// Ledger governance, OWNER only: CREATE (0), ROTATE roles (1), SET_POLICY (2), APPROVE a
// dual-control intent (3). Proves knowledge of the ledger secret and the OWNER role key behind the
// roles commitment (for CREATE: the new one). The action, new value, current policy and the ext
// data (key shares and config ciphertexts) are public inputs bound by the proof; replays are
// harmless because each commitment carries a fresh salt.
use lib::{ledger_id as ledger_of, owner_pk, roles_commit as roles_of};

fn main(
    ledger_id: pub Field,
    roles_commit: pub Field,
    policy_hash: pub Field,
    action: pub Field,
    new_value: pub Field,
    ext_data_hash: pub Field,
    lsk: Field,
    sk: Field,
    role_pks: [Field; 4],
    roles_salt: Field,
) {
    let _ = (policy_hash, action, new_value, ext_data_hash);
    assert_eq(ledger_of(lsk), ledger_id);
    assert_eq(roles_of(role_pks, roles_salt), roles_commit);
    assert_eq(owner_pk(sk), role_pks[0]);
}

mod tests;
