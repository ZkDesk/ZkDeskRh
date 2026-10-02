// Robinhood Chain adapter (mainnet or testnet, from lib/chain/config.js): real shielded notes, lending shares and credit positions,
// mapped onto the demo model's state shape so the approved dashboard renders them unchanged.
// Workspaces: your personal account, or a treasury ledger you hold roles in (its balances, actions
// and the role selector then follow the ledger; credit stays personal).
// Keys never reach this page: the account worker (lib/zk/account.worker.js) derives them from the
// wallet signature or a passkey seed and holds them with the client and prover. A wallet account is
// terminated on wallet change; a passkey account only uses the wallet to fund deposits.
import { isAddress, parseUnits } from 'viem';
import { abis, apiBase, deployment, MAINNET, mainnetReady, testnetReady, minRelayFee, network, NETWORK_NAME, payableFee, stocks, USD_SYMBOL } from '../../lib/chain/config.js';
import { connectWallet, hasWallet, onWalletChange, publicClient } from '../../lib/chain/wallet.js';
import { createPasskey, passkeySupported, unlockPasskey } from '../../lib/chain/passkey.js';
import { keyRequest, parseZkAddress, seedWords, wordsSeed, zkAddress } from '../../lib/zk/keys.js';
import { debtOf, friendly, valueOf } from '../../lib/zk/client.js';
import { balanceOf } from '../../lib/zk/wallet.js';
import { relay } from '../../lib/zk/transport.js';
import { healthBps } from '../../lib/zk/desk.js';
import { currentPeriod, KINDS, PERIODS } from '../../lib/zk/mandate.js';
import { periodKey } from '../model.js';
import { initialState } from '../model.js';

const FAUCET_CAP = { USDG: 100_000, STOCK: 1_000 };
const usd = (raw) => Number(raw) / 1e6;
const tokens = (raw) => Number(raw) / 1e18;
const SYMBOLS = Object.keys(stocks); // testnet tSPY… / mainnet SPY…
const T = MAINNET ? '' : 't'; // deployment symbol prefix
export const plain = (symbol) => (MAINNET ? symbol : symbol.replace(/^t/, '')); // tSPY -> SPY (dashboard class names)
const tokenOf = (name) => (name === 'USDG' ? deployment.usdg : stocks[`${T}${name}`]?.token);

export { parseZkAddress, zkAddress };

let session = null; // { wallet: {address, walletClient}, passkey: bool, credential (passkey id) | null, pub: {owner, encPub}, worker, client (proxy), workspace, snap }
let notice = null; // one-shot toast text for the next state (e.g. "sent for approval")
let requestsById = new Map(); // approval requests of the active treasury, by id
let listener = null;
let market = null; // { marks: {SPY: price8}, index, shareValue, liquidity, fee }
const blockTimes = new Map();
let statusHandler = () => {};

const base = () => ({ ...initialState(), cash: 0, vault: 0, freeStock: 0, positions: [], mandates: [], activity: [] });
const emit = (state) => { listener?.(state); return state; };
const offline = (error) => ({ ...base(), meta: { mode: 'testnet', connected: false, error } });

async function timeOf(block) {
  if (!block) return Date.now();
  if (!blockTimes.has(block)) blockTimes.set(block, Number((await publicClient.getBlock({ blockNumber: block })).timestamp) * 1000);
  return blockTimes.get(block);
}

async function readMarket() {
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
  const [prices, index, liquidity, relayInfo, lastAttestedAt, healthy, epoch] = await Promise.all([
    Promise.all(SYMBOLS.map((s) => read(deployment.marker, abis.marker, 'current', [stocks[s].token]))),
    read(deployment.desk, abis.desk, 'index'),
    read(deployment.lending, abis.lending, 'cash'),
    relay(null).catch(() => ({ available: false })),
    read(deployment.desk, abis.desk, 'lastAttestedAt'),
    read(deployment.desk, abis.desk, 'healthy'),
    read(deployment.desk, abis.desk, 'epoch'),
  ]);
  return {
    desk: { epoch: Number(epoch), attestedAt: Number(lastAttestedAt) * 1000, healthy },
    marks: Object.fromEntries(SYMBOLS.map((s, i) => [plain(s), prices[i][0]])),
    index, liquidity, relayAvailable: relayInfo.available,
    // What the client pays: the live gas-covering minimum plus headroom (api/_lib/fees.js).
    fee: payableFee(relayInfo.minFee ?? minRelayFee(deployment.usdg)), shareFee: payableFee(relayInfo.fees?.[deployment.lending.toLowerCase()] ?? minRelayFee(deployment.lending)),
    shareValue: (shares) => (shares ? read(deployment.lending, abis.lending, 'previewRedeem', [shares]) : 0n),
  };
}

const vaultValue = (shares) => (shares ? publicClient.readContract({ address: deployment.vault, abi: abis.vault, functionName: 'previewRedeem', args: [shares] }) : 0n);
const hexId = (id) => '0x' + id.toString(16).padStart(64, '0');
const activeLedger = () => session?.snap?.ledger ?? null;

/** Starts the account worker. Calls are messages; wallet transactions are asked of this page (wallet: {address, walletClient}). */
function startAccount(wallet) {
  const worker = new Worker(new URL('../../lib/zk/account.worker.js', import.meta.url), { type: 'module', name: network });
  let seq = 0;
  const waiting = new Map();
  worker.onmessage = async ({ data }) => {
    if (data.type === 'status') return statusHandler(data.message);
    if (data.type === 'wallet') {
      try {
        worker.postMessage({ type: 'walletResult', id: data.id, result: await wallet.walletClient[data.method]({ account: wallet.address, ...data.args }) });
      } catch (error) {
        worker.postMessage({ type: 'walletResult', id: data.id, error: error.shortMessage || error.message });
      }
      return;
    }
    const pending = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve(data.result);
  };
  worker.onerror = (event) => { for (const pending of waiting.values()) pending.reject(new Error(event.message || 'The account worker stopped.')); waiting.clear(); };
  const call = (method, ...args) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage({ id, method, args }); });
  // Every client method becomes a message ("then" is excluded so the proxy is not a thenable).
  const client = new Proxy({}, { get: (_, method) => (method === 'then' ? undefined : (...args) => call(method, ...args)) });
  return { worker, client };
}

async function refresh() {
  if (!session) return emit(offline());
  const [snap, m] = await Promise.all([session.client.snapshot(session.workspace ?? null), readMarket()]);
  // A lagging public RPC node can briefly miss a treasury's events: keep the last good view for a
  // few refreshes before concluding the treasury is gone (e.g. rotated out). Right after a switch or
  // a setup there is no treasury view to keep, so wait and retry (about 90 s) instead of falling back.
  if (session.workspace && !snap.ledger && ++session.misses < (session.last ? 4 : 30)) {
    if (session.last) return emit(session.last);
    await new Promise((r) => setTimeout(r, 3000));
    return refresh();
  }
  session.misses = 0;
  market = m;
  session.snap = snap;
  const { ledgers, ledger: L } = snap;
  if (!L) session.workspace = null;
  // The account shown: the active treasury ledger or your personal notes.
  const notes = snap.notes;
  const balance = (asset, st = 'unspent') => balanceOf(notes, BigInt(asset), st);
  const shares = L ? balance(deployment.vault) : balance(deployment.lending);
  const vault = L ? await vaultValue(shares) : await m.shareValue(shares);
  const freeStock = SYMBOLS.reduce((t, s) => t + valueOf(balance(stocks[s].token), m.marks[plain(s)]), 0n);
  const positions = snap.positions.map((p) => ({
    id: `slot-${p.slot}`, asset: plain(p.symbol), created: '',
    collateral: usd(valueOf(p.collateral, m.marks[plain(p.symbol)])), debt: usd(debtOf(p.debtScaled, m.index)),
    // Health vs the liquidation threshold at the pinned mark (1 = at the threshold); private, computed here.
    health: p.debtScaled ? Number(healthBps(p, m.marks[plain(p.symbol)], stocks[p.symbol].liqBps, m.index)) / 1e4 : null,
    // Health is linear in the price, so the position reaches the threshold at mark / health.
    mark: Number(m.marks[plain(p.symbol)]) / 1e8,
    liquidatedSold: p.liquidated.length ? tokens(p.liquidated.reduce((t, l) => t + l.sold, 0n)) : 0,
    raw: p,
  }));
  const label = (n) => {
    const sym = n.asset === BigInt(deployment.usdg) ? USD_SYMBOL : n.asset === BigInt(deployment.lending) ? 'lending shares' : n.asset === BigInt(deployment.vault) ? 'vault shares' : SYMBOLS.find((s) => BigInt(stocks[s].token) === n.asset);
    return { sym, kind: [USD_SYMBOL, 'lending shares', 'vault shares'].includes(sym) || L ? 'Treasury' : 'Credit' };
  };
  // Notes of retired contracts (e.g. M2 lending shares) are not assets of this deployment.
  const known = new Set([deployment.usdg, deployment.lending, deployment.vault, ...SYMBOLS.map((s) => stocks[s].token)].map((a) => BigInt(a)));
  // Payments received under mandates carry a receipt the recipient can prove (personal account).
  const received = new Map(snap.receipts.map((r) => [r.note.commitment, r]));
  const activity = await Promise.all(notes.filter((n) => n.amount > 0n && known.has(n.asset) && n.status !== 'refunded').map(async (n) => {
    const { sym, kind } = label(n);
    const isStock = SYMBOLS.includes(sym);
    const amount = sym === USD_SYMBOL ? usd(n.amount) : sym === 'lending shares' ? usd(await m.shareValue(n.amount)) : sym === 'vault shares' ? usd(await vaultValue(n.amount)) : usd(valueOf(n.amount, m.marks[plain(sym)]));
    const receipt = received.get(n.commitment);
    if (receipt) {
      return {
        id: n.commitment.toString(16), kind: 'Payments', amount, recipient: 'You (undisclosed unless you choose)', period: `Period ${receipt.k}`,
        receipt: `Receipt #${receipt.leafIndex} · treasury ${hexId(receipt.ledgerId).slice(0, 10)}…`,
        title: `Payment received under a mandate · ${isStock ? `${tokens(n.amount)} ${sym}` : sym}`,
        at: new Date(await timeOf(n.block)).toISOString(),
        detail: 'A private payment with a zero-knowledge receipt you can prove to one verifier.',
      };
    }
    return {
      id: n.commitment.toString(16), kind, amount,
      title: `${n.status === 'pending' ? 'Deposit in screening standby' : n.status === 'spent' ? 'Private note · spent' : 'Private note · available'} · ${isStock ? `${tokens(n.amount)} ${sym}` : sym}`,
      at: new Date(await timeOf(n.block)).toISOString(),
      detail: n.status === 'pending' ? `Clears after the ${deployment.standbySeconds}-second screening standby.` : L ? 'A confidential treasury note. Only this treasury\'s members can open it.' : 'A confidential note in the ZKDesk pool. Only your keys can open it.',
    };
  }));
  activity.sort((a, b) => b.at.localeCompare(a.at));
  const stockBalances = Object.fromEntries(SYMBOLS.map((s) => [plain(s), tokens(balance(stocks[s].token))]));
  const roles = L ? L.roles : ['Owner'];
  const requests = snap.requests;
  requestsById = new Map(requests.map((r) => [r.id, r]));
  const t = Math.floor(Date.now() / 1000);
  // The treasury's transfer-count limit (payments below the threshold without the Owner) and its use.
  const limit = L ? await publicClient.readContract({ address: deployment.ledger, abi: abis.ledger, functionName: 'limits', args: [L.owner] }).catch(() => null) : null;
  const mandates = snap.mandates.map((m) => {
    const oneTime = m.period === 0n;
    const paidNow = m.paid.has(currentPeriod(m, t));
    const sym = m.asset === BigInt(deployment.usdg) ? 'USDG' : `${T}${plain(SYMBOLS.find((x) => BigInt(stocks[x].token) === m.asset) ?? '')}`;
    const view = {
      id: hexId(m.commit), kind: KINDS[Number(m.kind)], recipient: m.label || zkAddress({ owner: m.recipient, encPub: m.recipientEncPub }).slice(0, 18) + '…',
      cap: usd(m.cap), period: oneTime ? 'One-time' : Object.keys(PERIODS).find((k) => PERIODS[k] === m.period) ?? 'Periodic', expiry: new Date(Number(m.expiry) * 1000).toISOString().slice(0, 10),
      status: m.status === 'Active' && oneTime && m.paid.size ? 'Complete' : m.status, asset: sym,
      paidLabel: m.paid.size ? `Paid periods: ${[...m.paid].sort().join(', ')}${sym === 'USDG' ? '' : ` · in ${sym} at the pinned mark`}` : `No payments yet${sym === 'USDG' ? '' : ` · pays ${sym} at the pinned mark`}`,
      raw: m,
    };
    // The approved view decides "payable" by comparing paidPeriod with the current period key.
    return { ...view, paidPeriod: paidNow ? periodKey(view) : null };
  });
  return (session.last = emit({
    ...base(),
    role: roles[0],
    cash: usd(balance(deployment.usdg)), vault: usd(vault), freeStock: usd(freeStock), positions, activity, mandates,
    meta: {
      mode: 'testnet', connected: true, address: session.wallet.address, keySource: session.passkey ? 'passkey' : 'wallet', zkAddress: zkAddress(L ?? session.pub), personalZkAddress: zkAddress(session.pub),
      roles, workspace: L ? hexId(L.owner) : 'personal', workspaceName: L ? L.name : null,
      workspaces: ledgers.map((l) => ({ id: hexId(l.owner), name: l.name, roles: l.roles })),
      requests: requests.filter((r) => r.status !== 'Expired').map((r) => ({
        id: r.id, amount: usd(r.amount), status: r.status, mine: r.mine, role: r.role, at: new Date(r.at).toISOString(),
        to: r.to ? zkAddress(r.to).slice(0, 18) + '…' : `${r.recipient.slice(0, 8)}…${r.recipient.slice(-4)}`,
      })),
      notice: (() => { const n = notice; notice = null; return n; })(),
      scheduler: deployment.scheduler,
      ledger: L && {
        scheduled: parseZkAddress(deployment.scheduler ?? '')?.owner === L.config.payer, name: L.name,
        // Who holds the Payer role: the Owner's own key (no agent), the ZKdesk scheduler, or another key (an agent or person).
        payer: L.config.payer === L.config.owner ? 'owner' : parseZkAddress(deployment.scheduler ?? '')?.owner === L.config.payer ? 'scheduler' : `0x${L.config.payer.toString(16).padStart(64, '0').slice(0, 8)}…`,
        limit: limit && limit[0] ? { max: Number(limit[0]), days: Number(limit[1]) / 86_400, used: t < Number(limit[2]) + Number(limit[1]) ? Number(limit[3]) : 0 } : null, allocCap: usd(L.config.allocCap), dualThreshold: usd(L.config.dualThreshold), attested: L.attested && { epoch: L.attested.epoch, liabilities: usd(L.attested.liabilities) } },
      pending: usd(balance(deployment.usdg, 'pending')), stockBalances, shares: shares.toString(),
      // Personal USDG notes worth merging (each pays more than one merge fee): client.combine.
      combinable: L ? 0 : notes.filter((n) => n.status === 'unspent' && n.asset === BigInt(deployment.usdg) && n.amount > m.fee).length,
      marks: Object.fromEntries(Object.entries(m.marks).map(([k, v]) => [k, Number(v) / 1e8])),
      liquidity: usd(m.liquidity), fee: usd(m.fee), shareFee: m.shareFee.toString(), syncedAt: Date.now(), desk: m.desk,
    },
  }));
}

/** Opens the account from {signature} or {passkey} (a seed); wallet funds deposits ({} until linked). */
async function open(source, wallet = {}, credential = null) {
  session?.worker.terminate();
  session = null;
  const funding = { address: wallet.address ?? null, walletClient: wallet.walletClient ?? null };
  const { worker, client } = startAccount(funding);
  const pub = await client.init(source, funding.address); // keys are derived inside the worker
  session = { wallet: funding, passkey: Boolean(source.passkey), credential, pub, worker, client, workspace: null, snap: null, last: null, misses: 0 };
  return refresh();
}

async function connect() {
  const { address, walletClient } = await connectWallet();
  const signature = await walletClient.signTypedData({ account: address, ...keyRequest(publicClient.chain.id) });
  return open({ signature }, { address, walletClient });
}

/** A passkey account adds funds from MetaMask: linked at each deposit, so it is always the current account. */
async function linkWallet() {
  statusHandler('Connect MetaMask to fund this deposit…');
  const { address, walletClient } = await connectWallet();
  Object.assign(session.wallet, { address, walletClient });
  await session.client.setAddress(address);
}

const live = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (error) {
    const message = error?.name === 'NotAllowedError' ? 'The passkey request was cancelled or timed out.' : friendly(error.shortMessage || error.message);
    if (!session) emit(offline(message));
    throw new Error(message);
  }
};

const positionOf = (state, id) => state.positions.find((p) => p.id === id)?.raw;

function validate(state, type, values) {
  if (!state.meta?.connected) return { general: 'Connect your wallet first.' };
  const errors = {};
  const m = state.meta;
  const amount = Number(values.amount);
  const needAmount = !['close', 'open', 'ledger', 'roles', 'mandate', 'pause', 'resume', 'revoke', 'approve', 'complete', 'combine', 'agent', 'unagent'].includes(type);
  if (needAmount && !(Number.isFinite(amount) && amount > 0 && amount <= 1e9)) errors.amount = 'Enter an amount greater than zero.';
  const position = state.positions.find((p) => p.id === values.id);
  const ledger = m.ledger;
  const fee = ledger ? 0 : m.fee; // treasury steps take their relay fee from the member's personal balance
  const zkOrBlank = (key) => { if (values[key]?.trim() && !parseZkAddress(values[key])) errors[key] = 'Enter a ZKdesk address (zkd:…) or leave blank for yourself.'; };
  if (ledger && ['allocate', 'deallocate', 'deposit'].includes(type) && !['Owner', 'Treasurer'].includes(state.role)) return { general: `${state.role} cannot ${type === 'deposit' ? 'add funds' : type} in this treasury.` };
  if (ledger && ['send', 'withdraw'].includes(type) && !['Owner', 'Treasurer', 'Payer'].includes(state.role)) return { general: 'The Auditor role can view the treasury but cannot move funds.' };
  if (type === 'deposit' && !m.address && !hasWallet()) return { general: 'Funds are added from a wallet: install MetaMask to deposit. You can already receive private payments at your ZKdesk address.' };
  switch (type) {
    case 'deposit': {
      const cap = values.asset === 'USDG' ? FAUCET_CAP.USDG : FAUCET_CAP.STOCK;
      if (!MAINNET && amount > cap) errors.amount = `Deposits are limited to ${cap.toLocaleString('en-US')} test ${values.asset === 'USDG' ? 'USDG' : 'tokens'} at a time.`;
      break;
    }
    case 'send': case 'withdraw':
      if (amount + fee > state.cash + 1e-9) errors.amount = fee ? `Not enough available private balance (a ${fee} ${USD_SYMBOL} relay fee applies).` : 'Not enough available treasury balance.';

      if (type === 'send' && !parseZkAddress(values.recipient)) errors.recipient = 'Enter a ZKdesk address (zkd:…).';
      if (type === 'withdraw' && !isAddress(values.recipient || '')) errors.recipient = 'Enter a wallet address (0x…).';
      break;
    case 'allocate':
      if (amount + fee > state.cash + 1e-9) errors.amount = fee ? `Not enough available private balance (a ${fee} ${USD_SYMBOL} relay fee applies).` : 'Not enough available treasury balance.';
      else if (ledger && amount > ledger.allocCap) errors.amount = `The treasury policy caps one allocation at ${ledger.allocCap} ${USD_SYMBOL}.`;
      break;
    case 'deallocate':
      if (amount > state.vault) errors.amount = `You have ${state.vault.toFixed(2)} ${USD_SYMBOL} supplied.`;
      else if (!ledger && amount > m.liquidity) errors.amount = 'The lending pool does not have that much available cash right now.';
      break;
    case 'agent': {
      if (!ledger || state.role !== 'Owner') { errors.general = 'Only the treasury Owner can add or remove an agent.'; break; }
      const agent = parseZkAddress(values.recipient);
      if (!agent) errors.recipient = "Enter the agent's ZKdesk address (zkd:…).";
      else if (agent.owner === session.pub.owner) errors.recipient = "That is your own address. Enter the agent's address.";
      if (!(Number(values.threshold) > 0)) errors.threshold = 'Enter the amount above which you approve each payment.';
      if (values.limit !== '' && !(Number.isInteger(Number(values.limit)) && Number(values.limit) >= 0 && Number(values.limit) <= 1000)) errors.limit = 'Enter a whole number of payments (0 for no limit).';
      break;
    }
    case 'unagent':
      if (!ledger || state.role !== 'Owner') errors.general = 'Only the treasury Owner can remove the agent.';
      break;
    case 'ledger': case 'roles':
      if (type === 'ledger' && !values.name?.trim()) errors.name = 'Name this treasury.';
      if (type === 'roles' && state.role !== 'Owner') errors.general = 'Only the Owner can change roles or policy.';
      for (const k of ['treasurer', 'payer', 'auditor']) zkOrBlank(k);
      if (!(Number(values.cap) > 0)) errors.cap = 'Enter the largest single allocation.';
      if (!(Number(values.threshold) > 0)) errors.threshold = 'Enter the dual-control threshold.';
      break;
    case 'combine':
      if (ledger || !(state.meta?.combinable > 1)) errors.general = 'There is nothing to combine: your private USDG is already in one note.';
      break;
    case 'attest':
      if (!ledger) errors.general = 'Treasury statements are made from a treasury workspace.';
      break;
    case 'approve': case 'complete': {
      const r = requestsById.get(values.id);
      if (!r) errors.general = 'This request is no longer available.';
      else if (type === 'approve' && (state.role !== 'Owner' || r.status !== 'Awaiting Owner')) errors.general = 'Only the Owner can approve a request that is awaiting approval.';
      else if (type === 'complete' && (!r.mine || r.status !== 'Approved')) errors.general = 'Only the member who asked can complete an approved request.';
      break;
    }
    case 'mandate': {
      if (!ledger) { errors.general = 'Mandates pay from a treasury. Switch to a treasury workspace in Settings.'; break; }
      if (!parseZkAddress(values.recipient)) errors.recipient = 'Enter the recipient\'s ZKDesk address (zkd:…).';
      const cap = Number(values.cap);
      if (!(cap > 0 && cap <= 1e9)) errors.cap = 'Enter a cap greater than zero.';
      else if (cap > ledger.dualThreshold && state.role !== 'Owner') errors.cap = `A cap above ${ledger.dualThreshold} ${USD_SYMBOL} needs the Owner (dual control).`;
      if (!values.expiry || values.expiry <= new Date().toISOString().slice(0, 10)) errors.expiry = 'Choose a future expiry date.';
      if (values.kind === 'Invoice' && !values.reference?.trim()) errors.reference = 'Enter the invoice reference.';
      if (!['Owner', 'Treasurer', 'Payer'].includes(state.role)) errors.general = 'The Auditor role cannot create mandates.';
      break;
    }
    case 'pay': case 'pause': case 'resume': case 'revoke': {
      const mandate = state.mandates.find((x) => x.id === values.id);
      if (!mandate) { errors.general = 'This mandate is no longer available.'; break; }
      if (!['Owner', 'Treasurer', 'Payer'].includes(state.role)) errors.general = 'The Auditor role can view mandates but not use them.';
      if (type === 'pay') {
        if (amount > mandate.cap + 1e-9) errors.amount = 'This payment exceeds the mandate cap.';
        else if (mandate.asset === 'USDG' && amount > state.cash + 1e-9) errors.amount = `Not enough liquid treasury ${USD_SYMBOL}.`;
      } else if (['pause', 'resume', 'revoke'].includes(type)) delete errors.amount;
      break;
    }
    case 'open': {
      const coll = Number(values.collateral);
      const held = m.stockBalances[values.asset] ?? 0;
      if (!(coll > 0)) errors.collateral = 'Enter the number of tokens to pledge.';
      else if (coll > held) errors.collateral = `You hold ${held} private t${values.asset}. Add funds in t${values.asset} first.`;
      const max = coll * (m.marks[values.asset] ?? 0) * (stocks[`${T}${values.asset}`].ltvBps / 10_000);
      if (!(amount > 0)) errors.amount = 'Enter an amount to borrow.';
      else if (amount > max) errors.amount = `At the current price you can borrow up to ${max.toFixed(2)} ${USD_SYMBOL}.`;
      else if (amount > m.liquidity) errors.amount = 'The lending pool does not have that much available cash right now.';
      break;
    }
    case 'repay':
      if (position && amount > position.debt + 1e-6) errors.amount = 'That is more than the position owes.';
      if (amount > state.cash + 1e-9) errors.amount = `Not enough available private ${USD_SYMBOL}.`;
      break;
    case 'add': {
      const held = m.stockBalances[position?.asset] ?? 0;
      if (amount > held) errors.amount = `You hold ${held} private t${position?.asset}.`;
      break;
    }
    case 'close':
      if (position && position.debt > state.cash + 1e-9) errors.general = `Closing repays ${position.debt.toFixed(2)} ${USD_SYMBOL}; your available balance is ${state.cash.toFixed(2)}.`;
      break;
    default:
      errors.general = 'This action is not available yet.';
  }
  return errors;
}

async function submit(state, type, values) {
  const { client } = session;
  if (type === 'deposit' && session.passkey) await linkWallet();
  const L = activeLedger();
  const member = (v) => (v?.trim() ? parseZkAddress(v) : undefined);
  if (type === 'ledger') {
    session.last = null;
    session.workspace = await client.createLedger({ name: values.name.trim(), treasurer: member(values.treasurer), payer: member(values.payer), auditor: member(values.auditor), allocCap: parseUnits(String(values.cap), 6), dualThreshold: parseUnits(String(values.threshold), 6) });
    return;
  }
  if (L) {
    const usdg6 = (x) => parseUnits(String(x), 6);
    switch (type) {
      case 'agent': {
        // The agent becomes the Payer; then the approval threshold, then the payments-without-approval limit.
        await client.updateLedger(L, { payer: parseZkAddress(values.recipient), dualThreshold: usdg6(values.threshold) });
        const max = values.limit === '' ? null : Number(values.limit);
        const days = values.per === 'week' ? 7 : 1;
        const now = state.meta.ledger.limit;
        if (max !== null && !(max === (now?.max ?? 0) && (!max || days === now?.days))) {
          await client.sync(); // the worker then resolves the treasury with its new config
          await client.setTransferLimit(L, max, max ? days * 86_400 : 0);
        }
        return;
      }
      case 'unagent': return client.updateLedger(L, { payer: { owner: session.pub.owner, encPub: session.pub.encPub } });
      case 'roles': return client.updateLedger(L, { treasurer: member(values.treasurer), payer: member(values.payer), auditor: member(values.auditor), allocCap: usdg6(values.cap), dualThreshold: usdg6(values.threshold) });
      case 'deposit': return client.deposit(tokenOf(values.asset), values.asset === 'USDG' ? usdg6(values.amount) : parseUnits(String(values.amount), 18), { owner: L.owner, encPub: L.encPub });
      case 'allocate': return client.ledgerAct(L, state.role, { action: 'allocate', amount: usdg6(values.amount) });
      case 'deallocate': {
        const all = balanceOf(session.snap.notes, BigInt(deployment.vault));
        const shares = Number(values.amount) >= state.vault - 1e-6 ? all : (all * usdg6(values.amount)) / usdg6(state.vault);
        return client.ledgerAct(L, state.role, { action: 'deallocate', amount: shares });
      }
      case 'send': case 'withdraw': {
        const r = await client.ledgerAct(L, state.role, type === 'send' ? { action: 'transfer', amount: usdg6(values.amount), to: parseZkAddress(values.recipient) } : { action: 'transfer', amount: usdg6(values.amount), recipient: values.recipient });
        if (r?.requested) notice = 'Above the dual-control threshold: sent to the treasury Owner for approval.';
        return r;
      }
      case 'approve': return client.approveRequest(L, requestsById.get(values.id));
      case 'complete': return client.completeRequest(L, requestsById.get(values.id));
      case 'attest': return client.ledgerAttest(L, usdg6(values.amount));
      case 'mandate': return client.createMandate(L, state.role, {
        kind: values.kind, to: parseZkAddress(values.recipient), label: values.name?.trim() ?? '', asset: tokenOf(values.asset), cap: usdg6(values.cap),
        period: values.kind === 'Invoice' ? 'One-time' : values.period, expiry: Math.floor(Date.parse(`${values.expiry}T23:59:59Z`) / 1000), reference: values.reference?.trim() ?? '',
      });
      case 'pay': return client.payMandate(L, state.role, state.mandates.find((x) => x.id === values.id).raw, usdg6(values.amount));
      case 'pause': case 'resume': case 'revoke': return client.manageMandate(L, state.role, state.mandates.find((x) => x.id === values.id).raw, type);
      default: throw new Error('That is not a treasury action.');
    }
  }
  const p = positionOf(state, values.id);
  const usdg = (x) => parseUnits(String(x), 6);
  const toks = (x) => parseUnits(String(x), 18);
  switch (type) {
    case 'deposit': await client.deposit(tokenOf(values.asset), values.asset === 'USDG' ? usdg(values.amount) : toks(values.amount)); break;
    case 'send': await client.send({ amount: usdg(values.amount), to: parseZkAddress(values.recipient) }); break;
    case 'combine': await client.combine(deployment.usdg); break;
    case 'withdraw': await client.send({ amount: usdg(values.amount), recipient: values.recipient }); break;
    case 'allocate': await client.lend(usdg(values.amount)); break;
    case 'deallocate': {
      const all = BigInt(state.meta.shares);
      const shares = Number(values.amount) >= state.vault - 1e-6 ? all - BigInt(state.meta.shareFee) : (all * usdg(values.amount)) / usdg(state.vault);
      await client.redeem(shares);
      break;
    }
    case 'open': await client.credit({ symbol: `${T}${values.asset}`, collIn: toks(values.collateral), draw: usdg(values.amount) }); break;
    case 'repay': await client.credit({ symbol: p.symbol, position: p, repay: usdg(values.amount) }); break;
    case 'add': await client.credit({ symbol: p.symbol, position: p, collIn: toks(values.amount) }); break;
    case 'close': await client.credit({ symbol: p.symbol, position: p, repay: debtOf(p.debtScaled, market.index), collOut: p.collateral }); break;
    default: throw new Error('Unsupported action.');
  }
}

export default {
  mode: 'testnet',
  net: { mainnet: MAINNET, network, mainnetReady, testnetReady, usd: USD_SYMBOL, name: NETWORK_NAME, t: T, label: MAINNET ? 'Mainnet' : 'Testnet' },
  load: () => offline(),
  connect: () => connect().catch((error) => { const message = friendly(error.shortMessage || error.message); emit(offline(message)); throw new Error(message); }),
  /** Passkey accounts: a seed (32 bytes, hex) stays on this page only until the worker opens it. */
  passkey: {
    supported: passkeySupported,
    /** A new passkey; returns its seed so the recovery key is shown before the account opens. */
    create: live(createPasskey),
    unlock: live(async () => { const { seed, id } = await unlockPasskey(); return open({ passkey: seed }, {}, id); }),
    /** Opens the account the seed belongs to (after create, or from the recovery words). */
    open: live(({ seed, id = null }) => open({ passkey: seed }, {}, id)),
    words: seedWords,
    fromWords: wordsSeed,
    /** The recovery words of the open passkey account (asks the passkey again; never kept). */
    recovery: live(async () => {
      if (!session?.passkey) throw new Error('Unlock with your passkey first.');
      const { seed } = await unlockPasskey(session.credential);
      if (!(await session.client.isMine(seed))) throw new Error('That passkey belongs to a different ZKdesk account.');
      return seedWords(seed);
    }),
  },
  subscribe(callback) {
    listener = callback;
    // A passkey account does not depend on the wallet: the next deposit links the current one.
    const off = onWalletChange(() => { if (session?.passkey) return; session?.worker.terminate(); session = null; emit(offline('Wallet changed. Connect again to unlock your notes.')); });
    const timer = setInterval(() => { if (session) refresh().catch(() => {}); }, 20_000);
    return () => { listener = null; off(); clearInterval(timer); };
  },
  validate,
  /** Public protocol aggregates (no wallet): api/transparency.js. */
  async transparency() {
    const r = await fetch(`${apiBase}/transparency`);
    if (!r.ok) throw new Error('Public data is unavailable right now.');
    return r.json();
  },
  /** Receipt proof for a received payment (activity id); returns the exportable record. */
  async proveReceipt(id, { verifier = '0', includeAmount = false, includeRecipient = false } = {}, onStatus = () => {}) {
    if (!session) throw new Error('Connect your wallet first.');
    const receipt = session.snap?.receipts.find((r) => r.note.commitment.toString(16) === id);
    if (!receipt) throw new Error('This payment has no receipt.');
    statusHandler = onStatus;
    try {
      return await session.client.proveReceipt(receipt, { verifier: verifier || '0', discloseAmount: includeAmount, discloseOwner: includeRecipient });
    } finally {
      statusHandler = () => {};
    }
  },
  /** 'personal' or a ledger id from meta.workspaces. */
  setWorkspace(id) {
    if (!session) return;
    session.workspace = id === 'personal' ? null : BigInt(id);
    session.last = null; // a deliberate switch never falls back to the previous view
    session.misses = 0;
    return refresh();
  },
  async submit(state, type, values, onStatus = () => {}) {
    if (!session) throw new Error('Connect your wallet first.');
    statusHandler = onStatus;
    try {
      await submit(state, type, values);
    } catch (error) {
      throw new Error(friendly(error.shortMessage || error.message));
    } finally {
      statusHandler = () => {};
    }
    onStatus('Updating your balance…');
    return refresh();
  },
};
