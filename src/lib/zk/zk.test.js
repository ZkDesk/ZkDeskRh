// node src/lib/zk/zk.test.js — primitives shared with circuits/lib (Noir) and ZKDeskPool (Solidity).
import assert from 'node:assert/strict';
import { hash2, publicAmount, FIELD } from './notes.js';
import { decryptNote, encryptNote, NOTE_CIPHERTEXT_BYTES } from './crypto.js';
import { deriveKeys } from './keys.js';
import { G, mul, operatorDecrypt, operatorEncrypt, operatorPublicKey } from './grumpkin.js';
import { applyLiquidation, buildHealth, isBreached } from './desk.js';
import { liquidatedBlinding, liquidationPad, positionCommitment, ownerPk } from './notes.js';
import { decryptConfig, decryptKeyShare, encryptConfig, encryptKeyShare } from './crypto.js';
import { heldRoles, ledgerKeys } from './ledger.js';

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
assert.deepEqual(decryptConfig(encryptConfig(config, lk.encPub), lk.encSecret), config);
assert.deepEqual(heldRoles(config, a.owner), ['Owner', 'Payer']);
assert.notEqual(lk.owner, ownerPk(0xabcn), 'ledger notes live outside the personal owner domain');
console.log('zk primitives passed: poseidon vector, public amount, key derivation, note encryption, grumpkin + operator encryption, liquidation replay, health witness, ledger key shares/config/roles.');
