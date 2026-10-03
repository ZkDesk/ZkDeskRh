// The move to new keys, counted in relayed steps (no dependencies: the dashboard bundle imports it).
/**
 * Relayed steps a move takes (each pays one voucher): governance steps left, transfers, and per live
 * mandate a commit (+ a pause when paused) and a revoke if it is carried, else a revoke.
 * preview: { governance, txs, mandates: [{ id, paused, carryable }] }; carry: the ids chosen.
 */
export function rekeyStepCount(preview, carry = []) {
  const chosen = new Set(carry);
  // A mandate continued in an earlier run only needs the old one revoked (and maybe a pause).
  return preview.governance + preview.txs + preview.mandates.reduce((t, m) => t + (m.continued ? 1 + (m.needsPause ? 1 : 0) : chosen.has(m.id) && m.carryable ? 2 + (m.paused ? 1 : 0) : 1), 0);
}
