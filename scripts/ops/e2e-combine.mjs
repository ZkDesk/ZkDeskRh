// Combine notes acceptance through the shared client, the real relayer handler and the real cron
// handler (in-process with .env.local): three deposits make three notes; combine() merges them into
// one, paying one relay fee per merge, so an amount larger than any two notes can be sent in one step.
// Usage: node scripts/ops/e2e-combine.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { chain, deployment, payableFee } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { createClient } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { default: relayHandler } = await import('../../api/relay.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const tick = () => call(tickHandler, { method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const transport = http(process.env.RPC_URL_SERVER || undefined);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
// A fresh account each run, so the note count starts at zero.
const keys = deriveKeys(await privateKeyToAccount('0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')).signTypedData(keyRequest(chain.id)));
const prover = await createProver(JSON.parse(readFileSync('src/lib/zk/artifacts/transact.json', 'utf8')));
const client = createClient({ publicClient, walletClient, address: account.address, keys, prove: (_, w) => prover.prove(w), relay, onStatus: (m) => console.log(`    · ${m}`) });

const USDG = deployment.usdg;
const usd = (x) => `${formatUnits(x, 6)} USDG`;
const mine = () => client.notes().filter((n) => n.status === 'unspent' && n.asset === BigInt(USDG));
const step = async (name, fn) => { console.log(`▶ ${name}`); const r = await fn(); console.log('  ✓'); return r; };

// Amounts in units u of at least three relay fees: notes 4u, 3u, 2u; a send of 8u needs all three.
const fee = payableFee(BigInt((await relay(null)).minFee));
const u = fee * 3n > 10n ** 6n ? fee * 3n : 10n ** 6n;
console.log(`relay fee ${usd(fee)}, unit ${usd(u)}`);
await step('three deposits of 4u, 3u and 2u', async () => { for (const a of [4n, 3n, 2n]) await client.deposit(USDG, a * u); });
await step(`wait standby (${deployment.standbySeconds}s), then cron clears`, async () => {
  await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 15) * 1000));
  for (let i = 0; i < 10 && (await client.sync(), mine().length < 3); i++) { await tick(); await new Promise((r) => setTimeout(r, 10_000)); }
});
const before = mine();
console.log(`  notes: ${before.map((n) => usd(n.amount)).join(', ')}`);
if (before.length !== 3) throw new Error(`expected 3 notes, got ${before.length}`);
const total = before.reduce((t, n) => t + n.amount, 0n);
await step('sending 8u (more than any two notes) is refused before combining', async () => {
  const error = await client.send({ amount: 8n * u, to: { owner: keys.owner, encPub: keys.encPub } }).then(() => null, (e) => e);
  if (!/Combine them first/.test(error?.message ?? '')) throw new Error(`expected the combine hint, got: ${error?.message}`);
});
const merges = await step('combine', () => client.combine(USDG));
await client.sync();
const after = mine();
const fees = total - after.reduce((t, n) => t + n.amount, 0n);
console.log(`  merges: ${merges}; notes: ${after.map((n) => usd(n.amount)).join(', ')}; fees paid: ${usd(fees)}`);
if (merges !== 2 || after.length !== 1) throw new Error('expected two merges into one note');
if ((await client.combine(USDG)) !== 0) throw new Error('combine with one note left must do nothing');
await step('send 8u in one step', () => client.send({ amount: 8n * u, to: { owner: keys.owner, encPub: keys.encPub } }));
console.log('combine passed: three notes merged into one, then one send for more than any two original notes');
await prover.destroy();
process.exit(0);
