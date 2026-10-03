// Treasury ledgers: keys from the shared ledger secret, and witness builders for circuits/ledger,
// circuits/role_auth and circuits/treasury_attest. Pure: nothing leaves the caller.
import { encodeAbiParameters, keccak256, zeroAddress } from 'viem';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  ALLOW_SLOTS, allowHash, budgetCommit, budgetPad, cosignIntent, FIELD, ledgerId, MAX_AMOUNT, noteCommitment, nullifier,
  nullifierKey, ownerPk, policyHash, publicAmount, randomField, rolesCommit, toHex,
} from './notes.js';
import { encPublicKey } from './crypto.js';
import { inputPaths, pad, padInputs } from './transact.js';

export const ROLES = ['Owner', 'Treasurer', 'Payer', 'Auditor'];
export const ACTIONS = { allocate: 0, deallocate: 1, transfer: 2 };
export const AUTH = { create: 0, rotate: 1, setPolicy: 2, approve: 3, setLimit: 4 };
export const ATTEST_NOTES = 8; // circuits/treasury_attest K
export const ATTEST_ASSETS = 6; // circuits/treasury_attest A

const str = (x) => x.toString();

/** Messages a treasury's mailbox key signs; api/requests.js verifies them. ledger: 0x + 64 hex. */
export const mailboxMessages = {
  register: (ledger) => `ZKDesk mailbox v1 register ${ledger}`,
  post: (ledger, ciphertext) => `ZKDesk mailbox v1 post ${ledger} ${keccak256(ciphertext)}`,
};

/** Ledger keys, shaped like personal keys so wallet.myNotes can open ledger notes. */
export function ledgerKeys(lsk) {
  const encSecret = hkdf(sha256, hexToBytes(toHex(lsk).slice(2)), new TextEncoder().encode('ZKDesk ledger v1'), new TextEncoder().encode('encrypt'), 32);
  const requestKey = hkdf(sha256, hexToBytes(toHex(lsk).slice(2)), new TextEncoder().encode('ZKDesk ledger v1'), new TextEncoder().encode('request'), 32);
  // secp256k1 key that signs approval-mailbox posts (api/requests.js); members only, like the rest.
  const mailboxKey = hkdf(sha256, hexToBytes(toHex(lsk).slice(2)), new TextEncoder().encode('ZKDesk ledger v1'), new TextEncoder().encode('mailbox'), 32);
  return { lsk, owner: ledgerId(lsk), nk: nullifierKey(lsk), encSecret, encPub: encPublicKey(encSecret), requestKey, mailboxKey };
}

/**
 * config: {owner, treasurer, payer, auditor (owner pks), rolesSalt, allocCap, dualThreshold, policySalt}
 * plus the Payer scope (v3.4; all optional, default none): allow (ALLOW_SLOTS owner keys or addresses,
 * 0 = unused), budget (USDG base units per window, 0 = none), budgetPeriod (seconds, 0 = one window),
 * budgetStart (unix seconds).
 */
export const rolePks = (c) => [c.owner, c.treasurer, c.payer, c.auditor];
export const scopeOf = (c) => ({
  allow: c.allow ?? Array(ALLOW_SLOTS).fill(0n), budget: c.budget ?? 0n, budgetPeriod: c.budgetPeriod ?? 0n, budgetStart: c.budgetStart ?? 0n,
});
/** The Payer is scoped when the policy has an allow list or a budget. */
export const payerScoped = (c) => { const x = scopeOf(c); return allowHash(x.allow) !== 0n || x.budget !== 0n; };
const mod = (x) => ((x % FIELD) + FIELD) % FIELD;
/** The budget window of time t (0 when the policy has no period). */
export const budgetWindow = (c, t) => {
  const x = scopeOf(c);
  if (!x.budgetPeriod) return 0n;
  if (t < x.budgetStart) throw new Error('The treasury budget has not started yet. Try again in a moment.');
  return (t - x.budgetStart) / x.budgetPeriod;
};
/**
 * The ledger's spending accumulator from its latest TreasuryLedger BudgetNote {commit, nonce, ct}: null
 * if it does not open (not this ledger's), {commit: 0n, ...} when fresh.
 */
export function openBudget(lsk, note) {
  if (!note || !note.commit) return { commit: 0n, window: 0n, spent: 0n, blinding: 0n };
  const window = mod(note.ct[0] - budgetPad(lsk, note.nonce, 0));
  const spent = mod(note.ct[1] - budgetPad(lsk, note.nonce, 1));
  const blinding = budgetPad(lsk, note.nonce, 2);
  return budgetCommit(ledgerId(lsk), window, spent, blinding) === note.commit ? { commit: note.commit, window, spent, blinding } : null;
}
/**
 * The Payer's share of each treasury transfer, from the ledger's BudgetNotes in chain order (v3.18
 * spending report): delta is the amount the Payer's spending record rose by, so > 0 means the Payer
 * made that transfer on its own, and 0 means the Owner or Treasurer made it, or the Owner approved it. A
 * reset note (roles or policy changed) starts again from zero; a new window starts from its own amount.
 */
export function payerDeltas(lsk, notes) {
  let prev = { window: 0n, spent: 0n };
  const out = [];
  for (const e of notes) {
    const b = openBudget(lsk, e);
    if (!b) continue;
    if (!e.commit) { prev = { window: 0n, spent: 0n }; continue; }
    out.push({ note: e, delta: b.window === prev.window ? b.spent - prev.spent : b.spent });
    prev = b;
  }
  return out;
}

/** What the Payer has spent in the budget window of time t (0 after a rollover). */
export const payerSpent = (ledger, t) => {
  const b = ledger.budget;
  if (!b?.commit) return 0n;
  return budgetWindow(ledger.config, t) === b.window ? b.spent : 0n;
};
export const rolesOf = (c) => rolesCommit(rolePks(c), c.rolesSalt);
/** Roles this personal owner key holds in the ledger (a person may hold several). */
export const heldRoles = (c, owner) => ROLES.filter((_, i) => rolePks(c)[i] === owner);

// Must match TreasuryLedger.LedgerExt field order.
const LEDGER_EXT = [{ type: 'tuple', components: [
  { name: 'recipient', type: 'address' }, { name: 'extAmount', type: 'int256' },
  { name: 'encryptedOutput1', type: 'bytes' }, { name: 'encryptedOutput2', type: 'bytes' },
] }];
export const ledgerExtHash = (ext) => BigInt(keccak256(encodeAbiParameters(LEDGER_EXT, [{ recipient: zeroAddress, extAmount: 0n, ...ext }]))) % FIELD;
/** role_auth ext: the key shares and config ciphertext posted with the action. */
/**
 * Binds a governance proof to its key shares, config ciphertext, (on a create) mailbox key (audit L-c)
 * and the ledger's governance nonce (TreasuryLedger.authNonce, v3.4), so it applies once.
 */
export const authExtHash = (shares, config, mailbox = '0x0000000000000000000000000000000000000000', nonce = 0n) =>
  BigInt(keccak256(encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes' }, { type: 'address' }, { type: 'uint64' }], [shares, config, mailbox, BigInt(nonce)]))) % FIELD;

/**
 * One ledger action. ledger: ledgerKeys + {config, budget?} (budget: openBudget of the latest note).
 * sk/role: the acting member's personal key and role name. inputs: ledger notes in `asset`. out:
 * {amount, owner?, blinding?} (output 1; for converts the owner is the ledger). ext: {recipient,
 * extAmount, encryptedOutput1, encryptedOutput2}. t: chain time (unix seconds) for the budget window.
 * check: false skips the friendly role/policy checks (tests prove the circuit itself rejects).
 */
export function buildLedger({ tree, ledger, sk, role, action, asset, outAsset = asset, inputs = [], out = { amount: 0n }, ext, t = BigInt(Math.floor(Date.now() / 1000)), blindings = {}, check = true }) {
  const r = ROLES.indexOf(role);
  const c = ledger.config;
  if (r < 0) throw new Error(`Unknown role ${role}.`);
  if (check && !heldRoles(c, ownerPk(sk)).includes(role)) throw new Error(`You do not hold the ${role} role in this treasury.`);
  const id = ledger.owner;
  const ins = padInputs(inputs, blindings.dummies);
  const extAmount = BigInt(ext.extAmount ?? 0n);
  const sumIn = ins.reduce((t, n) => t + n.amount, 0n);
  const convert = action !== ACTIONS.transfer;
  const change = convert ? sumIn + extAmount : sumIn + extAmount - out.amount;
  const moved = sumIn - change;
  if (change < 0n) throw new Error('Not enough treasury balance for this action.');
  for (const v of [change, out.amount, moved]) if (v < 0n || v > MAX_AMOUNT) throw new Error('Amount out of range.');
  if (check && role === 'Auditor') throw new Error('The Auditor role can view the treasury but cannot move funds.');
  if (check && convert && r > 1) throw new Error('Only the Owner or Treasurer can allocate or deallocate.');
  if (check && action === ACTIONS.allocate && moved > c.allocCap) throw new Error('This exceeds the allocation cap in the treasury policy.');

  const outOwner = convert ? id : out.owner;
  const ob = blindings.outputs ?? [randomField(), randomField()];
  const outputs = [
    { asset, amount: change, owner: id, blinding: ob[0] },
    { asset: outAsset, amount: out.amount, owner: outOwner, blinding: ob[1] },
  ].map((o) => ({ ...o, commitment: noteCommitment(o) }));
  const inputNullifiers = ins.map((n) => nullifier(noteCommitment({ asset, amount: n.amount, owner: id, blinding: n.blinding }), ledger.nk));
  const extDataHash = ledgerExtHash(ext);
  const intent = cosignIntent(id, inputNullifiers, outputs.map((o) => o.commitment), extDataHash);
  const needsOwner = action === ACTIONS.transfer && moved > c.dualThreshold && r !== 0;

  // Payer scope and the spending accumulator (circuits/ledger).
  const scope = scopeOf(c);
  const scoped = !convert && r === 2 && !needsOwner;
  const recipient = BigInt(ext.recipient ?? zeroAddress);
  if (check && scoped && allowHash(scope.allow) !== 0n) {
    const listed = (x) => x !== 0n && scope.allow.includes(x);
    if ((out.amount > 0n && !listed(out.owner)) || (extAmount < 0n && !listed(recipient))) {
      throw new Error("This recipient is not on the treasury's list of allowed recipients for the Payer.");
    }
  }
  // A recorded accumulator always opens for members (the proof publishes its opening); null would mean
  // a sync problem. With check off (rebuilding a request only for its intent) it is not needed.
  if (check && !convert && ledger.budget === null) throw new Error("This treasury's spending record could not be read. Please refresh and try again.");
  const acc = ledger.budget ?? { commit: 0n, window: 0n, spent: 0n, blinding: 0n };
  let budgetNew = acc.commit;
  let budgetCt = [0n, 0n];
  let window = 0n;
  let spent = 0n;
  if (!convert) {
    window = scope.budgetPeriod && (check || t >= scope.budgetStart) ? budgetWindow(c, t) : acc.window;
    if (check && window < acc.window) throw new Error('The treasury budget moved on. Refresh and try again.');
    spent = (window === acc.window ? acc.spent : 0n) + (scoped ? moved : 0n);
    if (check && scoped && scope.budget && spent > scope.budget) {
      // The budget is in USDG base units; other assets count by their own (finer) base units, so a
      // budget effectively keeps a scoped Payer to USDG.
      const left = scope.budget - (spent - moved);
      throw new Error(`This would take the Payer over the treasury budget (${Number(left > 0n ? left : 0n) / 1e6} USDG left in this period).`);
    }
    const nonce = inputNullifiers[0];
    budgetNew = budgetCommit(id, window, spent, budgetPad(ledger.lsk, nonce, 2));
    budgetCt = [mod(window + budgetPad(ledger.lsk, nonce, 0)), mod(spent + budgetPad(ledger.lsk, nonce, 1))];
  }

  const paths = inputPaths(tree, ins);
  const root = tree.size ? tree.root : 0n;
  const pub = {
    root, ledgerId: id, rolesCommit: rolesOf(c), policyHash: policyHash(c), action: BigInt(action), asset, outAsset,
    publicAmount: publicAmount(extAmount), publicAmountOut: convert ? out.amount : 0n, extDataHash,
    inputNullifiers, outputCommitments: outputs.map((o) => o.commitment), cosignIntent: needsOwner ? intent : 0n,
    recipient, t, budgetOld: acc.commit, budgetNew, budgetCt,
  };
  const witness = {
    root: str(root), ledger_id: str(id), roles_commit: str(pub.rolesCommit), policy_hash: str(pub.policyHash), action: str(action),
    asset: str(asset), out_asset: str(outAsset), public_amount: str(pub.publicAmount), public_amount_out: str(pub.publicAmountOut),
    ext_data_hash: str(extDataHash), input_nullifiers: inputNullifiers.map(str), output_commitments: pub.outputCommitments.map(str),
    cosign_intent: str(pub.cosignIntent), recipient: str(recipient), t: str(t), budget_old: str(acc.commit), budget_new: str(budgetNew),
    budget_ct: budgetCt.map(str), lsk: str(ledger.lsk), sk: str(sk), role: r, role_pks: rolePks(c).map(str), roles_salt: str(c.rolesSalt),
    alloc_cap: str(c.allocCap), dual_threshold: str(c.dualThreshold), allow: scope.allow.map(str), budget: str(scope.budget),
    budget_period: str(scope.budgetPeriod), budget_start: str(scope.budgetStart), policy_salt: str(c.policySalt),
    in_amounts: ins.map((n) => str(n.amount)), in_blindings: ins.map((n) => str(n.blinding)),
    in_path_depths: paths.map((p) => p.depth), in_path_indices: paths.map((p) => str(p.index)), in_path_siblings: paths.map((p) => p.siblings.map(str)),
    out_amounts: outputs.map((o) => str(o.amount)), out_owner: str(outOwner), out_blindings: ob.map(str),
    old_window: str(acc.window), old_spent: str(acc.spent), old_blinding: str(acc.blinding), window: str(window),
  };
  return { witness, public: pub, outputs, intent, needsOwner, scoped, spent, dummies: ins.slice(inputs.length).map((n) => n.blinding) };
}

/**
 * role_auth (OWNER). For create, `config` is the new config and rolesCommit/policyHash are its own;
 * otherwise `config` is the current one and newValue the new roles commit / policy hash / intent.
 */
export function buildRoleAuth({ ledger, sk, config, action, newValue = 0n, extHash }) {
  if (rolePks(config)[0] !== ownerPk(sk)) throw new Error('Only the Owner can change roles, policy or approvals.');
  const pub = { ledgerId: ledger.owner, rolesCommit: rolesOf(config), policyHash: policyHash(config), action: BigInt(action), newValue, extDataHash: extHash };
  const witness = {
    ledger_id: str(pub.ledgerId), roles_commit: str(pub.rolesCommit), policy_hash: str(pub.policyHash), action: str(action),
    new_value: str(newValue), ext_data_hash: str(extHash), lsk: str(ledger.lsk), sk: str(sk), role_pks: rolePks(config).map(str), roles_salt: str(config.rolesSalt),
  };
  return { witness, public: pub };
}

/**
 * Treasury attestation over the largest unspent ledger notes (≤ ATTEST_NOTES). assets/prices:
 * TreasuryLedger.attestAssets() order and prices. Throws if they do not cover the liabilities.
 */
export function buildAttest({ tree, ledger, notes, assets, prices, liabilities }) {
  const idx = (a) => assets.findIndex((x) => BigInt(x) === a);
  const value = (n) => (n.amount * prices[idx(n.asset)]) / 10n ** 18n;
  const counted = notes.filter((n) => n.status === 'unspent' && idx(n.asset) >= 0 && prices[idx(n.asset)] > 0n)
    .sort((a, b) => (value(b) > value(a) ? 1 : -1)).slice(0, ATTEST_NOTES);
  const total = counted.reduce((t, n) => t + n.amount * prices[idx(n.asset)], 0n);
  if (total < liabilities * 10n ** 18n) throw new Error('Treasury assets do not cover these liabilities, so no statement can be proven.');
  const all = pad(counted, ATTEST_NOTES, () => ({ asset: BigInt(assets[0]), amount: 0n, blinding: randomField() }));
  const paths = inputPaths(tree, all);
  const nullifiers = all.map((n) => nullifier(noteCommitment({ asset: BigInt(n.asset), amount: n.amount, owner: ledger.owner, blinding: n.blinding }), ledger.nk));
  const root = tree.size ? tree.root : 0n;
  const witness = {
    root: str(root), ledger_id: str(ledger.owner), liabilities: str(liabilities), assets: assets.map((a) => str(BigInt(a))), prices: prices.map(str),
    nullifiers: nullifiers.map(str), lsk: str(ledger.lsk), asset_index: all.map((n) => idx(BigInt(n.asset))), amounts: all.map((n) => str(n.amount)),
    blindings: all.map((n) => str(n.blinding)), depths: paths.map((p) => p.depth), indices: paths.map((p) => str(p.index)), siblings: paths.map((p) => p.siblings.map(str)),
  };
  return { witness, public: { root, ledgerId: ledger.owner, liabilities, nullifiers }, counted: counted.length };
}
