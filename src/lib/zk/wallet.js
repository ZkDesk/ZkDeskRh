// Rebuilds pool state from chain events (source of truth) and finds the notes a key set owns.
// Supabase mirrors these events for speed; clients rebuild the tree from events, check its size against the pool, and the contract rejects any unknown root.
import { LeanIMT } from '@zk-kit/lean-imt';
import { parseAbi, parseAbiItem } from 'viem';
import { hash2, mandateCommit, noteCommitment, nullifier, policyHash, positionCommitment, receiptLeaf } from './notes.js';
import { decryptConfig, decryptKeyShare, decryptMandate, decryptNote, decryptPosition } from './crypto.js';
import { heldRoles, ledgerKeys, rolesOf } from './ledger.js';
import { applyLiquidation, LIQUIDATION_CIPHERTEXT_BYTES } from './desk.js';

const EVENTS = {
  commitment: parseAbiItem('event NewCommitment(uint256 indexed commitment, uint256 index)'),
  note: parseAbiItem('event EncryptedNote(uint256 indexed commitment, bytes ciphertext)'),
  nullifier: parseAbiItem('event NewNullifier(uint256 indexed nullifier)'),
};
const POSITION_EVENT = parseAbiItem('event PositionUpdated(uint8 indexed slot, uint256 leaf, bytes ciphertext)');
const LEDGER_EVENTS = parseAbi([
  'event LedgerCreated(uint256 indexed id, uint256 rolesCommit, uint256 policyHash)',
  'event RolesRotated(uint256 indexed id, uint256 rolesCommit)',
  'event PolicySet(uint256 indexed id, uint256 policyHash)',
  'event KeyShare(uint256 indexed id, bytes share)',
  'event LedgerConfig(uint256 indexed id, bytes config)',
  'event IntentApproved(uint256 indexed id, uint256 intent)',
  'event TreasuryAttested(uint256 indexed id, uint64 epoch, uint256 liabilities)',
]);
const MANDATE_EVENTS = parseAbi([
  'event MandateCommitted(uint256 indexed ledgerId, uint256 indexed commit, bytes ciphertext)',
  'event MandateStatus(uint256 indexed ledgerId, uint256 indexed commit, uint8 status)',
  'event Pulled(uint256 indexed ledgerId, uint256 indexed commit, uint256 k, uint256 receiptLeaf, uint256 receiptIndex, uint256 receiptRoot)',
]);
const MIN_SPLIT = 1_000n;

// Asks for the whole range at once (mainnet has ~350k blocks a day, so fixed 10k chunks meant hundreds
// of calls and public-RPC throttling); halves the range only when the node refuses it.
async function logs(client, address, event, fromBlock, toBlock) {
  try {
    return await client.getLogs({ address, ...(Array.isArray(event) ? { events: event } : { event }), fromBlock, toBlock });
  } catch (error) {
    if (toBlock - fromBlock < MIN_SPLIT) throw error;
    const mid = (fromBlock + toBlock) / 2n;
    return [...(await logs(client, address, event, fromBlock, mid)), ...(await logs(client, address, event, mid + 1n, toBlock))];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZE_ABI = [{ type: 'function', name: 'size', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];

/**
 * Public pool state: ordered leaves, ciphertext by commitment, spent nullifiers.
 * minBlock: block of a tx we just sent. Public RPC nodes are load-balanced and can lag, so the
 * result is only accepted once the leaf count matches the pool's own size at that block.
 */
export async function syncPool(client, deployment, { minBlock = 0n } = {}) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await syncOnce(client, deployment, minBlock);
    if (state) return state;
    await sleep(750);
  }
  throw new Error('The network RPC is behind. Please try again in a moment.');
}

async function syncOnce(client, deployment, minBlock) {
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  if (toBlock < BigInt(minBlock)) return null;
  const fromBlock = BigInt(deployment.deployBlock);
  const [c, n, x, p, g, mm] = await Promise.all([
    ...Object.values(EVENTS).map((e) => logs(client, deployment.pool, e, fromBlock, toBlock)),
    deployment.desk ? logs(client, deployment.desk, POSITION_EVENT, BigInt(deployment.deskBlock ?? deployment.deployBlock), toBlock) : [],
    deployment.ledger ? logs(client, deployment.ledger, LEDGER_EVENTS, BigInt(deployment.ledgerBlock), toBlock) : [],
    deployment.mandates ? logs(client, deployment.mandates, MANDATE_EVENTS, BigInt(deployment.mandatesBlock), toBlock) : [],
  ]);
  const mandateEvents = mm.map((l) => ({ name: l.eventName, ...l.args, block: l.blockNumber, tx: l.transactionHash }));
  const pulls = mandateEvents.filter((e) => e.name === 'Pulled').sort((a, b) => Number(a.receiptIndex - b.receiptIndex));
  if (pulls.some((e, i) => Number(e.receiptIndex) !== i)) return null;
  // Latest leaf per desk slot, plus each slot's history (a liquidation is only readable from the
  // position before it). Logs arrive in chain order.
  const slots = new Map();
  const slotHistory = new Map();
  for (const l of p) {
    const s = { slot: Number(l.args.slot), leaf: l.args.leaf, ciphertext: l.args.ciphertext, block: l.blockNumber, tx: l.transactionHash };
    slots.set(s.slot, s);
    slotHistory.set(s.slot, [...(slotHistory.get(s.slot) ?? []), s]);
  }
  const leaves = c.map((l) => ({ commitment: l.args.commitment, index: Number(l.args.index) })).sort((a, b) => a.index - b.index);
  if (leaves.some((l, i) => l.index !== i)) return null;
  const size = await client.readContract({ address: deployment.pool, abi: SIZE_ABI, functionName: 'size', blockNumber: toBlock }).catch(() => -1n);
  if (Number(size) !== leaves.length) return null;
  const tree = new LeanIMT((a, b) => hash2(a, b), leaves.map((l) => l.commitment));
  return {
    tree,
    indexOf: new Map(leaves.map((l) => [l.commitment, l.index])),
    ciphertexts: n.map((l) => ({ commitment: l.args.commitment, ciphertext: l.args.ciphertext, block: l.blockNumber })),
    spent: new Set(x.map((l) => l.args.nullifier)),
    slots,
    slotHistory,
    ledgerEvents: g.map((l) => ({ name: l.eventName, ...l.args, block: l.blockNumber, tx: l.transactionHash })),
    mandateEvents,
    pulls,
    receipts: new LeanIMT((a, b) => hash2(a, b), pulls.map((e) => e.receiptLeaf)),
    toBlock,
  };
}

/** Notes this key set can open. status: 'pending' (in standby), 'unspent' or 'spent'. */
export function myNotes(state, keys) {
  const notes = [];
  for (const { commitment, ciphertext, block } of state.ciphertexts) {
    const opened = decryptNote(ciphertext, keys.encSecret);
    if (!opened || opened.amount === 0n) continue;
    // A sender could encrypt garbage; only accept notes whose commitment really is ours.
    if (noteCommitment({ ...opened, owner: keys.owner }) !== commitment) continue;
    const leafIndex = state.indexOf.get(commitment);
    const spent = state.spent.has(nullifier(commitment, keys.nk));
    notes.push({ ...opened, commitment, leafIndex, block, status: spent ? 'spent' : leafIndex === undefined ? 'pending' : 'unspent' });
  }
  return notes;
}

/**
 * Open credit positions this key set owns. Each slot's history is replayed: our own updates open with
 * our key; a liquidation's masked amounts open with the previous position's blinding.
 * `liquidated` lists the sealed batches that touched the position (collateral sold, debt repaid).
 */
export function myPositions(state, keys) {
  const out = [];
  for (const history of state.slotHistory.values()) {
    let mine = null;
    let liquidated = [];
    for (const s of history) {
      if (mine && (s.ciphertext.length - 2) / 2 === LIQUIDATION_CIPHERTEXT_BYTES) {
        const { sold, repaidScaled, ...next } = applyLiquidation(mine, s.ciphertext);
        mine = next;
        liquidated = [...liquidated, { sold, repaidScaled, block: s.block, tx: s.tx }];
      } else {
        const opened = decryptPosition(s.ciphertext, keys.encSecret);
        mine = opened && positionCommitment({ ...opened, owner: keys.owner }) === s.leaf ? opened : null;
        if (!mine) liquidated = [];
      }
      if (mine && positionCommitment({ ...mine, owner: keys.owner }) !== s.leaf) mine = null;
    }
    const last = history[history.length - 1];
    if (mine && last.leaf !== 0n) out.push({ ...mine, slot: last.slot, leaf: last.leaf, block: last.block, liquidated });
  }
  return out;
}

/** First slot with no position (null if the desk is full). */
export const freeSlot = (state) => { for (let i = 0; i < 64; i++) if (!state.slots.get(i)?.leaf) return i; return null; };

export const balanceOf = (notes, asset, status = 'unspent') =>
  notes.filter((n) => n.asset === asset && n.status === status).reduce((s, n) => s + n.amount, 0n);

/**
 * Treasury ledgers this key set holds a key share for, with the current config (the one matching
 * the on-chain roles commitment and policy hash) and the roles this person holds in it.
 */
export function myLedgers(state, keys) {
  const out = [];
  const events = state.ledgerEvents;
  const seen = new Set();
  for (const e of events.filter((x) => x.name === 'KeyShare')) {
    const lsk = decryptKeyShare(e.share, keys.encSecret);
    if (lsk === null) continue;
    const ledger = ledgerKeys(lsk);
    if (ledger.owner !== e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    const mine = events.filter((x) => x.id === e.id);
    const roles = mine.filter((x) => x.name === 'LedgerCreated' || x.name === 'RolesRotated').at(-1)?.rolesCommit;
    const policy = mine.filter((x) => x.name === 'LedgerCreated' || x.name === 'PolicySet').at(-1)?.policyHash;
    const config = mine.filter((x) => x.name === 'LedgerConfig').map((x) => decryptConfig(x.config, ledger.encSecret))
      .filter((c) => c && rolesOf(c) === roles && policyHash(c) === policy).at(-1);
    if (!config) continue;
    const held = heldRoles(config, keys.owner);
    if (!held.length) continue; // rotated out: the old share still opens, but no role remains
    const attested = mine.filter((x) => x.name === 'TreasuryAttested').at(-1);
    out.push({ ...ledger, config, name: config.name, roles: held, approved: new Set(mine.filter((x) => x.name === 'IntentApproved').map((x) => x.intent)), attested: attested && { epoch: Number(attested.epoch), liabilities: attested.liabilities, block: attested.block } });
  }
  return out;
}

const STATUS = ['', 'Active', 'Paused', 'Revoked'];
/**
 * A ledger's payment mandates (decrypted with the ledger key), with status and the periods paid.
 * Only mandates whose commitment matches their ciphertext are listed.
 */
export function ledgerMandates(state, ledger) {
  const mine = state.mandateEvents.filter((e) => e.ledgerId === ledger.owner);
  return mine.filter((e) => e.name === 'MandateCommitted').map((e) => {
    const m = decryptMandate(e.ciphertext, ledger.encSecret);
    if (!m || mandateCommit(ledger.owner, m) !== e.commit) return null;
    const status = mine.filter((x) => x.name === 'MandateStatus' && x.commit === e.commit).at(-1)?.status ?? 1;
    const pulls = state.pulls.filter((x) => x.commit === e.commit);
    return { ...m, commit: e.commit, block: e.block, status: STATUS[status], paid: new Set(pulls.map((x) => x.k)), pulls };
  }).filter(Boolean);
}

/** Payments this key set received under mandates, each with what is needed for a receipt proof. */
export function myReceipts(state, notes) {
  const out = [];
  for (const pull of state.pulls) {
    const note = notes.find((n) => n.block === pull.block && receiptLeaf(pull.ledgerId, pull.k, n.commitment) === pull.receiptLeaf);
    if (note) out.push({ ...pull, note, leafIndex: Number(pull.receiptIndex) });
  }
  return out;
}
