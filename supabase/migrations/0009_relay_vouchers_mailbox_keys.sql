-- Audit H-2 / M-6.
-- Nonce row 2: the keeper key (desk epochs, liquidations, marks, clearing) has its own nonce lane.
alter table public.relayer_state drop constraint relayer_state_id_check;
alter table public.relayer_state add constraint relayer_state_id_check check (id in (1, 2));
insert into public.relayer_state (id, next_nonce) values (2, null) on conflict do nothing;

-- One-use relay vouchers, bought by a fee-paying self-transfer (op_id). Only a hash of the token is
-- kept, and nothing ties a voucher to the step that redeems it. Pruned once used or after a day.
create table public.relay_vouchers (
  token_hash text primary key,
  op_id uuid not null references public.operations (op_id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.relay_vouchers enable row level security;
-- relay_vouchers: no policies (service only).

-- Approval mailbox: each treasury's posting key (an address derived from the ledger secret, which
-- only members hold), registered by the creator before the treasury exists on-chain.
create table public.mailbox_keys (
  ledger_id text primary key,
  signer text not null,
  created_at timestamptz not null default now()
);
alter table public.mailbox_keys enable row level security;
-- mailbox_keys: no policies (service only).
create unique index approval_requests_unique on public.approval_requests (ledger_id, md5(ciphertext));
