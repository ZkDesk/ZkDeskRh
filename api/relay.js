// POST /api/relay — submits a user's private transaction from the relayer so the user's wallet
// never appears on-chain. No login: the proof itself authorizes the step, and the ext data
// (recipient, fee, converter, ciphertexts) is bound into it, so the relayer cannot alter it.
// Stores no user identity; idempotent per transaction (its nullifiers).
//
// Every relay pays for its gas. A transact pays its fee in a shielded note (at least the live
// minimum from api/_lib/fees.js). The other kinds have no fee field in their proofs, so they redeem a
// voucher: a self-transfer sent with { voucher: true } pays twice the minimum and returns a one-use
// token, valid for a day once that transfer confirms. User relays stop at a balance floor, and the
// services run from their own keeper key, so spam cannot halt epochs or liquidations.
//   { kind: 'transact', proof, ext }  -> ZKDeskPool.transact (transfer, withdraw, private convert)
//   { kind: 'position', proof, ext }  -> CreditDesk.act (open, draw, repay, add, withdraw, close)
//   { kind: 'ledger', proof, ext }    -> TreasuryLedger.act (allocate, deallocate, transfer out)
//   { kind: 'ledger_auth', proof, ext: {shares, config} } -> TreasuryLedger.authorize (create, rotate, policy, approve)
//   { kind: 'ledger_attest', proof }  -> TreasuryLedger.attest (treasury solvency statement)
//   { kind: 'mandate_auth', proof, ext: {ciphertext} } -> MandateRegistry.manage (commit, revoke, pause, resume)
//   { kind: 'mandate_pull', proof, ext } -> MandateRegistry.pull (one payment under a mandate)
import { randomBytes } from 'node:crypto';
import { concatHex, encodeAbiParameters, isAddress, isHex, keccak256, toHex, verifyMessage, zeroAddress } from 'viem';
import { mailboxMessages } from '../src/lib/zk/ledger.js';
import { abis, db, deployment, deploymentReady, publicClient, relayer, sendFromRelayer, revertName, json } from './_lib/server.js';
import { RELAY_GAS, relayFees } from './_lib/fees.js';
import { CONFIG_BYTES, KEY_SHARE_BYTES, MANDATE_BYTES, NOTE_CIPHERTEXT_BYTES, POSITION_CIPHERTEXT_BYTES } from '../src/lib/zk/crypto.js';

/** User relays stop below this, leaving gas for transactions in flight. */
export const RELAYER_FLOOR_WEI = 2n * 10n ** 15n; // 0.002 ETH
/** Kinds whose proofs carry no fee: they redeem a voucher. */
const VOUCHER_KINDS = new Set(['position', 'ledger', 'ledger_auth', 'ledger_attest', 'mandate_auth', 'mandate_pull']);
const VOUCHER_PRICE = 2n; // a voucher self-transfer pays its own gas and one later relay
const MAX_PROOF_BYTES = 16_384;
const ASSETS = new Set([deployment.usdg, deployment.lending, deployment.vault, ...Object.values(deployment.stocks).map((s) => s.token)].map((a) => a.toLowerCase()));
const uint = (v) => { const b = BigInt(v); if (b < 0n || b >= 2n ** 256n) throw new Error('range'); return b; };
const bytesLen = (h) => (isHex(h) ? (h.length - 2) / 2 : -1);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

function checkProofBytes(proof) {
  if (!isHex(proof) || bytesLen(proof) > MAX_PROOF_BYTES) throw new Error('Bad proof bytes.');
}
function checkNotes(e) {
  for (const c of [e.encryptedOutput1, e.encryptedOutput2]) if (bytesLen(c) !== NOTE_CIPHERTEXT_BYTES) throw new Error('Bad note ciphertext.');
}

function parseTransact(p, e) {
  checkProofBytes(p.proof);
  checkNotes(e);
  if (!ASSETS.has(p.asset?.toLowerCase()) || !ASSETS.has(p.outAsset?.toLowerCase())) throw new Error('Unsupported asset.');
  if (!isAddress(e.recipient) || !isAddress(e.relayer) || !isAddress(e.converter)) throw new Error('Bad address.');
  const extAmount = BigInt(e.extAmount);
  const fee = uint(e.fee);
  if (extAmount > 0n) throw new Error('Deposits are sent from your own wallet, not the relayer.');
  if (!same(e.relayer, relayer.address)) throw new Error('Fee must be paid to this relayer.');
  if (!same(e.converter, zeroAddress) && !same(e.converter, deployment.lending)) throw new Error('Unsupported converter.');
  return {
    kind: same(p.outAsset, p.asset) ? (extAmount < 0n ? 'withdraw' : 'transfer') : 'convert',
    fee: { asset: p.asset.toLowerCase(), amount: fee },
    target: { address: deployment.pool, abi: abis.pool, functionName: 'transact' },
    nullifiers: p.inputNullifiers.slice(0, 2).map(uint),
    spends: p.inputNullifiers.slice(0, 2).map(uint),
    args: [{
      proof: p.proof, root: uint(p.root), publicAmount: uint(p.publicAmount), extDataHash: uint(p.extDataHash), asset: p.asset,
      outAsset: p.outAsset, publicAmountOut: uint(p.publicAmountOut),
      inputNullifiers: p.inputNullifiers.slice(0, 2).map(uint), outputCommitments: p.outputCommitments.slice(0, 2).map(uint),
    }, { recipient: e.recipient, extAmount, relayer: e.relayer, fee, converter: e.converter, encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2 }],
  };
}

function parsePosition(p, e) {
  checkProofBytes(p.proof);
  checkNotes(e);
  // A fully closed position has no ciphertext; otherwise it must be a position payload.
  if (bytesLen(e.encryptedPosition) !== POSITION_CIPHERTEXT_BYTES && bytesLen(e.encryptedPosition) !== 0) throw new Error('Bad position ciphertext.');
  if (!isAddress(e.relayer) || uint(e.fee) !== 0n) throw new Error('Credit steps carry no relay fee.');
  const slot = Number(p.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= 64) throw new Error('Bad slot.');
  const f = ['root', 'extDataHash', 'mark', 'rateIndex', 'oldLeaf', 'newLeaf', 'collIn', 'collOut', 'draw', 'repay', 'drawScaled', 'repayScaled'];
  if (p.operatorEph?.length !== 2 || p.operatorCipher?.length !== 4) throw new Error('Missing operator ciphertext.');
  const proof = {
    proof: p.proof, slot, collAsset: p.collAsset, inAsset: p.inAsset, inputNullifiers: p.inputNullifiers.slice(0, 2).map(uint), outputCommitments: p.outputCommitments.slice(0, 2).map(uint),
    operatorEph: p.operatorEph.map(uint), operatorCipher: p.operatorCipher.map(uint),
  };
  for (const k of f) proof[k] = uint(p[k]);
  const kind = proof.oldLeaf === 0n ? 'open' : proof.newLeaf === 0n ? 'close' : proof.draw ? 'draw' : proof.repay ? 'repay' : proof.collIn ? 'add' : 'withdraw_collateral';
  return {
    kind, nullifiers: proof.inputNullifiers, spends: proof.inputNullifiers,
    target: { address: deployment.desk, abi: abis.desk, functionName: 'act' },
    args: [proof, { relayer: e.relayer, fee: 0n, encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2, encryptedPosition: e.encryptedPosition }],
  };
}

const LEDGER_KINDS = ['allocate', 'deallocate', 'transfer'];
const AUTH_KINDS = ['create', 'rotate', 'set_policy', 'approve', 'set_limit'];
const ledgerTarget = (functionName) => ({ address: deployment.ledger, abi: abis.ledger, functionName });

function parseLedger(p, e) {
  checkProofBytes(p.proof);
  checkNotes(e);
  if (!isAddress(e.recipient) || !ASSETS.has(p.asset?.toLowerCase()) || !ASSETS.has(p.outAsset?.toLowerCase())) throw new Error('Bad address or asset.');
  const action = Number(p.action);
  if (!LEDGER_KINDS[action]) throw new Error('Bad ledger action.');
  const extAmount = BigInt(e.extAmount);
  if (extAmount > 0n) throw new Error('Funds enter a treasury by a deposit or a private transfer.');
  const proof = { proof: p.proof, action, asset: p.asset, outAsset: p.outAsset, inputNullifiers: p.inputNullifiers.slice(0, 2).map(uint), outputCommitments: p.outputCommitments.slice(0, 2).map(uint) };
  for (const k of ['root', 'ledgerId', 'publicAmount', 'publicAmountOut', 'extDataHash', 'cosignIntent', 't', 'budgetOld', 'budgetNew']) proof[k] = uint(p[k]);
  if (!Array.isArray(p.budgetCt) || p.budgetCt.length !== 2) throw new Error('Bad budget ciphertext.');
  proof.budgetCt = p.budgetCt.map(uint);
  // A transfer replaces the ledger's spending accumulator (v3.4): two in flight for one accumulator
  // cannot both land, so the second waits like a second spend of the same note.
  const serial = action === 2 ? [serialKey('ledger', proof.ledgerId)] : [];
  return { kind: `ledger_${LEDGER_KINDS[action]}`, nullifiers: proof.inputNullifiers, spends: proof.inputNullifiers, serial, target: ledgerTarget('act'), args: [proof, { recipient: e.recipient, extAmount, encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2 }] };
}

function parseLedgerAuth(p, e) {
  checkProofBytes(p.proof);
  const action = Number(p.action);
  if (!AUTH_KINDS[action]) throw new Error('Bad governance action.');
  if (!Array.isArray(e.shares) || e.shares.length > 4 || e.shares.some((x) => bytesLen(x) !== KEY_SHARE_BYTES)) throw new Error('Bad key shares.');
  if (bytesLen(e.config) !== CONFIG_BYTES && bytesLen(e.config) !== 0) throw new Error('Bad config ciphertext.');
  const proof = { proof: p.proof, action };
  for (const k of ['ledgerId', 'rolesCommit', 'policyHash', 'newValue']) proof[k] = uint(p[k]);
  const nonce = uint(p.nonce ?? 0); // the governance counter the proof binds (TreasuryLedger.authNonce)
  // A create may carry the treasury's approval-mailbox key (audit M-6/N-4): the address of a key
  // derived from the ledger secret, plus its signature over the register message. The address is part
  // of the create proof's ext hash (audit L-c), so nobody else can attach a key to the treasury.
  let mailbox = null;
  if (action === 0 && e.mailboxSigner !== undefined) {
    if (!isAddress(e.mailboxSigner) || !/^0x[0-9a-fA-F]{130}$/.test(e.mailboxSignature ?? '')) throw new Error('Bad mailbox key.');
    mailbox = { ledger: toHex(proof.ledgerId, { size: 32 }), signer: e.mailboxSigner, signature: e.mailboxSignature };
  }
  // One operation per (ledger, action, value, roles, policy, counter): the same change made again later
  // binds a new counter, so it is a new operation. One governance change per ledger in flight (v3.4).
  return {
    kind: `ledger_${AUTH_KINDS[action]}`, nullifiers: [proof.ledgerId, BigInt(action), proof.newValue, proof.rolesCommit, proof.policyHash, nonce],
    serial: [serialKey('ledger', proof.ledgerId)], target: ledgerTarget('authorize'), args: [proof, e.shares, e.config, mailbox?.signer ?? zeroAddress], mailbox,
  };
}

function parseLedgerAttest(p) {
  checkProofBytes(p.proof);
  if (p.nullifiers?.length !== 8) throw new Error('Bad nullifiers.');
  const proof = { proof: p.proof, root: uint(p.root), ledgerId: uint(p.ledgerId), liabilities: uint(p.liabilities), nullifiers: p.nullifiers.map(uint) };
  return { kind: 'ledger_attest', nullifiers: [proof.root, proof.ledgerId, proof.liabilities], target: ledgerTarget('attest'), args: [proof] };
}

const MANDATE_KINDS = ['commit', 'revoke', 'pause', 'resume'];
const mandatesTarget = (functionName) => ({ address: deployment.mandates, abi: abis.mandates, functionName });

function parseMandateAuth(p, e) {
  checkProofBytes(p.proof);
  const action = Number(p.action);
  if (!MANDATE_KINDS[action]) throw new Error('Bad mandate action.');
  if (bytesLen(e.ciphertext) !== (action === 0 ? MANDATE_BYTES : 0)) throw new Error('Bad mandate ciphertext.');
  const proof = { proof: p.proof, ledgerId: uint(p.ledgerId), action, mandateCommit: uint(p.mandateCommit) };
  const nonce = uint(p.nonce ?? 0); // the mandate's change counter the proof binds (MandateRegistry.changes)
  return { kind: `mandate_${MANDATE_KINDS[action]}`, nullifiers: [proof.mandateCommit, BigInt(action), proof.ledgerId, nonce], serial: [serialKey('ledger', proof.ledgerId)], target: mandatesTarget('manage'), args: [proof, e.ciphertext] };
}

function parseMandatePull(p, e) {
  checkProofBytes(p.proof);
  checkNotes(e);
  if (!ASSETS.has(p.asset?.toLowerCase())) throw new Error('Unsupported asset.');
  const proof = { proof: p.proof, asset: p.asset, inputNullifiers: p.inputNullifiers.slice(0, 2).map(uint), outputCommitments: p.outputCommitments.slice(0, 2).map(uint) };
  for (const k of ['root', 'ledgerId', 'mandateCommit', 'mark', 'k', 't', 'pullNullifier', 'receiptLeaf', 'extDataHash']) proof[k] = uint(p[k]);
  return { kind: 'mandate_pull', nullifiers: [proof.pullNullifier], spends: [proof.pullNullifier, ...proof.inputNullifiers], target: mandatesTarget('pull'), args: [proof, { encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2 }] };
}

// A Map, not an object literal: a kind such as "constructor" or "__proto__" must never resolve to an
// inherited property (it made `tx` attacker-controlled JSON).
const PARSERS = new Map(Object.entries({
  transact: parseTransact, position: parsePosition, ledger: parseLedger, ledger_auth: parseLedgerAuth,
  ledger_attest: parseLedgerAttest, mandate_auth: parseMandateAuth, mandate_pull: parseMandatePull,
}));
/** The only calls the relayer ever signs for a user: checked again just before signing. */
const ALLOWED = new Map([
  [deployment.pool, ['transact']], [deployment.desk, ['act']],
  [deployment.ledger, ['act', 'authorize', 'attest']], [deployment.mandates, ['manage', 'pull']],
].filter(([a]) => a).map(([a, fns]) => [a.toLowerCase(), new Set(fns)]));
const allowed = (target) => Boolean(target && typeof target.address === 'string' && ALLOWED.get(target.address.toLowerCase())?.has(target.functionName));

const hashToken = (t) => keccak256(t);

/** Validates a request body and builds the one call it may make. Throws on anything else. */
export function parseRelayRequest(body) {
  if (!body?.proof || (!body?.ext && body.kind !== 'ledger_attest')) throw new Error('Missing proof or ext.');
  const parse = PARSERS.get(body.kind ?? 'transact'); // no kind: a plain transact (older clients)
  if (!parse) throw new Error('Unknown kind.');
  const tx = parse(body.proof, body.ext);
  if (!allowed(tx.target)) throw new Error('Unsupported call.');
  if (body.voucher === true && tx.kind !== 'transfer') throw new Error('A voucher is bought with a private transfer.');
  return tx;
}

/** Fee for a call of `gas`, given the minimum `base` quoted for RELAY_GAS (rounded up). */
export const feeForGas = (base, gas) => (gas > RELAY_GAS ? (base * gas + RELAY_GAS - 1n) / RELAY_GAS : base);

/** A claim key for state that only one operation may change at a time (not a note nullifier). */
const serialKey = (what, ...ids) => BigInt(keccak256(encodeAbiParameters([{ type: 'string' }, ...ids.map(() => ({ type: 'uint256' }))], [what, ...ids])));

/** Claims every note this operation spends; false if another unfinished operation holds one. */
async function claimSpends(opId, spends) {
  const keys = spends.map((n) => toHex(n, { size: 32 }));
  // Claims of operations that finished (or never got anywhere) no longer hold their notes.
  await db.query(
    `delete from public.pending_spends where nullifier = any($1) and op_id in (select op_id from public.operations where status in ('confirmed', 'failed', 'replaced'))`, [keys]);
  const { rows } = await db.query(
    `insert into public.pending_spends (nullifier, op_id) select unnest($1::text[]), $2 on conflict (nullifier) do nothing returning nullifier`, [keys, opId]);
  if (rows.length === keys.length) return true;
  await release(opId);
  return false;
}
const release = (opId) => db.query('delete from public.pending_spends where op_id = $1', [opId]);

export default async function handler(req, res) {
  if (!deploymentReady) return json(res, 503, { error: 'network_upgrading' }); // still on older contracts
  if (req.method === 'GET') {
    if (!relayer) return json(res, 200, { relayer: null, available: false });
    const [fees, balance] = await Promise.all([relayFees(), publicClient.getBalance({ address: relayer.address })]).catch(() => [null, 0n]);
    if (!fees) return json(res, 200, { relayer: relayer.address, available: false });
    return json(res, 200, { relayer: relayer.address, minFee: fees[deployment.usdg.toLowerCase()], fees, voucherPrice: VOUCHER_PRICE, available: balance >= RELAYER_FLOOR_WEI });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!relayer) return json(res, 503, { error: 'relayer_unavailable' });

  let tx;
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    tx = parseRelayRequest(body);
  } catch (error) {
    return json(res, 400, { error: 'invalid_request', message: error.message });
  }
  // The in-process scheduler (api/cron/pulls.js) is the service itself: it redeems no voucher.
  const needsVoucher = VOUCHER_KINDS.has(body.kind) && !req.internal;
  if (needsVoucher && !(typeof body.voucher === 'string' && /^0x[0-9a-f]{64}$/.test(body.voucher))) return json(res, 402, { error: 'voucher_required' });
  if (tx.fee) {
    const base = (await relayFees())[tx.fee.asset];
    if (!base) return json(res, 402, { error: 'fee_asset_unavailable' }); // e.g. a stock without a live mark
    const min = base * (body.voucher === true ? VOUCHER_PRICE : 1n);
    if (tx.fee.amount < min) return json(res, 402, { error: 'fee_too_low', minFee: min });
  }
  if ((await publicClient.getBalance({ address: relayer.address })) < RELAYER_FLOOR_WEI) return json(res, 503, { error: 'relayer_unavailable' });

  // One operation per spend. A failed attempt may be retried; anything in flight or done is returned.
  const intentHash = keccak256(concatHex(tx.nullifiers.map((n) => toHex(n, { size: 32 }))));
  const { rows } = await db.query(
    `insert into public.operations (intent_hash, kind) values ($1, $2)
     on conflict (intent_hash) do update set status = 'queued', error_code = null, updated_at = now()
       where public.operations.status = 'failed'
     returning op_id`, [intentHash, tx.kind]);
  if (!rows.length) {
    const { rows: [op] } = await db.query('select op_id, status, tx_hash, error_code from public.operations where intent_hash = $1', [intentHash]);
    return json(res, 200, { opId: op.op_id, status: op.status, txHash: op.tx_hash, errorCode: op.error_code, duplicate: true });
  }
  const opId = rows[0].op_id;
  const fail = async (status, code) => {
    await db.query(`update public.operations set status = 'failed', error_code = $2, updated_at = now() where op_id = $1`, [opId, code]);
    await release(opId);
    return json(res, status, { opId, status: 'failed', errorCode: code });
  };
  let gas;
  try {
    const sim = await publicClient.simulateContract({ account: relayer, ...tx.target, args: tx.args });
    gas = sim.request.gas;
  } catch (error) {
    return fail(422, revertName(error));
  }
  // Audit N-2: one in-flight operation per note. Requests spending a note another pending operation
  // spends would all pass simulation and all but one would revert at the relayer's cost. Claimed only
  // after a successful simulation (a valid proof), so a bogus request cannot hold a claim (v3.4).
  if (tx.spends?.length && !(await claimSpends(opId, tx.spends))) return fail(409, 'spend_in_flight');
  // v3.4: one in-flight change per treasury (a transfer moves its accumulator; a governance or mandate
  // change moves a counter or the roles and policy the others bind). The key is public, which is why it
  // is claimed after the simulation too.
  if (tx.serial?.length && !(await claimSpends(opId, tx.serial))) return fail(409, 'ledger_busy');
  // Fees are quoted for RELAY_GAS; a heavier call pays proportionally more, and a voucher (sized
  // for RELAY_GAS with the client's 25% margin) covers nothing heavier.
  if (tx.fee && gas > RELAY_GAS) {
    const base = (await relayFees())[tx.fee.asset] * (body.voucher === true ? VOUCHER_PRICE : 1n);
    if (tx.fee.amount < feeForGas(base, gas)) return fail(402, 'fee_too_low');
  }
  if (needsVoucher && gas > (RELAY_GAS * 5n) / 4n) return fail(402, 'gas_above_voucher');
  // The mailbox key of a treasury being created: its holder must have signed, and its row is written
  // only once the create is confirmed (audit L-d; tick.js also indexes the MailboxKey event).
  if (tx.mailbox && !(await verifyMessage({ address: tx.mailbox.signer, message: mailboxMessages.register(tx.mailbox.ledger), signature: tx.mailbox.signature }).catch(() => false))) return fail(400, 'bad_mailbox_signature');
  // Spent only once the step is known to succeed; bought by a confirmed transfer within the last day.
  if (needsVoucher) {
    const { rowCount } = await db.query(
      `update public.relay_vouchers set used_at = now()
       where token_hash = $1 and used_at is null and created_at > now() - interval '1 day'
         and op_id in (select op_id from public.operations where status = 'confirmed')`, [hashToken(body.voucher)]);
    if (!rowCount) return fail(402, 'voucher_required');
  }
  let voucher;
  if (body.voucher === true) {
    voucher = toHex(randomBytes(32));
    // A retried purchase replaces the earlier attempt's token: one confirmed transfer, one voucher.
    await db.query('delete from public.relay_vouchers where op_id = $1', [opId]);
    await db.query('insert into public.relay_vouchers (token_hash, op_id) values ($1, $2)', [hashToken(voucher), opId]);
  }

  try {
    // Re-simulated inside the nonce lock, so a spend that landed meanwhile is never broadcast.
    const { hash, nonce } = await sendFromRelayer(tx.target.functionName, tx.args, gas, tx.target, { resimulate: true });
    await db.query(`update public.operations set status = 'submitted', tx_hash = $2, nonce = $3, attempts = attempts + 1, updated_at = now() where op_id = $1`, [opId, hash, nonce]);
    // Blocks are fast; wait briefly so most clients get a final answer in one round trip.
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 }).catch(() => null);
    if (!receipt) return json(res, 202, { opId, status: 'submitted', txHash: hash, voucher });
    const status = receipt.status === 'success' ? 'confirmed' : 'failed';
    if (status === 'confirmed' && tx.mailbox) await db.query('insert into public.mailbox_keys (ledger_id, signer) values ($1, $2) on conflict (ledger_id) do nothing', [tx.mailbox.ledger, tx.mailbox.signer.toLowerCase()]);
    await db.query(`update public.operations set status = $2, error_code = $3, updated_at = now() where op_id = $1`, [opId, status, status === 'failed' ? 'reverted' : null]);
    await release(opId);
    return json(res, 200, { opId, status, txHash: hash, block: receipt.blockNumber, voucher });
  } catch (error) {
    if (error.code === 'resimulate_failed') {
      // Nothing was broadcast: the voucher this step used pays for its retry (v3.4).
      if (needsVoucher) await db.query('update public.relay_vouchers set used_at = null where token_hash = $1', [hashToken(body.voucher)]);
      return fail(422, revertName(error.cause));
    }
    // Unknown whether it reached the chain: leave it queued for the reconciler, never resend blindly.
    await db.query(`update public.operations set error_code = $2, updated_at = now() where op_id = $1`, [opId, revertName(error)]);
    return json(res, 502, { opId, status: 'queued', errorCode: 'send_uncertain', voucher });
  }
}
