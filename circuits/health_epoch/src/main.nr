// Epoch health proof over every CreditDesk slot. All slot leaves are public inputs read from the
// desk in the same transaction, so no live position can be omitted; each is opened privately by the
// desk operator and valued at the pinned marks. Publishes only the desk totals and a commitment to
// the set of breached slots (debt above collateral value x liquidation threshold).
//
// Units as in circuits/position: collateral 18 dp, marks 8 dp, USDG 6 dp, rate_index 1e18-based.
use lib::{debt_term, lte, position_commitment, value_term, WAD};
use poseidon::poseidon::bn254::hash_2;

global SLOTS: u32 = 64;
global CLASSES: u32 = 4;
global VALUE_DIV: Field = 100000000000000000000; // 1e20: coll(18) * mark(8) -> USDG(6)

fn main(
    leaves: pub [Field; SLOTS],
    assets: pub [Field; CLASSES],
    marks: pub [Field; CLASSES],
    liq_bps: pub [Field; CLASSES],
    rate_index: pub Field,
    sum_value: pub Field, // floor(sum of collateral * mark / 1e20), USDG
    sum_debt: pub Field, // ceil(sum of debt_scaled * index / 1e18), USDG
    breach_commit: pub Field, // H(bitmap of breached slots, salt)
    class: [u32; SLOTS],
    collateral: [Field; SLOTS],
    debt_scaled: [Field; SLOTS],
    owner: [Field; SLOTS],
    blinding: [Field; SLOTS],
    salt: Field,
) {
    rate_index.assert_max_bit_size::<96>();
    for k in 0..CLASSES {
        marks[k].assert_max_bit_size::<64>();
        liq_bps[k].assert_max_bit_size::<16>();
    }

    let mut value = 0;
    let mut debt = 0;
    let mut bitmap = 0;
    let mut bit = 1;
    for i in 0..SLOTS {
        if leaves[i] == 0 {
            assert_eq(collateral[i], 0);
            assert_eq(debt_scaled[i], 0);
        } else {
            let k = class[i];
            // The leaf binds the asset, so a position cannot be valued at another class's mark.
            assert_eq(
                position_commitment(assets[k], collateral[i], debt_scaled[i], owner[i], blinding[i]),
                leaves[i],
            );
            value += collateral[i] * marks[k];
            debt += debt_scaled[i] * rate_index;
            if !lte(
                debt_term(debt_scaled[i], rate_index),
                value_term(collateral[i], marks[k], liq_bps[k]),
            ) {
                bitmap += bit;
            }
        }
        bit *= 2;
    }

    // Exact floor / ceil divisions (sums stay far below the field: 64 * 2^164 and 64 * 2^224).
    sum_value.assert_max_bit_size::<128>();
    sum_debt.assert_max_bit_size::<128>();
    assert(lte(value - sum_value * VALUE_DIV, VALUE_DIV - 1));
    assert(lte(sum_debt * WAD - debt, WAD - 1));

    assert_eq(hash_2([bitmap, salt]), breach_commit);
}

mod tests;
