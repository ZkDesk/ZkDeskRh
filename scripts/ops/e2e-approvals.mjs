// Live dual control across members on Robinhood Chain testnet (the treasury from e2e-treasury.mjs).
// The Treasurer asks to pay 150 tUSDG (above the 100 threshold): a sealed request goes to the
// mailbox (no gas). The Owner lists and verifies it and approves on-chain; the Treasurer completes
// it. An outsider's ciphertext is ignored; completing before approval is refused.
// Usage: node scripts/ops/e2e-approvals.mjs [ledgerIdHex]
import { readFileSync } from 'node:fs';
import { createPublicClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { chain, deployment } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { createClient } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { default: relayHandler } = await import('../../api/relay.js');
const { default: requestsHandler } = await import('../../api/requests.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const mailbox = {
  list: (ledger) => call(requestsHandler, { method: 'GET', query: { ledger } }).then((r) => r.requests),
  post: (ledgerId, ciphertext) => call(requestsHandler, { method: 'POST', body: { ledgerId, ciphertext } }),
};
const publicClient = createPublicClient({ chain, transport: http() });
const provers = Object.fromEntries(await Promise.all(['ledger', 'role_auth'].map(async (k) => [k, await createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${k}.json`, 'utf8')))])));
const prove = (kind, witness) => provers[kind].prove(witness);
const member = (name, keys) => ({ name, keys, client: createClient({ publicClient, keys, prove, relay, requests: mailbox, onStatus: (m) => console.log(`    · ${name}: ${m}`) }) });
const owner = member('Owner', deriveKeys(await privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY).signTypedData(keyRequest(chain.id))));
const treasurer = member('Treasurer', deriveKeys('0x' + '01'.repeat(65))); // the e2e-treasury.mjs Treasurer
const usd = (x) => `${formatUnits(x, 6)} tUSDG`;
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms`); return r; };
const L = async (m) => {
  await m.client.sync();
  const all = m.client.ledgers();
  return process.argv[2] ? all.find((l) => l.owner === BigInt(process.argv[2])) : all.find((l) => l.name === 'E2E treasury' && l.roles.includes(m.name));
};

const lt = await L(treasurer);
if (!lt) throw new Error('No "E2E treasury" where the test Treasurer holds a role (run e2e-treasury.mjs first).');
console.log(`treasury ${'0x' + lt.owner.toString(16).slice(0, 10)}…: ${usd(treasurer.client.ledgerBalance(lt, deployment.usdg))} liquid, dual control above ${usd(lt.config.dualThreshold)}`);
await mailbox.post('0x' + lt.owner.toString(16).padStart(64, '0'), '0x' + 'ab'.repeat(80)); // an outsider's garbage

const r = await step('Treasurer asks to pay 150 tUSDG to itself (above the threshold)', async () => treasurer.client.ledgerAct(lt, 'Treasurer', { action: 'transfer', amount: 150_000000n, to: { owner: treasurer.keys.owner, encPub: treasurer.keys.encPub } }));
if (!r.requested) throw new Error('expected a request');
const seen = await owner.client.ledgerRequests(await L(owner));
const pending = seen.find((x) => x.intent === r.intent);
console.log(`  Owner sees ${seen.length} valid request(s) (garbage dropped); this one: ${pending?.status}, ${usd(pending.amount)} by ${pending.role}`);
try {
  await treasurer.client.completeRequest(await L(treasurer), (await treasurer.client.ledgerRequests(await L(treasurer))).find((x) => x.intent === r.intent));
  throw new Error('completed before approval');
} catch (error) {
  console.log(`  ✓ refused before approval: ${error.message}`);
}
await step('Owner approves the exact transfer on-chain', async () => owner.client.approveRequest(await L(owner), pending));
const approved = (await treasurer.client.ledgerRequests(await L(treasurer))).find((x) => x.intent === r.intent);
console.log(`  Treasurer sees: ${approved.status}`);
const before = treasurer.client.balance(deployment.usdg);
await step('Treasurer completes the approved transfer', async () => treasurer.client.completeRequest(await L(treasurer), approved));
await treasurer.client.sync();
const done = (await treasurer.client.ledgerRequests(await L(treasurer))).find((x) => x.intent === r.intent);
console.log(`  status: ${done.status}; Treasurer personal tUSDG ${usd(before)} -> ${usd(treasurer.client.balance(deployment.usdg))}`);
await Promise.all(Object.values(provers).map((p) => p.destroy()));
process.exitCode = done.status === 'Completed' ? 0 : 1;
