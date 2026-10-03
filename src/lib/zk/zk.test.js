// node src/lib/zk/zk.test.js — primitives shared with circuits/lib (Noir) and ZKDeskPool (Solidity).
import assert from 'node:assert/strict';
import { hash2, publicAmount, FIELD } from './notes.js';
import { decryptNote, encryptNote, NOTE_CIPHERTEXT_BYTES } from './crypto.js';
import { canonicalSignature, deriveKeys, passkeyKeys, seedWords, wordsSeed } from './keys.js';
import { G, mul, operatorDecrypt, operatorEncrypt, operatorPublicKey } from './grumpkin.js';
import { applyLiquidation, buildHealth, isBreached } from './desk.js';
import { liquidatedBlinding, liquidationPad, positionCommitment, ownerPk } from './notes.js';
import { decryptConfig, decryptKeyShare, encryptConfig, encryptKeyShare } from './crypto.js';
import { ACTIONS, buildLedger, budgetWindow, heldRoles, ledgerKeys, openBudget, payerDeltas, payerScoped, payerSpent } from './ledger.js';
import { buildMandateAuth, MANDATE_ACTIONS } from './mandate.js';
import { allowHash, budgetCommit, budgetPad, policyHash } from './notes.js';
import { NOTE_MEMO_CIPHERTEXT_BYTES } from './crypto.js';
import { LeanIMT } from '@zk-kit/lean-imt';

// Same circomlib vector as circuits/lib and contracts/test.
assert.equal(hash2(1n, 2n), 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189an);
assert.equal(publicAmount(5n), 5n);
assert.equal(publicAmount(-5n), FIELD - 5n);

const sig = '0x' + 'ab'.repeat(65);
const a = deriveKeys(sig);
assert.deepEqual(deriveKeys(sig).sk, a.sk, 'deterministic');
assert.ok(a.sk < FIELD);
const b = deriveKeys('0x' + 'cd'.repeat(65));
assert.notEqual(a.sk, b.sk);
// Every wallet encoding of one signature gives the same keys; a canonical one is unchanged.
{
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = 'a1'.repeat(32);
  const s = (5n).toString(16).padStart(64, '0');
  const canonical = '0x' + r + s + '1b';
  const k = deriveKeys(canonical);
  assert.equal(deriveKeys('0x' + r + s + '00').sk, k.sk, 'v = 0 is v = 27');
  assert.equal(deriveKeys('0x' + r + (N - 5n).toString(16).padStart(64, '0') + '1c').sk, k.sk, 'high s with flipped v is the same signature');
  assert.equal(canonicalSignature(canonical), canonical.slice(2), 'canonical signatures are unchanged');
}

const note = { asset: 0x8c898f70efd7665280460fc3c9fbb5e56b8d8bddn, amount: 1234_567890n, blinding: FIELD - 1n };
const ct = encryptNote(note, a.encPub);
assert.equal((ct.length - 2) / 2, NOTE_CIPHERTEXT_BYTES);
assert.deepEqual(decryptNote(ct, a.encSecret), note);
assert.equal(decryptNote(ct, b.encSecret), null, 'foreign key cannot open');
const tampered = ct.slice(0, -2) + (ct.endsWith('00') ? '01' : '00');
assert.equal(decryptNote(tampered, a.encSecret), null, 'AEAD rejects tampering');
assert.equal(decryptNote('0x01', a.encSecret), null, 'malformed input');
// Grumpkin vectors from Noir's fixed_base_scalar_mul / multi_scalar_mul (beta.22).
assert.deepEqual(mul(2n), [0x06ce1b0827aafa85ddeb49cdaa36306d19a74caa311e13d46d8bc688cdbffffen, 0x1c122f81a3a14964909ede0ba2a6855fc93faf6fa1a788bf467be7e7a43f80acn]);
assert.deepEqual(mul(3n), [0x2941b0928df1b9480273773b36397da3e495430a2a7a3857661bc7a446c94f4dn, 0x13ae7e938c892308bef0f45ee7386daa2d3b447349a7d0a11b5aa4cfbe69072cn]);
assert.deepEqual(mul(2n, mul(3n)), [0x1136be4fd725da12b061e315eaadf48e38656fb0f6aa00ae3984454ca590471an, 0x27e08c4b441fb4e4e03c96c677893a680c8bddfe0fbd218e8cbba9ab91c15278n]);
assert.deepEqual(mul(1n), G);
const opSk = 0x1234567890abcdefn;
const values = [10n ** 19n, 5n * 10n ** 8n, a.owner, FIELD - 7n];
const enc = operatorEncrypt(values, operatorPublicKey(opSk));
assert.deepEqual(operatorDecrypt(opSk, enc.eph, enc.cipher), values, 'operator opens the position');
assert.notDeepEqual(operatorDecrypt(opSk + 1n, enc.eph, enc.cipher), values, 'other key cannot');
// operator_r = 0 is provable: Noir returns infinity as (0, 0) for eph and the shared point (checked
// against circuits/position with noir_js). The operator must still open it, or every epoch halts.
const enc0 = operatorEncrypt(values, operatorPublicKey(opSk), 0n);
assert.deepEqual(enc0.eph, [0n, 0n]);
assert.deepEqual(operatorDecrypt(opSk, enc0.eph, enc0.cipher), values, 'operator opens an r = 0 position');
assert.deepEqual(mul(0n), [0n, 0n]);

// Owner follows a liquidation from the masked amounts.
const pos = { asset: 0xb5n, collateral: 10n * 10n ** 18n, debtScaled: 900_000000n * 10n ** 18n / 10n ** 18n, owner: a.owner, blinding: 99n };
const hexw = (x) => x.toString(16).padStart(64, '0');
const after = applyLiquidation(pos, '0x' + hexw((3n * 10n ** 18n + liquidationPad(99n, 1)) % FIELD) + hexw((400_000000n + liquidationPad(99n, 2)) % FIELD));
assert.equal(after.collateral, 7n * 10n ** 18n);
assert.equal(after.debtScaled, 500_000000n);
assert.equal(after.blinding, liquidatedBlinding(99n));

// Health witness: exactly the breached slot is flagged; sums floor/ceil.
const cls = [{ asset: 0xb5n, mark: 120_00000000n, liqBps: 5500 }];
const healthy = { ...pos, debtScaled: 600_000000n }; // value 1200, limit 660
const breached = { ...pos, debtScaled: 700_000000n, blinding: 5n };
const h = buildHealth({ positions: [healthy, null, breached, ...Array(61).fill(null)], classes: cls, rateIndex: 10n ** 18n, salt: 1n });
assert.deepEqual(h.breached, [2]);
assert.equal(h.bitmap, 4n);
assert.equal(h.public.sumValue, 2400_000000n);
assert.equal(h.public.sumDebt, 1300_000000n);
assert.ok(isBreached(breached, 120_00000000n, 5500, 10n ** 18n) && !isBreached(healthy, 120_00000000n, 5500, 10n ** 18n));
assert.equal(h.witness.leaves[2], positionCommitment(breached).toString());
// Treasury ledgers: key shares open only for the member; config opens with the ledger key.
const lk = ledgerKeys(0xabcn);
assert.equal(decryptKeyShare(encryptKeyShare(0xabcn, a.encPub), a.encSecret), 0xabcn);
assert.equal(decryptKeyShare(encryptKeyShare(0xabcn, a.encPub), b.encSecret), null);
const config = { name: 'Ops treasury', owner: a.owner, treasurer: b.owner, payer: a.owner, auditor: b.owner, rolesSalt: 1n, allocCap: 5n, dualThreshold: 6n, policySalt: 7n };
const unscoped = { budget: 0n, budgetPeriod: 0n, budgetStart: 0n, allow: Array(8).fill(0n), allowPubs: Array(8).fill(null) };
assert.deepEqual(decryptConfig(encryptConfig(config, lk.encPub), lk.encSecret), { ...config, ...unscoped });
assert.equal(policyHash(config), policyHash({ ...config, ...unscoped }), 'no scope is the default');
// v3.4 Payer scope: the config round-trips, and the scope changes the policy hash.
{
  const vendor = '0x' + '11'.repeat(20);
  const scoped = { ...config, allow: [b.owner, BigInt(vendor), 0n, 0n, 0n, 0n, 0n, 0n], allowPubs: [b.encPub, null, null, null, null, null, null, null], budget: 120_000000n, budgetPeriod: 86_400n, budgetStart: 1_790_000_000n };
  assert.deepEqual(decryptConfig(encryptConfig(scoped, lk.encPub), lk.encSecret), scoped);
  assert.notEqual(policyHash(scoped), policyHash(config));
  assert.equal(allowHash(Array(8).fill(0n)), 0n, 'an empty list is no restriction');
  assert.ok(payerScoped(scoped) && !payerScoped(config));
  assert.equal(budgetWindow(scoped, 1_790_000_000n + 86_399n), 0n);
  assert.equal(budgetWindow(scoped, 1_790_000_000n + 86_400n), 1n);
  assert.throws(() => budgetWindow(scoped, 1_789_999_999n), /not started/);

  // The accumulator a transfer publishes opens for members, and only with the ledger secret.
  const tree = new LeanIMT((x, y) => hash2(x, y));
  const L = { ...ledgerKeys(0xabcn), config: { ...scoped, payer: a.owner, dualThreshold: 500_000000n } };
  const note = { asset: 0xa55e7n, amount: 1000_000000n, owner: L.owner, blinding: 9n };
  tree.insert((await import('./notes.js')).noteCommitment(note));
  const pay = (o) => buildLedger({ tree, ledger: L, sk: deriveKeys(sig).sk, role: 'Payer', action: ACTIONS.transfer, asset: 0xa55e7n, inputs: [{ ...note, leafIndex: 0 }], out: { amount: 60_000000n, owner: b.owner }, t: 1_790_000_100n, ...o, ext: { encryptedOutput1: '0x', encryptedOutput2: '0x', ...o.ext } });
  const built = pay({});
  assert.equal(built.spent, 60_000000n);
  const opened = openBudget(L.lsk, { commit: built.public.budgetNew, nonce: built.public.inputNullifiers[0], ct: built.public.budgetCt });
  assert.deepEqual([opened.window, opened.spent], [0n, 60_000000n]);
  assert.equal(openBudget(0xdefn, { commit: built.public.budgetNew, nonce: built.public.inputNullifiers[0], ct: built.public.budgetCt }), null, 'another key cannot open it');
  L.budget = opened;
  assert.equal(payerSpent(L, 1_790_000_100n), 60_000000n);
  assert.equal(payerSpent(L, 1_790_086_400n), 0n, 'a new window starts at zero');
  // Friendly checks before proving (the circuit enforces the same; see circuits/ledger tests).
  assert.throws(() => pay({ out: { amount: 61_000000n, owner: b.owner } }), /over the treasury budget/);
  assert.throws(() => pay({ out: { amount: 1n, owner: ownerPk(0x5n) } }), /not on the treasury's list/);
  assert.throws(() => pay({ out: { amount: 0n, owner: L.owner }, ext: { recipient: '0x' + '22'.repeat(20), extAmount: -1n } }), /not on the treasury's list/);
  assert.equal(pay({ out: { amount: 0n, owner: L.owner }, ext: { recipient: vendor, extAmount: -60_000000n } }).spent, 120_000000n, 'a listed address');
  assert.equal(pay({ t: 1_790_086_500n, out: { amount: 100_000000n, owner: b.owner } }).spent, 100_000000n, 'the next window');
  assert.throws(() => buildMandateAuth({ ledger: L, sk: deriveKeys(sig).sk, role: 'Payer', action: MANDATE_ACTIONS.commit, mandate: { kind: 0n, recipient: 1n, asset: 0xa55e7n, cap: 1n, period: 0n, start: 0n, expiry: 1n, reference: 0n, salt: 1n } }), /can only pause mandates/);
}
assert.deepEqual(heldRoles(config, a.owner), ['Owner', 'Payer']);
assert.notEqual(lk.owner, ownerPk(0xabcn), 'ledger notes live outside the personal owner domain');
// Passkey keys: same seed, same keys; the chain and the "passkey" label separate them.
{
  const seed = '0x' + '7f'.repeat(32);
  assert.equal(passkeyKeys(seed, 4663).sk, passkeyKeys(seed, 4663).sk, 'deterministic');
  assert.notEqual(passkeyKeys(seed, 4663).sk, passkeyKeys(seed, 46630).sk, 'mainnet and testnet keys differ');
  assert.notEqual(passkeyKeys(seed, 4663).sk, deriveKeys(seed).sk, 'passkey keys differ from signature keys');
  // Recovery words: BIP-39 English vectors (Trezor), and the round trip back to the same keys.
  assert.equal(seedWords('0x' + '00'.repeat(32)).join(' '), 'abandon '.repeat(23) + 'art');
  const words = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
  assert.equal(seedWords(seed).join(' '), words);
  assert.equal(wordsSeed(`  ${words.toUpperCase().replaceAll(' ', '\n ')} `), seed, 'case and spacing do not matter');
  assert.equal(passkeyKeys(wordsSeed(words), 4663).owner, passkeyKeys(seed, 4663).owner);
  assert.equal(wordsSeed(words.replace(/title$/, 'wave')), null, 'a wrong checksum word is rejected');
  assert.equal(wordsSeed(words.replace(/^legal/, 'legall')), null, 'an unknown word is rejected');
  assert.equal(wordsSeed('legal winner'), null, 'too few words are rejected');
}
// v3.18 spending report: the change note may carry who was paid; both sizes open.
{
  const n = { asset: 0xa55e7n, amount: 5n, blinding: 9n };
  assert.deepEqual(decryptNote(encryptNote(n, a.encPub), a.encSecret), n, 'a note without memo');
  const toZk = decryptNote(encryptNote(n, a.encPub, { owner: b.owner, encPub: b.encPub }), a.encSecret);
  assert.deepEqual([toZk.amount, toZk.memo.owner, [...toZk.memo.encPub]], [5n, b.owner, [...b.encPub]]);
  const vendor = '0x' + '3c'.repeat(20);
  const ct = encryptNote(n, a.encPub, vendor);
  assert.equal((ct.length - 2) / 2, NOTE_MEMO_CIPHERTEXT_BYTES);
  assert.equal(decryptNote(ct, a.encSecret).memo, vendor);
  assert.equal(decryptNote(ct, b.encSecret), null, 'only the ledger key opens it');

  // Attribution from the spending record: +60 (Payer), +0 (Owner), +50 (Payer), reset, +10, next window +5.
  const lsk = 0xabcn;
  const L = ledgerKeys(lsk);
  let i = 0;
  const note = (window, spent) => { const nonce = BigInt(++i); return { commit: budgetCommit(L.owner, window, spent, budgetPad(lsk, nonce, 2)), nonce, ct: [window + budgetPad(lsk, nonce, 0), spent + budgetPad(lsk, nonce, 1)], tx: `t${i}` }; };
  const history = [note(0n, 60n), note(0n, 60n), note(0n, 110n), { commit: 0n, nonce: 0n, ct: [0n, 0n] }, note(0n, 10n), note(1n, 5n)];
  assert.deepEqual(payerDeltas(lsk, history).map((x) => [x.note.tx, x.delta]), [['t1', 60n], ['t2', 0n], ['t3', 50n], ['t4', 10n], ['t5', 5n]]);
  assert.deepEqual(payerDeltas(0xdefn, history), [], 'another key opens none');
}
// The report rows (src/lib/zk/report.js): attribution, proven and recorded recipients, decoy calls, a
// rotated Payer, an approved request, an unshield.
{
  const { paymentRows, verifiedCall } = await import('./report.js');
  const { encryptConfig } = await import('./crypto.js');
  const { noteCommitment } = await import('./notes.js');
  const { zkAddress } = await import('./keys.js');
  const lsk = 0x5eedn;
  const K = ledgerKeys(lsk);
  const USD = 0xa55e7n;
  const LEDGER = '0x' + '1e'.repeat(20);
  const [P, Q, B, C] = [deriveKeys('0x' + '01'.repeat(65)), deriveKeys('0x' + '02'.repeat(65)), deriveKeys('0x' + '03'.repeat(65)), deriveKeys('0x' + '04'.repeat(65))];
  const cfg = (payer) => ({ name: 'T', owner: a.owner, treasurer: b.owner, payer: payer.owner, auditor: b.owner, rolesSalt: 1n, allocCap: 5n, dualThreshold: 100n, policySalt: 2n });
  const events = [];
  const notes = [];
  const cts = new Map();
  const calls = new Map();
  let spent = 0n;
  let bal = { amount: 1000n, blinding: 11n };
  let i = 0;
  const config = (payer) => events.push({ id: K.owner, name: 'LedgerConfig', config: encryptConfig(cfg(payer), K.encPub) });
  // One transfer: the ledger's note in, change out, an accumulator note; byPayer raises it. pub: the part
  // unshielded to `unshield` (default: all of it when unshield is set). hidden: spend a note the other
  // members never saw (a Payer that posted an unreadable change ciphertext earlier).
  function transfer({ amount, to, unshield, pub = unshield ? amount : 0n, byPayer = false, cosign = 0n, memo = 'real', decoy = false, hidden = null, noCall = false, fakeEmpty = false }) {
    const tx = `t${++i}`;
    const nonce = BigInt(1000 + i);
    const input = hidden ?? bal;
    if (!hidden) notes.push({ asset: USD, amount: input.amount, blinding: input.blinding, spentIn: tx });
    const change = { asset: USD, amount: input.amount - amount, blinding: BigInt(50 + i) };
    const blind2 = BigInt(90 + i);
    const priv = amount - pub;
    const out2 = noteCommitment({ asset: USD, amount: priv, owner: priv > 0n ? to.owner : K.owner, blinding: blind2 });
    const m = priv === 0n && unshield ? unshield : memo === 'real' ? { owner: to.owner, encPub: to.encPub, blinding: blind2 } : memo === 'lie' ? { owner: C.owner, encPub: C.encPub, blinding: blind2 } : undefined;
    const changeCommitment = noteCommitment({ ...change, owner: K.owner });
    // Output 2: the payment, or, for a pure unshield, the ledger's own empty note (the app's shape).
    const second = priv === 0n && !fakeEmpty ? [{ commitment: out2, ciphertext: encryptNote({ asset: USD, amount: 0n, blinding: blind2 }, K.encPub) }] : [];
    cts.set(tx, [{ commitment: changeCommitment, ciphertext: encryptNote(change, K.encPub, m) }, ...second]);
    if (!hidden) bal = { amount: change.amount, blinding: change.blinding };
    if (byPayer) spent += amount;
    const commit = budgetCommit(K.owner, 0n, spent, budgetPad(lsk, nonce, 2));
    events.push({ id: K.owner, name: 'BudgetNote', commit, nonce, ct: [budgetPad(lsk, nonce, 0), spent + budgetPad(lsk, nonce, 1)], tx, block: BigInt(i) });
    if (!noCall) calls.set(tx, { to: decoy ? '0x' + 'de'.repeat(20) : LEDGER, args: [{ ledgerId: K.owner, asset: USD, inputNullifiers: [nonce, 0n], budgetNew: commit, cosignIntent: cosign, outputCommitments: [changeCommitment, out2] }, { recipient: unshield ?? '0x0000000000000000000000000000000000000000', extAmount: -pub }] });
    return tx;
  }
  config(P);
  transfer({ amount: 60n, to: B, byPayer: true }); // t1: the first Payer pays B (proven)
  transfer({ amount: 100n, unshield: '0x' + '3c'.repeat(20) }); // t2: the Owner unshields to a vendor
  transfer({ amount: 200n, to: B, cosign: 77n }); // t3: an approved transfer the Payer asked for
  transfer({ amount: 5n, to: B, byPayer: true, decoy: true }); // t4: read through a decoy contract call
  transfer({ amount: 7n, to: B, byPayer: true, memo: 'lie' }); // t5: the memo names someone else
  config(Q);
  transfer({ amount: 10n, to: B, byPayer: true, memo: 'none' }); // t6: the new Payer, an old-style note
  // t7: from a note only it can read, the Payer unshields 1 to a vendor and pays B 500: the record's 501 is
  // the amount, the 500 is still shown, and the unreadable note is flagged.
  transfer({ amount: 501n, to: B, unshield: '0x' + '3c'.repeat(20), pub: 1n, byPayer: true, hidden: { amount: 1000n, blinding: 7777n } });
  transfer({ amount: 3n, to: B, noCall: true }); // t8: a member payment whose call cannot be read
  // t9: a member unshields 100 and, from a note only it can read, sends 1000 privately elsewhere: the
  // readable notes show only the 100, so output 2 must be the ledger's empty note for the row to be complete.
  transfer({ amount: 100n, unshield: '0x' + '3c'.repeat(20), hidden: { amount: 100n, blinding: 8888n }, fakeEmpty: true });
  const rows = paymentRows({ ledger: { ...K, config: cfg(Q) }, events, notes, ciphertextsByTx: cts, calls, intentsFrom: new Map([[77n, Q.owner]]), ledgerAddress: LEDGER });
  const view = rows.map((r) => [r.tx, r.by, r.amount, r.toSource]);
  assert.deepEqual(view, [
    ['t1', 'former payer', 60n, 'chain'], ['t2', 'member', 100n, 'chain'], ['t3', 'approved', 200n, 'chain'],
    ['t4', 'former payer', 5n, 'paying app'], ['t5', 'former payer', 7n, 'paying app'], ['t6', 'payer', 10n, null],
    ['t7', 'payer', 501n, 'chain'], ['t8', 'unknown', 3n, 'paying app'], ['t9', 'member', 100n, null],
  ]);
  assert.equal(rows[8].to, `${'0x' + '3c'.repeat(20)} + a private recipient`, 'a possibly hidden private part is named');
  assert.equal(rows[8].mismatch, true);
  assert.equal(rows[1].mismatch, false, 'an honest unshield stays complete');
  assert.equal(rows[6].to, `${'0x' + '3c'.repeat(20)} + ${zkAddress(B)}`, 'both parts of a mixed payment');
  assert.equal(rows[6].mismatch, true, 'an unreadable input is flagged');
  assert.equal(rows[0].mismatch, false);
  assert.equal(rows[0].toOwner, B.owner);
  assert.equal(rows[0].to, zkAddress(B));
  assert.equal(rows[1].to, '0x' + '3c'.repeat(20));
  assert.equal(rows[2].requestedByPayer, true, 'the current Payer asked for the approved one');
  assert.equal(rows[4].to, zkAddress(C), 'a false memo is shown, but only as recorded');
  assert.equal(verifiedCall(calls.get('t4'), events.find((e) => e.tx === 't4'), LEDGER), null, 'a call not sent to the ledger is ignored');
  assert.equal(verifiedCall({ ...calls.get('t1'), args: [{ ...calls.get('t1').args[0], budgetNew: 1n }, calls.get('t1').args[1]] }, events.find((e) => e.tx === 't1'), LEDGER), null, 'nor one for another accumulator');
  // A memo key at or above the field (it would alias a smaller key in a commitment), or an address above
  // 160 bits, is dropped; the note still opens.
  const n1 = { asset: USD, amount: 1n, blinding: 2n };
  assert.equal(decryptNote(encryptNote(n1, K.encPub, '0x' + 'ff'.repeat(20)), K.encSecret).memo, '0x' + 'ff'.repeat(20));
  assert.deepEqual(decryptNote(encryptNote(n1, K.encPub, '0x' + 'ff'.repeat(21)), K.encSecret), n1);
  const { FIELD: P_ } = await import('./notes.js');
  assert.deepEqual(decryptNote(encryptNote(n1, K.encPub, { owner: B.owner + P_, encPub: B.encPub, blinding: 1n }), K.encSecret), n1);
}
// v3.19: a treasury read with its view key alone, and approval requests that must show their transfer.
{
  const { ledgerFromSecret, myLedgers } = await import('./wallet.js');
  const { requestShowsItsTransfer, rolesOf: rolesCommitOf } = await import('./ledger.js');
  const { encryptConfig, encryptKeyShare } = await import('./crypto.js');
  const lsk = 0x77n;
  const K = ledgerKeys(lsk);
  const cfg = { name: 'View', owner: a.owner, treasurer: b.owner, payer: b.owner, auditor: b.owner, rolesSalt: 3n, allocCap: 9n, dualThreshold: 4n, policySalt: 5n };
  const st = { ledgerEvents: [
    { id: K.owner, name: 'LedgerCreated', rolesCommit: rolesCommitOf(cfg), policyHash: policyHash(cfg) },
    { id: K.owner, name: 'KeyShare', share: encryptKeyShare(lsk, a.encPub) },
    { id: K.owner, name: 'LedgerConfig', config: encryptConfig(cfg, K.encPub) },
  ] };
  const viewed = ledgerFromSecret(st, lsk);
  const member = myLedgers(st, a)[0];
  assert.equal(viewed.name, 'View');
  assert.deepEqual(viewed.roles, [], 'a view key holds no role');
  assert.deepEqual(member.roles, ['Owner']);
  assert.equal(viewed.owner, member.owner);
  assert.equal(ledgerFromSecret(st, 0x78n), null, 'another secret finds nothing');
  // Requests: an unshield must display exactly its ext data; a private payment carries no ext.
  const vendor = '0x' + '3c'.repeat(20);
  assert.equal(requestShowsItsTransfer({ amount: 200n, recipient: vendor, ext: { recipient: vendor, extAmount: -200n } }), true);
  assert.equal(requestShowsItsTransfer({ amount: 200n, recipient: vendor, ext: { recipient: '0x' + 'ee'.repeat(20), extAmount: -200n } }), false, 'another recipient');
  assert.equal(requestShowsItsTransfer({ amount: 200n, recipient: vendor, ext: { recipient: vendor, extAmount: -50000n } }), false, 'another amount');
  assert.equal(requestShowsItsTransfer({ amount: 5n, to: { owner: 1n }, ext: { recipient: '0x0000000000000000000000000000000000000000', extAmount: 0n } }), true);
  assert.equal(requestShowsItsTransfer({ amount: 5n, to: { owner: 1n }, ext: { recipient: vendor, extAmount: -5n } }), false, 'a private request that also unshields');
  assert.equal(requestShowsItsTransfer({ amount: 0n, recipient: vendor, ext: { recipient: vendor, extAmount: 0n } }), false);
  assert.equal(requestShowsItsTransfer({ amount: 'x', recipient: vendor, ext: {} }), false, 'malformed');
}
console.log('zk primitives passed: poseidon vector, public amount, key derivation (signature and passkey, recovery words), note encryption, grumpkin + operator encryption, liquidation replay, health witness, ledger key shares/config/roles, Payer scope and spending accumulator.');
