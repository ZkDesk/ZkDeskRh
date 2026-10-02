// Relay fees: every relay pays for the gas it burns. The minimum is RELAY_GAS at the current gas
// price, valued in USDG at the ETH price, then converted into the spent asset. Never below the
// per-asset floor in src/lib/chain/config.js.
import { parseAbi } from 'viem';
import { abis, deployment, MAINNET, publicClient } from './server.js';
import { minRelayFee } from '../../src/lib/chain/config.js';

/** Gas a relayed step can burn: the heaviest kinds measured on mainnet use 4.4–5.1M. */
export const RELAY_GAS = 5_500_000n;
// Uniswap v3 QuoterV2 on Robinhood Chain mainnet (developers.uniswap.org, v3 deployments).
export const QUOTER = {
  address: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  abi: parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)']),
};
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'; // mainnet (docs/mainnet-facts.md)
// ponytail: fixed ETH price when no quote is available (testnet, or the pool unreachable); errs high.
const FALLBACK_ETH_USDG = 5000_000000n;
const CACHE_MS = 60_000;
let cache = null;

async function ethPriceUsdg() {
  if (!MAINNET) return FALLBACK_ETH_USDG;
  try {
    const { result: [out] } = await publicClient.simulateContract({
      ...QUOTER, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: WETH, tokenOut: deployment.usdg, amountIn: 10n ** 15n, fee: 500, sqrtPriceLimitX96: 0n }],
    });
    return out * 1000n;
  } catch {
    return FALLBACK_ETH_USDG;
  }
}

const ceilDiv = (a, b) => (a + b - 1n) / b;
const max = (a, b) => (a > b ? a : b);

/** {assetLowercase: minimum fee in base units}, cached for a minute. */
export async function relayFees() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.fees;
  const [gasPrice, eth] = await Promise.all([publicClient.getGasPrice(), ethPriceUsdg()]);
  const usdgFee = max(minRelayFee(deployment.usdg), ceilDiv(RELAY_GAS * gasPrice * eth, 10n ** 18n));
  const read = (address, abi, functionName, args) => publicClient.readContract({ address, abi, functionName, args });
  const fees = { [deployment.usdg.toLowerCase()]: usdgFee };
  const shares = [[deployment.lending, abis.lending], [deployment.vault, abis.vault]].filter(([a]) => a);
  await Promise.all([
    ...shares.map(async ([asset, abi]) => {
      fees[asset.toLowerCase()] = max(minRelayFee(asset), (await read(asset, abi, 'previewDeposit', [usdgFee])) + 1n);
    }),
    ...Object.values(deployment.stocks).map(async ({ token }) => {
      const [mark] = await read(deployment.marker, abis.marker, 'current', [token]);
      // mark: USD (8 dp) per 1e18 base units, so value in USDG base units = units * mark / 1e20.
      if (mark > 0n) fees[token.toLowerCase()] = max(minRelayFee(token), ceilDiv(usdgFee * 10n ** 20n, mark));
    }),
  ]);
  cache = { at: Date.now(), fees };
  return fees;
}
