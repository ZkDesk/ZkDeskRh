-- The chain mirror must not depend on event order across indexer versions: statements may be
-- mirrored before their ledger row (re-indexing backfills it).
alter table public.treasury_epochs drop constraint treasury_epochs_ledger_id_fkey;
