// ZKDesk keys derive from one deterministic wallet signature (EOA/RFC 6979) or from a passkey's
// WebAuthn PRF output. Nothing is stored: re-signing the same message, or unlocking the same passkey,
// restores the same keys. Smart-contract wallets are unsupported.
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { english } from 'viem/accounts';
import { FIELD, nullifierKey, ownerPk } from './notes.js';
import { encPublicKey } from './crypto.js';

const enc = new TextEncoder();

/** EIP-712 payload the wallet signs (eth_signTypedData_v4). */
export const keyRequest = (chainId) => ({
  domain: { name: 'ZKDesk', version: '1', chainId },
  types: { KeyRequest: [{ name: 'purpose', type: 'string' }] },
  primaryType: 'KeyRequest',
  message: { purpose: 'Unlock my ZKDesk private notes. This signature never leaves this device and costs no gas.' },
});

// secp256k1 group order: a signature (r, s) and (r, n - s) are both valid, and wallets report the
// recovery id as 0/1 or 27/28. Keys derive from the canonical form (low s, v = 27/28) so every wallet
// encoding of the same signature gives the same keys; canonical signatures are unchanged by this.
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export function canonicalSignature(signatureHex) {
  const hex = signatureHex.replace(/^0x/, '');
  if (hex.length !== 130) return hex;
  let s = BigInt('0x' + hex.slice(64, 128));
  let v = parseInt(hex.slice(128), 16);
  if (v < 27) v += 27;
  if (s > N / 2n) {
    s = N - s;
    v = v === 27 ? 28 : 27;
  }
  return hex.slice(0, 64) + s.toString(16).padStart(64, '0') + v.toString(16).padStart(2, '0');
}

/** Keys from a wallet's key-request signature (any encoding of it gives the same keys). */
export const deriveKeys = (signatureHex) => seedKeys('0x' + canonicalSignature(signatureHex));

/**
 * Keys from a passkey's 32-byte PRF output (or the same bytes restored from the recovery key). The
 * chain is in the HKDF salt, so one passkey holds separate mainnet and testnet keys, as the EIP-712
 * domain separates signature keys; the "passkey" label keeps them apart from signature keys.
 */
export const passkeyKeys = (seedHex, chainId) => seedKeys(seedHex, `ZKDesk passkey v1 ${chainId}`);

/** Keys of an AI agent's account (agent/): a random 32-byte seed its operator keeps, one account per chain. */
export const agentKeys = (seedHex, chainId) => seedKeys(seedHex, `ZKDesk agent v1 ${chainId}`);

/** A private address: zkd: + owner key (32 bytes) + encryption key (32 bytes), hex. */
export const zkAddress = (keys) => `zkd:${keys.owner.toString(16).padStart(64, '0')}${[...keys.encPub].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
export function parseZkAddress(value) {
  const m = /^zkd:([0-9a-f]{64})([0-9a-f]{64})$/i.exec((value || '').trim());
  if (!m) return null;
  return { owner: BigInt('0x' + m[1]), encPub: Uint8Array.from(m[2].match(/../g).map((b) => parseInt(b, 16))) };
}

/** Keys from raw seed bytes as given: a service seed that is not a wallet signature (the scheduler's). */
export function seedKeys(seedHex, label = 'ZKDesk key v1') {
  const ikm = hexToBytes(seedHex.replace(/^0x/, ''));
  const salt = enc.encode(label);
  // 48 bytes -> reduce mod FIELD so the bias is negligible (< 2^-128).
  const sk = BigInt('0x' + bytesToHex(hkdf(sha256, ikm, salt, enc.encode('spend'), 48))) % FIELD;
  const encSecret = hkdf(sha256, ikm, salt, enc.encode('encrypt'), 32);
  return { sk, owner: ownerPk(sk), nk: nullifierKey(sk), encSecret, encPub: encPublicKey(encSecret) };
}

// Recovery key: the passkey seed as 24 BIP-39 English words (256 bits + an 8-bit SHA-256 checksum).
/** 32-byte seed (hex) -> 24 words. */
export function seedWords(seedHex) {
  const bytes = hexToBytes(seedHex.replace(/^0x/, ''));
  if (bytes.length !== 32) throw new Error('A recovery key holds 32 bytes.');
  const bits = [...bytes, sha256(bytes)[0]].map((b) => b.toString(2).padStart(8, '0')).join('');
  return bits.match(/.{11}/g).map((w) => english[parseInt(w, 2)]);
}
/** 24 words (any spacing or case) -> 32-byte seed (hex), or null if a word or the checksum is wrong. */
export function wordsSeed(text) {
  const words = String(text).trim().toLowerCase().split(/\s+/);
  const index = words.map((w) => english.indexOf(w));
  if (words.length !== 24 || index.includes(-1)) return null;
  const bits = index.map((i) => i.toString(2).padStart(11, '0')).join('');
  const bytes = Uint8Array.from(bits.slice(0, 256).match(/.{8}/g), (b) => parseInt(b, 2));
  return sha256(bytes)[0] === parseInt(bits.slice(256), 2) ? '0x' + bytesToHex(bytes) : null;
}
