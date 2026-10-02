// node agent/paywall.test.mjs — the paywall's rules with a stand-in service account, and the paying
// side's refusals against a local server. No chain access: nothing here pays.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnits } from 'viem';
import { createPaywall, fileStore, memoryStore, redisStore, socketClient } from './paywall.mjs';
import { createAgent, isPrivateAddress } from './index.mjs';
import { agentKeys, zkAddress } from '../src/lib/zk/keys.js';

const service = zkAddress(agentKeys('0x' + '33'.repeat(32), 4663));
let block = 100;
const paid = []; // { id, raw, block }
let syncs = 0;
const fake = { address: service, network: 'mainnet', head: async () => { syncs++; return block; }, payments: async ({ since }) => { syncs++; return paid.filter((p) => p.block > since); } };
let t = 1_000_000;
const now = () => t;
const req = (id, url = '/answer', method = 'GET', ip = '1.2.3.4') => ({ method, url, headers: id ? { 'x-zkdesk-request': id } : {}, socket: { remoteAddress: ip } });
function res() {
  const r = { statusCode: 200, headers: {}, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = b ? JSON.parse(b) : null; } };
  return r;
}
async function call(wall, id, url, method, ip) {
  const r = res();
  const ok = await wall.guard(req(id, url, method, ip), r);
  return { ok, status: r.statusCode, body: r.body };
}

assert.throws(() => createPaywall({ agent: fake, price: '0' }), /price must be/);
assert.throws(() => createPaywall({ agent: fake, price: '1', perClient: 500 }), /perClient/);
const ipOf = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
// Re-review N-3: an IPv6 caller is keyed by its /64; a mapped IPv4 address by the IPv4 one.
assert.equal(socketClient({ socket: { remoteAddress: '2001:db8:1:2:aaaa::1' } }), socketClient({ socket: { remoteAddress: '2001:db8:1:2:ffff::9' } }));
assert.equal(socketClient({ socket: { remoteAddress: '::ffff:9.9.9.9' } }), '9.9.9.9');
// Re-review info: IPv6 forms that hide a private IPv4 address, and site-local ones.
for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:a00:1::', 'fec0::1', 'fe80::1%eth0', 'fd00::1', '::1', '::']) assert.ok(isPrivateAddress(ip), ip);
for (const ip of ['2606:4700::1111', '8.8.8.8', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::']) assert.ok(!isPrivateAddress(ip), ip);
const wall = createPaywall({ agent: fake, price: '0.25', now, recheckMs: 0, perClient: 100 });

// Review H-1: guard never throws. A URL Node accepts but URL() rejects is a 400; a failing chain read or
// store a 503.
assert.equal((await call(wall, null, 'http://a:99999/x')).status, 400);
const broken = createPaywall({ agent: { ...fake, head: async () => { throw new Error('The network RPC is behind'); } }, price: '1', now });
assert.equal((await call(broken)).status, 503);
const downStore = { add: async () => { throw new Error('store down'); }, get: async () => { throw new Error('store down'); }, del: async () => {} };
assert.equal((await call(createPaywall({ agent: fake, price: '1', now, store: downStore }))).status, 503);
assert.equal((await call(createPaywall({ agent: fake, price: '1', now, store: downStore }), 'a'.repeat(24))).status, 503);

// An unpaid request gets a challenge: its own amount (price + 1 to 9,999 millionths), the service's link.
const first = await call(wall);
assert.equal(first.ok, false);
assert.equal(first.status, 402);
const c = first.body.zkdesk;
assert.match(c.requestId, /^[A-Za-z0-9_-]{24}$/);
assert.ok(Number(c.amount) > 0.25 && Number(c.amount) <= 0.259999, c.amount);
assert.equal(new URL(c.link).searchParams.get('pay'), service);
assert.equal(new URL(c.link).searchParams.get('amount'), c.amount);
const raw = parseUnits(c.amount, 6);

// Not paid yet; paid before the challenge; the wrong amount; another route: all refused.
assert.equal((await call(wall, c.requestId)).body.pending, true);
paid.push({ id: 'early', raw, block: 100 }); // in the challenge's block: not after it
paid.push({ id: 'short', raw: raw - 1n, block: 101 });
assert.equal((await call(wall, c.requestId)).ok, false, 'a payment before the challenge, or of another amount, does not count');
assert.match((await call(wall, c.requestId, '/other')).body.message, /another route/);
assert.match((await call(wall, c.requestId, '/answer?premium=1')).body.message, /another route/, 'the query is part of the route');
assert.match((await call(wall, c.requestId, '/answer', 'POST')).body.message, /another route/);

// Paid after the challenge: served once.
paid.push({ id: 'good', raw, block: 102 });
assert.equal((await call(wall, c.requestId)).ok, true, 'paid: served');
const again = await call(wall, c.requestId);
assert.equal(again.ok, false);
assert.notEqual(again.body.zkdesk.requestId, c.requestId, 'a used request id only gets a new challenge');

// One payment unlocks one request. With a cached head, a later challenge can start before an earlier,
// already used payment (and could even get its freed amount): that payment still cannot pay it.
{
  const cached = createPaywall({ agent: fake, price: '0.25', now, recheckMs: 60_000, perClient: 100 });
  const c1 = (await call(cached)).body.zkdesk; // head 100
  paid.push({ id: 'p1', raw: parseUnits(c1.amount, 6), block: 102 });
  assert.equal((await call(cached, c1.requestId)).ok, true);
  const c2 = (await call(cached)).body.zkdesk; // the cached head: starts at 100, before p1
  paid.push({ id: 'p1', raw: parseUnits(c2.amount, 6), block: 102 }); // as if p1 had c2's amount
  assert.equal((await call(cached, c2.requestId)).ok, false, 'a payment is used once, even after every challenge closed');
}
block = 103;
const second = (await call(wall)).body.zkdesk;

// Expiry and unknown ids.
t += 300_000;
assert.equal((await call(wall, second.requestId)).body.zkdesk.requestId === second.requestId, false, 'an expired challenge is gone');
assert.equal((await call(wall, 'not-a-real-id')).status, 402);
// Review M-2: one caller holds at most perClient open challenges; others are not locked out by it.
const fair = createPaywall({ agent: fake, price: '1', now, perClient: 5, recheckMs: 0 });
for (let i = 0; i < 5; i++) assert.equal((await call(fair, null, '/answer', 'GET', '6.6.6.6')).status, 402);
assert.equal((await call(fair, null, '/answer', 'GET', '6.6.6.6')).status, 503, 'per-client bound');
assert.equal((await call(fair, null, '/answer', 'GET', '7.7.7.7')).status, 402, 'another caller still gets a challenge');

// Review L-1: an amount stays reserved until its challenge expired plus another ttl.
{
  const one = createPaywall({ agent: fake, price: '1', now, recheckMs: 0, store: memoryStore({ now }) });
  const expired = parseUnits((await call(one)).body.zkdesk.amount, 6);
  t += 300_000;
  const fresh = await Promise.all([...Array(3000)].map((_, i) => call(one, null, '/answer', 'GET', ipOf(i)).then((r) => r.body.zkdesk && parseUnits(r.body.zkdesk.amount, 6))));
  assert.ok(!fresh.includes(expired), 'a late payment for an expired challenge cannot match a new one');
}
// Re-review N-2: the 9,999 amounts bound all open challenges; once they are taken, a 503, never a hang.
{
  const full = createPaywall({ agent: fake, price: '1', now, recheckMs: 0, store: memoryStore({ now }) });
  const statuses = await Promise.all([...Array(10_200)].map((_, i) => call(full, null, '/answer', 'GET', ipOf(i)).then((r) => r.status)));
  assert.ok(statuses.every((s) => s === 402 || s === 503), 'no hang');
  assert.ok(statuses.filter((s) => s === 402).length <= 9_999, 'at most 9,999 open');
  assert.ok(statuses.includes(503), 'beyond the amounts: busy');
}
// Review L-2: the head never goes back in a process (a lagging RPC node).
{
  let h = 500;
  const lagging = createPaywall({ agent: { ...fake, head: async () => h }, price: '1', now, recheckMs: 0, perClient: 100 });
  await call(lagging);
  h = 490;
  t += 1;
  const a2 = (await call(lagging)).body.zkdesk;
  paid.push({ id: 'lag', raw: parseUnits(a2.amount, 6), block: 495 }); // between the lagging and the real head
  assert.equal((await call(lagging, a2.requestId)).ok, false, 'a challenge never starts below the highest head seen');
}

// Concurrent challenges never share an amount, and the head is not re-read for each one.
const many = createPaywall({ agent: fake, price: '1', now, recheckMs: 60_000, store: memoryStore({ now }) });
syncs = 0;
const issued = await Promise.all([...Array(500)].map((_, i) => call(many, null, '/answer', 'GET', ipOf(i)).then((r) => r.body.zkdesk)));
assert.equal(new Set(issued.map((x) => x.amount)).size, 500, 'unique amounts');
assert.ok(syncs <= 2, `one chain read for 500 challenges (${syncs})`);
// Review M-1: concurrent retries of challenges with different start blocks share one payments read.
syncs = 0;
await Promise.all(issued.slice(0, 200).map((x, i) => call(many, x.requestId, '/answer', 'GET', ipOf(i))));
assert.ok(syncs <= 1, `one payments read for 200 concurrent retries (${syncs})`);

// Lasting state. Two instances sharing one store act as one paywall: a challenge issued by one is served
// by the other, a payment unlocks one request even when both see it at once, and the per-caller bound
// counts across them.
{
  const shared = memoryStore({ now });
  const a = createPaywall({ agent: fake, price: '2', now, recheckMs: 0, store: shared, perClient: 2 });
  const b = createPaywall({ agent: fake, price: '2', now, recheckMs: 0, store: shared, perClient: 2 });
  const x = (await call(a, null, '/answer', 'GET', '8.8.8.8')).body.zkdesk;
  assert.equal((await call(b, x.requestId, '/answer', 'GET', '8.8.8.8')).body.pending, true, 'the other instance knows the challenge');
  await call(b, null, '/answer', 'GET', '8.8.8.8');
  assert.equal((await call(a, null, '/answer', 'GET', '8.8.8.8')).status, 503, 'the per-caller bound counts across instances');
  paid.push({ id: 'shared', raw: parseUnits(x.amount, 6), block: 600 });
  block = 650;
  const [ra, rb] = await Promise.all([call(a, x.requestId, '/answer', 'GET', '8.8.8.8'), call(b, x.requestId, '/answer', 'GET', '8.8.8.8')]);
  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, 'served exactly once across instances');
}
// A restart with a file store keeps open challenges and used payments.
{
  const path = join(mkdtempSync(join(tmpdir(), 'zkdesk-wall-')), 'paywall.json');
  const before = createPaywall({ agent: fake, price: '3', now, recheckMs: 0, store: fileStore(path, { now }) });
  const y = (await call(before)).body.zkdesk;
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0, 'the state file is private (0600)');
  paid.push({ id: 'filed', raw: parseUnits(y.amount, 6), block: 700 });
  block = 750;
  const after = createPaywall({ agent: fake, price: '3', now, recheckMs: 0, store: fileStore(path, { now }) }); // the restart
  assert.equal((await call(after, y.requestId)).ok, true, 'a challenge paid before the restart is served after it');
  const z = (await call(after)).body.zkdesk;
  paid.push({ id: 'filed', raw: parseUnits(z.amount, 6), block: 760 }); // the same payment again
  const later = createPaywall({ agent: fake, price: '3', now, recheckMs: 0, store: fileStore(path, { now }) }); // another restart
  assert.equal((await call(later, z.requestId)).ok, false, 'a used payment stays used across restarts');
}
// A file that exists but cannot be parsed stops the start instead of being overwritten.
{
  const dir = mkdtempSync(join(tmpdir(), 'zkdesk-bad-'));
  writeFileSync(join(dir, 'p.json'), '{not json');
  assert.throws(() => fileStore(join(dir, 'p.json')));
  writeFileSync(join(dir, 'q.json'), '{"a":1}');
  assert.throws(() => fileStore(join(dir, 'q.json')), /not a paywall state file/);
}
// Store review M-2: a long URL is refused, and the stored route is a short hash whatever the URL.
{
  const st = memoryStore({ now });
  const w = createPaywall({ agent: fake, price: '5', now, recheckMs: 0, store: st });
  assert.equal((await call(w, null, '/x?' + 'q'.repeat(3000))).status, 414);
  const ok = (await call(w, null, '/x?' + 'q'.repeat(1500))).body.zkdesk;
  assert.ok((await st.get(`c:${ok.requestId}`)).route.length <= 43, 'the route is stored as a hash');
}
// Store review L-2: a failure after the caller's slot was taken gives it back.
{
  let fail = true;
  const flaky = createPaywall({ agent: { ...fake, head: async () => { if (fail) throw new Error('RPC down'); return block; } }, price: '6', now, recheckMs: 0, perClient: 1 });
  assert.equal((await call(flaky, null, '/answer', 'GET', '5.5.5.5')).status, 503);
  fail = false;
  assert.equal((await call(flaky, null, '/answer', 'GET', '5.5.5.5')).status, 402, 'the slot was given back');
}
// Store review M-1: a crash after the claim (the store fails before the challenge is deleted) does not
// strand the payer: the next try takes its claim up again and serves, once.
{
  const st = memoryStore({ now });
  let crash = false;
  const crashy = { ...st, del: async (k) => { if (crash && k.startsWith('c:')) { crash = false; throw new Error('store went away'); } return st.del(k); } };
  const w = createPaywall({ agent: fake, price: '7', now, recheckMs: 0, store: crashy });
  const ch = (await call(w)).body.zkdesk;
  paid.push({ id: 'crash', raw: parseUnits(ch.amount, 6), block: block + 1 });
  block += 2;
  crash = true;
  assert.equal((await call(w, ch.requestId)).status, 503, 'the store failed after the claim');
  assert.equal((await call(w, ch.requestId)).ok, true, 'the paid request is still served');
  assert.equal((await call(w, ch.requestId)).ok, false, 'and only once');
}
// Store review L-1: a stale copy of a challenge (served meanwhile by another instance) never claims a
// payment: the claim it took is given back for the challenge it belongs to.
{
  const st = memoryStore({ now });
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const slowAgent = { ...fake, payments: async (a) => { await gate; return fake.payments(a); } };
  const quick = createPaywall({ agent: fake, price: '8', now, recheckMs: 0, store: st });
  const slow = createPaywall({ agent: slowAgent, price: '8', now, recheckMs: 0, store: st });
  const ch = (await call(quick)).body.zkdesk;
  paid.push({ id: 'first', raw: parseUnits(ch.amount, 6), block: block + 1 });
  block += 2;
  const stale = call(slow, ch.requestId); // reads the challenge, then waits on the chain
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal((await call(quick, ch.requestId)).ok, true, 'served by the quick instance');
  paid.push({ id: 'second', raw: parseUnits(ch.amount, 6), block: block + 1 }); // a later payment of the same amount
  release();
  assert.equal((await stale).ok, false, 'the stale copy is not served');
  assert.equal(await st.get('p:second'), null, 'and the payment it found is not kept claimed');
}
// Round 2, finding 1: a change the file store cannot save is undone, so a paid challenge whose serve
// failed to save is still served on the next try (and only once).
{
  let failSave = false;
  const st = memoryStore({ now, onChange: () => { if (failSave) throw new Error('EPERM: rename'); } });
  const w = createPaywall({ agent: fake, price: '9', now, recheckMs: 0, store: st });
  const ch = (await call(w)).body.zkdesk;
  paid.push({ id: 'unsaved', raw: parseUnits(ch.amount, 6), block: block + 1 });
  block += 2;
  failSave = true;
  assert.equal((await call(w, ch.requestId)).status, 503, 'the serve could not be saved');
  failSave = false;
  assert.equal((await call(w, ch.requestId)).ok, true, 'the paid request is still served');
  assert.equal((await call(w, ch.requestId)).ok, false, 'and only once');
}
// The file store writes a new temporary file each time and leaves none behind.
{
  const dir = mkdtempSync(join(tmpdir(), 'zkdesk-tmp-'));
  const st = fileStore(join(dir, 'w.json'), { now });
  await st.add('x', 1, t + 1000);
  await st.del('x');
  assert.deepEqual(readdirSync(dir), ['w.json']);
}
// Round 2, finding 4: a slot add that fails (perhaps after it was applied) gives the slot back.
{
  const st = memoryStore({ now });
  let failOnce = true;
  const flaky = { ...st, add: async (k, v, u) => { const r = await st.add(k, v, u); if (failOnce && k.startsWith('k:')) { failOnce = false; throw new Error('timeout'); } return r; } };
  const w = createPaywall({ agent: fake, price: '10', now, recheckMs: 0, perClient: 1, store: flaky });
  assert.equal((await call(w, null, '/answer', 'GET', '6.6.6.6')).status, 503);
  assert.equal((await call(w, null, '/answer', 'GET', '6.6.6.6')).status, 402, 'the slot was given back');
}
// Round 2, finding 5: paywalls on one account given no store share one (amounts and caller slots).
{
  const account = { ...fake };
  const a = createPaywall({ agent: account, price: '11', now, recheckMs: 0, perClient: 1 });
  const b = createPaywall({ agent: account, price: '11.005', now, recheckMs: 0, perClient: 1 });
  assert.equal((await call(a, null, '/answer', 'GET', '7.7.7.7')).status, 402);
  assert.equal((await call(b, null, '/answer', 'GET', '7.7.7.7')).status, 503, 'one budget per caller across the account');
}
// Round 2, finding 6: an IPv6 caller is keyed by its expanded /64.
{
  const key = (ip) => socketClient({ socket: { remoteAddress: ip } });
  assert.equal(key('2001:db8::1'), key('2001:db8::ffff'));
  assert.equal(key('2001:db8::1'), key('2001:0DB8:0:0:aaaa::1'));
  assert.equal(key('fe80::1%eth0'), key('fe80::2'));
  assert.notEqual(key('2001:db8::1'), key('2001:db8:0:1::1'));
}
// redisStore: SET NX with an expiry (a stand-in client with node-redis v4 semantics).
{
  const kv = new Map();
  const redis = {
    async set(k, v, o) { const e = kv.get(k); if (o.NX && e && t < e.until) return null; kv.set(k, { v, until: t + o.PX }); return 'OK'; },
    async get(k) { const e = kv.get(k); return e && t < e.until ? e.v : null; },
    async del(k) { const e = kv.get(k); kv.delete(k); return e && t < e.until ? 1 : 0; },
  };
  const r1 = createPaywall({ agent: fake, price: '4', now, recheckMs: 0, store: redisStore(redis, { now }) });
  const r2 = createPaywall({ agent: fake, price: '4', now, recheckMs: 0, store: redisStore(redis, { now }) });
  const w = (await call(r1)).body.zkdesk;
  assert.ok([...kv.keys()].every((k) => k.startsWith('zkdesk:paywall:')), 'keys are prefixed');
  paid.push({ id: 'redis', raw: parseUnits(w.amount, 6), block: 800 });
  block = 850;
  const [s1, s2] = await Promise.all([call(r1, w.requestId), call(r2, w.requestId)]);
  assert.equal([s1.ok, s2.ok].filter(Boolean).length, 1, 'served exactly once across Redis-sharing instances');
  t += 300_000;
  assert.equal((await call(r2, w.requestId)).body.zkdesk.requestId === w.requestId, false, 'expired keys are gone');
}

// The paying side (no payment is ever made here): https only, the price ceiling, a bad challenge, no
// redirects, and at most 64 KB of the body.
const later = () => new Date(Date.now() + 300_000).toISOString();
const server = createServer((rq, rs) => {
  if (rq.url === '/priced') { rs.statusCode = 402; rs.setHeader('content-type', 'application/json'); return rs.end(JSON.stringify({ zkdesk: { version: 1, requestId: 'a'.repeat(24), expiresAt: later(), link: `https://zkdesk.tech/dashboard?pay=${service}&amount=1.000123&network=mainnet` } })); }
  if (rq.url === '/soon') { rs.statusCode = 402; return rs.end(JSON.stringify({ zkdesk: { version: 1, requestId: 'c'.repeat(24), expiresAt: new Date(Date.now() + 30_000).toISOString(), link: `https://zkdesk.tech/dashboard?pay=${service}&amount=0.1&network=mainnet` } })); }
  if (rq.url === '/huge402') { rs.statusCode = 402; rs.write('{"zkdesk":{"pad":"'); for (let i = 0; i < 200; i++) rs.write('x'.repeat(10_000)); return rs.end('"}}'); }
  if (rq.url === '/testnet') { rs.statusCode = 402; return rs.end(JSON.stringify({ zkdesk: { version: 1, requestId: 'b'.repeat(24), expiresAt: later(), link: `https://zkdesk.tech/dashboard?pay=${service}&amount=0.1&network=testnet` } })); }
  if (rq.url === '/bad') { rs.statusCode = 402; return rs.end('{"zkdesk":{"version":1,"requestId":"x"}}'); }
  if (rq.url === '/move') { rs.statusCode = 302; rs.setHeader('location', 'http://127.0.0.1:1/'); return rs.end(); }
  rs.end('z'.repeat(100_000));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const stateDir = mkdtempSync(join(tmpdir(), 'zkdesk-paywall-'));
const strict = await createAgent({ seed: '0x' + '44'.repeat(32), network: 'mainnet', stateDir });
await assert.rejects(strict.fetchPaid({ url: `${base}/free`, maxPrice: '1' }), /Only https/);
// Review info: no localhost or private networks for a model's fetches.
for (const u of ['https://127.0.0.1/', 'https://localhost/', 'https://10.1.2.3/', 'https://[::1]/', 'https://192.168.1.1/', 'https://169.254.169.254/latest']) {
  await assert.rejects(strict.fetchPaid({ url: u, maxPrice: '1' }), /Only public hosts/, u);
}
const agent = await createAgent({ seed: '0x' + '44'.repeat(32), network: 'mainnet', stateDir, allowHttp: true });
await assert.rejects(agent.fetchPaid({ url: `${base}/priced`, maxPrice: '1' }), /asks 1.000123 USDG, above max_price 1 USDG. Nothing was paid/);
await assert.rejects(agent.fetchPaid({ url: `${base}/testnet`, maxPrice: '1' }), /for testnet; this agent is on mainnet/);
await assert.rejects(agent.fetchPaid({ url: `${base}/soon`, maxPrice: '1' }), /expires too soon to pay safely. Nothing was paid/);
await assert.rejects(agent.fetchPaid({ url: `${base}/huge402`, maxPrice: '1' }), /without a valid ZKdesk payment challenge/, 'a 2 MB 402 body is read only up to 16 KB');
// Re-review N-1 is checked with a real payment in scripts/ops/e2e-paywall.mjs (a service that breaks after
// the payment: fetchPaid returns paid and the request id instead of throwing).
await assert.rejects(agent.fetchPaid({ url: `${base}/bad`, maxPrice: '1' }), /without a valid ZKdesk payment challenge. Nothing was paid/);
await assert.rejects(agent.fetchPaid({ url: `${base}/move`, maxPrice: '1' }));
await assert.rejects(agent.fetchPaid({ url: 'file:///etc/passwd', maxPrice: '1' }), /Only https/);
await assert.rejects(agent.fetchPaid({ url: `${base}/free`, maxPrice: '1', method: 'DELETE' }), /GET or POST/);
const free = await agent.fetchPaid({ url: `${base}/free`, maxPrice: '1' });
assert.equal(free.status, 200);
assert.equal(free.paid, null);
assert.equal(free.untrustedBody.length, 65_536);
assert.equal(free.truncated, true);
await new Promise((ok) => { server.closeAllConnections(); server.close(ok); });

console.log('paywall checks passed: shared, file (restart) and Redis stores, unique amounts per challenge, payment after the challenge and of the exact amount, one payment per request, route and query binding, expiry and quarantined amounts, bounded challenges overall and per caller, monotonic head, never throws (400/503), one chain read under load; payer: https and public hosts only, price ceiling, expiry margin, challenge and network checks, no redirects, 16 KB 402 and 64 KB body caps');
