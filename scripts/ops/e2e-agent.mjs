// Agent acceptance (agent/): an AI agent's private account used through the SDK against a running
// ZKdesk site (its relayer and mailbox over HTTP), with an Owner who funds it and makes it a
// treasury's Payer. Owner deposits -> sends the agent 800 -> agent sends and withdraws -> Owner
// creates a treasury with the agent as Payer (approval above 50) -> agent pays 20 -> agent's 80 becomes
// a request -> Owner approves -> agent completes -> Owner gives the agent a 25/month mandate -> agent
// pays it once (a second pay is refused) -> agent proves the receipt and it verifies -> payment links:
// the agent pays the Owner's link (own balance, then from the treasury) and the Owner pays the agent's
// link while the agent waits for it -> incoming payments list (no change) -> the agent's
// per-transaction limit refuses 600 -> a deposit to the agent that its sender refunds during screening
// is reported as pending, never as received.
// Usage (testnet or a local fork with the site served by serve.mjs-style server and DB_SCHEMA set):
//   RPC_URL_SERVER=<rpc> node scripts/ops/e2e-agent.mjs <siteUrl>
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const site = process.argv[2] ?? 'http://localhost:5199';
const RPC = process.env.RPC_URL_SERVER || undefined;
const { createAgent, newSeed } = await import('../../agent/index.mjs');
const agent = await createAgent({ seed: newSeed(), network: 'testnet', api: site, rpc: RPC, maxPerTx: '500', onStatus: (m) => console.log(`    · agent: ${m}`) });
const { chain, deployment, apiBase } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest, zkAddress, parseZkAddress } = await import('../../src/lib/zk/keys.js');
const { createClient } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { createTransport } = await import('../../src/lib/zk/transport.js');
const { paymentLink, readPaymentLink } = await import('../../src/lib/zk/request-link.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const provers = {};
const prove = async (kind, witness) => (await (provers[kind] ??= createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${kind}.json`, 'utf8'))))).prove(witness);
const { relay, mailbox } = createTransport(`${site}${apiBase}`);
const keys = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const owner = createClient({ publicClient, walletClient, address: account.address, keys, prove, relay, requests: mailbox, onStatus: (m) => console.log(`    · owner: ${m}`) });
const ownerZk = zkAddress(keys);
// A local fork mines only on demand and the indexer stays a few blocks behind the head.
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

console.log(`Agent ${agent.address.slice(0, 22)}… on ${chain.name} via ${site}`);
await owner.sync();
if (owner.balance(deployment.usdg) < 1500_000000n) {
  await step('Owner deposits 3000 tUSDG privately', async () => {
    const before = owner.balance(deployment.usdg);
    await owner.deposit(deployment.usdg, 3000_000000n);
    await cleared(async () => { await owner.sync(); return owner.balance(deployment.usdg); }, before + 3000_000000n);
  });
}
await step('Owner sends the agent 800 tUSDG privately', () => owner.send({ amount: 800_000000n, to: parseZkAddress(agent.address) }));
const start = await step('Agent balance', () => agent.balance());
check(Number(start.usdg) >= 800, 'the agent sees its funds');
await step('Agent sends 10 back privately', () => agent.send({ to: ownerZk, amount: '10' }));
await step('Agent withdraws 10 to a 0x address', () => agent.withdraw({ to: account.address, amount: '10' }));

const ledgerId = await step('Owner creates a treasury with the agent as Payer (approval above 50)', () => owner.createLedger({
  name: 'Agent treasury', payer: parseZkAddress(agent.address), allocCap: 1000_000000n, dualThreshold: 50_000000n,
}));
const id = '0x' + ledgerId.toString(16).padStart(64, '0');
await owner.sync();
const L = () => owner.ledgers().find((l) => l.owner === ledgerId);
await step('Owner deposits 400 tUSDG into the treasury', async () => {
  await owner.deposit(deployment.usdg, 400_000000n, { owner: L().owner, encPub: L().encPub });
  await cleared(async () => Number((await agent.treasuries()).find((t) => t.id === id)?.usdg ?? 0) * 1e6, 400_000000);
});
const seen = await step('Agent lists its treasuries', () => agent.treasuries());
check(seen.find((t) => t.id === id)?.roles.join() === 'Payer', 'the agent holds only the Payer role');
const paid = await step('Agent pays 20 from the treasury (below the threshold)', () => agent.pay(id, { to: ownerZk, amount: '20' }));
check(paid.confirmed, 'relayed and confirmed');
const asked = await step('Agent pays 80 (above the threshold)', () => agent.pay(id, { to: ownerZk, amount: '80' }));
check(asked.requested === true, 'it became a request for the Owner');
await step('Owner approves the request', async () => {
  await owner.sync();
  const r = (await owner.ledgerRequests(L())).find((x) => x.status === 'Awaiting Owner');
  return owner.approveRequest(L(), r).then(() => r.id);
});
const approved = (await agent.requests(id)).find((r) => r.status === 'Approved' && r.mine);
check(approved?.amount === '80', 'the agent sees its request approved');
check((await step('Agent completes it', () => agent.complete(id, approved.id))).confirmed, 'the approved transfer is sent');

const expiry = Math.floor(Date.now() / 1000) + 30 * 86_400;
await step('Owner gives the agent a 25 tUSDG monthly mandate', () => owner.createMandate(L(), 'Owner', { kind: 'Payroll', to: parseZkAddress(agent.address), label: 'agent', cap: 25_000000n, period: 'Monthly', expiry }));
const [mandate] = await step('Agent lists the mandates', () => agent.mandates(id));
check(mandate?.cap === '25' && !mandate.paidThisPeriod, 'one unpaid 25 tUSDG mandate');
check((await step('Agent pays the mandate', () => agent.payMandate(id, mandate.id, '25'))).confirmed, 'mandate paid');
await refused('second payment in the same period', () => agent.payMandate(id, mandate.id, '25'), /already paid/);
const [receipt] = await step('Agent lists its receipts', () => agent.receipts());
check(receipt?.amount === '25', 'the payment carries a receipt');
const record = await step('Agent proves the receipt (amount disclosed)', () => agent.proveReceipt(receipt.id, { discloseAmount: true }).then((r) => r.proof.amount));
check(await agent.verifyReceipt(await agent.proveReceipt(receipt.id, { discloseAmount: true })), 'the receipt verifies on-chain');
const ownerLink = (amount) => paymentLink(site, { to: ownerZk, amount, memo: 'e2e invoice', network: 'testnet' }).toString();
check((await step("Agent pays the Owner's 3 tUSDG link from its balance", () => agent.payLink(ownerLink('3')))).confirmed, 'link paid');
check((await step('Agent pays an open-amount link from the treasury (5)', () => agent.payLink(ownerLink(''), { amount: '5', treasury: id }))).confirmed, 'link paid from the treasury');
const asking = await step('Agent creates a link asking for 4', () => agent.requestLink({ amount: '4', memo: 'agent invoice' }));
const before = Number((await agent.balance()).usdg);
const want = agent.readLink(asking).amount; // 4 plus a few millionths: this link's own amount
check(Number(want) > 4 && Number(want) < 4.001, `the link asks for a unique amount (${want})`);
const waiting = agent.waitForPayment({ amount: want, timeoutSeconds: 180 });
await step("Owner pays the agent's link", () => { const r = readPaymentLink(new URL(asking).searchParams); return owner.send({ amount: BigInt(Math.round(Number(r.amount) * 1e6)), to: parseZkAddress(r.to) }); });
const arrived = await step('Agent was waiting for it', () => waiting);
check(arrived.received && arrived.amount === want && arrived.kind === 'private payment', "the wait returned this link's payment");
check(Math.abs(Number((await agent.balance()).usdg) - before - Number(want)) < 1e-9, 'the agent received exactly the link amount');
const got = await step('Agent lists incoming payments', () => agent.incoming().then((list) => list.map((p) => `${p.amount} ${p.kind}`)));
check(got.includes(`${want} private payment`) && got.includes('800 private payment') && got.includes('25 mandate payment (has a receipt)'), 'payments from others are listed');
check(got.length === 3, 'its own change and self-transfers are not');
check((await step('Agent waits 3 s for 999 that never comes', () => agent.waitForPayment({ amount: '999', timeoutSeconds: 3 }))).received === false, 'the wait times out');
await refused('600 above the agent limit', () => agent.pay(id, { to: ownerZk, amount: '600' }), /above this agent's limit/);
// A-1: a deposit in screening can be taken back by its sender, so it is never "received".
const { abis } = await import('../../src/lib/chain/config.js');
const holding = agent.waitForPayment({ amount: '7', timeoutSeconds: 45 }); // started before the deposit, like a real wait
await step('Owner deposits 7 to the agent (stays in screening)', () => owner.deposit(deployment.usdg, 7_000000n, parseZkAddress(agent.address)));
const held = await step('Agent was waiting for 7', () => holding);
check(held.received === false && held.pending === true, 'the screened deposit is reported as pending, not received');
await step('Owner takes it back (refundToOrigin)', async () => {
  const depositId = (await publicClient.readContract({ address: deployment.pool, abi: abis.pool, functionName: 'depositCount' })) - 1n;
  const hash = await walletClient.writeContract({ address: deployment.pool, abi: abis.pool, functionName: 'refundToOrigin', args: [depositId] });
  return (await publicClient.waitForTransactionReceipt({ hash })).status;
});
check(!(await agent.incoming()).some((p) => p.amount === '7') && !(await agent.incoming({ pending: true })).some((p) => p.amount === '7'), 'the refunded deposit is neither received nor pending');
check((await agent.waitForPayment({ amount: '7', timeoutSeconds: 3 })).pending !== true, 'and no longer reported at all');
console.log(`Agent balance now ${(await agent.balance()).usdg} tUSDG. Agent e2e passed. (${record})`);
process.exit(0);
