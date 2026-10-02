// Sealed liquidation batch: up to B breached positions of one collateral class sold at one uniform
// price. For each used entry the proof shows the position is in the attested epoch's breached set and
// is still breached at the pinned mark, and applies the close factor (20% of debt, 100% below 95%
// health), the bonus (2%, or 8% below 95% health) and the off-hours floor (only below 95% health
// while the market is closed). Unsold collateral stays in the position for the owner; if all
// collateral is sold, any remaining debt is written off and the slot is freed.
//
// Public per entry: slot, old/new leaf and the owner's masked (sold, repaid_scaled). Public totals:
// collateral sold, minimum sale proceeds, USDG repaid to lenders and scaled debt removed.
use lib::{debt_term, liquidated_blinding, liquidation_pad, lte, position_commitment, value_term, WAD};
use poseidon::poseidon::bn254::hash_2;

global B: u32 = 4;
global VALUE_DIV: Field = 100000000000000000000; // 1e20
global BPS: Field = 10000;
global HARD_FLOOR_BPS: Field = 9500;
global BONUS_BPS: Field = 200;
global DEEP_BONUS_BPS: Field = 800;

fn main(
    breach_commit: pub Field,
    coll_asset: pub Field,
    mark: pub Field,
    price: pub Field,
    liq_bps: pub Field,
    rate_index: pub Field,
    market_open: pub bool,
    slots: pub [Field; B],
    old_leaves: pub [Field; B],
    new_leaves: pub [Field; B],
    enc_sold: pub [Field; B],
    enc_repaid: pub [Field; B],
    total_sold: pub Field,
    total_value: pub Field,
    total_repay: pub Field,
    total_repaid_scaled: pub Field,
    total_written_off: pub Field,
    min_debt: pub Field,
    bitmap: Field,
    salt: Field,
    collateral: [Field; B],
    debt_scaled: [Field; B],
    owner: [Field; B],
    blinding: [Field; B],
    sold: [Field; B],
    values: [Field; B],
    repays: [Field; B],
    repaid_scaled: [Field; B],
) {
    mark.assert_max_bit_size::<64>();
    price.assert_max_bit_size::<64>();
    liq_bps.assert_max_bit_size::<16>();
    rate_index.assert_max_bit_size::<96>();
    min_debt.assert_max_bit_size::<100>();
    assert(rate_index != 0);
    assert_eq(hash_2([bitmap, salt]), breach_commit);
    let breached: [bool; 64] = bitmap.to_le_bits();

    let mut sums = [0; 5];
    for i in 0..B {
        if old_leaves[i] == 0 {
            // Unused entry.
            assert_eq(slots[i], 0);
            assert_eq(new_leaves[i], 0);
            assert_eq(sold[i], 0);
            assert_eq(values[i], 0);
            assert_eq(repays[i], 0);
            assert_eq(repaid_scaled[i], 0);
        } else {
            slots[i].assert_max_bit_size::<6>();
            assert(breached[slots[i] as u32]);
            let (coll, debt, b) = (collateral[i], debt_scaled[i], blinding[i]);
            assert_eq(position_commitment(coll_asset, coll, debt, owner[i], b), old_leaves[i]);

            // Still breached at the pinned mark; "deep" is below 95% health.
            let d = debt_term(debt, rate_index);
            let v = value_term(coll, mark, liq_bps);
            assert(!lte(d, v));
            let deep = !lte(d * HARD_FLOOR_BPS, v * BPS);
            if !market_open {
                assert(deep);
            }

            // Sale at the uniform price: values = floor(sold * price / 1e20).
            sold[i].assert_max_bit_size::<100>();
            assert(lte(sold[i], coll));
            values[i].assert_max_bit_size::<128>();
            assert(lte(values[i] * VALUE_DIV, sold[i] * price));
            assert(!lte(values[i] * VALUE_DIV + VALUE_DIV, sold[i] * price));
            // Lenders get floor(value / (1 + bonus)); the bonus stays with the batch.
            let bonus = if deep { DEEP_BONUS_BPS } else { BONUS_BPS };
            repays[i].assert_max_bit_size::<128>();
            assert(lte(repays[i] * (BPS + bonus), values[i] * BPS));
            assert(!lte(repays[i] * (BPS + bonus) + BPS + bonus, values[i] * BPS));
            // Scaled debt removed rounds down, as for a normal repayment.
            repaid_scaled[i].assert_max_bit_size::<128>();
            assert(lte(repaid_scaled[i] * rate_index, repays[i] * WAD));
            assert(!lte(repaid_scaled[i] * rate_index + rate_index, repays[i] * WAD));
            // Close factor: a shallow breach sells at most 20% of the debt, unless that would leave
            // dust (below min_debt, audit H-1): then the whole debt may be repaid.
            assert(lte(repaid_scaled[i], debt));
            let new_coll = coll - sold[i];
            let rest = debt - repaid_scaled[i];
            let partial_leaves_dust = !lte(min_debt * WAD * 5, debt * 4 * rate_index);
            if !deep & !((rest == 0) & partial_leaves_dust) {
                assert(lte(repaid_scaled[i] * 5, debt));
            }
            // A position that keeps collateral keeps no dust debt.
            if (new_coll != 0) & (rest != 0) {
                assert(lte(min_debt * WAD, rest * rate_index));
            }
            let mut written_off = 0;
            if new_coll == 0 {
                written_off = rest;
                assert_eq(new_leaves[i], 0);
            } else {
                assert_eq(
                    position_commitment(coll_asset, new_coll, rest, owner[i], liquidated_blinding(b)),
                    new_leaves[i],
                );
            }
            assert_eq(enc_sold[i], sold[i] + liquidation_pad(b, 1));
            assert_eq(enc_repaid[i], repaid_scaled[i] + liquidation_pad(b, 2));

            sums[0] += sold[i];
            sums[1] += values[i];
            sums[2] += repays[i];
            sums[3] += repaid_scaled[i];
            sums[4] += written_off;
        }
    }
    assert_eq(sums, [total_sold, total_value, total_repay, total_repaid_scaled, total_written_off]);
}

mod tests;
