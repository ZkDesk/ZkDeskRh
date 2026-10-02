// Vercel Cron, every 15 minutes (hourly off-hours): the desk operator. It is the testnet stand-in
// for the TEE health-prover and liquidation sequencer, and holds DESK_OPERATOR_SK. Each run:
//   1. replays CreditDesk events and opens every live slot with the operator key
//   2. proves the epoch (circuits/health_epoch) at the current pinned marks
//   3. for each class with breached slots, prices the sale at the venue (salePrice) and proves sealed
//      batches (circuits/liquidate) at that uniform price
//   4. attests and liquidates in one transaction (attestAndLiquidate, audit M-1); if a batch would
//      revert, attests alone and sends the batches one by one so the epoch still lands
//   5. evicts idle positions without debt (circuits/evict, audit H-1), a few per run
// Nothing is stored off-chain; the indexer mirrors Attested / Liquidated events.
// Fallback when Functions are too slow or down: node scripts/ops/desk.mjs
import { parseAbi, parseAbiItem } from 'viem';
import { abis, cachedProver, cronAuthorized, deployment, keeper, publicClient, secret, sendFromKeeper, revertName, json } from '../_lib/server.js';
import { deploymentReady } from '../_lib/server.js';
import { QUOTER } from '../_lib/fees.js';
import { createProver } from '../../src/lib/zk/prover.js';
import { buildEvict, buildHealth, planLiquidations, replaySlots, CLASSES } from '../../src/lib/zk/desk.js';
import healthCircuit from '../../src/lib/zk/artifacts/health_epoch.json' with { type: 'json' };
import liquidateCircuit from '../../src/lib/zk/artifacts/liquidate.json' with { type: 'json' };
import evictCircuit from '../../src/lib/zk/artifacts/evict.json' with { type: 'json' };

const EVENTS = {
  operator: parseAbiItem('event OperatorNote(uint8 indexed slot, address asset, uint256[2] eph, uint256[4] cipher)'),
  position: parseAbiItem('event PositionUpdated(uint8 indexed slot, uint256 leaf, bytes ciphertext)'),
};
const AMM = parseAbi(['function quote(address) view returns (uint256)']);
const VENUE = parseAbi(['function feeOf(address) view returns (uint24)']);
const RANGE = 50_000n;
const MIN_KEEPER_WEI = 5n * 10n ** 14n; // 0.0005 ETH ≈ 10 epochs
const MAX_EVICTIONS = 4; // per run: each is a proof and a transaction
const desk = { address: deployment.desk, abi: abis.desk };
const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });

async function deskEvents(toBlock) {
  const from = BigInt(deployment.deskBlock ?? deployment.deployBlock);
  const ranges = [];
  for (let f = from; f <= toBlock; f += RANGE) ranges.push([f, f + RANGE - 1n < toBlock ? f + RANGE - 1n : toBlock]);
  const logs = (await Promise.all(ranges.map(([fromBlock, to]) => publicClient.getLogs({ address: deployment.desk, events: Object.values(EVENTS), fromBlock, toBlock: to })))).flat();
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  return logs.map((l) => (l.eventName === 'OperatorNote'
    ? { type: 'operator', slot: Number(l.args.slot), asset: l.args.asset, eph: [...l.args.eph], cipher: [...l.args.cipher] }
    : { type: 'position', slot: Number(l.args.slot), leaf: l.args.leaf, ciphertext: l.args.ciphertext }));
}

async function classes() {
  const out = [];
  for (let k = 0; k < CLASSES; k++) {
    const asset = await read(deployment.desk, abis.desk, 'classList', [BigInt(k)]).catch(() => null);
    if (!asset) break;
    const [[mark], cls] = await Promise.all([read(deployment.marker, abis.marker, 'current', [asset]), read(deployment.desk, abis.desk, 'classes', [asset])]);
    out.push({ asset: BigInt(asset), address: asset, mark: BigInt(mark), liqBps: Number(cls[1]) });
  }
  return out;
}

async function submit(functionName, args) {
  const sim = await publicClient.simulateContract({ account: keeper, ...desk, functionName, args });
  const { hash } = await sendFromKeeper(functionName, args, sim.request.gas, desk);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, block: receipt.blockNumber, gas: receipt.gasUsed };
}

/**
 * Uniform sale price in mark units (USDG base units x 1e20 per token wei). Testnet: the MockAMM quote.
 * Mainnet: the venue's Uniswap pool's average price for `amount`, the class's whole breached
 * collateral. A batch sells no more than that, so the venue's minimum output (price x sold) holds.
 */
export async function salePrice(asset, amount) {
  if (deployment.amm) return read(deployment.amm, AMM, 'quote', [asset]);
  const fee = await read(deployment.venue, VENUE, 'feeOf', [asset]);
  const { result: [out] } = await publicClient.simulateContract({
    ...QUOTER, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: asset, tokenOut: deployment.usdg, amountIn: amount, fee, sqrtPriceLimitX96: 0n }],
  });
  return (out * 10n ** 20n) / amount;
}

/** One desk run. prove(kind, witness) -> {proof}. Exported for scripts/ops/desk.mjs. */
export async function runDesk({ operatorSk, prove, log = () => {} }) {
  // The keeper falls back to the relayer key until KEEPER_PRIVATE_KEY is set; keep a margin either way.
  if ((await publicClient.getBalance({ address: keeper.address })) < MIN_KEEPER_WEI) throw Object.assign(new Error('keeper_low_balance'), { shortMessage: 'keeper_low_balance' });
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  const [events, cls, index, marketOpen] = await Promise.all([
    deskEvents(head), classes(), read(deployment.desk, abis.desk, 'index'), read(deployment.marker, abis.marker, 'marketOpen'),
  ]);
  const positions = replaySlots(events, operatorSk);
  const live = positions.filter(Boolean).length;
  const h = buildHealth({ positions, classes: cls, rateIndex: index });
  log(`epoch: ${live} live positions, ${h.breached.length} breached`);
  const t0 = Date.now();
  const { proof } = await prove('health_epoch', h.witness);
  const marks = [...cls.map((c) => c.mark), ...Array(CLASSES - cls.length).fill(0n)];
  const health = { proof, marks, rateIndex: index, sumValue: h.public.sumValue, sumDebt: h.public.sumDebt, breachCommit: h.public.breachCommit };
  const report = { live, breached: h.breached, sumValue: h.public.sumValue, sumDebt: h.public.sumDebt, proveMs: Date.now() - t0, batches: [], evicted: [] };

  // Sealed batches for the breached set this epoch commits to, proven before anything is sent.
  const batches = [];
  for (const c of cls) {
    const breached = positions.filter((p, slot) => p && p.asset === c.asset && (h.bitmap >> BigInt(slot)) & 1n);
    if (!breached.length) continue;
    let price;
    try {
      price = await salePrice(c.address, breached.reduce((t, p) => t + p.collateral, 0n));
    } catch (error) {
      // A pricing failure skips this class only; the epoch still lands.
      report.batches.push({ asset: c.address, error: revertName(error) });
      continue;
    }
    for (const b of planLiquidations({ positions, bitmap: h.bitmap, salt: h.salt, asset: c.asset, mark: c.mark, price, liqBps: c.liqBps, rateIndex: index, marketOpen })) {
      const p = b.public;
      log(`batch ${c.address}: slots ${p.slots.slice(0, b.rows.length)}`);
      const { proof: bp } = await prove('liquidate', b.witness);
      batches.push({
        asset: c.address, slots: p.slots.slice(0, b.rows.length),
        args: {
          proof: bp, collAsset: c.address, mark: p.mark, price: p.price, rateIndex: p.rateIndex, slots: p.slots,
          oldLeaves: p.oldLeaves, newLeaves: p.newLeaves, encSold: p.encSold, encRepaid: p.encRepaid,
          totalSold: p.totalSold, totalValue: p.totalValue, totalRepay: p.totalRepay, totalRepaidScaled: p.totalRepaidScaled, totalWrittenOff: p.totalWrittenOff,
        },
      });
    }
  }

  // One transaction: nothing can replace the breached set between the epoch and its liquidations.
  // A batch that would revert (e.g. the venue moved) is dropped from the call, never sent on its own
  // after the epoch: a separate liquidate would reopen the window an old epoch proof could use (M-1).
  const atomic = (list) => (list.length ? ['attestAndLiquidate', [health, list.map((b) => b.args)]] : ['attest', [health]]);
  const sim = (list) => publicClient.simulateContract({ account: keeper, ...desk, functionName: atomic(list)[0], args: atomic(list)[1] }).then(() => true, (error) => { report.dropped = [...(report.dropped ?? []), revertName(error)]; return false; });
  let send = batches;
  if (send.length && !(await sim(send))) {
    send = [];
    for (const b of batches) if (await sim([...send, b])) send.push(b);
  }
  report.attest = await submit(...atomic(send));
  report.batches.push(...send.map((b) => ({ asset: b.asset, slots: b.slots, tx: report.attest.hash })));
  report.batches.push(...batches.filter((b) => !send.includes(b)).map((b) => ({ asset: b.asset, slots: b.slots, error: 'dropped: would revert; retried next epoch' })));

  // Audit H-1: free the slots of positions without debt that nobody touched for EVICT_AFTER.
  const [evictAfter, now] = await Promise.all([read(deployment.desk, abis.desk, 'EVICT_AFTER'), publicClient.getBlock({ blockTag: 'latest' }).then((b) => b.timestamp)]);
  for (const [slot, p] of positions.entries()) {
    if (!p || p.debtScaled !== 0n || report.evicted.length >= MAX_EVICTIONS) continue;
    if (now < (await read(deployment.desk, abis.desk, 'touchedAt', [BigInt(slot)])) + evictAfter) continue;
    try {
      const e = buildEvict(p);
      const { proof: ep } = await prove('evict', e.witness);
      const tx = await submit('evict', [{ proof: ep, slot, asset: '0x' + p.asset.toString(16).padStart(40, '0'), collateral: p.collateral, commitment: e.public.commitment }]);
      report.evicted.push({ slot, ...tx });
    } catch (error) {
      report.evicted.push({ slot, error: revertName(error) });
    }
  }
  return report;
}

const prove = cachedProver(createProver, { health_epoch: healthCircuit, liquidate: liquidateCircuit, evict: evictCircuit });

export default async function handler(req, res) {
  if (!cronAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
  if (!deploymentReady) return json(res, 200, { skipped: 'network still on v1 contracts' });
  if (!keeper || !secret('DESK_OPERATOR_SK')) return json(res, 503, { error: 'desk_operator_unavailable' });
  // Epochs are 15 minutes in market hours and hourly off-hours.
  const open = await read(deployment.marker, abis.marker, 'marketOpen');
  if (!open && new Date().getUTCMinutes() >= 15 && req.query?.force !== '1') return json(res, 200, { skipped: 'off-hours epoch is hourly' });
  try {
    return json(res, 200, await runDesk({ operatorSk: BigInt(secret('DESK_OPERATOR_SK')), prove }));
  } catch (error) {
    return json(res, 500, { error: revertName(error) });
  }
}
