-- Operational alerts (api/_lib/alerts.js): when each alert last went out, and the timelock log cursor.
create table public.alert_state (
  key text primary key,
  sent_at timestamptz,
  block bigint
);
alter table public.alert_state enable row level security;
-- alert_state: no policies (service only).
