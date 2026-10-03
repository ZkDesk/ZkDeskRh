// Moving a treasury to new keys (3.21): the parts that decide, kept pure so they are tested on their own.
// A treasury's identity is its secret (ledger id, note owner and nullifier key all come from it), so new
// keys are a new treasury and the funds move across. client.rekeyLedger runs the steps.
import { poseidon4 } from 'poseidon-lite';

export { rekeyStepCount } from './rekey-steps.js';

export const DOM_REKEY = 0x5a4b442e72656b6579n; // "ZKD.rekey"

/**
 * The new treasury's secret: from the Owner's personal key and the old treasury's id. A re-run finds the
 * same treasury and continues; someone holding only the old secret (a removed agent) cannot derive it.
 */
export const rekeySecret = (sk, oldId) => poseidon4([DOM_REKEY, sk, oldId, 0n]);

/** A carried mandate's salt: hides it like any mandate, and only the Owner can recompute it. */
export const rekeySalt = (sk, oldId, oldCommit) => poseidon4([DOM_REKEY, sk, oldId, oldCommit]);

/** A mandate that can still pay (not revoked, not expired). */
export const liveMandate = (m, now) => m.status !== 'Revoked' && m.expiry > now;

/**
 * The mandate that continues `m` in the new treasury, or null when nothing is left to pay (revoked,
 * expired, a paid invoice, or past its last period). It starts right after the last period paid, so no
 * period is paid twice; an earlier period that was skipped is not carried.
 */
export function carriedMandate(m, now, salt) {
  if (!liveMandate(m, now)) return null;
  let start = m.start;
  if (m.period === 0n) {
    if (m.paid.has(0n)) return null;
  } else {
    const next = m.paid.size ? [...m.paid].reduce((a, b) => (b > a ? b : a)) + 1n : 0n;
    start = m.start + next * m.period;
    if (start >= m.expiry) return null;
  }
  const { kind, recipient, recipientEncPub, asset, cap, period, expiry, reference, label } = m;
  return { kind, recipient, recipientEncPub, asset, cap, period, start, expiry, reference, label: label ?? '', salt };
}

// Notes worth moving: unspent, and (for `minOf(asset)`) worth more than what moving them costs.
const movable = (notes, minOf) => notes.filter((n) => n.status === 'unspent' && n.amount > 0n && n.amount >= minOf(n.asset));

/**
 * The next move: the two largest movable notes of one asset (a ledger transfer spends at most two),
 * skipping assets in `skip` (ones whose moves failed in this run). minOf(asset): the smallest note worth
 * moving (dust below it stays, so a stranger cannot drain the Owner's fees by spraying tiny deposits).
 */
export function nextMove(notes, { skip = new Set(), minOf = () => 1n } = {}) {
  const open = movable(notes, minOf).filter((n) => !skip.has(n.asset));
  if (!open.length) return null;
  const asset = open[0].asset;
  const two = open.filter((n) => n.asset === asset).sort((a, b) => (b.amount > a.amount ? 1 : -1)).slice(0, 2);
  return { asset, amount: two.reduce((t, n) => t + n.amount, 0n), inputs: two };
}

/** What moving still involves: per asset, the amount and transactions; dust left behind; notes clearing. */
export function moveSummary(notes, { minOf = () => 1n } = {}) {
  const assets = new Map();
  for (const n of movable(notes, minOf)) {
    const a = assets.get(n.asset) ?? { asset: n.asset, amount: 0n, notes: 0 };
    a.amount += n.amount;
    a.notes += 1;
    assets.set(n.asset, a);
  }
  const moves = [...assets.values()].map((a) => ({ ...a, txs: Math.ceil(a.notes / 2) }));
  const open = notes.filter((n) => n.status === 'unspent' && n.amount > 0n);
  return {
    moves,
    txs: moves.reduce((t, m) => t + m.txs, 0),
    dust: open.length - movable(notes, minOf).length,
    pending: notes.filter((n) => n.status === 'pending').length,
  };
}

/** The first `max` UTF-8 bytes of `text`, cut between characters. */
export function cutBytes(text, max) {
  let out = '';
  for (const ch of text) {
    if (new TextEncoder().encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}
