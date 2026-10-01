// 2-in / 2-out join-split: deposit, private transfer, withdraw, and convert.
// Inputs and output 0 are in `asset`; output 1 is in `out_asset`.
// - Same asset (out_asset == asset): Σin + public_amount = out0 + out1, public_amount_out = 0.
// - Convert (out_asset != asset): Σin + public_amount = out0 (public_amount < 0 leaves via the
//   converter) and out1 = public_amount_out, the minimum the converter must return.
// Zero-amount inputs are dummies (no Merkle check); their nullifiers are still unique because
// each dummy uses a fresh blinding. public_amount is a field element: +x in, p - x out.
use lib::{MAX_DEPTH, nullifier_key, output_note, owner_pk, spend_inputs};

fn main(
    root: pub Field,
    public_amount: pub Field,
    ext_data_hash: pub Field,
    asset: pub Field,
    out_asset: pub Field,
    public_amount_out: pub Field,
    input_nullifiers: pub [Field; 2],
    output_commitments: pub [Field; 2],
    sk: Field,
    in_amounts: [Field; 2],
    in_blindings: [Field; 2],
    in_path_depths: [u32; 2],
    in_path_indices: [Field; 2],
    in_path_siblings: [[Field; MAX_DEPTH]; 2],
    out_amounts: [Field; 2],
    out_owners: [Field; 2],
    out_blindings: [Field; 2],
) {
    // Bound by the proof as a public input: recipient, relayer, fee, converter and ciphertexts.
    let _ = ext_data_hash;
    let owner = owner_pk(sk);
    let sum_in = spend_inputs(
        root,
        asset,
        owner,
        nullifier_key(sk),
        in_amounts,
        in_blindings,
        in_path_depths,
        in_path_indices,
        in_path_siblings,
        input_nullifiers,
    );
    assert_eq(output_note(asset, out_amounts[0], out_owners[0], out_blindings[0]), output_commitments[0]);
    assert_eq(output_note(out_asset, out_amounts[1], out_owners[1], out_blindings[1]), output_commitments[1]);
    if out_asset == asset {
        assert_eq(public_amount_out, 0);
        assert_eq(sum_in + public_amount, out_amounts[0] + out_amounts[1]);
    } else {
        assert_eq(out_amounts[1], public_amount_out);
        assert_eq(sum_in + public_amount, out_amounts[0]);
    }
}
