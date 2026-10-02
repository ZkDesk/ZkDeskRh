// Build of record, reproducible from a clone. For every contract a deployment uses (the addresses in
// src/lib/chain/deployments/<chainId>.json, the verifiers they point to and the libraries linked into
// them), the on-chain runtime code must equal this repository's `forge build` output once the parts
// that legitimately differ are masked: immutables (constructor values), linked library addresses and
// the compiler metadata tail. The hash is over the masked local bytecode, so anyone reproduces it from
// a clone; the comparison with the chain shows the deployment runs exactly that code.
// Usage: (cd contracts && forge build) && node scripts/build-hash.mjs [mainnet|testnet]
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const CONTRACTS = { pool: 'ZKDeskPool', assetGate: 'AssetGate', desk: 'CreditDesk', deskGuardian: 'DeskGuardian', lending: 'LendingPoolUSDG', ledger: 'TreasuryLedger', mandates: 'MandateRegistry', venue: 'UniswapV3Venue', amm: 'MockAMM' };
const VERIFIERS = {
  pool: { verifier: 'TransactVerifier' },
  desk: { verifier: 'PositionVerifier', healthVerifier: 'HealthEpochVerifier', liquidationVerifier: 'LiquidateVerifier', evictVerifier: 'EvictVerifier' },
  ledger: { ledgerVerifier: 'LedgerVerifier', authVerifier: 'RoleAuthVerifier', attestVerifier: 'TreasuryAttestVerifier' },
  mandates: { authVerifier: 'MandateAuthVerifier', pullVerifier: 'MandatePullVerifier', receiptVerifier: 'ReceiptVerifier' },
};

function artifact(file, name) {
  const path = `contracts/out/${file.split('/').pop()}/${name}.json`;
  if (!existsSync(path)) throw new Error(`missing ${path}: run forge build in contracts/ first`);
  return JSON.parse(readFileSync(path, 'utf8')).deployedBytecode;
}
/** Hex without 0x, with each [start, length) byte range zeroed and the CBOR metadata tail removed. */
function masked(hex, ranges) {
  let code = hex.replace(/^0x/, '').toLowerCase();
  for (const { start, length } of ranges) code = code.slice(0, start * 2) + '00'.repeat(length) + code.slice((start + length) * 2);
  const tail = parseInt(code.slice(-4), 16) * 2 + 4;
  return tail < code.length ? code.slice(0, -tail) : code;
}
const rangesOf = (bytecode) => [
  ...Object.values(bytecode.immutableReferences ?? {}).flat(),
  ...Object.values(bytecode.linkReferences ?? {}).flatMap((libs) => Object.values(libs).flat()),
  // A library's runtime code starts with PUSH20 <its own address> (call protection), set at deployment.
  ...(bytecode.object.replace(/^0x/, '').startsWith('73' + '00'.repeat(20)) ? [{ start: 1, length: 20 }] : []),
];

/**
 * Compares every contract of deployment `d` with the local build. client: a viem public client.
 * Returns {hash, entries: [{name, address, match}]}.
 */
export async function buildOfRecord(client, d) {
  const read = (address, functionName) => client.readContract({ address, abi: [{ type: 'function', name: functionName, inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }], functionName });
  const targets = Object.entries(CONTRACTS).filter(([k]) => d[k]).map(([k, name]) => ({ name, file: `${name}.sol`, address: d[k] }));
  const id = (t) => `${t.file.split('/').pop()}:${t.name}`; // libraries of the same name live in several verifier files
  for (const [k, getters] of Object.entries(VERIFIERS)) {
    for (const [getter, name] of Object.entries(getters)) targets.push({ name, file: `${name}.sol`, address: await read(d[k], getter) });
  }
  const entries = [];
  const seen = new Set();
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const key = `${t.name}@${t.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const local = artifact(t.file, t.name);
    const chainCode = await client.getCode({ address: t.address });
    const ranges = rangesOf(local);
    entries.push({ name: t.name, id: id(t), address: t.address, local: masked(local.object, ranges), match: !!chainCode && masked(chainCode, ranges) === masked(local.object, ranges) });
    // Linked libraries: their addresses sit in the contract's code at the link positions.
    for (const [file, libs] of Object.entries(local.linkReferences ?? {})) {
      for (const [lib, [ref]] of Object.entries(libs)) {
        const address = '0x' + (chainCode ?? '0x').replace(/^0x/, '').slice(ref.start * 2, (ref.start + ref.length) * 2);
        targets.push({ name: lib, file, address });
      }
    }
  }
  const hash = createHash('sha256');
  for (const e of [...new Map(entries.map((e) => [e.id, e])).values()].sort((a, b) => (a.id < b.id ? -1 : 1))) hash.update(`${e.id}:${e.local}\n`);
  return { hash: hash.digest('hex'), entries: entries.map(({ name, address, match }) => ({ name, address, match })) };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const net = process.argv[2] === 'testnet' ? 'testnet' : 'mainnet';
  globalThis.ZKDESK_NETWORK = net;
  const { createPublicClient, http } = await import('viem');
  const { chain, deployment } = await import('../src/lib/chain/config.js');
  const client = createPublicClient({ chain, transport: http(process.env.RPC_URL || undefined) });
  const { hash, entries } = await buildOfRecord(client, deployment);
  for (const e of entries) console.log(`${e.match ? 'match   ' : 'MISMATCH'}  ${e.name.padEnd(24)} ${e.address}`);
  console.log(`\n${net}: ${entries.filter((e) => e.match).length}/${entries.length} contracts and libraries run this build`);
  console.log(`build-of-record sha256: ${hash}`);
  process.exitCode = entries.every((e) => e.match) ? 0 : 1;
}
