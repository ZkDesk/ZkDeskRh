// Checks a ZKDesk payment receipt (the JSON a recipient exports from the dashboard) against ZKDesk's
// MandateRegistry on the receipt's network (Robinhood Chain mainnet or testnet). Needs no keys and
// sends no transaction. Pass your own address as expected-verifier to check the receipt is for you.
// Usage: node scripts/verify-receipt.mjs receipt.json [expected-verifier]
import { readFileSync } from 'node:fs';
import { createPublicClient, formatUnits, http } from 'viem';

const [file, expected] = process.argv.slice(2);
if (!file) throw new Error('Usage: node scripts/verify-receipt.mjs receipt.json [expected-verifier]');
const record = JSON.parse(readFileSync(file, 'utf8'));
// The shared config reads the network once, at import.
globalThis.ZKDESK_NETWORK = Number(record.chainId) === 4663 ? 'mainnet' : 'testnet';
const { chain, deployment, symbolOf } = await import('../src/lib/chain/config.js');
const { verifyReceipt } = await import('../src/lib/zk/client.js');
const p = record.proof;
const client = createPublicClient({ chain, transport: http() });
const ok = await verifyReceipt(client, record).catch((error) => { console.error(`not verified: ${error.shortMessage || error.message}`); return false; });
const forMe = expected === undefined || BigInt(expected) === BigInt(p.verifier);
const usd = chain.id === 4663 ? 'USDG' : 'tUSDG';
const asset = p.asset.toLowerCase() === deployment.usdg.toLowerCase() ? usd : symbolOf(p.asset) ?? p.asset;
const decimals = asset === usd ? 6 : 18;
console.log(`receipt ${ok && forMe ? 'VALID' : 'INVALID'}${forMe ? '' : ' (addressed to a different verifier)'}`);
console.log(`  paid by treasury ${'0x' + BigInt(p.ledgerId).toString(16)} for period ${p.k} in ${asset}`);
console.log(`  addressed to verifier ${'0x' + BigInt(p.verifier).toString(16)}${expected === undefined && BigInt(p.verifier) !== 0n ? ' (pass your address as expected-verifier to check it is you)' : ''}`);
console.log(`  amount: ${p.discloseAmount ? `${formatUnits(BigInt(p.amount), decimals)} ${asset}` : 'not disclosed'}`);
console.log(`  recipient key: ${p.discloseOwner ? '0x' + BigInt(p.owner).toString(16) : 'not disclosed'}`);
process.exitCode = ok && forMe ? 0 : 1;
