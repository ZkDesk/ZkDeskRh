// Mandate governance for a treasury ledger: COMMIT (0), REVOKE (1), PAUSE (2), RESUME (3), by an
// Owner, Treasurer or Payer (never the Auditor). On COMMIT the mandate opens to this ledger, and a
// cap above the policy's dual-control threshold needs the Owner: the committed mandate is then the
// Owner's standing approval for every pull under it. ext_data_hash binds the mandate ciphertext.
use lib::{
    ledger_id as ledger_of, lte, mandate_commit as mandate_of, owner_pk, policy_hash as policy_of,
    roles_commit as roles_of,
};

global COMMIT: Field = 0;
global OWNER: u32 = 0;
global AUDITOR: u32 = 3;

fn main(
    ledger_id: pub Field,
    roles_commit: pub Field,
    policy_hash: pub Field,
    action: pub Field,
    mandate_commit: pub Field,
    ext_data_hash: pub Field,
    lsk: Field,
    sk: Field,
    role: u32,
    role_pks: [Field; 4],
    roles_salt: Field,
    alloc_cap: Field,
    dual_threshold: Field,
    policy_salt: Field,
    kind: Field,
    recipient: Field,
    asset: Field,
    cap: Field,
    period: Field,
    start: Field,
    expiry: Field,
    reference: Field,
    salt: Field,
) {
    let _ = ext_data_hash;
    assert_eq(ledger_of(lsk), ledger_id);
    assert_eq(roles_of(role_pks, roles_salt), roles_commit);
    assert_eq(owner_pk(sk), role_pks[role]);
    assert(role != AUDITOR);
    assert_eq(policy_of(alloc_cap, dual_threshold, policy_salt), policy_hash);
    assert((action == COMMIT) | (action == 1) | (action == 2) | (action == 3));
    if action == COMMIT {
        assert_eq(
            mandate_of(ledger_id, kind, recipient, asset, cap, period, start, expiry, reference, salt),
            mandate_commit,
        );
        assert((kind == 0) | (kind == 1) | (kind == 2));
        if kind == 1 {
            assert_eq(period, 0); // invoices are paid once
        }
        cap.assert_max_bit_size::<100>();
        dual_threshold.assert_max_bit_size::<100>();
        assert(lte(cap, dual_threshold) | (role == OWNER));
    }
}
