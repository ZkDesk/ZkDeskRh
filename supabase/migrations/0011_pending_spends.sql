-- Audit N-2: a note may be spent by at most one unfinished relay operation at a time. Rows are
-- released when the operation confirms or fails, and pruned by api/cron/tick.js.
create table public.pending_spends (
  nullifier text primary key,
  op_id uuid not null references public.operations (op_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index pending_spends_op on public.pending_spends (op_id);
alter table public.pending_spends enable row level security;
-- pending_spends: no policies (service only).
