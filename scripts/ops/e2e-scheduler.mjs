// Live unattended mandate payments (opt-in scheduler) on Robinhood Chain testnet, using the
// "Payroll e2e" treasury from e2e-mandates.mjs: the Owner makes the ZKDesk scheduler its Payer and
// commits a weekly 10 tUSDG mandate to Rita; one scheduler run pays period 0; a second run finds
// nothing due. Runs the real cron logic (api/cron/pulls.js) in-process.
// Usage: node scripts/ops/e2e-scheduler.mjs
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
const { runPulls } = await import('../../api/cron/pulls.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const provers = Object.fromEntries(await Promise.all(['transact', 'role_auth', 'mandate_auth', 'mandate_pull'].map(async (k) => [k, await createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${k}.json`, 'utf8')))])));
const prove = (kind, witness) => provers[kind].prove(witness);
const ownerKeys = deriveKeys(await privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY).signTypedData(keyRequest(chain.id)));
const owner = createClient({ publicClient, keys: ownerKeys, prove, relay, onStatus: (m) => console.log(`    · Owner: ${m}`) });
const rita = createClient({ publicClient, keys: deriveKeys('0x' + '0c'.repeat(65)), prove, relay });
const scheduler = deriveKeys(process.env.SCHEDULER_SEED);
const zk = /^zkd:([0-9a-f]{64})([0-9a-f]{64})$/i.exec(deployment.scheduler);
const schedulerAddr = { owner: BigInt('0x' + zk[1]), encPub: Uint8Array.from(zk[2].match(/../g).map((b) => parseInt(b, 16))) };
if (schedulerAddr.owner !== scheduler.owner) throw new Error('deployments.scheduler does not match SCHEDULER_SEED');
const usd = (x) => `${formatUnits(x, 6)} tUSDG`;
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms`); return r; };
const L = async () => { await owner.sync(); return owner.ledgers().find((l) => l.name === 'Payroll e2e'); };
const now = Math.floor(Date.now() / 1000);

let ledger = await L();
if (!ledger) throw new Error('No "Payroll e2e" treasury (run e2e-mandates.mjs first).');
console.log(`treasury liquid ${usd(owner.ledgerBalance(ledger, deployment.usdg))}`);
if (ledger.config.payer !== scheduler.owner) await step('Owner makes the ZKDesk scheduler the Payer', () => owner.updateLedger(ledger, { payer: schedulerAddr }));
ledger = await L();
await step('Owner commits a weekly 10 tUSDG mandate to Rita', () => owner.createMandate(ledger, 'Owner', { kind: 'Payroll', to: { owner: rita.keys?.owner ?? deriveKeys('0x' + '0c'.repeat(65)).owner, encPub: deriveKeys('0x' + '0c'.repeat(65)).encPub }, label: 'Rita · weekly (scheduled)', cap: 10_000000n, period: 'Weekly', expiry: now + 30 * 86400 }));
await rita.sync();
const before = rita.balance(deployment.usdg);
const schedulerProve = async (kind, witness) => prove(kind, witness);
const first = await step('scheduler run 1 (cron logic)', () => runPulls({ keys: scheduler, prove: schedulerProve, log: (m) => console.log(`    · scheduler: ${m}`) }));
console.log(`  ${JSON.stringify(first)}`);
const second = await step('scheduler run 2: nothing due', () => runPulls({ keys: scheduler, prove: schedulerProve }));
console.log(`  ${JSON.stringify(second)}`);
await rita.sync();
console.log(`  Rita private tUSDG ${usd(before)} -> ${usd(rita.balance(deployment.usdg))}`);
await Promise.all(Object.values(provers).map((p) => p.destroy()));
process.exitCode = first.paid.length >= 1 && second.paid.length === 0 && second.failed.length === 0 ? 0 : 1;
