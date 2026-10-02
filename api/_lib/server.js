// Shared server-side clients for Vercel Functions. Secrets come from Vercel env only.
import { rmSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, deployment, abis, MAINNET } from '../../src/lib/chain/config.js';
import ca from './supabase-ca.js';

export { chain, deployment, abis, MAINNET };

/** A service secret for this network: the mainnet functions read MAINNET_<name>. */
export const secret = (name) => process.env[MAINNET ? `MAINNET_${name}` : name];

// Supavisor transaction mode (6543) suits short-lived serverless connections. An sslmode in the URL
// would override the pinned CA below, so it is dropped.
const dbUrl = (process.env.SUPABASE_DB_URL || '').replace(':5432/', ':6543/').replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
export const db = new pg.Pool({ connectionString: dbUrl, ssl: { ca }, max: 2, idleTimeoutMillis: 5000 });
// Mainnet mirrors live in their own schema (same migrations): queries are written against public.
// DB_SCHEMA: an isolated schema for fork tests (supabase/migrate.mjs <schema>).
export const SCHEMA = process.env.DB_SCHEMA || (MAINNET ? 'mainnet' : 'public');
const inSchema = (q) => (typeof q === 'string' ? q.replace(/\bpublic\./g, `${SCHEMA}.`) : q?.text ? { ...q, text: inSchema(q.text) } : q);
if (SCHEMA !== 'public') {
  db.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = (q, ...rest) => query(inSchema(q), ...rest);
  });
}

const transport = http(secret('RPC_URL_SERVER') || undefined);
export const publicClient = createPublicClient({ chain, transport });
const account = (name) => (secret(name) ? privateKeyToAccount(secret(name)) : null);
/** Pays gas for user relays only. */
export const relayer = account('RELAYER_PRIVATE_KEY');
/** Pays gas for the services (desk epochs, liquidations, marks, deposit clearing), so spam on the
 * relay cannot starve liquidations. Falls back to the relayer until a keeper key is configured. */
export const keeper = account('KEEPER_PRIVATE_KEY') ?? relayer;
const wallets = new Map([relayer, keeper].filter(Boolean).map((a) => [a, createWalletClient({ account: a, chain, transport })]));

/**
 * Sends a contract call from `from` (relayer or keeper). Nonces are serialized through a row lock per
 * account so concurrent function instances never reuse one, and never go below the chain's pending count.
 */
export async function sendFrom(from, functionName, args, gas, { address = deployment.pool, abi = abis.pool } = {}) {
  const walletClient = wallets.get(from);
  if (!walletClient) throw Object.assign(new Error('Relayer is not configured.'), { code: 'relayer_unavailable' });
  const conn = await db.connect();
  try {
    await conn.query('begin');
    const id = from === relayer ? 1 : 2;
    const { rows } = await conn.query('select next_nonce from public.relayer_state where id = $1 for update', [id]);
    const chainNonce = await publicClient.getTransactionCount({ address: from.address, blockTag: 'pending' });
    const nonce = Math.max(Number(rows[0]?.next_nonce ?? 0), chainNonce);
    const hash = await walletClient.writeContract({ address, abi, functionName, args, nonce, gas });
    await conn.query('update public.relayer_state set next_nonce = $1 where id = $2', [nonce + 1, id]);
    await conn.query('commit');
    return { hash, nonce };
  } catch (error) {
    await conn.query('rollback');
    throw error;
  } finally {
    conn.release();
  }
}

export const sendFromRelayer = (...a) => sendFrom(relayer, ...a);
export const sendFromKeeper = (...a) => sendFrom(keeper, ...a);

/** Vercel Cron's bearer token, compared in constant time. */
export function cronAuthorized(req) {
  const digest = (x) => createHash('sha256').update(String(x)).digest();
  return Boolean(process.env.CRON_SECRET) && timingSafeEqual(digest(req.headers?.authorization ?? ''), digest(`Bearer ${process.env.CRON_SECRET}`));
}

/**
 * Proves with a lazily created prover, retrying once from an empty CRS cache: a torn CRS download
 * (an instance stopped mid-write, or two provers fetching at once) stays in /tmp and fails every
 * later run with "SrsInitSrs … SHA-256 mismatch". bb.js caches the CRS; /tmp is the only writable path.
 */
export function cachedProver(createProver, circuits) {
  let provers = {};
  const get = (kind) => (provers[kind] ??= createProver(circuits[kind], { crsPath: '/tmp/bb-crs' }));
  return async (kind, witness) => {
    try {
      return await (await get(kind)).prove(witness);
    } catch (error) {
      if (!/SrsInitSrs|SHA-256 mismatch/.test(error?.message ?? '')) throw error;
      rmSync('/tmp/bb-crs', { recursive: true, force: true });
      provers = {};
      return (await get(kind)).prove(witness);
    }
  };
}

export const revertName = (error) => error?.cause?.data?.errorName || error?.shortMessage || error?.message || 'unknown_error';

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
