// Alert decisions for the treasury watcher (agent/watch.mjs): pure, so they are tested on their own.
// A view of the treasury goes in (its payments report, approval requests and limits); the alerts still
// owed and the next state come out. Nothing is sent from here.
//
// Each payment, request, budget mark and limits change is decided once, when it first appears, and an
// alert is queued for every channel configured then. A queued alert stays until each of its channels
// accepted it. So a payment that later reads differently (an agent removed and added back, an outage of
// the mailbox or the RPC) is never reported again, and a channel added later gets only new alerts.

const UNKNOWN_CHECKS = 10;
const MAX_QUEUE = 500;
const MAX_IDS = 2000;
const short = (x) => (!x ? 'unknown' : x.length > 26 ? `${x.slice(0, 14)}…${x.slice(-6)}` : x);
const LIMIT_NAMES = { payer: 'Payer (agent)', threshold: 'approval threshold', scope: 'agent limits (recipients, budget)', until: "agent's access end", count: 'payments-without-approval limit', roles: 'Owner, Treasurer or Auditor', allocCap: 'allocation cap' };

/**
 * view: {
 *   payments: [{ tx, by, requestedByPayer, amount (decimal string), asset, to, toSource, mismatch }] newest first,
 *   period: { spent, budget (decimal strings or null), window (string) },
 *   requests: [{ id, status, amount, to }], or null when they could not be read,
 *   limits: { payer, threshold, scope, until, count, roles, allocCap } (strings; null = could not be read;
 *     until: the agent's access end in unix seconds, '0' = none),
 *   now: unix seconds (for the access-end alerts),
 * }
 * state: null on the first run (what is there is learned, not reported). channels: the configured ones.
 * Returns { alerts: [{ key, event, text, channels }] (oldest first, each with the channels it is still
 * owed on), state }; the caller marks each delivery with markSent.
 */
export function decide(view, state, { name = 'Treasury', all = false, dashboard = '', channels = ['webhook'] } = {}) {
  const first = !state;
  const decided = new Set(state?.decided ?? []);
  const seenRequests = new Set(state?.requests ?? []);
  const marks = new Set(state?.marks ?? []);
  const was = state?.limits ?? {};
  // A field that could not be read keeps its last value (a failed read is not a change).
  const limits = Object.fromEntries(Object.entries(view.limits).map(([k, v]) => [k, v ?? was[k] ?? null]));
  let seq = Number.isInteger(state?.limitsSeq) ? state.limitsSeq : 0;
  const fresh = [];
  const add = (key, event, text) => fresh.push({ key, event, text: `${name}: ${text}` });
  const link = dashboard ? `\n${dashboard}` : '';

  const unknown = { ...(state?.unknown ?? {}) };
  for (const p of [...view.payments].reverse()) { // oldest first
    if (decided.has(p.tx)) continue;
    // A row whose call could not be read yet is decided on a later check, or after UNKNOWN_CHECKS as is.
    if (p.by === 'unknown' && !first && (unknown[p.tx] = (unknown[p.tx] ?? 0) + 1) < UNKNOWN_CHECKS) continue;
    delete unknown[p.tx];
    decided.add(p.tx);
    // The agent's own payments, every payment the Owner approved (whoever asked: who asked is not
    // proven), and with `all` everyone's.
    const approved = p.by === 'approved by the Owner';
    if (p.by === 'payer' || approved || p.requestedByPayer || all || (p.by === 'unknown' && !first)) {
      const who = p.by === 'payer' ? 'Your agent paid' : approved ? `A payment you approved${p.requestedByPayer ? ' (requested by your agent)' : ''} was sent:` : p.by === 'mandate' ? 'A mandate paid' : p.by === 'unknown' ? 'A payment whose details could not be read sent' : 'A treasury payment sent';
      const toText = `${short(p.to)}${p.to && p.toSource !== 'chain' ? ' (as recorded by the paying app)' : ''}`;
      const budget = p.by === 'payer' && view.period.budget ? ` Now ${view.period.spent} of ${view.period.budget} USDG used this period.` : '';
      add(`pay:${p.tx}`, 'payment', `${who} ${p.amount} ${p.asset} to ${toText}.${budget}`);
    }
    // A note the members cannot read hides part of a payment, whoever made it.
    if (p.mismatch) add(`gap:${p.tx}`, 'unreadable', `a payment spent a note the members cannot read, so its amount or recipient may be incomplete (tx ${short(p.tx)}).`);
  }

  if (view.period.budget) {
    const spent = Number(view.period.spent);
    const budget = Number(view.period.budget);
    // Any change to the policy or the roles restarts the agent's spending record (TreasuryLedger), so
    // the marks are per window and per policy: after an extension the budget alerts can come again.
    const tag = `${view.period.window}:${limits.scope}:${limits.until ?? 0}:${limits.threshold}:${limits.allocCap}:${limits.payer}:${limits.roles}`;
    for (const [level, reached, text] of [
      [80, spent >= budget * 0.8, `the agent has used ${Math.floor((spent / budget) * 100)}% of its budget for this period (${view.period.spent} of ${view.period.budget} USDG).`],
      [100, spent >= budget, `the agent has used its whole budget for this period (${view.period.spent} of ${view.period.budget} USDG).`],
    ]) {
      const key = `budget${level}:${tag}`;
      if (!reached || marks.has(key)) continue;
      marks.add(key);
      if (level === 80 && spent >= budget) continue; // straight to 100%: one alert
      add(key, 'budget', text);
    }
    for (const k of [...marks]) if (k.startsWith('budget') && !k.endsWith(`:${tag}`)) marks.delete(k); // only this window's marks
  }

  // The agent's access end (v3.5): a day before, and when it has passed. A new end time alerts again.
  const until = Number(limits.until ?? 0);
  for (const k of [...marks]) if (/^(ends24|ended):/.test(k) && k !== `ends24:${until}` && k !== `ended:${until}`) marks.delete(k);
  if (until && Number.isFinite(view.now)) {
    const at = new Date(until * 1000).toISOString();
    if (view.now >= until && !marks.has(`ended:${until}`)) {
      marks.add(`ended:${until}`);
      add(`ended:${until}`, 'access', `the agent's access ended at ${at}. A payment dated before then can still go through until ${new Date((until + 3_600) * 1000).toISOString()} (a payment proof may be dated up to an hour back); none after. Extend it in the dashboard if it should keep paying.${link}`);
    } else if (view.now < until && view.now >= until - 86_400 && !marks.has(`ends24:${until}`)) {
      marks.add(`ends24:${until}`);
      add(`ends24:${until}`, 'access', `the agent's access ends at ${at} (in about ${Math.max(1, Math.round((until - view.now) / 3600))} h). Extend it in the dashboard if it should keep paying.${link}`);
    }
  }

  // Requests: the first list that could be read is learned, not reported (also when the first run could
  // not read it). Seen ids are kept (the newest MAX_IDS), so one that drops out and comes back is not new.
  let requestsLearned = first ? false : state.requestsLearned !== false;
  if (view.requests) {
    for (const r of view.requests) {
      if (seenRequests.has(r.id)) continue;
      seenRequests.add(r.id);
      // Already marked declined: still reported (anyone holding the keys can mark it, so it is unverified).
      if (requestsLearned && ['Awaiting Owner', 'Declined'].includes(r.status)) add(`req:${r.id}`, 'approval', `approval requested: ${r.amount} ${r.asset ?? 'USDG'} to ${short(r.to)}${r.status === 'Declined' ? ' (already marked declined; unverified)' : ''}. Check the full recipient in the dashboard before approving.${link}`);
    }
    requestsLearned = true;
  }

  const changed = Object.keys(limits).filter((k) => state && limits[k] != null && was[k] != null && limits[k] !== was[k]);
  if (changed.length) add(`limits:${seq++}`, 'limits', `the treasury's ${changed.map((k) => LIMIT_NAMES[k] ?? k).join(', ')} changed.`);

  let queue = (state?.queue ?? []).map((q) => ({ ...q, channels: q.channels.filter((c) => channels.includes(c)) })).filter((q) => q.channels.length);
  if (!first) queue.push(...fresh.map((a) => ({ ...a, channels: [...channels] })));
  const dropped = Math.max(queue.length - MAX_QUEUE, 0); // a channel down for long: keep the newest
  if (dropped) queue = queue.slice(dropped);
  return {
    alerts: queue,
    dropped,
    // decided txs are never forgotten: a payment that leaves the view and comes back is not new.
    state: { v: 3, decided: [...decided], requests: [...seenRequests].slice(-MAX_IDS), requestsLearned, marks: [...marks], limits, limitsSeq: seq, queue, unknown },
  };
}

/** The state after `alert` was delivered on `channel`: owed on the other channels only, if any. */
export function markSent(state, alert, channel) {
  const queue = state.queue.map((q) => (q.key === alert.key ? { ...q, channels: q.channels.filter((c) => c !== channel) } : q)).filter((q) => q.channels.length);
  return { ...state, queue };
}

const TIMEOUT_MS = 10_000;
const telegramApi = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// Text someone else wrote (Telegram's answers, chat names), without control characters.
const clean = (text, max = 200) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, max);
// Telegram's answer, in plain words. Never includes the token or a URL (Telegram's description has neither).
function telegramReason(status, body) {
  const d = clean(body?.description);
  if (status === 401 || status === 404) return 'the bot token is wrong: copy it again from @BotFather';
  if (/chat not found/i.test(d)) return 'Telegram cannot find this chat: send your bot a message first, then run --find-chat for the right chat id';
  if (/blocked by the user/i.test(d)) return 'you blocked the bot: unblock it in Telegram';
  if (/can't initiate/i.test(d)) return 'the bot cannot write to this chat yet: send it a message first';
  if (/kicked|not a member/i.test(d)) return 'the bot is no longer in that group or channel: add it again, or use your own chat id';
  if (/upgraded to a supergroup/i.test(d)) return `that group became a supergroup${body?.parameters?.migrate_to_chat_id ? `: use chat id ${clean(body.parameters.migrate_to_chat_id, 30)}` : ''}`;
  if (status === 429) return 'Telegram is limiting messages for a moment: try again in a minute';
  return `Telegram answered ${status}${d ? `: ${d}` : ''}`;
}
// Fetch's own errors carry the real cause one level down (undici: "fetch failed", cause "unexpected redirect").
const failedFetch = (error, what) => (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? `${what} did not answer within ${TIMEOUT_MS / 1000} s`
  : /redirect/i.test(`${error?.message} ${error?.cause?.message}`) ? `${what} redirects: use the final URL` : `${what} could not be reached`);

/**
 * Delivers on the given channels; returns { telegram, webhook }, each { ok, reason } (reason: why it
 * failed, in plain words, without the token or the URL).
 */
export async function deliverDetailed(alert, { telegramToken, telegramChat, webhookUrl }, fetchFn = fetch, channels = ['telegram', 'webhook']) {
  const post = (url, body) => fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const out = {};
  if (channels.includes('telegram') && telegramToken && telegramChat) {
    out.telegram = await post(telegramApi(telegramToken, 'sendMessage'), { chat_id: telegramChat, text: alert.text, disable_web_page_preview: true })
      .then(async (r) => (r.ok ? { ok: true } : { ok: false, reason: telegramReason(r.status, await r.json().catch(() => null)) }), (error) => ({ ok: false, reason: failedFetch(error, 'Telegram') }));
  }
  if (channels.includes('webhook') && webhookUrl) {
    out.webhook = await post(webhookUrl, { text: alert.text, event: alert.event })
      .then((r) => (r.ok ? { ok: true } : { ok: false, reason: `the webhook answered HTTP ${r.status}` }), (error) => ({ ok: false, reason: failedFetch(error, 'the webhook') }));
  }
  return out;
}

/** Delivers on the given channels; returns { telegram, webhook } (true when accepted). */
export async function deliver(alert, settings, fetchFn = fetch, channels = ['telegram', 'webhook']) {
  const out = await deliverDetailed(alert, settings, fetchFn, channels);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.ok]));
}

/**
 * The chats that wrote to a Telegram bot recently (its last updates): [{ id, type, name }], newest
 * first. For --find-chat: you send the bot a message, then this finds your chat id. Throws in plain
 * words (wrong token, no message yet, a webhook set on the bot).
 */
export async function findChats(token, fetchFn = fetch) {
  const r = await fetchFn(telegramApi(token, 'getUpdates'), { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    .catch((error) => { throw new Error(failedFetch(error, 'Telegram')); });
  const body = await r.json().catch(() => null);
  if (r.status === 409) {
    throw new Error(/webhook/i.test(body?.description ?? '') ? 'This bot is set to send its messages to a webhook, so its chats cannot be listed here. Remove that webhook (Telegram deleteWebhook) or create a new bot.'
      : 'Another program is reading this bot\'s messages right now. Stop it, or create a new bot used only for these alerts.');
  }
  if (!r.ok || !body?.ok) throw new Error(telegramReason(r.status, body));
  const seen = new Map();
  for (const u of [...(body.result ?? [])].reverse()) {
    const m = u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post ?? u.my_chat_member ?? u.chat_member;
    const chat = m?.chat;
    if (chat?.id === undefined || seen.has(chat.id)) continue;
    const who = (x) => clean(x?.title || [x?.first_name, x?.last_name].filter(Boolean).join(' ') || x?.username || '', 60);
    seen.set(chat.id, { id: clean(chat.id, 30), type: clean(chat.type, 20), name: who(chat), from: m.from ? who(m.from) : '', username: m.from?.username ? clean(m.from.username, 40) : '' });
  }
  if (!seen.size) throw new Error('No message to this bot yet: open it in Telegram, send it any message (e.g. "hi"), then run this again.');
  return [...seen.values()];
}
