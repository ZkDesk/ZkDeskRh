// Folds a v2 deployment (contracts/script/DeployV2.s.sol output, deployments/<chainId>.v2.json) into
// the app's deployment file. The v1 contract addresses move under `v1` (still on-chain, for exits);
// unchanged contracts (tokens, feeds, marker, vault, Safe, timelock) stay where they are.
// Usage: node scripts/ops/merge-v2.mjs <chainId>
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const id = process.argv[2];
if (!['4663', '46630'].includes(id)) throw new Error('Usage: merge-v2.mjs 4663|46630');
const path = `src/lib/chain/deployments/${id}.json`;
const d = JSON.parse(readFileSync(path, 'utf8'));
const v2 = JSON.parse(readFileSync(`src/lib/chain/deployments/${id}.v2.json`, 'utf8'));
if (d.version === 2) throw new Error(`${path} is already v2`);

// Robinhood Chain is an Arbitrum chain: Solidity's block.number there is the parent chain's block, so
// the first deploy block for log scans comes from the broadcast receipts (L2 block numbers).
const receipts = JSON.parse(readFileSync(`contracts/broadcast/DeployV2.s.sol/${id}/run-latest.json`, 'utf8')).receipts;
v2.deployBlock = Math.min(...receipts.map((r) => parseInt(r.blockNumber, 16)));

const MOVED = ['pool', 'assetGate', 'lending', 'desk', 'deskGuardian', 'ledger', 'mandates', 'venue', 'amm', 'deployBlock', 'deskBlock', 'ledgerBlock', 'mandatesBlock', 'deployedAt'];
const v1 = Object.fromEntries(MOVED.filter((k) => k in d).map((k) => [k, d[k]]));
const block = v2.deployBlock;
const next = {
  ...d, ...v2, version: 2, v1,
  deployBlock: block, deskBlock: block, ledgerBlock: block, mandatesBlock: block,
};
writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
rmSync(`src/lib/chain/deployments/${id}.v2.json`);
console.log(`${path}: v2 pool ${next.pool}, desk ${next.desk}; v1 kept under "v1"`);
