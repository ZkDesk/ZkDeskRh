// ZKDesk keys derive from one deterministic wallet signature (EOA/RFC 6979). Nothing is stored:
// re-signing the same message restores the same keys. Smart-contract wallets are unsupported.
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
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

/** Keys from raw seed bytes as given: a service seed that is not a wallet signature (the scheduler's). */
export function seedKeys(seedHex) {
  const ikm = hexToBytes(seedHex.replace(/^0x/, ''));
  const salt = enc.encode('ZKDesk key v1');
  // 48 bytes -> reduce mod FIELD so the bias is negligible (< 2^-128).
  const sk = BigInt('0x' + bytesToHex(hkdf(sha256, ikm, salt, enc.encode('spend'), 48))) % FIELD;
  const encSecret = hkdf(sha256, ikm, salt, enc.encode('encrypt'), 32);
  return { sk, owner: ownerPk(sk), nk: nullifierKey(sk), encSecret, encPub: encPublicKey(encSecret) };
}
