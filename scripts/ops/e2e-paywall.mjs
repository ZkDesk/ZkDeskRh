// Pay-per-call acceptance (agent/paywall.mjs + fetchPaid) against a running ZKdesk site and chain:
// a service puts an HTTP endpoint behind a 0.5 tUSDG paywall with its own account; a funded agent fetches
// it, gets 402, pays privately and is served; the request id is single-use and the next call pays again;
// a max_price below the price pays nothing; and a deposit of the exact amount, still in screening (its
// sender could take it back), does not unlock a challenge. A service that drops the connection after
// the payment: fetchPaid keeps retrying and is served, and if it never is, returns what it paid and the
// request id instead of throwing (so the model does not pay twice).
// Usage: RPC_URL_SERVER=<rpc> DB_SCHEMA=<schema> node scripts/ops/e2e-paywall.mjs <siteUrl>
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const site = process.argv[2] ?? 'http://localhost:5199';
const RPC = process.env.RPC_URL_SERVER || undefined;
const { createAgent, newSeed } = await import('../../agent/index.mjs');
const { createPaywall } = await import('../../agent/paywall.mjs');
const opts = { network: 'testnet', api: site, rpc: RPC, allowHttp: true, stateDir: (await import('node:os')).tmpdir() };
const service = await createAgent({ seed: newSeed(), ...opts });
const agent = await createAgent({ seed: newSeed(), ...opts, maxPerTx: '5' });
const { chain, deployment, apiBase } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest, parseZkAddress } = await import('../../src/lib/zk/keys.js');
const { createClient } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { createTransport } = await import('../../src/lib/zk/transport.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const provers = {};
const prove = async (kind, w) => (await (provers[kind] ??= createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${kind}.json`, 'utf8'))))).prove(w);
const { relay, mailbox } = createTransport(`${site}${apiBase}`);
const owner = createClient({ publicClient, walletClient, address: account.address, keys: deriveKeys(await account.signTypedData(keyRequest(chain.id))), prove, relay, requests: mailbox });
const mine = () => (RPC?.includes('127.0.0.1') ? publicClient.request({ method: 'anvil_mine', params: ['0x40'] }) : null);
const tick = () => new Promise((resolve) => tickHandler({ method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, { statusCode: 200, setHeader() {}, end: resolve }));
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms`); return r; };
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ✓ ${what}`); };

// The paid API: one JSON answer per payment.
const paywall = createPaywall({ agent: service, price: '0.5', origin: site, recheckMs: 2000 });
let served = 0;
let drops = 0;
const api = createServer(async (req, res) => {
  // /flaky drops the first two paid retries; /broken drops every one.
  if (req.headers['x-zkdesk-request'] && (req.url === '/broken' || (req.url === '/flaky' && drops++ < 2))) return req.socket.destroy();
  if (!(await paywall.guard(req, res))) return;
  served++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ answer: 42, served }));
});
await new Promise((ok) => api.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${api.address().port}/answer`;

try {
  await owner.sync();
  if (owner.balance(deployment.usdg) < 200_000000n) {
    await step('Owner deposits 1000 tUSDG privately', async () => {
      await owner.deposit(deployment.usdg, 1000_000000n);
      await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 5) * 1000));
      for (let i = 0; i < 10; i++) { await mine(); await tick(); await owner.sync(); if (owner.balance(deployment.usdg) >= 1000_000000n) return; await new Promise((r) => setTimeout(r, 8000)); }
      throw new Error('deposit did not clear');
    });
  }
  await step('Owner funds the agent with 150 tUSDG', () => owner.send({ amount: 150_000000n, to: parseZkAddress(agent.address) }));

  const low = await agent.fetchPaid({ url, maxPrice: '0.4' }).then(() => 'paid', (e) => e.message);
  check(/above max_price.*Nothing was paid/.test(low), `max_price below the price pays nothing (${low.slice(0, 60)}…)`);

  const first = await step('Agent fetches the paid API', () => agent.fetchPaid({ url, maxPrice: '1' }));
  console.log(`  status ${first.status}, paid ${first.paid?.amount}, body ${first.untrustedBody}`);
  check(first.status === 200 && JSON.parse(first.untrustedBody).served === 1 && Number(first.paid.amount) > 0.5 && Number(first.paid.amount) < 0.51, 'paid its unique amount and was served');
  const got = (await service.payments({ since: 0 })).map((p) => p.raw);
  check(got.includes(parseUnits(first.paid.amount, 6)), 'the service received exactly that amount');

  const second = await step('Agent fetches again', () => agent.fetchPaid({ url, maxPrice: '1' }));
  check(second.status === 200 && JSON.parse(second.untrustedBody).served === 2 && second.paid.amount !== first.paid.amount, 'each call pays its own challenge');

  // A deposit of the exact amount, still in screening, does not unlock a challenge.
  const challenge = await fetch(url).then((r) => r.json());
  await step('Owner deposits exactly the challenge amount to the service (stays in screening)', () => owner.deposit(deployment.usdg, parseUnits(challenge.zkdesk.amount, 6), parseZkAddress(service.address)));
  await mine();
  const blocked = await new Promise((r) => setTimeout(r, 2500)).then(() => fetch(url, { headers: { 'x-zkdesk-request': challenge.zkdesk.requestId } }));
  check(blocked.status === 402 && (await blocked.json()).pending === true, 'a screened deposit does not unlock the API');
  check(served === 2, 'served exactly twice');

  const flaky = await step('Agent fetches a service that drops the first two retries after the payment', () => agent.fetchPaid({ url: url.replace('/answer', '/flaky'), maxPrice: '1', timeoutSeconds: 30 }));
  check(flaky.status === 200 && flaky.paid?.confirmed, 'it kept retrying and was served');
  const broken = await step('Agent fetches a service that never answers after the payment', () => agent.fetchPaid({ url: url.replace('/answer', '/broken'), maxPrice: '1', timeoutSeconds: 8 }));
  check(broken.status === null && broken.paid?.confirmed && /^[A-Za-z0-9_-]{24}$/.test(broken.requestId) && /Do not pay again/.test(broken.message), 'no throw: it reports what it paid and the request id');
  console.log('Paywall e2e passed.');
} finally {
  api.close();
}
process.exit(0);
