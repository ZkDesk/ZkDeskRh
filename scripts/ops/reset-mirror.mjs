// Clears the Supabase chain mirror so the indexer rebuilds it from the current deployment's
// deployBlock (use after a redeploy, e.g. v2). Relayer state, operations, vouchers and mailbox keys
// are kept. Usage: node scripts/ops/reset-mirror.mjs [mainnet]   (default: testnet, schema public)
import { readFileSync } from 'node:fs';
import pg from 'pg';
import ca from '../../api/_lib/supabase-ca.js';

const schema = process.argv[2] === 'mainnet' ? 'mainnet' : 'public';
const TABLES = ['commitments', 'encrypted_notes', 'nullifiers', 'deposits', 'positions', 'credit_flows', 'marks', 'rate_checkpoints', 'chain_cursor',
  'desk_epochs', 'liq_batches', 'ledgers', 'treasury_epochs', 'mandates_pub', 'receipts_pub', 'solvency', 'lending_snapshots'];
const url = readFileSync('.env.local', 'utf8').match(/SUPABASE_DB_URL="([^"]+)"/)[1];
const db = new pg.Client({ connectionString: url, ssl: { ca } });
await db.connect();
await db.query(`truncate ${TABLES.map((t) => `${schema}.${t}`).join(', ')}`);
console.log(`${schema} mirror cleared (${TABLES.length} tables)`);
await db.end();
