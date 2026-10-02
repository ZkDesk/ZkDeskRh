// Vercel Cron, hourly: the ZKDesk scheduler pays due mandates, unattended. Opt-in per treasury: a
// treasury that makes the scheduler's ZKDesk address (deployments `scheduler`) its Payer gives it
// that role's key share, like any Payer; nothing else can make it act. Each run pays the current
// period of every active mandate that is due and unpaid, at the mandate cap, through the same
// mandate_pull proof and relay as a person would (cap, period, expiry and one pull per period are
// enforced by the circuit and the MandateRegistry). Holds SCHEDULER_SEED (Vercel env only).
import { cachedProver, cronAuthorized, deployment, json, publicClient, revertName, secret } from '../_lib/server.js';
import { deploymentReady } from '../_lib/server.js';
import { seedKeys } from '../../src/lib/zk/keys.js';
import { createClient } from '../../src/lib/zk/client.js';
import { createProver } from '../../src/lib/zk/prover.js';
import { currentPeriod } from '../../src/lib/zk/mandate.js';
import relayHandler from '../relay.js';
import pullCircuit from '../../src/lib/zk/artifacts/mandate_pull.json' with { type: 'json' };

const MAX_PULLS = 3; // successful pulls per run: proofs take ~10-50 s in a Function
const TIME_BUDGET_MS = 220_000; // of the Function's 300 s

/** In-process relay (the same handler the browser calls). */
const relay = (body) => new Promise((resolve) => relayHandler(body ? { method: 'POST', body, internal: true } : { method: 'GET' }, { statusCode: 200, setHeader() {}, end(b) { resolve(JSON.parse(b)); } }));

/** The treasuries in a different starting order every run (run = an hour number). */
export const rotate = (list, run) => (list.length ? [...list.slice(run % list.length), ...list.slice(0, run % list.length)] : list);

/** One scheduler run. Exported for scripts/ops. */
export async function runPulls({ keys, prove, log = () => {} }) {
  const client = createClient({ publicClient, keys, prove, relay, onStatus: log, vouchers: false });
  await client.sync();
  const t = (await publicClient.getBlock({ blockTag: 'latest' })).timestamp;
  const report = { treasuries: 0, due: 0, paid: [], failed: [] };
  const started = Date.now();
  // Audit N-3: a treasury whose mandates fail (e.g. unfunded) must not starve the others. Only
  // successful pulls count toward MAX_PULLS, each treasury gets at most one pull per run, and the
  // starting treasury rotates every run.
  for (const ledger of rotate(client.ledgers().filter((l) => l.roles.includes('Payer')), Math.floor(Date.now() / 3_600_000))) {
    report.treasuries++;
    for (const m of client.mandates(ledger)) {
      const k = currentPeriod(m, t);
      if (m.status !== 'Active' || m.paid.has(k) || t < m.start || t >= m.expiry) continue;
      report.due++;
      if (report.paid.length >= MAX_PULLS || Date.now() - started > TIME_BUDGET_MS) continue;
      const id = { treasury: `0x${ledger.owner.toString(16).slice(0, 10)}…`, mandate: `0x${m.commit.toString(16).slice(0, 10)}…`, k: Number(k) };
      try {
        const r = await client.payMandate(ledger, 'Payer', m, m.cap);
        report.paid.push({ ...id, tx: r.txHash });
        await client.sync();
        break; // one pull per treasury per run; the rest of its due mandates wait for the next run
      } catch (error) {
        report.failed.push({ ...id, error: error.message });
      }
    }
  }
  return report;
}

const proveCached = cachedProver(createProver, { mandate_pull: pullCircuit });
const prove = async (kind, witness) => {
  if (kind !== 'mandate_pull') throw new Error(`The scheduler only proves pulls, not ${kind}.`);
  return proveCached(kind, witness);
};

export default async function handler(req, res) {
  if (!cronAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
  if (!deploymentReady) return json(res, 200, { skipped: 'network still on v1 contracts' });
  if (!secret('SCHEDULER_SEED') || !deployment.mandates) return json(res, 503, { error: 'scheduler_unavailable' });
  try {
    return json(res, 200, await runPulls({ keys: seedKeys(secret('SCHEDULER_SEED')), prove }));
  } catch (error) {
    return json(res, 500, { error: revertName(error) });
  }
}
