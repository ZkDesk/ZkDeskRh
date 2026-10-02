#!/usr/bin/env node
// node agent/cli.mjs keygen  [mainnet|testnet]   new agent seed and its private address
// node agent/cli.mjs address [mainnet|testnet]   address of ZKDESK_SEED
// node agent/cli.mjs balance [mainnet|testnet]   private USDG balance of ZKDESK_SEED
import { createAgent, newSeed } from './index.mjs';

const [command, network = process.env.ZKDESK_NETWORK || 'mainnet'] = process.argv.slice(2);
if (!['keygen', 'address', 'balance'].includes(command)) {
  console.error('Usage: node agent/cli.mjs keygen|address|balance [mainnet|testnet]');
  process.exit(1);
}
try {
  const seed = command === 'keygen' ? newSeed() : process.env.ZKDESK_SEED;
  const agent = await createAgent({ seed, network, api: process.env.ZKDESK_API || undefined, rpc: process.env.ZKDESK_RPC || undefined });
  if (command === 'keygen') {
    console.log(`ZKDESK_SEED=${seed}`);
    console.log(`Address (${network}): ${agent.address}`);
    console.error('Keep the seed secret: whoever holds it can spend what this agent can. ZKdesk never sees it.');
  } else if (command === 'address') console.log(agent.address);
  else console.log(JSON.stringify(await agent.balance()));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
