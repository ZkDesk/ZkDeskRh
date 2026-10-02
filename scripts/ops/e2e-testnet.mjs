// Live M1 acceptance on Robinhood Chain testnet (46630), using the deployer key from .env.local:
// faucet -> private deposit -> standby -> clear -> private transfer to a second key (relayer fee)
// -> withdraw. Keys, encryption, tree sync and proving use the same modules as the app.
// Usage: node scripts/ops/e2e-testnet.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, maxUint256, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, deployment, abis, explorerTx } from '../../src/lib/chain/config.js';
import { deriveKeys, keyRequest } from '../../src/lib/zk/keys.js';
import { encryptNote } from '../../src/lib/zk/crypto.js';
import { buildTransact } from '../../src/lib/zk/transact.js';
import { createProver } from '../../src/lib/zk/prover.js';
import { syncPool, myNotes, balanceOf } from '../../src/lib/zk/wallet.js';
import circuit from '../../src/lib/zk/artifacts/transact.json' with { type: 'json' };

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const client = createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const wallet = createWalletClient({ account, chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const USDG = BigInt(deployment.usdg);
const u = (x) => `${Number(x) / 1e6} tUSDG`;

const alice = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const bob = deriveKeys('0x' + [...crypto.getRandomValues(new Uint8Array(65))].map((b) => b.toString(16).padStart(2, '0')).join(''));
const prover = await createProver(circuit);
let lastBlock = 0n;

async function send(label, fn, args) {
  const hash = await wallet.writeContract({ address: fn === 'faucet' || fn === 'approve' ? deployment.usdg : deployment.pool, abi: fn === 'faucet' || fn === 'approve' ? abis.usdg : abis.pool, functionName: fn, args });
  const r = await client.waitForTransactionReceipt({ hash });
  lastBlock = r.blockNumber;
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${explorerTx(hash)} (gas ${r.gasUsed})`);
  return r;
}

async function privateTx(label, keys, { inputs = [], outputs, ext }) {
  const state = await syncPool(client, deployment, { minBlock: lastBlock });
  const onchainRoot = await client.readContract({ address: deployment.pool, abi: abis.pool, functionName: 'root' });
  if (state.tree.size && state.tree.root !== onchainRoot) throw new Error('Rebuilt tree does not match the pool root.');
  const full = { recipient: zeroAddress, extAmount: 0n, relayer: zeroAddress, fee: 0n, ...ext };
  // Output ciphertexts must be fixed before proving because extDataHash binds them.
  const draft = buildTransact({ tree: state.tree, sk: keys.sk, asset: USDG, inputs, outputs, ext: { ...full, encryptedOutput1: '0x', encryptedOutput2: '0x' } });
  const [o1, o2] = draft.outputs;
  const ext2 = { ...full, encryptedOutput1: encryptNote(o1, o1.encPub ?? keys.encPub), encryptedOutput2: encryptNote(o2, o2.encPub ?? keys.encPub) };
  const tx = buildTransact({ tree: state.tree, sk: keys.sk, asset: USDG, inputs, outputs: draft.outputs, ext: ext2 });
  const t0 = performance.now();
  const { proof } = await prover.prove(tx.witness);
  console.log(`  ${label}: proof generated in ${Math.round(performance.now() - t0)} ms`);
  const p = tx.public;
  return send(label, 'transact', [{ proof, root: p.root, publicAmount: p.publicAmount, extDataHash: p.extDataHash, asset: deployment.usdg, outAsset: deployment.usdg, publicAmountOut: 0n, inputNullifiers: p.inputNullifiers, outputCommitments: p.outputCommitments }, ext2]);
}

console.log(`Deployer ${account.address} | pool ${deployment.pool}`);
console.log('1. Faucet + approve');
await send('faucet 1000', 'faucet', [1000_000000n]);
await send('approve', 'approve', [deployment.pool, maxUint256]);

console.log('2. Private deposit (standby)');
await privateTx('deposit 1000', alice, { outputs: [{ amount: 1000_000000n, owner: alice.owner }], ext: { extAmount: 1000_000000n } });
const id = (await client.readContract({ address: deployment.pool, abi: abis.pool, functionName: 'depositCount' })) - 1n;
console.log(`  pending notes: ${u(balanceOf(myNotes(await syncPool(client, deployment, { minBlock: lastBlock }), alice), USDG, 'pending'))}; waiting ${deployment.standbySeconds}s standby…`);
await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 5) * 1000));
await send(`clear deposit #${id}`, 'clear', [id]);

console.log('3. Private transfer 300 to a second key, relayer fee 1');
let notes = myNotes(await syncPool(client, deployment, { minBlock: lastBlock }), alice).filter((n) => n.status === 'unspent' && n.asset === USDG).sort((a, b) => b.leafIndex - a.leafIndex);
const input = notes[0];
await privateTx('transfer', alice, { inputs: [input], outputs: [{ amount: 300_000000n, owner: bob.owner, encPub: bob.encPub }, { amount: input.amount - 301_000000n, owner: alice.owner }], ext: { relayer: account.address, fee: 1_000000n } });

console.log('4. Withdraw 199 to the deployer address');
notes = myNotes(await syncPool(client, deployment, { minBlock: lastBlock }), alice).filter((n) => n.status === 'unspent' && n.asset === USDG).sort((a, b) => b.leafIndex - a.leafIndex);
const change = notes[0];
await privateTx('withdraw', alice, { inputs: [change], outputs: [{ amount: change.amount - 199_000000n, owner: alice.owner }], ext: { recipient: account.address, extAmount: -199_000000n } });

const state = await syncPool(client, deployment, { minBlock: lastBlock });
const read = (functionName, args = []) => client.readContract({ address: deployment.pool, abi: abis.pool, functionName, args });
const [poolBal, supply, pending] = await Promise.all([client.readContract({ address: deployment.usdg, abi: abis.usdg, functionName: 'balanceOf', args: [deployment.pool] }), read('shieldedSupply', [deployment.usdg]), read('pendingSupply', [deployment.usdg])]);
console.log('Result');
console.log(`  Alice private balance: ${u(balanceOf(myNotes(state, alice), USDG))}`);
console.log(`  Bob private balance:   ${u(balanceOf(myNotes(state, bob), USDG))} (found by trial decryption)`);
console.log(`  Pool token balance ${u(poolBal)} >= shielded ${u(supply)} + pending ${u(pending)}: ${poolBal >= supply + pending}`);
console.log(`  Tree: ${state.tree.size} leaves, rebuilt root matches pool: ${state.tree.root === (await read('root'))}`);
await prover.destroy();
