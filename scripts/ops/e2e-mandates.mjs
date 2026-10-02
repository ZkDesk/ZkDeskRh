// Live M5 acceptance on Robinhood Chain testnet. The Owner (deployer wallet) creates a treasury with
// a separate Payer (a relayed test key), funds it with tUSDG and tSPY, and the Payer commits and
// pays mandates to Rita (another test key): monthly payroll, an invoice (cap above the threshold:
// the Owner commits it), and SPY payroll priced in USDG. A second pull in the same period and a pull
// on a paused mandate are refused. Rita finds her payments and exports a receipt proof for her bank
// that discloses only the amount; it verifies on-chain, and not for another verifier.
// Usage: node scripts/ops/e2e-mandates.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { chain, deployment } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { createClient, verifyReceipt } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { default: relayHandler } = await import('../../api/relay.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');

const call = (handler, req) => new Promise((resolve) => handler(req, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));
const relay = (body) => call(relayHandler, body ? { method: 'POST', body } : { method: 'GET' });
const tick = () => call(tickHandler, { method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const walletClient = createWalletClient({ account, chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const provers = Object.fromEntries(await Promise.all(['transact', 'role_auth', 'mandate_auth', 'mandate_pull', 'receipt'].map(async (k) => [k, await createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${k}.json`, 'utf8')))])));
const prove = (kind, witness) => provers[kind].prove(witness);
const member = (name, keys, wallet = {}) => ({ name, keys, client: createClient({ publicClient, keys, prove, relay, onStatus: (m) => console.log(`    · ${name}: ${m}`), ...wallet }) });
const owner = member('Owner', deriveKeys(await account.signTypedData(keyRequest(chain.id))), { walletClient, address: account.address });
const payer = member('Payer', deriveKeys('0x' + '0b'.repeat(65)));
const rita = member('Rita', deriveKeys('0x' + '0c'.repeat(65)));
const addr = (m) => ({ owner: m.keys.owner, encPub: m.keys.encPub });
const SPY = deployment.stocks.tSPY.token;
const usd = (x) => `${formatUnits(x, 6)} tUSDG`;
const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms`); return r; };
const refused = async (name, fn, pattern) => {
  try { await fn(); } catch (error) { if (!pattern.test(error.message)) throw error; console.log(`  ✓ refused (${name}): ${error.message}`); return; }
  throw new Error(`${name} was not refused`);
};
const L = async (m, id) => { await m.client.sync(); return m.client.ledgers().find((l) => l.owner === id); };
const M = async (m, id, commit) => (m.client.mandates(await L(m, id))).find((x) => x.commit === commit);
const now = Math.floor(Date.now() / 1000);

// Payment steps pay their relay voucher from the acting member's personal private balance.
await payer.client.sync();
for (let i = 0; i < 3 && payer.client.balance(deployment.usdg) < 1000_000000n; i++) { await step('Owner sends the Payer 400 tUSDG privately for relay fees', () => owner.client.send({ amount: 400_000000n, to: addr(payer) })); await payer.client.sync(); }
const id = await step('Owner creates a treasury with a separate Payer (dual control above 100)', () => owner.client.createLedger({ name: 'Payroll e2e', payer: addr(payer), allocCap: 1000_000000n, dualThreshold: 100_000000n }));
const lo = await L(owner, id);
await step('Owner funds it: 500 tUSDG and 2 tSPY from the wallet', async () => {
  await owner.client.deposit(deployment.usdg, 500_000000n, { owner: lo.owner, encPub: lo.encPub });
  await owner.client.deposit(SPY, 2n * 10n ** 18n, { owner: lo.owner, encPub: lo.encPub });
  await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 15) * 1000));
  for (let i = 0; i < 8; i++) { await tick(); const l = await L(owner, id); if (owner.client.ledgerBalance(l, SPY) > 0n && owner.client.ledgerBalance(l, deployment.usdg) > 0n) return; await new Promise((r) => setTimeout(r, 15000)); }
  throw new Error('deposits did not clear');
});

const payroll = await step('Payer commits monthly payroll to Rita (cap 80)', async () => payer.client.createMandate(await L(payer, id), 'Payer', { kind: 'Payroll', to: addr(rita), label: 'Rita', cap: 80_000000n, period: 'Monthly', expiry: now + 90 * 86400 }));
await refused('Payer invoice above the threshold', async () => payer.client.createMandate(await L(payer, id), 'Payer', { kind: 'Invoice', to: addr(rita), cap: 150_000000n, period: 'One-time', expiry: now + 30 * 86400, reference: 'INV-7' }), /needs the Owner/);
const invoice = await step('Owner commits invoice INV-7 to Rita (cap 150)', async () => owner.client.createMandate(await L(owner, id), 'Owner', { kind: 'Invoice', to: addr(rita), label: 'Rita · INV-7', cap: 150_000000n, period: 'One-time', expiry: now + 30 * 86400, reference: 'INV-7' }));
const spy = await step('Payer commits weekly SPY payroll worth 100 tUSDG', async () => payer.client.createMandate(await L(payer, id), 'Payer', { kind: 'Payroll', to: addr(rita), label: 'Rita · SPY', asset: SPY, cap: 100_000000n, period: 'Weekly', expiry: now + 90 * 86400 }));
const commitOf = async (m) => (await L(payer, id)) && payer.client.mandates(await L(payer, id)).find((x) => x.salt === m.salt).commit;
const [cPay, cInv, cSpy] = [await commitOf(payroll), await commitOf(invoice), await commitOf(spy)];

await step('Payer pauses the SPY payroll', async () => payer.client.manageMandate(await L(payer, id), 'Payer', await M(payer, id, cSpy), 'pause'));
await refused('pull on a paused mandate (contract)', async () => payer.client.payMandate(await L(payer, id), 'Payer', await M(payer, id, cSpy), 10_000000n), /paused or revoked/);
await step('Payer resumes the SPY payroll', async () => payer.client.manageMandate(await L(payer, id), 'Payer', await M(payer, id, cSpy), 'resume'));
await step('Payer pays payroll: 80 tUSDG', async () => payer.client.payMandate(await L(payer, id), 'Payer', await M(payer, id, cPay), 80_000000n));
await refused('second payroll pull this month', async () => payer.client.payMandate(await L(payer, id), 'Payer', await M(payer, id, cPay), 80_000000n), /already paid/);
await step('Payer pays invoice INV-7: 150 tUSDG (committed by the Owner)', async () => payer.client.payMandate(await L(payer, id), 'Payer', await M(payer, id, cInv), 150_000000n));
await step('Payer pays SPY payroll: 50 tUSDG worth of tSPY at the pinned mark', async () => payer.client.payMandate(await L(payer, id), 'Payer', await M(payer, id, cSpy), 50_000000n));
await step('Owner revokes the SPY payroll', async () => owner.client.manageMandate(await L(owner, id), 'Owner', await M(owner, id, cSpy), 'revoke'));

await rita.client.sync();
const got = rita.client.receipts();
console.log(`  Rita received ${got.length} mandate payments: ${got.map((r) => `${r.note.asset === BigInt(deployment.usdg) ? usd(r.note.amount) : `${formatUnits(r.note.amount, 18)} tSPY`} (period ${r.k})`).join(', ')}; private tUSDG ${usd(rita.client.balance(deployment.usdg))}`);
const BANK = '0x000000000000000000000000000000000000ba4b';
const payslip = got.find((r) => r.note.amount === 80_000000n);
const record = await step("Rita proves the payroll payment to her bank (amount disclosed, identity hidden)", () => rita.client.proveReceipt(payslip, { verifier: BANK, discloseAmount: true }));
writeFileSync('receipt-e2e.json', JSON.stringify(record, null, 2));
console.log(`  on-chain verifyReceipt: ${await verifyReceipt(publicClient, record)}`);
const other = { ...record, proof: { ...record.proof, verifier: '0xbad' } };
console.log(`  same proof for another verifier: ${await verifyReceipt(publicClient, other).catch(() => false)}`);
const t = await tick();
console.log(`cron after: indexed ${JSON.stringify(t.indexed)}`);
await Promise.all(Object.values(provers).map((p) => p.destroy()));
process.exit(0);
