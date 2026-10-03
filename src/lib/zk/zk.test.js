// node src/lib/zk/zk.test.js — primitives shared with circuits/lib (Noir) and ZKDeskPool (Solidity).
import assert from 'node:assert/strict';
import { hash2, publicAmount, FIELD } from './notes.js';
import { decryptNote, encryptNote, NOTE_CIPHERTEXT_BYTES } from './crypto.js';
import { canonicalSignature, deriveKeys, passkeyKeys, seedWords, wordsSeed } from './keys.js';
import { G, mul, operatorDecrypt, operatorEncrypt, operatorPublicKey } from './grumpkin.js';
import { applyLiquidation, buildHealth, isBreached } from './desk.js';
import { liquidatedBlinding, liquidationPad, positionCommitment, ownerPk } from './notes.js';
import { decryptConfig, decryptKeyShare, encryptConfig, encryptKeyShare } from './crypto.js';
import { ACTIONS, buildLedger, budgetWindow, heldRoles, ledgerKeys, openBudget, payerScoped, payerSpent } from './ledger.js';
import { buildMandateAuth, MANDATE_ACTIONS } from './mandate.js';
import { allowHash, policyHash } from './notes.js';
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
console.log('zk primitives passed: poseidon vector, public amount, key derivation (signature and passkey, recovery words), note encryption, grumpkin + operator encryption, liquidation replay, health witness, ledger key shares/config/roles, Payer scope and spending accumulator.');
