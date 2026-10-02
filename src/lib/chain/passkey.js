// Passkey unlock (WebAuthn PRF): the passkey returns the same 32 secret bytes for the same input
// every time, on every device it syncs to, and they replace the wallet signature as the key seed
// (lib/zk/keys.js passkeyKeys). There is no server: the challenge is random and nothing is verified
// or stored here. A passkey belongs to this site's domain.
import { bytesToHex } from '@noble/hashes/utils.js';

const PRF_INPUT = new TextEncoder().encode('ZKDesk passkey v1'); // fixed; keys.js separates the chains
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const prf = { eval: { first: PRF_INPUT } };
// Bound to this exact host name, so no other subdomain can ask for the same seed.
const rpId = () => location.hostname;
export const UNSUPPORTED = 'This browser or passkey provider cannot unlock ZKdesk (it has no WebAuthn PRF support). Use a current Chrome, Edge or Safari with a synced passkey, or connect MetaMask.';

/** false when the browser says it has no PRF support; true when it says yes or cannot tell. */
export async function passkeySupported() {
  if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials) return false;
  try {
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && 'extension:prf' in caps) return caps['extension:prf'];
  } catch { /* older browsers: try, and the result tells */ }
  return true;
}

/** Unlocks a passkey (the given credential, or one the person picks); returns { seed, id }. */
export async function unlockPasskey(id = null) {
  const credential = await navigator.credentials.get({ publicKey: {
    rpId: rpId(), challenge: random(32), userVerification: 'required',
    allowCredentials: id ? [{ type: 'public-key', id }] : [],
    extensions: { prf },
  } });
  const first = credential?.getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw new Error(UNSUPPORTED);
  return { seed: '0x' + bytesToHex(new Uint8Array(first)), id: credential.rawId };
}

/** Creates a passkey for a new private account; returns { seed, id }. */
export async function createPasskey() {
  const credential = await navigator.credentials.create({ publicKey: {
    rp: { id: rpId(), name: 'ZKdesk' },
    user: { id: random(16), name: `ZKdesk private account ${new Date().toISOString().slice(0, 10)}`, displayName: 'ZKdesk private account' },
    challenge: random(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf },
  } });
  const results = credential?.getClientExtensionResults?.().prf;
  if (!results?.enabled && !results?.results) throw new Error(UNSUPPORTED);
  const first = results.results?.first;
  // Many authenticators only evaluate the PRF on sign-in, so ask once more for this passkey.
  return first ? { seed: '0x' + bytesToHex(new Uint8Array(first)), id: credential.rawId } : unlockPasskey(credential.rawId);
}
