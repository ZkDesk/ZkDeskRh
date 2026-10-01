// Shared ZKDesk note primitives. Must stay byte-identical with src/lib/zk/notes.js
// and the on-chain PoseidonT3 (circomlib-compatible Poseidon over bn254).
use poseidon::poseidon::bn254::{hash_11, hash_2, hash_3, hash_4, hash_6};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul, multi_scalar_mul};

// Domain separators: ASCII "ZKD.owner" / "ZKD.nk" / "ZKD.pos".
pub global DOM_OWNER: Field = 0x5a4b442e6f776e6572;
pub global DOM_NK: Field = 0x5a4b442e6e6b;
pub global DOM_POSITION: Field = 0x5a4b442e706f73;
// ASCII "ZKD.op" (operator encryption) / "ZKD.liq" (liquidation state for the owner).
pub global DOM_OPERATOR: Field = 0x5a4b442e6f70;
pub global DOM_LIQ: Field = 0x5a4b442e6c6971;
// ASCII "ZKD.ledger" / "ZKD.roles" / "ZKD.policy" / "ZKD.intent" (treasury ledgers).
pub global DOM_LEDGER: Field = 0x5a4b442e6c6564676572;
pub global DOM_ROLES: Field = 0x5a4b442e726f6c6573;
pub global DOM_POLICY: Field = 0x5a4b442e706f6c696379;
pub global DOM_INTENT: Field = 0x5a4b442e696e74656e74;
// ASCII "ZKD.mandate" / "ZKD.pull" / "ZKD.receipt" (payment mandates and receipts).
pub global DOM_MANDATE: Field = 0x5a4b442e6d616e64617465;
pub global DOM_PULL: Field = 0x5a4b442e70756c6c;
pub global DOM_RECEIPT: Field = 0x5a4b442e72656365697074;
pub global WAD: Field = 1000000000000000000;
// value6 = coll * mark / 1e20, so debt <= value6 * bps / 1e4  <=>  debt_scaled * index * 1e6 <= coll * mark * bps
pub global HEALTH_SCALE: Field = 1000000;
// LeanIMT depth: up to ~1M notes. Matches the contract tree cap.
pub global MAX_DEPTH: u32 = 20;

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

pub fn policy_hash(alloc_cap: Field, dual_threshold: Field, salt: Field) -> Field {
    hash_4([DOM_POLICY, alloc_cap, dual_threshold, salt])
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

/// Same root as merkle_root with one hash per level (swap, then hash). Deployed verifiers pin the
/// constraint system of merkle_root, so it stays as is; new circuits use this one.
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
            assert_eq(merkle_root(commitment, depths[i], indices[i], siblings[i]), root);
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
fn lte_is_integer_order() {
    assert(lte(3, 3));
    assert(lte(3, 4));
    assert(!lte(5, 4));
    assert(lte(0, 0x100000000000000000000000000000000000000000000000000));
}
