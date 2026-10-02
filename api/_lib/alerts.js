// Operational alerts, checked on every tick (api/cron/tick.js): service gas, missed desk epochs,
// a paused desk, failed relays, and every timelock proposal (CallScheduled), so a governance change
// is seen during its delay. Sent to a Telegram chat (ALERT_TELEGRAM_TOKEN + ALERT_TELEGRAM_CHAT)
// and/or a webhook (ALERT_WEBHOOK_URL, JSON {text}); with neither set, alerts are only reported.
// Each alert repeats at most once per REPEAT_MS; state lives in <schema>.alert_state.
import { formatEther, parseAbiItem } from 'viem';
import { abis, db, deployment, keeper, MAINNET, publicClient, relayer, secret } from './server.js';

const LOW_WEI = 5n * 10n ** 15n; // 0.005 ETH
const REPEAT_MS = 60 * 60 * 1000;
const MAX_SCAN = 50_000n; // blocks of timelock logs per tick; the cursor catches up over ticks
const CALL_SCHEDULED = parseAbiItem('event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)');
const NET = MAINNET ? 'mainnet' : 'testnet';

async function send(text) {
  const token = secret('ALERT_TELEGRAM_TOKEN');
  const chat = secret('ALERT_TELEGRAM_CHAT');
  const hook = secret('ALERT_WEBHOOK_URL');
  const sends = [];
  if (token && chat) sends.push(fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }));
  if (hook) sends.push(fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
  const results = await Promise.allSettled(sends);
  return results.length > 0 && results.every((r) => r.status === 'fulfilled' && r.value.ok);
}

/**
 * Sends `text` under `key` unless it was sent within REPEAT_MS. It is recorded as sent only after a
 * channel accepted it, so a failed delivery is retried on the next tick. Returns whether it went out.
 */
async function raise(key, text) {
  const { rows } = await db.query('select sent_at from public.alert_state where key = $1', [key]);
  if (rows[0]?.sent_at && Date.now() - new Date(rows[0].sent_at).getTime() < REPEAT_MS) return false;
  if (!(await send(`ZKDesk ${NET}: ${text}`))) return false;
  await db.query(`insert into public.alert_state (key, sent_at) values ($1, now()) on conflict (key) do update set sent_at = now()`, [key]);
  return true;
}

/** Timelock proposals since the last check (block cursor in alert_state). */
async function proposals(head) {
  if (!deployment.timelock) return [];
  const { rows } = await db.query(`select block from public.alert_state where key = 'timelock_cursor'`);
  const from = rows[0]?.block ? BigInt(rows[0].block) + 1n : head;
  if (from > head) return [];
  const to = from + MAX_SCAN - 1n < head ? from + MAX_SCAN - 1n : head;
  const logs = await publicClient.getLogs({ address: deployment.timelock, event: CALL_SCHEDULED, fromBlock: from, toBlock: to });
  await db.query(`insert into public.alert_state (key, block) values ('timelock_cursor', $1) on conflict (key) do update set block = $1`, [to.toString()]);
  return logs;
}

export async function checkAlerts() {
  const out = [];
  const head = await publicClient.getBlockNumber();
  const [relayerWei, keeperWei, healthy, paused, failed] = await Promise.all([
    relayer ? publicClient.getBalance({ address: relayer.address }) : null,
    keeper && keeper !== relayer ? publicClient.getBalance({ address: keeper.address }) : null,
    publicClient.readContract({ address: deployment.desk, abi: abis.desk, functionName: 'healthy' }),
    publicClient.readContract({ address: deployment.desk, abi: abis.desk, functionName: 'paused' }),
    db.query(`select count(*)::int as n from public.operations where status = 'failed' and updated_at > now() - interval '1 hour'`).then((r) => r.rows[0].n),
  ]);
  if (relayerWei !== null && relayerWei < LOW_WEI) out.push(['relayer_low', `relayer gas low: ${formatEther(relayerWei)} ETH (user relays stop at 0.002).`]);
  if (keeperWei !== null && keeperWei < LOW_WEI) out.push(['keeper_low', `keeper gas low: ${formatEther(keeperWei)} ETH (desk epochs stop at 0.0005).`]);
  if (!healthy) out.push(['epoch_missed', 'desk epochs are overdue: new draws are halted and liquidations wait. Check the desk cron.']);
  if (paused) out.push(['desk_paused', 'the desk is paused (new risk only).']);
  if (failed >= 10) out.push(['ops_failing', `${failed} relayed operations failed in the last hour.`]);
  for (const l of await proposals(head)) {
    out.push([`proposal_${l.args.id}`, `timelock proposal ${l.args.id.slice(0, 10)}…: call to ${l.args.target}, executable after ${Number(l.args.delay) / 3600} h. Review it now.`]);
  }
  const sent = [];
  for (const [key, text] of out) if (await raise(key, text)) sent.push(key);
  return { raised: out.map(([k]) => k), sent };
}
