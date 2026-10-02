// Pay-per-call for an HTTP API: an unpaid request gets 402 with a one-time ZKdesk payment challenge;
// the caller (an agent: fetchPaid / zkdesk_fetch_paid) pays it privately and repeats the request with
// the x-zkdesk-request header; the paywall serves it once a matching payment is in the pool.
//
//   const service = await createAgent({ seed: SERVICE_SEED, network: 'mainnet' }); // the API's own account
//   const paywall = createPaywall({ agent: service, price: '0.25' });
//   http.createServer(async (req, res) => { if (await paywall.guard(req, res)) res.end('the paid answer'); });
//
// What it relies on: each open challenge has its own amount (the price plus 1 to 9,999 millionths), so a
// payment matches one challenge; only payments in the pool count (a deposit still in screening can be
// taken back); only payments made after the challenge count; a payment unlocks one request, once; a
// challenge is bound to the method, path and query it was issued for and expires (ttlSeconds). An
// amount freed by an expired challenge stays reserved for another ttl, so a late payment cannot unlock
// someone else's challenge. guard never throws: a bad request is a 400, a chain read failure a 503.
// The service learns nothing about the payer. ponytail: challenges and used payments live in this
// process's memory, so a restart forgets open challenges (a caller who paid then gets a new one); run one
// instance per account.
import { randomBytes } from 'node:crypto';
import { formatUnits, parseUnits } from 'viem';
import { paymentLink } from '../src/lib/zk/request-link.js';

const HEADER = 'x-zkdesk-request';
const SPREAD = 9_999n; // unique part of the amount, in base units (at most 0.009999 USDG)

/** The default caller key: the socket address, an IPv6 one by its /64 (one host holds a whole /64). */
export function socketClient(req) {
  const ip = String(req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

/**
 * agent: the service's own account (agent/index.mjs createAgent). price: USDG string. origin: the
 * ZKdesk site the payment link opens. maxOpen bounds all open challenges, perClient those of one
 * caller. Beyond either: 503.
 * BEHIND A REVERSE PROXY, pass clientOf: with the default (the socket address) every caller looks like
 * the proxy and shares one perClient budget. Read the client address from the header your proxy sets
 * and overwrites (never one a caller can set).
 */
export function createPaywall({
  agent, price, ttlSeconds = 300, origin = 'https://zkdesk.tech', maxOpen = 1000, perClient = 5, recheckMs = 3000,
  clientOf = socketClient, now = () => Date.now(),
}) {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(String(price)) || !(Number(price) > 0)) throw new Error(`price must be a USDG amount above zero (got "${price}").`);
  // Open plus recently expired challenges reserve up to twice maxOpen amounts out of 9,999.
  if (!(maxOpen > 0 && maxOpen <= 4000)) throw new Error('maxOpen must be between 1 and 4,000 (amounts are unique among 9,999).');
  const base = parseUnits(String(price), 6);
  const ttl = ttlSeconds * 1000;
  const open = new Map(); // requestId -> { raw, since, expires, route, client }
  const reserved = new Map(); // amount -> reserved until (open challenges, and expired ones for another ttl)
  const used = new Map(); // payment id -> block: each payment unlocks one request
  let cache = { at: -Infinity, list: [] };
  let inflight = null;
  // The chain head for new challenges, re-read at most every recheckMs (unpaid requests must not each
  // cost a chain sync) and never going back (a lagging RPC node cannot reopen a used payment).
  let head = { at: -Infinity, block: 0 };
  let headInflight = null;

  async function headBlock() {
    if (now() - head.at < recheckMs) return head.block;
    headInflight ??= agent.head().then((block) => { head = { at: now(), block: Math.max(head.block, block) }; return head.block; }).finally(() => { headInflight = null; });
    return headInflight;
  }
  // All payments received, read once per recheckMs for every caller (a chain sync costs the same
  // whatever the start block); each challenge then filters by its own start block.
  async function payments() {
    if (now() - cache.at < recheckMs) return cache.list;
    inflight ??= agent.payments({ since: 0 }).then((list) => { cache = { at: now(), list }; return list; }).finally(() => { inflight = null; });
    return inflight;
  }
  function prune() {
    for (const [id, c] of open) {
      if (now() < c.expires) continue;
      open.delete(id);
      reserved.set(c.raw, c.expires + ttl); // a late payment of this amount must not unlock a new challenge
    }
    for (const [raw, until] of reserved) if (now() >= until) reserved.delete(raw);
    // A used payment can only matter to a challenge whose start block is before it: an open one, or a
    // future one, which starts at the last head read or later. Older used payments can go.
    const oldest = Math.min(head.block, ...[...open.values()].map((c) => c.since));
    for (const [pid, block] of used) if (block <= oldest) used.delete(pid);
  }
  function reply(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
    return false;
  }
  const challengeOf = (id, c) => ({
    version: 1, requestId: id, network: agent.network, amount: formatUnits(c.raw, 6),
    link: paymentLink(origin, { to: agent.address, amount: formatUnits(c.raw, 6), network: agent.network }).toString(),
    expiresAt: new Date(c.expires).toISOString(), header: HEADER,
  });
  const busy = (client) => open.size >= maxOpen || [...open.values()].filter((c) => c.client === client).length >= perClient;

  async function check(req, res) {
    let route;
    try {
      const u = new URL(req.url, 'http://x');
      route = `${req.method} ${u.pathname}${u.search}`;
    } catch {
      return reply(res, 400, { error: 'bad_request' });
    }
    prune();
    const id = req.headers?.[HEADER];
    if (typeof id === 'string' && open.has(id)) {
      const c = open.get(id);
      if (c.route !== route) return reply(res, 402, { error: 'payment_required', message: 'This request id was issued for another route.' });
      const hit = (await payments()).find((p) => p.raw === c.raw && p.block > c.since && !used.has(p.id));
      if (hit && open.has(id) && !used.has(hit.id)) {
        used.set(hit.id, hit.block); // the payment is spent for good, so its amount is free again
        open.delete(id);
        reserved.delete(c.raw);
        return true;
      }
      return reply(res, 402, { error: 'payment_required', pending: true, message: 'No matching payment has reached the pool yet.', zkdesk: challengeOf(id, c) });
    }
    const client = String(clientOf(req));
    if (busy(client)) return reply(res, 503, { error: 'busy', message: 'Too many open payment requests. Try again shortly.' });
    const since = await headBlock();
    if (busy(client)) return reply(res, 503, { error: 'busy', message: 'Too many open payment requests. Try again shortly.' });
    // Choose and reserve the amount with no await in between: concurrent challenges never share one.
    let raw = null;
    for (let i = 0; i < 64 && raw === null; i++) {
      const pick = base + 1n + (BigInt(`0x${randomBytes(4).toString('hex')}`) % SPREAD);
      if (!reserved.has(pick)) raw = pick;
    }
    if (raw === null) return reply(res, 503, { error: 'busy', message: 'Too many open payment requests. Try again shortly.' });
    reserved.set(raw, Infinity);
    const c = { raw, since, expires: now() + ttl, route, client };
    const newId = randomBytes(18).toString('base64url');
    open.set(newId, c);
    return reply(res, 402, { error: 'payment_required', message: `Pay ${formatUnits(raw, 6)} USDG privately with ZKdesk, then repeat the request with the ${HEADER} header.`, zkdesk: challengeOf(newId, c) });
  }

  return {
    /** true: paid, let the request through (once). false: a 400, 402 or 503 has been written. Never throws. */
    async guard(req, res) {
      try {
        return await check(req, res);
      } catch {
        if (!res.headersSent && !res.writableEnded) reply(res, 503, { error: 'unavailable', message: 'Payments cannot be checked right now. Try again shortly.' });
        return false;
      }
    },
    /** Open challenges (for monitoring). */
    get open() { return open.size; },
  };
}
