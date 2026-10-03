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
const ledger = { kind: 'ledger', proof: { proof, root: '1', ledgerId: '7', action: 2, asset: deployment.usdg, outAsset: deployment.usdg, publicAmount: '0', publicAmountOut: '0', extDataHash: '2', inputNullifiers: ['51', '52'], outputCommitments: ['61', '62'], cosignIntent: '0', t: '1790000000', budgetOld: '0', budgetNew: '71', budgetCt: ['72', '73'] }, ext: { recipient: ZERO, extAmount: '0', ...notes } };
assert.equal(parseRelayRequest(ledger).kind, 'ledger_transfer');
assert.deepEqual(parseRelayRequest(ledger).spends.slice(0, 2), [51n, 52n]);
// v3.4: a transfer also claims its accumulator (after simulation), so two transfers on one
// accumulator wait for each other; governance changes and mandate changes are serialized the same way.
{
  const other = { ...ledger, proof: { ...ledger.proof, inputNullifiers: ['53', '54'] } };
  const key = (r) => parseRelayRequest(r).serial[0];
  assert.deepEqual(parseRelayRequest(ledger).spends, [51n, 52n], 'notes only; the accumulator is a separate claim');
  assert.equal(key(other), key(ledger), 'same ledger and accumulator');
  assert.equal(key({ ...other, proof: { ...other.proof, budgetOld: '1' } }), key(ledger), 'one key per treasury');
  assert.notEqual(key({ ...other, proof: { ...other.proof, ledgerId: '8' } }), key(ledger), 'fresh ledgers do not share a claim');
  assert.equal(parseRelayRequest({ ...ledger, proof: { ...ledger.proof, action: 0 }, ext: { ...ledger.ext, extAmount: '-1' } }).serial.length, 0, 'converts do not touch the accumulator');
}
rejects({ ...ledger, proof: { ...ledger.proof, action: 9 } }, /ledger action/);
rejects({ ...ledger, ext: { ...ledger.ext, extAmount: '1' } }, /deposit or a private transfer/);
// v3.4: the spending accumulator rides with every ledger proof.
assert.deepEqual(parseRelayRequest(ledger).args[0].budgetCt, [72n, 73n]);
assert.equal(parseRelayRequest(ledger).args[0].t, 1790000000n);
rejects({ ...ledger, proof: { ...ledger.proof, budgetCt: ['72'] } }, /budget ciphertext/);
const auth = { kind: 'ledger_auth', proof: { proof, action: 4, ledgerId: '7', rolesCommit: '8', policyHash: '9', newValue: '1' }, ext: { shares: [bytes(KEY_SHARE_BYTES)], config: bytes(CONFIG_BYTES) } };
// v3.4: the same limit set again later binds a new governance counter, so it is a new operation; one
// governance change per ledger in flight.
assert.notDeepEqual(parseRelayRequest({ ...auth, proof: { ...auth.proof, nonce: '5' } }).nullifiers, parseRelayRequest({ ...auth, proof: { ...auth.proof, nonce: '6' } }).nullifiers);
assert.notDeepEqual(parseRelayRequest({ ...auth, proof: { ...auth.proof, policyHash: '10' } }).nullifiers, parseRelayRequest(auth).nullifiers);
assert.deepEqual(parseRelayRequest(auth).serial, parseRelayRequest(ledger).serial, 'governance and transfers of a treasury go one at a time');
assert.equal(parseRelayRequest(auth).kind, 'ledger_set_limit', 'the M-4 transfer limit is relayed');
assert.equal(parseRelayRequest({ ...auth, proof: { ...auth.proof, action: 3 } }).kind, 'ledger_approve');
rejects({ ...auth, proof: { ...auth.proof, action: 5 } }, /governance action/, 'unknown governance action');
rejects({ ...auth, proof: { ...auth.proof, action: 0 }, ext: { shares: [bytes(3)], config: '0x' } }, /key shares/);
// Mailbox keys ride only on a create (audit M-6/N-4); a create without one still works.
const create = { ...auth, proof: { ...auth.proof, action: 0 } };
assert.equal(parseRelayRequest(create).mailbox, null, 'a create needs no mailbox');
const withBox = parseRelayRequest({ ...create, ext: { ...create.ext, mailboxSigner: relayer.address, mailboxSignature: '0x' + '22'.repeat(65) } });
assert.equal(withBox.args[3], relayer.address, 'L-c: the mailbox key is a contract argument, bound by the create proof');
assert.equal(parseRelayRequest(create).args[3], '0x0000000000000000000000000000000000000000');
assert.deepEqual(withBox.mailbox, { ledger: '0x' + (7).toString(16).padStart(64, '0'), signer: relayer.address, signature: '0x' + '22'.repeat(65) });
rejects({ ...create, ext: { ...create.ext, mailboxSigner: 'nope', mailboxSignature: '0x' } }, /mailbox key/, 'malformed mailbox key');
assert.equal(parseRelayRequest({ ...auth, proof: { ...auth.proof, action: 3 }, ext: { ...auth.ext, mailboxSigner: relayer.address } }).mailbox, null, 'only a create registers a mailbox');
assert.equal(parseRelayRequest({ kind: 'ledger_attest', proof: { proof, root: '1', ledgerId: '7', liabilities: '1', nullifiers: Array(8).fill('1') } }).kind, 'ledger_attest');
rejects({ kind: 'ledger_attest', proof: { proof, root: '1', ledgerId: '7', liabilities: '1', nullifiers: ['1'] } }, /nullifiers/);

// ---- mandates ----
const mauth = { kind: 'mandate_auth', proof: { proof, ledgerId: '7', action: 0, mandateCommit: '9' }, ext: { ciphertext: bytes(MANDATE_BYTES) } };
// v3.4: a pause after a resume binds a new change counter, so it is not a duplicate of the first pause.
{
  const pause = (nonce) => parseRelayRequest({ ...mauth, proof: { ...mauth.proof, action: 2, nonce }, ext: { ciphertext: '0x' } }).nullifiers;
  assert.notDeepEqual(pause('1'), pause('3'));
  assert.deepEqual(parseRelayRequest(mauth).serial, parseRelayRequest(ledger).serial, 'and so do its mandate changes');
}
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
assert.equal((await call(requests, { method: 'POST', body: { ledgerId: id, register: true, signer: relayer.address, signature: '0x' + '00'.repeat(65) } })).status, 410, 'no public registration: it rides on the create relay');
assert.equal((await call(requests, { method: 'PUT' })).status, 405);
// Posts to unknown or unregistered treasuries: api/handlers.test.mjs (mocked database and chain).

console.log('relay checks passed: kinds and inherited names, every relay kind, allow-list, note claims, fee scaling, scheduler rotation, mailbox validation');
process.exit(0);
