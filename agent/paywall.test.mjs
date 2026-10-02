// node agent/paywall.test.mjs — the paywall's rules with a stand-in service account, and the paying
// side's refusals against a local server. No chain access: nothing here pays.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnits } from 'viem';
import { createPaywall, socketClient } from './paywall.mjs';
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
assert.throws(() => createPaywall({ agent: fake, price: '1', maxOpen: 5000 }), /maxOpen/);
// Re-review N-3: an IPv6 caller is keyed by its /64; a mapped IPv4 address by the IPv4 one.
assert.equal(socketClient({ socket: { remoteAddress: '2001:db8:1:2:aaaa::1' } }), socketClient({ socket: { remoteAddress: '2001:db8:1:2:ffff::9' } }));
assert.equal(socketClient({ socket: { remoteAddress: '::ffff:9.9.9.9' } }), '9.9.9.9');
// Re-review info: IPv6 forms that hide a private IPv4 address, and site-local ones.
for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:a00:1::', 'fec0::1', 'fe80::1%eth0', 'fd00::1', '::1', '::']) assert.ok(isPrivateAddress(ip), ip);
for (const ip of ['2606:4700::1111', '8.8.8.8', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::']) assert.ok(!isPrivateAddress(ip), ip);
const wall = createPaywall({ agent: fake, price: '0.25', now, recheckMs: 0, perClient: 100 });

// Review H-1: guard never throws. A URL Node accepts but URL() rejects is a 400; a failing chain read a 503.
assert.equal((await call(wall, null, 'http://a:99999/x')).status, 400);
const broken = createPaywall({ agent: { ...fake, head: async () => { throw new Error('The network RPC is behind'); } }, price: '1', now });
assert.equal((await call(broken)).status, 503);

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

// Expiry, unknown ids, and the bound on open challenges.
t += 300_000;
assert.equal((await call(wall, second.requestId)).body.zkdesk.requestId === second.requestId, false, 'an expired challenge is gone');
assert.equal((await call(wall, 'not-a-real-id')).status, 402);
const small = createPaywall({ agent: fake, price: '1', now, maxOpen: 3, recheckMs: 0 });
for (let i = 0; i < 3; i++) assert.equal((await call(small, null, '/answer', 'GET', `9.9.9.${i}`)).status, 402);
assert.equal((await call(small, null, '/answer', 'GET', '9.9.9.9')).status, 503, 'open challenges are bounded');
// Review M-2: one caller holds at most perClient open challenges; others are not locked out by it.
const fair = createPaywall({ agent: fake, price: '1', now, perClient: 5, recheckMs: 0 });
for (let i = 0; i < 5; i++) assert.equal((await call(fair, null, '/answer', 'GET', '6.6.6.6')).status, 402);
assert.equal((await call(fair, null, '/answer', 'GET', '6.6.6.6')).status, 503, 'per-client bound');
assert.equal((await call(fair, null, '/answer', 'GET', '7.7.7.7')).status, 402, 'another caller still gets a challenge');

// Review L-1: an amount freed by an expired challenge stays reserved for another ttl.
{
  const one = createPaywall({ agent: fake, price: '1', now, perClient: 10_000, maxOpen: 4000, recheckMs: 0 });
  const expired = parseUnits((await call(one)).body.zkdesk.amount, 6);
  t += 300_000;
  const fresh = await Promise.all([...Array(3999)].map(() => call(one).then((r) => r.body.zkdesk && parseUnits(r.body.zkdesk.amount, 6))));
  assert.ok(!fresh.includes(expired), 'a late payment for an expired challenge cannot match a new one');
}
// Re-review N-2: when nearly every amount is reserved, a new challenge is a 503, never a hang.
{
  const full = createPaywall({ agent: fake, price: '1', now, perClient: 10_000, maxOpen: 4000, recheckMs: 0 });
  await Promise.all([...Array(4000)].map(() => call(full)));
  t += 300_000; // all 4,000 expire and stay reserved for another ttl
  const more = await Promise.all([...Array(4000)].map(() => call(full).then((r) => r.status)));
  assert.ok(more.every((s) => s === 402 || s === 503), 'no hang');
  const after = await call(full);
  assert.equal(after.status, 503, 'all open: busy');
}
// Review L-2: the head never goes back (a lagging RPC node), so a used payment cannot be reopened.
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
const many = createPaywall({ agent: fake, price: '1', now, maxOpen: 2000, recheckMs: 60_000, perClient: 1000 });
syncs = 0;
const issued = await Promise.all([...Array(500)].map(() => call(many).then((r) => r.body.zkdesk)));
assert.equal(new Set(issued.map((x) => x.amount)).size, 500, 'unique amounts');
assert.ok(syncs <= 2, `one chain read for 500 challenges (${syncs})`);
// Review M-1: concurrent retries of challenges with different start blocks share one payments read.
syncs = 0;
await Promise.all(issued.slice(0, 200).map((x) => call(many, x.requestId)));
assert.ok(syncs <= 1, `one payments read for 200 concurrent retries (${syncs})`);

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

console.log('paywall checks passed: unique amounts per challenge, payment after the challenge and of the exact amount, one payment per request, route and query binding, expiry and quarantined amounts, bounded challenges overall and per caller, monotonic head, never throws (400/503), one chain read under load; payer: https and public hosts only, price ceiling, expiry margin, challenge and network checks, no redirects, 16 KB 402 and 64 KB body caps');
