// Payment receipt, made by the recipient only (it needs the recipient's spend key): "treasury
// `ledger_id` paid me for period `k`", against a published receipt root, addressed to one
// `verifier`. The amount and the recipient's key are disclosed only if the recipient chooses; an
// undisclosed field is public as 0. The ledger and the period k are public, so the receipt links to
// that mandate's on-chain pulls: whoever sees it learns the mandate's payment schedule (audit L-1).
use lib::{MAX_DEPTH, merkle_root_swap, note_commitment, owner_pk, receipt_leaf as receipt_of};

fn main(
    receipt_root: pub Field,
    ledger_id: pub Field,
    k: pub Field,
    asset: pub Field,
    verifier: pub Field,
    disclose_amount: pub bool,
    amount_out: pub Field,
    disclose_owner: pub bool,
    owner_out: pub Field,
    sk: Field,
    amount: Field,
    blinding: Field,
    depth: u32,
    index: Field,
    siblings: [Field; MAX_DEPTH],
) {
    let _ = verifier;
    let owner = owner_pk(sk);
    let payment = note_commitment(asset, amount, owner, blinding);
    assert_eq(merkle_root_swap(receipt_of(ledger_id, k, payment), depth, index, siblings), receipt_root);
    assert_eq(amount_out, if disclose_amount { amount } else { 0 });
    assert_eq(owner_out, if disclose_owner { owner } else { 0 });
}

mod tests;
