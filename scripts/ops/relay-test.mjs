// Live relayer acceptance: builds a real withdraw proof for the deployer's notes and sends it through
// api/relay.js (called in-process with .env.local), then checks idempotency and tamper rejection.
// Usage: node scripts/ops/relay-test.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { chain, deployment } = await import('../../src/lib/chain/config.js');
const { deriveKeys, keyRequest } = await import('../../src/lib/zk/keys.js');
const { encryptNote } = await import('../../src/lib/zk/crypto.js');
const { buildTransact } = await import('../../src/lib/zk/transact.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { syncPool, myNotes, balanceOf } = await import('../../src/lib/zk/wallet.js');
const { default: relay } = await import('../../api/relay.js');
const circuit = JSON.parse(readFileSync('src/lib/zk/artifacts/transact.json', 'utf8'));

const call = (body) => new Promise((resolve) => relay({ method: 'POST', body: JSON.parse(JSON.stringify(body)) }, { statusCode: 200, setHeader() {}, end(b) { resolve({ http: this.statusCode, ...JSON.parse(b) }); } }));
const client = createPublicClient({ chain, transport: http() });
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const keys = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const USDG = BigInt(deployment.usdg);
const FEE = 10_000n;

let state = await syncPool(client, deployment);
const before = balanceOf(myNotes(state, keys), USDG);
const input = myNotes(state, keys).filter((n) => n.status === 'unspent' && n.asset === USDG).sort((a, b) => Number(b.amount - a.amount))[0];
const ext0 = { recipient: account.address, extAmount: -5_000000n, relayer: process.env.RELAYER_ADDRESS, fee: FEE };
const draft = buildTransact({ tree: state.tree, sk: keys.sk, asset: USDG, inputs: [input], outputs: [{ amount: input.amount - 5_000000n - FEE, owner: keys.owner }], ext: { ...ext0, encryptedOutput1: '0x', encryptedOutput2: '0x' } });
const ext = { ...ext0, encryptedOutput1: encryptNote(draft.outputs[0], keys.encPub), encryptedOutput2: encryptNote(draft.outputs[1], keys.encPub) };
const tx = buildTransact({ tree: state.tree, sk: keys.sk, asset: USDG, inputs: [input], outputs: draft.outputs, ext });
const prover = await createProver(circuit);
const { proof } = await prover.prove(tx.witness);
await prover.destroy();
const body = { proof: { proof, ...tx.public, asset: deployment.usdg }, ext: { ...ext, extAmount: ext.extAmount.toString(), fee: ext.fee.toString() } };
body.proof.inputNullifiers = tx.public.inputNullifiers.map(String);
body.proof.outputCommitments = tx.public.outputCommitments.map(String);
for (const k of ['root', 'publicAmount', 'extDataHash']) body.proof[k] = String(tx.public[k]);

const tampered = structuredClone(body);
tampered.ext.recipient = '0x000000000000000000000000000000000000dEaD';
const t = await call(tampered);
console.log('tampered recipient ->', t.http, t.status, t.errorCode);

const first = await call(body);
console.log('relayed withdraw   ->', first.http, first.status, first.txHash);
const again = await call(body);
console.log('same request again ->', again.http, again.status, `duplicate=${again.duplicate}`, `op ${again.opId === first.opId ? 'same' : 'DIFFERENT'}`);

state = await syncPool(client, deployment, { minBlock: first.block ? BigInt(first.block) : 0n });
console.log(`private balance ${Number(before) / 1e6} -> ${Number(balanceOf(myNotes(state, keys), USDG)) / 1e6} tUSDG (withdrew 5 + fee 0.01)`);
process.exit(0);
