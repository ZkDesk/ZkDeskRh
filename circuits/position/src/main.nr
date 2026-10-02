// One private credit transition: open, draw, repay, add collateral, withdraw collateral, close.
// A position is a hidden commitment (asset, collateral, debt_scaled, owner, blinding) stored in a
// CreditDesk slot. Only aggregate flows (coll_in/out, draw, repay and their scaled debt deltas)
// are public; owner, collateral size, debt and LTV are not.
//
// Units: collateral in 18-decimal token base units, USDG in 6 decimals, `mark` is the 8-decimal
// oracle price per base token (Chainlink stock feeds already include the uiMultiplier, so it is
// never applied again), rate_index is 1e18-based. debt = ceil(debt_scaled * rate_index / 1e18).
//
// Notes in `in_asset` pay in collateral (coll_in) or USDG (repay); output 0 is their change.
// Output 1 carries whatever leaves the desk: drawn USDG or withdrawn collateral.
// The new position (collateral, debt_scaled, owner, blinding) is also provably encrypted to the desk
// operator key, so the epoch health proof and liquidations can always open every live position.
use lib::{
    debt_term, lte, MAX_DEPTH, nullifier_key, operator_encrypt, output_note, owner_pk,
    position_commitment, spend_inputs, value_term, WAD,
};

fn main(
    root: pub Field,
    ext_data_hash: pub Field,
    coll_asset: pub Field,
    usdg_asset: pub Field,
    in_asset: pub Field,
    mark: pub Field,
    ltv_bps: pub Field,
    rate_index: pub Field,
    old_leaf: pub Field,
    new_leaf: pub Field,
    coll_in: pub Field,
    coll_out: pub Field,
    draw: pub Field,
    repay: pub Field,
    draw_scaled: pub Field,
    repay_scaled: pub Field,
    input_nullifiers: pub [Field; 2],
    output_commitments: pub [Field; 2],
    operator_pk: pub [Field; 2],
    operator_eph: pub [Field; 2],
    operator_cipher: pub [Field; 4],
    min_coll: pub Field,
    liq_bps: pub Field,
    min_debt: pub Field,
    sk: Field,
    old_coll: Field,
    old_debt_scaled: Field,
    old_blinding: Field,
    new_blinding: Field,
    in_amounts: [Field; 2],
    in_blindings: [Field; 2],
    in_path_depths: [u32; 2],
    in_path_indices: [Field; 2],
    in_path_siblings: [[Field; MAX_DEPTH]; 2],
    out_blindings: [Field; 2],
    change: Field,
    operator_r: Field,
) {
    let _ = ext_data_hash;
    // Audit N-1: a step must move something. An empty step would only re-randomise the leaf.
    assert((coll_in != 0) | (coll_out != 0) | (draw != 0) | (repay != 0));
    // Public parameters are bounded so every product below stays far under the field size.
    mark.assert_max_bit_size::<64>();
    ltv_bps.assert_max_bit_size::<16>();
    rate_index.assert_max_bit_size::<96>();
    assert(rate_index != 0);
    for x in [coll_in, coll_out, draw, repay] {
        x.assert_max_bit_size::<100>();
    }
    draw_scaled.assert_max_bit_size::<128>();
    repay_scaled.assert_max_bit_size::<128>();

    let owner = owner_pk(sk);

    // Notes paid in: collateral for coll_in, USDG for repay (never both in one step).
    if coll_in != 0 {
        assert_eq(in_asset, coll_asset);
    }
    if repay != 0 {
        assert_eq(in_asset, usdg_asset);
    }
    let sum_in = spend_inputs(
        root,
        in_asset,
        owner,
        nullifier_key(sk),
        in_amounts,
        in_blindings,
        in_path_depths,
        in_path_indices,
        in_path_siblings,
        input_nullifiers,
    );
    assert_eq(sum_in, change + coll_in + repay);
    assert_eq(output_note(in_asset, change, owner, out_blindings[0]), output_commitments[0]);

    // Value leaving the desk: drawn USDG or withdrawn collateral (never both in one step).
    assert_eq(draw * coll_out, 0);
    let out_asset = if draw != 0 { usdg_asset } else { coll_asset };
    assert_eq(output_note(out_asset, draw + coll_out, owner, out_blindings[1]), output_commitments[1]);

    // Previous position (none when opening).
    if old_leaf != 0 {
        assert_eq(position_commitment(coll_asset, old_coll, old_debt_scaled, owner, old_blinding), old_leaf);
    } else {
        assert_eq(old_coll, 0);
        assert_eq(old_debt_scaled, 0);
    }

    // Exact rounding against the pinned public index: borrowers round up, repayments round down.
    // draw * 1e18 <= draw_scaled * index < draw * 1e18 + index
    assert(lte(draw * WAD, draw_scaled * rate_index));
    assert(draw_scaled * rate_index - draw * WAD != rate_index);
    assert(lte(draw_scaled * rate_index, draw * WAD + rate_index));
    // repay_scaled * index <= repay * 1e18 < (repay_scaled + 1) * index
    assert(lte(repay_scaled * rate_index, repay * WAD));
    assert(repay * WAD - repay_scaled * rate_index != rate_index);
    assert(lte(repay * WAD, repay_scaled * rate_index + rate_index));

    // New state. Range checks reject withdrawing more collateral or repaying more than owed.
    let new_coll = old_coll + coll_in - coll_out;
    let new_debt_scaled = old_debt_scaled + draw_scaled - repay_scaled;
    new_coll.assert_max_bit_size::<100>();
    new_debt_scaled.assert_max_bit_size::<128>();

    if (new_coll == 0) & (new_debt_scaled == 0) {
        assert_eq(new_leaf, 0); // fully closed: the slot is freed
    } else {
        // Audit N-1: every step that leaves a position leaves it healthy at the liquidation threshold,
        // so a breached position can only be cured, closed or liquidated, never just touched.
        liq_bps.assert_max_bit_size::<16>();
        assert(lte(debt_term(new_debt_scaled, rate_index), value_term(new_coll, mark, liq_bps)));
        // Audit H-1: debt is zero or at least the class minimum (no dust debt holding a slot).
        if new_debt_scaled != 0 {
            min_debt.assert_max_bit_size::<100>();
            assert(lte(min_debt * WAD, new_debt_scaled * rate_index));
        }
        // Audit H-1: opening, or withdrawing from, a position leaves at least the class minimum, so a
        // slot costs real capital. Repay and add stay open to a position a liquidation left below it.
        if (old_leaf == 0) | (coll_out != 0) {
            min_coll.assert_max_bit_size::<100>();
            assert(lte(min_coll, new_coll));
        }
        assert_eq(position_commitment(coll_asset, new_coll, new_debt_scaled, owner, new_blinding), new_leaf);
    }

    let (eph, cipher) = operator_encrypt([new_coll, new_debt_scaled, owner, new_blinding], operator_pk, operator_r);
    assert_eq(eph, operator_eph);
    assert_eq(cipher, operator_cipher);

    // Risk-increasing steps must stay within the LTV limit at the pinned mark.
    if (draw != 0) | (coll_out != 0) {
        assert(lte(debt_term(new_debt_scaled, rate_index), value_term(new_coll, mark, ltv_bps)));
    }
}

mod tests;
