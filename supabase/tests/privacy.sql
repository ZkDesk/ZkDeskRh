-- Fails (raises) if any public table gains a column that could tie value or identity to a note.
-- Allowlisted: public on-chain data (deposits are visible ERC-20 transfers; solvency, rates and
-- credit flows are aggregates that carry no owner).
do $$
declare bad text;
begin
  select string_agg(table_name || '.' || column_name, ', ') into bad
  from information_schema.columns
  where table_schema = 'public'
    and column_name ~* '(amount|owner|recipient|ltv|rate|balance|plaintext|blinding|secret|email|(^|_)ip($|_))'
    and (table_name, column_name) not in (
      ('deposits', 'amount'), ('solvency', 'pool_balance'),
      ('users', 'owner_pk'),  -- public key used for addressing, not an owner-to-note link
      ('rate_checkpoints', 'rate_per_second')  -- public curve output
    );
  if bad is not null then
    raise exception 'privacy check failed: %', bad;
  end if;
  raise notice 'privacy check passed';
end $$;
