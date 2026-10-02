// Mainnet (4663) governance, audit Phase B: Safe 2-of-3, guardian and screener off the deployer, 48 h delay.
//   node scripts/ops/govern-mainnet.mjs status       Safe owners/threshold, roles, delay, the Phase B operation
//   node scripts/ops/govern-mainnet.mjs schedule-b   Safe -> timelock.scheduleBatch(setGuardian, setScreener, updateDelay 48 h)
//   node scripts/ops/govern-mainnet.mjs handover     Safe: add the 3 signers, remove the deployer, threshold 2
//   node scripts/ops/govern-mainnet.mjs execute-b    Safe -> timelock.executeBatch (once the delay has passed)
//   node scripts/ops/govern-mainnet.mjs pause-desk   guardian (signer 1): pause new risk on the desk at once
//   node scripts/ops/govern-mainnet.mjs cancel <id>  Safe -> timelock.cancel(id): drop a pending proposal
// Safe transactions are signed by whichever current owners have keys in .env.local (the deployer and
// MAINNET_SAFE_SIGNER_{1,2,3}_PRIVATE_KEY, see secrets/mainnet-governance-keys.json), up to the threshold, and
// submitted by the deployer account, which pays the gas. RPC_URL_SERVER points everything at a fork.
import { readFileSync } from 'node:fs';
globalThis.ZKDESK_NETWORK = 'mainnet';
const { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash, concatHex } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');
const { chain, deployment } = await import('../../src/lib/chain/config.js');

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const deployer = privateKeyToAccount(env.MAINNET_DEPLOYER_PRIVATE_KEY);
const signers = [1, 2, 3].map((i) => privateKeyToAccount(env[`MAINNET_SAFE_SIGNER_${i}_PRIVATE_KEY`]));
const [guardian, screener] = signers;
const keys = [deployer, ...signers];
const transport = http(process.env.RPC_URL_SERVER || undefined);
const publicClient = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account: deployer, chain, transport });

const SAFE = parseAbi([
  'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)', 'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
]);
const TIMELOCK = parseAbi([
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable',
  'function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) pure returns (bytes32)',
  'function getTimestamp(bytes32 id) view returns (uint256)', 'function getMinDelay() view returns (uint256)', 'function updateDelay(uint256 newDelay)',
  'function cancel(bytes32 id)',
]);
const ROLES = parseAbi(['function guardian() view returns (address)', 'function screener() view returns (address)', 'function pinner() view returns (address)', 'function setGuardian(address)', 'function setScreener(address)']);
const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const SENTINEL = '0x0000000000000000000000000000000000000001';
const NEW_DELAY = 48n * 3600n;

// The Phase B batch. A fixed salt makes it one identifiable operation.
const batch = {
  targets: [deployment.deskGuardian, deployment.assetGate, deployment.timelock],
  values: [0n, 0n, 0n],
  payloads: [
    encodeFunctionData({ abi: ROLES, functionName: 'setGuardian', args: [guardian.address] }),
    encodeFunctionData({ abi: ROLES, functionName: 'setScreener', args: [screener.address] }),
    encodeFunctionData({ abi: TIMELOCK, functionName: 'updateDelay', args: [NEW_DELAY] }),
  ],
  predecessor: zeroHash,
  salt: keccak256(stringToHex('zkdesk audit phase B v1')),
};
const batchArgs = [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt];

/** One Safe transaction, signed by current owners we hold keys for (ascending address order, as Safe requires). */
async function viaSafe(label, to, data) {
  const [owners, threshold, nonce] = await Promise.all([read(deployment.safe, SAFE, 'getOwners'), read(deployment.safe, SAFE, 'getThreshold'), read(deployment.safe, SAFE, 'nonce')]);
  const hash = await read(deployment.safe, SAFE, 'getTransactionHash', [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
  const held = keys.filter((k) => owners.some((o) => same(o, k.address))).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1)).slice(0, Number(threshold));
  if (held.length < Number(threshold)) throw new Error(`${label}: need ${threshold} owner keys, hold ${held.length}`);
  const signatures = concatHex(await Promise.all(held.map((k) => k.sign({ hash }))));
  const args = [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures];
  await publicClient.simulateContract({ account: deployer, address: deployment.safe, abi: SAFE, functionName: 'execTransaction', args });
  const tx = await wallet.writeContract({ address: deployment.safe, abi: SAFE, functionName: 'execTransaction', args });
  const r = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (r.status !== 'success') throw new Error(`${label} failed: ${tx}`);
  console.log(`${label}: ${tx} (Safe nonce ${nonce}, signed by ${held.map((k) => k.address).join(', ')})`);
}

async function status() {
  const id = await read(deployment.timelock, TIMELOCK, 'hashOperationBatch', batchArgs);
  const [owners, threshold, delay, g, s, p, ready] = await Promise.all([
    read(deployment.safe, SAFE, 'getOwners'), read(deployment.safe, SAFE, 'getThreshold'), read(deployment.timelock, TIMELOCK, 'getMinDelay'),
    read(deployment.deskGuardian, ROLES, 'guardian'), read(deployment.assetGate, ROLES, 'screener'), read(deployment.marker, ROLES, 'pinner'),
    read(deployment.timelock, TIMELOCK, 'getTimestamp', [id]),
  ]);
  const state = ready === 0n ? 'not scheduled' : ready === 1n ? 'executed' : `scheduled, executable after ${new Date(Number(ready) * 1000).toISOString()}`;
  console.log({ safe: deployment.safe, owners, threshold: Number(threshold), timelockDelayHours: Number(delay) / 3600, guardian: g, screener: s, pinner: p, phaseB: { id, state } });
  return { owners, threshold, ready };
}

const command = process.argv[2];
if (command === 'status') {
  await status();
} else if (command === 'schedule-b') {
  const delay = await read(deployment.timelock, TIMELOCK, 'getMinDelay');
  await viaSafe('schedule Phase B batch', deployment.timelock, encodeFunctionData({ abi: TIMELOCK, functionName: 'scheduleBatch', args: [...batchArgs, delay] }));
  await status();
} else if (command === 'handover') {
  for (const s of signers) {
    if ((await read(deployment.safe, SAFE, 'getOwners')).some((o) => same(o, s.address))) continue;
    await viaSafe(`add owner ${s.address}`, deployment.safe, encodeFunctionData({ abi: SAFE, functionName: 'addOwnerWithThreshold', args: [s.address, 1n] }));
  }
  const owners = await read(deployment.safe, SAFE, 'getOwners');
  const i = owners.findIndex((o) => same(o, deployer.address));
  if (i >= 0) await viaSafe('remove the deployer, threshold 2', deployment.safe, encodeFunctionData({ abi: SAFE, functionName: 'removeOwner', args: [i === 0 ? SENTINEL : owners[i - 1], deployer.address, 2n] }));
  await status();
} else if (command === 'execute-b') {
  await viaSafe('execute Phase B batch', deployment.timelock, encodeFunctionData({ abi: TIMELOCK, functionName: 'executeBatch', args: batchArgs }));
  await status();
} else if (command === 'pause-desk') {
  const g = createWalletClient({ account: guardian, chain, transport });
  const tx = await g.writeContract({ address: deployment.deskGuardian, abi: parseAbi(['function pause()']), functionName: 'pause' });
  const r = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`desk ${r.status === 'success' ? 'paused' : 'NOT paused'} by the guardian: ${tx}`);
} else if (command === 'cancel') {
  const id = process.argv[3];
  if (!/^0x[0-9a-f]{64}$/i.test(id ?? '')) throw new Error('Usage: govern-mainnet.mjs cancel <operation id>');
  await viaSafe(`cancel ${id}`, deployment.timelock, encodeFunctionData({ abi: TIMELOCK, functionName: 'cancel', args: [id] }));
} else {
  throw new Error('Usage: govern-mainnet.mjs status | schedule-b | handover | execute-b | pause-desk | cancel <id>');
}
