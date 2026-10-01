// Treasury approval requests mailbox (dual control across members; no gas).
//   GET  /api/requests?ledger=0x…   -> the latest sealed requests for a treasury
//   POST /api/requests {ledgerId, ciphertext}
// Requests are opaque: sealed with a key only the treasury's members hold, so the server cannot read
// them and clients drop anything that does not open. No identity is stored. Status comes from the
// chain (the Owner's approval event, then the spent notes), not from this table.
import { db, json } from './_lib/server.js';

const MAX_BYTES = 4096;
const OPEN_PER_LEDGER = 50;
const isId = (x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ledger = String(req.query?.ledger ?? '').toLowerCase();
    if (!isId(ledger)) return json(res, 400, { error: 'invalid_ledger' });
    const { rows } = await db.query(`select id, ciphertext, created_at from public.approval_requests where ledger_id = $1 and created_at > now() - interval '14 days' order by created_at desc limit $2`, [ledger, OPEN_PER_LEDGER]);
    return json(res, 200, { requests: rows });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const ledger = String(body.ledgerId ?? '').toLowerCase();
  const ct = String(body.ciphertext ?? '');
  if (!isId(ledger) || !/^0x[0-9a-f]+$/i.test(ct) || ct.length / 2 > MAX_BYTES) return json(res, 400, { error: 'invalid_request' });
  const { rows } = await db.query('insert into public.approval_requests (ledger_id, ciphertext) values ($1, $2) returning id', [ledger, ct]);
  return json(res, 200, { id: rows[0].id });
}
