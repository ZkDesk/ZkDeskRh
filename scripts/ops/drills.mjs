// Failure drills: each dependency down (or a relayed tx replaced) must produce a truthful state.
//   relayer down   -> relay GET says unavailable, POST 503; the client refuses with a clear message
//   operator down  -> the desk cron answers 503 (draws halt on-chain after two missed epochs)
//   RPC down       -> sync fails with the "not reachable (RPC)" message
//   replaced tx    -> the reconciler marks a submitted op whose nonce was used elsewhere as failed
//   browser        -> (with PLAYWRIGHT) relay 503 and RPC down render as messages, not crashes
// Usage: node scripts/ops/drills.mjs [baseUrl] [shotDir]      (PLAYWRIGHT=<file URL> for the browser part)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const [base = 'https://zkdesk.tech', shots = '.'] = process.argv.slice(2);
const { chain } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { createClient, friendly } = await import('../../src/lib/zk/client.js');
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };

// Handlers run in a child process so a secret can be withheld from its environment.
function handlerIn(env, file, req) {
  const code = `const { default: h } = await import(${JSON.stringify(new URL(`../../${file}`, import.meta.url).href)});
    h(${JSON.stringify(req)}, { statusCode: 200, setHeader() {}, end(b) { console.log(JSON.stringify({ status: this.statusCode, body: JSON.parse(b) })); process.exit(0); } });`;
  const out = execFileSync('node', ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1));
}

// 1. Relayer down.
{
  const env = { RELAYER_PRIVATE_KEY: '' };
  const get = handlerIn(env, 'api/relay.js', { method: 'GET' });
  const post = handlerIn(env, 'api/relay.js', { method: 'POST', body: { kind: 'transact', proof: {}, ext: {} } });
  check('relayer down: GET reports unavailable', get.body.available === false);
  check('relayer down: POST answers 503', post.status === 503 && post.body.error === 'relayer_unavailable');
  const keys = deriveKeys(await privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY).signTypedData(keyRequest(chain.id)));
  const client = createClient({ publicClient: createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) }), keys, prove: null, relay: async () => get.body });
  const err = await client.send({ amount: 1n, recipient: '0x000000000000000000000000000000000000dEaD' }).then(() => null, (e) => e.message);
  check('relayer down: the client refuses clearly', /relayer is unavailable/.test(err ?? ''), err);
}

// 2. Desk operator down.
{
  const r = handlerIn({ DESK_OPERATOR_SK: '' }, 'api/cron/desk.js', { method: 'GET', query: { force: '1' }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  check('operator down: the desk cron answers 503 (no epoch is faked)', r.status === 503 && r.body.error === 'desk_operator_unavailable');
}

// 3. RPC down.
{
  const keys = deriveKeys('0x' + '0d'.repeat(65));
  const client = createClient({ publicClient: createPublicClient({ chain, transport: http('http://127.0.0.1:9', { retryCount: 0 }) }), keys, prove: null, relay: null });
  const err = await client.sync().then(() => null, (e) => friendly(e.shortMessage || e.message));
  check('RPC down: sync fails with the RPC message', /not reachable.*\(RPC\)/.test(err ?? ''), err);
}

// 4. Replaced relayed transaction.
{
  const { db } = await import('../../api/_lib/server.js');
  const intent = keccak256(toHex(randomBytes(32)));
  const { rows: [op] } = await db.query(`insert into public.operations (intent_hash, kind, status, tx_hash, nonce, updated_at) values ($1, 'drill', 'submitted', $2, 0, now() - interval '5 minutes') returning op_id`, [intent, toHex(randomBytes(32))]);
  const tick = await import('../../api/cron/tick.js');
  await new Promise((resolve) => tick.default({ method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, { statusCode: 200, setHeader() {}, end: resolve }));
  const { rows: [after] } = await db.query('select status, error_code from public.operations where op_id = $1', [op.op_id]);
  await db.query('delete from public.operations where op_id = $1', [op.op_id]);
  check('replaced tx: the reconciler marks it failed', after.status === 'failed' && after.error_code === 'replaced', `${after.status}/${after.error_code} -> "${friendly(after.error_code)}"`);
}

// 5. Browser states.
if (process.env.PLAYWRIGHT) {
  const { chromium } = await import(process.env.PLAYWRIGHT);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.ethereum = { isMetaMask: true, request: async ({ method }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x000000000000000000000000000000000000dEaD']; if (method === 'eth_chainId') return '0xb626'; if (method === 'eth_signTypedData_v4') return '0x' + 'ab'.repeat(65); return null; }, on() {}, removeListener() {} };
  });
  await page.route('**/rpc.testnet.chain.robinhood.com/**', (route) => route.abort());
  await page.goto(`${base}/dashboard?mode=testnet&view=treasury`, { waitUntil: 'networkidle' });
  const isolated = await page.evaluate(() => self.crossOriginIsolated);
  check('dashboard is cross-origin isolated (multithreaded proving)', isolated === true);
  await page.getByRole('button', { name: 'Connect MetaMask' }).click();
  await page.getByText(/not reachable.*\(RPC\)/).first().waitFor({ timeout: 60_000 }).then(() => check('browser, RPC down: the page says so', true), () => check('browser, RPC down: the page says so', false));
  await page.screenshot({ path: `${shots}/drill-rpc-down.png`, fullPage: true });
  check('browser: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

console.log(failed ? `${failed} drill(s) failed` : 'all drills passed');
process.exitCode = failed ? 1 : 0;
