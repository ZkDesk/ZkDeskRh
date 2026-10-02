// Eviction of an idle, zero-debt credit position (audit H-1). The desk operator, who can open every
// position, proves that the slot's leaf holds `collateral` of `asset` and no debt, and that
// `commitment` is a note of exactly that collateral for the same owner, with a blinding the owner can
// derive (evicted_blinding). CreditDesk frees the slot and returns the collateral to the pool as that
// note; no ciphertext is needed. The amount becomes public, the owner does not.
use lib::{evicted_blinding, output_note, position_commitment};

fn main(leaf: pub Field, asset: pub Field, collateral: pub Field, commitment: pub Field, owner: Field, blinding: Field) {
    assert(leaf != 0);
    assert_eq(position_commitment(asset, collateral, 0, owner, blinding), leaf);
    assert_eq(output_note(asset, collateral, owner, evicted_blinding(blinding)), commitment);
}

#[test]
fn evicts_into_the_owners_note() {
    let (asset, coll, owner, b) = (0x5b1, 7, 42, 99);
    let leaf = position_commitment(asset, coll, 0, owner, b);
    main(leaf, asset, coll, output_note(asset, coll, owner, evicted_blinding(b)), owner, b);
}

#[test(should_fail)]
fn a_position_with_debt_cannot_be_evicted() {
    let (asset, coll, owner, b) = (0x5b1, 7, 42, 99);
    let leaf = position_commitment(asset, coll, 1, owner, b);
    main(leaf, asset, coll, output_note(asset, coll, owner, evicted_blinding(b)), owner, b);
}

#[test(should_fail)]
fn the_note_must_go_to_the_owner() {
    let (asset, coll, owner, b) = (0x5b1, 7, 42, 99);
    let leaf = position_commitment(asset, coll, 0, owner, b);
    main(leaf, asset, coll, output_note(asset, coll, 43, evicted_blinding(b)), owner, b);
}

mod tests;
