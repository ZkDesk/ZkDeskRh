// Payload encryption: X25519 ECDH + XChaCha20-Poly1305. Ciphertexts are posted on-chain in
// events; only the recipient's encryption key can open them.
// Layout: ephPub(32) | viewTag(1) | nonce(24) | sealed(plaintext | tag 16)
//   note     plaintext: asset 20 | amount 16 | blinding 32
//   position plaintext: asset 20 | collateral 16 | debtScaled 16 | blinding 32
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

const enc = new TextEncoder();
const OVERHEAD = 32 + 1 + 24 + 16;
const NOTE_FIELDS = [['asset', 20], ['amount', 16], ['blinding', 32]];
const POSITION_FIELDS = [['asset', 20], ['collateral', 16], ['debtScaled', 16], ['blinding', 32]];
const size = (fields) => fields.reduce((s, [, n]) => s + n, 0);
export const NOTE_CIPHERTEXT_BYTES = OVERHEAD + size(NOTE_FIELDS);
export const POSITION_CIPHERTEXT_BYTES = OVERHEAD + size(POSITION_FIELDS);

const toBytes = (x, n) => hexToBytes(BigInt(x).toString(16).padStart(n * 2, '0'));
const toBig = (b) => BigInt('0x' + bytesToHex(b));
const shared = (secret, pub) => {
  const s = x25519.getSharedSecret(secret, pub);
  return { key: hkdf(sha256, s, undefined, enc.encode('ZKD.note.key'), 32), tag: hkdf(sha256, s, undefined, enc.encode('ZKD.note.tag'), 1)[0] };
};

export const encPublicKey = (encSecret) => x25519.getPublicKey(encSecret);

function seal(fields, value, recipientEncPub) {
  const eph = x25519.utils.randomSecretKey();
  const { key, tag } = shared(eph, recipientEncPub);
  const nonce = randomBytes(24);
  const plain = new Uint8Array(fields.flatMap(([k, n]) => [...toBytes(value[k], n)]));
  const sealed = xchacha20poly1305(key, nonce).encrypt(plain);
  return '0x' + bytesToHex(new Uint8Array([...x25519.getPublicKey(eph), tag, ...nonce, ...sealed]));
}

function open(fields, ciphertextHex, encSecret) {
  const c = hexToBytes(ciphertextHex.replace(/^0x/, ''));
  if (c.length !== OVERHEAD + size(fields)) return null;
  const { key, tag } = shared(encSecret, c.slice(0, 32));
  if (c[32] !== tag) return null; // view tag: skips ~255/256 foreign payloads without AEAD work
  try {
    const p = xchacha20poly1305(key, c.slice(33, 57)).decrypt(c.slice(57));
    const out = {};
    let at = 0;
    for (const [k, n] of fields) { out[k] = toBig(p.slice(at, at + n)); at += n; }
    return out;
  } catch {
    return null;
  }
}

/** note: {asset, amount, blinding}. Returns 0x-hex ciphertext. */
export const encryptNote = (note, recipientEncPub) => seal(NOTE_FIELDS, note, recipientEncPub);
/** Returns {asset, amount, blinding} or null if the note is not ours. */
export const decryptNote = (ciphertextHex, encSecret) => open(NOTE_FIELDS, ciphertextHex, encSecret);
/** position: {asset, collateral, debtScaled, blinding}. Encrypted to the owner's own key. */
export const encryptPosition = (position, encPub) => seal(POSITION_FIELDS, position, encPub);
export const decryptPosition = (ciphertextHex, encSecret) => open(POSITION_FIELDS, ciphertextHex, encSecret);

// Treasury ledgers. A key share gives one role member the ledger secret; the config (role keys,
// policy and their salts, a display name) is encrypted to the ledger's own key, so every member
// with the secret can prove and read. Both are posted on-chain by TreasuryLedger.
const SHARE_FIELDS = [['lsk', 32]];
const CONFIG_FIELDS = [['name', 32], ['owner', 32], ['treasurer', 32], ['payer', 32], ['auditor', 32], ['rolesSalt', 32], ['allocCap', 16], ['dualThreshold', 16], ['policySalt', 32]];
export const KEY_SHARE_BYTES = OVERHEAD + size(SHARE_FIELDS);
export const CONFIG_BYTES = OVERHEAD + size(CONFIG_FIELDS);
export const encryptKeyShare = (lsk, memberEncPub) => seal(SHARE_FIELDS, { lsk }, memberEncPub);
export const decryptKeyShare = (ciphertextHex, encSecret) => open(SHARE_FIELDS, ciphertextHex, encSecret)?.lsk ?? null;
const nameToBig = (name) => BigInt('0x' + (bytesToHex(enc.encode(name).slice(0, 32)) || '0'));
const bigToName = (x) => { const h = x.toString(16); return new TextDecoder().decode(hexToBytes(h.length % 2 ? `0${h}` : h)); };
export const encryptConfig = (config, ledgerEncPub) => seal(CONFIG_FIELDS, { ...config, name: nameToBig(config.name) }, ledgerEncPub);
export function decryptConfig(ciphertextHex, ledgerEncSecret) {
  const c = open(CONFIG_FIELDS, ciphertextHex, ledgerEncSecret);
  return c && { ...c, name: c.name ? bigToName(c.name) : '' };
}

// Payment mandates: the full mandate (plus the recipient's encryption key and a display label) is
// encrypted to the ledger key, so every member can see and pay it.
const MANDATE_FIELDS = [['kind', 1], ['recipient', 32], ['recipientEncPub', 32], ['asset', 20], ['cap', 16], ['period', 8], ['start', 8], ['expiry', 8], ['reference', 32], ['salt', 32], ['label', 32]];
export const MANDATE_BYTES = OVERHEAD + size(MANDATE_FIELDS);
const bytesToBig = (b) => BigInt('0x' + (bytesToHex(b) || '0'));
export const encryptMandate = (m, ledgerEncPub) => seal(MANDATE_FIELDS, { ...m, recipientEncPub: bytesToBig(m.recipientEncPub), label: nameToBig(m.label ?? '') }, ledgerEncPub);
export function decryptMandate(ciphertextHex, ledgerEncSecret) {
  const m = open(MANDATE_FIELDS, ciphertextHex, ledgerEncSecret);
  return m && { ...m, recipientEncPub: toBytes(m.recipientEncPub, 32), label: m.label ? bigToName(m.label) : '' };
}
/** Short text (at most 31 bytes, so it is a field element): invoice references are hashed into mandates. */
export const textToField = (text) => bytesToBig(enc.encode(text).slice(0, 31));

// Treasury approval requests: sealed with a key derived from the ledger secret (not a public key),
// so only members can create or read one; the AEAD tag is the membership check. Bigints survive
// as "n:<decimal>" strings.
const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `n:${x}` : x instanceof Uint8Array ? `b:${bytesToHex(x)}` : x));
const fromJson = (t) => JSON.parse(t, (_, x) => (typeof x === 'string' && /^n:-?\d+$/.test(x) ? BigInt(x.slice(2)) : typeof x === 'string' && /^b:[0-9a-f]*$/.test(x) ? hexToBytes(x.slice(2)) : x));
export function sealRequest(value, key) {
  const nonce = randomBytes(24);
  return '0x' + bytesToHex(new Uint8Array([...nonce, ...xchacha20poly1305(key, nonce).encrypt(enc.encode(toJson(value)))]));
}
export function openRequest(hex, key) {
  try {
    const c = hexToBytes(hex.replace(/^0x/, ''));
    return fromJson(new TextDecoder().decode(xchacha20poly1305(key, c.slice(0, 24)).decrypt(c.slice(24))));
  } catch {
    return null;
  }
}
