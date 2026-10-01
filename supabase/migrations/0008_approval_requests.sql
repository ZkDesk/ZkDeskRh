-- Treasury approval requests (dual control across members): opaque ciphertexts sealed with a key
-- only the treasury's members hold. Served by api/requests.js only (no public policy); the status of
-- each request is derived from the chain (IntentApproved, spent nullifiers), never stored here.
create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null,
  ciphertext text not null,
  created_at timestamptz not null default now()
);
create index approval_requests_ledger on public.approval_requests (ledger_id, created_at desc);
alter table public.approval_requests enable row level security;
