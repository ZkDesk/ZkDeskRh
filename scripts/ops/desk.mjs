// Runs one desk-operator epoch locally (fallback for api/cron/desk.js): open every slot, prove and
// attest the epoch, liquidate breached slots. Uses .env.local (DESK_OPERATOR_SK, RELAYER_PRIVATE_KEY).
// Usage: node scripts/ops/desk.mjs
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { runDesk } = await import('../../api/cron/desk.js');
const { createProver } = await import('../../src/lib/zk/prover.js');

const circuit = (name) => JSON.parse(readFileSync(`src/lib/zk/artifacts/${name}.json`, 'utf8'));
const provers = { health_epoch: await createProver(circuit('health_epoch')), liquidate: await createProver(circuit('liquidate')) };
const report = await runDesk({ operatorSk: BigInt(process.env.DESK_OPERATOR_SK), prove: (kind, w) => provers[kind].prove(w), log: (m) => console.log(`· ${m}`) });
console.log(JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
await Promise.all(Object.values(provers).map((p) => p.destroy()));
process.exit(0);
