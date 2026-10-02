// Audit N-2 acceptance: two requests spending the same note (each with a different dummy second input,
// so their intent hashes differ) are sent to the relay at once. Exactly one may be broadcast; the other
// must be refused (spend_in_flight, or NullifierSpent if it arrives after the first confirmed).
// Usage (fork or testnet): node scripts/ops/relay-race.mjs
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { createPublicClient, http, zeroAddress } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');
const { chain, deployment, payableFee } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { encryptNote } = await import('../../src/lib/zk/crypto.js');
const { buildTransact } = await import('../../src/lib/zk/transact.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { syncPool, myNotes } = await import('../../src/lib/zk/wallet.js');
const { default: relay } = await import('../../api/relay.js');

const call = (body) => new Promise((resolve) => relay({ method: body ? 'POST' : 'GET', body: body && JSON.parse(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) }, { statusCode: 200, setHeader() {}, end(b) { resolve({ http: this.statusCode, ...JSON.parse(b) }); } }));
const client = createPublicClient({ chain, transport: http(process.env.RPC_URL_SERVER || undefined) });
const keys = deriveKeys(await privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY).signTypedData(keyRequest(chain.id)));
const USDG = BigInt(deployment.usdg);
const info = await call(null);
const FEE = payableFee(info.minFee);
const state = await syncPool(client, deployment);
const note = myNotes(state, keys).filter((n) => n.status === 'unspent' && n.asset === USDG && n.amount > FEE).sort((a, b) => Number(b.amount - a.amount))[0];
if (!note) throw new Error('No USDG note to spend: run e2e-credit.mjs first.');
const prover = await createProver(JSON.parse(readFileSync('src/lib/zk/artifacts/transact.json', 'utf8')));

async function body() {
  const ext0 = { recipient: zeroAddress, extAmount: 0n, relayer: info.relayer, fee: FEE, converter: zeroAddress };
  const outputs = [{ amount: note.amount - FEE, owner: keys.owner }];
  const draft = buildTransact({ tree: state.tree, sk: keys.sk, asset: USDG, inputs: [note], outputs, ext: { ...ext0, encryptedOutput1: '0x', encryptedOutput2: '0x' } });
  const ext = { ...ext0, encryptedOutput1: encryptNote(draft.outputs[0], keys.encPub), encryptedOutput2: encryptNote(draft.outputs[1], keys.encPub) };
  const tx = buildTransact({ tree: state.tree, sk: keys.sk, asset: USDG, inputs: [note], outputs: draft.outputs, ext });
  const { proof } = await prover.prove(tx.witness);
  const p = tx.public;
  return { kind: 'transact', proof: { proof, root: p.root, publicAmount: p.publicAmount, extDataHash: p.extDataHash, asset: deployment.usdg, outAsset: deployment.usdg, publicAmountOut: 0n, inputNullifiers: p.inputNullifiers, outputCommitments: p.outputCommitments }, ext };
}
const [a, b] = [await body(), await body()]; // same real note, different dummy input each time
if (a.proof.inputNullifiers[0] !== b.proof.inputNullifiers[0] || a.proof.inputNullifiers[1] === b.proof.inputNullifiers[1]) throw new Error('setup: expected one shared and one distinct nullifier');
const results = await Promise.all([call(a), call(b)]);
for (const r of results) console.log(`  ${r.http} ${r.status ?? ''} ${r.errorCode ?? r.error ?? ''}`);
const sent = results.filter((r) => r.txHash).length;
const refused = results.filter((r) => ['spend_in_flight', 'NullifierSpent'].includes(r.errorCode)).length;
await prover.destroy();
if (sent !== 1 || refused !== 1) throw new Error(`expected one sent and one refused, got ${sent} sent, ${refused} refused`);
console.log('relay race passed: one broadcast, the conflicting spend refused before it cost gas');
process.exit(0);
