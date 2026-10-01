// Copies ABIs from forge output into the app. Run after `forge build`: pnpm abis
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const out = 'src/lib/chain/abis';
mkdirSync(out, { recursive: true });
for (const name of ['ZKDeskPool', 'MockUSDG', 'AssetGate', 'CreditDesk', 'LendingPoolUSDG', 'Marker', 'MockStockToken', 'FeedKeeper', 'MockAMM', 'TreasuryLedger', 'MockERC4626', 'MandateRegistry', 'ZKDStaking', 'DeskGuardian', 'MockZKD']) {
  const file = `${name}.sol`;
  const { abi } = JSON.parse(readFileSync(`contracts/out/${file}/${name}.json`, 'utf8'));
  writeFileSync(`${out}/${name}.json`, JSON.stringify(abi, null, 2) + '\n');
  console.log(`${name}: ${abi.length} entries`);
}
