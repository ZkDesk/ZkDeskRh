// Moving a treasury to new keys (3.21), end to end: a treasury with an agent (limits and an access end),
// USDG in several notes, vault shares, a payments-without-approval limit and three mandates: one the agent
// was paid once, one paused, one the Owner leaves behind. The Owner moves it to new keys with a new agent
// key and a new Treasurer; the move is interrupted twice (after the new treasury is set up, and during the
// fund moves) and resumed. Then: everything arrived, the limits and the two chosen mandates continued (no
// period paid twice, the paused one still paused), the third was revoked, the new agent pays, the new
// Treasurer sees the treasury, the old agent has no role and cannot see the new treasury, the old
// treasury's records do not name the new one, and a deposit that reaches the old treasury afterwards is
// moved too.
// Usage (a local fork with the site served by a serve.mjs-style server and DB_SCHEMA set):
//   RPC_URL_SERVER=<rpc> node scripts/ops/e2e-rekey.mjs <siteUrl>
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const site = process.argv[2] ?? 'http://localhost:5199';
const RPC = process.env.RPC_URL_SERVER || undefined;
const { createAgent, newSeed } = await import('../../agent/index.mjs');
const agent = await createAgent({ seed: newSeed(), network: 'testnet', api: site, rpc: RPC, maxPerTx: '500' });
const agent2 = await createAgent({ seed: newSeed(), network: 'testnet', api: site, rpc: RPC, maxPerTx: '500' });
const treasurer = await createAgent({ seed: newSeed(), network: 'testnet', api: site, rpc: RPC });
const { chain, deployment, apiBase, abis } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest, zkAddress, parseZkAddress } = await import('../../src/lib/zk/keys.js');
const { createClient } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { createTransport } = await import('../../src/lib/zk/transport.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const provers = {};
const prove = async (kind, witness) => (await (provers[kind] ??= createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${kind}.json`, 'utf8'))))).prove(witness);
const { relay, mailbox } = createTransport(`${site}${apiBase}`);
const keys = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const ownerWith = (relayFn) => createClient({ publicClient, walletClient, address: account.address, keys, prove, relay: relayFn, requests: mailbox, onStatus: (m) => console.log(`    · owner: ${m}`) });
const owner = ownerWith(relay);
const ownerZk = zkAddress(keys);
const mine = () => (RPC?.includes('127.0.0.1') ? publicClient.request({ method: 'anvil_mine', params: ['0x40'] }) : null);
const tick = () => new Promise((resolve) => tickHandler({ method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, { statusCode: 200, setHeader() {}, end: resolve }));
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms${r === undefined ? '' : ` ${JSON.stringify(r, (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`}`); return r; };
const refused = async (name, fn, pattern) => {
  try { await fn(); } catch (error) { if (!pattern.test(error.message)) throw error; console.log(`  ✓ refused (${name}): ${error.message}`); return; }
  throw new Error(`${name} was not refused`);
};
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ✓ ${what}`); };
async function cleared(balance, want) {
  await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 5) * 1000));
  for (let i = 0; i < 10; i++) { await mine(); await tick(); if ((await balance()) >= want) return; await new Promise((r) => setTimeout(r, 10_000)); }
  throw new Error('the deposit did not clear');
}
const limitOf = async (id) => (await publicClient.readContract({ address: deployment.ledger, abi: abis.ledger, functionName: 'limits', args: [id] })).slice(0, 2).map(Number);

await owner.sync();
if (owner.balance(deployment.usdg) < 2500_000000n) {
  await step('Owner deposits 3000 tUSDG privately', async () => {
    const before = owner.balance(deployment.usdg);
    await owner.deposit(deployment.usdg, 3000_000000n);
    await cleared(async () => { await owner.sync(); return owner.balance(deployment.usdg); }, before + 3000_000000n);
  });
}
await step('Owner funds both agents for relay fees', async () => {
  await owner.send({ amount: 400_000000n, to: parseZkAddress(agent.address) });
  await owner.send({ amount: 400_000000n, to: parseZkAddress(agent2.address) });
});
const t0 = (await publicClient.getBlock()).timestamp;
const oldId = await step('Owner creates a treasury: agent as Payer, 100 a day, access for 7 days', () => owner.createLedger({
  name: 'Rekey treasury', payer: parseZkAddress(agent.address), allocCap: 1000_000000n, dualThreshold: 50_000000n,
  scope: { budget: 100_000000n, budgetPeriod: 86_400n, until: t0 + 7n * 86_400n },
}));
const hex = (x) => '0x' + x.toString(16).padStart(64, '0');
await owner.sync();
const L = (id = oldId) => owner.ledgers().find((l) => l.owner === id);
const to = (l) => ({ owner: l.owner, encPub: l.encPub });
// Every note stays above what moving it costs (a relay step on this fork is about 69 tUSDG).
await step('Owner deposits 300 + 200 + 150 tUSDG into it (three notes)', async () => {
  for (const amount of [300_000000n, 200_000000n, 150_000000n]) await owner.deposit(deployment.usdg, amount, to(L()));
  await cleared(async () => { await owner.sync(); return owner.ledgerBalance(L(), deployment.usdg); }, 650_000000n);
});
await step('Owner allocates 100 to the yield vault', () => owner.ledgerAct(L(), 'Owner', { action: 'allocate', amount: 100_000000n }));
await step('Owner limits payments without approval to 10 a day', () => owner.setTransferLimit(L(), 10, 86_400));
const expiry = Math.floor(Date.now() / 1000) + 180 * 86_400;
await step('Owner gives the agent a 25 tUSDG monthly mandate', () => owner.createMandate(L(), 'Owner', { kind: 'Payroll', to: parseZkAddress(agent.address), label: 'agent pay', cap: 25_000000n, period: 'Monthly', expiry }));
await step('Owner adds a mandate it pauses, and one it will leave behind', async () => {
  await owner.createMandate(L(), 'Owner', { kind: 'Payroll', to: parseZkAddress(ownerZk), label: 'on hold', cap: 5_000000n, period: 'Monthly', expiry });
  await owner.sync();
  await owner.manageMandate(L(), 'Owner', owner.mandates(L()).find((m) => m.label === 'on hold'), 'pause');
  await owner.createMandate(L(), 'Owner', { kind: 'Payroll', to: parseZkAddress(agent.address), label: 'planted', cap: 40_000000n, period: 'Monthly', expiry });
});
const [mandate] = (await step('Agent lists the mandates', () => agent.mandates(hex(oldId)))).filter((m) => m.label === 'agent pay');
check((await step('Agent pays the mandate (period 0)', () => agent.payMandate(hex(oldId), mandate.id, '25'))).confirmed, 'mandate paid');
check((await step('Agent pays 10 from the treasury', () => agent.pay(hex(oldId), { to: ownerZk, amount: '10' }))).confirmed, 'paid');
await owner.sync();
const before = { usdg: owner.ledgerBalance(L(), deployment.usdg), vault: owner.ledgerBalance(L(), deployment.vault) };
const oldMandate = owner.mandates(L()).find((m) => m.label === 'agent pay');
const onHold = owner.mandates(L()).find((m) => m.label === 'on hold');
const planted = owner.mandates(L()).find((m) => m.label === 'planted');
const plan = { payer: parseZkAddress(agent2.address), treasurer: parseZkAddress(treasurer.address), carry: [oldMandate.commit, onHold.commit] };
console.log(`    old treasury: ${before.usdg} USDG units, ${before.vault} vault shares, ${owner.ledgerNotes(L()).filter((n) => n.status === 'unspent').length} notes`);
const preview = await owner.rekeyPreview(L());
check(preview.movedTo === null && preview.txs >= 2 && preview.mandates.length === 3 && preview.governance === 4, 'the review: notes to move, three live mandates, four governance steps');

// The move, interrupted: the fourth governance step (lifting the old limit) fails once.
const failing = (kind, nth) => { let n = 0; return ownerWith((body) => (body?.kind === kind && ++n === nth ? Promise.reject(new Error('simulated network failure')) : relay(body))); };
await refused('the move, interrupted', () => failing('ledger_auth', 4).rekeyLedger(L(), plan), /simulated network failure/);
await owner.sync();
const newId = owner.movedTo(L());
check(newId !== null && L(newId), 'the new treasury exists after the interruption');
await refused('the old agent pays from the old treasury', () => agent.pay(hex(oldId), { to: ownerZk, amount: '1' }), /cannot act in treasury/);
// Interrupted again during the fund moves (the second transfer fails); the third run finishes.
await refused('the move, interrupted while moving funds', () => failing('ledger', 2).rekeyLedger(L(), { carry: plan.carry }), /could not be moved yet .*simulated network failure/);
check((await step('Owner continues the move', () => owner.rekeyLedger(L(), { carry: plan.carry }))) === newId, 'it continues into the same treasury');

await owner.sync();
check(owner.ledgerNotes(L()).every((n) => n.status !== 'unspent' || n.amount === 0n), 'nothing left in the old treasury');
check(owner.ledgerBalance(L(newId), deployment.usdg) === before.usdg, 'every USDG unit arrived');
check(owner.ledgerBalance(L(newId), deployment.vault) === before.vault, 'every vault share arrived');
check(JSON.stringify(await limitOf(newId)) === JSON.stringify([10, 86_400]), 'the payment limit carried over');
check((await limitOf(oldId))[0] === 0, 'and was lifted on the old treasury');
const c = L(newId).config;
check(c.payer === parseZkAddress(agent2.address).owner && c.budget === 100_000000n && c.payerUntil === t0 + 7n * 86_400n, 'the new agent with the same budget and access end');
check(owner.mandates(L()).every((m) => m.status === 'Revoked'), 'every old mandate is revoked');
const carried = owner.mandates(L(newId)).find((m) => m.label === 'agent pay');
check(carried?.status === 'Active' && carried.start === oldMandate.start + oldMandate.period, 'the mandate continues after the period already paid');
check(owner.mandates(L(newId)).find((m) => m.label === 'on hold')?.status === 'Paused', 'the paused mandate is still paused');
check(!owner.mandates(L(newId)).some((m) => m.label === 'planted') && planted, 'the mandate the Owner did not tick stayed behind');
check((await treasurer.treasuries()).find((t) => t.id === hex(newId))?.roles.includes('Treasurer'), 'the new Treasurer has the new keys');
const oldRecords = JSON.stringify((await owner.ledgerPayments(L())).rows, (_, x) => (typeof x === 'bigint' ? x.toString(16) : x));
check(!oldRecords.includes(newId.toString(16)), "the old treasury's records do not name the new treasury");
check(!(await agent.treasuries()).some((t) => t.id === hex(newId)), 'the old agent cannot see the new treasury');
const seen = (await agent2.treasuries()).find((t) => t.id === hex(newId));
check(seen?.payerLimits?.budget === '100', 'the new agent sees it, with its limits');
check((await step('New agent pays 5 from the new treasury', () => agent2.pay(hex(newId), { to: ownerZk, amount: '5' }))).confirmed, 'paid');

await step('Someone pays 100 to the old treasury address afterwards', async () => {
  await owner.deposit(deployment.usdg, 100_000000n, to(L()));
  await cleared(async () => { await owner.sync(); return owner.ledgerBalance(L(), deployment.usdg); }, 100_000000n);
});
const later = await owner.rekeyPreview(L());
check(later.movedTo === newId && later.txs === 1 && later.governance === 0, 'the old treasury shows it as left to move');
await step('Owner moves the remaining funds', () => owner.rekeyLedger(L()));
await owner.sync();
check(owner.ledgerBalance(L(), deployment.usdg) === 0n, 'moved');
console.log('Rekey e2e passed.');
process.exit(0);
