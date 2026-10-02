// Static privacy checks for CI (no network, no database). Fails on:
//   1. a public mirror column that could tie value or identity to a note (same rule as
//      supabase/tests/privacy.sql, applied to the migrations' CREATE TABLE statements)
//   2. server code that reads client IPs or logs request bodies / relay payloads
//   3. browser code that persists keys, notes or openings to storage
//   4. server-only secrets referenced from browser code or present in the built bundle
//   5. key derivation or a client on the page instead of the account worker
// Usage: node scripts/privacy-check.mjs   (run after `pnpm build` to include dist/)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];
const walk = (dir, ext) => existsSync(dir) ? readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p, ext) : ext.some((e) => p.endsWith(e)) ? [p] : [];
}) : [];

// 1. Mirror columns.
const SENSITIVE = /(amount|owner|recipient|ltv|rate|balance|plaintext|blinding|secret|email|(^|_)ip($|_))/i;
const ALLOWED = new Set(['deposits.amount', 'solvency.pool_balance', 'users.owner_pk', 'rate_checkpoints.rate_per_second']);
for (const file of walk('supabase/migrations', ['.sql'])) {
  const sql = readFileSync(file, 'utf8');
  for (const [, table, body] of sql.matchAll(/create table (?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    for (const line of body.split('\n')) {
      const column = line.trim().match(/^(\w+)\s+\w/)?.[1];
      if (!column || /^(primary|unique|constraint|check|foreign)$/i.test(column)) continue;
      if (SENSITIVE.test(column) && !ALLOWED.has(`${table}.${column}`)) failures.push(`${file}: public column ${table}.${column} looks sensitive`);
    }
  }
  for (const [, table, column] of sql.matchAll(/alter table (?:public\.)?(\w+) add column (\w+)/gi)) {
    if (SENSITIVE.test(column) && !ALLOWED.has(`${table}.${column}`)) failures.push(`${file}: public column ${table}.${column} looks sensitive`);
  }
}

// 2. Server code: no client IPs, no logging of requests or payloads.
for (const file of walk('api', ['.js'])) {
  const src = readFileSync(file, 'utf8');
  if (/x-forwarded-for|x-real-ip|remoteAddress|req\.ip\b/i.test(src)) failures.push(`${file}: reads the client IP`);
  if (/console\.(log|info|warn|error|debug)\s*\([^)]*\b(req|body|proof|ext|witness)\b/.test(src)) failures.push(`${file}: logs request or proof data`);
}

// 3 + 4. Browser code: no key/note persistence, no server secrets.
const SECRETS = /(RELAYER_PRIVATE_KEY|KEEPER_PRIVATE_KEY|ALERT_TELEGRAM_TOKEN|ALERT_WEBHOOK_URL|DEPLOYER_PRIVATE_KEY|DESK_OPERATOR_SK|SCHEDULER_SEED|SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE|CRON_SECRET)/;
for (const file of [...walk('src/lib', ['.js']), ...walk('src/dashboard/adapters', ['.js'])]) {
  const src = readFileSync(file, 'utf8');
  if (/(localStorage|sessionStorage|indexedDB)\s*\.\s*(setItem|open)/.test(src)) failures.push(`${file}: writes browser storage (keys and notes must stay in memory)`);
  if (SECRETS.test(src)) failures.push(`${file}: references a server secret`);
}
// 5. Keys stay in the account worker: the page never derives keys or builds a client.
for (const file of walk('src/dashboard', ['.js', '.jsx'])) {
  if (/\b(deriveKeys|createClient)\s*\(/.test(readFileSync(file, 'utf8'))) failures.push(`${file}: derives keys or builds a client on the page (keys belong in lib/zk/account.worker.js)`);
}
for (const file of walk('dist', ['.js', '.html'])) {
  if (SECRETS.test(readFileSync(file, 'utf8'))) failures.push(`${file}: built bundle contains a server secret name`);
}

if (failures.length) {
  console.error(`privacy check failed:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`privacy check passed (${walk('supabase/migrations', ['.sql']).length} migrations, ${walk('api', ['.js']).length} API files, ${walk('dist', ['.js']).length} bundle files)`);
}
