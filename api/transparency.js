// GET /api/transparency — public protocol aggregates for the dashboard's Transparency view.
// Everything here is already public on-chain (or mirrors it): desk epoch totals, sealed batch
// totals, pool solvency, lender pool state, treasury statements, mandate and receipt counts,
// governance settings and the service wallets' gas. Never a position, balance, owner or amount
// that belongs to one account. Cached briefly at the edge.
import { formatEther, parseAbi } from 'viem';
import { abis, db, deployment, MAINNET, publicClient, json } from './_lib/server.js';

const GOV = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function insurance() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
]);
const LOW_RELAYER_WEI = 10n ** 15n; // 0.001 ETH: top up soon
const DESK_FLOOR_WEI = 5n * 10n ** 14n; // 0.0005 ETH: desk epochs stop to keep user relays running
const symbols = Object.fromEntries([
  [deployment.usdg.toLowerCase(), MAINNET ? 'USDG' : 'tUSDG'], [deployment.lending.toLowerCase(), 'Lending shares'], [deployment.vault?.toLowerCase(), 'Vault shares'],
  ...Object.entries(deployment.stocks).map(([s, v]) => [v.token.toLowerCase(), s]),
]);
const symbolOf = (a) => symbols[String(a).toLowerCase()] ?? `${String(a).slice(0, 8)}…`;
const read = (address, abi, functionName) => publicClient.readContract({ address, abi, functionName });

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const q = (sql) => db.query(sql).then((r) => r.rows);
  const [epochs, batches, solvency, lending, statements, ledgers, mandates, receipts] = await Promise.all([
    q('select epoch, sum_value, sum_debt, ts from public.desk_epochs order by epoch desc limit 8'),
    q('select asset, n_positions, coll_sold, proceeds, debt_repaid, price, ts from public.liq_batches order by id desc limit 8'),
    q('select distinct on (asset) asset, pool_balance, shielded_supply, pending_supply, ok, ts from public.solvency order by asset, ts desc'),
    q('select total_assets, cash, debt, utilization_bps, apr_bps, ts from public.lending_snapshots order by ts desc limit 1'),
    q('select ledger_id, epoch, liabilities, ts from public.treasury_epochs order by ts desc limit 8'),
    q('select count(*)::int as n from public.ledgers'),
    q('select status, count(*)::int as n from public.mandates_pub group by status'),
    q('select count(*)::int as n, max(receipt_index) as last from public.receipts_pub'),
  ]);
  const [lastAttestedAt, healthy, paused, deskEpoch, marketOpen, relayerWei, delay, threshold, owners, insurance, staked] = await Promise.all([
    read(deployment.desk, abis.desk, 'lastAttestedAt'), read(deployment.desk, abis.desk, 'healthy'), read(deployment.desk, abis.desk, 'paused'),
    read(deployment.desk, abis.desk, 'epoch'), read(deployment.marker, abis.marker, 'marketOpen'),
    publicClient.getBalance({ address: deployment.relayer }),
    deployment.timelock ? read(deployment.timelock, GOV, 'getMinDelay') : null,
    deployment.safe ? read(deployment.safe, GOV, 'getThreshold') : null,
    deployment.safe ? read(deployment.safe, GOV, 'getOwners') : [],
    deployment.staking ? read(deployment.staking, GOV, 'insurance') : null,
    deployment.staking ? read(deployment.staking, GOV, 'totalStaked') : null,
  ]);
  res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify({
    at: new Date().toISOString(),
    desk: {
      epoch: Number(deskEpoch), lastAttestedAt: Number(lastAttestedAt) * 1000, healthy, paused, marketOpen,
      epochs: epochs.map((e) => ({ epoch: e.epoch, value: e.sum_value, debt: e.sum_debt, at: e.ts })),
      batches: batches.map((b) => ({ asset: symbolOf(b.asset), positions: b.n_positions, sold: b.coll_sold, proceeds: b.proceeds, repaid: b.debt_repaid, price: b.price, at: b.ts })),
    },
    lending: lending[0] && { totalAssets: lending[0].total_assets, cash: lending[0].cash, debt: lending[0].debt, utilizationBps: lending[0].utilization_bps, aprBps: lending[0].apr_bps, at: lending[0].ts },
    // Current assets only (older snapshots can name retired contracts).
    solvency: solvency.filter((s) => symbols[s.asset.toLowerCase()]).map((s) => ({ asset: symbolOf(s.asset), balance: s.pool_balance, backed: (BigInt(s.shielded_supply) + BigInt(s.pending_supply)).toString(), ok: s.ok, at: s.ts, decimals: s.asset.toLowerCase() === deployment.usdg.toLowerCase() ? 6 : s.asset.toLowerCase() === deployment.lending.toLowerCase() ? 12 : s.asset.toLowerCase() === deployment.vault?.toLowerCase() ? (MAINNET ? 18 : 12) : 18 })),
    treasuries: {
      count: ledgers[0].n,
      statements: statements.map((s) => ({ treasury: `${s.ledger_id.slice(0, 10)}…`, statement: s.epoch, liabilities: s.liabilities, at: s.ts })),
    },
    payments: { mandates: Object.fromEntries(mandates.map((m) => [m.status, m.n])), receipts: receipts[0].n },
    operations: {
      relayerEth: formatEther(relayerWei), relayerStatus: relayerWei < DESK_FLOOR_WEI ? 'critical' : relayerWei < LOW_RELAYER_WEI ? 'low' : 'ok',
      timelockDelay: delay === null ? null : Number(delay), safeThreshold: threshold === null ? null : Number(threshold), safeSigners: owners.length,
      insurance: insurance?.toString() ?? null, staked: staked?.toString() ?? null,
    },
  }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
