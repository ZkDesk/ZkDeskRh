// Payment mandates and receipts: witness builders for circuits/mandate_auth, circuits/mandate_pull
// and circuits/receipt. Pure: nothing leaves the caller.
import { encodeAbiParameters, keccak256 } from 'viem';
import { FIELD, mandateCommit, MAX_DEPTH, noteCommitment, nullifier, ownerPk, policyHash, pullNullifier, randomField, receiptLeaf } from './notes.js';
import { inputPaths, pad, padInputs } from './transact.js';
import { ROLES, rolePks, rolesOf } from './ledger.js';

export const KINDS = ['Payroll', 'Invoice', 'Vendor'];
export const PERIODS = { Monthly: 30n * 86_400n, Weekly: 7n * 86_400n, 'One-time': 0n };
export const MANDATE_ACTIONS = { commit: 0, revoke: 1, pause: 2, resume: 3 };
const VALUE_DIV = 10n ** 20n;
const str = (x) => x.toString();

/** Index of the period that contains `now` (seconds); one-time mandates only have period 0. */
export const currentPeriod = (m, now) => (m.period ? (BigInt(now) - m.start) / m.period : 0n);
/** Stock payroll: raw token units paid for `usdg` at an 8-decimal mark (floor). */
export const rawForUsdg = (usdg, mark) => (mark ? (usdg * VALUE_DIV) / mark : usdg);

export const mandateExtHash = (ciphertext) => BigInt(keccak256(encodeAbiParameters([{ type: 'bytes' }], [ciphertext]))) % FIELD;
// Must match MandateRegistry.PullExt field order.
const PULL_EXT = [{ type: 'tuple', components: [{ name: 'encryptedOutput1', type: 'bytes' }, { name: 'encryptedOutput2', type: 'bytes' }] }];
export const pullExtHash = (ext) => BigInt(keccak256(encodeAbiParameters(PULL_EXT, [{ encryptedOutput1: '0x', encryptedOutput2: '0x', ...ext }]))) % FIELD;

const roleOf = (ledger, sk, role) => {
  const r = ROLES.indexOf(role);
  if (r < 0 || r === 3) throw new Error('The Auditor role can view mandates but cannot manage or pay them.');
  if (rolePks(ledger.config)[r] !== ownerPk(sk)) throw new Error(`You do not hold the ${role} role in this treasury.`);
  return r;
};
const mandateWitness = (m) => ({
  kind: str(m.kind), recipient: str(m.recipient), cap: str(m.cap), period: str(m.period),
  start: str(m.start), expiry: str(m.expiry), reference: str(m.reference), salt: str(m.salt),
});

/** mandate: {kind, recipient, asset, cap, period, start, expiry, reference, salt}; action from MANDATE_ACTIONS. */
export function buildMandateAuth({ ledger, sk, role, action, mandate, ciphertext = '0x', check = true }) {
  const c = ledger.config;
  const r = check ? roleOf(ledger, sk, role) : ROLES.indexOf(role);
  if (check && action === MANDATE_ACTIONS.commit && mandate.cap > c.dualThreshold && r !== 0) {
    throw new Error(`A cap above the ${Number(c.dualThreshold) / 1e6} tUSDG dual-control threshold needs the Owner.`);
  }
  const commit = mandateCommit(ledger.owner, mandate);
  const extHash = mandateExtHash(ciphertext);
  const witness = {
    ledger_id: str(ledger.owner), roles_commit: str(rolesOf(c)), policy_hash: str(policyHash(c)), action: str(action),
    mandate_commit: str(commit), ext_data_hash: str(extHash), lsk: str(ledger.lsk), sk: str(sk), role: r,
    role_pks: rolePks(c).map(str), roles_salt: str(c.rolesSalt), alloc_cap: str(c.allocCap), dual_threshold: str(c.dualThreshold),
    policy_salt: str(c.policySalt), asset: str(mandate.asset), ...mandateWitness(mandate),
  };
  return { witness, public: { ledgerId: ledger.owner, action, mandateCommit: commit }, commit };
}

/**
 * One pull. inputs: ledger notes in mandate.asset. mark: 8-decimal pinned mark for a stock mandate
 * (0 for USDG). t: proof time in seconds (the contract accepts it for an hour).
 */
export function buildPull({ tree, ledger, sk, role, mandate, k, t, usdgAmount, mark = 0n, inputs, ext, blindings = {}, check = true }) {
  const r = check ? roleOf(ledger, sk, role) : ROLES.indexOf(role);
  if (check && usdgAmount > mandate.cap) throw new Error('This payment exceeds the mandate cap.');
  const raw = rawForUsdg(usdgAmount, mark);
  const id = ledger.owner;
  const ins = padInputs(inputs);
  const change = ins.reduce((s, n) => s + n.amount, 0n) - raw;
  if (change < 0n) throw new Error('Not enough treasury balance for this payment.');
  const ob = blindings.outputs ?? [randomField(), randomField()];
  const outputs = [
    { asset: mandate.asset, amount: change, owner: id, blinding: ob[0] },
    { asset: mandate.asset, amount: raw, owner: mandate.recipient, blinding: ob[1] },
  ].map((o) => ({ ...o, commitment: noteCommitment(o) }));
  const commit = mandateCommit(id, mandate);
  const inputNullifiers = ins.map((n) => nullifier(noteCommitment({ asset: mandate.asset, amount: n.amount, owner: id, blinding: n.blinding }), ledger.nk));
  const paths = inputPaths(tree, ins);
  const root = tree.size ? tree.root : 0n;
  const pub = {
    root, ledgerId: id, rolesCommit: rolesOf(ledger.config), mandateCommit: commit, asset: mandate.asset, mark, k, t,
    pullNullifier: pullNullifier(commit, k), receiptLeaf: receiptLeaf(id, k, outputs[1].commitment), extDataHash: pullExtHash(ext),
    inputNullifiers, outputCommitments: outputs.map((o) => o.commitment),
  };
  const witness = {
    root: str(root), ledger_id: str(id), roles_commit: str(pub.rolesCommit), mandate_commit: str(commit), asset: str(mandate.asset),
    mark: str(mark), k: str(k), t: str(t), pull_nullifier: str(pub.pullNullifier), receipt_leaf: str(pub.receiptLeaf),
    ext_data_hash: str(pub.extDataHash), input_nullifiers: inputNullifiers.map(str), output_commitments: pub.outputCommitments.map(str),
    lsk: str(ledger.lsk), sk: str(sk), role: r, role_pks: rolePks(ledger.config).map(str), roles_salt: str(ledger.config.rolesSalt),
    ...mandateWitness(mandate), usdg_amount: str(usdgAmount), raw_amount: str(raw),
    in_amounts: ins.map((n) => str(n.amount)), in_blindings: ins.map((n) => str(n.blinding)),
    in_path_depths: paths.map((p) => p.depth), in_path_indices: paths.map((p) => str(p.index)), in_path_siblings: paths.map((p) => p.siblings.map(str)),
    change: str(change), out_blindings: ob.map(str),
  };
  return { witness, public: pub, outputs, raw };
}

/**
 * Recipient's receipt for a payment note. receipts: LeanIMT of receipt leaves; leafIndex: this
 * payment's receipt leaf. verifier: a field naming who the proof is for (e.g. an address).
 */
export function buildReceipt({ receipts, sk, payment, ledgerId, k, leafIndex, verifier, discloseAmount = false, discloseOwner = false }) {
  const p = receipts.generateProof(leafIndex);
  if (p.siblings.length > MAX_DEPTH) throw new Error('Receipt tree deeper than the circuit.');
  const owner = ownerPk(sk);
  const pub = {
    receiptRoot: receipts.root, ledgerId, k, asset: payment.asset, verifier,
    discloseAmount, amountOut: discloseAmount ? payment.amount : 0n, discloseOwner, ownerOut: discloseOwner ? owner : 0n,
  };
  const witness = {
    receipt_root: str(pub.receiptRoot), ledger_id: str(ledgerId), k: str(k), asset: str(payment.asset), verifier: str(verifier),
    disclose_amount: discloseAmount, amount_out: str(pub.amountOut), disclose_owner: discloseOwner, owner_out: str(pub.ownerOut),
    sk: str(sk), amount: str(payment.amount), blinding: str(payment.blinding), depth: p.siblings.length, index: str(p.index),
    siblings: pad(p.siblings, MAX_DEPTH, () => 0n).map(str),
  };
  return { witness, public: pub };
}
