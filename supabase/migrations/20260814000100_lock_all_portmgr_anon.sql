-- Defense-in-depth repair for installations that still expose legacy portmgr_* tables.
--
-- This intentionally changes only the two invariants that must hold for every current
-- and future app table: RLS is enabled, and anon/PUBLIC have no table privileges.
-- Existing authenticated/service-role grants and specialized append-only ledger policies
-- remain untouched.
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename like 'portmgr\_%'
    order by tablename
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('revoke all privileges on table public.%I from anon', r.tablename);
    execute format('revoke all privileges on table public.%I from public', r.tablename);
  end loop;
end
$$;
