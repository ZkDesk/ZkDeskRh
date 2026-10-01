// Applies supabase/migrations/*.sql in order (tracked in <schema>._migrations), then runs
// supabase/tests/*.sql. Uses SUPABASE_DB_URL from .env.local. Usage: node supabase/migrate.mjs [mainnet]
// (mainnet: the same migrations in the "mainnet" schema, which the /api/mainnet functions use).
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import ca from '../api/_lib/supabase-ca.js';

const url = process.env.SUPABASE_DB_URL || readFileSync('.env.local', 'utf8').match(/SUPABASE_DB_URL="([^"]+)"/)?.[1];
if (!url) throw new Error('SUPABASE_DB_URL is not set.');
// TLS is verified against the pinned Supabase Root 2021 CA (not in Node's default store).
const db = new pg.Client({ connectionString: url, ssl: { ca } });
await db.connect();
const schema = process.argv[2] === 'mainnet' ? 'mainnet' : 'public';
const sql = (text) => (schema === 'public' ? text : text.replace(/\bpublic\./g, 'mainnet.').replace(/table_schema = 'public'/g, "table_schema = 'mainnet'"));
await db.query(`create schema if not exists ${schema}`);
await db.query(sql('create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())'));
await db.query(sql('alter table public._migrations enable row level security'));
const done = new Set((await db.query(sql('select name from public._migrations'))).rows.map((r) => r.name));
for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  await db.query('begin');
  try {
    await db.query(sql(readFileSync(`supabase/migrations/${file}`, 'utf8')));
    await db.query(sql('insert into public._migrations (name) values ($1)'), [file]);
    await db.query('commit');
    console.log(`applied ${file}`);
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
db.on('notice', (n) => console.log(n.message));
for (const file of readdirSync('supabase/tests').filter((f) => f.endsWith('.sql')).sort()) {
  await db.query(sql(readFileSync(`supabase/tests/${file}`, 'utf8')));
}
await db.end();
