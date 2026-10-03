// node agent/alerts.test.mjs — the treasury watcher's alert decisions, delivery and settings (v3.19).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, deliver, markSent } from './alerts.mjs';
import { loadState, settings } from './watch.mjs';

const limits = { payer: 'a1', threshold: '50', scope: 's1', count: '0/0', roles: 'o:t:a', allocCap: '800' };
const view = (o = {}) => ({ payments: [], period: { spent: '0', budget: '30', window: '7' }, requests: [], limits, ...o });
const pay = (tx, amount, o = {}) => ({ tx, by: 'payer', requestedByPayer: false, amount, asset: 'USDG', to: 'zkd:' + 'ab'.repeat(64), toSource: 'chain', mismatch: false, ...o });
// Decides, then delivers every owed alert on the given channels (all succeed unless `fail` names one).
const run = (v, state, { channels = ['webhook'], fail = null, ...opts } = {}) => {
  const { alerts, state: s } = decide(v, state, { channels, ...opts });
  let st = s;
  for (const a of alerts) for (const c of a.channels) if (c !== fail) st = markSent(st, a, c);
  return [alerts, st];
};

// First run: what is already there is learned, not reported (no replay of history).
let [alerts, state] = run(view({ payments: [pay('t1', '10')], requests: [{ id: '1', status: 'Awaiting Owner', amount: '80', to: '0xabc' }], period: { spent: '25', budget: '30', window: '7' } }), null);
assert.equal(alerts.length, 0, 'nothing on the first run');

// New agent payments: once each, oldest first, with the period total.
[alerts, state] = run(view({ payments: [pay('t3', '5'), pay('t2', '10'), pay('t1', '10')], period: { spent: '25', budget: '30', window: '7' } }), state, { name: 'Ops' });
assert.deepEqual(alerts.map((a) => a.key), ['pay:t2', 'pay:t3'], 'the 80% mark was already there at the first run');
assert.match(alerts[0].text, /^Ops: Your agent paid 10 USDG to zkd:abab.*\. Now 25 of 30 USDG used this period\.$/);
[alerts, state] = run(view({ payments: [pay('t3', '5'), pay('t2', '10'), pay('t1', '10')], period: { spent: '25', budget: '30', window: '7' } }), state);
assert.equal(alerts.length, 0, 'nothing twice');

// Budget reached, then 80% in the next window; a recorded recipient is labelled.
[alerts, state] = run(view({ payments: [pay('t4', '5', { toSource: 'paying app' })], period: { spent: '30', budget: '30', window: '7' } }), state);
assert.deepEqual(alerts.map((a) => a.event), ['payment', 'budget']);
assert.match(alerts[0].text, /as recorded by the paying app/);
assert.match(alerts[1].text, /whole budget/);
[alerts, state] = run(view({ period: { spent: '24', budget: '30', window: '8' } }), state);
assert.deepEqual(alerts.map((a) => a.text.match(/(\d+)% of its budget/)?.[1]), ['80'], '80% again in the next window');
[alerts, state] = run(view({ period: { spent: '31', budget: '30', window: '9' } }), state);
assert.deepEqual(alerts.map((a) => a.event), ['budget'], 'straight past 100%: one alert');

// An unreadable note is flagged whoever paid; members' payments themselves only with all; an approved
// payment the agent asked for counts as the agent's.
[alerts, state] = run(view({ payments: [pay('t6', '9', { by: 'approved by the Owner', requestedByPayer: true }), pay('t5', '100', { by: 'Owner or Treasurer', mismatch: true })] }), state);
assert.deepEqual(alerts.map((a) => a.event), ['unreadable', 'payment']);
assert.match(alerts[1].text, /A payment you approved \(requested by your agent\) was sent: 9 USDG/);
// Every payment the Owner approved is reported, whoever asked for it (that is not proven).
[alerts, state] = run(view({ payments: [pay('t6b', '4', { by: 'approved by the Owner' })] }), state);
assert.match(alerts[0].text, /A payment you approved was sent: 4 USDG/);
[alerts] = run(view({ payments: [pay('t7', '1', { by: 'Owner or Treasurer' })] }), state, { all: true });
assert.match(alerts[0].text, /A treasury payment sent 1 USDG/);

// A payment whose call cannot be read yet is decided on a later check, not lost.
[alerts, state] = run(view({ payments: [pay('t8', '3', { by: 'unknown' })] }), state);
assert.equal(alerts.length, 0);
[alerts, state] = run(view({ payments: [pay('t8', '3')] }), state);
assert.deepEqual(alerts.map((a) => a.key), ['pay:t8']);

// A row whose call stays unreadable is decided after 10 checks, as unreadable.
for (let i = 0; i < 9; i++) [alerts, state] = run(view({ payments: [pay('u1', '7', { by: 'unknown' })] }), state);
assert.equal(alerts.length, 0);
[alerts, state] = run(view({ payments: [pay('u1', '7', { by: 'unknown' })] }), state);
assert.match(alerts[0].text, /A payment whose details could not be read sent 7 USDG/);
// A payment that leaves the view and comes back is not new.
[alerts, state] = run(view({ payments: [] }), state);
[alerts, state] = run(view({ payments: [pay('t8', '3'), pay('u1', '7', { by: 'unknown' })] }), state);
assert.equal(alerts.length, 0, 'decided payments are never forgotten');
// Rows that read differently later (an agent removed and added back) are not reported again.
[alerts, state] = run(view({ payments: [pay('t8', '3', { by: 'former payer' }), pay('t3', '5', { by: 'former payer' })] }), state);
[alerts, state] = run(view({ payments: [pay('t8', '3'), pay('t3', '5')] }), state);
assert.equal(alerts.length, 0, 'no replay after the agent comes back');

// Approval requests: once, with a link; a mailbox outage (null) does not forget them.
const req = { id: '2', status: 'Awaiting Owner', amount: '60', to: '0xdef' };
[alerts, state] = run(view({ requests: [req] }), state, { dashboard: 'https://zkdesk.tech/dashboard' });
assert.deepEqual(alerts.map((a) => a.event), ['approval']);
assert.match(alerts[0].text, /approval requested: 60 USDG to 0xdef\. Check the full recipient.*\nhttps:\/\/zkdesk\.tech\/dashboard$/s);
[alerts, state] = run(view({ requests: null }), state);
[alerts, state] = run(view({ requests: [req] }), state);
assert.equal(alerts.length, 0, 'not again after the outage');
[alerts, state] = run(view({ requests: [] }), state);
[alerts, state] = run(view({ requests: [req] }), state);
assert.equal(alerts.length, 0, 'not again when it drops out of the list and comes back');
[alerts, state] = run(view({ requests: [{ id: '3', status: 'Awaiting Owner', amount: '2.5', asset: 'SPY', to: '0xdef' }] }), state);
assert.match(alerts[0].text, /approval requested: 2\.5 SPY to 0xdef/, 'in the request asset');
// A first run that could not read the mailbox learns the first list it reads, without alerting it.
{
  let [a, st] = run(view({ requests: null }), null);
  [a, st] = run(view({ requests: [req, { id: '9', status: 'Awaiting Owner', amount: '1', to: '0x1' }] }), st);
  assert.equal(a.length, 0, 'old requests are not replayed');
  [a, st] = run(view({ requests: [req, { id: '10', status: 'Awaiting Owner', amount: '1', to: '0x1' }] }), st);
  assert.deepEqual(a.map((x) => x.key), ['req:10']);
  // A first run whose count read failed: the first good read is learned, not a change.
  [a, st] = run(view({ limits: { ...limits, count: null } }), null);
  [a, st] = run(view({ limits }), st);
  assert.equal(a.length, 0, 'no false limits change');
}

// Limits: every change, also flipping back; a failed read is not a change.
const lim = (o = {}) => ({ ...limits, ...o });
for (const [l, expect] of [[lim({ payer: 'b2' }), 1], [lim({ payer: 'b2' }), 0], [lim(), 1], [lim({ payer: 'b2' }), 1], [lim({ payer: 'b2', count: null }), 0], [lim({ payer: 'b2' }), 0]]) {
  [alerts, state] = run(view({ limits: l }), state);
  assert.equal(alerts.length, expect, `limits ${JSON.stringify(l)}`);
}
[alerts, state] = run(view({ limits: lim({ payer: 'b2', count: '1/86400', roles: 'o:t2:a' }) }), state);
assert.match(alerts[0].text, /payments-without-approval limit, Owner, Treasurer or Auditor changed/);
const now = lim({ payer: 'b2', count: '1/86400', roles: 'o:t2:a' });

// Two channels: a failed one is retried alone (also for a limits change); a channel added later gets
// only new alerts.
{
  const both = ['telegram', 'webhook'];
  let [a, st] = run(view({ payments: [pay('t9', '2')], limits: lim({ ...now, threshold: '60' }) }), state, { channels: both, fail: 'webhook' });
  assert.deepEqual(a.map((x) => x.channels), [both, both]);
  [a, st] = run(view({ payments: [pay('t9', '2')], limits: lim({ ...now, threshold: '60' }) }), st, { channels: both });
  assert.deepEqual(a.map((x) => [x.event, x.channels]), [['payment', ['webhook']], ['limits', ['webhook']]], 'only the failed channel, for both');
  [a, st] = run(view({ payments: [pay('t9', '2')], limits: lim({ ...now, threshold: '60' }) }), st, { channels: [...both, 'extra'] });
  assert.equal(a.length, 0, 'a new channel does not replay history');
  state = st;
}

// A channel down for long: the queue keeps the newest 500 and says how many were dropped.
{
  let [, st] = run(view(), null);
  const many = Array.from({ length: 520 }, (_, i) => pay(`q${i}`, '1')).reverse();
  const { alerts: a, dropped } = decide(view({ payments: many }), st, { channels: ['webhook'] });
  assert.equal(a.length, 500);
  assert.equal(dropped, 20);
  assert.equal(a[0].key, 'pay:q20', 'the oldest are dropped');
}

// A long history never floods.
{
  const history = Array.from({ length: 2600 }, (_, i) => pay(`h${i}`, '1')).reverse();
  let [, st] = run(view({ payments: history }), null);
  let a;
  [a, st] = run(view({ payments: [pay('new', '1'), ...history] }), st);
  assert.equal(a.length, 1);
  for (let i = 0; i < 3; i++) {
    [a, st] = run(view({ payments: [pay('new', '1'), ...history] }), st);
    assert.equal(a.length, 0, 'no replay of old payments');
  }
}

// Delivery: Telegram and webhook shapes, per channel, no redirects, a timeout.
{
  const calls = [];
  const ok = (url, init) => { calls.push([url, JSON.parse(init.body), init.redirect, !!init.signal]); return Promise.resolve({ ok: true }); };
  const alert = { key: 'k', event: 'payment', text: 'Ops: hello' };
  assert.deepEqual(await deliver(alert, { telegramToken: 'T', telegramChat: '42', webhookUrl: 'https://hook.example/x' }, ok), { telegram: true, webhook: true });
  assert.deepEqual(calls, [
    ['https://api.telegram.org/botT/sendMessage', { chat_id: '42', text: 'Ops: hello', disable_web_page_preview: true }, 'error', true],
    ['https://hook.example/x', { text: 'Ops: hello', event: 'payment' }, 'error', true],
  ]);
  assert.deepEqual(await deliver(alert, { telegramToken: 'T', telegramChat: '42', webhookUrl: 'https://hook.example/x' }, ok, ['webhook']), { webhook: true }, 'only the due channels');
  assert.deepEqual(await deliver(alert, { webhookUrl: 'https://hook.example/x' }, () => Promise.resolve({ ok: false })), { webhook: false });
  assert.deepEqual(await deliver(alert, { webhookUrl: 'https://hook.example/x' }, () => Promise.reject(new Error('down'))), { webhook: false });
}

// Settings: a valid view key, one channel, https webhooks only (http for localhost).
{
  const key = '0x' + '12'.repeat(32);
  const ok = settings({ ZKDESK_VIEW_KEY: key, ZKDESK_ALERT_WEBHOOK_URL: 'https://hook.example/x' });
  assert.equal(ok.network, 'mainnet');
  assert.equal(ok.interval, 60);
  assert.equal(settings({ ZKDESK_VIEW_KEY: key, ZKDESK_ALERT_WEBHOOK_URL: 'http://127.0.0.1:9/x', ZKDESK_WATCH_INTERVAL: '1' }).interval, 15, 'at least 15 s');
  assert.throws(() => settings({ ZKDESK_VIEW_KEY: '0x12', ZKDESK_ALERT_WEBHOOK_URL: 'https://h/x' }), /view key/);
  assert.throws(() => settings({ ZKDESK_VIEW_KEY: '0x' + 'ff'.repeat(32), ZKDESK_ALERT_WEBHOOK_URL: 'https://h/x' }), /view key/, 'above the field');
  assert.throws(() => settings({ ZKDESK_VIEW_KEY: key }), /Set a channel/);
  assert.throws(() => settings({ ZKDESK_VIEW_KEY: key, ZKDESK_ALERT_TELEGRAM_TOKEN: 'T' }), /both/);
  assert.throws(() => settings({ ZKDESK_VIEW_KEY: key, ZKDESK_ALERT_WEBHOOK_URL: 'http://hook.example/x' }), /https/);
  assert.throws(() => settings({ ZKDESK_VIEW_KEY: key, ZKDESK_NETWORK: 'devnet', ZKDESK_ALERT_WEBHOOK_URL: 'https://h/x' }), /mainnet or testnet/);
}

// The state file: a missing one is a first run; a damaged one (or an older format) starts fresh with a note.
{
  const dir = mkdtempSync(join(tmpdir(), 'zkd-alerts-'));
  const err = console.error;
  const notes = [];
  console.error = (m) => notes.push(m);
  try {
    assert.equal(loadState(join(dir, 'none.json')), null);
    for (const [f, text] of [['torn.json', '{"decided":['], ['types.json', JSON.stringify({ ...state, decided: [1] })], ['old.json', JSON.stringify({ v: 2, sent: [], limits })]]) {
      writeFileSync(join(dir, f), text);
      assert.equal(loadState(join(dir, f)), null, f);
    }
    writeFileSync(join(dir, 'good.json'), JSON.stringify(state));
    assert.deepEqual(loadState(join(dir, 'good.json')).decided, state.decided);
  } finally {
    console.error = err;
  }
  assert.equal(notes.length, 3, 'each damaged state is reported');
}
console.log('alerts checks passed: first run learns history, each payment decided once (oldest first, with the period total), unreadable calls decided later, no replay when rows read differently, 80% and 100% per window, approved payments the agent asked for, requests once across a mailbox outage, every limit change (also flipping back) and no false change on a failed read, per-channel retries, new channels get only new alerts, no flood over a long history, delivery shapes, watcher settings, state file recovery');
