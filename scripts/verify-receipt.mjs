// Checks a ZKDesk payment receipt (the JSON a recipient exports from the dashboard) against the
// MandateRegistry on Robinhood Chain testnet. Needs no keys and sends no transaction.
// Usage: node scripts/verify-receipt.mjs receipt.json [expected-verifier]
import { readFileSync } from 'node:fs';
import { createPublicClient, formatUnits, http } from 'viem';
import { chain, deployment, symbolOf } from '../src/lib/chain/config.js';
import { verifyReceipt } from '../src/lib/zk/client.js';

const [file, expected] = process.argv.slice(2);
if (!file) throw new Error('Usage: node scripts/verify-receipt.mjs receipt.json [expected-verifier]');
const record = JSON.parse(readFileSync(file, 'utf8'));
const p = record.proof;
const client = createPublicClient({ chain, transport: http() });
const ok = await verifyReceipt(client, record).catch((error) => { console.error(`not verified: ${error.shortMessage || error.message}`); return false; });
const forMe = expected === undefined || BigInt(expected) === BigInt(p.verifier);
const asset = p.asset.toLowerCase() === deployment.usdg.toLowerCase() ? 'tUSDG' : symbolOf(p.asset) ?? p.asset;
const decimals = asset === 'tUSDG' ? 6 : 18;
console.log(`receipt ${ok && forMe ? 'VALID' : 'INVALID'}${forMe ? '' : ' (addressed to a different verifier)'}`);
console.log(`  paid by treasury ${'0x' + BigInt(p.ledgerId).toString(16)} for period ${p.k} in ${asset}`);
console.log(`  addressed to verifier ${'0x' + BigInt(p.verifier).toString(16)}`);
console.log(`  amount: ${p.discloseAmount ? `${formatUnits(BigInt(p.amount), decimals)} ${asset}` : 'not disclosed'}`);
console.log(`  recipient key: ${p.discloseOwner ? '0x' + BigInt(p.owner).toString(16) : 'not disclosed'}`);
process.exitCode = ok && forMe ? 0 : 1;
