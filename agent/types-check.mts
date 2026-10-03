// Compiled (never run) by `pnpm test:types`: the declarations parse and read as the README shows them.
import { createServer } from 'node:http';
import { createAgent, newSeed, type Agent, type Payment } from './index.mjs';
import { createPaywall, fileStore, memoryStore, redisStore, type RedisLike } from './paywall.mjs';

const agent: Agent = await createAgent({ seed: newSeed(), network: 'testnet', maxPerTx: '5', allowTo: ['zkd:00'] });
const { usdg, notes } = await agent.balance();
const sent: Payment = await agent.send({ to: agent.address, amount: usdg });
if (sent.confirmed) sent.tx.toUpperCase();
else sent.status.toUpperCase();
const r = await agent.fetchPaid({ url: 'https://api.example/answer', maxPrice: '0.5' });
if (r.status === null) r.requestId.toUpperCase();
else r.untrustedBody.slice(0, notes);
const waited = await agent.waitForPayment({ amount: '1' });
if (waited.received) waited.tx.toUpperCase();
if (waited.pending) waited.amount.toUpperCase();
const paidLink = await agent.payLink(await agent.requestLink({ amount: '1' }));
if (paidLink.confirmed) paidLink.tx.toUpperCase();
else if ('requested' in paidLink) paidLink.message.toUpperCase();
const merged = await agent.combine({ target: '100' });
if ('message' in merged) merged.message.toUpperCase();
else if (!merged.reached) merged.stopped?.toUpperCase();
const posted = await agent.fetchPaid({ url: 'https://api.example/q', maxPrice: '1', method: 'POST', body: { q: 1 } });
if (posted.paid) posted.paid.tx.toUpperCase();
const [t] = await agent.treasuries();
const report = await agent.spending(t.id, { since: '2026-10-01', all: true });
for (const p of report.payments) if (p.by === 'payer' && p.to) p.to.toUpperCase();
// @ts-expect-error since is a date or unix seconds
await agent.spending(t.id, { since: true });
if (t.payerLimits?.leftThisPeriod) t.payerLimits.leftThisPeriod.toUpperCase();
if (t.payerLimits && !t.payerLimits.accessEnded) t.payerLimits.accessEnds?.slice(0, 10);
// @ts-expect-error payerLimits may be null
t.payerLimits.budget;
const requested = await agent.pay(t.id, { to: agent.address, amount: '2' });
if (!requested.confirmed && 'requested' in requested) (await agent.requests(t.id)).filter((x) => x.status === 'Approved');
// @ts-expect-error a GET has no body
await agent.fetchPaid({ url: 'https://api.example/q', maxPrice: '1', body: { q: 1 } });
await agent.verifyReceipt(await agent.proveReceipt((await agent.receipts())[0].id));

declare const redis: RedisLike;
const walls = [
  createPaywall({ agent, price: '0.25' }),
  createPaywall({ agent, price: '0.25', store: fileStore('./paywall.json') }),
  createPaywall({ agent, price: '0.25', store: redisStore(redis, { prefix: 'svc:' }), clientOf: (req) => String(req.headers['x-real-ip']) }),
  createPaywall({ agent, price: '0.25', store: memoryStore() }),
];
createServer(async (req, res) => {
  if (await walls[0].guard(req, res)) res.end('the paid answer');
});
