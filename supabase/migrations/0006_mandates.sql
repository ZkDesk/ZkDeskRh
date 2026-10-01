-- ZKDesk M5: payment mandates and receipts. Public mirror of on-chain data only: mandate
-- commitments and status, period indexes and receipt leaves / roots. Never recipients, caps or
-- amounts (those stay encrypted to the treasury on-chain).
create table public.mandates_pub (
  mandate_commit text primary key,
  ledger_id text not null,
  status text not null check (status in ('active', 'paused', 'revoked')),
  block bigint not null,
  updated_at timestamptz not null default now()
);

-- One row per pull: the receipt leaf and the receipt root after it (recipients prove against any).
create table public.receipts_pub (
  receipt_index integer primary key,
  mandate_commit text not null,
  k integer not null,
  receipt_leaf text not null,
  receipt_root text not null,
  block bigint not null,
  tx text not null
);

alter table public.mandates_pub enable row level security;
alter table public.receipts_pub enable row level security;
create policy "public read" on public.mandates_pub for select using (true);
create policy "public read" on public.receipts_pub for select using (true);
