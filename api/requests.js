// Treasury approval requests mailbox (dual control across members; no gas).
//   GET  /api/requests?ledger=0x…   -> the latest sealed requests for a treasury
//   POST /api/requests {ledgerId, ciphertext, signature}   -> posts a sealed request
// Requests are opaque: sealed with a key only the treasury's members hold, so the server cannot read
// them and clients drop anything that does not open. No identity is stored. Status comes from the
// chain (the Owner's approval event, then the spent notes), not from this table.
// Posting needs the treasury's mailbox key, derived from the ledger secret. Its address is registered
// only through the treasury's create relay request (api/relay.js), and posts are accepted only for
// treasuries that exist on-chain, so made-up ids can neither register nor post (audit M-6/N-4).
// A treasury takes at most POSTS_PER_DAY requests; requests expire after 14 days (api/cron/tick.js).
// No IP addresses are read (privacy rule).
import { verifyMessage } from 'viem';
import { abis, db, deployment, json, publicClient } from './_lib/server.js';
import { mailboxMessages } from '../src/lib/zk/ledger.js';

const MAX_BYTES = 4096;
const OPEN_PER_LEDGER = 50;
const POSTS_PER_DAY = 50;

const isId = (x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ledger = String(req.query?.ledger ?? '').toLowerCase();
    if (!isId(ledger)) return json(res, 400, { error: 'invalid_ledger' });
    const { rows } = await db.query(`select id, ciphertext, created_at from public.approval_requests where ledger_id = $1 and created_at > now() - interval '14 days' order by created_at desc limit $2`, [ledger, OPEN_PER_LEDGER]);
    return json(res, 200, { requests: rows });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  } catch {
    return json(res, 400, { error: 'invalid_request' });
  }
  if (body.register !== undefined) return json(res, 410, { error: 'register_with_create' }); // registration rides on the create relay
  const ledger = String(body.ledgerId ?? '').toLowerCase();
  const signature = String(body.signature ?? '');
  if (!isId(ledger) || !/^0x[0-9a-f]{130}$/i.test(signature)) return json(res, 400, { error: 'invalid_request' });

  const ct = String(body.ciphertext ?? '');
  if (!/^0x[0-9a-f]+$/i.test(ct) || ct.length / 2 > MAX_BYTES) return json(res, 400, { error: 'invalid_request' });
  // Authenticate first (the mailbox key, then its signature); only then read the chain.
  const { rows: [key] } = await db.query('select signer from public.mailbox_keys where ledger_id = $1', [ledger]);
  if (!key) return json(res, 409, { error: 'mailbox_unregistered' });
  if (!(await verifyMessage({ address: key.signer, message: mailboxMessages.post(ledger, ct), signature }).catch(() => false))) return json(res, 401, { error: 'bad_signature' });
  const [rolesCommit] = await publicClient.readContract({ address: deployment.ledger, abi: abis.ledger, functionName: 'ledgers', args: [BigInt(ledger)] });
  if (rolesCommit === 0n) return json(res, 404, { error: 'unknown_ledger' });
  const { rows: [{ n }] } = await db.query(`select count(*)::int as n from public.approval_requests where ledger_id = $1 and created_at > now() - interval '1 day'`, [ledger]);
  if (n >= POSTS_PER_DAY) return json(res, 429, { error: 'mailbox_full' });
  const { rows } = await db.query('insert into public.approval_requests (ledger_id, ciphertext) values ($1, $2) on conflict do nothing returning id', [ledger, ct]);
  return json(res, 200, { id: rows[0]?.id ?? null, duplicate: !rows.length });
}
