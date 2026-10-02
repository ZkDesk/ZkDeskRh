// node agent/agent.test.mjs — agent keys, the per-transaction guard, MCP protocol handling and a real
// stdio session. No network: every call checked here fails or answers before any chain read.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIELD } from '../src/lib/zk/notes.js';
import { agentKeys, deriveKeys, passkeyKeys, zkAddress, parseZkAddress } from '../src/lib/zk/keys.js';
import { createHandler, TOOLS } from './mcp.mjs';
import { createAgent, newSeed, receivedNotes, spendLog } from './index.mjs';
import { paymentLink, readPaymentLink } from '../src/lib/zk/request-link.js';

// Keys: deterministic, one account per chain, never the passkey or signature account of the same bytes.
const seed = '0x' + '5a'.repeat(32);
assert.equal(agentKeys(seed, 4663).sk, agentKeys(seed, 4663).sk);
assert.notEqual(agentKeys(seed, 4663).sk, agentKeys(seed, 46630).sk);
assert.notEqual(agentKeys(seed, 4663).sk, passkeyKeys(seed, 4663).sk);
assert.notEqual(agentKeys(seed, 4663).sk, deriveKeys(seed).sk);
const k = agentKeys(seed, 4663);
assert.deepEqual(parseZkAddress(zkAddress(k)), { owner: k.owner, encPub: k.encPub });
assert.equal(parseZkAddress(zkAddress({ owner: k.owner + FIELD, encPub: k.encPub })), null, 'no address aliases above the field');
assert.match(newSeed(), /^0x[0-9a-f]{64}$/);
assert.notEqual(newSeed(), newSeed());

// SDK: bad seeds, amounts, addresses and the per-transaction limit are refused before any proof.
await assert.rejects(createAgent({ seed: '0x12' }), /32 bytes of hex/);
await assert.rejects(createAgent({ seed, network: 'devnet' }), /mainnet" or "testnet/);
const stateDir = mkdtempSync(join(tmpdir(), 'zkdesk-agent-'));
const agent = await createAgent({ seed, network: 'mainnet', maxPerTx: '50', stateDir });
// A receipt is checked only against ZKdesk's own registry on this chain, whatever contract the record
// names (a forged one could answer true). Refused before any chain read.
await assert.rejects(agent.verifyReceipt({ registry: '0x' + 'de'.repeat(20), chainId: 4663, proof: {} }), /not ZKDesk's MandateRegistry/);
await assert.rejects(agent.verifyReceipt({ chainId: 46630, proof: {} }), /another network/);
// A receipt made out to someone else (or to anyone) is refused for an expected verifier, before any chain read.
await assert.rejects(agent.verifyReceipt({ chainId: 4663, proof: { verifier: '5' } }, { expectedVerifier: '0x6' }), /made out to verifier 0x5, not 0x6/);
await assert.rejects(agent.verifyReceipt({ chainId: 4663, proof: { verifier: '0' } }, { expectedVerifier: 6n }), /made out to anyone/);
await assert.rejects(agent.verifyReceipt({ chainId: 4663, proof: { verifier: '5' } }, { expectedVerifier: 'me' }), /expectedVerifier must be/);
for (const empty of ['', ' ', '0', '0x0', 0, '5', '0b101']) await assert.rejects(agent.verifyReceipt({ chainId: 4663, proof: { verifier: '0' } }, { expectedVerifier: empty }), /non-zero 0x address/, `"${empty}" does not switch the check off`);
await assert.rejects(agent.verifyReceipt({ chainId: 4663, proof: { verifier: '5' } }, { expectedVerifier: agent.address }), /not a zkd: address/);
await assert.rejects((await import('../src/lib/zk/client.js')).verifyReceipt({ chain: { id: 46630 } }, { proof: {} }), /client on chain 4663\./);
// The TypeScript declarations name every method and export (pnpm test:types checks they compile).
{
  const dts = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const members = dts('./index.d.mts').match(/export interface Agent \{([\s\S]*?)\n\}/)[1].match(/^  (\w+)[(:]/gm).map((m) => m.slice(2, -1));
  assert.deepEqual(members.sort(), Object.keys(agent).sort(), 'Agent in index.d.mts lists every method');
  const fields = (name) => dts('./index.d.mts').match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))[1].match(/^  (\w+)\??:/gm).map((m) => m.slice(2).replace(/\??:$/, '')).sort();
  const link = paymentLink('https://zkdesk.tech', { to: agent.address, amount: '1', memo: 'hi', network: 'mainnet' }).toString();
  assert.deepEqual(Object.keys(agent.readLink(link)).sort(), fields('PaymentLink'), 'readLink returns the declared fields');
  const declared = (f) => [...dts(f).matchAll(/^export function (\w+)/gm)].map((m) => m[1]).sort();
  const internal = ['receivedNotes', 'spendLog']; // exported for tests only
  assert.deepEqual(declared('./index.d.mts'), Object.keys(await import('./index.mjs')).filter((k) => !internal.includes(k)).sort());
  assert.deepEqual(declared('./paywall.d.mts'), Object.keys(await import('./paywall.mjs')).sort());
}
assert.equal(agent.address, zkAddress(k));
await assert.rejects(createAgent({ seed, network: 'testnet' }), /one network per process/);
await assert.rejects(agent.send({ to: agent.address, amount: '50.000001' }), /above this agent's limit of 50 USDG/);
await assert.rejects(agent.send({ to: agent.address, amount: '0' }), /greater than zero/);
await assert.rejects(agent.send({ to: agent.address, amount: '1e3' }), /greater than zero/);
await assert.rejects(agent.send({ to: 'zkd:1234', amount: '1' }), /Not a ZKdesk private address/);
await assert.rejects(agent.withdraw({ to: '0x123', amount: '1' }), /Not a 0x address/);
// Allow-list: only listed recipients, compared canonically (zkd: and 0x case-insensitive).
{
  const listed = zkAddress(agentKeys('0x' + '22'.repeat(32), 4663));
  const fenced = await createAgent({ seed, network: 'mainnet', allowTo: `${listed.toUpperCase().replace('ZKD:', 'zkd:')}, 0x00000000000000000000000000000000000000AA`, stateDir });
  await assert.rejects(fenced.send({ to: agent.address, amount: '1' }), /not on this agent's list of allowed recipients/);
  await assert.rejects(fenced.withdraw({ to: '0x00000000000000000000000000000000000000bb', amount: '1' }), /not on this agent's list/);
  await assert.rejects(fenced.payLink(`https://zkdesk.tech/dashboard?pay=${agent.address}&amount=1&network=mainnet`), /not on this agent's list/);
}

// Daily cap: a rolling 24 h total kept in a file (amount plus fee), refused before sending.
{
  let t = 1_000_000;
  const log = spendLog(join(stateDir, 'day.json'), 10_000_000n, () => t);
  log.check(6_000_000n);
  log.add(6_000_000n);
  assert.throws(() => log.check(4_000_001n), /pass this agent's limit of 10 USDG per 24 hours/);
  log.check(4_000_000n);
  t += 86_400_000;
  log.check(10_000_000n);
  assert.equal(log.total(), 0n, 'older than 24 h no longer counts');
  assert.equal(spendLog(join(stateDir, 'day.json'), 10_000_000n, () => 1_000_001).total(), 6_000_000n, 'kept across restarts');
  // A step that failed before anything was sent gives its reservation back (combine review M-2).
  const back = spendLog(join(stateDir, 'back.json'), 10_000_000n, () => t);
  const at = back.add(6_000_000n);
  t += 1_800_000; // a step that failed half an hour later
  back.add(-6_000_000n, at); // released with the reservation's own time
  assert.equal(back.total(), 0n);
  back.check(10_000_000n);
  t += 86_400_000 - 1_800_000; // 24 h after the reservation: both expire together, no extra room
  back.add(9_000_000n);
  assert.throws(() => back.check(1_000_001n), /per 24 hours/);
}

// Received payments: notes from transactions that spent our own notes are change, not payments.
{
  const U = 0x1n;
  const notes = [
    { asset: U, block: 10n, tx: '0xa', spentIn: '0xb', amount: 100n, status: 'spent' }, // received in 0xa, later spent in 0xb
    { asset: U, block: 11n, tx: '0xb', amount: 40n, status: 'unspent' }, // change of our own spend in 0xb
    { asset: U, block: 12n, tx: '0xc', amount: 7n, status: 'unspent' }, // a payment
    { asset: 0x2n, block: 13n, tx: '0xd', amount: 9n, status: 'unspent' }, // another asset
    { asset: U, block: 14n, amount: 1n, status: 'unspent' }, // no transaction (an evicted position's collateral)
    { asset: U, block: 15n, tx: '0xe', amount: 50n, status: 'pending' }, // a deposit in screening: its sender can take it back
    { asset: U, block: 16n, tx: '0xf', amount: 60n, status: 'refunded' }, // a deposit its sender took back
  ];
  assert.deepEqual(receivedNotes(notes, U).map((n) => n.amount), [7n, 100n], 'a deposit in screening or refunded is not received');
  assert.deepEqual(receivedNotes(notes, U, 10).map((n) => n.amount), [7n]);
  assert.deepEqual(receivedNotes(notes, U, 0, { pending: true }).map((n) => n.amount), [50n]);
}

// Payment request links: the dashboard's format, created and read by the agent, checked before paying.
const zkTo = zkAddress(agentKeys('0x' + '11'.repeat(32), 4663));
assert.deepEqual(readPaymentLink(paymentLink('https://zkdesk.tech', { to: zkTo, amount: '7.25', memo: 'Invoice 7', network: 'mainnet' }).searchParams), { to: zkTo, amount: '7.25', memo: 'Invoice 7', network: 'mainnet' });
assert.equal(readPaymentLink(new URLSearchParams('pay=zkd:12')), null);
assert.equal(readPaymentLink(new URLSearchParams(`pay=${zkTo}&amount=-1`)).amount, '', 'a bad amount leaves it to the payer');
const own = await agent.requestLink({ amount: '12.5', memo: 'Invoice 8', exact: true });
// Without exact, each link asks for a slightly different amount so its payment can be told apart.
const unique = Number(agent.readLink(await agent.requestLink({ amount: '12.5' })).amount);
assert.ok(unique > 12.5 && unique < 12.501, `unique amount ${unique}`);
assert.match(own, /^https:\/\/zkdesk\.tech\/dashboard\?view=treasury&pay=zkd%3A/);
assert.deepEqual(agent.readLink(own), { to: agent.address, amount: '12.5', memo: 'Invoice 8', network: 'mainnet' });
const link = (q) => `https://zkdesk.tech/dashboard?view=treasury&pay=${zkTo}&network=mainnet${q}`;
assert.throws(() => agent.readLink(link('').replace('mainnet', 'testnet')), /for testnet; this agent is on mainnet/);
assert.throws(() => agent.readLink('pay me'), /Not a link/);
assert.throws(() => agent.readLink('https://zkdesk.tech/dashboard?amount=5'), /not a ZKdesk payment request/);
await assert.rejects(agent.payLink(link('&amount=12.5'), { amount: '10' }), /asks for 12.5 USDG, not 10/);
await assert.rejects(agent.payLink(link('')), /leaves the amount to the payer/);
await assert.rejects(agent.payLink(link('&amount=60')), /above this agent's limit of 50 USDG/);
await assert.rejects(agent.requestLink({ amount: 'ten' }), /greater than zero/);

// MCP handler with a stand-in agent.
const calls = [];
const fake = {
  address: 'zkd:abc', network: 'mainnet',
  balance: async () => ({ usdg: '1.5' }),
  send: async (x) => { calls.push(['start', x.amount]); await new Promise((r) => setTimeout(r, x.amount === '2' ? 50 : 0)); calls.push(['end', x.amount]); return { confirmed: true, big: 5n }; },
};
const handle = createHandler(async () => fake);
const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
assert.equal(init.result.protocolVersion, '2025-06-18');
assert.deepEqual(init.result.capabilities, { tools: {} });
assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-11-25');
assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
assert.deepEqual((await handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
const { tools } = (await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).result;
assert.equal(tools.length, TOOLS.length);
assert.ok(tools.every((t) => t.name.startsWith('zkdesk_') && t.inputSchema.type === 'object' && !('run' in t)));
assert.ok(tools.find((t) => t.name === 'zkdesk_send').annotations.destructiveHint);
assert.ok(tools.find((t) => t.name === 'zkdesk_balance').annotations.readOnlyHint);
const call = (name, args, id = 9) => handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
assert.equal(JSON.parse((await call('zkdesk_balance', {})).result.content[0].text).usdg, '1.5');
for (const [args, why] of [[{ to: 'zkd:x' }, /Missing argument "amount"/], [{ to: 'zkd:x', amount: 5 }, /must be a string/], [{ to: 'zkd:x', amount: '1,5' }, /not valid/], [{ to: 'zkd:x', amount: '1', memo: 'hi' }, /Unknown argument "memo"/]]) {
  const r = (await call('zkdesk_send', args)).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, why);
}
assert.match((await call('zkdesk_request_link', { memo: 'x'.repeat(61) })).result.content[0].text, /longer than 60/);
// expected_verifier: only a 0x EVM address gets through (an empty one would accept receipts for anyone).
for (const v of ['', ' ', 'zkd:' + 'a'.repeat(128), 5, '0x' + 'a'.repeat(40) + '\n']) assert.equal((await call('zkdesk_verify_receipt', { record: {}, expected_verifier: v })).result.content[0].text.match(/expected_verifier" (is not valid|must be a string)/) !== null, true, JSON.stringify(v));
assert.equal((await call('zkdesk_nope', {})).error.code, -32602);
assert.equal((await handle({ jsonrpc: '2.0', id: 10, method: 'resources/list' })).error.code, -32601);
assert.equal((await handle({ id: 11, method: 'ping' })).error.code, -32600);
// Spends run one at a time, in order, and bigints serialize.
const [a, b] = await Promise.all([call('zkdesk_send', { to: 'zkd:x', amount: '2' }, 20), call('zkdesk_send', { to: 'zkd:x', amount: '3' }, 21)]);
assert.deepEqual(calls, [['start', '2'], ['end', '2'], ['start', '3'], ['end', '3']]);
assert.equal(JSON.parse(a.result.content[0].text).big, '5');
assert.equal(b.id, 21);
// A failing agent (e.g. no seed) is a tool error, not a crash.
const leaky = createHandler(async () => { throw new Error('HTTP request failed. URL: https://rpc.example.com/v2/SECRETKEY123 Details: 429'); });
const leaked = (await leaky({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zkdesk_balance', arguments: {} } })).result.content[0].text;
assert.ok(leaked.includes('https://rpc.example.com') && !leaked.includes('SECRETKEY123'), 'URLs in errors keep only their origin');
const broken = createHandler(async () => { throw new Error('no seed'); });
assert.match((await broken({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zkdesk_balance', arguments: {} } })).result.content[0].text, /no seed/);

// A real stdio session: stdout carries only JSON-RPC lines.
const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp.mjs', import.meta.url))], { env: { ...process.env, ZKDESK_SEED: seed, ZKDESK_NETWORK: 'mainnet' } });
let out = '';
child.stdout.on('data', (d) => { out += d; });
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'zkdesk_address', arguments: {} } });
child.stdin.write('not json\n');
for (let i = 0; i < 200 && out.split('\n').filter(Boolean).length < 3; i++) await new Promise((r) => setTimeout(r, 50));
child.kill();
const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, 'zkdesk');
assert.equal(JSON.parse(lines.find((l) => l.id === 2).result.content[0].text).address, zkAddress(k));
assert.equal(lines.find((l) => l.id === null).error.code, -32700);

console.log('agent checks passed: agent keys, type declarations, SDK input guards and per-transaction limit, payment request links, MCP initialize/tools/list/tools/call, argument validation, serialized spends, stdio session');
