// Post-deployment check, read-only: anyone can run it against a network to confirm the deployed
// contracts are wired and governed as documented. Exits 1 on any failed check.
// Usage: node scripts/check-deployment.mjs [mainnet|testnet]   (RPC: RPC_URL, else the chain default)
const net = process.argv[2] === 'testnet' ? 'testnet' : 'mainnet';
globalThis.ZKDESK_NETWORK = net;
const { createPublicClient, http, parseAbi, parseAbiItem, getAddress, keccak256, toHex } = await import('viem');
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
  'function classes(address) view returns (uint16 ltvBps, uint16 liqThresholdBps, bool enabled, uint128 maxCollateral, uint128 minCollateral, uint128 minDebt)',
  'function STEP_INTERVAL() view returns (uint64)',
  'function SNAPSHOT_TTL() view returns (uint64)',
  'function venue() view returns (address)',
  'function bonusSink() view returns (address)',
  'function lending() view returns (address)',
  'function marker() view returns (address)',
  'function EVICT_AFTER() view returns (uint64)',
  'function MAX_LEAVES() view returns (uint256)',
  'function verifier() view returns (address)',
  'function healthVerifier() view returns (address)',
  'function liquidationVerifier() view returns (address)',
  'function evictVerifier() view returns (address)',
  'function ledgerVerifier() view returns (address)',
  'function authVerifier() view returns (address)',
  'function attestVerifier() view returns (address)',
  'function pullVerifier() view returns (address)',
  'function receiptVerifier() view returns (address)',
  'function feeds(address) view returns (address)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function maxAge() view returns (uint64)',
]);
const ROLE_GRANTED = parseAbiItem('event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)');
const ROLE_REVOKED = parseAbiItem('event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)');
const sourcify = async (address) => ['match', 'exact_match'].includes((await fetch(`https://sourcify.dev/server/v2/contract/${chain.id}/${address}`).then((x) => x.json()).catch(() => ({}))).match);
/** Logs over a long range, halving the window when the node refuses it. */
async function logs(params, from, to) {
  try {
    return await client.getLogs({ ...params, fromBlock: from, toBlock: to });
  } catch (error) {
    if (to - from < 1000n) throw error;
    const mid = (from + to) / 2n;
    return [...(await logs(params, from, mid)), ...(await logs(params, mid + 1n, to))];
  }
}
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
await check('Safe owners are exactly the documented signers', async () => {
  const owners = (await read(d.safe, 'getOwners')).map((a) => a.toLowerCase()).sort();
  const expected = (d.governance?.safeOwners ?? []).map((a) => a.toLowerCase()).sort();
  return { ok: expected.length > 0 && owners.join() === expected.join(), detail: owners.join(', ') };
});
await check('timelock roles: only the Safe proposes, executes and cancels; no outside admin', async () => {
  const roles = Object.fromEntries(['PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE', 'DEFAULT_ADMIN_ROLE'].map((n) => [n, n === 'DEFAULT_ADMIN_ROLE' ? '0x' + '00'.repeat(32) : keccak256(toHex(n))]));
  const from = BigInt(d.governance?.timelockDeployBlock ?? d.deployBlock);
  const head = await client.getBlockNumber();
  const events = [...(await logs({ address: d.timelock, event: ROLE_GRANTED }, from, head)), ...(await logs({ address: d.timelock, event: ROLE_REVOKED }, from, head))];
  const holders = {};
  for (const [name, role] of Object.entries(roles)) {
    const candidates = [...new Set(events.filter((e) => e.args.role === role).map((e) => getAddress(e.args.account)))];
    holders[name] = [];
    for (const a of candidates) if (await read(d.timelock, 'hasRole', [role, a])) holders[name].push(a);
  }
  const onlySafe = (list) => list.length === 1 && eq(list[0], d.safe);
  const ok = onlySafe(holders.PROPOSER_ROLE) && onlySafe(holders.EXECUTOR_ROLE) && onlySafe(holders.CANCELLER_ROLE) && holders.DEFAULT_ADMIN_ROLE.every((a) => eq(a, d.timelock));
  return { ok, detail: Object.entries(holders).map(([k, v]) => `${k.replace('_ROLE', '').toLowerCase()}: ${v.length ? v.map((a) => a.slice(0, 8)).join('/') : 'none'}`).join('; ') };
});
await check('Safe has at least 2-of-N signers', async () => {
  const [owners, threshold] = await Promise.all([read(d.safe, 'getOwners'), read(d.safe, 'getThreshold')]);
  return { ok: Number(threshold) >= 2 && !owners.some((o) => eq(o, d.deployer)), detail: `${threshold}-of-${owners.length}; deployer ${owners.some((o) => eq(o, d.deployer)) ? 'IS' : 'is not'} an owner` };
});
await check(`timelock delay >= ${MIN_DELAY / 3600} h, as the deployment file records`, async () => {
  const delay = Number(await read(d.timelock, 'getMinDelay'));
  const recorded = d.timelockDelay === undefined || Number(d.timelockDelay) === delay;
  return { ok: delay >= MIN_DELAY && recorded, detail: `${delay / 3600} h on-chain; file says ${d.timelockDelay === undefined ? '—' : `${Number(d.timelockDelay) / 3600} h`}` };
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
await check('guardian and screener are the documented keys', async () => {
  const [screener, guardian] = await Promise.all([read(d.assetGate, 'screener'), read(d.deskGuardian, 'guardian')]);
  const ok = !eq(screener, d.deployer) && (!d.governance || (eq(screener, d.governance.screener) && eq(guardian, d.governance.guardian)));
  return { ok, detail: `guardian ${guardian}; screener ${screener}` };
});
await check('price pinner is the relayer or keeper; every class reads its documented feed', async () => {
  const pinner = await read(d.marker, 'pinner');
  const wrong = [];
  for (const [symbol, s] of Object.entries(d.stocks)) if (!eq(await read(d.marker, 'feeds', [s.token]), s.feed)) wrong.push(symbol);
  const ok = (eq(pinner, d.relayer) || (d.keeper && eq(pinner, d.keeper))) && wrong.length === 0;
  return { ok, detail: `pinner ${pinner}${wrong.length ? `; wrong feeds: ${wrong.join(', ')}` : '; feeds match'}` };
});
await check('Marker mark validity matches the documented maxAge', async () => {
  const maxAge = Number(await read(d.marker, 'maxAge'));
  return { ok: maxAge === Number(d.markMaxAge), detail: `${maxAge / 3600} h (documented ${Number(d.markMaxAge) / 3600} h)` };
});
await check('service addresses: relayer and keeper are funded EOAs; the scheduler address is well formed', async () => {
  const keeper = d.keeper ?? d.relayer; // the keeper is the relayer until a keeper key is configured
  const problems = [];
  for (const [name, a] of [['relayer', d.relayer], ['keeper', keeper]]) {
    if ((await client.getCode({ address: a })) !== undefined) problems.push(`${name} is a contract`);
    if ((await client.getBalance({ address: a })) === 0n) problems.push(`${name} has no gas`);
  }
  if (!/^zkd:[0-9a-f]{128}$/.test(d.scheduler ?? '')) problems.push('scheduler address malformed');
  return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `relayer ${d.relayer}; keeper ${keeper}; scheduler ${d.scheduler.slice(0, 14)}…` };
});
await check('every verifier is deployed and source-verified', async () => {
  const getters = [[d.pool, ['verifier']], [d.desk, ['verifier', 'healthVerifier', 'liquidationVerifier', 'evictVerifier']], [d.ledger, ['ledgerVerifier', 'authVerifier', 'attestVerifier']], [d.mandates, ['authVerifier', 'pullVerifier', 'receiptVerifier']]];
  const bad = [];
  let n = 0;
  for (const [contract, names] of getters) {
    for (const g of names) {
      const v = await read(contract, g);
      n++;
      if ((await client.getCode({ address: v })) === undefined || !(await sourcify(v))) bad.push(`${g}@${v.slice(0, 8)}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.length ? `problem: ${bad.join(', ')}` : `${n} verifiers` };
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
await check('every collateral class is listed, enabled and has a minimum position and debt', async () => {
  const bad = [];
  for (const [symbol, s] of Object.entries(d.stocks)) {
    const [c, allowed] = await Promise.all([read(d.desk, 'classes', [s.token]), read(d.assetGate, 'isAllowed', [s.token])]);
    if (!allowed || !c[2] || c[4] === 0n || c[5] === 0n || c[0] !== s.ltvBps || c[1] !== s.liqBps) bad.push(symbol);
  }
  return { ok: bad.length === 0, detail: bad.length ? `wrong: ${bad.join(', ')}` : Object.keys(d.stocks).join(', ') };
});
await check('contract sources verified on Sourcify', async () => {
  const keys = ['pool', 'assetGate', 'desk', 'deskGuardian', 'lending', 'ledger', 'mandates', ...(d.venue ? ['venue'] : [])];
  const missing = [];
  for (const k of keys) if (!(await sourcify(d[k]))) missing.push(k);
  return { ok: missing.length === 0, detail: missing.length ? `unverified: ${missing.join(', ')}` : `${keys.length} contracts (https://repo.sourcify.dev/${chain.id}/<address>)` };
});
await check('idle positions can be evicted', async () => {
  const after = Number(await read(d.desk, 'EVICT_AFTER'));
  return { ok: after > 0, detail: `after ${after / 3600} h without debt or activity` };
});
await check('steps are spaced and epochs prove recent single-use snapshots', async () => {
  const [step, ttl] = (await Promise.all([read(d.desk, 'STEP_INTERVAL'), read(d.desk, 'SNAPSHOT_TTL')])).map(Number);
  return { ok: step > 0 && ttl > 0, detail: `one step per slot every ${step / 60} min (closing exempt); snapshots valid ${ttl / 60} min` };
});

const width = Math.max(...results.map((r) => r.name.length));
console.log(`ZKDesk ${net} (chain ${chain.id}), pool ${d.pool}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
