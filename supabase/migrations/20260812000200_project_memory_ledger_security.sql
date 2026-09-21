-- v9 project-memory ledger hardening.
--
-- The local API is the only writer and uses a server-only service_role key.
-- Authenticated browser clients may inspect member-scoped rows, but cannot forge,
-- rewrite, or delete CAS/append-only history directly.

do $$
declare
  t text;
  read_predicate text;
begin
  -- Legacy installations may have project-memory tables without the common
  -- member helper. The migration must still harden them, so use a deny-all
  -- authenticated SELECT policy until the canonical helper is installed.
  read_predicate := case
    when to_regprocedure('public.portmgr_is_member()') is null then 'false'
    else '(select public.portmgr_is_member())'
  end;
  foreach t in array array[
    'portmgr_project_memory_revisions',
    'portmgr_project_memory_journal',
    'portmgr_project_memories',
    'portmgr_project_memory_heads',
    'portmgr_project_memory_feedback'
  ]
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists portmgr_authenticated_all on public.%I', t);
    execute format('drop policy if exists portmgr_authenticated_read on public.%I', t);
    execute format($p$
      create policy portmgr_authenticated_read on public.%I
        for select to authenticated
        using (%s)
    $p$, t, read_predicate);
    execute format('revoke all privileges on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;

-- Revisions alone are retention-pruned. Journal and feedback are immutable
-- append-only evidence and deliberately have no UPDATE or DELETE privilege.
grant select, insert, delete on table public.portmgr_project_memory_revisions to service_role;
grant select, insert on table public.portmgr_project_memory_journal to service_role;
grant select, insert on table public.portmgr_project_memory_feedback to service_role;
grant select, insert, update, delete on table public.portmgr_project_memories to service_role;
grant select, insert, update, delete on table public.portmgr_project_memory_heads to service_role;

revoke all on function public.portmgr_claim_project_memory(text, text) from public, anon, authenticated;
revoke all on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.portmgr_claim_project_memory(text, text) to service_role;
grant execute on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) to service_role;
revoke all on function public.portmgr_guard_project_memory_revision_insert() from public, anon, authenticated;
grant execute on function public.portmgr_guard_project_memory_revision_insert() to service_role;
