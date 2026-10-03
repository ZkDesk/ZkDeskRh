// One private-account client for the dashboard and ops scripts. It reads chain state, picks notes,
// builds witnesses and ciphertexts, then hands proofs to injected `prove(kind, witness)` and
// `relay(body)` (browser: worker + fetch; Node: bb.js + in-process handler).
import { decodeFunctionData, getAddress, maxUint256, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abis, deployment, explorerTx, MAINNET, minRelayFee, NETWORK_NAME, payableFee, stocks, USD_SYMBOL } from '../chain/config.js';
import { encryptConfig, encryptKeyShare, encryptMandate, encryptNote, encryptPosition, openRequest, sealRequest, textToField } from './crypto.js';
import { buildMandateAuth, buildPull, buildReceipt, currentPeriod, KINDS, MANDATE_ACTIONS, PERIODS, rawForUsdg } from './mandate.js';
import { ACTIONS, AUTH, authExtHash, buildAttest, buildLedger, buildRoleAuth, ledgerKeys, mailboxMessages, payerSpent, rolesOf, scopeOf } from './ledger.js';
import { ALLOW_SLOTS, allowHash, mandateCommit, MAX_AMOUNT, policyHash, randomField } from './notes.js';
import { buildTransact } from './transact.js';
import { paymentRows } from './report.js';
import { buildPosition, debtOf, maxDebt, valueOf } from './position.js';
import { balanceOf, freeSlot, ledgerMandates, myLedgers, myNotes, myPositions, myReceipts, syncPool } from './wallet.js';

const USDG = BigInt(deployment.usdg);
const hexId = (id) => '0x' + id.toString(16).padStart(64, '0');
const LENDING = BigInt(deployment.lending);
const big = (a) => BigInt(a);
const s = (x) => x.toString();
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * requests: optional mailbox {list(ledgerIdHex), post(ledgerIdHex, ciphertext, signature)} (api/requests.js).
 * vouchers: false only for the in-process scheduler, which relays without paying itself.
 */
export function createClient({ publicClient, walletClient = null, address = null, keys, prove, relay, requests = null, onStatus = () => {}, vouchers = true, maxFee = null }) {
  let state = null;
  let lastBlock = 0n;
  const status = (m) => onStatus(m);
  const read = (addr, abi, functionName, args = []) => publicClient.readContract({ address: addr, abi, functionName, args });

  async function sync(minBlock = lastBlock) {
    state = await syncPool(publicClient, deployment, { minBlock });
    return state;
  }
  const notes = () => myNotes(state, keys);
  const unspent = (asset) => notes().filter((n) => n.asset === big(asset) && n.status === 'unspent').sort((a, b) => (b.amount > a.amount ? 1 : -1));

  function pickInputs(asset, needed, list = unspent(asset)) {
    if (needed === 0n) return [];
    if (list[0]?.amount >= needed) return [list[0]];
    if (list.length > 1 && list[0].amount + list[1].amount >= needed) return list.slice(0, 2);
    const total = list.reduce((t, n) => t + n.amount, 0n);
    throw new Error(total >= needed
      ? 'This amount spans more than two private notes. Combine them first (Combine notes, on the Treasury tab of your personal account), or use a smaller amount.'
      : 'Not enough available private balance.');
  }

  async function relayInfo() {
    const info = await relay(null);
    if (!info.available) throw new Error('The relayer is unavailable right now. Please try again shortly.');
    return info;
  }
  // maxFee (agents): refuse a relay that quotes more than this per step in USDG, or a voucher price above 2.
  // ceiling (agents, per step): the fee the agent reserved for the step; a relay that raises its quote
  // after that is refused before anything is proven.
  let ceiling = null;
  function quote(info, asset) {
    const fee = payableFee(info.fees?.[String(asset).toLowerCase()] ?? minRelayFee(asset));
    if (maxFee !== null && big(asset) === USDG && (fee > maxFee || Number(info.voucherPrice ?? 2) > 2)) {
      throw new Error(`The relay quotes ${Number(fee) / 1e6} USDG per step (voucher ×${info.voucherPrice ?? 2}), above this agent's fee limit of ${Number(maxFee) / 1e6} USDG.`);
    }
    if (ceiling && big(asset) === USDG && (fee > ceiling.fee || BigInt(info.voucherPrice ?? 2) > ceiling.voucherPrice)) {
      throw new Error('The relay fee rose after it was reserved. Nothing was paid; try again.');
    }
    return fee;
  }

  /** The relay fee is paid in the spent asset and covers the relay's gas (api/_lib/fees.js). */
  async function relayFee(asset) {
    const info = await relayInfo();
    return { fee: quote(info, asset), relayer: info.relayer };
  }

  /**
   * Steps whose proofs have no fee field (credit, treasury, payments) redeem a one-use voucher. It is
   * bought first by a private self-transfer that pays twice the fee: its own gas and the step's.
   */
  // A voucher whose step was refused before the relay used it (a race on the treasury's accumulator or
  // governance counter) pays for the retry instead of a new one.
  let spareVoucher;
  const keepVoucher = (paid, error) => { if (paid && retryable(error)) spareVoucher = paid; };
  async function voucher() {
    if (!vouchers) return undefined;
    if (spareVoucher) { const v = spareVoucher; spareVoucher = undefined; return v; }
    const info = await relayInfo();
    await sync();
    const hexAddr = (x) => '0x' + x.toString(16).padStart(40, '0');
    const held = [...new Set(notes().filter((n) => n.status === 'unspent').map((n) => hexAddr(n.asset)))];
    for (const asset of [deployment.usdg, ...held.filter((a) => !same(a, deployment.usdg))]) {
      const fee = quote(info, asset) * BigInt(info.voucherPrice ?? 2);
      let inputs;
      try {
        inputs = pickInputs(asset, fee);
      } catch {
        continue;
      }
      const change = inputs.reduce((t, n) => t + n.amount, 0n) - fee;
      status('Paying the relay fee (a private self-transfer)…');
      const body = await transactBody({ asset, inputs, outputs: [{ amount: change, owner: keys.owner }], ext: { relayer: info.relayer, fee } });
      const r = await submitRelay({ ...body, voucher: true });
      if (!r.voucher) throw new Error('The relayer did not return a fee voucher. Please try again.');
      return r.voucher;
    }
    const usd = Number(quote(info, deployment.usdg) * BigInt(info.voucherPrice ?? 2)) / 1e6;
    throw new Error(`This step needs a relay fee of about ${usd.toFixed(2)} ${USD_SYMBOL} from your private balance. Add funds first.`);
  }

  let relaysSent = 0; // counted before each submission: an agent releases a fee reservation only if nothing was sent
  async function submitRelay(body) {
    relaysSent++;
    status('Submitting through the relayer…');
    const r = await relay(body);
    if (r.status !== 'confirmed') throw new Error(friendly(r.errorCode || (r.status === 'submitted' || r.status === 'queued' ? 'pending_long' : r.message || r.error)));
    lastBlock = big(r.block ?? 0);
    return r;
  }

  /** Proves a transact with both outputs encrypted; returns the relay/tx body. */
  async function transactBody({ asset, outAsset = asset, publicAmountOut = 0n, inputs, outputs, ext }) {
    const full = { recipient: zeroAddress, extAmount: 0n, relayer: zeroAddress, fee: 0n, converter: zeroAddress, ...ext };
    const args = { tree: state.tree, sk: keys.sk, asset: big(asset), outAsset: big(outAsset), publicAmountOut, inputs, outputs };
    const draft = buildTransact({ ...args, ext: { ...full, encryptedOutput1: '0x', encryptedOutput2: '0x' } });
    const [o1, o2] = draft.outputs;
    const finalExt = { ...full, encryptedOutput1: encryptNote(o1, o1.encPub ?? keys.encPub), encryptedOutput2: encryptNote(o2, o2.encPub ?? keys.encPub) };
    const tx = buildTransact({ ...args, outputs: draft.outputs, ext: finalExt });
    status('Generating proof…');
    const { proof } = await prove('transact', tx.witness);
    const p = tx.public;
    const hexAddr = (x) => '0x' + x.toString(16).padStart(40, '0');
    return {
      kind: 'transact',
      proof: { proof, root: s(p.root), publicAmount: s(p.publicAmount), extDataHash: s(p.extDataHash), asset: hexAddr(p.asset), outAsset: hexAddr(p.outAsset), publicAmountOut: s(p.publicAmountOut), inputNullifiers: p.inputNullifiers.map(s), outputCommitments: p.outputCommitments.map(s) },
      ext: { ...finalExt, extAmount: s(finalExt.extAmount), fee: s(finalExt.fee) },
    };
  }

  async function wallet(label, target, functionName, args) {
    if (!walletClient) throw new Error('Connect your wallet first.');
    status(label);
    const hash = await walletClient.writeContract({ ...target, functionName, args });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} failed: ${explorerTx(hash)}`);
    lastBlock = r.blockNumber;
    return r;
  }

  /**
   * Public token -> private notes, from the connected wallet (standby applies). On testnet it faucets test tokens if
   * short; on mainnet a short wallet is refused and the approval is for this amount only. to: {owner, encPub} of another private account or a treasury (default: yourself).
   */
  async function deposit(asset, amount, to = { owner: keys.owner, encPub: keys.encPub }) {
    if (!address) throw new Error('Connect MetaMask to add funds.');
    const token = { address: asset, abi: big(asset) === USDG ? abis.usdg : abis.stock };
    const balance = await read(asset, token.abi, 'balanceOf', [address]);
    if (balance < amount && MAINNET) throw new Error('Your wallet does not hold enough of this token for that deposit.');
    if (balance < amount) await wallet('Confirm the test-token faucet in your wallet…', token, 'faucet', [amount - balance]);
    if ((await read(asset, token.abi, 'allowance', [address, deployment.pool])) < amount) await wallet('Approve ZKdesk in your wallet…', token, 'approve', [deployment.pool, MAINNET ? amount : maxUint256]);
    await sync();
    const body = await transactBody({ asset, inputs: [], outputs: [{ amount, ...to }], ext: { extAmount: amount } });
    const p = body.proof;
    const args = [{ ...p, root: big(p.root), publicAmount: big(p.publicAmount), extDataHash: big(p.extDataHash), publicAmountOut: 0n, inputNullifiers: p.inputNullifiers.map(big), outputCommitments: p.outputCommitments.map(big) }, { ...body.ext, extAmount: amount, fee: 0n }];
    await wallet('Confirm the private deposit in your wallet…', { address: deployment.pool, abi: abis.pool }, 'transact', args);
  }

  /** Private transfer to a ZKDesk address ({owner, encPub}) or withdrawal to a public address. */
  async function send({ asset = deployment.usdg, amount, to = null, recipient = null }) {
    const { fee, relayer } = await relayFee(asset);
    await sync();
    const inputs = pickInputs(asset, amount + fee);
    const change = inputs.reduce((t, n) => t + n.amount, 0n) - amount - fee;
    const self = { owner: keys.owner };
    const outputs = to ? [{ amount, ...to }, { amount: change, ...self }] : [{ amount: change, ...self }];
    const ext = to ? { relayer, fee } : { recipient, extAmount: -amount, relayer, fee };
    return submitRelay(await transactBody({ asset, inputs, outputs, ext }));
  }

  /**
   * Merges this asset's private notes, two at a time by relayed self-transfer (each pays its relay
   * fee), largest first, until one note holds `target` (default: all of them) or one note is left.
   * Notes that cannot pay their own merge fee are left alone. Returns the number of merges (at most max).
   */
  async function combine(asset = deployment.usdg, { target, max, feeCap } = {}) {
    for (let merges = 0; ; merges++) {
      if (max !== undefined && merges >= max) return merges;
      const { fee, relayer } = await relayFee(asset);
      if (feeCap !== undefined && fee > feeCap) return merges; // the relay raised its fee: stop, do not overspend
      await sync();
      const list = unspent(asset).filter((n) => n.amount > fee);
      if (list.length < 2 || (target !== undefined && list[0].amount >= target)) return merges;
      status(`Combining notes (${merges + 1} of ${merges + list.length - 1})…`);
      const inputs = list.slice(0, 2);
      await submitRelay(await transactBody({ asset, inputs, outputs: [{ amount: inputs[0].amount + inputs[1].amount - fee, owner: keys.owner }], ext: { relayer, fee } }));
    }
  }

  /** Private USDG -> lending shares (lend) or shares -> USDG (redeem). */
  async function convert(direction, amount) {
    const [assetIn, assetOut] = direction === 'lend' ? [deployment.usdg, deployment.lending] : [deployment.lending, deployment.usdg];
    const { fee, relayer } = await relayFee(assetIn);
    await sync();
    const quote = direction === 'lend'
      ? await read(deployment.lending, abis.lending, 'previewDeposit', [amount])
      : await read(deployment.lending, abis.lending, 'previewRedeem', [amount]);
    const minOut = (quote * 9_999n) / 10_000n; // 0.01% slack for interest accrued between quote and execution
    const inputs = pickInputs(assetIn, amount + fee);
    const change = inputs.reduce((t, n) => t + n.amount, 0n) - amount - fee;
    return submitRelay(await transactBody({
      asset: assetIn, outAsset: assetOut, publicAmountOut: minOut, inputs,
      outputs: [{ amount: change, owner: keys.owner }, { amount: minOut, owner: keys.owner }],
      ext: { extAmount: -amount, relayer, fee, converter: deployment.lending },
    }));
  }

  let operatorPk = null;
  async function market(symbol) {
    const token = stocks[symbol].token;
    operatorPk ??= await Promise.all([0n, 1n].map((i) => read(deployment.desk, abis.desk, 'operatorPk', [i])));
    const [[price], index, cls] = await Promise.all([read(deployment.marker, abis.marker, 'current', [token]), read(deployment.desk, abis.desk, 'index'), read(deployment.desk, abis.desk, 'classes', [token])]);
    // classes(): ltvBps, liqThresholdBps, enabled, maxCollateral, minCollateral, minDebt.
    return { token, mark: big(price), ltvBps: Number(cls[0]), liqBps: Number(cls[1]), minColl: cls[4] ?? 0n, minDebt: cls[5] ?? 0n, index, operatorPk };
  }

  /** Desk epoch status: last attestation, whether new draws are halted, epoch count. */
  async function deskHealth() {
    const [lastAttestedAt, healthy, epoch] = await Promise.all(['lastAttestedAt', 'healthy', 'epoch'].map((f) => read(deployment.desk, abis.desk, f)));
    return { lastAttestedAt: Number(lastAttestedAt), healthy, epoch: Number(epoch) };
  }

  /**
   * One credit step. position: from positions() or null to open. A step that keeps the position open
   * must prove at the current rate index (v3.3); if accrue() lands while proving, it is proven again once.
   */
  async function credit(step) {
    try {
      return await creditOnce(step);
    } catch (error) {
      if (!/StaleIndex|Rates were just updated/.test(error?.message ?? '')) throw error;
      status('Rates were just updated: proving again…');
      return creditOnce(step);
    }
  }

  async function creditOnce({ symbol, position = null, collIn = 0n, collOut = 0n, draw = 0n, repay = 0n }) {
    const m = await market(symbol);
    const left = (position?.collateral ?? 0n) + collIn - collOut;
    if (left > 0n && (!position || collOut) && left < m.minColl) throw new Error(`A position must hold at least ${Number(m.minColl) / 1e18} ${symbol} of collateral.`);
    const paid = await voucher(); // first, so the step's inputs are picked from what is left
    await sync();
    const payAsset = repay ? deployment.usdg : m.token;
    const inputs = pickInputs(payAsset, collIn + repay);
    const slot = position ? position.slot : freeSlot(state);
    if (slot === null) throw new Error('The credit desk is full. Please try again later.');
    const old = position && { collateral: position.collateral, debtScaled: position.debtScaled, blinding: position.blinding };
    const args = { tree: state.tree, sk: keys.sk, collAsset: big(m.token), usdgAsset: USDG, mark: m.mark, ltvBps: m.ltvBps, minColl: m.minColl, liqBps: m.liqBps, minDebt: m.minDebt, rateIndex: m.index, operatorPk: m.operatorPk, old, collIn, collOut, draw, repay, inputs };
    const empty = { relayer: zeroAddress, fee: 0n, encryptedOutput1: '0x', encryptedOutput2: '0x', encryptedPosition: '0x' };
    const draft = buildPosition({ ...args, ext: empty });
    const [o1, o2] = draft.outputs;
    const ext = { ...empty, encryptedOutput1: encryptNote(o1, keys.encPub), encryptedOutput2: encryptNote(o2, keys.encPub), encryptedPosition: draft.position ? encryptPosition(draft.position, keys.encPub) : '0x' };
    // Rebuild with the final ext hash and the draft's blindings so the ciphertexts describe what is proven.
    const built = buildPosition({ ...args, ext, blindings: { position: draft.position?.blinding, outputs: draft.outputs.map((o) => o.blinding) } });
    status('Generating proof…');
    const { proof } = await prove('position', built.witness);
    const p = built.public;
    const hexAddr = (x) => '0x' + x.toString(16).padStart(40, '0');
    return submitRelay({
      kind: 'position',
      proof: { proof, slot, root: s(p.root), extDataHash: s(p.extDataHash), collAsset: hexAddr(p.collAsset), inAsset: hexAddr(p.inAsset), mark: s(p.mark), rateIndex: s(p.rateIndex), oldLeaf: s(p.oldLeaf), newLeaf: s(p.newLeaf), collIn: s(p.collIn), collOut: s(p.collOut), draw: s(p.draw), repay: s(p.repay), drawScaled: s(p.drawScaled), repayScaled: s(p.repayScaled), inputNullifiers: p.inputNullifiers.map(s), outputCommitments: p.outputCommitments.map(s), operatorEph: p.operatorEph.map(s), operatorCipher: p.operatorCipher.map(s) },
      ext: { ...ext, fee: '0' },
      voucher: paid,
    });
  }

  // ---- Treasury ledgers ----

  const ledgers = () => myLedgers(state, keys);
  const ledgerNotes = (ledger) => myNotes(state, ledger);
  const ledgerUnspent = (ledger, asset) => ledgerNotes(ledger).filter((n) => n.asset === big(asset) && n.status === 'unspent').sort((a, b) => (b.amount > a.amount ? 1 : -1));

  // Governance changes of one treasury go one at a time (each binds the treasury's counter): a change
  // that finds another in flight is proven again on the new counter.
  const relayAuth = (args) => againWhenBusy(() => relayAuthOnce(args));
  async function relayAuthOnce({ ledger, config, action, newValue = 0n, shares = [], configCt = '0x', mailbox = {} }) {
    const paid = await voucher();
    try {
      // The ledger's governance nonce: each proof applies once (v3.4).
      const nonce = action === AUTH.create ? 0n : await read(deployment.ledger, abis.ledger, 'authNonce', [ledger.owner]);
      const built = buildRoleAuth({ ledger, sk: keys.sk, config, action, newValue, extHash: authExtHash(shares, configCt, mailbox.mailboxSigner, nonce) });
      status('Generating proof…');
      const { proof } = await prove('role_auth', built.witness);
      const p = built.public;
      try {
        return await submitRelay({ kind: 'ledger_auth', proof: { proof, ledgerId: s(p.ledgerId), rolesCommit: s(p.rolesCommit), policyHash: s(p.policyHash), action, newValue: s(newValue), nonce: s(nonce) }, ext: { shares, config: configCt, ...mailbox }, voucher: paid });
      } catch (error) {
        // Another change landed while this one was proven: its counter moved, so prove it again.
        if (action !== AUTH.create && (await read(deployment.ledger, abis.ledger, 'authNonce', [ledger.owner])) !== nonce) throw new Error('Another change to this treasury landed first.');
        throw error;
      }
    } catch (error) {
      keepVoucher(paid, error);
      throw error;
    }
  }

  // Approval mailbox (api/requests.js): posts are signed with the treasury's mailbox key.
  const mailboxSigner = (ledger) => privateKeyToAccount(toHex(ledger.mailboxKey));
  /** The mailbox key, signed, for the create request (api/relay.js registers it). Never blocks a create. */
  async function mailboxFields(ledger) {
    try {
      const id = hexId(ledger.owner);
      const signer = mailboxSigner(ledger);
      return { mailboxSigner: signer.address, mailboxSignature: await signer.signMessage({ message: mailboxMessages.register(id) }) };
    } catch {
      return {};
    }
  }
  async function postRequest(ledger, ciphertext) {
    const id = hexId(ledger.owner);
    const signature = await mailboxSigner(ledger).signMessage({ message: mailboxMessages.post(id, ciphertext) });
    let r = await requests.post(id, ciphertext, signature);
    if (r.error === 'mailbox_unregistered') throw new Error('This treasury has no request mailbox (it was created before mailboxes existed). Ask the Owner to approve directly.');
    if (r.error) throw new Error(friendly(r.error));
  }

  const shareTo = (lsk, members) => [...new Map(members.map((m) => [m.owner, m])).values()].map((m) => encryptKeyShare(lsk, m.encPub));

  /**
   * The Payer's scope as config fields (v3.4). allowTo: up to ALLOW_SLOTS recipients, each a ZKDesk
   * address {owner, encPub} or a 0x address ([] = any recipient). budget: USDG base units per
   * budgetPeriod seconds (0n = no budget; period 0n = one budget for the policy's lifetime). Windows
   * start at UTC midnight of the day the policy is set, and a new policy starts from zero spent.
   */
  async function payerScope({ allowTo = [], budget = 0n, budgetPeriod = 0n } = {}) {
    if (allowTo.length > ALLOW_SLOTS) throw new Error(`At most ${ALLOW_SLOTS} allowed recipients.`);
    const allow = Array(ALLOW_SLOTS).fill(0n);
    const allowPubs = Array(ALLOW_SLOTS).fill(null);
    allowTo.forEach((r, i) => {
      if (typeof r === 'string') {
        allow[i] = BigInt(getAddress(r));
        if (!allow[i]) throw new Error('The zero address cannot be an allowed recipient.');
      }
      else [allow[i], allowPubs[i]] = [r.owner, r.encPub];
    });
    if (new Set(allow.filter((x) => x)).size !== allow.filter((x) => x).length) throw new Error('A recipient is listed twice.');
    if (budget < 0n || budget > MAX_AMOUNT || budgetPeriod < 0n || budgetPeriod >= 1n << 32n) throw new Error('Budget out of range.');
    const DAY = 86_400n;
    const budgetStart = budgetPeriod ? ((await chainTime()) / DAY) * DAY : 0n;
    return { allow, allowPubs, budget, budgetPeriod, budgetStart };
  }

  /**
   * New treasury with you as Owner. treasurer/payer/auditor: {owner, encPub} (a ZKDesk address;
   * default yourself). allocCap / dualThreshold in USDG base units. scope: the Payer's allow list and
   * budget (payerScope). Returns the ledger id.
   */
  async function createLedger({ name, treasurer, payer, auditor, allocCap, dualThreshold, scope }) {
    await sync();
    const self = { owner: keys.owner, encPub: keys.encPub };
    const members = [self, treasurer ?? self, payer ?? self, auditor ?? self];
    const lsk = randomField();
    const ledger = ledgerKeys(lsk);
    const config = { name, owner: self.owner, treasurer: members[1].owner, payer: members[2].owner, auditor: members[3].owner, rolesSalt: randomField(), allocCap, dualThreshold, policySalt: randomField(), ...(await payerScope(scope)) };
    // The approval-mailbox key rides on the create request; only this proof can register it.
    await relayAuth({ ledger, config, action: AUTH.create, shares: shareTo(lsk, members), configCt: encryptConfig(config, ledger.encPub), mailbox: await mailboxFields(ledger) });
    return ledger.owner;
  }

  /**
   * Owner: replace members ({owner, encPub}; omitted = unchanged) and/or change the policy. scope: a
   * new Payer allow list and budget (payerScope; omitted = unchanged). Either change resets what the
   * Payer has spent in the current window.
   */
  async function updateLedger(ledger, { treasurer, payer, auditor, allocCap = ledger.config.allocCap, dualThreshold = ledger.config.dualThreshold, scope }) {
    let current = ledger.config;
    // The policy first, then the roles: a new Payer (an agent) never holds the role before its scope
    // and threshold apply. An unchanged scope keeps its window start; any policy or roles change still
    // resets what the Payer spent in the current window (TreasuryLedger resets the accumulator).
    let nextScope = scope ? await payerScope(scope) : {};
    const was = scopeOf(current);
    if (scope && allowHash(nextScope.allow) === allowHash(was.allow) && nextScope.budget === was.budget && nextScope.budgetPeriod === was.budgetPeriod) nextScope = {};
    const policyChanges = allocCap !== current.allocCap || dualThreshold !== current.dualThreshold || Object.keys(nextScope).length > 0;
    // A Payer being replaced must not see the new policy (a fresh budget, new recipients): the Owner
    // takes the role first.
    if (policyChanges && payer && payer.owner !== current.payer && current.payer !== current.owner) {
      const next = { ...current, payer: current.owner, rolesSalt: randomField() };
      await relayAuth({ ledger, config: current, action: AUTH.rotate, newValue: rolesOf(next), configCt: encryptConfig(next, ledger.encPub) });
      current = next;
    }
    if (policyChanges) {
      const next = { ...current, allocCap, dualThreshold, ...nextScope, policySalt: randomField() };
      await relayAuth({ ledger, config: current, action: AUTH.setPolicy, newValue: policyHash(next), configCt: encryptConfig(next, ledger.encPub) });
      current = next;
    }
    const changed = { treasurer, payer, auditor };
    const roles = Object.fromEntries(Object.entries(changed).filter(([k, m]) => m && m.owner !== current[k]).map(([k, m]) => [k, m.owner]));
    if (Object.keys(roles).length) {
      const next = { ...current, ...roles, rolesSalt: randomField() };
      const joining = Object.entries(changed).filter(([k]) => k in roles).map(([, m]) => m);
      await relayAuth({ ledger, config: current, action: AUTH.rotate, newValue: rolesOf(next), shares: shareTo(ledger.lsk, joining), configCt: encryptConfig(next, ledger.encPub) });
    }
  }

  /**
   * One treasury action as `role`: allocate / deallocate (tUSDG <-> vault shares) or transfer
   * (to a ZKDesk address `to` = {owner, encPub}, or unshield to a public `recipient`). Above the
   * dual-control threshold a non-owner needs the Owner's approval; if you hold Owner too, it is
   * given first automatically.
   */
  // Every treasury transfer replaces the ledger's spending accumulator and every governance change
  // moves its counter, so two at once race: the one that lands second is proven again (a few times,
  // with a short pause). Only these refusals, which the relay gives before using the fee voucher, retry.
  const retryable = (error) => /StaleBudget|spending record changed|another change to this treasury/i.test(error?.message ?? '');
  async function againWhenBusy(fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (error) {
        if (!retryable(error) || attempt >= 4) throw error;
        status('Another treasury change landed first: proving again…');
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  /** memo: kept across attempts, so a retry spends the same notes with the same outputs (the same intent). */
  const ledgerAct = (ledger, role, action) => { const memo = {}; return againWhenBusy(() => ledgerActOnce(ledger, role, action, memo)); };

  /** The ledger as of the last sync (its spending accumulator moves with every transfer). */
  const current = (ledger) => ledgers().find((l) => l.owner === ledger.owner) ?? ledger;

  async function ledgerActOnce(ledger, role, { action, amount, asset = deployment.usdg, to = null, recipient = null }, memo = {}) {
    await sync();
    ledger = current(ledger);
    // A retry never pays twice: if the notes an earlier attempt spent are gone, that attempt (or another
    // payment) used them, so stop and let the caller check.
    if (memo.inputs && memo.inputs.some((c) => ledgerNotes(ledger).find((n) => n.commitment === c)?.status !== 'unspent')) {
      throw new Error('An earlier attempt of this treasury payment may have gone through (its funds moved). Check the treasury before paying again.');
    }
    const t = await chainTime();
    let args;
    if (action === 'allocate' || action === 'deallocate') {
      const [from, into] = action === 'allocate' ? [deployment.usdg, deployment.vault] : [deployment.vault, deployment.usdg];
      const quote = await read(deployment.vault, abis.vault, action === 'allocate' ? 'previewDeposit' : 'previewRedeem', [amount]);
      args = { action: ACTIONS[action], asset: big(from), outAsset: big(into), inputs: pickInputs(from, amount, ledgerUnspent(ledger, from)), out: { amount: (quote * 9_999n) / 10_000n }, ext: { extAmount: -amount } };
    } else {
      args = { action: ACTIONS.transfer, asset: big(asset), inputs: pickInputs(asset, amount, ledgerUnspent(ledger, asset)),
        out: to ? { amount, owner: to.owner } : { amount: 0n, owner: ledger.owner }, ext: to ? {} : { recipient, extAmount: -amount } };
    }
    if (memo.inputs) args.inputs = memo.inputs.map((c) => ledgerNotes(ledger).find((n) => n.commitment === c));
    const base = { tree: state.tree, ledger, sk: keys.sk, role, t, ...args };
    const empty = { recipient: zeroAddress, extAmount: 0n, encryptedOutput1: '0x', encryptedOutput2: '0x', ...args.ext };
    if (!memo.inputs) {
      const draft = buildLedger({ ...base, ext: empty });
      const [o1, o2] = draft.outputs;
      // A transfer's change note also records who was paid, for the members' spending report (v3.18).
      // With the payment note's blinding, members can check the recipient against its on-chain commitment.
      const paidTo = action === 'allocate' || action === 'deallocate' ? undefined : to ? { owner: to.owner, encPub: to.encPub, blinding: o2.blinding } : recipient ?? undefined;
      memo.ext = { ...empty, encryptedOutput1: encryptNote(o1, ledger.encPub, paidTo), encryptedOutput2: encryptNote(o2, to?.encPub ?? ledger.encPub) };
      memo.blindings = { outputs: draft.outputs.map((o) => o.blinding), dummies: draft.dummies };
      memo.inputs = args.inputs.map((n) => n.commitment);
    }
    const ext = memo.ext;
    const built = buildLedger({ ...base, ext, blindings: memo.blindings });
    if (built.needsOwner) {
      if (!ledger.roles.includes('Owner')) {
        if (!requests) throw new Error('This is above the dual-control threshold: the treasury Owner must approve it.');
        // Dual control across members: park the exact transfer for the Owner (no gas).
        status('Sending the request to the treasury Owner…');
        const request = {
          v: 1, from: keys.owner, role, asset: big(asset), amount, to, recipient, at: Date.now(), intent: built.intent,
          inputs: args.inputs.map((n) => n.commitment), outputs: built.outputs.map((o) => o.blinding), dummies: built.dummies, ext,
        };
        await postRequest(ledger, sealRequest(request, ledger.requestKey));
        return { requested: true, intent: built.intent };
      }
      // The same intent on every attempt, so an approval from an earlier attempt still counts.
      if (!ledger.approved.has(built.intent)) {
        status('Approving as Owner (dual control)…');
        await relayAuth({ ledger, config: ledger.config, action: AUTH.approve, newValue: built.intent });
      }
    }
    return submitLedger(built, ext);
  }

  async function submitLedger(built, ext) {
    const paid = await voucher(); // personal notes only; the proof spends treasury notes
    try {
      return await submitLedgerWith(built, ext, paid);
    } catch (error) {
      keepVoucher(paid, error);
      throw error;
    }
  }
  async function submitLedgerWith(built, ext, paid) {
    status('Generating proof…');
    const { proof } = await prove('ledger', built.witness);
    const p = built.public;
    const hexAddr = (x) => '0x' + x.toString(16).padStart(40, '0');
    return submitRelay({
      kind: 'ledger',
      proof: {
        proof, root: s(p.root), ledgerId: s(p.ledgerId), action: Number(p.action), asset: hexAddr(p.asset), outAsset: hexAddr(p.outAsset), publicAmount: s(p.publicAmount),
        publicAmountOut: s(p.publicAmountOut), extDataHash: s(p.extDataHash), inputNullifiers: p.inputNullifiers.map(s), outputCommitments: p.outputCommitments.map(s),
        cosignIntent: s(p.cosignIntent), t: s(p.t), budgetOld: s(p.budgetOld), budgetNew: s(p.budgetNew), budgetCt: p.budgetCt.map(s),
      },
      ext: { ...ext, extAmount: s(ext.extAmount) },
      voucher: paid,
    });
  }

  /** Rebuilds a request exactly as proposed; null if it does not reproduce its intent. */
  function rebuildRequest(ledger, r, sk, check, t) {
    const notes = ledgerNotes(ledger);
    const inputs = r.inputs.map((c) => notes.find((n) => n.commitment === c));
    if (inputs.some((n) => !n)) return null;
    const out = r.to ? { amount: r.amount, owner: r.to.owner } : { amount: 0n, owner: ledger.owner };
    try {
      const built = buildLedger({ tree: state.tree, ledger, sk, role: r.role, action: ACTIONS.transfer, asset: r.asset, inputs, out, ext: r.ext, t, blindings: { outputs: r.outputs, dummies: r.dummies }, check });
      return built.intent === r.intent && built.needsOwner ? { built, inputs } : null;
    } catch {
      return null;
    }
  }

  /**
   * Approval requests for a treasury, newest first, verified against the chain: Awaiting Owner,
   * Approved (the requester can complete it), Completed, or Expired (its notes moved otherwise).
   */
  async function ledgerRequests(ledger) {
    if (!requests) return [];
    const rows = await requests.list(hexId(ledger.owner));
    const out = [];
    for (const row of rows) {
      const r = openRequest(row.ciphertext, ledger.requestKey);
      if (!r || r.v !== 1) continue;
      const rebuilt = rebuildRequest(ledger, r, keys.sk, false, BigInt(Math.floor(Date.now() / 1000)));
      if (!rebuilt) continue;
      const spent = rebuilt.inputs.some((n) => n.status === 'spent');
      const approved = ledger.approved.has(r.intent);
      const statusText = spent ? (approved ? 'Completed' : 'Expired') : approved ? 'Approved' : 'Awaiting Owner';
      out.push({ ...r, id: row.id, status: statusText, mine: r.from === keys.owner });
    }
    return out;
  }

  /**
   * Owner: allow at most `maxTransfers` transfers without the Owner's approval per `periodSeconds`
   * (TreasuryLedger SET_LIMIT; 0 removes the limit). Each is below the dual-control threshold, so this
   * bounds the cumulative outflow without revealing any amount.
   */
  const setTransferLimit = (ledger, maxTransfers, periodSeconds) =>
    relayAuth({ ledger, config: ledger.config, action: AUTH.setLimit, newValue: BigInt(maxTransfers) | (BigInt(periodSeconds) << 64n) });

  /** Owner: approve the exact transfer in a request. */
  const approveRequest = (ledger, request) => relayAuth({ ledger, config: ledger.config, action: AUTH.approve, newValue: request.intent });

  /** Requester: send an approved request (re-proven on the current tree with the same blindings). */
  async function completeRequest(ledger, request) {
    const once = async () => {
      await sync();
      if (request.from !== keys.owner) throw new Error('Only the member who requested this transfer can complete it.');
      const rebuilt = rebuildRequest(current(ledger), request, keys.sk, true, await chainTime());
      if (!rebuilt) throw new Error('This request no longer matches the treasury notes.');
      return submitLedger(rebuilt.built, request.ext);
    };
    return againWhenBusy(once); // approved transfers also move the spending accumulator
  }

  // ---- Treasury spending report (v3.18) ----
  // Chain reads behind the report, cached: a mined transaction and a block time never change. A failed
  // read is retried after a minute, not on every refresh.
  const cached = (map, key, read) => {
    const hit = map.get(key);
    if (hit && (hit.value !== null || Date.now() - hit.at < 60_000)) return hit.value;
    return read().catch(() => null).then((value) => { map.set(key, { value, at: Date.now() }); return value; });
  };
  const callCache = new Map();
  const timeCache = new Map();
  const callOf = (hash) => cached(callCache, hash, async () => {
    const t = await publicClient.getTransaction({ hash });
    // Input that is not an act() call (a contract wrapping it) never will be: cached as such, not retried.
    let args = null;
    try { args = decodeFunctionData({ abi: abis.ledger, data: t.input }).args; } catch { /* not the ledger's own call */ }
    return { to: t.to, args };
  });
  const timeOf = (block) => cached(timeCache, block, async () => Number((await publicClient.getBlock({ blockNumber: block })).timestamp));
  /** Runs fn over items a few at a time (public RPCs throttle bursts). */
  async function inBatches(items, fn, size = 8) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    return out;
  }

  /**
   * Payments out of a treasury, newest first (src/lib/zk/report.js paymentRows), each with its time
   * (unix seconds). since: only payments from then on. period: what the current Payer spent in this
   * budget window, and the budget.
   */
  async function ledgerPayments(ledger, { since = 0 } = {}) {
    ledger = current(ledger);
    const events = state.ledgerEvents.filter((e) => e.id === ledger.owner);
    const pulls = state.pulls.filter((p) => p.ledgerId === ledger.owner);
    const transfers = events.filter((e) => e.name === 'BudgetNote' && e.commit);
    const blocks = [...new Set([...transfers, ...pulls].map((e) => e.block))];
    const times = new Map(await inBatches(blocks, async (b) => [b, await timeOf(b)]));
    const recent = (e) => (times.get(e.block) ?? Infinity) >= since;
    // Calls are read only for the payments in range (an unreadable one is shown as 'unknown').
    const calls = new Map(await inBatches(transfers.filter(recent).map((e) => e.tx), async (tx) => [tx, await callOf(tx)]));
    const ciphertextsByTx = new Map();
    for (const c of state.ciphertexts) ciphertextsByTx.set(c.tx, [...(ciphertextsByTx.get(c.tx) ?? []), c]);
    // Who asked for each approved transfer (approval mailbox requests open with the ledger's request key).
    const intentsFrom = new Map();
    if (requests) {
      for (const row of await requests.list(hexId(ledger.owner)).catch(() => [])) {
        const r = openRequest(row.ciphertext, ledger.requestKey);
        if (r?.intent !== undefined) intentsFrom.set(r.intent, r.from);
      }
    }
    const rows = paymentRows({
      ledger, events, notes: ledgerNotes(ledger), ciphertextsByTx, pulls, mandates: ledgerMandates(state, ledger), calls, intentsFrom, ledgerAddress: deployment.ledger,
    }).filter(recent);
    for (const r of rows) r.at = times.get(r.block) ?? null;
    const scope = scopeOf(ledger.config);
    return {
      rows: rows.reverse(),
      period: { spent: (() => { try { return ledger.budget ? payerSpent(ledger, BigInt(Math.floor(Date.now() / 1000))) : 0n; } catch { return 0n; } })(), budget: scope.budget, budgetPeriod: scope.budgetPeriod },
    };
  }

  /** Treasury statement: the ledger's assets cover `liabilities` (USDG base units). Publishes only that. */
  async function ledgerAttest(ledger, liabilities) {
    const paid = await voucher();
    await sync();
    const [assets, prices] = await read(deployment.ledger, abis.ledger, 'attestPrices');
    const built = buildAttest({ tree: state.tree, ledger, notes: ledgerNotes(ledger), assets: [...assets], prices: [...prices], liabilities });
    status('Generating proof…');
    const { proof } = await prove('treasury_attest', built.witness);
    const p = built.public;
    return submitRelay({ kind: 'ledger_attest', proof: { proof, root: s(p.root), ledgerId: s(p.ledgerId), liabilities: s(liabilities), nullifiers: p.nullifiers.map(s) }, voucher: paid });
  }

  // ---- Payment mandates and receipts ----

  const mandates = (ledger) => ledgerMandates(state, ledger);
  const chainTime = async () => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp;

  const relayMandateAuth = (ledger, role, action, mandate, ciphertext = '0x') => againWhenBusy(() => relayMandateAuthOnce(ledger, role, action, mandate, ciphertext));
  async function relayMandateAuthOnce(ledger, role, action, mandate, ciphertext) {
    const commit = mandateCommit(ledger.owner, mandate);
    // The mandate's change counter: each proof applies once (v3.4).
    const nonce = action === MANDATE_ACTIONS.commit ? 0n : await read(deployment.mandates, abis.mandates, 'changes', [commit]);
    const built = buildMandateAuth({ ledger, sk: keys.sk, role, action, mandate, ciphertext, nonce }); // its checks run before any fee
    const paid = await voucher();
    try {
      status('Generating proof…');
      const { proof } = await prove('mandate_auth', built.witness);
      try {
        return await submitRelay({ kind: 'mandate_auth', proof: { proof, ledgerId: s(ledger.owner), action, mandateCommit: s(built.commit), nonce: s(nonce) }, ext: { ciphertext }, voucher: paid });
      } catch (error) {
        if (action !== MANDATE_ACTIONS.commit && (await read(deployment.mandates, abis.mandates, 'changes', [commit])) !== nonce) throw new Error('Another change to this treasury landed first.');
        throw error;
      }
    } catch (error) {
      keepVoucher(paid, error);
      throw error;
    }
  }

  /**
   * New mandate from a treasury. kind: 'Payroll' | 'Invoice' | 'Vendor'; to: {owner, encPub} (a
   * ZKdesk address); cap in USDG base units (per pull; stock mandates convert at the mark);
   * period: 'Monthly' | 'Weekly' | 'One-time'; expiry: unix seconds; reference: invoice text.
   */
  async function createMandate(ledger, role, { kind, to, label = '', asset = deployment.usdg, cap, period, expiry, reference = '' }) {
    const k = KINDS.indexOf(kind);
    const mandate = {
      kind: BigInt(k), recipient: to.owner, recipientEncPub: to.encPub, asset: big(asset), cap, period: k === 1 ? 0n : PERIODS[period],
      start: await chainTime(), expiry: BigInt(expiry), reference: reference ? textToField(reference) : 0n, salt: randomField(), label,
    };
    await relayMandateAuth(ledger, role, MANDATE_ACTIONS.commit, mandate, encryptMandate(mandate, ledger.encPub));
    return mandate;
  }

  /** action: 'revoke' | 'pause' | 'resume'. */
  const manageMandate = (ledger, role, mandate, action) => relayMandateAuth(ledger, role, MANDATE_ACTIONS[action], mandate);

  /** Pays the current period of a mandate (usdgAmount ≤ cap). Stock mandates convert at the pinned mark. */
  async function payMandate(ledger, role, mandate, usdgAmount) {
    const paid = await voucher();
    await sync();
    const t = await chainTime();
    const k = currentPeriod(mandate, t);
    if (mandate.paid.has(k)) throw new Error('This mandate is already paid for the current period.');
    const usdgAsset = mandate.asset === USDG;
    const mark = usdgAsset ? 0n : big((await read(deployment.marker, abis.marker, 'current', ['0x' + mandate.asset.toString(16).padStart(40, '0')]))[0]);
    const raw = rawForUsdg(usdgAmount, mark);
    const inputs = pickInputs(mandate.asset, raw, ledgerUnspent(ledger, mandate.asset));
    const base = { tree: state.tree, ledger, sk: keys.sk, role, mandate, k, t, usdgAmount, mark, inputs };
    const draft = buildPull({ ...base, ext: {} });
    const [o1, o2] = draft.outputs;
    const ext = { encryptedOutput1: encryptNote(o1, ledger.encPub), encryptedOutput2: encryptNote(o2, mandate.recipientEncPub) };
    const built = buildPull({ ...base, ext, blindings: { outputs: draft.outputs.map((o) => o.blinding) } });
    status('Generating proof…');
    const { proof } = await prove('mandate_pull', built.witness);
    const p = built.public;
    const hexAddr = (x) => '0x' + x.toString(16).padStart(40, '0');
    return submitRelay({
      kind: 'mandate_pull',
      proof: { proof, root: s(p.root), ledgerId: s(p.ledgerId), mandateCommit: s(p.mandateCommit), asset: hexAddr(p.asset), mark: s(p.mark), k: s(p.k), t: s(p.t), pullNullifier: s(p.pullNullifier), receiptLeaf: s(p.receiptLeaf), extDataHash: s(p.extDataHash), inputNullifiers: p.inputNullifiers.map(s), outputCommitments: p.outputCommitments.map(s) },
      ext,
      voucher: paid,
    });
  }

  /** Payments you received under mandates (personal notes). */
  const receipts = () => myReceipts(state, notes());

  /**
   * A receipt proof for a received payment, addressed to `verifier` (a 0x address or number),
   * disclosing only what you choose. Returns a JSON-safe record anyone can check with verifyReceipt.
   */
  async function proveReceipt(receipt, { verifier, discloseAmount = false, discloseOwner = false }) {
    await sync();
    const built = buildReceipt({ receipts: state.receipts, sk: keys.sk, payment: receipt.note, ledgerId: receipt.ledgerId, k: receipt.k, leafIndex: receipt.leafIndex, verifier: big(verifier), discloseAmount, discloseOwner });
    status('Generating proof…');
    const { proof } = await prove('receipt', built.witness);
    const p = built.public;
    return {
      type: 'ZKDesk payment receipt', chainId: publicClient.chain?.id, registry: deployment.mandates,
      proof: { proof, receiptRoot: s(p.receiptRoot), ledgerId: s(p.ledgerId), k: s(p.k), asset: '0x' + p.asset.toString(16).padStart(40, '0'), verifier: s(p.verifier), discloseAmount, amount: s(p.amountOut), discloseOwner, owner: s(p.ownerOut) },
    };
  }

  function positions() {
    return myPositions(state, keys).map((p) => {
      const symbol = Object.keys(stocks).find((k) => big(stocks[k].token) === p.asset);
      return { ...p, symbol, ltvBps: stocks[symbol]?.ltvBps };
    });
  }

  return {
    sync, notes, positions, deposit, send, combine, credit, deskHealth,
    ledgers, ledgerNotes, createLedger, updateLedger, ledgerAct, ledgerAttest, ledgerRequests, ledgerPayments, approveRequest, completeRequest, setTransferLimit,
    mandates, createMandate, manageMandate, payMandate, receipts, proveReceipt,
    ledgerBalance: (ledger, asset, st = 'unspent') => balanceOf(ledgerNotes(ledger), big(asset), st),
    lend: (amount) => convert('lend', amount),
    redeem: (shares) => convert('redeem', shares),
    balance: (asset, st = 'unspent') => balanceOf(notes(), big(asset), st),
    market, get state() { return state; },
    owner: keys.owner,
    /** Relays submitted so far (counted before each submission, whatever its outcome). */
    get relaysSent() { return relaysSent; },
    /** Agents: the most a step may pay in relay fees (null: no ceiling). */
    setFeeCeiling: (c) => { ceiling = c; },
    /** The relay fee a step paid in `asset` costs now (a voucher step costs voucherPrice times this). */
    quoteFee: async (asset = deployment.usdg) => { const info = await relayInfo(); return { fee: quote(info, asset), voucherPrice: BigInt(info.voucherPrice ?? 2) }; },
    /** The wallet that funds deposits; a passkey account links one only when it adds funds. */
    setAddress: (a) => { address = a; },
  };
}


const FRIENDLY = {
  NullifierSpent: 'These funds were already spent. Your balance has been refreshed.',
  UnknownRoot: 'The pool moved on while your proof was being made. Please try again.',
  ExtDataHashMismatch: 'The transaction details changed after proving and were rejected.',
  InvalidProof: 'The proof was rejected by the verifier.',
  MarkUnusable: 'The price moved or is stale. Please refresh and try again; closing a position always works.',
  TooSoon: 'A position can borrow or withdraw once every 10 minutes. Adding collateral, repaying and closing are always available.',
  EmptyStep: 'A credit step must move collateral or debt.',
  StaleIndex: 'Rates were just updated. Please try again.',
  SlotMismatch: 'That position changed. Please refresh and try again.',
  ExposureCap: 'This collateral class is at its exposure cap.',
  DeskPaused: 'New borrowing is paused. Repaying and closing still work.',
  AlreadyPaid: 'This mandate is already paid for this period.',
  NotActive: 'This mandate is paused or revoked.',
  StaleTime: 'The payment proof took too long. Please try again.',
  StaleBudget: "The treasury's spending record changed while proving (another payment landed first). Please try again.",
  spend_in_flight: 'Another payment using these funds is still being confirmed. Please try again in a moment.',
  ledger_busy: 'Another change to this treasury is still being confirmed. Please try again in a moment.',
  BadMandate: 'This mandate cannot change to that state.',
  NotApproved: 'The treasury Owner has not approved this transfer yet.',
  StaleRoles: 'The treasury roles or policy changed. Please refresh and try again.',
  NoteSpent: 'Treasury funds moved while the statement was being proven. Please try again.',
  HealthStale: 'The desk health attestation is overdue, so new borrowing is paused. Repaying and closing still work.',
  InsufficientLiquidity: 'The lending pool does not have enough USDG right now.',
  mailbox_key_mismatch: 'This treasury\'s request mailbox is registered to another key, so requests cannot be posted. Approve as Owner instead.',
  mailbox_full: 'This treasury received too many approval requests today. Please try again tomorrow.',
  mailbox_busy: 'The request mailbox is busy right now. Please try again in an hour.',
  mailbox_closed: 'A request mailbox can only be set up while creating a treasury.',
  unknown_ledger: 'This treasury does not exist on this network.',
  bad_signature: 'The approval request could not be signed for this treasury.',
  voucher_required: 'The relay fee voucher was missing or already used. Please try again.',
  fee_too_low: 'Network fees rose while your proof was being made. Please try again.',
  fee_asset_unavailable: 'That asset cannot pay the relay fee right now (its price is unavailable). Use USDG.',
  relayer_unavailable: 'The relayer is unavailable right now. Please try again shortly.',
  pending_long: 'Submitted, but not confirmed yet. It is checked automatically; refresh in a minute before retrying.',
  replaced: 'The relayed transaction was replaced before it confirmed, so nothing moved. Please try again.',
  send_uncertain: 'The relayer could not confirm sending your transaction. It will be checked automatically; refresh in a minute.',
  'HTTP request failed.': `${NETWORK_NAME} is not reachable right now (RPC). Check your connection and try again.`,
  'Failed to fetch': `${NETWORK_NAME} is not reachable right now (RPC). Check your connection and try again.`,
};
export const friendly = (code) => FRIENDLY[code] || code || 'The transaction failed.';
export { debtOf, maxDebt, valueOf, LENDING };

/**
 * Checks an exported receipt (proveReceipt output) against ZKDesk's MandateRegistry on this chain: the
 * current one, or a replaced contract set's for an older receipt. No keys needed. expectedVerifier (a
 * 0x EVM address): refuse a receipt made out to anyone else, including one for anyone (verifier 0),
 * which could have been shown to anyone. A receipt can be presented more than once: a verifier that
 * grants something per receipt remembers the ones it accepted.
 */
export async function verifyReceipt(publicClient, record, options) {
  const expectedVerifier = options?.expectedVerifier;
  const p = record.proof;
  // The record names its registry and chain: only ZKDesk's own count, or a forged contract could answer true.
  if (publicClient.chain?.id !== deployment.chainId) throw new Error(`Verify with a client on chain ${deployment.chainId}.`);
  if (record.chainId !== undefined && Number(record.chainId) !== deployment.chainId) throw new Error('This receipt is for another network.');
  const ours = [deployment, ...Object.values(deployment)].map((d) => d?.mandates).filter(Boolean).map((a) => a.toLowerCase());
  const registry = String(record.registry ?? deployment.mandates).toLowerCase();
  if (!ours.includes(registry)) throw new Error("This receipt names a contract that is not ZKDesk's MandateRegistry on this network.");
  const verifier = (() => { try { return BigInt(p?.verifier); } catch { throw new Error('This receipt names no valid verifier.'); } })(); // read once: checked and verified
  if (expectedVerifier !== undefined && expectedVerifier !== null) {
    if (/^zkd:/i.test(String(expectedVerifier))) throw new Error('Receipts are made out to a 0x EVM address, not a zkd: address.');
    // Only a 0x address (or a bigint): a bare decimal or 0b/0o string would name another number.
    const want = typeof expectedVerifier === 'bigint' ? expectedVerifier : /^0x[0-9a-f]{1,40}$/i.test(String(expectedVerifier)) ? BigInt(expectedVerifier) : -1n;
    // A value that reads as 0 ('', ' ', '0') would accept receipts for anyone: refused, like any non-address.
    if (want <= 0n || want >= 2n ** 160n) throw new Error(`expectedVerifier must be a non-zero 0x address (got "${expectedVerifier}").`);
    if (verifier !== want) throw new Error(`This receipt is made out to ${verifier === 0n ? 'anyone (verifier 0)' : `verifier 0x${verifier.toString(16)}`}, not 0x${want.toString(16)}.`);
  }
  return publicClient.readContract({
    address: registry, abi: abis.mandates, functionName: 'verifyReceipt',
    args: [{ ...p, receiptRoot: BigInt(p.receiptRoot), ledgerId: BigInt(p.ledgerId), k: BigInt(p.k), verifier, amount: BigInt(p.amount), owner: BigInt(p.owner) }],
  });
}
