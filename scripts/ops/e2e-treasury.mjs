// Live M4 acceptance on Robinhood Chain testnet with four members: Owner (the deployer wallet) and
// Treasurer / Payer / Auditor (test keys; everything they do is relayed, so they need no gas).
// create -> each member finds the ledger and its role -> Owner deposits 1000 tUSDG into it ->
// Treasurer allocates 600 -> Payer cannot allocate -> Payer transfers 50 to itself -> Treasurer is
// refused above the dual-control threshold -> Owner rotates Payer to itself, then pays 200 as Payer
// (auto Owner approval) -> Treasurer deallocates -> Auditor reads everything, cannot spend, and
// publishes a treasury statement. Real relayer and cron handlers in-process with .env.local.
// Usage: node scripts/ops/e2e-treasury.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
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
const { default: tickHandler } = await import('../../api/cron/tick.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const tick = () => call(tickHandler, { method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const walletClient = createWalletClient({ account, chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const provers = Object.fromEntries(await Promise.all(['transact', 'ledger', 'role_auth', 'treasury_attest'].map(async (k) => [k, await createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${k}.json`, 'utf8')))])));
const prove = (kind, witness) => provers[kind].prove(witness);
const member = (name, keys, wallet = {}) => ({ name, keys, client: createClient({ publicClient, keys, prove, relay, onStatus: (m) => console.log(`    · ${name}: ${m}`), ...wallet }) });
const owner = member('Owner', deriveKeys(await account.signTypedData(keyRequest(chain.id))), { walletClient, address: account.address });
// Deterministic test members (not wallets): keys from fixed test signatures.
const [treasurer, payer, auditor] = ['Treasurer', 'Payer', 'Auditor'].map((n, i) => member(n, deriveKeys('0x' + (i + 1).toString(16).padStart(2, '0').repeat(65))));
const addr = (m) => ({ owner: m.keys.owner, encPub: m.keys.encPub });

const usd = (x) => `${formatUnits(x, 6)} tUSDG`;
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms`); return r; };
const refused = async (name, fn, pattern) => {
  try { await fn(); } catch (error) { if (!pattern.test(error.message)) throw error; console.log(`  ✓ refused (${name}): ${error.message}`); return; }
  throw new Error(`${name} was not refused`);
};
const find = async (m, id) => { await m.client.sync(); return m.client.ledgers().find((l) => l.owner === id); };
const show = async (m, id) => {
  const l = await find(m, id);
  console.log(`  ${m.name} sees "${l.name}" as ${l.roles.join(', ')}: ${usd(m.client.ledgerBalance(l, deployment.usdg))} liquid, ${formatUnits(m.client.ledgerBalance(l, deployment.vault), 12)} vault shares`);
  return l;
};

// Relay fees (vouchers) come from the Owner's personal private balance: top it up when low.
await owner.client.sync();
if (owner.client.balance(deployment.usdg) < 3000_000000n) {
  await step('Owner tops up 5000 tUSDG privately (relay fees)', async () => {
    await owner.client.deposit(deployment.usdg, 5000_000000n);
    await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 15) * 1000));
    for (let i = 0; i < 8; i++) { await tick(); await owner.client.sync(); if (owner.client.balance(deployment.usdg) >= 3000_000000n) return; await new Promise((r) => setTimeout(r, 15000)); }
  });
}
// Treasury steps pay their relay voucher from the acting member's personal private balance.
for (const m of [treasurer, payer, auditor]) {
  await m.client.sync();
  if (m.client.balance(deployment.usdg) < 300_000000n) await step(`Owner sends ${m.name} 500 tUSDG privately for relay fees`, () => owner.client.send({ amount: 500_000000n, to: addr(m) }));
}

const id = await step('Owner creates the treasury (cap 800, dual control above 100)', () => owner.client.createLedger({
  name: 'E2E treasury', treasurer: addr(treasurer), payer: addr(payer), auditor: addr(auditor), allocCap: 800_000000n, dualThreshold: 100_000000n,
}));
for (const m of [owner, treasurer, payer, auditor]) {
  const l = await find(m, id);
  if (!l) throw new Error(`${m.name} cannot find the ledger`);
  console.log(`  ${m.name} holds: ${l.roles.join(', ')}`);
}
const ledgerAddr = await find(owner, id);
await step('Owner deposits 1000 tUSDG from the wallet into the treasury', () => owner.client.deposit(deployment.usdg, 1000_000000n, { owner: ledgerAddr.owner, encPub: ledgerAddr.encPub }));
await step(`wait standby (${deployment.standbySeconds}s), then cron clears`, async () => {
  await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 15) * 1000));
  for (let i = 0; i < 8; i++) { await tick(); const l = await find(owner, id); if (owner.client.ledgerBalance(l, deployment.usdg) >= 1000_000000n) return; await new Promise((r) => setTimeout(r, 15000)); }
  throw new Error('deposit did not clear');
});
await show(auditor, id);

await step('Treasurer allocates 600 tUSDG to the yield vault', async () => treasurer.client.ledgerAct(await find(treasurer, id), 'Treasurer', { action: 'allocate', amount: 600_000000n }));
await refused('Payer allocate', async () => payer.client.ledgerAct(await find(payer, id), 'Payer', { action: 'allocate', amount: 10_000000n }), /Owner or Treasurer/);
await refused('Auditor transfer', async () => auditor.client.ledgerAct(await find(auditor, id), 'Auditor', { action: 'transfer', amount: 1_000000n, to: addr(auditor) }), /cannot move funds/);
await step('Payer pays 50 tUSDG to itself (under the threshold)', async () => payer.client.ledgerAct(await find(payer, id), 'Payer', { action: 'transfer', amount: 50_000000n, to: addr(payer) }));
await payer.client.sync();
console.log(`  Payer personal balance: ${usd(payer.client.balance(deployment.usdg))}`);
await refused('Treasurer above the threshold without the Owner', async () => treasurer.client.ledgerAct(await find(treasurer, id), 'Treasurer', { action: 'transfer', amount: 200_000000n, to: addr(treasurer) }), /Owner must approve/);
await step('Owner rotates the Payer role to itself', async () => owner.client.updateLedger(await find(owner, id), { payer: addr(owner) }));
if ((await find(payer, id))) throw new Error('the old Payer still holds a role');
console.log('  old Payer no longer holds a role');
await step('Owner pays 200 tUSDG as Payer (above the threshold: approves as Owner, then pays)', async () => owner.client.ledgerAct(await find(owner, id), 'Payer', { action: 'transfer', amount: 200_000000n, to: addr(treasurer) }));
const tl = await find(treasurer, id);
await step('Treasurer deallocates all vault shares', () => treasurer.client.ledgerAct(tl, 'Treasurer', { action: 'deallocate', amount: treasurer.client.ledgerBalance(tl, deployment.vault) }));
const al = await show(auditor, id);
await refused('Auditor cannot spend', () => auditor.client.ledgerAct(al, 'Auditor', { action: 'transfer', amount: 1_000000n, to: addr(auditor) }), /cannot move funds/);
await step('Auditor publishes a treasury statement: assets cover 500 tUSDG', () => auditor.client.ledgerAttest(al, 500_000000n));
await refused('statement above the assets', () => auditor.client.ledgerAttest(al, 10_000_000000n), /do not cover/);
const t = await tick();
console.log(`cron after: indexed ${JSON.stringify(t.indexed)}`);
console.log(`ledger ${'0x' + id.toString(16)} (${(await find(auditor, id)).attested ? `statement epoch ${(await find(auditor, id)).attested.epoch}` : 'no statement'})`);
await Promise.all(Object.values(provers).map((p) => p.destroy()));
process.exit(0);
