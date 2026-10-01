// POST /api/relay — submits a user's private transaction from the relayer so the user's wallet
// never appears on-chain. No login: the proof itself authorizes the step, and the ext data
// (recipient, fee, converter, ciphertexts) is bound into it, so the relayer cannot alter it.
// Stores no user identity; idempotent per transaction (its nullifiers).
//   { kind: 'transact', proof, ext }  -> ZKDeskPool.transact (transfer, withdraw, private convert)
//   { kind: 'position', proof, ext }  -> CreditDesk.act (open, draw, repay, add, withdraw, close)
//   { kind: 'ledger', proof, ext }    -> TreasuryLedger.act (allocate, deallocate, transfer out)
//   { kind: 'ledger_auth', proof, ext: {shares, config} } -> TreasuryLedger.authorize (create, rotate, policy, approve)
//   { kind: 'ledger_attest', proof }  -> TreasuryLedger.attest (treasury solvency statement)
//   { kind: 'mandate_auth', proof, ext: {ciphertext} } -> MandateRegistry.manage (commit, revoke, pause, resume)
//   { kind: 'mandate_pull', proof, ext } -> MandateRegistry.pull (one payment under a mandate)
import { concatHex, isAddress, isHex, keccak256, toHex, zeroAddress } from 'viem';
import { abis, db, deployment, publicClient, relayer, sendFromRelayer, revertName, json } from './_lib/server.js';
import { minRelayFee } from '../src/lib/chain/config.js';
import { CONFIG_BYTES, KEY_SHARE_BYTES, MANDATE_BYTES, NOTE_CIPHERTEXT_BYTES, POSITION_CIPHERTEXT_BYTES } from '../src/lib/zk/crypto.js';

// A shielded fee makes every relayed transfer cost the sender something; all-dummy spam cannot pay it.
export const MIN_RELAY_FEE = minRelayFee(deployment.usdg); // 0.01 USDG; other assets: minRelayFee(asset)
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
  if (fee < minRelayFee(p.asset)) throw new Error(`Relay fee must be at least ${minRelayFee(p.asset)} base units of the spent asset.`);
  if (!same(e.relayer, relayer.address)) throw new Error('Fee must be paid to this relayer.');
  if (!same(e.converter, zeroAddress) && !same(e.converter, deployment.lending)) throw new Error('Unsupported converter.');
  return {
    kind: same(p.outAsset, p.asset) ? (extAmount < 0n ? 'withdraw' : 'transfer') : 'convert',
    target: { address: deployment.pool, abi: abis.pool, functionName: 'transact' },
    nullifiers: p.inputNullifiers.slice(0, 2).map(uint),
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
    kind, nullifiers: proof.inputNullifiers,
    target: { address: deployment.desk, abi: abis.desk, functionName: 'act' },
    args: [proof, { relayer: e.relayer, fee: 0n, encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2, encryptedPosition: e.encryptedPosition }],
  };
}

const LEDGER_KINDS = ['allocate', 'deallocate', 'transfer'];
const AUTH_KINDS = ['create', 'rotate', 'set_policy', 'approve'];
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
  for (const k of ['root', 'ledgerId', 'publicAmount', 'publicAmountOut', 'extDataHash', 'cosignIntent']) proof[k] = uint(p[k]);
  return { kind: `ledger_${LEDGER_KINDS[action]}`, nullifiers: proof.inputNullifiers, target: ledgerTarget('act'), args: [proof, { recipient: e.recipient, extAmount, encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2 }] };
}

function parseLedgerAuth(p, e) {
  checkProofBytes(p.proof);
  const action = Number(p.action);
  if (!AUTH_KINDS[action]) throw new Error('Bad governance action.');
  if (!Array.isArray(e.shares) || e.shares.length > 4 || e.shares.some((x) => bytesLen(x) !== KEY_SHARE_BYTES)) throw new Error('Bad key shares.');
  if (bytesLen(e.config) !== CONFIG_BYTES && bytesLen(e.config) !== 0) throw new Error('Bad config ciphertext.');
  const proof = { proof: p.proof, action };
  for (const k of ['ledgerId', 'rolesCommit', 'policyHash', 'newValue']) proof[k] = uint(p[k]);
  // One operation per (ledger, action, value, current roles).
  return { kind: `ledger_${AUTH_KINDS[action]}`, nullifiers: [proof.ledgerId, BigInt(action), proof.newValue, proof.rolesCommit], target: ledgerTarget('authorize'), args: [proof, e.shares, e.config] };
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
  return { kind: `mandate_${MANDATE_KINDS[action]}`, nullifiers: [proof.mandateCommit, BigInt(action), proof.ledgerId], target: mandatesTarget('manage'), args: [proof, e.ciphertext] };
}

function parseMandatePull(p, e) {
  checkProofBytes(p.proof);
  checkNotes(e);
  if (!ASSETS.has(p.asset?.toLowerCase())) throw new Error('Unsupported asset.');
  const proof = { proof: p.proof, asset: p.asset, inputNullifiers: p.inputNullifiers.slice(0, 2).map(uint), outputCommitments: p.outputCommitments.slice(0, 2).map(uint) };
  for (const k of ['root', 'ledgerId', 'mandateCommit', 'mark', 'k', 't', 'pullNullifier', 'receiptLeaf', 'extDataHash']) proof[k] = uint(p[k]);
  return { kind: 'mandate_pull', nullifiers: [proof.pullNullifier], target: mandatesTarget('pull'), args: [proof, { encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2 }] };
}

const PARSERS = { position: parsePosition, ledger: parseLedger, ledger_auth: parseLedgerAuth, ledger_attest: parseLedgerAttest, mandate_auth: parseMandateAuth, mandate_pull: parseMandatePull };

export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, 200, { relayer: relayer?.address ?? null, minFee: MIN_RELAY_FEE, available: Boolean(relayer) });
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!relayer) return json(res, 503, { error: 'relayer_unavailable' });

  let tx;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body?.proof || (!body?.ext && body.kind !== 'ledger_attest')) throw new Error('Missing proof or ext.');
    tx = (PARSERS[body.kind] ?? parseTransact)(body.proof, body.ext);
  } catch (error) {
    return json(res, 400, { error: 'invalid_request', message: error.message });
  }

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

  let gas;
  try {
    const sim = await publicClient.simulateContract({ account: relayer, ...tx.target, args: tx.args });
    gas = sim.request.gas;
  } catch (error) {
    const code = revertName(error);
    await db.query(`update public.operations set status = 'failed', error_code = $2, updated_at = now() where op_id = $1`, [opId, code]);
    return json(res, 422, { opId, status: 'failed', errorCode: code });
  }

  try {
    const { hash, nonce } = await sendFromRelayer(tx.target.functionName, tx.args, gas, tx.target);
    await db.query(`update public.operations set status = 'submitted', tx_hash = $2, nonce = $3, attempts = attempts + 1, updated_at = now() where op_id = $1`, [opId, hash, nonce]);
    // Blocks are fast; wait briefly so most clients get a final answer in one round trip.
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 }).catch(() => null);
    if (!receipt) return json(res, 202, { opId, status: 'submitted', txHash: hash });
    const status = receipt.status === 'success' ? 'confirmed' : 'failed';
    await db.query(`update public.operations set status = $2, error_code = $3, updated_at = now() where op_id = $1`, [opId, status, status === 'failed' ? 'reverted' : null]);
    return json(res, 200, { opId, status, txHash: hash, block: receipt.blockNumber });
  } catch (error) {
    // Unknown whether it reached the chain: leave it queued for the reconciler, never resend blindly.
    await db.query(`update public.operations set error_code = $2, updated_at = now() where op_id = $1`, [opId, revertName(error)]);
    return json(res, 502, { opId, status: 'queued', errorCode: 'send_uncertain' });
  }
}
