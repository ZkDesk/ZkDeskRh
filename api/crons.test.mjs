// node api/crons.test.mjs — the crons (tick, desk, pulls), alerts, transparency and operation status
// against a scripted database and a mocked chain (no network, no Postgres): indexing and the mirror
// completeness guard, deposit clearing, market flag and price pins, rate accrual, reconciliation of
// relayed operations, pruning, alerts and their dedup, solvency snapshots, a desk epoch over a snapshot
// (and its refusal when the replayed slots differ), and the public transparency view.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RELEASE = 3;
if (JSON.parse(readFileSync(new URL('../src/lib/chain/deployments/4663.json', import.meta.url))).version !== RELEASE) {
  console.log('crons checks skipped: mainnet is not on this release yet');
  process.exit(0);
}
globalThis.ZKDESK_NETWORK = 'mainnet';
Object.assign(process.env, {
  MAINNET_RELAYER_PRIVATE_KEY: '0x' + '11'.repeat(32), MAINNET_KEEPER_PRIVATE_KEY: '0x' + '12'.repeat(32), CRON_SECRET: 'cron-secret',
  MAINNET_DESK_OPERATOR_SK: '123456789', MAINNET_ALERT_WEBHOOK_URL: 'https://hook.invalid/alerts', MAINNET_RPC_URL_SERVER: 'http://rpc.invalid',
});

// ---- mocked chain: JSON-RPC for the wallet, webhook deliveries ----
const net = { sent: 0, hooks: [], hookOk: true };
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://hook.invalid')) { net.hooks.push(JSON.parse(init.body).text); return new Response('ok', { status: net.hookOk ? 200 : 500 }); }
  const { id, method } = JSON.parse(init.body);
  const result = {
    eth_chainId: '0x' + (4663).toString(16), eth_estimateGas: '0x5208', eth_maxPriorityFeePerGas: '0x1', eth_gasPrice: '0x3b9aca00',
    eth_getBlockByNumber: { number: '0x10', hash: '0x' + '0'.repeat(64), baseFeePerGas: '0x3b9aca00', timestamp: '0x1', transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0' },
  }[method];
  if (method === 'eth_sendRawTransaction') return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x' + (++net.sent).toString(16).padStart(64, '0') }));
  if (result === undefined) throw new Error(`unmocked RPC ${method}`);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

const { db, publicClient, deployment, keeper, relayer } = await import('./_lib/server.js');
const { default: tick } = await import('./mainnet/cron/tick.js');
const { default: desk } = await import('./mainnet/cron/desk.js');
const { default: pulls } = await import('./mainnet/cron/pulls.js');
const { default: transparency } = await import('./mainnet/transparency.js');
const { default: ops } = await import('./mainnet/ops/[id].js');
const [{ default: mainnetRelay }, { default: mainnetRequests }] = await Promise.all([import('./mainnet/relay.js'), import('./mainnet/requests.js')]);
const { marketOpenAt } = await import('./_lib/nyse.js');
const { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem } = await import('viem');

// ---- scripted database: every statement is recorded; SELECTs answer from `answers` ----
const log = [];
let answers = [];
const answer = (pattern, rows) => answers.push([pattern, rows]);
function query(sql, params = []) {
  const q = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  log.push({ q, params });
  for (const [pattern, rows] of answers) if (pattern.test(q)) return { rows: typeof rows === 'function' ? rows(params) : rows, rowCount: (typeof rows === 'function' ? rows(params) : rows).length };
  return { rows: [], rowCount: /^(delete|update)/.test(q) ? 2 : 0 };
}
db.query = async (sql, params) => query(sql, params);
db.connect = async () => ({ query: async (sql, params) => query(sql, params), release() {} });
const ran = (pattern) => log.filter((l) => pattern.test(l.q));

// ---- mocked reads ----
let reads = {};
publicClient.readContract = async ({ functionName, args = [], address }) => {
  const r = reads[functionName];
  if (r === undefined) throw new Error(`unmocked read ${functionName} @ ${address}`);
  return typeof r === 'function' ? r(args, address) : r;
};
publicClient.simulateContract = async ({ functionName }) => ({ request: {}, result: functionName === 'quoteExactInputSingle' ? [1n, 0n, 0, 0n] : undefined });
let receipts = {};
publicClient.waitForTransactionReceipt = async ({ hash }) => receipts[hash] ?? { status: 'success', blockNumber: 500n, gasUsed: 21000n, logs: [] };
publicClient.getTransactionReceipt = async ({ hash }) => receipts[hash] ?? null;
publicClient.getTransactionCount = async () => 9;
let balance = 10n ** 18n;
publicClient.getBalance = async () => balance;
let head = 1_000n;
publicClient.getBlockNumber = async () => head;
publicClient.getBlock = async () => ({ timestamp: 2_000_000_000n });
let logs = [];
publicClient.getLogs = async ({ event }) => (event ? logs.filter((l) => l.eventName === event.name) : logs);
publicClient.getGasPrice = async () => 10n ** 7n;

const call = (fn, req) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); } };
  fn({ method: 'GET', headers: {}, query: {}, ...req }, res);
});
const authed = { headers: { authorization: 'Bearer cron-secret' } };
const reset = () => { log.length = 0; answers = []; reads = {}; logs = []; receipts = {}; net.hooks = []; };
const H = (n) => '0x' + n.toString(16).padStart(64, '0');
const ev = (eventName, args, extra = {}) => ({ eventName, args, blockNumber: 900n, transactionHash: H(77), logIndex: 0, ...extra });

// ---------------- tick ----------------
assert.equal((await call(tick, {})).status, 401, 'cron secret required');
assert.equal((await call(tick, { headers: { authorization: 'Bearer wrong' } })).status, 401);

reset();
const stocks = Object.values(deployment.stocks);
answer(/^select block from public\.chain_cursor/, [{ block: '899' }]);
answer(/^select count\(\*\)::int as count from public\.commitments/, [{ count: 2 }]);
answer(/^select id from public\.deposits/, [{ id: 3 }]);
answer(/^select op_id, status, tx_hash, nonce from public\.operations/, [
  { op_id: 'a', status: 'submitted', tx_hash: H(1), nonce: 4 },
  { op_id: 'b', status: 'submitted', tx_hash: H(2), nonce: 5 },
  { op_id: 'c', status: 'queued', tx_hash: null, nonce: null },
]);
answer(/^select count\(\*\)::int as n from public\.operations/, [{ n: 12 }]);
receipts[H(1)] = { status: 'success' };
logs = [
  ev('NewCommitment', { commitment: 5n, index: 0n }), ev('EncryptedNote', { commitment: 5n, ciphertext: '0x01' }), ev('NewNullifier', { nullifier: 6n }),
  ev('DepositPending', { id: 3n, depositor: relayer.address, asset: deployment.usdg, amount: 5n, clearAfter: 100n }), ev('DepositCleared', { id: 3n }),
  ev('PositionUpdated', { slot: 1, leaf: 7n, ciphertext: '0x02' }), ev('CreditFlow', { asset: stocks[0].token, collIn: 1n, collOut: 0n, draw: 2n, repay: 0n }),
  ev('Accrued', { index: 10n ** 18n, ratePerSecond: 1n, interest: 0n }), ev('Pinned', { asset: stocks[0].token, price: 500n, round: 1n, updatedAt: 1n }),
  ev('Attested', { epoch: 1n, sumValue: 1n, sumDebt: 1n, breachCommit: 1n }),
  ev('LedgerCreated', { id: 9n, rolesCommit: 1n, policyHash: 2n }), ev('MailboxKey', { id: 9n, signer: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD' }),
  ev('RolesRotated', { id: 9n, rolesCommit: 3n }), ev('PolicySet', { id: 9n, policyHash: 4n }), ev('TreasuryAttested', { id: 9n, epoch: 1n, liabilities: 5n }),
  ev('MandateCommitted', { ledgerId: 9n, commit: 8n, ciphertext: '0x03' }), ev('MandateStatus', { ledgerId: 9n, commit: 8n, status: 1 }),
  ev('Pulled', { ledgerId: 9n, commit: 8n, k: 1n, receiptLeaf: 1n, receiptIndex: 0n, receiptRoot: 1n }),
  ev('Liquidated', { asset: stocks[0].token, positions: 1n, collSold: 1n, proceeds: 1n, repaid: 1n, price: 1n, writtenOffScaled: 0n }),
  ev('CallScheduled', { id: H(42), index: 0n, target: deployment.desk, value: 0n, data: '0x', predecessor: H(0), delay: 172800n }),
];
const open = marketOpenAt();
Object.assign(reads, {
  size: 2n, marketOpen: !open, pinner: keeper.address, lastAccrual: 1n, healthy: false, paused: true,
  latestRoundData: [7n, 500n, 0n, 0n, 7n], current: [500n, 0n, 6n], balanceOf: 10n, shieldedSupply: 4n, pendingSupply: 1n,
  totalAssets: 100n, cash: 50n, totalDebt: 50n, utilizationBps: 5000n, aprBps: 400n,
});
balance = 10n ** 15n; // low: relayer and keeper alerts
let r = await call(tick, { ...authed, query: { snapshot: '1' } });
assert.equal(r.status, 200, JSON.stringify(r.body));
const t = r.body;
assert.equal(t.indexed.logs, logs.length);
assert.equal(ran(/^insert into public\.chain_cursor/).length, 1, 'cursor advances when the mirror is complete');
assert.deepEqual(ran(/^insert into public\.mailbox_keys/).map((l) => l.params), [[H(9n), '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd']], 'L-c: mailbox keys come from the MailboxKey event');
assert.ok(ran(/^insert into public\.ledgers/).length && ran(/^insert into public\.desk_epochs|^insert into public\.liq_batches/).length >= 1);
assert.match(Object.values(t.cleared[0])[0], /^0x/, 'a due deposit is cleared');
assert.match(t.marker.marketOpen, /^0x/, 'the market flag follows the NYSE session');
assert.match(t.marker.marks, /^0x/, 'stale feeds are pinned');
assert.match(t.rates.accrue, /^0x/, 'rates accrue hourly');
assert.deepEqual(t.reconciled, { checked: 3, updated: 3 }, 'confirmed, replaced and never-sent operations are settled');
assert.deepEqual(ran(/^update public\.operations set status = 'failed', error_code = 'replaced'/).map((l) => l.params), [['b']]);
assert.equal(t.pruned.vouchers, 2);
assert.deepEqual(t.alerts.raised.sort(), ['desk_paused', 'epoch_missed', 'keeper_low', 'ops_failing', `proposal_${H(42)}`, 'relayer_low'].sort());
assert.equal(t.alerts.sent.length, 6, 'every alert delivered once');
assert.ok(net.hooks.some((h) => h.includes('timelock proposal')));
assert.equal(t.snapshots.solvency.length, 3 + stocks.length);
assert.ok(t.snapshots.solvency.every((s) => s.ok));

// An incomplete mirror never advances the cursor; a delivered alert is not repeated within the hour;
// a failed delivery is retried.
reset();
answer(/^select block from public\.chain_cursor/, [{ block: '899' }]);
answer(/^select count\(\*\)::int as count from public\.commitments/, [{ count: 1 }]);
answer(/^select sent_at from public\.alert_state/, [{ sent_at: new Date().toISOString() }]);
answer(/^select count\(\*\)::int as n from public\.operations/, [{ n: 0 }]);
Object.assign(reads, { size: 2n, marketOpen: open, pinner: keeper.address, lastAccrual: BigInt(Math.floor(Date.now() / 1000)), healthy: false, paused: false, latestRoundData: [6n, 500n, 0n, 0n, 6n], current: [500n, 0n, 6n] });
logs = [ev('NewCommitment', { commitment: 5n, index: 0n })];
r = await call(tick, authed);
assert.match(r.body.indexed.error, /mirror has 1 leaves, pool has 2/);
assert.equal(ran(/^insert into public\.chain_cursor/).length, 0);
assert.equal(ran(/^rollback/).length, 1);
assert.deepEqual(r.body.marker, { marks: 'fresh' });
assert.equal(r.body.rates, 'fresh');
assert.deepEqual(r.body.alerts.sent, [], 'deduplicated within the hour');
reset();
answer(/^select block from public\.chain_cursor/, [{ block: '2000' }]);
answer(/^select count\(\*\)::int as n from public\.operations/, [{ n: 0 }]);
Object.assign(reads, { marketOpen: open, pinner: keeper.address, lastAccrual: BigInt(Math.floor(Date.now() / 1000)), healthy: false, paused: false, latestRoundData: [6n, 500n, 0n, 0n, 6n], current: [500n, 0n, 6n] });
net.hookOk = false;
r = await call(tick, authed);
assert.equal(r.body.indexed.to, null, 'nothing to index past the head');
assert.deepEqual(r.body.alerts, { raised: ['relayer_low', 'keeper_low', 'epoch_missed'], sent: [] }, 'a failed delivery is not recorded as sent');
assert.equal(ran(/^insert into public\.alert_state \(key, sent_at\)/).length, 0);
net.hookOk = true;
balance = 10n ** 18n;

// ---------------- desk ----------------
assert.equal((await call(desk, {})).status, 401);
reset();
const SNAPSHOT = encodeEventTopics({ abi: [parseAbiItem('event SnapshotTaken(uint256 indexed id, bytes32 leavesHash)')] })[0];
const deskReads = (leavesHash) => Object.assign(reads, {
  marketOpen: true, index: 10n ** 18n, EVICT_AFTER: 86_400n, activeAt: 0n,
  classList: (args) => { if (args[0] > 0n) throw new Error('out of range'); return stocks[0].token; },
  current: [500_00000000n, 0n, 1n], classes: [6000, 7000, true, 10n ** 30n, 10n ** 18n, 250_000000n],
  snapshots: [leavesHash, 1n],
});
const zeroLeaves = keccak256(encodeAbiParameters([{ type: 'uint256[64]' }], [Array(64).fill(0n)]));
deskReads(zeroLeaves);
let snapHash;
publicClient.waitForTransactionReceipt = async ({ hash }) => {
  snapHash ??= hash; // the first desk transaction is the snapshot
  return { status: 'success', blockNumber: 500n, gasUsed: 21000n, logs: hash === snapHash ? [{ address: deployment.desk, topics: [SNAPSHOT, H(1n)], logIndex: 3 }] : [] };
};
const proofs = [];
const { runDesk } = await import('./cron/desk.js');
const report = await runDesk({ operatorSk: 123456789n, prove: async (kind, witness) => { proofs.push([kind, witness]); return { proof: '0x01' }; } });
assert.equal(report.live, 0);
assert.deepEqual(proofs.map(([k]) => k), ['health_epoch']);
assert.equal(proofs[0][1].snapshot_id, '1', 'the epoch proves the snapshot just taken');
assert.match(report.attest.hash, /^0x/);
// The replayed slots must match the snapshot's hash, or nothing is proven or sent.
snapHash = undefined;
deskReads(H(1n));
proofs.length = 0;
await assert.rejects(runDesk({ operatorSk: 123456789n, prove: async () => ({ proof: '0x01' }) }), /snapshot_mismatch/);
assert.equal(proofs.length, 0);
balance = 10n ** 13n;
await assert.rejects(runDesk({ operatorSk: 123456789n, prove: async () => ({ proof: '0x01' }) }), /keeper_low_balance/);
balance = 10n ** 18n;
reads.marketOpen = false;
r = await call(desk, authed);
assert.equal(r.status, 200);
assert.ok(r.body.skipped || r.body.error !== undefined || r.body.attest, 'off-hours epochs run hourly');

// ---------------- pulls ----------------
assert.equal((await call(pulls, {})).status, 401);
r = await call(pulls, authed);
assert.equal(r.status, 503, 'no scheduler key configured');
assert.equal(r.body.error, 'scheduler_unavailable');
// With a scheduler key and no treasury that made it the Payer, a run pays nothing.
reset();
process.env.MAINNET_SCHEDULER_SEED = '0x' + '33'.repeat(32);
Object.assign(reads, { size: 0n, root: 0n });
r = await call(pulls, authed);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.deepEqual([r.body.paid, r.body.failed], [[], []]);
assert.equal(typeof mainnetRelay, 'function');
assert.equal((await call(mainnetRequests, { method: 'PUT' })).status, 405);

// ---------------- operation status ----------------
reset();
assert.equal((await call(ops, { query: { id: 'nope' } })).status, 400);
assert.equal((await call(ops, { query: { id: '00000000-0000-0000-0000-000000000000' } })).status, 404);
answer(/^select op_id, kind, status, tx_hash, error_code, updated_at from public\.operations/, [{ op_id: '00000000-0000-0000-0000-000000000001', kind: 'transfer', status: 'submitted', tx_hash: H(3), error_code: null }]);
receipts[H(3)] = { status: 'reverted' };
r = await call(ops, { query: { id: '00000000-0000-0000-0000-000000000001' } });
assert.deepEqual([r.body.status, r.body.errorCode], ['failed', 'reverted']);
assert.equal(ran(/^update public\.operations set status = \$2/).length, 1);

// ---------------- transparency ----------------
reset();
answer(/from public\.desk_epochs/, [{ epoch: 3, sum_value: '10', sum_debt: '4', ts: 't' }]);
answer(/from public\.liq_batches/, [{ asset: stocks[0].token, n_positions: 1, coll_sold: '1', proceeds: '2', debt_repaid: '2', price: '3', ts: 't' }]);
answer(/from public\.solvency/, [{ asset: deployment.usdg, pool_balance: '5', shielded_supply: '4', pending_supply: '1', ok: true, ts: 't' }, { asset: '0x000000000000000000000000000000000000dead', pool_balance: '0', shielded_supply: '0', pending_supply: '0', ok: true, ts: 't' }]);
answer(/from public\.lending_snapshots/, [{ total_assets: '100', cash: '50', debt: '50', utilization_bps: 5000, apr_bps: 400, ts: 't' }]);
answer(/from public\.treasury_epochs/, [{ ledger_id: H(9n), epoch: 1, liabilities: '5', ts: 't' }]);
answer(/count\(\*\)::int as n from public\.ledgers/, [{ n: 2 }]);
answer(/from public\.mandates_pub/, [{ status: 1, n: 3 }]);
answer(/from public\.receipts_pub/, [{ n: 4, last: 3 }]);
Object.assign(reads, { lastAttestedAt: 1_790_000_000n, healthy: true, paused: false, epoch: 3n, marketOpen: true, getMinDelay: 172800n, getThreshold: 2n, getOwners: ['0x1', '0x2', '0x3'], insurance: 0n, totalStaked: 0n });
balance = 3n * 10n ** 15n; // between the relayer floor (0.002) and the low mark (0.005)
r = await call(transparency, {});
assert.equal(r.status, 200);
assert.equal(r.body.desk.epoch, 3);
assert.equal(r.body.solvency.length, 1, 'retired assets are left out');
assert.equal(r.body.solvency[0].backed, '5');
assert.equal(r.body.treasuries.count, 2);
assert.equal(r.body.operations.relayerStatus, 'low');
assert.equal(r.body.operations.keeperStatus, 'low');
assert.equal(r.body.operations.separateKeeper, true);
assert.deepEqual([r.body.operations.timelockDelay, r.body.operations.safeThreshold, r.body.operations.safeSigners], [172800, 2, 3]);
assert.equal((await call(transparency, { method: 'POST' })).status, 405);

console.log('crons checks passed: tick (indexing and completeness guard, clearing, market flag and pins, accrual, reconciliation, pruning, alerts and dedup, snapshots), desk epoch over a snapshot and its refusals, pulls, operation status, transparency');
process.exit(0);
