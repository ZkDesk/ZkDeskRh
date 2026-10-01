-- ZKDesk M4: treasury ledgers. Public mirror of on-chain data only: commitments, never members,
-- balances or amounts. Key shares and configs stay encrypted on-chain (TreasuryLedger events).
create table public.ledgers (
  ledger_id text primary key,
  roles_commit text not null,
  policy_hash text not null,
  created_block bigint not null,
  updated_at timestamptz not null default now()
);

-- One row per treasury statement: assets covered the declared liabilities at this epoch.
create table public.treasury_epochs (
  ledger_id text not null references public.ledgers (ledger_id),
  epoch integer not null,
  liabilities numeric not null,
  ok boolean not null default true,
  block bigint not null,
  tx text not null,
  primary key (ledger_id, epoch)
);

alter table public.ledgers enable row level security;
alter table public.treasury_epochs enable row level security;
create policy "public read" on public.ledgers for select using (true);
create policy "public read" on public.treasury_epochs for select using (true);
