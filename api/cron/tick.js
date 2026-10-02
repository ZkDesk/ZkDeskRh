// Vercel Cron, every minute:
//   indexer      — pool, desk and marker events into Supabase (advances only when complete),
//                  including desk epochs and liquidation batches (M3), treasury ledgers (M4) and
//                  payment mandates / receipt roots (M5)
//   deposits     — clear notes whose screening standby has passed
//   operations   — reconcile relayed transactions
//   marker       — testnet mock feeds: ±0.5% random walk + pin via FeedKeeper when marks age 25 min
//   market hours — NYSE session flag on the Marker (exchange holidays not modelled yet)
//   rates        — hourly CreditDesk.accrue() (the public-curve rate publisher)
//   snapshots    — solvency per asset and lending pool state, hourly and after new events
import { parseAbi } from 'viem';
import { abis, cronAuthorized, db, deployment, keeper, publicClient, relayer, sendFrom, revertName, json } from '../_lib/server.js';
import { deploymentReady } from '../_lib/server.js';
import { checkAlerts } from '../_lib/alerts.js';

const EVENTS = parseAbi([
  'event NewCommitment(uint256 indexed commitment, uint256 index)',
  'event EncryptedNote(uint256 indexed commitment, bytes ciphertext)',
  'event NewNullifier(uint256 indexed nullifier)',
  'event DepositPending(uint256 indexed id, address indexed depositor, address indexed asset, uint256 amount, uint64 clearAfter)',
  'event DepositCleared(uint256 indexed id)',
  'event DepositFlagged(uint256 indexed id)',
  'event DepositRefunded(uint256 indexed id)',
  'event PositionUpdated(uint8 indexed slot, uint256 leaf, bytes ciphertext)',
  'event CreditFlow(address indexed asset, uint256 collIn, uint256 collOut, uint256 draw, uint256 repay)',
  'event Accrued(uint256 index, uint256 ratePerSecond, uint256 interest)',
  'event Pinned(address indexed asset, uint64 price, uint80 round, uint64 updatedAt)',
  'event Attested(uint64 indexed epoch, uint256 sumValue, uint256 sumDebt, uint256 breachCommit)',
  'event LedgerCreated(uint256 indexed id, uint256 rolesCommit, uint256 policyHash)',
  'event RolesRotated(uint256 indexed id, uint256 rolesCommit)',
  'event PolicySet(uint256 indexed id, uint256 policyHash)',
  'event TreasuryAttested(uint256 indexed id, uint64 epoch, uint256 liabilities)',
  'event MandateCommitted(uint256 indexed ledgerId, uint256 indexed commit, bytes ciphertext)',
  'event MandateStatus(uint256 indexed ledgerId, uint256 indexed commit, uint8 status)',
  'event Pulled(uint256 indexed ledgerId, uint256 indexed commit, uint256 k, uint256 receiptLeaf, uint256 receiptIndex, uint256 receiptRoot)',
  'event Liquidated(address indexed asset, uint256 positions, uint256 collSold, uint256 proceeds, uint256 repaid, uint256 price, uint256 writtenOffScaled)',
]);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const FEED = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const SAFETY_BLOCKS = 40n; // ~10 s behind head: public RPC nodes are load-balanced and can lag
const MAX_RANGE = 50_000n;
const MARK_REFRESH_SECONDS = 25 * 60;
const STOCKS = Object.values(deployment.stocks);
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const now = () => Math.floor(Date.now() / 1000);
const read = (address, abi, functionName, args = [], blockNumber) => publicClient.readContract({ address, abi, functionName, args, blockNumber });

async function index() {
  const { rows } = await db.query(`select block from public.chain_cursor where name = 'pool'`);
  const from = rows.length ? BigInt(rows[0].block) + 1n : BigInt(deployment.deployBlock);
  const head = (await publicClient.getBlockNumber({ cacheTime: 0 })) - SAFETY_BLOCKS;
  if (head < from) return { from, to: null, logs: 0 };
  const to = from + MAX_RANGE - 1n < head ? from + MAX_RANGE - 1n : head;
  const [logs, size] = await Promise.all([
    publicClient.getLogs({ address: [deployment.pool, deployment.desk, deployment.marker, deployment.ledger, deployment.mandates], events: EVENTS, fromBlock: from, toBlock: to }),
    read(deployment.pool, abis.pool, 'size', [], to),
  ]);

  const conn = await db.connect();
  try {
    await conn.query('begin');
    for (const l of logs) {
      const at = [l.blockNumber.toString(), l.transactionHash];
      const a = l.args;
      switch (l.eventName) {
        case 'NewCommitment': await conn.query('insert into public.commitments (leaf_index, commitment, block, tx) values ($1, $2, $3, $4) on conflict do nothing', [Number(a.index), hex(a.commitment), ...at]); break;
        case 'EncryptedNote': await conn.query('insert into public.encrypted_notes (commitment, ciphertext, block, tx) values ($1, $2, $3, $4) on conflict do nothing', [hex(a.commitment), a.ciphertext, ...at]); break;
        case 'NewNullifier': await conn.query('insert into public.nullifiers (nullifier, block, tx) values ($1, $2, $3) on conflict do nothing', [hex(a.nullifier), ...at]); break;
        case 'DepositPending': await conn.query('insert into public.deposits (id, depositor, asset, amount, clear_after, block, tx) values ($1, $2, $3, $4, to_timestamp($5), $6, $7) on conflict do nothing', [Number(a.id), a.depositor, a.asset, a.amount.toString(), Number(a.clearAfter), ...at]); break;
        case 'DepositCleared': case 'DepositFlagged': case 'DepositRefunded':
          await conn.query('update public.deposits set status = $2, updated_at = now() where id = $1', [Number(a.id), { DepositCleared: 'cleared', DepositFlagged: 'flagged', DepositRefunded: 'refunded' }[l.eventName]]); break;
        case 'PositionUpdated': await conn.query('insert into public.positions (slot, leaf, ciphertext, block, tx) values ($1, $2, $3, $4, $5) on conflict (slot) do update set leaf = $2, ciphertext = $3, block = $4, tx = $5, updated_at = now()', [Number(a.slot), hex(a.leaf), a.ciphertext, ...at]); break;
        case 'CreditFlow': await conn.query('insert into public.credit_flows (asset, coll_in, coll_out, draw, repay, block, tx, log_index) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing', [a.asset, a.collIn.toString(), a.collOut.toString(), a.draw.toString(), a.repay.toString(), ...at, l.logIndex]); break;
        case 'Accrued': await conn.query('insert into public.rate_checkpoints (index_wad, rate_per_second, interest, block, tx) values ($1, $2, $3, $4, $5) on conflict do nothing', [a.index.toString(), a.ratePerSecond.toString(), a.interest.toString(), ...at]); break;
        case 'Attested': await conn.query('insert into public.desk_epochs (epoch, sum_value, sum_debt, breach_commit, ts, block, tx) values ($1, $2, $3, $4, to_timestamp($5), $6, $7) on conflict do nothing', [Number(a.epoch), a.sumValue.toString(), a.sumDebt.toString(), hex(a.breachCommit), Number((await publicClient.getBlock({ blockNumber: l.blockNumber })).timestamp), ...at]); break;
        case 'Liquidated': await conn.query('insert into public.liq_batches (asset, n_positions, coll_sold, proceeds, debt_repaid, price, written_off_scaled, ts, block, tx, log_index) values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, $10, $11) on conflict do nothing', [a.asset, Number(a.positions), a.collSold.toString(), a.proceeds.toString(), a.repaid.toString(), a.price.toString(), a.writtenOffScaled.toString(), Number((await publicClient.getBlock({ blockNumber: l.blockNumber })).timestamp), ...at, l.logIndex]); break;
        case 'LedgerCreated': await conn.query('insert into public.ledgers (ledger_id, roles_commit, policy_hash, created_block) values ($1, $2, $3, $4) on conflict do nothing', [hex(a.id), hex(a.rolesCommit), hex(a.policyHash), at[0]]); break;
        case 'RolesRotated': await conn.query('update public.ledgers set roles_commit = $2, updated_at = now() where ledger_id = $1', [hex(a.id), hex(a.rolesCommit)]); break;
        case 'PolicySet': await conn.query('update public.ledgers set policy_hash = $2, updated_at = now() where ledger_id = $1', [hex(a.id), hex(a.policyHash)]); break;
        case 'TreasuryAttested': await conn.query('insert into public.treasury_epochs (ledger_id, epoch, liabilities, block, tx, ts) values ($1, $2, $3, $4, $5, to_timestamp($6)) on conflict do nothing', [hex(a.id), Number(a.epoch), a.liabilities.toString(), ...at, Number((await publicClient.getBlock({ blockNumber: l.blockNumber })).timestamp)]); break;
        case 'MandateStatus': await conn.query('insert into public.mandates_pub (mandate_commit, ledger_id, status, block) values ($1, $2, $3, $4) on conflict (mandate_commit) do update set status = $3, updated_at = now()', [hex(a.commit), hex(a.ledgerId), ['', 'active', 'paused', 'revoked'][a.status], at[0]]); break;
        case 'Pulled': await conn.query('insert into public.receipts_pub (receipt_index, mandate_commit, k, receipt_leaf, receipt_root, block, tx) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing', [Number(a.receiptIndex), hex(a.commit), Number(a.k), hex(a.receiptLeaf), hex(a.receiptRoot), ...at]); break;
        case 'Pinned': await conn.query('insert into public.marks (asset, round, price, updated_at, block) values ($1, $2, $3, to_timestamp($4), $5) on conflict do nothing', [a.asset, a.round.toString(), a.price.toString(), Number(a.updatedAt), at[0]]); break;
      }
    }
    // Only advance if the mirror is complete up to `to`; otherwise retry next minute.
    const { rows: [{ count }] } = await conn.query('select count(*)::int as count from public.commitments');
    if (count !== Number(size)) throw Object.assign(new Error(`mirror has ${count} leaves, pool has ${size} at ${to}`), { code: 'incomplete' });
    await conn.query(`insert into public.chain_cursor (name, block) values ('pool', $1) on conflict (name) do update set block = $1, updated_at = now()`, [to.toString()]);
    await conn.query('commit');
    return { from, to, logs: logs.length };
  } catch (error) {
    await conn.query('rollback');
    return { from, to, error: error.code === 'incomplete' ? error.message : revertName(error) };
  } finally {
    conn.release();
  }
}

/** Service transactions come from the keeper (the relayer until KEEPER_PRIVATE_KEY is set). */
async function send(label, target, functionName, args = [], from = keeper) {
  try {
    const sim = await publicClient.simulateContract({ account: from, ...target, functionName, args });
    return { [label]: (await sendFrom(from, functionName, args, sim.request.gas, target)).hash };
  } catch (error) {
    return { [label]: `skipped: ${revertName(error)}` };
  }
}

async function clearDue() {
  const { rows } = await db.query(`select id from public.deposits where status = 'pending' and clear_after <= now() order by id limit 5`);
  const out = [];
  for (const { id } of rows) out.push(await send(`clear ${id}`, { address: deployment.pool, abi: abis.pool }, 'clear', [BigInt(id)]));
  return out;
}

async function reconcile() {
  const { rows } = await db.query(`select op_id, status, tx_hash, nonce from public.operations where status in ('queued', 'submitted') and updated_at < now() - interval '30 seconds' limit 20`);
  let updated = 0;
  let confirmedNonce = null;
  for (const op of rows) {
    if (op.status === 'submitted') {
      const receipt = await publicClient.getTransactionReceipt({ hash: op.tx_hash }).catch(() => null);
      if (!receipt) {
        // Replaced or dropped: another transaction confirmed with this nonce, and this one never will.
        confirmedNonce ??= relayer ? await publicClient.getTransactionCount({ address: relayer.address, blockTag: 'latest' }) : null;
        if (op.nonce !== null && confirmedNonce !== null && confirmedNonce > Number(op.nonce)) {
          await db.query(`update public.operations set status = 'failed', error_code = 'replaced', updated_at = now() where op_id = $1 and status = 'submitted'`, [op.op_id]);
          updated++;
        }
        continue;
      }
      await db.query('update public.operations set status = $2, error_code = $3, updated_at = now() where op_id = $1', [op.op_id, receipt.status === 'success' ? 'confirmed' : 'failed', receipt.status === 'success' ? null : 'reverted']);
      updated++;
    } else if (!op.tx_hash) {
      // Never reached the chain (or unknown after 2 min): release it so the client can retry.
      // A retry of a spend that did land is rejected by simulation (NullifierSpent).
      await db.query(`update public.operations set status = 'failed', error_code = coalesce(error_code, 'not_sent'), updated_at = now() where op_id = $1 and updated_at < now() - interval '2 minutes'`, [op.op_id]);
      updated++;
    }
  }
  return { checked: rows.length, updated };
}

/** Drops spent or expired vouchers, old approval requests, unused mailbox keys and released note claims. */
async function prune() {
  const [v, r, k, s] = await Promise.all([
    db.query(`delete from public.relay_vouchers where used_at is not null or created_at < now() - interval '1 day'`),
    db.query(`delete from public.approval_requests where created_at < now() - interval '14 days'`),
    // Mailbox keys registered for a treasury that was never created (the mirror's ledgers table).
    db.query(`delete from public.mailbox_keys where created_at < now() - interval '1 day' and ledger_id not in (select ledger_id from public.ledgers)`),
    // Note claims of finished operations (audit N-2).
    db.query(`delete from public.pending_spends where op_id in (select op_id from public.operations where status in ('confirmed', 'failed', 'replaced')) or created_at < now() - interval '1 day'`),
  ]);
  return { vouchers: v.rowCount, requests: r.rowCount, mailboxKeys: k.rowCount, spends: s.rowCount };
}

/** NYSE regular session, weekdays 09:30-16:00 America/New_York (holidays not modelled). */
export function marketOpenAt(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((p) => [p.type, p.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !['Sat', 'Sun'].includes(parts.weekday) && minutes >= 570 && minutes < 960;
}

async function marker() {
  const out = {};
  const open = marketOpenAt();
  if ((await read(deployment.marker, abis.marker, 'marketOpen')) !== open) {
    // Only Marker.pinner may set the flag: the keeper once governance moves it there, else the relayer.
    const pinner = await read(deployment.marker, abis.marker, 'pinner');
    const from = pinner.toLowerCase() === keeper.address.toLowerCase() ? keeper : relayer;
    Object.assign(out, await send('marketOpen', { address: deployment.marker, abi: abis.marker }, 'setMarketOpen', [open], from));
  }
  if (!deployment.feedKeeper) {
    // Mainnet: real Chainlink feeds; pin a stock only when its feed has a new round.
    const stale = [];
    for (const s of STOCKS) {
      const [[round], [, , pinned]] = await Promise.all([read(s.feed, FEED, 'latestRoundData'), read(deployment.marker, abis.marker, 'current', [s.token])]);
      if (round !== pinned) stale.push(s.token);
    }
    return stale.length ? { ...out, ...(await send('marks', { address: deployment.marker, abi: abis.marker }, 'pinMany', [stale])) } : { ...out, marks: 'fresh' };
  }
  // Testnet: mock feeds take a small random walk through the FeedKeeper every MARK_REFRESH_SECONDS.
  const [, updatedAt] = await read(deployment.marker, abis.marker, 'current', [STOCKS[0].token]);
  if (now() - Number(updatedAt) < MARK_REFRESH_SECONDS) return { ...out, marks: 'fresh' };
  const prices = await Promise.all(STOCKS.map(async (s) => {
    const [, answer] = await read(s.feed, FEED, 'latestRoundData');
    const step = BigInt(Math.floor(Math.random() * 101) - 50); // -50..+50 bps
    return (answer * (10_000n + step)) / 10_000n;
  }));
  return { ...out, ...(await send('marks', { address: deployment.feedKeeper, abi: abis.keeper }, 'push', [STOCKS.map((s) => s.token), STOCKS.map((s) => s.feed), prices])) };
}

async function rates() {
  const last = Number(await read(deployment.desk, abis.desk, 'lastAccrual'));
  if (now() - last < 3600) return 'fresh';
  // Testnet: the mock yield vault quotes without its unminted yield; accruing hourly keeps a quote
  // within the treasury's 0.01% slippage slack.
  if (deployment.feedKeeper) await send('vault', { address: deployment.vault, abi: abis.vault }, 'accrue');
  return send('accrue', { address: deployment.desk, abi: abis.desk }, 'accrue');
}

async function snapshots() {
  const assets = [deployment.usdg, deployment.lending, deployment.vault, ...STOCKS.map((s) => s.token)];
  const out = [];
  for (const asset of assets) {
    const [balance, shielded, pending] = await Promise.all([
      read(asset, ERC20, 'balanceOf', [deployment.pool]), read(deployment.pool, abis.pool, 'shieldedSupply', [asset]), read(deployment.pool, abis.pool, 'pendingSupply', [asset]),
    ]);
    const ok = balance >= shielded + pending;
    await db.query('insert into public.solvency (asset, pool_balance, shielded_supply, pending_supply, ok) values ($1, $2, $3, $4, $5)', [asset, balance.toString(), shielded.toString(), pending.toString(), ok]);
    out.push({ asset, ok });
  }
  const [totalAssets, cash, debt, util] = await Promise.all([
    read(deployment.lending, abis.lending, 'totalAssets'), read(deployment.lending, abis.lending, 'cash'),
    read(deployment.desk, abis.desk, 'totalDebt'), read(deployment.lending, abis.lending, 'utilizationBps'),
  ]);
  const apr = await read(deployment.desk, abis.desk, 'aprBps', [util]);
  await db.query('insert into public.lending_snapshots (total_assets, cash, debt, utilization_bps, apr_bps) values ($1, $2, $3, $4, $5)', [totalAssets.toString(), cash.toString(), debt.toString(), Number(util), Number(apr)]);
  return { solvency: out, lending: { totalAssets, cash, debt, util, apr } };
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
  if (!deploymentReady) return json(res, 200, { skipped: 'network still on older contracts' });
  const report = { indexed: await index() };
  if (keeper) {
    report.cleared = await clearDue();
    report.marker = await marker();
    report.rates = await rates();
  }
  report.reconciled = await reconcile();
  report.pruned = await prune();
  report.alerts = await checkAlerts().catch((error) => ({ error: revertName(error) }));
  // Hourly, and on any tick that indexed new events, so a deposit shows within about a minute of clearing.
  if (new Date().getUTCMinutes() === 0 || report.indexed?.logs > 0 || req.query?.snapshot === '1') report.snapshots = await snapshots();
  return json(res, 200, report);
}
