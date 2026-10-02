// V39 N-A acceptance (contract set v3.3) with real proofs: two tNVDA positions breach together and are
// planned into one sealed batch; right after the epoch's snapshot one of them cures (adds collateral, at
// the current index). The batch is skipped on-chain because that slot changed, and the desk cron must
// re-plan the other position and liquidate it in the same epoch, instead of letting it escape for an
// epoch. Also checks that a step keeping a position open is refused at the previous rate index.
// Real relayer, desk and cron handlers in-process with .env.local. Restores the tNVDA price at the end.
// Usage (a fork or testnet on v3.3): RPC_URL_SERVER=<rpc> DB_SCHEMA=<schema> node scripts/ops/e2e-replan.mjs
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
const { createClient, maxDebt } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { default: relayHandler } = await import('../../api/relay.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');
const { runDesk } = await import('../../api/cron/desk.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const tick = () => call(tickHandler, { method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

const RPC = process.env.RPC_URL_SERVER || undefined;
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const keys = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const circuit = (name) => JSON.parse(readFileSync(`src/lib/zk/artifacts/${name}.json`, 'utf8'));
const provers = Object.fromEntries(await Promise.all(['transact', 'position', 'health_epoch', 'liquidate'].map(async (k) => [k, await createProver(circuit(k))])));
const prove = (kind, witness) => provers[kind].prove(witness);
const client = createClient({ publicClient, walletClient, address: account.address, keys, prove, relay, onStatus: (m) => console.log(`    · ${m}`) });
const mine = () => (RPC?.includes('127.0.0.1') ? publicClient.request({ method: 'anvil_mine', params: ['0x40'] }) : null);

const NVDA = deployment.stocks.tNVDA.token;
const FEED = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const E18 = 10n ** 18n;
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms`); return r; };
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ✓ ${what}`); };
async function funded(asset, amount) {
  await client.sync();
  if (client.balance(asset) >= amount) return;
  await client.deposit(asset, amount);
  await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 5) * 1000));
  for (let i = 0; i < 10; i++) { await mine(); await tick(); await client.sync(); if (client.balance(asset) >= amount) return; await new Promise((r) => setTimeout(r, 8000)); }
  throw new Error('deposit did not clear');
}
const [, startPrice] = await publicClient.readContract({ address: deployment.stocks.tNVDA.feed, abi: FEED, functionName: 'latestRoundData' });

try {
  await step('fund: 40 tNVDA and 8000 tUSDG privately, supply 5000 to the credit pool', async () => {
    await funded(NVDA, 40n * E18);
    await funded(deployment.usdg, 8000_000000n);
    await client.lend(5000_000000n);
  });
  const m = await client.market('tNVDA');
  const draw = (maxDebt(10n * E18, m.mark, m.ltvBps) * 999n) / 1000n;
  await step('open A and B: 10 tNVDA each at the LTV limit', async () => {
    await client.credit({ symbol: 'tNVDA', collIn: 10n * E18, draw });
    await client.credit({ symbol: 'tNVDA', collIn: 10n * E18, draw });
  });
  await client.sync();
  const [A, B] = client.positions().filter((p) => p.symbol === 'tNVDA' && !p.liquidated.length).sort((a, b) => a.slot - b.slot);
  console.log(`  A slot ${A.slot}, B slot ${B.slot}`);

  // A checkpoint first, so the cure below must prove at the new index (the previous one is refused for
  // a step that keeps a position open: contracts/test/V32.t.sol test_v33_openStepNeedsTheCurrentIndex).
  await step('a rate checkpoint (accrue)', async () => {
    if (RPC?.includes('127.0.0.1')) await publicClient.request({ method: 'evm_increaseTime', params: [601] });
    await mine();
    const hash = await walletClient.writeContract({ address: deployment.desk, abi: abis.desk, functionName: 'accrue' });
    await publicClient.waitForTransactionReceipt({ hash });
    const [index, prev] = await Promise.all(['index', 'prevIndex'].map((f) => publicClient.readContract({ address: deployment.desk, abi: abis.desk, functionName: f })));
    check(index !== prev, 'the index moved');
  });

  await step('tNVDA -40%: both breach', async () => console.log(execFileSync('node', ['scripts/ops/set-price.mjs', 'tNVDA', '-40%'], { encoding: 'utf8' })));
  // The cure happens between the snapshot and the epoch transaction: the desk proves the batch after it
  // took the snapshot, so cure A then.
  let cured = false;
  const hooked = async (kind, witness) => {
    if (kind === 'liquidate' && !cured) {
      cured = true;
      console.log('    · cure: A adds 15 tNVDA right after the snapshot');
      await client.sync();
      const a = client.positions().find((p) => p.slot === A.slot);
      await client.credit({ symbol: 'tNVDA', position: a, collIn: 15n * E18 });
    }
    return prove(kind, witness);
  };
  const report = await step('desk epoch', () => runDesk({ operatorSk: BigInt(process.env.DESK_OPERATOR_SK), prove: hooked, log: (m2) => console.log(`    · desk: ${m2}`) }));
  console.log(`  breached ${json(report.breached)}; batches ${json(report.batches.map((b) => ({ slots: b.slots, error: b.error })))}; replanned ${json(report.replanned?.map((r) => ({ slots: r.slots, hash: r.hash, error: r.error })))}`);
  check(report.breached.includes(A.slot) && report.breached.includes(B.slot), 'the epoch committed both breaches');
  check(cured, 'A cured after the snapshot');
  const again = report.replanned?.find((r) => r.slots.includes(B.slot));
  check(again && again.hash && !again.slots.includes(A.slot), 'the skipped batch was re-planned without A and sent');
  await client.sync();
  const b = client.positions().find((p) => p.slot === B.slot);
  const a = client.positions().find((p) => p.slot === A.slot);
  check(b === undefined || b.liquidated.length > 0, 'B was liquidated in the same epoch');
  check(a && !a.liquidated.length && a.collateral === 25n * E18, 'A, cured, kept its 25 tNVDA');
} finally {
  console.log(execFileSync('node', ['scripts/ops/set-price.mjs', 'tNVDA', formatUnits(startPrice, 8)], { encoding: 'utf8' }));
  await Promise.all(Object.values(provers).map((p) => p.destroy()));
}
process.exit(0);
