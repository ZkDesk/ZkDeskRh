#!/usr/bin/env node
// Treasury alerts for its Owner (v3.19): watches one treasury with its view key and sends Telegram and/or
// webhook messages when the agent pays, nears or reaches its budget, asks for approval, a payment spends a
// note the members cannot read, or the treasury's limits change. Runs on the Owner's side: the view key
// can read the treasury but never move funds, and it never leaves this machine.
//
//   ZKDESK_VIEW_KEY=0x… ZKDESK_ALERT_TELEGRAM_TOKEN=… ZKDESK_ALERT_TELEGRAM_CHAT=… node agent/watch.mjs
//
// Settings (environment):
//   ZKDESK_VIEW_KEY            the treasury's view key (dashboard: Settings → Copy viewing key)
//   ZKDESK_NETWORK             mainnet (default) or testnet
//   ZKDESK_ALERT_TELEGRAM_TOKEN, ZKDESK_ALERT_TELEGRAM_CHAT   a Telegram bot and the chat it posts to
//   ZKDESK_ALERT_WEBHOOK_URL   https URL that receives POST {text, event}
//   ZKDESK_ALERT_ALL=1         also report the Owner's and Treasurer's payments
//   ZKDESK_WATCH_INTERVAL      seconds between checks (default 60, at least 15)
//   ZKDESK_API, ZKDESK_RPC     the ZKdesk site (default https://zkdesk.tech) and an optional chain RPC
//   ZKDESK_STATE_DIR           where it remembers what it sent (default ~/.zkdesk)
// --once: check once and exit (for cron).
// --find-chat: list the chats that wrote to your bot (needs only ZKDESK_ALERT_TELEGRAM_TOKEN), for the chat id.
// --test: open the treasury, send one test alert to each channel and say whether each arrived; changes nothing.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, formatUnits, http } from 'viem';
import { decide, deliver, deliverDetailed, findChats, markSent } from './alerts.mjs';

const env = process.env;
const FAILURES_TO_ALERT = 5;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Checks the settings; returns them or throws with what is wrong. */
export function settings(e = env) {
  const key = String(e.ZKDESK_VIEW_KEY ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || BigInt(key) === 0n || BigInt(key) >= FIELD) throw new Error('ZKDESK_VIEW_KEY must be a treasury view key (0x + 64 hex), from the dashboard: Settings → Copy viewing key.');
  const network = e.ZKDESK_NETWORK || 'mainnet';
  if (!['mainnet', 'testnet'].includes(network)) throw new Error('ZKDESK_NETWORK must be mainnet or testnet.');
  const webhookUrl = e.ZKDESK_ALERT_WEBHOOK_URL || null;
  if (webhookUrl) {
    const u = new URL(webhookUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('ZKDESK_ALERT_WEBHOOK_URL must be https (http only for localhost).');
  }
  const telegramToken = String(e.ZKDESK_ALERT_TELEGRAM_TOKEN ?? '').trim() || null;
  const telegramChat = String(e.ZKDESK_ALERT_TELEGRAM_CHAT ?? '').trim() || null;
  if (!!telegramToken !== !!telegramChat) throw new Error(telegramToken ? 'Set ZKDESK_ALERT_TELEGRAM_CHAT too: run node agent/watch.mjs --find-chat to get it.' : 'Set both ZKDESK_ALERT_TELEGRAM_TOKEN and ZKDESK_ALERT_TELEGRAM_CHAT, or neither.');
  if (telegramToken && !/^\d+:[\w-]{20,}$/.test(telegramToken)) throw new Error('ZKDESK_ALERT_TELEGRAM_TOKEN does not look like a bot token (123456789:AA…): copy it again from @BotFather.');
  if (!webhookUrl && !telegramToken) throw new Error('Set a channel: ZKDESK_ALERT_TELEGRAM_TOKEN + ZKDESK_ALERT_TELEGRAM_CHAT, and/or ZKDESK_ALERT_WEBHOOK_URL.');
  const interval = Math.max(Number(e.ZKDESK_WATCH_INTERVAL) || 60, 15);
  return {
    key: BigInt(key), network, webhookUrl, telegramToken, telegramChat, interval, all: e.ZKDESK_ALERT_ALL === '1',
    api: (e.ZKDESK_API || 'https://zkdesk.tech').replace(/\/$/, ''), rpc: e.ZKDESK_RPC || undefined, stateDir: e.ZKDESK_STATE_DIR || join(homedir(), '.zkdesk'),
  };
}

// A read-only client for the network in the settings (a throwaway key set: it reads with the view key
// only and never proves or relays anything).
async function connect(s) {
  globalThis.ZKDESK_NETWORK = s.network;
  const [config, { agentKeys, zkAddress }, zk, { createTransport }, { allowHash }] = await Promise.all([
    import('../src/lib/chain/config.js'), import('../src/lib/zk/keys.js'), import('../src/lib/zk/client.js'), import('../src/lib/zk/transport.js'), import('../src/lib/zk/notes.js'),
  ]);
  const { chain, deploymentReady, apiBase } = config;
  if (!deploymentReady) throw new Error(`ZKdesk ${s.network} still runs older contracts.`);
  const publicClient = createPublicClient({ chain, transport: http(s.rpc) });
  const { mailbox } = createTransport(`${s.api}${apiBase}`);
  const keys = agentKeys('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), chain.id);
  const refuse = () => { throw new Error('The watcher is read-only.'); };
  const client = zk.createClient({ publicClient, keys, prove: refuse, relay: refuse, requests: mailbox });
  return { config, zkAddress, allowHash, publicClient, client };
}
const channelsOf = (s) => [s.telegramToken && 'telegram', s.webhookUrl && 'webhook'].filter(Boolean);
const NAMES = { telegram: 'Telegram', webhook: 'Webhook' };

/** --find-chat: the chats that wrote to the bot, with the line to set. */
async function findChat(e = env, fetchFn = fetch) {
  const token = String(e.ZKDESK_ALERT_TELEGRAM_TOKEN ?? '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('Set ZKDESK_ALERT_TELEGRAM_TOKEN to your bot token from @BotFather (it looks like 123456789:AA…).');
  const chats = await findChats(token, fetchFn);
  for (const c of chats) console.log(`Chat ${c.id} (${c.type}${c.name ? `, ${c.name}` : ''})${c.from ? ` · last message from ${c.from} · username ${c.username ? `@${c.username}` : 'none'}` : ''}`);
  // Anyone can message a bot: with more than one chat, you choose (alerts go to whoever has that chat).
  if (chats.length === 1) console.log(`\nSet: ZKDESK_ALERT_TELEGRAM_CHAT=${chats[0].id}`);
  else console.log('\nMore than one chat wrote to this bot. Set ZKDESK_ALERT_TELEGRAM_CHAT to yours from the list above (check the name), or use a new bot only you have messaged.');
}

/** --test: opens the treasury and sends one test alert to each channel. Exit 0 only if all arrived. */
async function test() {
  const s = settings();
  console.log(`Opening the treasury on ${s.network}…`);
  const { client } = await connect(s);
  await client.sync();
  const L = client.viewLedger(s.key);
  if (!L) throw new Error(`The viewing key opens no treasury on ${s.network}. Copy it again (dashboard: Settings → Copy viewing key), and check ZKDESK_NETWORK.`);
  console.log(`✓ Viewing key opens "${L.name || 'Treasury'}" on ${s.network}.`);
  const text = `ZKdesk alerts are set up for "${L.name || 'Treasury'}" (${s.network}). You will get a message here when your agent pays, asks for approval, nears its budget or its access ends.`;
  const results = await deliverDetailed({ key: 'test', event: 'test', text }, s, fetch, channelsOf(s));
  for (const [channel, r] of Object.entries(results)) console.log(r.ok ? `✓ ${NAMES[channel]}: test alert delivered.` : `✗ ${NAMES[channel]}: ${r.reason}.`);
  const ok = Object.values(results).every((r) => r.ok);
  console.log(ok ? 'All set. Run it without --test to start watching.' : 'Fix the line marked ✗, then run --test again.');
  return ok;
}

async function main() {
  const s = settings();
  const { config, zkAddress, allowHash, publicClient, client } = await connect(s);
  const { deployment } = config;

  const fmt = (raw) => formatUnits(raw, 6);
  const unit = (asset) => {
    if (asset === undefined) return ['units (asset unknown)', 0];
    if (asset === BigInt(deployment.usdg)) return ['USDG', 6];
    if (deployment.vault && asset === BigInt(deployment.vault)) return ['vault shares', 12];
    return [Object.keys(config.stocks).find((k) => BigInt(config.stocks[k].token) === asset) ?? 'tokens', 18];
  };
  const BY = { payer: 'payer', 'former payer': 'former payer', approved: 'approved by the Owner', member: 'Owner or Treasurer', mandate: 'mandate', unknown: 'unknown' };

  const channels = channelsOf(s);
  let statePath = null;
  let state = null;
  const save = () => { // atomic, private to this user; it lists only what was already delivered
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  };
  async function check() {
    await client.sync();
    const L = client.viewLedger(s.key);
    if (!L) throw new Error(`No treasury for this view key on ${s.network}.`);
    if (!statePath) {
      const ledgerId = '0x' + L.owner.toString(16).padStart(64, '0');
      mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
      const path = join(s.stateDir, `watch-${s.network}-${ledgerId.slice(2, 18)}.json`);
      lock(`${path}.lock`); // throws unless this process holds it; then the state is ours to read
      state = loadState(path);
      statePath = path;
    }
    const report = await client.ledgerPayments(L);
    // A read that fails is "unknown" (null), never "none": that would look like a change.
    const requests = await client.ledgerRequests(L).catch(() => null);
    const count = await publicClient.readContract({ address: deployment.ledger, abi: config.abis.ledger, functionName: 'limits', args: [L.owner] }).catch(() => null);
    // The access end is checked against chain time, as the proof is.
    const now = await publicClient.getBlock().then((b) => Number(b.timestamp), () => Math.floor(Date.now() / 1000));
    const c = L.config;
    const view = {
      payments: report.rows.map((r) => {
        const [asset, decimals] = unit(r.asset);
        return { tx: r.tx, block: String(r.block), by: BY[r.by] ?? r.by, requestedByPayer: !!r.requestedByPayer, amount: formatUnits(r.amount, decimals), asset, to: r.to, toSource: r.toSource, mismatch: r.mismatch };
      }),
      period: { spent: fmt(report.period.spent), budget: report.period.budget ? fmt(report.period.budget) : null, window: String(report.period.window ?? 0n) },
      requests: requests && requests.map((r) => {
        const [asset, decimals] = unit(r.asset);
        return { id: String(r.id), status: r.status, amount: formatUnits(r.amount, decimals), asset, to: r.to ? zkAddress(r.to) : r.recipient };
      }),
      limits: {
        payer: c.payer.toString(16), threshold: fmt(c.dualThreshold),
        scope: `${allowHash(c.allow ?? Array(8).fill(0n)).toString(16)}:${c.budget ?? 0n}:${c.budgetPeriod ?? 0n}:${c.budgetStart ?? 0n}`, until: String(c.payerUntil ?? 0n),
        count: count ? `${count[0]}/${count[1]}` : null, roles: [c.owner, c.treasurer, c.auditor].map((x) => x.toString(16)).join(':'), allocCap: fmt(c.allocCap),
      },
      now,
    };
    const { alerts, dropped, state: next } = decide(view, state, { name: L.name || 'Treasury', all: s.all, dashboard: `${s.api}/dashboard?view=treasury`, channels });
    if (dropped) console.error(`${new Date().toISOString()} ${dropped} undelivered alerts dropped (a channel has been down for long)`);
    state = next;
    save();
    const down = new Set(); // a channel that failed in this check is not tried again until the next one
    for (const a of alerts) {
      const results = await deliverDetailed(a, s, fetch, a.channels.filter((c) => !down.has(c)));
      for (const [channel, r] of Object.entries(results)) {
        if (r.ok) state = markSent(state, a, channel);
        else down.add(channel);
        console.log(`${new Date().toISOString()} ${r.ok ? 'sent' : `could not send (retrying next check): ${r.reason};`} ${a.event} via ${channel}`);
      }
      save(); // after each alert: a crash does not send the delivered ones again
    }
    return state.queue.length; // still owed
  }

  console.log(`Watching treasury on ${s.network} every ${s.interval} s (alerts: ${channels.join(' + ')}).`);
  const once = process.argv.includes('--once');
  let failures = 0;
  // The watcher's own health, sent straight to every channel (not queued): silence must not look like calm.
  const health = (text) => Promise.all(channels.map((c) => deliver({ key: 'health', event: 'watcher', text: `ZKdesk alerts: ${text}` }, s, fetch, [c]))).catch(() => {});
  for (;;) {
    try {
      const owed = await check();
      if (failures >= FAILURES_TO_ALERT) await health(`the watcher is checking the treasury again (after ${failures} failed checks).`);
      failures = 0;
      if (once && owed) process.exit(2); // cron sees that a channel did not take every alert
    } catch (error) {
      // Error text from the RPC client can carry its URL (with an API key): URLs are not printed.
      console.error(`${new Date().toISOString()} ${String(error.message).replace(/https?:\/\/\S+/g, '<url>')}`);
      if (once || /already running/.test(error.message)) process.exit(1); // cron sees the failure; a second watcher stops
      if (++failures === FAILURES_TO_ALERT) await health(`the watcher cannot check the treasury (${failures} checks failed in a row). Payments are not being watched until this recovers.`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, s.interval * 1000));
  }
}

/** The saved state, or null (a first run) with a note when it is missing or unreadable. */
export function loadState(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const st = JSON.parse(text);
    const strings = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string');
    const queued = Array.isArray(st?.queue) && st.queue.every((q) => q && typeof q.key === 'string' && typeof q.text === 'string' && strings(q.channels));
    if (st?.v === 3 && strings(st.decided) && strings(st.requests) && strings(st.marks) && queued && typeof st.limits === 'object' && st.limits !== null) {
      return { ...st, limitsSeq: Number.isInteger(st.limitsSeq) ? st.limitsSeq : 0 };
    }
  } catch { /* below */ }
  console.error(`${path} is unreadable: starting fresh (alerts since the last check may be missed).`);
  return null;
}

/** One watcher per treasury: a lock file with the process id (a stale lock from a dead process is taken over). */
function lock(path) {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch (error) { alive = error.code === 'EPERM'; } // EPERM: alive, another user's
    if (alive) throw new Error(`A watcher for this treasury is already running (pid ${pid}); if not, delete ${path}.`);
    writeFileSync(path, String(process.pid), { mode: 0o600 });
    // Two watchers taking over the same stale lock: the last write wins and the other stops here.
    if (readFileSync(path, 'utf8') !== String(process.pid)) throw new Error('A watcher for this treasury is already running.');
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0)); // runs the exit cleanup
  process.on('exit', () => { try { if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); } catch { /* gone */ } });
}

export { findChat };

// Run directly (node agent/watch.mjs) or by pm2 (argv[1] is then pm2's container; pm_exec_path names this
// file). A pm_exec_path inherited from another pm2 app never hides argv[1].
if ([process.argv[1], process.env.pm_exec_path].some((p) => p && import.meta.url === pathToFileURL(p).href)) {
  // The setup helpers run once, by hand: under pm2 they would be restarted and repeat.
  if (process.env.pm_id !== undefined && (process.argv.includes('--test') || process.argv.includes('--find-chat'))) {
    console.error('Run --test and --find-chat directly (node agent/watch.mjs --test), not under pm2.');
    process.exit(1);
  }
  const run = process.argv.includes('--find-chat') ? findChat() : process.argv.includes('--test') ? test().then((ok) => { process.exitCode = ok ? 0 : 1; }) : main();
  run.catch((error) => {
    console.error(String(error.message).replace(/https?:\/\/\S+/g, '<url>'));
    process.exit(1);
  });
}
