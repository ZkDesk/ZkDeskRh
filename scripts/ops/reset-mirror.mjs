// Clears the Supabase chain mirror so the indexer rebuilds it from the current deployment's
// deployBlock (use after a redeploy). Testnet ops only. Usage: node scripts/ops/reset-mirror.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';
import ca from '../../api/_lib/supabase-ca.js';

const url = readFileSync('.env.local', 'utf8').match(/SUPABASE_DB_URL="([^"]+)"/)[1];
const db = new pg.Client({ connectionString: url, ssl: { ca } });
await db.connect();
await db.query('truncate public.commitments, public.encrypted_notes, public.nullifiers, public.deposits, public.positions, public.credit_flows, public.marks, public.rate_checkpoints, public.chain_cursor');
console.log('mirror cleared');
await db.end();
