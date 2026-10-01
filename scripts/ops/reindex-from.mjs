// Rewinds the chain mirror's cursor so the next cron tick re-indexes from `block` (inserts are
// idempotent). Use after shipping an indexer that reads new events, once the new code is live.
// Usage: node scripts/ops/reindex-from.mjs <block>
import { readFileSync } from 'node:fs';
import pg from 'pg';
import ca from '../../api/_lib/supabase-ca.js';

const block = BigInt(process.argv[2]);
const url = readFileSync('.env.local', 'utf8').match(/SUPABASE_DB_URL="([^"]+)"/)[1];
const db = new pg.Client({ connectionString: url, ssl: { ca } });
await db.connect();
const { rows } = await db.query(`update public.chain_cursor set block = least(block, $1) where name = 'pool' returning block`, [(block - 1n).toString()]);
console.log(`cursor now ${rows[0]?.block}`);
await db.end();
