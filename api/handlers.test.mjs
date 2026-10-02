// node api/handlers.test.mjs — the relay and mailbox handlers end to end against an in-memory
// database and a mocked chain (no network, no Postgres): operation lifecycle, duplicate requests,
// note claims (audit N-2), simulation and in-lock re-simulation failures, nonce handling, fee and
// balance floors, uncertain sends, and every mailbox outcome.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run against the network this app release speaks to.
const RELEASE = 3;
const onMainnet = JSON.parse(readFileSync(new URL('../src/lib/chain/deployments/4663.json', import.meta.url))).version === RELEASE;
globalThis.ZKDESK_NETWORK = onMainnet ? 'mainnet' : 'testnet';
const prefix = onMainnet ? 'MAINNET_' : '';
process.env[`${prefix}RELAYER_PRIVATE_KEY`] = '0x' + '11'.repeat(32);
delete process.env[`${prefix}KEEPER_PRIVATE_KEY`];
process.env[`${prefix}RPC_URL_SERVER`] = 'http://rpc.invalid';

// ---- mocked chain: JSON-RPC over fetch for the wallet; client methods patched below ----
const rpc = { sent: [], sendError: null };
globalThis.fetch = async (_url, init) => {
  const { id, method } = JSON.parse(init.body);
  const result = {
    eth_chainId: '0x' + (onMainnet ? 4663 : 46630).toString(16),
    eth_estimateGas: '0x5208',
    eth_maxPriorityFeePerGas: '0x1',
    eth_gasPrice: '0x3b9aca00',
    eth_getBlockByNumber: { number: '0x10', hash: '0x' + '0'.repeat(64), baseFeePerGas: '0x3b9aca00', timestamp: '0x1', transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0' },
  }[method];
  if (method === 'eth_sendRawTransaction') {
    if (rpc.sendError) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: rpc.sendError } }));
    rpc.sent.push(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x' + rpc.sent.length.toString(16).padStart(64, '0') }));
  }
  if (result === undefined) throw new Error(`unmocked RPC ${method}`);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

const { default: relay } = await import('./relay.js');
const { default: requests } = await import('./requests.js');
const { db, publicClient, relayer, deployment } = await import('./_lib/server.js');
const { mailboxMessages } = await import('../src/lib/zk/ledger.js');
const { NOTE_CIPHERTEXT_BYTES } = await import('../src/lib/zk/crypto.js');
const { privateKeyToAccount } = await import('viem/accounts');
assert.ok(deployment.version === RELEASE, 'deployment is on this release');

// ---- in-memory database: just the statements the handlers issue ----
const mem = { ops: new Map(), spends: new Map(), nonce: null, vouchers: [], mailbox: new Map(), posts: [], log: [] };
let nextOp = 1;
const ops = () => [...mem.ops.values()];
function query(sql, p = []) {
  const q = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  mem.log.push(q.split(' ').slice(0, 3).join(' '));
  const rows = (r = []) => ({ rows: r, rowCount: r.length });
  if (/^(begin|commit|rollback)$/.test(q)) return rows();
  if (q.startsWith('insert into public.operations')) {
    const old = mem.ops.get(p[0]);
    if (old && old.status !== 'failed') return rows();
    const op = old ? Object.assign(old, { status: 'queued', error_code: null }) : { op_id: nextOp++, intent_hash: p[0], kind: p[1], status: 'queued', error_code: null, tx_hash: null };
    mem.ops.set(p[0], op);
    return rows([{ op_id: op.op_id }]);
  }
  if (q.startsWith('select op_id, status, tx_hash, error_code from public.operations')) return rows([mem.ops.get(p[0])]);
  if (q.startsWith('update public.operations')) {
    const op = ops().find((o) => o.op_id === p[0]);
    if (q.includes("status = 'submitted'")) Object.assign(op, { status: 'submitted', tx_hash: p[1], nonce: p[2] });
    else if (q.includes("status = 'failed'")) Object.assign(op, { status: 'failed', error_code: p[1] });
    else if (q.includes('status = $2')) Object.assign(op, { status: p[1], error_code: p[2] });
    else Object.assign(op, { error_code: p[1] });
    return rows();
  }
  if (q.startsWith('delete from public.pending_spends where nullifier')) {
    const done = new Set(ops().filter((o) => ['confirmed', 'failed', 'replaced'].includes(o.status)).map((o) => o.op_id));
    for (const n of p[0]) if (done.has(mem.spends.get(n))) mem.spends.delete(n);
    return rows();
  }
  if (q.startsWith('insert into public.pending_spends')) {
    const got = p[0].filter((n) => !mem.spends.has(n));
    for (const n of got) mem.spends.set(n, p[1]);
    return rows(got.map((nullifier) => ({ nullifier })));
  }
  if (q.startsWith('delete from public.pending_spends where op_id')) {
    for (const [n, op] of mem.spends) if (op === p[0]) mem.spends.delete(n);
    return rows();
  }
  if (q.startsWith('select next_nonce from public.relayer_state')) return rows([{ next_nonce: mem.nonce }]);
  if (q.startsWith('update public.relayer_state')) {
    mem.nonce = p[0];
    return rows();
  }
  if (q.startsWith('select signer from public.mailbox_keys')) return rows(mem.mailbox.has(p[0]) ? [{ signer: mem.mailbox.get(p[0]) }] : []);
  if (q.startsWith('insert into public.mailbox_keys')) {
    if (!mem.mailbox.has(p[0])) mem.mailbox.set(p[0], p[1]);
    return rows();
  }
  if (q.startsWith('select count(*)::int as n from public.approval_requests')) return rows([{ n: mem.posts.filter((x) => x.ledger === p[0]).length }]);
  if (q.startsWith('insert into public.approval_requests')) {
    if (mem.posts.some((x) => x.ledger === p[0] && x.ct === p[1])) return rows();
    mem.posts.push({ id: mem.posts.length + 1, ledger: p[0], ct: p[1] });
    return rows([{ id: mem.posts.length }]);
  }
  if (q.startsWith('select id, ciphertext, created_at from public.approval_requests')) return rows(mem.posts.filter((x) => x.ledger === p[0]).map((x) => ({ id: x.id, ciphertext: x.ct, created_at: 'now' })));
  throw new Error(`unmocked SQL: ${q}`);
}
db.query = async (sql, p) => query(sql, p);
db.connect = async () => ({ query: async (sql, p) => query(sql, p), release() {} });

// ---- mocked reads ----
const chain = { balance: 10n ** 18n, pendingCount: 5, simulate: () => ({ request: {} }), resimulate: null, receipt: 'success', rolesCommit: 9n };
let simCalls = 0;
publicClient.getBalance = async () => chain.balance;
publicClient.getGasPrice = async () => 10n ** 7n;
publicClient.getTransactionCount = async () => chain.pendingCount;
publicClient.simulateContract = async (args) => {
  if (args.functionName === 'quoteExactInputSingle') return { result: [3n * 10n ** 9n] };
  simCalls++;
  if (chain.resimulate && simCalls % 2 === 0) throw chain.resimulate; // the second simulation: inside the nonce lock
  return chain.simulate(args);
};
publicClient.waitForTransactionReceipt = async () => (chain.receipt ? { status: chain.receipt, blockNumber: 17n } : Promise.reject(new Error('timeout')));
publicClient.readContract = async ({ functionName, args }) => {
  if (functionName === 'previewDeposit') return args[0] * 10n ** 6n;
  if (functionName === 'current') return [500_00000000n, 0n, 1n];
  if (functionName === 'ledgers') return [chain.rolesCommit, 1n, 0n];
  throw new Error(`unmocked read ${functionName}`);
};

const call = (fn, req) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); } };
  fn(req, res);
});
const post = (body) => call(relay, { method: 'POST', body: JSON.parse(JSON.stringify(body)) });
const ZERO = '0x0000000000000000000000000000000000000000';
const notes = { encryptedOutput1: '0x' + 'ab'.repeat(NOTE_CIPHERTEXT_BYTES), encryptedOutput2: '0x' + 'ab'.repeat(NOTE_CIPHERTEXT_BYTES) };
let n = 100;
const transfer = (a = ++n, b = ++n, fee = '1000000') => ({
  kind: 'transact',
  proof: { proof: '0x' + 'ab'.repeat(100), root: '1', publicAmount: '0', extDataHash: '2', asset: deployment.usdg, outAsset: deployment.usdg, publicAmountOut: '0', inputNullifiers: [String(a), String(b)], outputCommitments: ['21', '22'] },
  ext: { recipient: ZERO, extAmount: '0', relayer: relayer.address, fee, converter: ZERO, ...notes },
});

// GET: quotes and availability.
let r = await call(relay, { method: 'GET' });
assert.equal(r.status, 200);
assert.equal(r.body.available, true);
assert.ok(BigInt(r.body.minFee) > 0n && r.body.fees[deployment.usdg.toLowerCase()] === r.body.minFee);
const minFee = BigInt(r.body.minFee);

// A relayed transfer: queued -> submitted -> confirmed, nonce past the chain's pending count, claims released.
r = await post(transfer(1, 2, String(minFee)));
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.status, 'confirmed');
assert.equal(rpc.sent.length, 1, 'one broadcast');
assert.equal(mem.nonce, 6, 'nonce = max(stored, pending count) + 1');
assert.equal(mem.spends.size, 0, 'note claims released once final');
assert.equal(ops()[0].status, 'confirmed');

// The same spend again: the recorded operation, never a second broadcast.
r = await post(transfer(1, 2, String(minFee)));
assert.equal(r.body.duplicate, true);
assert.equal(r.body.status, 'confirmed');
assert.equal(rpc.sent.length, 1);

// N-2: while an operation is in flight (no receipt yet), another request spending one of its notes is
// refused before simulation, at no gas cost.
chain.receipt = null;
r = await post(transfer(3, 4, String(minFee)));
assert.equal(r.status, 202);
assert.equal(r.body.status, 'submitted');
const sims = simCalls;
r = await post(transfer(3, 99, String(minFee)));
assert.equal(r.status, 409);
assert.equal(r.body.errorCode, 'spend_in_flight');
assert.equal(simCalls, sims, 'refused before simulation');
assert.equal(rpc.sent.length, 2);
chain.receipt = 'success';

// A reverting simulation fails the operation and frees its notes; a retry of the same spend may run.
chain.simulate = () => { throw Object.assign(new Error('x'), { shortMessage: 'NullifierSpent' }); };
r = await post(transfer(5, 6, String(minFee)));
assert.equal(r.status, 422);
assert.equal(r.body.errorCode, 'NullifierSpent');
assert.equal([...mem.spends.keys()].some((k) => BigInt(k) === 5n), false, 'claims released');
chain.simulate = () => ({ request: {} });
r = await post(transfer(5, 6, String(minFee)));
assert.equal(r.body.status, 'confirmed', 'a failed operation can be retried');

// A spend that lands while this one waits for the nonce lock is caught by the in-lock re-simulation:
// nothing is broadcast and the nonce does not move.
const sent = rpc.sent.length;
const nonce = mem.nonce;
simCalls = 0;
chain.resimulate = Object.assign(new Error('x'), { shortMessage: 'NullifierSpent' });
r = await post(transfer(7, 8, String(minFee)));
assert.equal(r.status, 422);
assert.equal(r.body.errorCode, 'NullifierSpent');
assert.equal(rpc.sent.length, sent);
assert.equal(mem.nonce, nonce);
chain.resimulate = null;

// Fee floor, relayer balance floor.
r = await post(transfer(9, 10, String(minFee - 1n)));
assert.equal(r.status, 402);
assert.equal(r.body.error, 'fee_too_low');
chain.balance = 10n ** 14n;
r = await post(transfer(11, 12, String(minFee)));
assert.equal(r.status, 503);
assert.equal(r.body.error, 'relayer_unavailable');
chain.balance = 10n ** 18n;

// A send whose outcome is unknown stays queued for the reconciler; it is never resent blindly.
rpc.sendError = 'connection reset';
r = await post(transfer(13, 14, String(minFee)));
assert.equal(r.status, 502);
assert.equal(r.body.errorCode, 'send_uncertain');
assert.equal(ops().find((o) => o.op_id === r.body.opId).status, 'queued');
rpc.sendError = null;
r = await post(transfer(13, 14, String(minFee)));
assert.equal(r.body.duplicate, true, 'the uncertain operation is not re-sent');
assert.equal(r.status, 200);

// ---- mailbox ----
const id = '0x' + 'ee'.repeat(32);
const key = privateKeyToAccount('0x' + '22'.repeat(32));
const ct = '0x' + 'cd'.repeat(40);
const signed = async (c = ct, k = key) => ({ ledgerId: id, ciphertext: c, signature: await k.signMessage({ message: mailboxMessages.post(id, c) }) });
chain.rolesCommit = 0n;
r = await call(requests, { method: 'POST', body: await signed() });
assert.equal(r.status, 404, 'unknown treasury');
chain.rolesCommit = 9n;
r = await call(requests, { method: 'POST', body: await signed() });
assert.equal(r.status, 409, 'no mailbox key registered');
mem.mailbox.set(id, key.address.toLowerCase());
r = await call(requests, { method: 'POST', body: await signed(ct, privateKeyToAccount('0x' + '33'.repeat(32))) });
assert.equal(r.status, 401, 'signed by another key');
r = await call(requests, { method: 'POST', body: await signed() });
assert.equal(r.status, 200);
assert.equal(r.body.duplicate, false);
r = await call(requests, { method: 'POST', body: await signed() });
assert.equal(r.body.duplicate, true);
for (let i = 1; i < 50; i++) await call(requests, { method: 'POST', body: await signed('0x' + i.toString(16).padStart(4, '0')) });
r = await call(requests, { method: 'POST', body: await signed('0xbeef') });
assert.equal(r.status, 429, 'per-day cap');
r = await call(requests, { method: 'GET', query: { ledger: id } });
assert.equal(r.body.requests.length, 50);

console.log('handler checks passed: relay lifecycle, duplicates, in-flight note claims, simulation and in-lock re-simulation failures, nonces, fee and balance floors, uncertain sends, mailbox outcomes');
process.exit(0);
