// Folds a release (contracts/script/DeployV2.s.sol output, deployments/<chainId>.<release>.json) into
// the app's deployment file. The current contract addresses move under `v<version>` (still on-chain,
// for exits); unchanged contracts (tokens, feeds, marker, vault, Safe, timelock) stay where they are.
// Usage: node scripts/ops/merge-v2.mjs <chainId> [release, default v2] [--replace]
// --replace: a corrected deployment of the current release; the superseded set moves under `v<n>-replaced`.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const id = process.argv[2];
const release = process.argv[3] ?? 'v2';
const version = Number(release.slice(1));
if (!['4663', '46630'].includes(id) || !(version >= 2)) throw new Error('Usage: merge-v2.mjs 4663|46630 [v2|v3|…]');
const path = `src/lib/chain/deployments/${id}.json`;
const d = JSON.parse(readFileSync(path, 'utf8'));
const current = d.version ?? 1;
const fresh = JSON.parse(readFileSync(`src/lib/chain/deployments/${id}.${release}.json`, 'utf8'));
const replace = process.argv[4] === '--replace';
if (replace ? current !== version : current >= version) throw new Error(`${path} is ${replace ? 'not' : 'already'} ${release}`);

// Robinhood Chain is an Arbitrum chain: Solidity's block.number there is the parent chain's block, so
// the first deploy block for log scans comes from the broadcast receipts (L2 block numbers).
const receipts = JSON.parse(readFileSync(`contracts/broadcast/DeployV2.s.sol/${id}/run-latest.json`, 'utf8')).receipts;
fresh.deployBlock = Math.min(...receipts.map((r) => parseInt(r.blockNumber, 16)));

const MOVED = ['pool', 'assetGate', 'lending', 'desk', 'deskGuardian', 'ledger', 'mandates', 'venue', 'amm', 'deployBlock', 'deskBlock', 'ledgerBlock', 'mandatesBlock', 'deployedAt'];
const old = Object.fromEntries(MOVED.filter((k) => k in d).map((k) => [k, d[k]]));
const block = fresh.deployBlock;
const next = {
  ...d, ...fresh, version, [`v${current}${replace ? '-replaced' : ''}`]: old,
  deployBlock: block, deskBlock: block, ledgerBlock: block, mandatesBlock: block,
};
writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
rmSync(`src/lib/chain/deployments/${id}.${release}.json`);
console.log(`${path}: ${release} pool ${next.pool}, desk ${next.desk}; the previous set kept under "v${current}${replace ? '-replaced' : ''}"`);
