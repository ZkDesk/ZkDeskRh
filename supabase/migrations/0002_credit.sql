-- ZKDesk M2: credit desk, lending pool and marks. The M2 deployment is a fresh pool v2, so the
-- M1 mirror (which described the retired pool) is reset. Testnet only.
truncate public.commitments, public.encrypted_notes, public.nullifiers, public.deposits, public.solvency, public.chain_cursor;

-- Current state of each desk slot: the position commitment and its ciphertext (only the owner can
-- open it). Public on-chain data; no owner, size or LTV.
create table public.positions (
  slot smallint primary key check (slot between 0 and 63),
  leaf text not null,
  ciphertext text not null,
  block bigint not null,
  tx text not null,
  updated_at timestamptz not null default now()
);

-- Public aggregate flow of each credit step (who took it is not known).
create table public.credit_flows (
  id bigserial primary key,
  asset text not null,
  coll_in numeric not null,
  coll_out numeric not null,
  draw numeric not null,
  repay numeric not null,
  block bigint not null,
  tx text not null,
  log_index integer not null,
  unique (tx, log_index)
);

create table public.marks (
  asset text not null,
  round numeric not null,
  price numeric not null, -- 8 decimals, per 1e18 base units
  updated_at timestamptz not null,
  block bigint not null,
  primary key (asset, round)
);

create table public.rate_checkpoints (
  index_wad numeric primary key,
  rate_per_second numeric not null,
  interest numeric not null,
  block bigint not null,
  tx text not null
);

create table public.lending_snapshots (
  ts timestamptz primary key default now(),
  total_assets numeric not null,
  cash numeric not null,
  debt numeric not null,
  utilization_bps integer not null,
  apr_bps integer not null
);

alter table public.positions enable row level security;
alter table public.credit_flows enable row level security;
alter table public.marks enable row level security;
alter table public.rate_checkpoints enable row level security;
alter table public.lending_snapshots enable row level security;
create policy "public read" on public.positions for select using (true);
create policy "public read" on public.credit_flows for select using (true);
create policy "public read" on public.marks for select using (true);
create policy "public read" on public.rate_checkpoints for select using (true);
create policy "public read" on public.lending_snapshots for select using (true);

alter publication supabase_realtime add table public.positions, public.marks;
