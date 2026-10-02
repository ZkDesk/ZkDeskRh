// node api/relay.test.mjs — request validation of the relay and the mailbox, fee scaling and the
// scheduler's rotation. Runs with a throwaway relayer key and no database or RPC: every case here
// must be decided before either is touched.
import assert from 'node:assert/strict';

globalThis.ZKDESK_NETWORK = 'mainnet';
process.env.MAINNET_RELAYER_PRIVATE_KEY = '0x' + '11'.repeat(32);
const { default: handler, parseRelayRequest, feeForGas } = await import('./relay.js');
const { default: requests } = await import('./requests.js');
const { rotate } = await import('./cron/pulls.js');
const { RELAY_GAS } = await import('./_lib/fees.js');
const { deployment } = await import('../src/lib/chain/config.js');
const { relayer } = await import('./_lib/server.js');
const { CONFIG_BYTES, KEY_SHARE_BYTES, MANDATE_BYTES, NOTE_CIPHERTEXT_BYTES, POSITION_CIPHERTEXT_BYTES } = await import('../src/lib/zk/crypto.js');

const call = (fn, req) => new Promise((resolve) => {
  const res = { statusCode: 200, setHeader() {}, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); } };
  fn(req, res);
});
const rejects = (body, pattern, label) => assert.throws(() => parseRelayRequest(body), pattern, label);
const bytes = (n) => '0x' + 'ab'.repeat(n);
const ZERO = '0x0000000000000000000000000000000000000000';
const proof = bytes(100);
const notes = { encryptedOutput1: bytes(NOTE_CIPHERTEXT_BYTES), encryptedOutput2: bytes(NOTE_CIPHERTEXT_BYTES) };

// ---- N-0: only the relay's own kinds, only allow-listed calls ----
const usdgTransfer = {
  target: { address: deployment.usdg, abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], functionName: 'transfer' },
  args: ['0x000000000000000000000000000000000000dEaD', '1'], nullifiers: ['1'],
};
for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'nope', 7, { x: 1 }]) {
  rejects({ kind, proof: usdgTransfer, ext: {} }, /Unknown kind/, `kind ${JSON.stringify(kind)}`);
  const r = await call(handler, { method: 'POST', body: { kind, proof: usdgTransfer, ext: {} } });
  assert.equal(r.status, 400, `handler rejects kind ${JSON.stringify(kind)}`);
}

// ---- transact ----
const transact = (p = {}, e = {}) => ({
  kind: 'transact',
  proof: { proof, root: '1', publicAmount: '0', extDataHash: '2', asset: deployment.usdg, outAsset: deployment.usdg, publicAmountOut: '0', inputNullifiers: ['11', '12'], outputCommitments: ['21', '22'], ...p },
  ext: { recipient: ZERO, extAmount: '0', relayer: relayer.address, fee: '1', converter: ZERO, ...notes, ...e },
});
const t = parseRelayRequest(transact());
assert.equal(t.kind, 'transfer');
assert.deepEqual(t.target.functionName, 'transact');
assert.deepEqual(t.spends, [11n, 12n], 'N-2: a transfer claims both input notes');
assert.deepEqual(t.fee, { asset: deployment.usdg.toLowerCase(), amount: 1n });
assert.equal(parseRelayRequest({ ...transact(), kind: undefined }).kind, 'transfer', 'no kind is a plain transact');
assert.equal(parseRelayRequest(transact({}, { recipient: '0x000000000000000000000000000000000000dEaD', extAmount: '-5' })).kind, 'withdraw');
rejects(transact({}, { extAmount: '5' }), /own wallet/, 'deposits are not relayed');
rejects(transact({}, { relayer: '0x000000000000000000000000000000000000dEaD' }), /this relayer/, 'fee goes to this relayer');
rejects(transact({}, { converter: '0x000000000000000000000000000000000000dEaD' }), /converter/, 'unknown converter');
rejects(transact({ asset: '0x000000000000000000000000000000000000dEaD' }), /asset/, 'unknown asset');
rejects(transact({}, { encryptedOutput1: bytes(3) }), /ciphertext/, 'wrong note size');
rejects(transact({ proof: '0x' + 'ab'.repeat(20_000) }), /proof bytes/, 'oversized proof');
rejects(transact({ root: '-1' }), /range/, 'negative field');
assert.throws(() => parseRelayRequest({ ...transact(), voucher: true, proof: { ...transact().proof, outAsset: deployment.lending } }, /voucher/));

// ---- position ----
const position = (p = {}, e = {}) => ({
  kind: 'position',
  proof: {
    proof, slot: 3, root: '1', extDataHash: '2', collAsset: deployment.stocks.SPY.token, inAsset: deployment.stocks.SPY.token, mark: '1', rateIndex: '1',
    oldLeaf: '0', newLeaf: '5', collIn: '1', collOut: '0', draw: '0', repay: '0', drawScaled: '0', repayScaled: '0',
    inputNullifiers: ['31', '32'], outputCommitments: ['41', '42'], operatorEph: ['1', '2'], operatorCipher: ['1', '2', '3', '4'], ...p,
  },
  ext: { relayer: relayer.address, fee: '0', ...notes, encryptedPosition: bytes(POSITION_CIPHERTEXT_BYTES), ...e },
});
const pos = parseRelayRequest(position());
assert.equal(pos.kind, 'open');
assert.deepEqual(pos.spends, [31n, 32n]);
assert.equal(pos.target.address, deployment.desk);
rejects(position({ slot: 64 }), /slot/, 'slot out of range');
rejects(position({}, { fee: '1' }), /no relay fee/, 'credit steps carry no fee field');
rejects(position({ operatorCipher: ['1'] }), /operator/, 'operator ciphertext required');
rejects(position({}, { encryptedPosition: bytes(5) }), /position ciphertext/, 'wrong position size');

// ---- ledger, ledger_auth, ledger_attest ----
const ledger = { kind: 'ledger', proof: { proof, root: '1', ledgerId: '7', action: 2, asset: deployment.usdg, outAsset: deployment.usdg, publicAmount: '0', publicAmountOut: '0', extDataHash: '2', inputNullifiers: ['51', '52'], outputCommitments: ['61', '62'], cosignIntent: '0' }, ext: { recipient: ZERO, extAmount: '0', ...notes } };
assert.equal(parseRelayRequest(ledger).kind, 'ledger_transfer');
assert.deepEqual(parseRelayRequest(ledger).spends, [51n, 52n]);
rejects({ ...ledger, proof: { ...ledger.proof, action: 9 } }, /ledger action/);
rejects({ ...ledger, ext: { ...ledger.ext, extAmount: '1' } }, /deposit or a private transfer/);
const auth = { kind: 'ledger_auth', proof: { proof, action: 4, ledgerId: '7', rolesCommit: '8', policyHash: '9', newValue: '1' }, ext: { shares: [bytes(KEY_SHARE_BYTES)], config: bytes(CONFIG_BYTES) } };
assert.equal(parseRelayRequest(auth).kind, 'ledger_set_limit', 'the M-4 transfer limit is relayed');
assert.equal(parseRelayRequest({ ...auth, proof: { ...auth.proof, action: 3 } }).kind, 'ledger_approve');
rejects({ ...auth, proof: { ...auth.proof, action: 5 } }, /governance action/, 'unknown governance action');
rejects({ ...auth, proof: { ...auth.proof, action: 0 }, ext: { shares: [bytes(3)], config: '0x' } }, /key shares/);
assert.equal(parseRelayRequest({ kind: 'ledger_attest', proof: { proof, root: '1', ledgerId: '7', liabilities: '1', nullifiers: Array(8).fill('1') } }).kind, 'ledger_attest');
rejects({ kind: 'ledger_attest', proof: { proof, root: '1', ledgerId: '7', liabilities: '1', nullifiers: ['1'] } }, /nullifiers/);

// ---- mandates ----
const mauth = { kind: 'mandate_auth', proof: { proof, ledgerId: '7', action: 0, mandateCommit: '9' }, ext: { ciphertext: bytes(MANDATE_BYTES) } };
assert.equal(parseRelayRequest(mauth).kind, 'mandate_commit');
rejects({ ...mauth, ext: { ciphertext: '0x' } }, /mandate ciphertext/);
const pull = { kind: 'mandate_pull', proof: { proof, root: '1', ledgerId: '7', mandateCommit: '9', asset: deployment.usdg, mark: '0', k: '0', t: '1', pullNullifier: '77', receiptLeaf: '1', extDataHash: '2', inputNullifiers: ['71', '72'], outputCommitments: ['81', '82'] }, ext: notes };
assert.deepEqual(parseRelayRequest(pull).spends, [77n, 71n, 72n], 'N-2: a pull claims its pull nullifier and inputs');

// ---- fee scaling (heavier calls pay proportionally) ----
assert.equal(feeForGas(1000n, RELAY_GAS), 1000n);
assert.equal(feeForGas(1000n, RELAY_GAS / 2n), 1000n, 'never below the quoted minimum');
assert.equal(feeForGas(1000n, RELAY_GAS * 2n), 2000n);
assert.equal(feeForGas(1000n, RELAY_GAS + 1n), 1001n, 'rounds up');

// ---- scheduler fairness (N-3) ----
assert.deepEqual(rotate(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
assert.deepEqual(rotate(['a', 'b', 'c'], 1), ['b', 'c', 'a']);
assert.deepEqual(rotate(['a', 'b', 'c'], 5), ['c', 'a', 'b']);
assert.deepEqual(rotate([], 3), []);
const firsts = new Set([0, 1, 2].map((h) => rotate(['a', 'b', 'c'], h)[0]));
assert.equal(firsts.size, 3, 'every treasury goes first once every 3 runs');

// ---- mailbox: malformed requests never reach the database ----
const id = '0x' + 'ab'.repeat(32);
assert.equal((await call(requests, { method: 'GET', query: { ledger: 'nope' } })).status, 400);
assert.equal((await call(requests, { method: 'POST', body: { ledgerId: 'x', ciphertext: '0x00', signature: '0x' + '00'.repeat(65) } })).status, 400);
assert.equal((await call(requests, { method: 'POST', body: { ledgerId: id, ciphertext: '0x00', signature: '0x12' } })).status, 400, 'signature must be 65 bytes');
assert.equal((await call(requests, { method: 'POST', body: '{not json' })).status, 400);
assert.equal((await call(requests, { method: 'POST', body: { ledgerId: id, register: true, signer: 'nope', signature: '0x' + '00'.repeat(65) } })).status, 401, 'registration needs a valid signer');
assert.equal((await call(requests, { method: 'PUT' })).status, 405);

console.log('relay checks passed: kinds and inherited names, every relay kind, allow-list, note claims, fee scaling, scheduler rotation, mailbox validation');
process.exit(0);
