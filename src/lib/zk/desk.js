// Desk operator logic: opens every live position with the operator key, builds the epoch health
// proof and sealed liquidation batches (circuits/health_epoch, circuits/liquidate). Server-side
// only (api/cron/desk.js, scripts/ops); owners use `applyLiquidation` to follow their own position.
import { evictedBlinding, hash2, liquidatedBlinding, liquidationPad, noteCommitment, positionCommitment, randomField, FIELD } from './notes.js';
import { operatorDecrypt } from './grumpkin.js';
import { WAD } from './position.js';

export const SLOTS = 64;
export const CLASSES = 4;
export const BATCH = 4;
const HEALTH_SCALE = 10n ** 6n;
const VALUE_DIV = 10n ** 20n;
const BPS = 10_000n;
const HARD_FLOOR_BPS = 9_500n;
const BONUS_BPS = 200n;
const DEEP_BONUS_BPS = 800n;

const str = (x) => x.toString();
const mod = (a) => ((a % FIELD) + FIELD) % FIELD;
const debtTerm = (debtScaled, index) => debtScaled * index * HEALTH_SCALE;
const valueTerm = (collateral, mark, bps) => collateral * mark * BigInt(bps);

/** Health in bps of the liquidation threshold (10000 = at the threshold); null without debt. */
export const healthBps = (p, mark, liqBps, index) =>
  p.debtScaled === 0n ? null : (valueTerm(p.collateral, mark, liqBps) * BPS) / debtTerm(p.debtScaled, index);
export const isBreached = (p, mark, liqBps, index) => debtTerm(p.debtScaled, index) > valueTerm(p.collateral, mark, liqBps);
export const isDeep = (p, mark, liqBps, index) => debtTerm(p.debtScaled, index) * HARD_FLOOR_BPS > valueTerm(p.collateral, mark, liqBps) * BPS;

/** Liquidation payload in PositionUpdated: abi.encode(encSold, encRepaid), 64 bytes. */
export const LIQUIDATION_CIPHERTEXT_BYTES = 64;
export function applyLiquidation(position, ciphertextHex) {
  const h = ciphertextHex.replace(/^0x/, '');
  const sold = mod(BigInt('0x' + h.slice(0, 64)) - liquidationPad(position.blinding, 1));
  const repaidScaled = mod(BigInt('0x' + h.slice(64, 128)) - liquidationPad(position.blinding, 2));
  return { ...position, collateral: position.collateral - sold, debtScaled: position.debtScaled - repaidScaled, blinding: liquidatedBlinding(position.blinding), sold, repaidScaled };
}

/**
 * Replays desk events in chain order into the current opening of every slot.
 * events: [{ type: 'operator', slot, asset, eph, cipher } | { type: 'position', slot, leaf, ciphertext }]
 * Returns Array(SLOTS) of {asset, collateral, debtScaled, owner, blinding, leaf} or null (empty).
 * Throws if a live slot cannot be opened (the epoch proof must cover every slot).
 */
export function replaySlots(events, operatorSk) {
  const open = Array(SLOTS).fill(null);
  const leaf = Array(SLOTS).fill(0n);
  for (const e of events) {
    if (e.type === 'operator') {
      const [collateral, debtScaled, owner, blinding] = operatorDecrypt(operatorSk, e.eph, e.cipher);
      open[e.slot] = { asset: BigInt(e.asset), collateral, debtScaled, owner, blinding };
    } else {
      leaf[e.slot] = BigInt(e.leaf);
      if ((e.ciphertext.length - 2) / 2 === LIQUIDATION_CIPHERTEXT_BYTES && open[e.slot]) {
        const { sold, repaidScaled, ...next } = applyLiquidation(open[e.slot], e.ciphertext);
        open[e.slot] = next;
      }
    }
  }
  return open.map((p, slot) => {
    if (leaf[slot] === 0n) return null;
    if (!p || positionCommitment(p) !== leaf[slot]) throw new Error(`slot ${slot}: operator cannot open the live position`);
    return { ...p, leaf: leaf[slot] };
  });
}

/**
 * Epoch health witness over a desk snapshot (CreditDesk.snapshot()). classes: [{asset, mark, liqBps}]
 * (≤ CLASSES, padded with zeros). Returns {witness, public: {sumValue, sumDebt, breachCommit, leaves},
 * bitmap, salt, breached: [slot]}.
 */
export function buildHealth({ positions, classes, rateIndex, snapshotId = 0n, salt = randomField() }) {
  const cls = [...classes, ...Array(CLASSES - classes.length).fill({ asset: 0n, mark: 0n, liqBps: 0 })];
  let value = 0n; let debt = 0n; let bitmap = 0n;
  const breached = [];
  const slot = positions.map((p, i) => {
    if (!p) return { class: 0, collateral: 0n, debtScaled: 0n, owner: 0n, blinding: 0n, leaf: 0n };
    const k = cls.findIndex((c) => BigInt(c.asset) === p.asset);
    if (k < 0) throw new Error(`slot ${i}: unknown collateral class`);
    const { mark, liqBps } = cls[k];
    value += p.collateral * mark;
    debt += p.debtScaled * rateIndex;
    if (isBreached(p, mark, liqBps, rateIndex)) { bitmap |= 1n << BigInt(i); breached.push(i); }
    return { ...p, class: k, leaf: positionCommitment(p) };
  });
  const sumValue = value / VALUE_DIV;
  const sumDebt = (debt + WAD - 1n) / WAD;
  const breachCommit = hash2(bitmap, salt);
  const witness = {
    leaves: slot.map((s) => str(s.leaf)), assets: cls.map((c) => str(BigInt(c.asset))), marks: cls.map((c) => str(c.mark)),
    liq_bps: cls.map((c) => str(c.liqBps)), rate_index: str(rateIndex), sum_value: str(sumValue), sum_debt: str(sumDebt), breach_commit: str(breachCommit), snapshot_id: str(snapshotId),
    class: slot.map((s) => s.class), collateral: slot.map((s) => str(s.collateral)), debt_scaled: slot.map((s) => str(s.debtScaled)),
    owner: slot.map((s) => str(s.owner)), blinding: slot.map((s) => str(s.blinding)), salt: str(salt),
  };
  return { witness, public: { sumValue, sumDebt, breachCommit, leaves: slot.map((s) => s.leaf) }, bitmap, salt, breached };
}

/**
 * Largest sale that keeps the repayment within the close factor: 100% of debt below 95% health,
 * else 20%. All collateral if it cannot cover that (the rest of the debt is then written off).
 */
function sizeSale(p, { mark, price, liqBps, rateIndex, minDebt = 0n }, override) {
  const deep = isDeep(p, mark, liqBps, rateIndex);
  const bonus = deep ? DEEP_BONUS_BPS : BONUS_BPS;
  // A 20% partial sale that would leave dust debt (below minDebt) repays everything instead (H-1).
  const partialLeavesDust = minDebt * WAD * 5n > p.debtScaled * 4n * rateIndex;
  const target = deep || partialLeavesDust ? p.debtScaled : p.debtScaled / 5n;
  const maxRepay = ((target + 1n) * rateIndex - 1n) / WAD;
  const maxValue = ((maxRepay + 1n) * (BPS + bonus) - 1n) / BPS;
  let sold = override ?? ((maxValue + 1n) * VALUE_DIV - 1n) / price;
  if (sold > p.collateral) sold = p.collateral;
  const value = (sold * price) / VALUE_DIV;
  const repay = (value * BPS) / (BPS + bonus);
  const repaidScaled = (repay * WAD) / rateIndex;
  return { deep, sold, value, repay, repaidScaled };
}

/**
 * Sealed batches (≤ BATCH slots each) for one collateral class at a uniform `price`.
 * Only slots in the attested breached set that are still breached at `mark`; off-hours only below 95%.
 */
export function planLiquidations({ positions, bitmap, salt, asset, mark, price, liqBps, rateIndex, marketOpen, minDebt = 0n }) {
  const eligible = positions
    .map((p, slot) => ({ p, slot }))
    .filter(({ p, slot }) => p && p.asset === BigInt(asset) && (bitmap >> BigInt(slot)) & 1n && isBreached(p, mark, liqBps, rateIndex) && (marketOpen || isDeep(p, mark, liqBps, rateIndex)));
  const batches = [];
  for (let i = 0; i < eligible.length; i += BATCH) {
    batches.push(buildLiquidation({ entries: eligible.slice(i, i + BATCH), bitmap, salt, asset: BigInt(asset), mark, price, liqBps, rateIndex, marketOpen, minDebt }));
  }
  return batches;
}

/** entries: [{p, slot, sold?}] in increasing slot order; `sold` overrides the sale size (tests). */
export function buildLiquidation({ entries, bitmap, salt, asset, mark, price, liqBps, rateIndex, marketOpen, minDebt = 0n }) {
  const rows = entries.map(({ p, slot, sold }) => {
    let s = sizeSale(p, { mark, price, liqBps, rateIndex, minDebt }, sold);
    // Rounding can leave a sliver of debt on a remaining position: sell everything then (H-1).
    const restAfter = p.debtScaled - s.repaidScaled;
    if (sold === undefined && restAfter > 0n && s.sold < p.collateral && restAfter * rateIndex < minDebt * WAD) s = sizeSale(p, { mark, price, liqBps, rateIndex, minDebt }, p.collateral);
    const newColl = p.collateral - s.sold;
    const rest = p.debtScaled - s.repaidScaled;
    const newLeaf = newColl === 0n ? 0n : positionCommitment({ ...p, collateral: newColl, debtScaled: rest, blinding: liquidatedBlinding(p.blinding) });
    return {
      ...s, slot, p, oldLeaf: positionCommitment(p), newLeaf, writtenOff: newColl === 0n ? rest : 0n,
      encSold: mod(s.sold + liquidationPad(p.blinding, 1)), encRepaid: mod(s.repaidScaled + liquidationPad(p.blinding, 2)),
    };
  });
  const empty = { slot: 0, oldLeaf: 0n, newLeaf: 0n, encSold: 0n, encRepaid: 0n, sold: 0n, value: 0n, repay: 0n, repaidScaled: 0n, writtenOff: 0n, p: { collateral: 0n, debtScaled: 0n, owner: 0n, blinding: 0n } };
  const all = [...rows, ...Array(BATCH - rows.length).fill(empty)];
  const sum = (k) => all.reduce((t, r) => t + r[k], 0n);
  const pub = {
    breachCommit: hash2(bitmap, salt), collAsset: asset, mark, price, liqBps: BigInt(liqBps), rateIndex, marketOpen,
    slots: all.map((r) => r.slot), oldLeaves: all.map((r) => r.oldLeaf), newLeaves: all.map((r) => r.newLeaf),
    encSold: all.map((r) => r.encSold), encRepaid: all.map((r) => r.encRepaid),
    totalSold: sum('sold'), totalValue: sum('value'), totalRepay: sum('repay'), totalRepaidScaled: sum('repaidScaled'), totalWrittenOff: sum('writtenOff'), minDebt,
  };
  const witness = {
    breach_commit: str(pub.breachCommit), coll_asset: str(asset), mark: str(mark), price: str(price), liq_bps: str(liqBps), rate_index: str(rateIndex),
    market_open: marketOpen, slots: pub.slots.map(str), old_leaves: pub.oldLeaves.map(str), new_leaves: pub.newLeaves.map(str),
    enc_sold: pub.encSold.map(str), enc_repaid: pub.encRepaid.map(str),
    total_sold: str(pub.totalSold), total_value: str(pub.totalValue), total_repay: str(pub.totalRepay),
    total_repaid_scaled: str(pub.totalRepaidScaled), total_written_off: str(pub.totalWrittenOff), min_debt: str(minDebt),
    bitmap: str(bitmap), salt: str(salt),
    collateral: all.map((r) => str(r.p.collateral)), debt_scaled: all.map((r) => str(r.p.debtScaled)), owner: all.map((r) => str(r.p.owner)),
    blinding: all.map((r) => str(r.p.blinding)), sold: all.map((r) => str(r.sold)), values: all.map((r) => str(r.value)),
    repays: all.map((r) => str(r.repay)), repaid_scaled: all.map((r) => str(r.repaidScaled)),
  };
  return { witness, public: pub, rows };
}

/**
 * Eviction of an idle zero-debt position (circuits/evict): its collateral returns to the owner as a
 * note whose blinding the owner derives (evictedBlinding), so no ciphertext is needed.
 */
export function buildEvict(p) {
  if (p.debtScaled !== 0n) throw new Error('Only a position without debt can be evicted.');
  const note = { asset: p.asset, amount: p.collateral, owner: p.owner, blinding: evictedBlinding(p.blinding) };
  const pub = { leaf: positionCommitment(p), asset: p.asset, collateral: p.collateral, commitment: noteCommitment(note) };
  return {
    public: pub,
    witness: { leaf: str(pub.leaf), asset: str(p.asset), collateral: str(p.collateral), commitment: str(pub.commitment), owner: str(p.owner), blinding: str(p.blinding) },
  };
}
