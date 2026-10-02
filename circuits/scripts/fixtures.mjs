// Proves the M2 + M3 lifecycles with bb.js (the browser's prover) and writes, for forge tests:
//   contracts/src/verifiers/{Transact,Position,HealthEpoch,Liquidate}Verifier.sol   (evm target)
//   circuits/fixtures/m2.json, m3.json                    (proofs + public inputs + ext data)
//   src/lib/zk/artifacts/*.json                           (circuits for the app and the desk service)
// M2: deposit USDG -> private lend -> deposit SPY -> open + draw -> repay -> withdraw collateral ->
//     close -> private redeem.
// M3: deposit NVDA -> open A (45% LTV) and B (34% LTV) -> epoch at $120 (no breach) -> NVDA -40% ->
//     epoch at $72 (A deep, B shallow breach) -> sealed batch (market open: A 100%, B 20%) | off-hours
//     batch (A only) -> A closes from the liquidated state.
// M4: ledger create -> deposit into the ledger -> attest -> allocate (Treasurer) -> transfer under the
//     threshold (Payer) -> transfer over it + Owner approval -> deallocate -> rotate Payer -> new Payer acts.
// M5: treasury -> USDG + SPY deposits -> payroll / invoice (Owner, above the threshold) / SPY payroll
//     mandates -> pulls -> pause / resume / revoke -> Rita proves payments to her bank.
// Run after `nargo compile --workspace`: pnpm zk:fixtures
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';
import { LeanIMT } from '@zk-kit/lean-imt';
import { hash2, ownerPk, toHex } from '../../src/lib/zk/notes.js';
import { buildTransact } from '../../src/lib/zk/transact.js';
import { buildPosition, debtOf, WAD } from '../../src/lib/zk/position.js';
import { operatorPublicKey } from '../../src/lib/zk/grumpkin.js';
import { buildEvict, buildHealth, buildLiquidation, planLiquidations, replaySlots, SLOTS } from '../../src/lib/zk/desk.js';
import { ACTIONS, AUTH, authExtHash, buildAttest, buildLedger, buildRoleAuth, ledgerKeys, rolesOf } from '../../src/lib/zk/ledger.js';
import { policyHash } from '../../src/lib/zk/notes.js';
import { buildMandateAuth, buildPull, buildReceipt, MANDATE_ACTIONS } from '../../src/lib/zk/mandate.js';

const EVM = { verifierTarget: 'evm' };
const api = await Barretenberg.new();
const CIRCUITS = { transact: 'TransactVerifier', position: 'PositionVerifier', health_epoch: 'HealthEpochVerifier', liquidate: 'LiquidateVerifier', evict: 'EvictVerifier', ledger: 'LedgerVerifier', role_auth: 'RoleAuthVerifier', treasury_attest: 'TreasuryAttestVerifier', mandate_auth: 'MandateAuthVerifier', mandate_pull: 'MandatePullVerifier', receipt: 'ReceiptVerifier' };
const C = {};
for (const name of Object.keys(CIRCUITS)) {
  const circuit = JSON.parse(readFileSync(`circuits/target/${name}.json`, 'utf8'));
  C[name] = { circuit, noir: new Noir(circuit), backend: new UltraHonkBackend(circuit.bytecode, api) };
}

// Fixed values shared with contracts/test/ZKDesk.t.sol.
const USDG = 0xa55e7n;
const SPY = 0x5b1n;
const NVDA = 0x4e7dan;
const LENDING = 0x1e4dn; // lending pool (share token) address
const ZERO = '0x0000000000000000000000000000000000000000';
const MARK = 500_00000000n; // $500.00, 8 decimals
const LTV = 6000;
const INDEX = WAD;
const OPERATOR_SK = 0x0b5e55ed0de5c0ffeen;
const OPERATOR_PK = operatorPublicKey(OPERATOR_SK);
const alice = 12345n;
const me = ownerPk(alice);
let tree;
let fixtures;
const jsonable = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

// Noir #[test]s per circuit (circuits/<name>/src/tests.nr): the same witnesses, accepted and rejected.
const nrTests = {};
const keepTest = (kind, label, witness, ok) => {
  const list = (nrTests[kind] ??= []);
  if (list.filter((t) => t.ok === ok).length < (ok ? 3 : 6)) list.push({ label, witness, ok });
};
async function prove(kind, label, witness, extra = {}) {
  keepTest(kind, label, witness, true);
  const t0 = performance.now();
  const { witness: w } = await C[kind].noir.execute(witness);
  const proof = await C[kind].backend.generateProof(w, EVM);
  if (!(await C[kind].backend.verifyProof(proof, EVM))) throw new Error(`${label}: proof did not verify`);
  console.log(`${label}: ${kind} proof ok in ${Math.round(performance.now() - t0)} ms (${proof.publicInputs.length} public inputs)`);
  fixtures.push({ label, kind, proof: '0x' + Buffer.from(proof.proof).toString('hex'), publicInputs: proof.publicInputs, ...jsonable(extra) });
}
/** The circuit must refuse this witness (it cannot be proven). */
async function rejects(kind, label, witness) {
  keepTest(kind, label, witness, false);
  const ok = await C[kind].noir.execute(witness).then(() => true, () => false);
  if (ok) throw new Error(`${label}: witness executed`);
  console.log(`${label}: circuit rejects ✓`);
}
const txExt = (o) => ({ recipient: ZERO, extAmount: 0n, relayer: ZERO, fee: 0n, converter: ZERO, encryptedOutput1: '0x01', encryptedOutput2: '0x02', ...o });
const posExt = { relayer: ZERO, fee: 0n, encryptedOutput1: '0x01', encryptedOutput2: '0x02', encryptedPosition: '0x03' };
const insert = (built) => built.outputs.map((o) => { tree.insert(o.commitment); return { ...o, leafIndex: tree.size - 1 }; });
async function tx(label, args) {
  const ext = txExt(args.ext);
  const built = buildTransact({ tree, sk: alice, ...args, ext });
  await prove('transact', label, built.witness, { ext });
  return insert(built);
}
async function step(label, { slot = 0, collAsset = SPY, mark = MARK, ltvBps = LTV, ...args }) {
  const built = buildPosition({ tree, sk: alice, collAsset, usdgAsset: USDG, mark, ltvBps, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, ...args });
  await prove('position', label, built.witness, { ext: posExt, slot });
  // What the chain would emit, for the operator's replay.
  const events = [
    { type: 'operator', slot, asset: collAsset, eph: built.public.operatorEph, cipher: built.public.operatorCipher },
    { type: 'position', slot, leaf: built.public.newLeaf, ciphertext: '0x03' },
  ];
  return { notes: insert(built), position: built.position, events };
}

// ---------------- M2 ----------------
tree = new LeanIMT((a, b) => hash2(a, b));
fixtures = [];
// OpenZeppelin ERC4626 math with _decimalsOffset = 6 (floor).
let supply = 0n; let assets = 0n;
const toShares = (a) => (a * (supply + 10n ** 6n)) / (assets + 1n);
const toAssets = (s) => (s * (assets + 1n)) / (supply + 10n ** 6n);

const [usdg] = await tx('deposit 1000 USDG', { asset: USDG, outputs: [{ amount: 1000_000000n, owner: me }], ext: { extAmount: 1000_000000n } });
const shares = toShares(600_000000n); supply += shares; assets += 600_000000n;
const [usdgLeft, lpNote] = await tx('lend 600 USDG privately', { asset: USDG, outAsset: LENDING, publicAmountOut: shares, inputs: [usdg], outputs: [{ amount: 400_000000n, owner: me }, { amount: shares, owner: me }], ext: { extAmount: -600_000000n, converter: '0x' + LENDING.toString(16).padStart(40, '0') } });
const [spy] = await tx('deposit 10 SPY', { asset: SPY, outputs: [{ amount: 10n * WAD, owner: me }], ext: { extAmount: 10n * WAD } });

// Circuit-level LTV enforcement: a witness that lies about the mark cannot be executed.
{
  const cheat = buildPosition({ tree, sk: alice, collAsset: SPY, usdgAsset: USDG, mark: MARK * 10n, ltvBps: LTV, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, collIn: 10n * WAD, draw: 3001_000000n, inputs: [spy] });
  cheat.witness.mark = MARK.toString(); // honest public mark, over-LTV draw
  await rejects('position', 'over-LTV open', cheat.witness);
  const ok = buildPosition({ tree, sk: alice, collAsset: SPY, usdgAsset: USDG, mark: MARK, ltvBps: LTV, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, collIn: 10n * WAD, draw: 1n, inputs: [spy] });
  ok.witness.operator_cipher = [...ok.witness.operator_cipher.slice(0, 3), '7']; // operator copy lies about the blinding
  await rejects('position', 'wrong operator ciphertext', ok.witness);
  // Audit H-1: an open below the class minimum; audit M-5: operator_r = 0 (eph at infinity).
  const dust = buildPosition({ tree, sk: alice, collAsset: SPY, usdgAsset: USDG, mark: MARK, ltvBps: LTV, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, collIn: 1n, inputs: [spy] });
  await rejects('position', 'open below the minimum collateral', { ...dust.witness, min_coll: WAD.toString() });
  const r0 = buildPosition({ tree, sk: alice, collAsset: SPY, usdgAsset: USDG, mark: MARK, ltvBps: LTV, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, collIn: WAD, inputs: [spy], blindings: { operator: 0n } });
  await rejects('position', 'operator_r = 0', r0.witness);
}

const open = await step('open: 10 SPY in, draw 500 USDG', { collIn: 10n * WAD, draw: 500_000000n, inputs: [spy] });
const drawn = open.notes[1];
const repaid = await step('repay 200 USDG', { old: open.position, repay: 200_000000n, inputs: [drawn] });
const withdrawn = await step('withdraw 2 SPY collateral', { old: repaid.position, collOut: 2n * WAD });
const owed = debtOf(withdrawn.position.debtScaled, INDEX);
const closed = await step(`close: repay ${Number(owed) / 1e6} USDG, 8 SPY back`, { old: withdrawn.position, repay: owed, collOut: 8n * WAD, inputs: [repaid.notes[0]] });
const back = toAssets(shares);
await tx('redeem lender shares privately', { asset: LENDING, outAsset: USDG, publicAmountOut: back, inputs: [lpNote], outputs: [{ amount: 0n, owner: me }, { amount: back, owner: me }], ext: { extAmount: -shares, converter: '0x' + LENDING.toString(16).padStart(40, '0') } });
const m2 = fixtures;
console.log(`M2: ${m2.length} fixtures; usdgLeft ${usdgLeft.amount}, withdrawn ${withdrawn.notes[1].amount}, closed ${closed.position === null}`);

// ---------------- M3 ----------------
tree = new LeanIMT((a, b) => hash2(a, b));
fixtures = [];
const NV120 = 120_00000000n;
const NV72 = 72_00000000n; // -40%
const PRICE = (NV72 * 9_950n) / 10_000n; // MockAMM quote: mark - 0.5%
const nv = { collAsset: NVDA, mark: NV120, ltvBps: 4500 };
const classesAt = (nvMark) => [{ asset: SPY, mark: MARK, liqBps: 7000 }, { asset: NVDA, mark: nvMark, liqBps: 5500 }];
const events = [];

const [nvda] = await tx('deposit 20 NVDA', { asset: NVDA, outputs: [{ amount: 20n * WAD, owner: me }], ext: { extAmount: 20n * WAD } });
const a = await step('open A: 10 NVDA, draw 540 USDG (45% LTV)', { ...nv, slot: 3, collIn: 10n * WAD, draw: 540_000000n, inputs: [nvda] });
events.push(...a.events);
const b = await step('open B: 10 NVDA, draw 408 USDG (34% LTV)', { ...nv, slot: 5, collIn: 10n * WAD, draw: 408_000000n, inputs: [a.notes[0]] });
events.push(...b.events);

// The operator reconstructs every slot from chain events alone.
const positions = replaySlots(events, OPERATOR_SK);
if (positions.filter(Boolean).length !== 2 || positions[3].debtScaled !== 540_000000n) throw new Error('operator replay');

const SALT = 777n;
const e1 = buildHealth({ positions, classes: classesAt(NV120), rateIndex: INDEX, salt: SALT });
await prove('health_epoch', 'epoch at $120: no breach', e1.witness, { bitmap: e1.bitmap, marks: [MARK, NV120, 0n, 0n] });
const e2 = buildHealth({ positions, classes: classesAt(NV72), rateIndex: INDEX, salt: SALT });
if (e2.bitmap !== ((1n << 3n) | (1n << 5n))) throw new Error(`expected slots 3 and 5 breached, got ${e2.breached}`);
await prove('health_epoch', 'epoch at $72: slots 3 and 5 breached', e2.witness, { bitmap: e2.bitmap, marks: [MARK, NV72, 0n, 0n] });

// Breach commitment binds exactly the breached set (fuzz: any other bitmap is unprovable).
for (let i = 0; i < 24; i++) {
  const wrong = i < SLOTS ? e2.bitmap ^ (1n << BigInt((i * 7) % SLOTS)) : 0n;
  await rejects('health_epoch', `  wrong breach set ${wrong.toString(2)}`, { ...e2.witness, breach_commit: hash2(wrong, SALT).toString() });
}
await rejects('health_epoch', 'omitted slot', { ...e2.witness, leaves: e2.witness.leaves.map((l, i) => (i === 5 ? '0' : l)) });
await rejects('health_epoch', 'mispriced slot', { ...e2.witness, marks: e2.witness.marks.map((m, k) => (k === 1 ? NV120.toString() : m)) });

const liq = { positions, bitmap: e2.bitmap, salt: SALT, asset: NVDA, mark: NV72, price: PRICE, liqBps: 5500, rateIndex: INDEX };
const [batch] = planLiquidations({ ...liq, marketOpen: true });
const [rA, rB] = batch.rows;
if (!rA.deep || rB.deep || rA.repaidScaled !== positions[3].debtScaled || rB.repaidScaled * 5n > positions[5].debtScaled) throw new Error('close factors');
await prove('liquidate', `batch (open): A ${rA.sold} sold, B ${rB.sold} sold`, batch.witness, { bitmap: e2.bitmap });
const [offHours] = planLiquidations({ ...liq, marketOpen: false });
if (offHours.rows.length !== 1 || offHours.rows[0].slot !== 3) throw new Error('off-hours batch should hold A only');
await prove('liquidate', 'batch (off-hours): A only', offHours.witness, { bitmap: e2.bitmap });

// Liquidation rules at the circuit level.
await rejects('liquidate', 'off-hours shallow breach (B)', { ...batch.witness, market_open: false });
const one = (slot, extra = {}) => buildLiquidation({ ...liq, marketOpen: true, entries: [{ p: positions[slot], slot, ...extra }] }).witness;
await rejects('liquidate', 'shallow breach sold above the 20% close factor', one(5, { sold: rB.sold * 2n }));
await rejects('liquidate', 'position not breached at $120', { ...one(3), mark: NV120.toString() });
await rejects('liquidate', 'slot outside the attested set', { ...batch.witness, bitmap: (1n << 3n).toString(), breach_commit: hash2(1n << 3n, SALT).toString() });

// A's owner follows the liquidation (debt fully repaid) and takes the unsold collateral back.
const afterEvents = [...events, ...batch.rows.map((r) => ({ type: 'position', slot: r.slot, leaf: r.newLeaf, ciphertext: '0x' + r.encSold.toString(16).padStart(64, '0') + r.encRepaid.toString(16).padStart(64, '0') }))];
const afterA = replaySlots(afterEvents, OPERATOR_SK)[3];
const restA = { collateral: afterA.collateral, debtScaled: afterA.debtScaled, blinding: afterA.blinding };
await step(`close A after liquidation: ${afterA.collateral} NVDA back`, { ...nv, mark: NV72, slot: 3, old: restA, collOut: afterA.collateral, repay: debtOf(afterA.debtScaled, INDEX), inputs: afterA.debtScaled ? [a.notes[1]] : [] });

// Audit H-1: an idle position without debt is evicted; its collateral returns to the owner's note.
const [nvda2] = await tx('deposit 1 NVDA', { asset: NVDA, outputs: [{ amount: WAD, owner: me }], ext: { extAmount: WAD } });
const idle = await step('open C: 1 NVDA, no debt', { ...nv, mark: NV72, slot: 7, collIn: WAD, inputs: [nvda2] });
const ev = buildEvict({ asset: NVDA, collateral: WAD, debtScaled: 0n, owner: me, blinding: idle.position.blinding });
await prove('evict', 'evict C after a day without activity', ev.witness, { slot: 7, asset: toHex(NVDA), collateral: WAD, commitment: ev.public.commitment });
await rejects('evict', 'evict with a forged debt-free opening', { ...ev.witness, collateral: (2n * WAD).toString() });
const m3 = fixtures;

// ---------------- M4 ----------------
// Alice OWNER, Bob TREASURER, Carol PAYER, Dave AUDITOR; later Eve replaces Carol as PAYER.
tree = new LeanIMT((a, b) => hash2(a, b));
fixtures = [];
const VAULT = 0x7a017n;
const [A, Bb, Cc, D, E] = [111n, 222n, 333n, 444n, 555n];
const LSK = 0x1ed6e5n;
const ledger = { ...ledgerKeys(LSK) };
const cfg = { name: 'Ops treasury', owner: ownerPk(A), treasurer: ownerPk(Bb), payer: ownerPk(Cc), auditor: ownerPk(D), rolesSalt: 71n, allocCap: 800_000000n, dualThreshold: 100_000000n, policySalt: 72n };
ledger.config = cfg;
const ATTEST_ASSETS_FIX = [USDG, VAULT, SPY, 0x9991n, NVDA, 0x7e51an];
const ledgerExt = (o) => ({ recipient: ZERO, extAmount: 0n, encryptedOutput1: '0x01', encryptedOutput2: '0x02', ...o });
async function auth(label, { sk, config, action, newValue = 0n, shares, bytes = '0x06', on = ledger }) {
  const built = buildRoleAuth({ ledger: on, sk, config, action, newValue, extHash: authExtHash(shares, bytes) });
  await prove('role_auth', label, built.witness, { ext: { shares, config: bytes } });
}
async function act(label, args) {
  const ext = ledgerExt(args.ext);
  const built = buildLedger({ tree, ledger, ...args, ext });
  await prove('ledger', label, built.witness, { ext });
  return { notes: insert(built), built };
}

await auth('create ledger (Owner)', { sk: A, config: cfg, action: AUTH.create, shares: ['0x01', '0x02', '0x03', '0x04'] });
await rejects('role_auth', 'Treasurer cannot rotate roles', { ...buildRoleAuth({ ledger, sk: A, config: cfg, action: AUTH.rotate, extHash: 1n }).witness, sk: Bb.toString() });
const [fund] = await tx('deposit 1000 USDG into the ledger', { asset: USDG, outputs: [{ amount: 1000_000000n, owner: ledger.owner }], ext: { extAmount: 1000_000000n } });
// A personal transact cannot spend a ledger note, even knowing the ledger secret.
await rejects('transact', 'ledger note spent through transact', buildTransact({ tree, sk: LSK, asset: USDG, inputs: [fund], outputs: [{ amount: 1000_000000n, owner: ownerPk(LSK) }], ext: txExt({ extAmount: 0n }) }).witness);

const PRICES = [10n ** 18n, 10n ** 12n, MARK / 100n, 0n, 0n, 0n]; // empty vault; SPY pinned at $500
const unspentFund = [{ ...fund, asset: USDG, status: 'unspent' }];
const att = buildAttest({ tree, ledger, notes: unspentFund, assets: ATTEST_ASSETS_FIX, prices: PRICES, liabilities: 900_000000n });
await prove('treasury_attest', 'attest: assets cover 900 USDG liabilities', att.witness);
await rejects('treasury_attest', 'liabilities above assets', { ...att.witness, liabilities: '1000000001' });
const twice = Object.fromEntries(Object.entries(att.witness).map(([k, v]) => [k, Array.isArray(v) && v.length === 8 ? [v[0], v[0], ...v.slice(2)] : v]));
await rejects('treasury_attest', 'same note counted twice', twice);

const alloc = { action: ACTIONS.allocate, asset: USDG, outAsset: VAULT, inputs: [fund], ext: { extAmount: -600_000000n } };
let vSupply = 0n; let vAssets = 0n;
const vShares = (a) => (a * (vSupply + 10n ** 6n)) / (vAssets + 1n);
const vAssetsOf = (s) => (s * (vAssets + 1n)) / (vSupply + 10n ** 6n);
const shares600 = vShares(600_000000n);
await rejects('ledger', 'Payer cannot allocate', buildLedger({ tree, ledger, sk: Cc, role: 'Payer', ...alloc, out: { amount: shares600 }, ext: ledgerExt(alloc.ext), check: false }).witness);
await rejects('ledger', 'allocation above the policy cap', buildLedger({ tree, ledger, sk: Bb, role: 'Treasurer', ...alloc, out: { amount: vShares(900_000000n) }, ext: ledgerExt({ extAmount: -900_000000n }), check: false }).witness);
const allocated = await act('allocate 600 USDG to the vault (Treasurer)', { sk: Bb, role: 'Treasurer', ...alloc, out: { amount: shares600 } });
vSupply += shares600; vAssets += 600_000000n;
const [liquid, vaultNote] = allocated.notes;

await rejects('ledger', 'Auditor cannot transfer', buildLedger({ tree, ledger, sk: D, role: 'Auditor', action: ACTIONS.transfer, asset: USDG, inputs: [liquid], out: { amount: 10_000000n, owner: ownerPk(D) }, ext: ledgerExt({}), check: false }).witness);
const small = await act('transfer 50 USDG to Carol (Payer, under the threshold)', { sk: Cc, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [liquid], out: { amount: 50_000000n, owner: ownerPk(Cc) } });
const bigArgs = { tree, ledger, sk: Cc, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [small.notes[0]], out: { amount: 200_000000n, owner: ownerPk(Cc) }, ext: ledgerExt({}) };
const bigDraft = buildLedger(bigArgs);
if (!bigDraft.needsOwner) throw new Error('expected dual control');
await rejects('ledger', 'over the threshold without the owner intent', { ...bigDraft.witness, cosign_intent: '0' });
const big = await act('transfer 200 USDG (Payer, over the threshold: needs Owner)', bigArgs);
await auth('approve the 200 USDG transfer (Owner)', { sk: A, config: cfg, action: AUTH.approve, newValue: big.built.public.cosignIntent, shares: [], bytes: '0x' });

const vaultBack = vAssetsOf(shares600);
await act('deallocate all vault shares (Treasurer)', { sk: Bb, role: 'Treasurer', action: ACTIONS.deallocate, asset: VAULT, outAsset: USDG, inputs: [vaultNote], out: { amount: vaultBack }, ext: { extAmount: -shares600 } });
const cfg2 = { ...cfg, payer: ownerPk(E), rolesSalt: 73n };
await auth('rotate: Eve replaces Carol as Payer (Owner)', { sk: A, config: cfg, action: AUTH.rotate, newValue: rolesOf(cfg2), shares: ['0x05'] });
ledger.config = cfg2;
const eve = await act('transfer 10 USDG to Eve (new Payer)', { sk: E, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [big.notes[0]], out: { amount: 10_000000n, owner: ownerPk(E) } });

// Audit M-4: Carol (Payer of the Ops treasury) owns a second ledger and "approves" the Ops intent there.
const L2 = { ...ledgerKeys(0x2ed6e5n) };
const cfgL2 = { ...cfg, name: 'Carol side ledger', owner: ownerPk(Cc), rolesSalt: 74n, policySalt: 75n };
await auth('create a second ledger (Carol as its Owner)', { sk: Cc, config: cfgL2, action: AUTH.create, shares: ['0x07'], on: L2 });
await auth('approve the Ops intent from the second ledger (Carol)', { sk: Cc, config: cfgL2, action: AUTH.approve, newValue: big.built.public.cosignIntent, shares: [], bytes: '0x', on: L2 });
// Audit M-4: the Owner caps transfers without approval at 1 per day; the second one is refused.
const LIMIT = 1n | (86_400n << 64n);
await auth('limit: 1 transfer without approval per day (Owner)', { sk: A, config: cfg2, action: 4, newValue: LIMIT, shares: [], bytes: '0x' });
const t1 = await act('transfer 5 USDG to Eve (1st under the limit)', { sk: E, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [eve.notes[0]], out: { amount: 5_000000n, owner: ownerPk(E) } });
await act('transfer 5 USDG to Eve (2nd: over the limit)', { sk: E, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [t1.notes[0]], out: { amount: 5_000000n, owner: ownerPk(E) } });
const m4 = fixtures;

// ---------------- M5 ----------------
// Treasury (Alice Owner, Bob Treasurer, Carol Payer, Dave Auditor) pays Rita (a personal account).
tree = new LeanIMT((a, b) => hash2(a, b));
fixtures = [];
const RITA = 777n;
const T0 = 1_790_000_000n; // mandates start here; pulls are proven at T0 + 100 (forge warps there)
const T = T0 + 100n;
const L5 = { ...ledgerKeys(0x5ed6e5n) };
L5.config = { ...cfg, name: 'Payroll treasury', rolesSalt: 81n, policySalt: 82n };
const receipts = new LeanIMT((a, b) => hash2(a, b));
const DAY = 86_400n;
const mandate = (o) => ({ kind: 0n, recipient: ownerPk(RITA), asset: USDG, cap: 80_000000n, period: 30n * DAY, start: T0, expiry: T0 + 90n * DAY, reference: 0n, salt: 91n, ...o });
const payroll = mandate({});
const invoice = mandate({ kind: 1n, cap: 150_000000n, period: 0n, reference: 0x494e562d37n, salt: 92n }); // "INV-7"
const spyPay = mandate({ asset: SPY, cap: 100_000000n, period: 7n * DAY, salt: 93n });
const ledger5 = { tree: null };
async function mauth(label, { sk, role, action, m, ct = '0x0a' }) {
  const built = buildMandateAuth({ ledger: L5, sk, role, action, mandate: m, ciphertext: ct });
  await prove('mandate_auth', label, built.witness, { ext: { ciphertext: ct } });
  return built.commit;
}
async function pull(label, args) {
  const ext = { encryptedOutput1: '0x01', encryptedOutput2: '0x02' };
  const built = buildPull({ tree, ledger: L5, t: T, k: 0n, ext, ...args });
  await prove('mandate_pull', label, built.witness, { ext });
  const notes = insert(built);
  receipts.insert(built.public.receiptLeaf);
  return { notes, built, leafIndex: receipts.size - 1 };
}

{
  const b = buildRoleAuth({ ledger: L5, sk: A, config: L5.config, action: AUTH.create, extHash: authExtHash(['0x01'], '0x06') });
  await prove('role_auth', 'create payroll treasury (Owner)', b.witness, { ext: { shares: ['0x01'], config: '0x06' } });
}
const [cash5] = await tx('deposit 1000 USDG into the treasury', { asset: USDG, outputs: [{ amount: 1000_000000n, owner: L5.owner }], ext: { extAmount: 1000_000000n } });
const [spy5] = await tx('deposit 10 SPY into the treasury', { asset: SPY, outputs: [{ amount: 10n * WAD, owner: L5.owner }], ext: { extAmount: 10n * WAD } });

const cPay = await mauth('commit payroll 80/month to Rita (Payer)', { sk: Cc, role: 'Payer', action: MANDATE_ACTIONS.commit, m: payroll });
await rejects('mandate_auth', 'Payer commits above the dual-control threshold', buildMandateAuth({ ledger: L5, sk: Cc, role: 'Payer', action: MANDATE_ACTIONS.commit, mandate: invoice, check: false }).witness);
await rejects('mandate_auth', 'Auditor commits', buildMandateAuth({ ledger: L5, sk: D, role: 'Auditor', action: MANDATE_ACTIONS.commit, mandate: payroll, check: false }).witness);
const cInv = await mauth('commit invoice INV-7 for 150 (Owner: above the threshold)', { sk: A, role: 'Owner', action: MANDATE_ACTIONS.commit, m: invoice });
const cSpy = await mauth('commit weekly SPY payroll worth 100 USDG (Treasurer)', { sk: Bb, role: 'Treasurer', action: MANDATE_ACTIONS.commit, m: spyPay });

const p1 = await pull('pay payroll period 0: 80 USDG (Payer)', { sk: Cc, role: 'Payer', mandate: payroll, usdgAmount: 80_000000n, inputs: [cash5] });
await rejects('mandate_pull', 'above the cap', buildPull({ tree, ledger: L5, sk: Cc, role: 'Payer', mandate: payroll, k: 1n, t: T + 30n * DAY, usdgAmount: 81_000000n, inputs: [p1.notes[0]], ext: {}, check: false }).witness);
await rejects('mandate_pull', 'next period before it starts', buildPull({ tree, ledger: L5, sk: Cc, role: 'Payer', mandate: payroll, k: 1n, t: T, usdgAmount: 80_000000n, inputs: [p1.notes[0]], ext: {} }).witness);
await rejects('mandate_pull', 'after expiry', buildPull({ tree, ledger: L5, sk: Cc, role: 'Payer', mandate: payroll, k: 3n, t: T0 + 91n * DAY, usdgAmount: 80_000000n, inputs: [p1.notes[0]], ext: {} }).witness);
await rejects('mandate_pull', 'Auditor pulls', buildPull({ tree, ledger: L5, sk: D, role: 'Auditor', mandate: payroll, k: 0n, t: T, usdgAmount: 1n, inputs: [p1.notes[0]], ext: {}, check: false }).witness);
await rejects('mandate_pull', 'invoice paid a second time (k = 1)', buildPull({ tree, ledger: L5, sk: Cc, role: 'Payer', mandate: invoice, k: 1n, t: T, usdgAmount: 150_000000n, inputs: [p1.notes[0]], ext: {} }).witness);
const p2 = await pull('pay invoice INV-7: 150 USDG (Payer)', { sk: Cc, role: 'Payer', mandate: invoice, usdgAmount: 150_000000n, inputs: [p1.notes[0]] });
const p3 = await pull('pay SPY payroll: 50 USDG worth at $500 = 0.1 SPY (Payer)', { sk: Cc, role: 'Payer', mandate: spyPay, usdgAmount: 50_000000n, mark: MARK, inputs: [spy5] });
if (p3.built.raw !== WAD / 10n) throw new Error('stock payroll raw units');
{
  const lie = buildPull({ tree, ledger: L5, sk: Cc, role: 'Payer', mandate: spyPay, k: 0n, t: T, usdgAmount: 50_000000n, mark: MARK, inputs: [p3.notes[0]], ext: {} }).witness;
  await rejects('mandate_pull', 'stock payroll at a wrong conversion', { ...lie, raw_amount: (WAD / 5n).toString() });
}
await mauth('pause payroll (Payer)', { sk: Cc, role: 'Payer', action: MANDATE_ACTIONS.pause, m: payroll, ct: '0x' });
await mauth('resume payroll (Payer)', { sk: Cc, role: 'Payer', action: MANDATE_ACTIONS.resume, m: payroll, ct: '0x' });
await mauth('revoke SPY payroll (Owner)', { sk: A, role: 'Owner', action: MANDATE_ACTIONS.revoke, m: spyPay, ct: '0x' });

const BANK = 0xba4bn;
const rc = (p, o) => buildReceipt({ receipts, sk: RITA, payment: p.notes[1], ledgerId: L5.owner, k: 0n, leafIndex: p.leafIndex, verifier: BANK, ...o });
const r1 = rc(p1, { discloseAmount: true });
await prove('receipt', 'Rita proves payroll period 0 to her bank (amount disclosed)', r1.witness);
await prove('receipt', 'Rita proves the SPY payment (nothing disclosed)', rc(p3, {}).witness);
await rejects('receipt', 'someone else claims Rita\'s receipt', { ...r1.witness, sk: '778' });
await rejects('receipt', 'a disclosed amount that was not paid', { ...r1.witness, amount_out: '90000000' });
const m5 = fixtures;

for (const [name, file] of Object.entries(CIRCUITS)) {
  const vk = await C[name].backend.getVerificationKey(EVM);
  const sol = (await C[name].backend.getSolidityVerifier(vk, EVM)).replaceAll('HonkVerifier', file);
  mkdirSync('contracts/src/verifiers', { recursive: true });
  writeFileSync(`contracts/src/verifiers/${file}.sol`, sol);
  mkdirSync('src/lib/zk/artifacts', { recursive: true });
  writeFileSync(`src/lib/zk/artifacts/${name}.json`, JSON.stringify(C[name].circuit));
}
const literal = (type, v) => {
  if (type.kind === 'array') return `[${v.map((x) => literal(type.type, x)).join(', ')}]`;
  if (type.kind === 'boolean') return v === true || v === 'true' ? 'true' : 'false';
  return BigInt(v).toString();
};
const fnName = (label, used) => {
  let n = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'case';
  if (/^[0-9]/.test(n)) n = `case_${n}`;
  while (used.has(n)) n += '_';
  used.add(n);
  return n;
};
for (const [kind, tests] of Object.entries(nrTests)) {
  const params = C[kind].circuit.abi.parameters;
  const used = new Set();
  const NL = '\n';
  const body = tests.map((t) => {
    const args = params.map((p) => literal(p.type, t.witness[p.name])).join(`,${NL}        `);
    const name = fnName(`${t.ok ? '' : 'rejects '}${t.label}`, used);
    return [t.ok ? '#[test]' : '#[test(should_fail)]', `fn ${name}() {`, '    super::main(', `        ${args},`, '    );', '}', ''].join(NL);
  }).join(NL);
  writeFileSync(`circuits/${kind}/src/tests.nr`, `// Generated by circuits/scripts/fixtures.mjs from the witnesses behind circuits/fixtures (do not edit):
// each accepted witness is also a Solidity fixture; each rejected one is a property the circuit enforces.

${body}`);
}
mkdirSync('circuits/fixtures', { recursive: true });
const common = { usdg: toHex(USDG), spy: toHex(SPY), nvda: toHex(NVDA), lending: toHex(LENDING), operatorPk: OPERATOR_PK.map((x) => x.toString()) };
writeFileSync('circuits/fixtures/m2.json', JSON.stringify({ ...common, mark: MARK.toString(), ltvBps: LTV, shares: shares.toString(), redeemAssets: back.toString(), closedLeaf: closed.position === null, txs: m2 }, null, 2));
writeFileSync('circuits/fixtures/m4.json', JSON.stringify(jsonable({ ...common, vault: toHex(VAULT), ledgerId: ledger.owner, ledgerId2: L2.owner, limit: LIMIT, rolesCommit: rolesOf(cfg), rolesCommit2: rolesOf(cfg2), policyHash: policyHash(cfg), intent: big.built.public.cosignIntent, attestAssets: ATTEST_ASSETS_FIX.map(toHex), prices: PRICES, shares600, vaultBack, txs: m4 }), null, 2));
writeFileSync('circuits/fixtures/m5.json', JSON.stringify(jsonable({ ...common, ledgerId: L5.owner, T, commits: { payroll: cPay, invoice: cInv, spy: cSpy }, receiptRoot: receipts.root, spyRaw: p3.built.raw, txs: m5 }), null, 2));
writeFileSync('circuits/fixtures/m3.json', JSON.stringify(jsonable({ ...common, price: PRICE, batch: batch.public, offHours: offHours.public, txs: m3 }), null, 2));
console.log(`wrote ${m2.length} M2, ${m3.length} M3, ${m4.length} M4 and ${m5.length} M5 fixtures`);
await api.destroy();
