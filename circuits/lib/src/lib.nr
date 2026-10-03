// Shared ZKDesk note primitives. Must stay byte-identical with src/lib/zk/notes.js
// and the on-chain PoseidonT3 (circomlib-compatible Poseidon over bn254).
use poseidon::poseidon::bn254::{hash_11, hash_2, hash_3, hash_4, hash_5, hash_6, hash_8, hash_9};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul, multi_scalar_mul};

// Domain separators: ASCII "ZKD.owner" / "ZKD.nk" / "ZKD.pos".
pub global DOM_OWNER: Field = 0x5a4b442e6f776e6572;
pub global DOM_NK: Field = 0x5a4b442e6e6b;
pub global DOM_POSITION: Field = 0x5a4b442e706f73;
// ASCII "ZKD.op" (operator encryption) / "ZKD.liq" (liquidation state for the owner).
pub global DOM_OPERATOR: Field = 0x5a4b442e6f70;
pub global DOM_LIQ: Field = 0x5a4b442e6c6971;
// ASCII "ZKD.evict": the note an evicted (idle, zero-debt) position returns to its owner.
pub global DOM_EVICT: Field = 0x5a4b442e6576696374;
// ASCII "ZKD.ledger" / "ZKD.roles" / "ZKD.policy" / "ZKD.intent" (treasury ledgers).
pub global DOM_LEDGER: Field = 0x5a4b442e6c6564676572;
pub global DOM_ROLES: Field = 0x5a4b442e726f6c6573;
pub global DOM_POLICY: Field = 0x5a4b442e706f6c696379;
pub global DOM_INTENT: Field = 0x5a4b442e696e74656e74;
// ASCII "ZKD.mandate" / "ZKD.pull" / "ZKD.receipt" (payment mandates and receipts).
pub global DOM_MANDATE: Field = 0x5a4b442e6d616e64617465;
pub global DOM_PULL: Field = 0x5a4b442e70756c6c;
pub global DOM_RECEIPT: Field = 0x5a4b442e72656365697074;
// ASCII "ZKD.allow" / "ZKD.budget" (a scoped Payer's recipient list and spending accumulator).
pub global DOM_ALLOW: Field = 0x5a4b442e616c6c6f77;
pub global DOM_BUDGET: Field = 0x5a4b442e627564676574;
pub global ALLOW_SLOTS: u32 = 8;
pub global WAD: Field = 1000000000000000000;
// value6 = coll * mark / 1e20, so debt <= value6 * bps / 1e4  <=>  debt_scaled * index * 1e6 <= coll * mark * bps
pub global HEALTH_SCALE: Field = 1000000;
// LeanIMT depth: up to ~4.3B notes. Matches the contract tree cap (audit M-2: a 2^20 tree could be
// filled with dummy outputs and then freeze every exit).
pub global MAX_DEPTH: u32 = 32;

// Spend authority is knowledge of `sk`; owner and nullifier key both derive from it.
pub fn owner_pk(sk: Field) -> Field {
    hash_2([DOM_OWNER, sk])
}

pub fn nullifier_key(sk: Field) -> Field {
    hash_2([DOM_NK, sk])
}

pub fn note_commitment(asset: Field, amount: Field, owner: Field, blinding: Field) -> Field {
    hash_4([asset, amount, owner, blinding])
}

// A treasury ledger owns notes under its own domain, so the personal `transact` circuit (which
// proves owner = H(DOM_OWNER, sk)) can never spend them; only the role-gated `ledger` circuit can.
// Its nullifier key is nullifier_key(lsk). Every role holder knows lsk (it is the view key).
pub fn ledger_id(lsk: Field) -> Field {
    hash_2([DOM_LEDGER, lsk])
}

/// Role members are personal owner keys: [OWNER, TREASURER, PAYER, AUDITOR].
pub fn roles_commit(pks: [Field; 4], salt: Field) -> Field {
    hash_6([DOM_ROLES, pks[0], pks[1], pks[2], pks[3], salt])
}

/// The ledger policy. allow_hash (0 = any recipient), budget (0 = none), budget_period (seconds; 0 = one
/// window for the policy's lifetime) and budget_start scope the PAYER; they never limit the Owner or Treasurer.
pub fn policy_hash(
    alloc_cap: Field,
    dual_threshold: Field,
    allow_hash: Field,
    budget: Field,
    budget_period: Field,
    budget_start: Field,
    salt: Field,
) -> Field {
    hash_8([DOM_POLICY, alloc_cap, dual_threshold, allow_hash, budget, budget_period, budget_start, salt])
}

/// The Payer's allowed recipients: personal owner keys or public addresses, unused slots 0. An empty
/// list hashes to 0 (no restriction).
pub fn allow_hash(list: [Field; ALLOW_SLOTS]) -> Field {
    let mut empty = true;
    for i in 0..ALLOW_SLOTS {
        empty = empty & (list[i] == 0);
    }
    if empty {
        0
    } else {
        hash_9([DOM_ALLOW, list[0], list[1], list[2], list[3], list[4], list[5], list[6], list[7]])
    }
}

/// x is a non-zero entry of the list.
pub fn listed(list: [Field; ALLOW_SLOTS], x: Field) -> bool {
    let mut product = 1;
    for i in 0..ALLOW_SLOTS {
        product *= list[i] - x;
    }
    (x != 0) & (product == 0)
}

/// The ledger's spending accumulator: what the Payer spent in budget window `window`.
pub fn budget_commit(ledger_id: Field, window: Field, spent: Field, blinding: Field) -> Field {
    hash_5([DOM_BUDGET, ledger_id, window, spent, blinding])
}

/// Members open the accumulator with a key from the ledger secret: blinding = pad(2), and the
/// window and spent amount are published masked with pad(0) and pad(1). nonce: the transfer's first
/// input nullifier, unique per step.
pub fn budget_pad(lsk: Field, nonce: Field, i: Field) -> Field {
    hash_3([hash_2([DOM_BUDGET, lsk]), nonce, i])
}

/// A payment mandate: a ledger may pay `recipient` (a personal owner key) up to `cap` per period.
/// kind: 0 payroll, 1 invoice (one-time, `reference` = invoice hash), 2 vendor. period 0 = one-time.
/// For a stock-token asset the cap is in USDG and each pull converts at the pinned mark.
pub fn mandate_commit(
    ledger_id: Field,
    kind: Field,
    recipient: Field,
    asset: Field,
    cap: Field,
    period: Field,
    start: Field,
    expiry: Field,
    reference: Field,
    salt: Field,
) -> Field {
    hash_11([DOM_MANDATE, ledger_id, kind, recipient, asset, cap, period, start, expiry, reference, salt])
}

/// One pull per mandate period; also the leaf a recipient later proves a payment with.
pub fn pull_nullifier(mandate: Field, k: Field) -> Field {
    hash_3([DOM_PULL, mandate, k])
}

pub fn receipt_leaf(ledger_id: Field, k: Field, payment: Field) -> Field {
    hash_4([DOM_RECEIPT, ledger_id, k, payment])
}

// Credit position: collateral in token base units, debt in index-normalised units.
pub fn position_commitment(
    asset: Field,
    collateral: Field,
    debt_scaled: Field,
    owner: Field,
    blinding: Field,
) -> Field {
    hash_6([DOM_POSITION, asset, collateral, debt_scaled, owner, blinding])
}

// Commitments are unique (random blinding), so the leaf index is not needed here.
pub fn nullifier(commitment: Field, nk: Field) -> Field {
    hash_2([commitment, nk])
}

// LeanIMT root (zk-kit semantics): levels without a sibling are skipped by the
// proof generator, so only the first `depth` siblings/bits are applied.
pub fn merkle_root(leaf: Field, depth: u32, index: Field, siblings: [Field; MAX_DEPTH]) -> Field {
    assert(depth <= MAX_DEPTH);
    let bits: [bool; MAX_DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..MAX_DEPTH {
        if i < depth {
            node = if bits[i] {
                hash_2([siblings[i], node])
            } else {
                hash_2([node, siblings[i]])
            };
        }
    }
    node
}

/// Same root as merkle_root with one hash per level (swap, then hash). Every circuit uses this one;
/// merkle_root stays as the readable reference the tests compare it with.
pub fn merkle_root_swap(leaf: Field, depth: u32, index: Field, siblings: [Field; MAX_DEPTH]) -> Field {
    assert(depth <= MAX_DEPTH);
    let bits: [bool; MAX_DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..MAX_DEPTH {
        let (l, r) = if bits[i] { (siblings[i], node) } else { (node, siblings[i]) };
        let up = hash_2([l, r]);
        node = if i < depth { up } else { node };
    }
    node
}

// Spends up to two notes of `asset` owned by (owner, nk); zero-amount inputs are dummies.
// Returns the total input amount.
pub fn spend_inputs(
    root: Field,
    asset: Field,
    owner: Field,
    nk: Field,
    amounts: [Field; 2],
    blindings: [Field; 2],
    depths: [u32; 2],
    indices: [Field; 2],
    siblings: [[Field; MAX_DEPTH]; 2],
    nullifiers: [Field; 2],
) -> Field {
    let mut sum = 0;
    for i in 0..2 {
        amounts[i].assert_max_bit_size::<100>();
        let commitment = note_commitment(asset, amounts[i], owner, blindings[i]);
        assert_eq(nullifier(commitment, nk), nullifiers[i]);
        if amounts[i] != 0 {
            assert_eq(merkle_root_swap(commitment, depths[i], indices[i], siblings[i]), root);
        }
        sum += amounts[i];
    }
    assert(nullifiers[0] != nullifiers[1]);
    sum
}

// Range-checked output note commitment.
pub fn output_note(asset: Field, amount: Field, owner: Field, blinding: Field) -> Field {
    amount.assert_max_bit_size::<100>();
    note_commitment(asset, amount, owner, blinding)
}

/// Verifiable encryption of `values` to the desk operator's Grumpkin key: ephemeral ECDH, then a
/// Poseidon keystream (c_i = v_i + H(key, i)). Returns (ephemeral point, ciphertext).
/// Mirrored by src/lib/zk/grumpkin.js.
pub fn operator_encrypt<let N: u32>(values: [Field; N], pk: [Field; 2], r: Field) -> ([Field; 2], [Field; N]) {
    // r = 0 would put eph and the shared point at infinity (audit M-5); never needed.
    assert(r != 0);
    let s = EmbeddedCurveScalar::from_field(r);
    let eph = fixed_base_scalar_mul(s);
    let shared = multi_scalar_mul([EmbeddedCurvePoint { x: pk[0], y: pk[1] }], [s]);
    let key = hash_3([DOM_OPERATOR, shared.x, shared.y]);
    let mut c = [0; N];
    for i in 0..N {
        c[i] = values[i] + hash_2([key, i as Field]);
    }
    ([eph.x, eph.y], c)
}

// Scaled debt vs collateral value at `bps` of the mark, in comparable units (see HEALTH_SCALE).
pub fn debt_term(debt_scaled: Field, rate_index: Field) -> Field {
    debt_scaled * rate_index * HEALTH_SCALE
}

pub fn value_term(collateral: Field, mark: Field, bps: Field) -> Field {
    collateral * mark * bps
}

// After a liquidation the owner (and only the operator, who already knows the opening) can derive
// the new position: blinding' = H(DOM_LIQ, b); the sold/repaid amounts are masked with H(DOM_LIQ, b, i).
pub fn liquidated_blinding(blinding: Field) -> Field {
    hash_2([DOM_LIQ, blinding])
}

pub fn liquidation_pad(blinding: Field, i: Field) -> Field {
    hash_3([DOM_LIQ, blinding, i])
}

// An evicted position's collateral returns as a note the owner can find without a ciphertext.
pub fn evicted_blinding(blinding: Field) -> Field {
    hash_2([DOM_EVICT, blinding])
}

// a <= b as integers (both must be < p, which bounded products guarantee).
pub fn lte(a: Field, b: Field) -> bool {
    !b.lt(a)
}

#[test]
fn poseidon_matches_circomlib() {
    // circomlib poseidon([1, 2]); the same vector is asserted in JS and Solidity tests.
    assert_eq(hash_2([1, 2]), 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a);
}

#[test]
fn merkle_root_two_leaves() {
    let mut siblings = [0; MAX_DEPTH];
    siblings[0] = 22;
    assert_eq(merkle_root(11, 1, 0, siblings), hash_2([11, 22]));
    assert_eq(merkle_root(22, 1, 1, [11; MAX_DEPTH]), hash_2([11, 22]));
    assert_eq(merkle_root(33, 0, 0, siblings), 33);
    assert_eq(merkle_root_swap(11, 1, 0, siblings), hash_2([11, 22]));
    assert_eq(merkle_root_swap(22, 1, 1, [11; MAX_DEPTH]), hash_2([11, 22]));
    assert_eq(merkle_root_swap(33, 0, 0, siblings), 33);
}

#[test]
fn allow_list() {
    let mut list = [0; ALLOW_SLOTS];
    assert_eq(allow_hash(list), 0);
    assert(!listed(list, 0));
    assert(!listed(list, 5));
    list[3] = 5;
    assert(allow_hash(list) != 0);
    assert(listed(list, 5));
    assert(!listed(list, 6));
    assert(!listed(list, 0));
}

#[test]
fn lte_is_integer_order() {
    assert(lte(3, 3));
    assert(lte(3, 4));
    assert(!lte(5, 4));
    assert(lte(0, 0x100000000000000000000000000000000000000000000000000));
}
