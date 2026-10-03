import { robinhood, robinhoodTestnet } from 'viem/chains';
import deployment46630 from './deployments/46630.json' with { type: 'json' };
import deployment4663 from './deployments/4663.json' with { type: 'json' };
import poolAbi from './abis/ZKDeskPool.json' with { type: 'json' };
import usdgAbi from './abis/MockUSDG.json' with { type: 'json' };
import deskAbi from './abis/CreditDesk.json' with { type: 'json' };
import lendingAbi from './abis/LendingPoolUSDG.json' with { type: 'json' };
import markerAbi from './abis/Marker.json' with { type: 'json' };
import stockAbi from './abis/MockStockToken.json' with { type: 'json' };
import keeperAbi from './abis/FeedKeeper.json' with { type: 'json' };
import ledgerAbi from './abis/TreasuryLedger.json' with { type: 'json' };
import vaultAbi from './abis/MockERC4626.json' with { type: 'json' };
import mandatesAbi from './abis/MandateRegistry.json' with { type: 'json' };

// Network: mainnet (4663) or testnet (46630), fixed for the life of a page or a function instance.
// Browser: ?network=, else the choice saved by the navbar switch, else mainnet once it is deployed. Server: the /api/mainnet/*
// wrappers set globalThis.ZKDESK_NETWORK before loading the shared handlers; otherwise testnet.
// This app version speaks to the v3 contracts (RELEASE). A network still on an older release is shown
// as upgrading; notes in older pools stay withdrawable with that release's final app version.
export const RELEASE = 5; // contract set v3.5 (Payer access end)
export const mainnetReady = deployment4663.version === RELEASE;
export const testnetReady = deployment46630.version === RELEASE;
function pick() {
  // The account worker is started with its page's network as its name.
  if (typeof window === 'undefined' && typeof WorkerGlobalScope !== 'undefined') return self.name === 'mainnet' ? 'mainnet' : 'testnet';
  if (typeof window === 'undefined') return globalThis.ZKDESK_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const asked = new URLSearchParams(window.location.search).get('network');
  let saved = null;
  try {
    saved = localStorage.getItem('zkdesk.network');
  } catch { /* storage unavailable: fall back to the default */ }
  const want = asked || saved || 'mainnet';
  if (want === 'mainnet' && mainnetReady) return 'mainnet';
  return testnetReady || !mainnetReady ? 'testnet' : 'mainnet';
}
export const network = pick();
export const MAINNET = network === 'mainnet';
export const chain = MAINNET ? robinhood : robinhoodTestnet;
export const deployment = MAINNET ? deployment4663 : deployment46630;
/** False while this network still runs older contracts: services stand down instead of failing. */
export const deploymentReady = deployment.version === RELEASE;
/** Base path of this network's API (the mainnet functions live under /api/mainnet). */
export const apiBase = MAINNET ? '/api/mainnet' : '/api';
/** Display names: real assets on mainnet, "t"-prefixed test assets on testnet. */
export const USD_SYMBOL = MAINNET ? 'USDG' : 'tUSDG';
export const NETWORK_NAME = MAINNET ? 'Robinhood Chain' : 'Robinhood Chain testnet';
export const abis = { pool: poolAbi, usdg: usdgAbi, desk: deskAbi, lending: lendingAbi, marker: markerAbi, stock: stockAbi, keeper: keeperAbi, ledger: ledgerAbi, vault: vaultAbi, mandates: mandatesAbi };
export const explorerTx = (hash) => `${chain.blockExplorers.default.url}/tx/${hash}`;

/**
 * Floor of the relay fee, in base units of the spent asset (≈5 cents): 0.05 USDG; 0.05 lending share
 * (12 decimals, ≈1 USDG each); 0.00015 of a stock token (18 decimals, ≈5 cents at $350). The live
 * minimum covers the relay's gas and is quoted by GET /api/relay (api/_lib/fees.js).
 */
export const minRelayFee = (asset) => {
  const a = String(asset).toLowerCase();
  if (a === deployment.lending.toLowerCase()) return 5n * 10n ** 10n;
  if (Object.values(deployment.stocks).some((s) => s.token.toLowerCase() === a)) return 15n * 10n ** 13n;
  return 50_000n;
};

/** What a client pays against the live minimum: 25% above it, so a proof survives a gas-price move. */
export const payableFee = (min) => (BigInt(min) * 5n + 3n) / 4n;

/** Collateral classes: symbol -> {token, feed, ltvBps, liqBps}, plus a reverse lookup. */
export const stocks = deployment.stocks;
export const symbolOf = (address) => Object.keys(stocks).find((s) => stocks[s].token.toLowerCase() === String(address).toLowerCase());
