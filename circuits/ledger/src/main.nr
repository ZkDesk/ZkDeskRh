// One treasury ledger action, spent by a role key under the ledger policy:
//   ALLOCATE (0)     ledger USDG -> yield-vault shares, OWNER or TREASURER, at most the policy cap
//   DEALLOCATE (1)   ledger vault shares -> USDG, OWNER or TREASURER
//   TRANSFER_OUT (2) ledger asset -> any private owner and/or a public address (unshield),
//                    OWNER, TREASURER or PAYER. Above the policy's dual-control threshold a
//                    non-owner exposes `cosign_intent`, which the OWNER must approve on-chain first.
// AUDITOR can never act. Roles and policy are hidden behind the on-chain commitments; the acting
// role, amounts and recipient stay private. Output 0 is always the ledger's change.
use lib::{
    DOM_INTENT, ledger_id as ledger_of, lte, MAX_DEPTH, nullifier_key, output_note, owner_pk,
    policy_hash as policy_of, roles_commit as roles_of, spend_inputs,
};
use poseidon::poseidon::bn254::hash_7;

global ALLOCATE: Field = 0;
global TRANSFER_OUT: Field = 2;
global OWNER: u32 = 0;
global TREASURER: u32 = 1;
global AUDITOR: u32 = 3;

fn main(
    root: pub Field,
    ledger_id: pub Field,
    roles_commit: pub Field,
    policy_hash: pub Field,
    action: pub Field,
    asset: pub Field,
    out_asset: pub Field,
    public_amount: pub Field,
    public_amount_out: pub Field,
    ext_data_hash: pub Field,
    input_nullifiers: pub [Field; 2],
    output_commitments: pub [Field; 2],
    cosign_intent: pub Field,
    lsk: Field,
    sk: Field,
    role: u32,
    role_pks: [Field; 4],
    roles_salt: Field,
    alloc_cap: Field,
    dual_threshold: Field,
    policy_salt: Field,
    in_amounts: [Field; 2],
    in_blindings: [Field; 2],
    in_path_depths: [u32; 2],
    in_path_indices: [Field; 2],
    in_path_siblings: [[Field; MAX_DEPTH]; 2],
    out_amounts: [Field; 2],
    out_owner: Field,
    out_blindings: [Field; 2],
) {
    // Who: a member of this ledger's role set, acting in a role allowed for the action.
    assert_eq(ledger_of(lsk), ledger_id);
    assert_eq(roles_of(role_pks, roles_salt), roles_commit);
    assert_eq(owner_pk(sk), role_pks[role]);
    assert(role != AUDITOR);
    assert((action == 0) | (action == 1) | (action == TRANSFER_OUT));
    if action != TRANSFER_OUT {
        assert(role <= TREASURER);
    }
    alloc_cap.assert_max_bit_size::<100>();
    dual_threshold.assert_max_bit_size::<100>();
    assert_eq(policy_of(alloc_cap, dual_threshold, policy_salt), policy_hash);

    // What: ledger notes in, the ledger's change out, plus one output.
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
    assert_eq(output_note(asset, out_amounts[0], ledger_id, out_blindings[0]), output_commitments[0]);
    assert_eq(output_note(out_asset, out_amounts[1], out_owner, out_blindings[1]), output_commitments[1]);
    // Value leaving the ledger's `asset` balance (converted, transferred or unshielded).
    let moved = sum_in - out_amounts[0];
    moved.assert_max_bit_size::<100>();

    if action == TRANSFER_OUT {
        assert_eq(out_asset, asset);
        assert_eq(public_amount_out, 0);
        assert_eq(sum_in + public_amount, out_amounts[0] + out_amounts[1]);
        let intent = hash_7([
            DOM_INTENT,
            ledger_id,
            input_nullifiers[0],
            input_nullifiers[1],
            output_commitments[0],
            output_commitments[1],
            ext_data_hash,
        ]);
        let needs_owner = !lte(moved, dual_threshold) & (role != OWNER);
        assert_eq(cosign_intent, if needs_owner { intent } else { 0 });
    } else {
        // Convert through the yield vault; the proceeds stay with the ledger.
        assert(out_asset != asset);
        assert_eq(out_owner, ledger_id);
        assert_eq(out_amounts[1], public_amount_out);
        assert_eq(sum_in + public_amount, out_amounts[0]);
        if action == ALLOCATE {
            assert(lte(moved, alloc_cap));
        }
        assert_eq(cosign_intent, 0);
    }
}
