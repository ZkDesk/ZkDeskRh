-- Treasury statements get a time for the public transparency view (mirrored shortly after the block).
alter table public.treasury_epochs add column ts timestamptz not null default now();
