// Shared server-side clients for Vercel Functions. Secrets come from Vercel env only.
import { rmSync } from 'node:fs';
import pg from 'pg';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, deployment, abis, MAINNET } from '../../src/lib/chain/config.js';
import ca from './supabase-ca.js';

export { chain, deployment, abis, MAINNET };

/** A service secret for this network: the mainnet functions read MAINNET_<name>. */
export const secret = (name) => process.env[MAINNET ? `MAINNET_${name}` : name];

// Supavisor transaction mode (6543) suits short-lived serverless connections.
const dbUrl = (process.env.SUPABASE_DB_URL || '').replace(':5432/', ':6543/');
export const db = new pg.Pool({ connectionString: dbUrl, ssl: { ca }, max: 2, idleTimeoutMillis: 5000 });
// Mainnet mirrors live in their own schema (same migrations): queries are written against public.
export const SCHEMA = MAINNET ? 'mainnet' : 'public';
const inSchema = (q) => (typeof q === 'string' ? q.replace(/\bpublic\./g, `${SCHEMA}.`) : q?.text ? { ...q, text: inSchema(q.text) } : q);
if (MAINNET) {
  db.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = (q, ...rest) => query(inSchema(q), ...rest);
  });
}

const transport = http(secret('RPC_URL_SERVER') || undefined);
export const publicClient = createPublicClient({ chain, transport });
export const relayer = secret('RELAYER_PRIVATE_KEY') ? privateKeyToAccount(secret('RELAYER_PRIVATE_KEY')) : null;
const walletClient = relayer ? createWalletClient({ account: relayer, chain, transport }) : null;

/**
 * Sends a pool call from the relayer. Nonces are serialized through a row lock so concurrent
 * function instances never reuse one, and never go below the chain's pending count.
 */
export async function sendFromRelayer(functionName, args, gas, { address = deployment.pool, abi = abis.pool } = {}) {
  if (!walletClient) throw Object.assign(new Error('Relayer is not configured.'), { code: 'relayer_unavailable' });
  const conn = await db.connect();
  try {
    await conn.query('begin');
    const { rows } = await conn.query('select next_nonce from public.relayer_state where id = 1 for update');
    const chainNonce = await publicClient.getTransactionCount({ address: relayer.address, blockTag: 'pending' });
    const nonce = Math.max(Number(rows[0]?.next_nonce ?? 0), chainNonce);
    const hash = await walletClient.writeContract({ address, abi, functionName, args, nonce, gas });
    await conn.query('update public.relayer_state set next_nonce = $1 where id = 1', [nonce + 1]);
    await conn.query('commit');
    return { hash, nonce };
  } catch (error) {
    await conn.query('rollback');
    throw error;
  } finally {
    conn.release();
  }
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
