// node api/relay.test.mjs — the relay rejects any kind that is not one of its own parsers (audit N-0:
// kind "constructor" resolved to Object and made the relayer sign attacker-chosen calls). Runs with a
// throwaway key and no database or RPC: every case must fail before either is touched.
import assert from 'node:assert/strict';

globalThis.ZKDESK_NETWORK = 'mainnet';
process.env.MAINNET_RELAYER_PRIVATE_KEY = '0x' + '11'.repeat(32);
const { default: handler } = await import('./relay.js');
const { deployment } = await import('../src/lib/chain/config.js');

const call = (body) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); } };
  handler({ method: 'POST', body }, res);
});

// The exact attack: a "proof" that is itself the transaction the attacker wants signed.
const usdgTransfer = {
  target: { address: deployment.usdg, abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], functionName: 'transfer' },
  args: ['0x000000000000000000000000000000000000dEaD', 1n.toString()],
  nullifiers: ['1'],
};
for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'nope', 7, { x: 1 }]) {
  const r = await call({ kind, proof: usdgTransfer, ext: {} });
  assert.equal(r.status, 400, `kind ${JSON.stringify(kind)} must be rejected`);
  assert.equal(r.body.error, 'invalid_request');
}
// A known kind with a malformed proof is still rejected by its own parser.
assert.equal((await call({ kind: 'position', proof: usdgTransfer, ext: {} })).status, 400);
console.log('relay checks passed: unknown and inherited kinds are rejected before any call is built');
process.exit(0);
