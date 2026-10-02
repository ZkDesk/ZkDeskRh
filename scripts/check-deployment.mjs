// Post-deployment check, read-only: anyone can run it against a network to confirm the deployed
// contracts are wired and governed as documented. Exits 1 on any failed check.
// Usage: node scripts/check-deployment.mjs [mainnet|testnet]   (RPC: RPC_URL, else the chain default)
const net = process.argv[2] === 'testnet' ? 'testnet' : 'mainnet';
globalThis.ZKDESK_NETWORK = net;
const { createPublicClient, http, parseAbi, getAddress } = await import('viem');
const { chain, deployment } = await import('../src/lib/chain/config.js');

const client = createPublicClient({ chain, transport: http(process.env.RPC_URL || undefined) });
const ABI = parseAbi([
  'function owner() view returns (address)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getMinDelay() view returns (uint256)',
  'function guardian() view returns (address)',
  'function timelock() view returns (address)',
  'function desk() view returns (address)',
  'function screener() view returns (address)',
  'function pinner() view returns (address)',
  'function isModule(address) view returns (bool)',
  'function modulesSet() view returns (bool)',
  'function gate() view returns (address)',
  'function pool() view returns (address)',
  'function isAllowed(address) view returns (bool)',
  'function classes(address) view returns (uint16 ltvBps, uint16 liqThresholdBps, bool enabled, uint128 maxCollateral, uint128 minCollateral)',
  'function venue() view returns (address)',
  'function bonusSink() view returns (address)',
  'function lending() view returns (address)',
  'function marker() view returns (address)',
  'function EVICT_AFTER() view returns (uint64)',
  'function MAX_LEAVES() view returns (uint256)',
]);
const read = (address, functionName, args = []) => client.readContract({ address, abi: ABI, functionName, args });
const eq = (a, b) => getAddress(a) === getAddress(b);
const results = [];
async function check(name, fn) {
  try {
    const { ok, detail } = await fn();
    results.push({ ok, name, detail });
  } catch (error) {
    results.push({ ok: false, name, detail: error.shortMessage ?? error.message });
  }
}
const d = deployment;
const MIN_DELAY = net === 'mainnet' ? 48 * 3600 : 0;

await check('every contract has code', async () => {
  const keys = ['pool', 'assetGate', 'desk', 'deskGuardian', 'lending', 'marker', 'ledger', 'mandates', 'safe', 'timelock', ...(d.venue ? ['venue'] : [])];
  const missing = [];
  for (const k of keys) if (!d[k] || (await client.getCode({ address: d[k] })) === undefined) missing.push(k);
  return { ok: missing.length === 0, detail: missing.length ? `no code: ${missing.join(', ')}` : `${keys.length} contracts` };
});
await check('Safe has at least 2-of-N signers', async () => {
  const [owners, threshold] = await Promise.all([read(d.safe, 'getOwners'), read(d.safe, 'getThreshold')]);
  return { ok: Number(threshold) >= 2 && !owners.some((o) => eq(o, d.deployer)), detail: `${threshold}-of-${owners.length}; deployer ${owners.some((o) => eq(o, d.deployer)) ? 'IS' : 'is not'} an owner` };
});
await check(`timelock delay >= ${MIN_DELAY / 3600} h`, async () => {
  const delay = Number(await read(d.timelock, 'getMinDelay'));
  return { ok: delay >= MIN_DELAY, detail: `${delay / 3600} h` };
});
await check('timelock owns the gate, lending pool, marker and venue', async () => {
  const targets = ['assetGate', 'lending', 'marker', ...(d.venue ? ['venue'] : [])];
  const wrong = [];
  for (const k of targets) if (!eq(await read(d[k], 'owner'), d.timelock)) wrong.push(k);
  return { ok: wrong.length === 0, detail: wrong.length ? `not timelock-owned: ${wrong.join(', ')}` : targets.join(', ') };
});
await check('desk owned by DeskGuardian, which answers to the timelock', async () => {
  const [owner, tl, desk, guardian] = await Promise.all([read(d.desk, 'owner'), read(d.deskGuardian, 'timelock'), read(d.deskGuardian, 'desk'), read(d.deskGuardian, 'guardian')]);
  return { ok: eq(owner, d.deskGuardian) && eq(tl, d.timelock) && eq(desk, d.desk) && !eq(guardian, d.deployer), detail: `guardian ${guardian}` };
});
await check('screener is not the deployer', async () => {
  const screener = await read(d.assetGate, 'screener');
  return { ok: !eq(screener, d.deployer), detail: screener };
});
await check('pool modules fixed: desk, ledgers, mandates only', async () => {
  const [set, a, b, c, gate] = await Promise.all([read(d.pool, 'modulesSet'), read(d.pool, 'isModule', [d.desk]), read(d.pool, 'isModule', [d.ledger]), read(d.pool, 'isModule', [d.mandates]), read(d.pool, 'gate')]);
  return { ok: set && a && b && c && eq(gate, d.assetGate), detail: `modulesSet ${set}; gate ${gate}` };
});
await check('tree depth 32', async () => {
  const max = await read(d.pool, 'MAX_LEAVES');
  return { ok: max === 2n ** 32n, detail: `MAX_LEAVES ${max}` };
});
await check('desk wired to this pool, lending pool, marker and venue', async () => {
  const [pool, lending, marker, venue, sink, lendDesk] = await Promise.all([read(d.desk, 'pool'), read(d.desk, 'lending'), read(d.desk, 'marker'), read(d.desk, 'venue'), read(d.desk, 'bonusSink'), read(d.lending, 'desk')]);
  const ok = eq(pool, d.pool) && eq(lending, d.lending) && eq(marker, d.marker) && eq(lendDesk, d.desk) && (!d.venue || eq(venue, d.venue)) && (net !== 'mainnet' || eq(sink, d.safe));
  return { ok, detail: `venue ${venue}; bonus to ${sink}` };
});
await check('every collateral class is listed, enabled and has a minimum position', async () => {
  const bad = [];
  for (const [symbol, s] of Object.entries(d.stocks)) {
    const [c, allowed] = await Promise.all([read(d.desk, 'classes', [s.token]), read(d.assetGate, 'isAllowed', [s.token])]);
    if (!allowed || !c[2] || c[4] === 0n || c[0] !== s.ltvBps || c[1] !== s.liqBps) bad.push(symbol);
  }
  return { ok: bad.length === 0, detail: bad.length ? `wrong: ${bad.join(', ')}` : Object.keys(d.stocks).join(', ') };
});
await check('contract sources verified on Sourcify', async () => {
  const keys = ['pool', 'assetGate', 'desk', 'deskGuardian', 'lending', 'ledger', 'mandates', ...(d.venue ? ['venue'] : [])];
  const missing = [];
  for (const k of keys) {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/${chain.id}/${d[k]}`).then((x) => x.json()).catch(() => ({}));
    if (!['match', 'exact_match'].includes(r.match)) missing.push(k);
  }
  return { ok: missing.length === 0, detail: missing.length ? `unverified: ${missing.join(', ')}` : `${keys.length} contracts (https://repo.sourcify.dev/${chain.id}/<address>)` };
});
await check('idle positions can be evicted', async () => {
  const after = Number(await read(d.desk, 'EVICT_AFTER'));
  return { ok: after > 0, detail: `after ${after / 3600} h without debt or activity` };
});

const width = Math.max(...results.map((r) => r.name.length));
console.log(`ZKDesk ${net} (chain ${chain.id}), pool ${d.pool}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
