// The private account runs here, off the page: keys (derived from the wallet signature), the client
// (note sync, witnesses, ciphertexts) and the prover. The page only receives public-shaped data:
// notes and positions it displays anyway, and treasuries with their secrets stripped (referenced
// back by id). Wallet transactions (faucet, approve, deposit) are asked of the page, where the
// wallet lives. Terminating the worker (wallet change) wipes the keys.
import { deriveKeys } from './keys.js';
import { createClient } from './client.js';
import { createProver } from './prover.js';
import { mailbox, relay } from './transport.js';
import { publicClient } from '../chain/wallet.js';

const CIRCUITS = {
  transact: () => import('./artifacts/transact.json'),
  position: () => import('./artifacts/position.json'),
  ledger: () => import('./artifacts/ledger.json'),
  role_auth: () => import('./artifacts/role_auth.json'),
  treasury_attest: () => import('./artifacts/treasury_attest.json'),
  mandate_auth: () => import('./artifacts/mandate_auth.json'),
  mandate_pull: () => import('./artifacts/mandate_pull.json'),
  receipt: () => import('./artifacts/receipt.json'),
};
const provers = {};
async function prove(kind, witness) {
  if (!CIRCUITS[kind]) throw new Error(`Unknown circuit: ${kind}`);
  provers[kind] ??= CIRCUITS[kind]().then(({ default: circuit }) => createProver(circuit, { threads: self.crossOriginIsolated ? navigator.hardwareConcurrency : 1 }));
  return (await provers[kind]).prove(witness);
}

let seq = 0;
const asked = new Map();
const askPage = (method, args) => new Promise((resolve, reject) => {
  const id = `w${++seq}`;
  asked.set(id, { resolve, reject });
  self.postMessage({ type: 'wallet', id, method, args });
});

let client = null;
const SECRET = ['lsk', 'nk', 'encSecret', 'requestKey'];
const strip = (l) => l && { ...Object.fromEntries(Object.entries(l).filter(([k]) => !SECRET.includes(k))), __ledger: true };
const unstrip = (x) => (x && typeof x === 'object' && x.__ledger ? client.ledgers().find((l) => l.owner === x.owner) : x);

const api = {
  /** Derives the keys here; returns only the public address parts. */
  init(signature, address) {
    const keys = deriveKeys(signature);
    client = createClient({
      publicClient, address, keys, prove, relay, requests: mailbox,
      walletClient: { writeContract: (args) => askPage('writeContract', args) },
      onStatus: (message) => self.postMessage({ type: 'status', message }),
    });
    return { owner: keys.owner, encPub: keys.encPub };
  },
  /** Everything the dashboard shows, for the personal account or one treasury (by id). */
  async snapshot(workspace) {
    await client.sync();
    const ledgers = client.ledgers();
    const L = workspace ? ledgers.find((l) => l.owner === workspace) ?? null : null;
    return {
      ledgers: ledgers.map(strip), ledger: strip(L),
      notes: L ? client.ledgerNotes(L) : client.notes(),
      positions: L ? [] : client.positions(),
      receipts: L ? [] : client.receipts(),
      mandates: L ? client.mandates(L) : [],
      requests: L ? await client.ledgerRequests(L).catch(() => []) : [],
    };
  },
  async sync() {
    await client.sync(); // the pool state holds functions: never sent to the page
  },
};

self.onmessage = async ({ data }) => {
  if (data.type === 'walletResult') {
    const p = asked.get(data.id);
    asked.delete(data.id);
    if (data.error) p?.reject(new Error(data.error)); else p?.resolve(data.result);
    return;
  }
  const { id, method, args = [] } = data;
  try {
    const fn = api[method] ?? (client && typeof client[method] === 'function' ? client[method] : null);
    if (!fn) throw new Error(client ? `Unknown account method ${method}` : 'Connect your wallet first.');
    const result = await fn(...args.map(unstrip));
    self.postMessage({ id, result: result && typeof result === 'object' && result.lsk ? strip(result) : result });
  } catch (error) {
    self.postMessage({ id, error: error?.shortMessage || error?.message || String(error) });
  }
};
