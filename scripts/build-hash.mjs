// Build-of-record hash: SHA-256 over the runtime bytecode of every contract and library a deployment
// created, from `forge build` output, with each bytecode's compiler metadata tail removed (it carries
// source-path details that differ between machines). Rebuild the deployment's commit and run this to
// reproduce the hash in the README.
// Usage: (cd contracts && forge build) && node scripts/build-hash.mjs [chainId]   (default 4663)
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const chainId = process.argv[2] ?? '4663';
const run = JSON.parse(readFileSync(`contracts/broadcast/DeployV2.s.sol/${chainId}/run-latest.json`, 'utf8'));
const created = run.transactions.filter((t) => t.transactionType === 'CREATE').map((t) => t.contractName);
const libraries = run.libraries.map((l) => { const [file, name] = l.split(':'); return `${file}:${name}`; });

/** Drops the CBOR metadata the compiler appends (its length is the last two bytes). */
const stripMetadata = (hex) => {
  const code = hex.replace(/^0x/, '');
  const len = parseInt(code.slice(-4), 16) * 2 + 4;
  return len < code.length ? code.slice(0, -len) : code;
};
function runtime(file, name) {
  const base = file.split('/').pop();
  const path = `contracts/out/${base}/${name}.json`;
  if (!existsSync(path)) throw new Error(`missing ${path}: run forge build first`);
  return stripMetadata(JSON.parse(readFileSync(path, 'utf8')).deployedBytecode.object);
}
const entries = [
  ...[...new Set(created)].map((name) => [name, runtime(`${name}.sol`, name)]),
  ...libraries.map((l) => { const [file, name] = l.split(':'); return [l, runtime(file, name)]; }),
].sort(([a], [b]) => (a < b ? -1 : 1));
const hash = createHash('sha256');
for (const [name, code] of entries) hash.update(`${name}:${code}\n`);
console.log(`chain ${chainId}, deploy commit ${run.commit}, ${entries.length} contracts and libraries`);
console.log(`build-of-record sha256: ${hash.digest('hex')}`);
