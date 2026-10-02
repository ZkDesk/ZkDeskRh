// Browser acceptance for /dashboard?mode=testnet with an injected EIP-1193 test wallet backed by
// DEPLOYER_PRIVATE_KEY (signing happens in Node; the page sees a normal injected wallet).
// Usage: PLAYWRIGHT=<file URL of playwright index.mjs> [ONLY=<step regex>] node scripts/ops/browser-e2e.mjs [baseUrl] [shotDir]
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain } from '../../src/lib/chain/config.js';
import { deriveKeys, keyRequest } from '../../src/lib/zk/keys.js';
import { verifyReceipt } from '../../src/lib/zk/client.js';
import { zkAddress } from '../../src/dashboard/adapters/testnet.js';

const { chromium } = await import(process.env.PLAYWRIGHT);
const [base = 'https://zkdesk.tech', shots = '.'] = process.argv.slice(2);
const key = readFileSync('.env.local', 'utf8').match(/DEPLOYER_PRIVATE_KEY="([^"]+)"/)[1];
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const rpc = (method, params) => wallet.request({ method, params });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// RPC_URL_SERVER (a local fork): the page's and its workers' chain reads go there too.
if (process.env.RPC_URL_SERVER) {
  await page.context().route(`${chain.rpcUrls.default.http[0]}**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    const r = await fetch(process.env.RPC_URL_SERVER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: await r.text() });
  });
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') errors.push(`worker: ${m.text()}`); }));
page.context().on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 100)}`); });
await page.exposeFunction('__wallet', async (method, params) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
  if (method === 'eth_chainId') return '0x' + chain.id.toString(16);
  if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
  if (method === 'eth_signTypedData_v4') {
    const { domain, types, primaryType, message } = JSON.parse(params[1]);
    delete types.EIP712Domain;
    return account.signTypedData({ domain, types, primaryType, message });
  }
  if (method === 'eth_sendTransaction') {
    const { to, data, value, gas } = params[0];
    return wallet.sendTransaction({ to, data, value: value ? BigInt(value) : undefined, gas: gas ? BigInt(gas) : undefined });
  }
  return rpc(method, params);
});
await page.addInitScript(() => {
  window.__toasts = [];
  new MutationObserver(() => {
    const t = document.querySelector(".desk-toast")?.innerText?.trim();
    if (t && window.__toasts.at(-1) !== t) window.__toasts.push(t);
    if (!t && window.__toasts.at(-1) !== null) window.__toasts.push(null);
  }).observe(document, { childList: true, subtree: true, characterData: true });
});
await page.addInitScript(() => {
  const listeners = {};
  window.ethereum = {
    isMetaMask: true,
    request: ({ method, params }) => window.__wallet(method, params ?? []),
    on: (e, f) => { (listeners[e] ||= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
  };
});

// ONLY=<regex>: run just the matching steps (opening and connecting always run).
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const step = async (name, fn) => {
  if (only && !only.test(name) && !/^(open testnet|connect)/.test(name)) return console.log(`- skipped ${name}`);
  const t = performance.now();
  try { await fn(); } catch (error) {
    await page.screenshot({ path: `${shots}/testnet-failure.png`, fullPage: true }).catch(() => {});
    console.error(`✗ ${name}; page errors: ${JSON.stringify(errors)}`);
    throw error;
  }
  console.log(`✓ ${name} (${Math.round(performance.now() - t)} ms)`);
};
const cash = () => page.locator('.desk-treasury-balance .desk-total').innerText();
let toastsSeen = 0;
const toast = async () => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const list = (await page.evaluate(() => window.__toasts)).filter(Boolean);
    if (list.length > toastsSeen) { toastsSeen = list.length; return list.at(-1); }
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${shots}/testnet-failure.png`, fullPage: true });
  throw new Error("no confirmation toast");
};
async function action(button, fill, scope = page) {
  await scope.getByRole("button", { name: button, exact: true }).first().click();
  for (const [sel, v] of Object.entries(fill)) {
    if (sel === "#desk-field-asset") { await page.selectOption(sel, v); continue; }
    // The dialog focuses its first field on open: wait for that, then fill and verify each field.
    await page.waitForTimeout(100);
    await page.fill(sel, v);
    if ((await page.inputValue(sel)) !== v) await page.fill(sel, v);
  }
  const review = page.getByRole("button", { name: "Review details" });
  if (await review.isVisible().catch(() => false)) await review.click();
  const confirm = page.locator("[data-confirm-simulation]");
  await confirm.click();
  const seen = new Set();
  const until = Date.now() + 180_000;
  while (Date.now() < until && await confirm.isVisible().catch(() => false)) {
    const label = (await confirm.innerText().catch(() => "")).trim();
    if (label && !seen.has(label)) { seen.add(label); console.log(`    · ${label}`); }
    const err = await page.locator(".desk-modal .desk-form-error").first().innerText({ timeout: 50 }).catch(() => null);
    if (err) throw new Error(`dialog error: ${err}`);
    await page.waitForTimeout(250);
  }
  return toast();
}

await step('open testnet dashboard', async () => {
  await page.goto(`${base}/dashboard?mode=testnet&network=testnet&view=treasury`, { waitUntil: 'networkidle' });
  await page.getByText('Connect MetaMask on Robinhood Chain testnet').waitFor();
  await page.screenshot({ path: `${shots}/testnet-1-connect.png` });
});
await step('connect + unlock notes', async () => {
  await page.getByRole('button', { name: 'Connect MetaMask' }).click();
  await page.getByText('Wallet connected').waitFor({ timeout: 90_000 });
  console.log(`    balance ${await cash()}`);
  await page.screenshot({ path: `${shots}/testnet-2-connected.png` });
});
const nav = (name) => page.locator(".desk-nav-item", { hasText: name }).click();
const credit = async () => { await nav("Credit"); return page.locator(".desk-credit-summary").innerText(); };
await step("lend 100 privately (Allocate)", async () => {
  console.log(`    toast: ${await action("Allocate", { "#desk-field-amount": "100" })} | liquid ${await cash()}`);
});
await step("open credit: 5 tSPY, borrow 1000", async () => {
  await nav("Credit");
  console.log(`    toast: ${await action("Open credit", { "#desk-field-asset": "SPY", "#desk-field-collateral": "5", "#desk-field-amount": "1000" })}`);
  console.log(`    ${(await credit()).replace(/s+/g, " ")}`);
  await page.screenshot({ path: `${shots}/testnet-credit-open.png`, fullPage: true });
});
const card = () => page.locator(".desk-position-card").first();
await step("repay 300", async () => { console.log(`    toast: ${await action("Repay", { "#desk-field-amount": "300" }, card())} | ${(await credit()).replace(/s+/g, " ")}`); });
await step("add 1 tSPY collateral", async () => { console.log(`    toast: ${await action("Add collateral", { "#desk-field-amount": "1" }, card())} | ${(await credit()).replace(/s+/g, " ")}`); });
await step("close position", async () => { console.log(`    toast: ${await action("Close", {}, card())} | positions: ${await page.locator(".desk-position-card").count()}`); });
await step("withdraw 50 from the credit pool (Move to liquid)", async () => {
  await nav("Treasury");
  console.log(`    toast: ${await action("Move to liquid", { "#desk-field-amount": "50" })} | liquid ${await cash()}`);
});
await step("deposit 2 tNVDA (standby)", async () => {
  console.log(`    toast: ${await action("Add funds", { "#desk-field-asset": "NVDA", "#desk-field-amount": "2" })}`);
  await page.screenshot({ path: `${shots}/testnet-treasury.png`, fullPage: true });
});
await step('activity + settings render', async () => {
  await page.getByRole('button', { name: 'Activity' }).click();
  await page.screenshot({ path: `${shots}/testnet-4-activity.png`, fullPage: true });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Your private address').waitFor();
  await page.screenshot({ path: `${shots}/testnet-5-settings.png`, fullPage: true });
});
// M4: a treasury with this wallet in every role, funded from the wallet, allocated and attested.
await step('set up a treasury (all roles: this wallet)', async () => {
  await nav('Treasury');
  console.log(`    toast: ${await action('Set up a treasury', { '#desk-field-name': `E2E ${new Date().toISOString().slice(11, 16)}`, '#desk-field-cap': '500', '#desk-field-threshold': '100' })}`);
  await page.locator('.desk-workspace strong').filter({ hasText: 'E2E' }).waitFor({ timeout: 60_000 });
  console.log(`    workspace: ${await page.locator('.desk-workspace').innerText()}`.replace(/\s+/g, ' '));
});
await step('add 200 tUSDG to the treasury (standby, then cleared by the cron)', async () => {
  console.log(`    toast: ${await action('Add funds', { '#desk-field-asset': 'USDG', '#desk-field-amount': '200' })}`);
  for (let i = 0; i < 24 && (await cash()) === '$0.00'; i++) await page.waitForTimeout(10_000);
  console.log(`    treasury liquid ${await cash()}`);
  const ws = await page.locator('.desk-workspace strong').innerText();
  if (!ws.startsWith('E2E')) throw new Error(`workspace fell back to "${ws}"`);
  if ((await cash()) !== '$200.00') throw new Error(`treasury should hold exactly $200.00, shows ${await cash()}`);
});
await step('allocate 50 to the yield vault', async () => {
  console.log(`    toast: ${await action('Allocate', { '#desk-field-amount': '50' })} | liquid ${await cash()}`);
});
await step('prove solvency: covers 100 tUSDG', async () => {
  console.log(`    toast: ${await action('Prove solvency', { '#desk-field-amount': '100' })}`);
  await page.getByText(/Statement #\d+ proved/).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: `${shots}/testnet-treasury-ledger.png`, fullPage: true });
});
await step('treasury settings', async () => {
  await nav('Settings');
  await page.getByText('Treasury private address').waitFor();
  await page.screenshot({ path: `${shots}/testnet-6-treasury-settings.png`, fullPage: true });
});
// M6: the public Transparency view renders live aggregates.
await step('transparency view', async () => {
  await nav('Transparency');
  await page.getByRole('heading', { name: 'Credit desk health' }).waitFor({ timeout: 60_000 });
  await page.getByRole('heading', { name: 'Operations and governance' }).waitFor();
  console.log(`    ${(await page.locator('.desk-credit-summary').innerText()).replace(/\s+/g, ' ')}`);
  await page.screenshot({ path: `${shots}/testnet-9-transparency.png`, fullPage: true });
});
// M5: a payroll mandate from the treasury to this wallet's personal account, paid, then the
// receipt proof exported from the personal workspace and verified on-chain.
await step('treasury payments: create and pay a mandate', async () => {
  const me = zkAddress(deriveKeys(await account.signTypedData(keyRequest(chain.id))));
  await nav('Payments');
  console.log(`    toast: ${await action('Create mandate', { '#desk-field-recipient': me, '#desk-field-name': 'E2E payee', '#desk-field-cap': '20' })}`);
  const card = page.locator('.desk-mandate-card', { hasText: 'E2E payee' }).first();
  await card.waitFor({ timeout: 60_000 });
  console.log(`    toast: ${await action('Pay now', { '#desk-field-amount': '20' }, card)}`);
  await card.getByText(/Paid periods: 0/).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: `${shots}/testnet-7-payments.png`, fullPage: true });
});
await step('receipt: export a proof from the personal workspace and verify it', async () => {
  await nav('Settings');
  await page.selectOption('select[aria-label="Workspace"]', 'personal');
  await page.locator('.desk-workspace strong', { hasText: 'Testnet workspace' }).waitFor({ timeout: 60_000 });
  await nav('Activity');
  const row = page.getByRole('button', { name: /View Payment received under a mandate/ }).first();
  await row.waitFor({ timeout: 60_000 });
  await row.click();
  await page.getByLabel('Include amount').check();
  await page.fill('.desk-modal input[type="text"]', '0x000000000000000000000000000000000000ba4b');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByRole('button', { name: 'Export receipt proof' }).click()]);
  const record = JSON.parse(readFileSync(await download.path(), 'utf8'));
  const ok = await verifyReceipt(createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) }), record);
  console.log(`    receipt: amount ${record.proof.amount} disclosed, owner ${record.proof.owner}; on-chain verifyReceipt ${ok}`);
  if (!ok) throw new Error('receipt did not verify');
  await page.screenshot({ path: `${shots}/testnet-8-receipt.png`, fullPage: true });
});
console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'no page errors');
await browser.close();
