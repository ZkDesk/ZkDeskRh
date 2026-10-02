// Treasury solvency statement: up to K unspent ledger notes, valued at contract-supplied prices,
// cover the declared liabilities. Publishes only the statement (ledger, liabilities) plus the notes'
// nullifiers, which the contract checks are unspent; zero-amount dummies pad the count. The balance
// stays private, but the nullifiers are public: later spends of those notes link to the statement,
// so the number of notes behind a statement can be learned over time (audit L-2).
//
// prices: USDG (6 dp) value of 1e18 base units of each asset; value6 = amount * price / 1e18.
use lib::{
    ledger_id as ledger_of, lte, MAX_DEPTH, merkle_root_swap, note_commitment, nullifier, nullifier_key,
    WAD,
};

global K: u32 = 8;
global A: u32 = 6;

fn main(
    root: pub Field,
    ledger_id: pub Field,
    liabilities: pub Field,
    assets: pub [Field; A],
    prices: pub [Field; A],
    nullifiers: pub [Field; K],
    lsk: Field,
    asset_index: [u32; K],
    amounts: [Field; K],
    blindings: [Field; K],
    depths: [u32; K],
    indices: [Field; K],
    siblings: [[Field; MAX_DEPTH]; K],
) {
    assert_eq(ledger_of(lsk), ledger_id);
    let nk = nullifier_key(lsk);
    liabilities.assert_max_bit_size::<128>();
    for a in 0..A {
        prices[a].assert_max_bit_size::<128>();
    }
    let mut total = 0;
    for i in 0..K {
        amounts[i].assert_max_bit_size::<100>();
        let a = asset_index[i];
        let cm = note_commitment(assets[a], amounts[i], ledger_id, blindings[i]);
        assert_eq(nullifier(cm, nk), nullifiers[i]);
        if amounts[i] != 0 {
            assert_eq(merkle_root_swap(cm, depths[i], indices[i], siblings[i]), root);
        }
        total += amounts[i] * prices[a];
        // Each note counts once.
        for j in 0..K {
            if j < i {
                assert(nullifiers[i] != nullifiers[j]);
            }
        }
    }
    assert(lte(liabilities * WAD, total));
}

mod tests;
