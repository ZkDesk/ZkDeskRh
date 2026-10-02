#!/usr/bin/env node
// ZKdesk MCP server (stdio): gives an LLM agent its private ZKdesk account as tools.
// Env: ZKDESK_SEED (required, from `node agent/cli.mjs keygen`), ZKDESK_NETWORK (mainnet | testnet,
// default mainnet), ZKDESK_MAX_PER_TX (USDG per payment, default 50; "off" removes it),
// ZKDESK_API (default https://zkdesk.tech), ZKDESK_RPC (optional chain RPC).
// The protocol is newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio transport, tools only).
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const AMOUNT = str('USDG amount as a decimal string, e.g. "12.5"', { pattern: '^\\d{1,9}(\\.\\d{1,6})?$' });
const TO = str('A ZKdesk private address (zkd:…) or, to leave the private pool, a 0x address');
const TREASURY = str('Treasury id (0x…) from zkdesk_treasuries');
const tool = (name, description, properties, required, run, readOnly = false) => ({
  name, description, run,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: readOnly ? { readOnlyHint: true } : { destructiveHint: true, idempotentHint: false, openWorldHint: true },
});

export const TOOLS = [
  tool('zkdesk_address', 'The agent\'s ZKdesk private address. Others fund the agent or add it to a treasury with it.', {}, [], (a) => ({ address: a.address, network: a.network }), true),
  tool('zkdesk_balance', 'The agent\'s private USDG balance (and deposits still in screening).', {}, [], (a) => a.balance(), true),
  tool('zkdesk_send', 'Send USDG privately from the agent\'s own balance to a zkd: address. A relay fee is taken from the balance.', { to: str('Recipient ZKdesk private address (zkd:…)'), amount: AMOUNT }, ['to', 'amount'], (a, x) => a.send(x)),
  tool('zkdesk_withdraw', 'Withdraw USDG from the agent\'s private balance to a public 0x address.', { to: str('Recipient 0x address'), amount: AMOUNT }, ['to', 'amount'], (a, x) => a.withdraw(x)),
  tool('zkdesk_treasuries', 'Treasuries where the agent holds a role, with their USDG balance and the amount above which the Owner must approve.', {}, [], (a) => a.treasuries(), true),
  tool('zkdesk_pay', 'Pay USDG from a treasury the agent can move funds in. Above the Owner\'s approval threshold it becomes a request instead; check it with zkdesk_requests and send it with zkdesk_complete once approved.', { treasury: TREASURY, to: TO, amount: AMOUNT }, ['treasury', 'to', 'amount'], (a, x) => a.pay(x.treasury, x)),
  tool('zkdesk_requests', 'Approval requests of a treasury and their status (Awaiting Owner, Approved, Completed, Expired).', { treasury: TREASURY }, ['treasury'], (a, x) => a.requests(x.treasury), true),
  tool('zkdesk_complete', 'Send a treasury transfer this agent requested, after the Owner approved it.', { treasury: TREASURY, request: str('Request id from zkdesk_requests') }, ['treasury', 'request'], (a, x) => a.complete(x.treasury, x.request)),
  tool('zkdesk_mandates', 'Payment mandates of a treasury: recipient, cap per period, expiry, status and whether this period is paid.', { treasury: TREASURY }, ['treasury'], (a, x) => a.mandates(x.treasury), true),
  tool('zkdesk_pay_mandate', 'Pay the current period of a mandate, up to its cap.', { treasury: TREASURY, mandate: str('Mandate id from zkdesk_mandates'), amount: AMOUNT }, ['treasury', 'mandate', 'amount'], (a, x) => a.payMandate(x.treasury, x.mandate, x.amount)),
  tool('zkdesk_receipts', 'Payments the agent received under mandates; each can be proven with zkdesk_prove_receipt.', {}, [], (a) => a.receipts(), true),
  tool('zkdesk_prove_receipt', 'A zero-knowledge receipt for one received payment, for one verifier, disclosing the amount only if asked.', { id: str('Receipt id from zkdesk_receipts'), verifier: str('Who the proof is for: a 0x address (default: anyone)'), disclose_amount: { type: 'boolean', description: 'Include the amount' } }, ['id'], (a, x) => a.proveReceipt(x.id, { verifier: x.verifier || '0', discloseAmount: Boolean(x.disclose_amount) }), true),
  tool('zkdesk_verify_receipt', 'Check a ZKdesk payment receipt record against the chain. Needs no keys.', { record: { type: 'object', description: 'The receipt record JSON' } }, ['record'], (a, x) => a.verifyReceipt(x.record).then((valid) => ({ valid })), true),
];

/** Rejects missing or mistyped arguments before anything is proven. */
function checkArgs(t, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  const { properties, required } = t.inputSchema;
  for (const k of Object.keys(args)) if (!properties[k]) throw new Error(`Unknown argument "${k}".`);
  for (const k of required) if (args[k] === undefined || args[k] === '') throw new Error(`Missing argument "${k}".`);
  for (const [k, v] of Object.entries(args)) {
    const p = properties[k];
    const type = Array.isArray(v) ? 'array' : typeof v;
    if (type !== p.type) throw new Error(`Argument "${k}" must be a ${p.type}.`);
    if (p.pattern && !new RegExp(p.pattern).test(v)) throw new Error(`Argument "${k}" is not valid: ${p.description}.`);
  }
}

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** One JSON-RPC message in, its response out (null for notifications). getAgent opens the account once. */
export function createHandler(getAgent) {
  let queue = Promise.resolve(); // tool calls run one at a time: two spends must not pick the same notes
  return async function handle(msg) {
    const { id, method, params = {} } = msg ?? {};
    const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });
    if (msg?.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid request');
    if (method === 'initialize') {
      return reply({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'zkdesk', version: '3.7.0' },
        instructions: 'ZKdesk private payments on Robinhood Chain. Amounts are USDG decimal strings. Every payment is a zero-knowledge proof generated locally (about 10 to 60 seconds) and relayed; no wallet or gas is needed. Payments above the treasury Owner\'s threshold become approval requests.',
      });
    }
    if (method.startsWith('notifications/')) return null;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    if (method !== 'tools/call') return fail(-32601, `Method not found: ${method}`);
    const t = TOOLS.find((x) => x.name === params.name);
    if (!t) return fail(-32602, `Unknown tool: ${params.name}`);
    const run = queue.then(async () => {
      try {
        const args = params.arguments ?? {};
        checkArgs(t, args);
        return reply({ content: [{ type: 'text', text: json(await t.run(await getAgent(), args)) }] });
      } catch (error) {
        return reply({ content: [{ type: 'text', text: error?.message || String(error) }], isError: true });
      }
    });
    queue = run.catch(() => {});
    return run;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log = console.info = console.warn = console.error; // stdout carries the protocol only
  let agent = null;
  const getAgent = () => (agent ??= import('./index.mjs').then(({ createAgent }) => createAgent({
    seed: process.env.ZKDESK_SEED, network: process.env.ZKDESK_NETWORK || 'mainnet', api: process.env.ZKDESK_API || undefined, rpc: process.env.ZKDESK_RPC || undefined,
    maxPerTx: process.env.ZKDESK_MAX_PER_TX === 'off' ? null : process.env.ZKDESK_MAX_PER_TX || '50',
    onStatus: (m) => console.error(m),
  })).catch((error) => { agent = null; throw error; }));
  const handle = createHandler(getAgent);
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
