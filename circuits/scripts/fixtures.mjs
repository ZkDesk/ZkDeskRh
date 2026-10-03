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
// M6 (v3.4): a treasury whose Payer is an AI agent with an allow list and a daily budget -> listed
//     payments (private and unshield) -> off-list / over-budget / forged-accumulator proofs rejected ->
//     the Owner pays anyone -> an Owner-approved payment is outside the scope -> next day's budget ->
//     the agent cannot commit a mandate -> a policy change resets the accumulator.
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
import { ACTIONS, AUTH, authExtHash, buildAttest, buildLedger, buildRoleAuth, ledgerKeys, openBudget, rolesOf } from '../../src/lib/zk/ledger.js';
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
const keepTest = (kind, label, witness, ok, name) => {
  const list = (nrTests[kind] ??= []);
  if (name || list.filter((t) => t.ok === ok && !t.name).length < (ok ? 3 : 6)) list.push({ label, witness, ok, name });
};
async function prove(kind, label, witness, extra = {}, name) {
  keepTest(kind, label, witness, true, name);
  const t0 = performance.now();
  const { witness: w } = await C[kind].noir.execute(witness);
  const proof = await C[kind].backend.generateProof(w, EVM);
  if (!(await C[kind].backend.verifyProof(proof, EVM))) throw new Error(`${label}: proof did not verify`);
  console.log(`${label}: ${kind} proof ok in ${Math.round(performance.now() - t0)} ms (${proof.publicInputs.length} public inputs)`);
  fixtures.push({ label, kind, proof: '0x' + Buffer.from(proof.proof).toString('hex'), publicInputs: proof.publicInputs, ...jsonable(extra) });
}
/** The circuit accepts this witness (a Noir test only; no proof or Solidity fixture). */
async function accepts(kind, label, witness, name) {
  keepTest(kind, label, witness, true, name);
  await C[kind].noir.execute(witness);
  console.log(`${label}: circuit accepts ✓`);
}
/** The circuit must refuse this witness (it cannot be proven). */
async function rejects(kind, label, witness, name) {
  keepTest(kind, label, witness, false, name);
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
const LIQ = 7000;
async function step(label, { slot = 0, collAsset = SPY, mark = MARK, ltvBps = LTV, liqBps = LIQ, ...args }) {
  const built = buildPosition({ tree, sk: alice, collAsset, usdgAsset: USDG, mark, ltvBps, liqBps, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, ...args });
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
  // Audit N-1: a step that moves nothing (it would only re-randomize the leaf) cannot be proven.
  const noop = buildPosition({ tree, sk: alice, collAsset: SPY, usdgAsset: USDG, mark: MARK, ltvBps: LTV, liqBps: LIQ, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, old: { collateral: WAD, debtScaled: 0n, blinding: 5n }, checks: false });
  await rejects('position', 'no-op step', noop.witness, 'rejects_noop_step');
  // Audit H-1: debt below the class minimum (here 5 USDG) cannot be opened.
  await rejects('position', 'dust debt', buildPosition({ tree, sk: alice, collAsset: SPY, usdgAsset: USDG, mark: MARK, ltvBps: LTV, liqBps: LIQ, minDebt: 5_000000n, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, collIn: WAD, draw: 1_000000n, inputs: [spy], checks: false }).witness, 'rejects_dust_debt');
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
const nv = { collAsset: NVDA, mark: NV120, ltvBps: 4500, liqBps: 5500 };
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
// Epochs prove CreditDesk snapshots 1 and 2 (snapshot ids are single-use public inputs).
const e1 = buildHealth({ positions, classes: classesAt(NV120), rateIndex: INDEX, snapshotId: 1n, salt: SALT });
await prove('health_epoch', 'epoch at $120: no breach', e1.witness, { bitmap: e1.bitmap, marks: [MARK, NV120, 0n, 0n] });
const e2 = buildHealth({ positions, classes: classesAt(NV72), rateIndex: INDEX, snapshotId: 2n, salt: SALT });
if (e2.bitmap !== ((1n << 3n) | (1n << 5n))) throw new Error(`expected slots 3 and 5 breached, got ${e2.breached}`);
await prove('health_epoch', 'epoch at $72: slots 3 and 5 breached', e2.witness, { bitmap: e2.bitmap, marks: [MARK, NV72, 0n, 0n] });

// Breach commitment binds exactly the breached set (fuzz: any other bitmap is unprovable).
for (let i = 0; i < 24; i++) {
  const wrong = i < SLOTS ? e2.bitmap ^ (1n << BigInt((i * 7) % SLOTS)) : 0n;
  await rejects('health_epoch', `  wrong breach set ${wrong.toString(2)}`, { ...e2.witness, breach_commit: hash2(wrong, SALT).toString() });
}
await rejects('health_epoch', 'omitted slot', { ...e2.witness, leaves: e2.witness.leaves.map((l, i) => (i === 5 ? '0' : l)) });
await rejects('health_epoch', 'mispriced slot', { ...e2.witness, marks: e2.witness.marks.map((m, k) => (k === 1 ? NV120.toString() : m)) });

// Audit N-1: at $72 A is breached (540 debt on $720 at 55%). A step that leaves it breached cannot be
// proven; one that cures it can. Built on the tree after B opened (fixture root 2), proven last.
const cureArgs = { tree, sk: alice, collAsset: NVDA, usdgAsset: USDG, mark: NV72, ltvBps: 4500, liqBps: 5500, rateIndex: INDEX, operatorPk: OPERATOR_PK, ext: posExt, old: a.position, inputs: [a.notes[1]] };
await rejects('position', 'breached step that stays breached', buildPosition({ ...cureArgs, repay: 1_000000n, checks: false }).witness, 'rejects_breached_step_that_stays_breached');
const cure = buildPosition({ ...cureArgs, repay: 150_000000n });

const liq = { positions, bitmap: e2.bitmap, salt: SALT, asset: NVDA, mark: NV72, price: PRICE, liqBps: 5500, rateIndex: INDEX };
// Audit H-1: under a 400 USDG minimum debt, B's 20% partial sale would leave dust, so B is repaid in full.
const [dustBatch] = planLiquidations({ ...liq, marketOpen: true, minDebt: 400_000000n });
if (dustBatch.rows[1].repaidScaled !== positions[5].debtScaled) throw new Error('dust rule: B should be repaid in full');
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
await rejects('liquidate', 'partial sale leaving dust debt', { ...batch.witness, min_debt: '400000000' }, 'rejects_partial_sale_leaving_dust_debt');

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
// 11: A cures at $72 (after fixture 2); 12: the 400 USDG minimum-debt batch (after fixture 4).
await prove('position', 'A cures its breach: repay 150 USDG at $72', cure.witness, { ext: posExt, slot: 3 }, 'accepts_breached_step_that_cures');
await prove('liquidate', 'batch with a 400 USDG minimum debt: B repaid in full', dustBatch.witness, { bitmap: e2.bitmap });
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
// Each ledger's governance nonce (TreasuryLedger.authNonce): a governance proof binds the next one.
const nonces = new Map();
const nextNonce = (on) => { const n = nonces.get(on.owner) ?? 0n; nonces.set(on.owner, n + 1n); return n; };
async function auth(label, { sk, config, action, newValue = 0n, shares, bytes = '0x06', on = ledger }) {
  const built = buildRoleAuth({ ledger: on, sk, config, action, newValue, extHash: authExtHash(shares, bytes, undefined, nextNonce(on)) });
  await prove('role_auth', label, built.witness, { ext: { shares, config: bytes } });
}
const T4 = 1_790_000_000n; // ledger transfers are proven at T4 (forge warps there)
// The ledger's spending accumulator after a transfer, as members read it from BudgetNote.
const afterTransfer = (on, built) => {
  if (built.public.action !== BigInt(ACTIONS.transfer)) return;
  on.budget = openBudget(on.lsk, { commit: built.public.budgetNew, nonce: built.public.inputNullifiers[0], ct: built.public.budgetCt });
};
async function act(label, args) {
  const ext = ledgerExt(args.ext);
  const built = buildLedger({ tree, ledger, t: T4, ...args, ext });
  await prove('ledger', label, built.witness, { ext });
  afterTransfer(ledger, built);
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
await rejects('ledger', 'a convert that moves the spending accumulator', { ...buildLedger({ tree, ledger, sk: Bb, role: 'Treasurer', ...alloc, out: { amount: shares600 }, ext: ledgerExt(alloc.ext), t: T4 }).witness, budget_new: '5' }, 'rejects_convert_moving_the_accumulator');
const allocated = await act('allocate 600 USDG to the vault (Treasurer)', { sk: Bb, role: 'Treasurer', ...alloc, out: { amount: shares600 } });
vSupply += shares600; vAssets += 600_000000n;
const [liquid, vaultNote] = allocated.notes;

await rejects('ledger', 'Auditor cannot transfer', buildLedger({ tree, ledger, sk: D, role: 'Auditor', action: ACTIONS.transfer, asset: USDG, inputs: [liquid], out: { amount: 10_000000n, owner: ownerPk(D) }, ext: ledgerExt({}), check: false }).witness);
const small = await act('transfer 50 USDG to Carol (Payer, under the threshold)', { sk: Cc, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [liquid], out: { amount: 50_000000n, owner: ownerPk(Cc) } });
const bigArgs = { tree, ledger, sk: Cc, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [small.notes[0]], out: { amount: 200_000000n, owner: ownerPk(Cc) }, ext: ledgerExt({}), t: T4 };
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
ledger.budget = undefined; // a rotation resets the accumulator
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
await act('transfer 5 USDG to Eve (2nd: over the limit)', { sk: E, role: 'Payer', action: ACTIONS.transfer, asset: USDG, inputs: [t1.notes[0]], out: { amount: 5_000000n, owner: ownerPk(E) }, t: T4 + 86_400n + 60n });
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
// Each mandate's change counter (MandateRegistry.changes): a mandate proof binds the next one.
const changes = new Map();
async function mauth(label, { sk, role, action, m, ct = '0x0a' }) {
  const key = JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  const nonce = changes.get(key) ?? 0n;
  changes.set(key, nonce + 1n);
  const built = buildMandateAuth({ ledger: L5, sk, role, action, mandate: m, ciphertext: ct, nonce });
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
  const b = buildRoleAuth({ ledger: L5, sk: A, config: L5.config, action: AUTH.create, extHash: authExtHash(['0x01'], '0x06', undefined, nextNonce(L5)) });
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

// ---------------- M6 (v3.4) ----------------
// Alice OWNER, Bob TREASURER, an AI agent PAYER, Dave AUDITOR. The agent may pay Vic (private) and one
// public address, at most 120 USDG per day; Alice may pay anyone.
tree = new LeanIMT((a, b) => hash2(a, b));
fixtures = [];
const [AG, VIC, MAL] = [666n, 888n, 999n];
const VADDR = 0x7e4d02n;
const addr = (x) => '0x' + x.toString(16).padStart(40, '0');
const T6 = 1_790_000_000n;
const L6 = { ...ledgerKeys(0x6ed6e5n) };
const allow6 = [ownerPk(VIC), VADDR, 0n, 0n, 0n, 0n, 0n, 0n];
const cfg6 = { name: 'Agent treasury', owner: ownerPk(A), treasurer: ownerPk(Bb), payer: ownerPk(AG), auditor: ownerPk(D), rolesSalt: 61n, allocCap: 800_000000n, dualThreshold: 100_000000n, policySalt: 62n, allow: allow6, budget: 120_000000n, budgetPeriod: DAY, budgetStart: T6 };
L6.config = cfg6;
async function act6(label, args) {
  const ext = ledgerExt(args.ext);
  const built = buildLedger({ tree, ledger: L6, action: ACTIONS.transfer, asset: USDG, ...args, ext });
  await prove('ledger', label, built.witness, { ext });
  afterTransfer(L6, built);
  return { notes: insert(built), built };
}
const draft6 = (args) => buildLedger({ tree, ledger: L6, action: ACTIONS.transfer, asset: USDG, ...args, ext: ledgerExt(args.ext), check: false });
{
  const b = buildRoleAuth({ ledger: L6, sk: A, config: cfg6, action: AUTH.create, extHash: authExtHash(['0x01'], '0x06', undefined, nextNonce(L6)) });
  await prove('role_auth', 'create the agent treasury (Owner)', b.witness, { ext: { shares: ['0x01'], config: '0x06' } });
}
const [cash6] = await tx('deposit 1000 USDG into the agent treasury', { asset: USDG, outputs: [{ amount: 1000_000000n, owner: L6.owner }], ext: { extAmount: 1000_000000n } });
const a1 = await act6('agent pays Vic 60 USDG (listed, day 0)', { sk: AG, role: 'Payer', inputs: [cash6], out: { amount: 60_000000n, owner: ownerPk(VIC) }, t: T6 + 100n });
const a2 = await act6('agent unshields 50 USDG to the listed address', { sk: AG, role: 'Payer', inputs: [a1.notes[0]], out: { amount: 0n, owner: L6.owner }, ext: { recipient: addr(VADDR), extAmount: -50_000000n }, t: T6 + 200n });
if (L6.budget.spent !== 110_000000n) throw new Error('accumulator should hold 110 USDG');
const next = a2.notes[0];
await rejects('ledger', 'agent over its daily budget (110 + 20 > 120)', draft6({ sk: AG, role: 'Payer', inputs: [next], out: { amount: 20_000000n, owner: ownerPk(VIC) }, t: T6 + 300n }).witness, 'rejects_scoped_payer_over_budget');
await rejects('ledger', 'agent pays a recipient not on the list', draft6({ sk: AG, role: 'Payer', inputs: [next], out: { amount: 5_000000n, owner: ownerPk(MAL) }, t: T6 + 300n }).witness, 'rejects_scoped_payer_off_list_private');
await rejects('ledger', 'agent unshields to an address not on the list', draft6({ sk: AG, role: 'Payer', inputs: [next], out: { amount: 0n, owner: L6.owner }, ext: { recipient: addr(0xbadn), extAmount: -5_000000n }, t: T6 + 300n }).witness, 'rejects_scoped_payer_off_list_unshield');
await rejects('ledger', 'agent forges a lower spent amount', { ...draft6({ sk: AG, role: 'Payer', inputs: [next], out: { amount: 5_000000n, owner: ownerPk(VIC) }, t: T6 + 300n }).witness, old_spent: '0' }, 'rejects_forged_accumulator_opening');
await rejects('ledger', 'agent claims the next budget window early', { ...draft6({ sk: AG, role: 'Payer', inputs: [next], out: { amount: 20_000000n, owner: ownerPk(VIC) }, t: T6 + DAY + 300n }).witness, t: (T6 + 300n).toString() }, 'rejects_budget_window_before_its_time');
await rejects('ledger', 'agent claims an older window than its time', { ...draft6({ sk: AG, role: 'Payer', inputs: [next], out: { amount: 5_000000n, owner: ownerPk(VIC) }, t: T6 + 300n }).witness, t: (T6 + DAY + 300n).toString() }, 'rejects_budget_window_older_than_its_time');
await accepts('ledger', 'agent spends exactly up to its budget (110 + 10 = 120)', draft6({ sk: AG, role: 'Payer', inputs: [next], out: { amount: 10_000000n, owner: ownerPk(VIC) }, t: T6 + 300n }).witness, 'accepts_scoped_payer_spending_exactly_the_budget');
await rejects('mandate_auth', 'scoped agent commits a mandate', buildMandateAuth({ ledger: L6, sk: AG, role: 'Payer', action: MANDATE_ACTIONS.commit, mandate: mandate({ recipient: ownerPk(MAL), cap: 50_000000n, salt: 94n }), check: false }).witness, 'rejects_scoped_payer_commits_mandate');
await rejects('mandate_auth', 'scoped agent resumes a mandate', buildMandateAuth({ ledger: L6, sk: AG, role: 'Payer', action: MANDATE_ACTIONS.resume, mandate: mandate({ recipient: ownerPk(MAL), cap: 50_000000n, salt: 94n }), check: false }).witness, 'rejects_scoped_payer_resumes_mandate');
await rejects('mandate_auth', 'scoped agent revokes a mandate', buildMandateAuth({ ledger: L6, sk: AG, role: 'Payer', action: MANDATE_ACTIONS.revoke, mandate: mandate({ recipient: ownerPk(MAL), cap: 50_000000n, salt: 94n }), check: false }).witness, 'rejects_scoped_payer_revokes_mandate');
await accepts('mandate_auth', 'scoped agent pauses a mandate', buildMandateAuth({ ledger: L6, sk: AG, role: 'Payer', action: MANDATE_ACTIONS.pause, mandate: mandate({ recipient: ownerPk(MAL), cap: 50_000000n, salt: 94n }) }).witness, 'accepts_scoped_payer_pausing_a_mandate');
const o6 = await act6('Owner pays Mallory 300 USDG (the Owner is not scoped)', { sk: A, role: 'Owner', inputs: [next], out: { amount: 300_000000n, owner: ownerPk(MAL) }, t: T6 + 300n });
const big6 = await act6('agent pays Mallory 200 USDG with the Owner\'s approval (outside the scope)', { sk: AG, role: 'Payer', inputs: [o6.notes[0]], out: { amount: 200_000000n, owner: ownerPk(MAL) }, t: T6 + 400n });
if (!big6.built.needsOwner || L6.budget.spent !== 110_000000n) throw new Error('approved payment should need the Owner and not count');
{
  const b = buildRoleAuth({ ledger: L6, sk: A, config: cfg6, action: AUTH.approve, newValue: big6.built.public.cosignIntent, extHash: authExtHash([], '0x', undefined, nextNonce(L6)) });
  await prove('role_auth', 'Owner approves the agent\'s 200 USDG payment', b.witness, { ext: { shares: [], config: '0x' } });
}
const d1 = await act6('agent pays Vic 100 USDG the next day (new window)', { sk: AG, role: 'Payer', inputs: [big6.notes[0]], out: { amount: 100_000000n, owner: ownerPk(VIC) }, t: T6 + DAY + 100n });
if (L6.budget.spent !== 100_000000n || L6.budget.window !== 1n) throw new Error('the new window should start from 0');
await rejects('ledger', 'budget window goes backwards', draft6({ sk: AG, role: 'Payer', inputs: [d1.notes[0]], out: { amount: 1_000000n, owner: ownerPk(VIC) }, t: T6 + 500n }).witness, 'rejects_budget_window_going_backwards');
const cfg6b = { ...cfg6, allow: Array(8).fill(0n), budget: 0n, budgetPeriod: 0n, budgetStart: 0n, policySalt: 63n };
{
  const b = buildRoleAuth({ ledger: L6, sk: A, config: cfg6, action: AUTH.setPolicy, newValue: policyHash(cfg6b), extHash: authExtHash([], '0x06', undefined, nextNonce(L6)) });
  await prove('role_auth', 'Owner lifts the agent\'s scope (policy change resets the accumulator)', b.witness, { ext: { shares: [], config: '0x06' } });
}
L6.config = cfg6b;
L6.budget = undefined;
const n9 = await act6('agent pays Mallory 10 USDG under the new policy', { sk: AG, role: 'Payer', inputs: [d1.notes[0]], out: { amount: 10_000000n, owner: ownerPk(MAL) }, t: T6 + DAY + 200n });
// v3.5: the Owner gives the agent an access end (and nothing else). Every Payer transfer needs t before it.
const END6 = T6 + DAY + 400n;
const cfg6c = { ...cfg6b, payerUntil: END6, policySalt: 64n };
{
  const b = buildRoleAuth({ ledger: L6, sk: A, config: cfg6b, action: AUTH.setPolicy, newValue: policyHash(cfg6c), extHash: authExtHash([], '0x06', undefined, nextNonce(L6)) });
  await prove('role_auth', "Owner sets an end to the agent's access", b.witness, { ext: { shares: [], config: '0x06' } });
}
L6.config = cfg6c;
L6.budget = undefined;
const end1 = await act6('agent pays Vic 5 USDG just before its access ends', { sk: AG, role: 'Payer', inputs: [n9.notes[0]], out: { amount: 5_000000n, owner: ownerPk(VIC) }, t: END6 - 100n });
await rejects('ledger', 'agent pays when its access has ended', draft6({ sk: AG, role: 'Payer', inputs: [end1.notes[0]], out: { amount: 5_000000n, owner: ownerPk(VIC) }, t: END6 }).witness, 'rejects_payer_after_access_ends');
await accepts('ledger', 'agent sends an Owner-approved payment before its access ends', draft6({ sk: AG, role: 'Payer', inputs: [end1.notes[0]], out: { amount: 200_000000n, owner: ownerPk(MAL) }, t: END6 - 50n }).witness, 'accepts_approved_payer_before_access_ends');
await rejects('ledger', 'agent sends an Owner-approved payment after its access ended', draft6({ sk: AG, role: 'Payer', inputs: [end1.notes[0]], out: { amount: 200_000000n, owner: ownerPk(MAL) }, t: END6 + 100n }).witness, 'rejects_approved_payer_after_access_ends');
await rejects('mandate_auth', 'agent with an access end commits a mandate', buildMandateAuth({ ledger: L6, sk: AG, role: 'Payer', action: MANDATE_ACTIONS.commit, mandate: mandate({ recipient: ownerPk(MAL), cap: 50_000000n, salt: 95n }), check: false }).witness, 'rejects_payer_with_access_end_commits_mandate');
await accepts('mandate_auth', 'agent with an access end pauses a mandate', buildMandateAuth({ ledger: L6, sk: AG, role: 'Payer', action: MANDATE_ACTIONS.pause, mandate: mandate({ recipient: ownerPk(MAL), cap: 50_000000n, salt: 95n }) }).witness, 'accepts_payer_with_access_end_pausing_a_mandate');
// Mandate pulls too: the agent cannot pull at or after its access end; the Owner can.
const mandate6 = mandate({ recipient: ownerPk(VIC), cap: 50_000000n, salt: 96n, start: T6, period: DAY, expiry: T6 + 90n * DAY });
const pull6 = (sk, role, t) => buildPull({ tree, ledger: L6, sk, role, mandate: mandate6, k: 1n, t, usdgAmount: 5_000000n, inputs: [end1.notes[0]], ext: {}, check: false }).witness;
await accepts('mandate_pull', 'agent pulls a mandate before its access ends', pull6(AG, 'Payer', END6 - 10n), 'accepts_payer_pull_before_access_ends');
await rejects('mandate_pull', 'agent pulls a mandate when its access has ended', pull6(AG, 'Payer', END6), 'rejects_payer_pull_after_access_ends');
await accepts('mandate_pull', "Owner pulls a mandate after the agent's access ended", pull6(A, 'Owner', END6 + 10n), 'accepts_owner_pull_after_access_ends');
await act6("Owner pays Mallory 1 USDG after the agent's access ended", { sk: A, role: 'Owner', inputs: [end1.notes[0]], out: { amount: 1_000000n, owner: ownerPk(MAL) }, t: END6 + 100n });
const m6 = fixtures;

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
    const name = fnName(t.name ?? `${t.ok ? '' : 'rejects '}${t.label}`, used);
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
writeFileSync('circuits/fixtures/m6.json', JSON.stringify(jsonable({ ...common, ledgerId: L6.owner, T: T6, vaddr: addr(VADDR), policyHash: policyHash(cfg6), policyHash2: policyHash(cfg6b), policyHash3: policyHash(cfg6c), end: END6, intent: big6.built.public.cosignIntent, txs: m6 }), null, 2));
writeFileSync('circuits/fixtures/m3.json', JSON.stringify(jsonable({ ...common, price: PRICE, batch: batch.public, offHours: offHours.public, cureLeaf: cure.public.newLeaf, txs: m3 }), null, 2));
console.log(`wrote ${m2.length} M2, ${m3.length} M3, ${m4.length} M4, ${m5.length} M5 and ${m6.length} M6 fixtures`);
await api.destroy();
