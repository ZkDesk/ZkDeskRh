-- ZKDesk M1: public mirror of ZKDeskPool events + relayer operations + opt-in directory.
-- Privacy rule: no table links a note to a person, amount, LTV, rate or recipient.
-- The chain stays the source of truth; clients re-check the rebuilt root against the pool.

create table public.chain_cursor (
  name text primary key,
  block bigint not null,
  updated_at timestamptz not null default now()
);

create table public.commitments (
  leaf_index integer primary key,
  commitment text not null unique,
  block bigint not null,
  tx text not null
);

create table public.encrypted_notes (
  commitment text primary key,
  ciphertext text not null,
  block bigint not null,
  tx text not null
);

create table public.nullifiers (
  nullifier text primary key,
  block bigint not null,
  tx text not null
);

-- Deposits are public ERC-20 transfers into the pool; mirrored for standby clearing.
create table public.deposits (
  id integer primary key,
  depositor text not null,
  asset text not null,
  amount numeric not null,
  clear_after timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'cleared', 'flagged', 'refunded')),
  block bigint not null,
  tx text not null,
  updated_at timestamptz not null default now()
);
create index deposits_pending_idx on public.deposits (clear_after) where status = 'pending';

create table public.solvency (
  ts timestamptz not null default now(),
  asset text not null,
  pool_balance numeric not null,
  shielded_supply numeric not null,
  pending_supply numeric not null,
  ok boolean not null,
  primary key (asset, ts)
);

-- Relayed operations. Deliberately no user id, address or IP: the proof authorizes the tx.
create table public.operations (
  op_id uuid primary key default gen_random_uuid(),
  intent_hash text not null unique,
  kind text not null,
  status text not null default 'queued' check (status in ('queued', 'submitted', 'confirmed', 'failed', 'replaced')),
  tx_hash text,
  nonce bigint,
  attempts integer not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index operations_open_idx on public.operations (updated_at) where status in ('queued', 'submitted');

create table public.relayer_state (
  id integer primary key check (id = 1),
  next_nonce bigint
);
insert into public.relayer_state (id, next_nonce) values (1, null);

-- Opt-in directory so people can send to a wallet address. Keys only; never balances.
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  address text not null unique,
  owner_pk text not null,
  enc_pk text not null,
  discoverable boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Row-level security: public chain mirror is read-only for everyone; writes use the service
-- connection (Vercel functions), which bypasses RLS.
alter table public.chain_cursor enable row level security;
alter table public.commitments enable row level security;
alter table public.encrypted_notes enable row level security;
alter table public.nullifiers enable row level security;
alter table public.deposits enable row level security;
alter table public.solvency enable row level security;
alter table public.operations enable row level security;
alter table public.relayer_state enable row level security;
alter table public.users enable row level security;

create policy "public read" on public.chain_cursor for select using (true);
create policy "public read" on public.commitments for select using (true);
create policy "public read" on public.encrypted_notes for select using (true);
create policy "public read" on public.nullifiers for select using (true);
create policy "public read" on public.deposits for select using (true);
create policy "public read" on public.solvency for select using (true);
create policy "public read" on public.operations for select using (true);
-- relayer_state: no policies (service only).

create policy "read own or discoverable" on public.users for select
  using (discoverable or id = auth.uid());
create policy "insert own" on public.users for insert with check (id = auth.uid());
create policy "update own" on public.users for update using (id = auth.uid()) with check (id = auth.uid());
create policy "delete own" on public.users for delete using (id = auth.uid());

-- Live updates for the dashboard.
alter publication supabase_realtime add table public.encrypted_notes, public.commitments, public.nullifiers, public.operations, public.deposits;
