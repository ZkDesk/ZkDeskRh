// One payment under a committed mandate, from the treasury ledger to the mandate's recipient, by an
// Owner, Treasurer or Payer. Enforces the cap, the period (k-th period has started by time t, before
// expiry; one-time mandates only k = 0) and one pull per period (pull nullifier). For a stock-token
// mandate the cap is in USDG and the paid raw amount is floor(usdg * 1e20 / mark) at a pinned mark.
// Publishes the mandate commitment, k, the pull nullifier and the receipt leaf; the amount, the
// recipient and the treasury balance stay private. Output 0 is the ledger's change.
use lib::{
    ledger_id as ledger_of, lte, mandate_commit as mandate_of, MAX_DEPTH, nullifier_key, output_note,
    owner_pk, pull_nullifier as pull_of, receipt_leaf as receipt_of, roles_commit as roles_of,
    spend_inputs,
};

global AUDITOR: u32 = 3;
global VALUE_DIV: Field = 100000000000000000000; // 1e20: raw(18) * mark(8) -> USDG(6)

fn main(
    root: pub Field,
    ledger_id: pub Field,
    roles_commit: pub Field,
    mandate_commit: pub Field,
    asset: pub Field,
    mark: pub Field,
    k: pub Field,
    t: pub Field,
    pull_nullifier: pub Field,
    receipt_leaf: pub Field,
    ext_data_hash: pub Field,
    input_nullifiers: pub [Field; 2],
    output_commitments: pub [Field; 2],
    lsk: Field,
    sk: Field,
    role: u32,
    role_pks: [Field; 4],
    roles_salt: Field,
    kind: Field,
    recipient: Field,
    cap: Field,
    period: Field,
    start: Field,
    expiry: Field,
    reference: Field,
    salt: Field,
    usdg_amount: Field,
    raw_amount: Field,
    in_amounts: [Field; 2],
    in_blindings: [Field; 2],
    in_path_depths: [u32; 2],
    in_path_indices: [Field; 2],
    in_path_siblings: [[Field; MAX_DEPTH]; 2],
    change: Field,
    out_blindings: [Field; 2],
) {
    let _ = ext_data_hash;
    assert_eq(ledger_of(lsk), ledger_id);
    assert_eq(roles_of(role_pks, roles_salt), roles_commit);
    assert_eq(owner_pk(sk), role_pks[role]);
    assert(role != AUDITOR);
    assert_eq(
        mandate_of(ledger_id, kind, recipient, asset, cap, period, start, expiry, reference, salt),
        mandate_commit,
    );

    // When: the k-th period has started by t, and t is before expiry.
    k.assert_max_bit_size::<32>();
    t.assert_max_bit_size::<40>();
    period.assert_max_bit_size::<40>();
    start.assert_max_bit_size::<40>();
    expiry.assert_max_bit_size::<40>();
    if period == 0 {
        assert_eq(k, 0);
    }
    assert(lte(start + k * period, t));
    assert(!lte(expiry, t));
    assert_eq(pull_of(mandate_commit, k), pull_nullifier);

    // How much: at most the cap in USDG; stock tokens convert at the pinned mark.
    usdg_amount.assert_max_bit_size::<100>();
    raw_amount.assert_max_bit_size::<100>();
    assert(lte(usdg_amount, cap));
    if mark == 0 {
        assert_eq(raw_amount, usdg_amount);
    } else {
        mark.assert_max_bit_size::<64>();
        assert(lte(raw_amount * mark, usdg_amount * VALUE_DIV));
        assert(!lte(raw_amount * mark + mark, usdg_amount * VALUE_DIV));
    }

    // From the ledger, to the recipient.
    let sum_in = spend_inputs(
        root,
        asset,
        ledger_id,
        nullifier_key(lsk),
        in_amounts,
        in_blindings,
        in_path_depths,
        in_path_indices,
        in_path_siblings,
        input_nullifiers,
    );
    assert_eq(sum_in, change + raw_amount);
    assert_eq(output_note(asset, change, ledger_id, out_blindings[0]), output_commitments[0]);
    let payment = output_note(asset, raw_amount, recipient, out_blindings[1]);
    assert_eq(payment, output_commitments[1]);
    assert_eq(receipt_of(ledger_id, k, payment), receipt_leaf);
}
