// Pay-per-call for an HTTP API: an unpaid request gets 402 with a one-time ZKdesk payment challenge;
// the caller (an agent: fetchPaid / zkdesk_fetch_paid) pays it privately and repeats the request with
// the x-zkdesk-request header; the paywall serves it once a matching payment is in the pool.
//
//   const service = await createAgent({ seed: SERVICE_SEED, network: 'mainnet' }); // the API's own account
//   const paywall = createPaywall({ agent: service, price: '0.25', store: fileStore('/var/lib/api/paywall.json') });
//   http.createServer(async (req, res) => { if (await paywall.guard(req, res)) res.end('the paid answer'); });
//
// What it relies on: each open challenge has its own amount (the price plus 1 to 9,999 millionths), so a
// payment matches one challenge; only payments in the pool count (a deposit still in screening can be
// taken back); only payments made after the challenge count; a payment unlocks one request, once; a
// challenge is bound to the method, path and query it was issued for and expires (ttlSeconds). An
// amount stays reserved until its challenge expired plus another ttl, so a late payment cannot unlock
// someone else's challenge. guard never throws: a bad request is a 400, a store or chain failure a 503.
// The service learns nothing about the payer.
//
// State lives in a store with three atomic operations (add-if-absent with an expiry, get, delete):
// memoryStore (the default: one process, forgotten on restart), fileStore (one process, kept across
// restarts) or redisStore (any number of instances sharing one Redis). Every rule above holds across
// instances sharing a store: amounts and payments are claimed with add-if-absent, and a request is
// served only by the call that deletes its challenge. Use one store per service account: two stores
// on one account could hand out the same amount (paywalls on one account given no store share one).
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { formatUnits, parseUnits } from 'viem';
import { paymentLink } from '../src/lib/zk/request-link.js';

const HEADER = 'x-zkdesk-request';
const SPREAD = 9_999n; // unique part of the amount, in base units (at most 0.009999 USDG)
const CLAIM_MS = 30 * 86_400_000; // a used payment stays claimed for 30 days

/** In-process store (the default). Expired keys are swept as it goes. */
export function memoryStore({ now = () => Date.now(), onChange = null } = {}) {
  const map = new Map();
  let ops = 0;
  const live = (k) => {
    const e = map.get(k);
    if (e && now() >= e.until) map.delete(k);
    return map.get(k) ?? null;
  };
  const changed = () => onChange?.(map);
  return {
    map,
    async add(key, value, until) {
      if (++ops % 1000 === 0) for (const k of map.keys()) live(k);
      if (live(key)) return false;
      map.set(key, { value, until });
      try {
        changed();
      } catch (error) {
        map.delete(key); // not saved: not done
        throw error;
      }
      return true;
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    /** true if the key was there (and is now gone). */
    async del(key) {
      const prev = live(key);
      if (!prev) return false;
      map.delete(key);
      try {
        changed();
      } catch (error) {
        map.set(key, prev); // not saved: not done (a paid challenge stays servable)
        throw error;
      }
      return true;
    },
  };
}

/**
 * One process, kept across restarts: the memory store, written to `path` (mode 0600, synced, then
 * renamed into place) after every change; a change that cannot be saved is undone and fails. Not for
 * several processes at once: use redisStore for that. A file that exists but cannot be read stops the
 * start instead of being overwritten. Windows ignores the mode: keep the file in a private folder.
 * ponytail: the whole file is rewritten (synchronously) on every change, fine for low volume; above a
 * few requests a second, or with many paid payments kept 30 days, use redisStore.
 */
export function fileStore(path, { now = () => Date.now() } = {}) {
  const save = (map) => {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`; // created new ('wx'), never a planted link
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify([...map]));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  };
  const store = memoryStore({ now, onChange: save });
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (text !== null) {
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error(`${path} is not a paywall state file.`);
    for (const [k, e] of entries) if (now() < e.until) store.map.set(k, e);
  }
  return store;
}

/**
 * Any number of instances: a node-redis v4+ client (`createClient()` from the `redis` package, already
 * connected). add is SET NX with an expiry, so it is atomic across instances. The Redis must never evict
 * keys early (`maxmemory-policy noeviction`, and AOF to survive its own restarts), and each service
 * account needs its own prefix.
 */
export function redisStore(client, { prefix = 'zkdesk:paywall:', now = () => Date.now() } = {}) {
  return {
    async add(key, value, until) {
      return (await client.set(prefix + key, JSON.stringify(value), { NX: true, PX: Math.max(1, Math.ceil(until - now())) })) === 'OK';
    },
    async get(key) {
      const v = await client.get(prefix + key);
      return v === null ? null : JSON.parse(v);
    },
    async del(key) {
      return (await client.del(prefix + key)) === 1;
    },
  };
}

/** The default caller key: the socket address, an IPv6 one by its /64 (one host holds a whole /64). */
export function socketClient(req) {
  const ip = String(req.socket?.remoteAddress ?? 'unknown').toLowerCase().replace(/%.*$/, '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  if (!ip.includes(':')) return ip;
  // Expanded first: every host of a /64 gets the same key however its address is compressed.
  const [head, tail] = ip.split('::');
  const groups = (part) => (part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const h = groups(head);
  const t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return all.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}

const defaults = new WeakMap(); // agent -> the store its paywalls share when given none

/**
 * agent: the service's own account (agent/index.mjs createAgent). price: USDG string. origin: the
 * ZKdesk site the payment link opens. store: where challenges live (memoryStore by default).
 * perClient bounds the open challenges of one caller; all open challenges are bounded by the 9,999
 * amounts (beyond either: 503).
 * BEHIND A REVERSE PROXY, pass clientOf: with the default (the socket address) every caller looks like
 * the proxy and shares one perClient budget. Read the client address from the header your proxy sets
 * and overwrites (never one a caller can set).
 */
export function createPaywall({
  agent, price, ttlSeconds = 300, origin = 'https://zkdesk.tech', perClient = 5, recheckMs = 3000,
  clientOf = socketClient, now = () => Date.now(), store,
}) {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(String(price)) || !(Number(price) > 0)) throw new Error(`price must be a USDG amount above zero (got "${price}").`);
  if (!(perClient >= 1 && perClient <= 100)) throw new Error('perClient must be between 1 and 100.');
  if (!store) {
    if (!defaults.has(agent)) defaults.set(agent, memoryStore({ now }));
    store = defaults.get(agent);
  }
  const base = parseUnits(String(price), 6);
  const ttl = ttlSeconds * 1000;
  let cache = { at: -Infinity, list: [] };
  let inflight = null;
  // The chain head for new challenges, re-read at most every recheckMs (unpaid requests must not each
  // cost a chain sync) and never going back in this process.
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
  function reply(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
    return false;
  }
  const challengeOf = (id, c) => ({
    version: 1, requestId: id, network: agent.network, amount: formatUnits(BigInt(c.raw), 6),
    link: paymentLink(origin, { to: agent.address, amount: formatUnits(BigInt(c.raw), 6), network: agent.network }).toString(),
    expiresAt: new Date(c.expires).toISOString(), header: HEADER,
  });
  const busy = (res) => reply(res, 503, { error: 'busy', message: 'Too many open payment requests. Try again shortly.' });

  async function check(req, res) {
    if (String(req.url).length > 2048) return reply(res, 414, { error: 'uri_too_long' });
    let route;
    try {
      const u = new URL(req.url, 'http://x');
      // Stored as a hash: a challenge's state stays small whatever the URL.
      route = createHash('sha256').update(`${req.method} ${u.pathname}${u.search}`).digest('base64url');
    } catch {
      return reply(res, 400, { error: 'bad_request' });
    }
    const id = req.headers?.[HEADER];
    const c = typeof id === 'string' && /^[A-Za-z0-9_-]{24}$/.test(id) ? await store.get(`c:${id}`) : null;
    if (c && now() < c.expires) {
      if (c.route !== route) return reply(res, 402, { error: 'payment_required', message: 'This request id was issued for another route.' });
      const raw = BigInt(c.raw);
      for (const p of (await payments()).filter((x) => x.raw === raw && x.block > c.since)) {
        // A payment unlocks one request, once, across every instance sharing the store. A claim this
        // challenge already holds (a crash between the claim and the serve) is taken up again.
        const fresh = await store.add(`p:${p.id}`, id, now() + CLAIM_MS);
        if (!fresh && (await store.get(`p:${p.id}`)) !== id) continue;
        // Only the call that deletes the challenge serves it. If it is gone (served meanwhile, or this
        // copy of it is stale), give back a claim taken just now so its rightful challenge can use it.
        if (!(await store.del(`c:${id}`))) {
          // Tried twice: a claim left behind would block its rightful challenge for 30 days.
          if (fresh) await store.del(`p:${p.id}`).catch(() => store.del(`p:${p.id}`));
          return reply(res, 402, { error: 'payment_required', message: 'This request id was already used or has expired.' });
        }
        await store.del(`k:${c.client}:${c.slot}`).catch(() => {});
        await store.del(`a:${c.raw}`).catch(() => {}); // its payment is claimed for good: the amount is free again
        return true;
      }
      return reply(res, 402, { error: 'payment_required', pending: true, message: 'No matching payment has reached the pool yet.', zkdesk: challengeOf(id, c) });
    }
    const client = String(clientOf(req));
    const expires = now() + ttl;
    // One of the caller's perClient slots, held until the challenge expires (or is served).
    let slot = -1;
    let taking = -1; // a slot whose add failed may still have been applied: given back too
    let raw = null;
    try {
      for (let i = 0; i < perClient && slot < 0; i++) {
        taking = i;
        if (await store.add(`k:${client}:${i}`, 1, expires)) slot = i;
      }
      taking = -1;
      if (slot < 0) return busy(res);
      const since = await headBlock();
      // Its own amount, reserved until the challenge expired plus another ttl (a late payment of it
      // must not unlock a new challenge). A few tries: when amounts run short, a 503 is cheaper.
      for (let i = 0; i < 8 && raw === null; i++) {
        const pick = base + 1n + (BigInt(`0x${randomBytes(4).toString('hex')}`) % SPREAD);
        if (await store.add(`a:${pick}`, 1, expires + ttl)) raw = pick;
      }
      if (raw === null) throw new Error('busy');
      const newId = randomBytes(18).toString('base64url');
      const ch = { raw: raw.toString(), since, expires, route, client, slot };
      await store.add(`c:${newId}`, ch, expires);
      return reply(res, 402, { error: 'payment_required', message: `Pay ${formatUnits(raw, 6)} USDG privately with ZKdesk, then repeat the request with the ${HEADER} header.`, zkdesk: challengeOf(newId, ch) });
    } catch (error) {
      // Nothing was issued: give back the caller's slot and the amount.
      if (slot >= 0 || taking >= 0) await store.del(`k:${client}:${slot >= 0 ? slot : taking}`).catch(() => {});
      if (raw !== null) await store.del(`a:${raw}`).catch(() => {});
      if (error?.message === 'busy') return busy(res);
      throw error;
    }
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
  };
}
