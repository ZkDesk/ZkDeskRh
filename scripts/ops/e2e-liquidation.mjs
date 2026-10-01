// Live M3 acceptance on Robinhood Chain testnet: a private tNVDA position at the LTV limit, an epoch
// with no breach, tNVDA -40%, an epoch that commits the breach, a sealed batch that liquidates it,
// then the owner finds the liquidated state and closes it. Real relayer, desk and cron handlers
// run in-process with .env.local. Restores the tNVDA price at the end.
// Usage: node scripts/ops/e2e-liquidation.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, formatUnits, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { chain, deployment, abis } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { createClient, debtOf, maxDebt } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { default: relayHandler } = await import('../../api/relay.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');
const { runDesk } = await import('../../api/cron/desk.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const tick = () => call(tickHandler, { method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ account, chain, transport: http() });
const keys = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const circuit = (name) => JSON.parse(readFileSync(`src/lib/zk/artifacts/${name}.json`, 'utf8'));
const provers = Object.fromEntries(await Promise.all(['transact', 'position', 'health_epoch', 'liquidate'].map(async (k) => [k, await createProver(circuit(k))])));
const prove = (kind, witness) => provers[kind].prove(witness);
const client = createClient({ publicClient, walletClient, address: account.address, keys, prove, relay, onStatus: (m) => console.log(`    · ${m}`) });
const desk = () => runDesk({ operatorSk: BigInt(process.env.DESK_OPERATOR_SK), prove, log: (m) => console.log(`    · desk: ${m}`) });

const NVDA = deployment.stocks.tNVDA.token;
const FEED = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const usd = (x) => `${formatUnits(x, 6)} tUSDG`;
const nv = (x) => `${formatUnits(x, 18)} tNVDA`;
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms`); return r; };
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const [, startPrice] = await publicClient.readContract({ address: deployment.stocks.tNVDA.feed, abi: FEED, functionName: 'latestRoundData' });
console.log(`tNVDA feed $${formatUnits(startPrice, 8)}; market open: ${await publicClient.readContract({ address: deployment.marker, abi: abis.marker, functionName: 'marketOpen' })}`);

try {
  await client.sync();
  if (client.balance(NVDA) < 10n * 10n ** 18n) {
    await step('deposit 10 tNVDA from wallet', () => client.deposit(NVDA, 10n * 10n ** 18n));
    await step(`wait standby (${deployment.standbySeconds}s), then cron clears`, async () => {
      await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 15) * 1000));
      for (let i = 0; i < 6; i++) { await tick(); await client.sync(); if (client.balance(NVDA) >= 10n * 10n ** 18n) break; await new Promise((r) => setTimeout(r, 15000)); }
    });
  }
  const m = await client.market('tNVDA');
  const draw = (maxDebt(10n * 10n ** 18n, m.mark, m.ltvBps) * 999n) / 1000n;
  await step(`open: 10 tNVDA at $${formatUnits(m.mark, 8)}, borrow ${usd(draw)} (≈45% LTV)`, () => client.credit({ symbol: 'tNVDA', collIn: 10n * 10n ** 18n, draw }));
  await client.sync();
  const [before] = client.positions().filter((p) => p.symbol === 'tNVDA');
  console.log(`  position: slot ${before.slot}, ${nv(before.collateral)}, debt ${usd(debtOf(before.debtScaled, m.index))}`);

  const e1 = await step('desk epoch (no breach expected)', desk);
  console.log(`  attest ${e1.attest.hash} gas ${e1.attest.gas}; breached ${json(e1.breached)}; prove ${e1.proveMs} ms`);
  if (e1.breached.includes(before.slot)) throw new Error('breached before the price move');

  await step('tNVDA -40%', async () => console.log(execFileSync('node', ['scripts/ops/set-price.mjs', 'tNVDA', '-40%'], { encoding: 'utf8' })));
  const e2 = await step('desk epoch: breach + sealed batch', desk);
  console.log(`  attest ${e2.attest.hash}; breached ${json(e2.breached)}; batches ${json(e2.batches)}`);
  await client.sync();
  // The production desk cron may have run the same batch first; either way the owner must see it.
  const after = client.positions().find((p) => p.slot === before.slot);
  if (!after?.liquidated.length) throw new Error('position was not liquidated');
  const index = await publicClient.readContract({ address: deployment.desk, abi: abis.desk, functionName: 'index' });
  console.log(`  owner sees: ${nv(after.collateral)} left, debt ${usd(debtOf(after.debtScaled, index))}; sold ${nv(after.liquidated[0].sold)}`);
  await step(`close: ${nv(after.collateral)} back`, () => client.credit({ symbol: 'tNVDA', position: after, collOut: after.collateral, repay: debtOf(after.debtScaled, index) }));
  await client.sync();
  if (client.positions().some((p) => p.slot === before.slot)) throw new Error('position still open');
  const t = await tick();
  console.log(`cron after: indexed ${json(t.indexed)}`);
} finally {
  console.log(execFileSync('node', ['scripts/ops/set-price.mjs', 'tNVDA', formatUnits(startPrice, 8)], { encoding: 'utf8' }));
  await Promise.all(Object.values(provers).map((p) => p.destroy()));
}
process.exit(0);
