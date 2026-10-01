-- ZKDesk M3: epoch health attestations and sealed liquidation batches. The M3 deployment swaps in a
-- new CreditDesk and lending pool (the shielded pool stays), so the M2 desk mirror is reset.
truncate public.positions, public.credit_flows, public.rate_checkpoints;

-- One row per attested epoch: desk totals and the breached-set commitment only.
create table public.desk_epochs (
  epoch integer primary key,
  sum_value numeric not null, -- collateral at pinned marks, USDG 6 dp
  sum_debt numeric not null,
  breach_commit text not null,
  ts timestamptz not null,
  block bigint not null,
  tx text not null
);

-- One row per sealed batch: aggregates only (no slot owner, size or health).
create table public.liq_batches (
  id bigserial primary key,
  asset text not null,
  n_positions integer not null,
  coll_sold numeric not null,
  proceeds numeric not null,
  debt_repaid numeric not null,
  price numeric not null, -- uniform batch price, 8 dp
  written_off_scaled numeric not null,
  ts timestamptz not null,
  block bigint not null,
  tx text not null,
  log_index integer not null,
  unique (tx, log_index)
);

alter table public.desk_epochs enable row level security;
alter table public.liq_batches enable row level security;
create policy "public read" on public.desk_epochs for select using (true);
create policy "public read" on public.liq_batches for select using (true);
alter publication supabase_realtime add table public.desk_epochs;
