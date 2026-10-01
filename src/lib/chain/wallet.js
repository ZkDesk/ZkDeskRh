// MetaMask connection on Robinhood Chain (the page's network: mainnet or testnet). Only MetaMask is offered: it is found through
// EIP-6963 (rdns io.metamask) or, for older setups, a legacy injected provider that is really
// MetaMask. Wallets that also claim isMetaMask (Phantom, Brave, Coinbase, Rabby, ...) are skipped.
import { createPublicClient, createWalletClient, custom, http, numberToHex } from 'viem';
import { chain } from './config.js';

export const publicClient = createPublicClient({ chain, transport: http() });

const IMPOSTORS = ['isPhantom', 'isBraveWallet', 'isCoinbaseWallet', 'isRabby', 'isTrust', 'isTrustWallet', 'isOkxWallet', 'isOKExWallet', 'isBitKeep', 'isTokenPocket', 'isZerion', 'isFrame'];
const isRealMetaMask = (p) => Boolean(p?.isMetaMask) && !IMPOSTORS.some((flag) => p[flag]);

let announced = null;
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event) => {
    if (event.detail?.info?.rdns === 'io.metamask') announced = event.detail.provider;
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** The MetaMask provider, or null. Never another wallet, even one that sets isMetaMask. */
export function metaMask() {
  if (typeof window === 'undefined') return null;
  if (announced) return announced;
  const eth = window.ethereum;
  const injected = Array.isArray(eth?.providers) ? eth.providers : [eth];
  return injected.find(isRealMetaMask) ?? null;
}

export const hasWallet = () => Boolean(metaMask());

async function ensureChain(provider) {
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === chain.id) return;
  const chainId = numberToHex(chain.id);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{
      chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency,
      rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url],
    }] });
  }
}

/** Asks the wallet for an account on the page's chain (4663 or 46630). Returns { address, walletClient }. */
export async function connectWallet() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((resolve) => setTimeout(resolve, 50)); // let MetaMask announce itself
  const provider = metaMask();
  if (!provider) throw new Error('MetaMask was not found. Install MetaMask (other wallets are not supported) and try again.');
  const [address] = await provider.request({ method: 'eth_requestAccounts' });
  await ensureChain(provider);
  return { address, walletClient: createWalletClient({ account: address, chain, transport: custom(provider) }) };
}

/** Calls back when the wallet account or chain changes; returns an unsubscribe function. */
export function onWalletChange(callback) {
  const provider = metaMask();
  if (!provider?.on) return () => {};
  provider.on('accountsChanged', callback);
  provider.on('chainChanged', callback);
  return () => {
    provider.removeListener?.('accountsChanged', callback);
    provider.removeListener?.('chainChanged', callback);
  };
}
