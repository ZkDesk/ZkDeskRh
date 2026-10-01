// Testnet governance through the Safe (1-of-1: the deployer) and the 300 s TimelockController.
//   node scripts/ops/govern.mjs schedule <target> "<signature>" [args...]   Safe -> timelock.schedule
//   node scripts/ops/govern.mjs execute  <target> "<signature>" [args...]   Safe -> timelock.execute (after 300 s)
//   node scripts/ops/govern.mjs pause-desk                                  guardian key: pause new risk now
// <target> is a deployments key (assetGate, marker, lending, staking, deskGuardian) or an address.
// Desk calls go through the guardian: target deskGuardian, signature "execute(bytes)" with the
// desk calldata, or use the shortcut:  ... schedule desk "setPaused(bool)" false
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress, parseAbi, parseAbiItem, concatHex, padHex, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, deployment } from '../../src/lib/chain/config.js';

const SAFE = parseAbi(['function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)']);
const TIMELOCK = parseAbi([
  'function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable',
  'function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) pure returns (bytes32)',
  'function getTimestamp(bytes32 id) view returns (uint256)',
  'function getMinDelay() view returns (uint256)',
]);
const GUARDIAN = parseAbi(['function pause()', 'function execute(bytes data) returns (bytes)']);

const key = readFileSync('.env.local', 'utf8').match(/DEPLOYER_PRIVATE_KEY="([^"]+)"/)[1];
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });

/** Parses CLI args for a function signature ("setPaused(bool)" + ["false"]). */
function encode(signature, args) {
  const item = parseAbiItem(`function ${signature}`);
  const values = item.inputs.map((input, i) => {
    const v = args[i];
    if (input.type === 'bool') return v === 'true';
    if (input.type.startsWith('uint') || input.type.startsWith('int')) return BigInt(v);
    return v;
  });
  return encodeFunctionData({ abi: [item], args: values });
}

function operation([targetName, signature, ...args]) {
  if (targetName === 'desk') return { target: deployment.deskGuardian, data: encodeFunctionData({ abi: GUARDIAN, functionName: 'execute', args: [encode(signature, args)] }) };
  const target = isAddress(targetName) ? targetName : deployment[targetName];
  if (!target) throw new Error(`Unknown target ${targetName}`);
  return { target, data: encode(signature, args) };
}

/** Safe transaction from its only owner: a pre-validated signature (r = owner, s = 0, v = 1). */
async function viaSafe(data) {
  const signatures = concatHex([padHex(account.address, { size: 32 }), zeroHash, '0x01']);
  const args = [deployment.timelock, 0n, data, 0, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', signatures];
  await publicClient.simulateContract({ account, address: deployment.safe, abi: SAFE, functionName: 'execTransaction', args });
  const hash = await wallet.writeContract({ address: deployment.safe, abi: SAFE, functionName: 'execTransaction', args });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`Safe transaction failed: ${hash}`);
  return hash;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'pause-desk') {
  const hash = await wallet.writeContract({ address: deployment.deskGuardian, abi: GUARDIAN, functionName: 'pause' });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`desk paused by the guardian: ${hash}`);
} else if (command === 'schedule' || command === 'execute') {
  const { target, data } = operation(rest);
  const id = await publicClient.readContract({ address: deployment.timelock, abi: TIMELOCK, functionName: 'hashOperation', args: [target, 0n, data, zeroHash, zeroHash] });
  const inner = command === 'schedule'
    ? encodeFunctionData({ abi: TIMELOCK, functionName: 'schedule', args: [target, 0n, data, zeroHash, zeroHash, await publicClient.readContract({ address: deployment.timelock, abi: TIMELOCK, functionName: 'getMinDelay' })] })
    : encodeFunctionData({ abi: TIMELOCK, functionName: 'execute', args: [target, 0n, data, zeroHash, zeroHash] });
  const hash = await viaSafe(inner);
  const ready = await publicClient.readContract({ address: deployment.timelock, abi: TIMELOCK, functionName: 'getTimestamp', args: [id] });
  console.log(`${command}d operation ${id} via the Safe: ${hash}${command === 'schedule' ? ` (executable after ${new Date(Number(ready) * 1000).toISOString()})` : ''}`);
} else {
  throw new Error('Usage: govern.mjs schedule|execute <target> "<signature>" [args...] | pause-desk');
}
