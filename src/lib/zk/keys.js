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

export function deriveKeys(signatureHex) {
  const ikm = hexToBytes(signatureHex.replace(/^0x/, ''));
  const salt = enc.encode('ZKDesk key v1');
  // 48 bytes -> reduce mod FIELD so the bias is negligible (< 2^-128).
  const sk = BigInt('0x' + bytesToHex(hkdf(sha256, ikm, salt, enc.encode('spend'), 48))) % FIELD;
  const encSecret = hkdf(sha256, ikm, salt, enc.encode('encrypt'), 32);
  return { sk, owner: ownerPk(sk), nk: nullifierKey(sk), encSecret, encPub: encPublicKey(encSecret) };
}
