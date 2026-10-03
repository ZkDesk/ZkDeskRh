// Mirrors circuits/lib/src/lib.nr exactly. Any change here needs the same change there.
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon6, poseidon7, poseidon9, poseidon11 } from 'poseidon-lite';

// bn254 scalar field (circuit Field / snark scalar field).
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DOM_OWNER = 0x5a4b442e6f776e6572n; // "ZKD.owner"
export const DOM_NK = 0x5a4b442e6e6bn; // "ZKD.nk"
export const DOM_POSITION = 0x5a4b442e706f73n; // "ZKD.pos"
export const MAX_DEPTH = 32;
export const MAX_AMOUNT = (1n << 100n) - 1n;

export const hash2 = (a, b) => poseidon2([a, b]);
export const ownerPk = (sk) => poseidon2([DOM_OWNER, sk]);
export const nullifierKey = (sk) => poseidon2([DOM_NK, sk]);
export const noteCommitment = ({ asset, amount, owner, blinding }) => poseidon4([asset, amount, owner, blinding]);
export const nullifier = (commitment, nk) => poseidon2([commitment, nk]);
export const positionCommitment = ({ asset, collateral, debtScaled, owner, blinding }) => poseidon6([DOM_POSITION, asset, collateral, debtScaled, owner, blinding]);

// Uniform field element from 32 random bytes (bias < 2^-250, fine for blindings).
export const randomField = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')) % FIELD;
};

// External amount (signed bigint) -> field element used as the circuit's public_amount.
export const publicAmount = (ext) => ((ext % FIELD) + FIELD) % FIELD;

export const toHex = (x) => '0x' + BigInt(x).toString(16).padStart(64, '0');

// Liquidation state the owner derives (circuits/lib liquidated_blinding / liquidation_pad).
export const DOM_LIQ = 0x5a4b442e6c6971n; // "ZKD.liq"
export const liquidatedBlinding = (blinding) => poseidon2([DOM_LIQ, blinding]);
export const liquidationPad = (blinding, i) => poseidon3([DOM_LIQ, blinding, BigInt(i)]);
// An evicted position's collateral note (circuits/lib evicted_blinding; circuits/evict).
export const DOM_EVICT = 0x5a4b442e6576696374n; // "ZKD.evict"
export const evictedBlinding = (blinding) => poseidon2([DOM_EVICT, blinding]);

// Treasury ledgers (circuits/lib ledger_id / roles_commit / policy_hash; circuits/ledger intent).
export const DOM_LEDGER = 0x5a4b442e6c6564676572n; // "ZKD.ledger"
export const DOM_ROLES = 0x5a4b442e726f6c6573n; // "ZKD.roles"
export const DOM_POLICY = 0x5a4b442e706f6c696379n; // "ZKD.policy"
export const DOM_INTENT = 0x5a4b442e696e74656e74n; // "ZKD.intent"
export const ledgerId = (lsk) => poseidon2([DOM_LEDGER, lsk]);
export const rolesCommit = (pks, salt) => poseidon6([DOM_ROLES, ...pks, salt]);
export const DOM_ALLOW = 0x5a4b442e616c6c6f77n; // "ZKD.allow"
export const DOM_BUDGET = 0x5a4b442e627564676574n; // "ZKD.budget"
export const ALLOW_SLOTS = 8;
/** The Payer's allowed recipients (owner keys or addresses, unused slots 0); an empty list is 0. */
export const allowHash = (list) => (list.every((x) => x === 0n) ? 0n : poseidon9([DOM_ALLOW, ...list]));
/** Payer scope fields default to "none", so older call sites keep working. */
export const policyHash = ({ allocCap, dualThreshold, allow = Array(ALLOW_SLOTS).fill(0n), budget = 0n, budgetPeriod = 0n, budgetStart = 0n, payerUntil = 0n, policySalt }) =>
  poseidon9([DOM_POLICY, allocCap, dualThreshold, allowHash(allow), budget, budgetPeriod, budgetStart, payerUntil, policySalt]);
export const budgetCommit = (ledger, window, spent, blinding) => poseidon5([DOM_BUDGET, ledger, window, spent, blinding]);
export const budgetPad = (lsk, nonce, i) => poseidon3([poseidon2([DOM_BUDGET, lsk]), nonce, BigInt(i)]);
export const cosignIntent = (id, nullifiers, commitments, extHash) => poseidon7([DOM_INTENT, id, ...nullifiers, ...commitments, extHash]);

// Payment mandates and receipts (circuits/lib mandate_commit / pull_nullifier / receipt_leaf).
export const DOM_MANDATE = 0x5a4b442e6d616e64617465n; // "ZKD.mandate"
export const DOM_PULL = 0x5a4b442e70756c6cn; // "ZKD.pull"
export const DOM_RECEIPT = 0x5a4b442e72656365697074n; // "ZKD.receipt"
export const mandateCommit = (ledger, m) => poseidon11([DOM_MANDATE, ledger, m.kind, m.recipient, m.asset, m.cap, m.period, m.start, m.expiry, m.reference, m.salt]);
export const pullNullifier = (mandate, k) => poseidon3([DOM_PULL, mandate, k]);
export const receiptLeaf = (ledger, k, payment) => poseidon4([DOM_RECEIPT, ledger, k, payment]);
