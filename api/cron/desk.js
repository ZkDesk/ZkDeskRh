// Vercel Cron, every 15 minutes (hourly off-hours): the desk operator. It is the testnet stand-in
// for the TEE health-prover and liquidation sequencer, and holds DESK_OPERATOR_SK. Each run:
//   1. replays CreditDesk events and opens every live slot with the operator key
//   2. proves the epoch (circuits/health_epoch) at the pinned marks and attests it on-chain
//   3. for each class with breached slots, proves sealed batches (circuits/liquidate) at the venue's
//      uniform price and liquidates them
// Nothing is stored off-chain; the indexer mirrors Attested / Liquidated events.
// Fallback when Functions are too slow or down: node scripts/ops/desk.mjs
import { parseAbi, parseAbiItem } from 'viem';
import { abis, cachedProver, deployment, publicClient, relayer, secret, sendFromRelayer, revertName, json } from '../_lib/server.js';
import { createProver } from '../../src/lib/zk/prover.js';
import { buildHealth, planLiquidations, replaySlots, CLASSES } from '../../src/lib/zk/desk.js';
import healthCircuit from '../../src/lib/zk/artifacts/health_epoch.json' with { type: 'json' };
import liquidateCircuit from '../../src/lib/zk/artifacts/liquidate.json' with { type: 'json' };

const EVENTS = {
  operator: parseAbiItem('event OperatorNote(uint8 indexed slot, address asset, uint256[2] eph, uint256[4] cipher)'),
  position: parseAbiItem('event PositionUpdated(uint8 indexed slot, uint256 leaf, bytes ciphertext)'),
};
const AMM = parseAbi(['function quote(address) view returns (uint256)']);
const RANGE = 50_000n;
const MIN_RELAYER_WEI = 5n * 10n ** 14n; // 0.0005 ETH ≈ 10 epochs
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
  const sim = await publicClient.simulateContract({ account: relayer, ...desk, functionName, args });
  const { hash } = await sendFromRelayer(functionName, args, sim.request.gas, desk);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, block: receipt.blockNumber, gas: receipt.gasUsed };
}

/** One desk run. prove(kind, witness) -> {proof}. Exported for scripts/ops/desk.mjs. */
export async function runDesk({ operatorSk, prove, log = () => {} }) {
  // Epochs share the relayer with user relays; leave it gas for those (draws halt if epochs stop).
  if ((await publicClient.getBalance({ address: relayer.address })) < MIN_RELAYER_WEI) throw Object.assign(new Error('relayer_low_balance'), { shortMessage: 'relayer_low_balance' });
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
  const attest = await submit('attest', [{ proof, marks, rateIndex: index, sumValue: h.public.sumValue, sumDebt: h.public.sumDebt, breachCommit: h.public.breachCommit }]);
  const report = { live, breached: h.breached, sumValue: h.public.sumValue, sumDebt: h.public.sumDebt, proveMs: Date.now() - t0, attest, batches: [] };

  for (const c of cls) {
    const price = await read(deployment.amm, AMM, 'quote', [c.address]);
    const batches = planLiquidations({ positions, bitmap: h.bitmap, salt: h.salt, asset: c.asset, mark: c.mark, price, liqBps: c.liqBps, rateIndex: index, marketOpen });
    for (const b of batches) {
      const p = b.public;
      log(`batch ${c.address}: slots ${p.slots.slice(0, b.rows.length)}`);
      try {
        const { proof: bp } = await prove('liquidate', b.witness);
        const tx = await submit('liquidate', [{
          proof: bp, collAsset: c.address, mark: p.mark, price: p.price, rateIndex: p.rateIndex, slots: p.slots,
          oldLeaves: p.oldLeaves, newLeaves: p.newLeaves, encSold: p.encSold, encRepaid: p.encRepaid,
          totalSold: p.totalSold, totalValue: p.totalValue, totalRepay: p.totalRepay, totalRepaidScaled: p.totalRepaidScaled, totalWrittenOff: p.totalWrittenOff,
        }]);
        report.batches.push({ asset: c.address, slots: p.slots.slice(0, b.rows.length), ...tx });
      } catch (error) {
        report.batches.push({ asset: c.address, error: revertName(error) });
      }
    }
  }
  return report;
}

const prove = cachedProver(createProver, { health_epoch: healthCircuit, liquidate: liquidateCircuit });

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return json(res, 401, { error: 'unauthorized' });
  if (!relayer || !secret('DESK_OPERATOR_SK')) return json(res, 503, { error: 'desk_operator_unavailable' });
  // Epochs are 15 minutes in market hours and hourly off-hours.
  const open = await read(deployment.marker, abis.marker, 'marketOpen');
  if (!open && new Date().getUTCMinutes() >= 15 && req.query?.force !== '1') return json(res, 200, { skipped: 'off-hours epoch is hourly' });
  try {
    return json(res, 200, await runDesk({ operatorSk: BigInt(secret('DESK_OPERATOR_SK')), prove }));
  } catch (error) {
    return json(res, 500, { error: revertName(error) });
  }
}
