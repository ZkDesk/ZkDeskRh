// Testnet demo: moves a mock stock feed and pins the new mark (deployer is the feeds' owner).
// The cron's ±0.5% walk continues from the new level; move it back the same way.
// Usage: node scripts/ops/set-price.mjs tNVDA -40%   |   node scripts/ops/set-price.mjs tNVDA 120
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, deployment, abis } from '../../src/lib/chain/config.js';

const [symbol, arg] = process.argv.slice(2);
const stock = deployment.stocks[symbol];
if (!stock || !arg) throw new Error('Usage: set-price.mjs <tSPY|tQQQ|tNVDA|tTSLA> <-40% | 120>');
const key = readFileSync('.env.local', 'utf8').match(/DEPLOYER_PRIVATE_KEY="([^"]+)"/)[1];
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const wallet = createWalletClient({ account, chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const FEED = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)', 'function setAnswer(int256)']);

const [, current] = await publicClient.readContract({ address: stock.feed, abi: FEED, functionName: 'latestRoundData' });
const next = arg.endsWith('%')
  ? (current * BigInt(Math.round((100 + Number(arg.slice(0, -1))) * 100))) / 10_000n
  : BigInt(Math.round(Number(arg) * 1e8));
for (const [label, address, abi, functionName, args] of [
  ['feed', stock.feed, FEED, 'setAnswer', [next]],
  ['pin', deployment.marker, abis.marker, 'pin', [stock.token]],
]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${hash}`);
}
console.log(`${symbol}: $${formatUnits(current, 8)} -> $${formatUnits(next, 8)}`);
