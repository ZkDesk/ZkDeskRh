// Live M2 acceptance on Robinhood Chain testnet through the shared client, the real relayer
// handler and the real cron handler (all in-process with .env.local).
// Usage: node scripts/ops/e2e-credit.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { chain, deployment, abis, payableFee } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { createClient, debtOf } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { default: relayHandler } = await import('../../api/relay.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const tick = () => call(tickHandler, { method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const walletClient = createWalletClient({ account, chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const keys = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const provers = { transact: await createProver(JSON.parse(readFileSync('src/lib/zk/artifacts/transact.json', 'utf8'))), position: await createProver(JSON.parse(readFileSync('src/lib/zk/artifacts/position.json', 'utf8'))) };
const prove = (kind, witness) => provers[kind].prove(witness);
const client = createClient({ publicClient, walletClient, address: account.address, keys, prove, relay, onStatus: (m) => console.log(`    · ${m}`) });

const SPY = deployment.stocks.tSPY.token;
const usd = (x) => `${formatUnits(x, 6)} tUSDG`;
const spy = (x) => `${formatUnits(x, 18)} tSPY`;
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms${r?.txHash ? ` ${r.txHash}` : ''}`); return r; };
const show = async () => {
  await client.sync();
  const pos = client.positions();
  const index = await publicClient.readContract({ address: deployment.desk, abi: abis.desk, functionName: "index" });
  const list = pos.map((p) => `slot ${p.slot} ${spy(p.collateral)} debt ${usd(debtOf(p.debtScaled, index))}`).join("; ") || "none";
  console.log(`  private: ${usd(client.balance(deployment.usdg))}, ${spy(client.balance(SPY))}, ${formatUnits(client.balance(deployment.lending), 12)} shares; positions: ${list}`);
  return pos;
};

await step('deposit 2000 tUSDG + 12 tSPY from wallet', async () => { await client.deposit(deployment.usdg, 2000_000000n); await client.deposit(SPY, 12n * 10n ** 18n); });
await step(`wait standby (${deployment.standbySeconds}s), then cron clears`, async () => {
  await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 15) * 1000));
  for (let i = 0; i < 6; i++) { const t = await tick(); console.log(`    · cron: cleared ${JSON.stringify(t.cleared)}`); await client.sync(); if (client.balance(SPY) > 0n && client.balance(deployment.usdg) > 0n) break; await new Promise((r) => setTimeout(r, 15000)); }
});
await show();
await step('lend 500 tUSDG privately', () => client.lend(500_000000n));
await show();
await step('open: 10 tSPY collateral, borrow 1000 tUSDG', () => client.credit({ symbol: 'tSPY', collIn: 10n * 10n ** 18n, draw: 1000_000000n }));
let [pos] = await show();
await step('repay 400 tUSDG', () => client.credit({ symbol: 'tSPY', position: pos, repay: 400_000000n }));
[pos] = await show();
await step('add 2 tSPY collateral', () => client.credit({ symbol: 'tSPY', position: pos, collIn: 2n * 10n ** 18n }));
[pos] = await show();
await step('withdraw 3 tSPY collateral', () => client.credit({ symbol: 'tSPY', position: pos, collOut: 3n * 10n ** 18n }));
[pos] = await show();
const index = await publicClient.readContract({ address: deployment.desk, abi: abis.desk, functionName: 'index' });
await step(`close: repay ${usd(debtOf(pos.debtScaled, index))}, all collateral back`, () => client.credit({ symbol: 'tSPY', position: pos, repay: debtOf(pos.debtScaled, index), collOut: pos.collateral }));
await show();
await step('redeem all lender shares privately (minus the relay fee)', async () => client.redeem(client.balance(deployment.lending) - payableFee((await relay(null)).fees[deployment.lending.toLowerCase()])));
await show();
const t = await tick();
console.log(`cron after: indexed ${JSON.stringify(t.indexed)}`);
await provers.transact.destroy(); await provers.position.destroy();
process.exit(0);
