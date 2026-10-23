-- Desktop AgentsToZ does not require a Google user session. Its Tauri WebView talks only
-- to the loopback sidecar, and the sidecar injects the server-only service_role key.
-- Keep member-scoped authenticated web access unchanged while allowing service-owned RPCs
-- such as memory merge and device retirement to pass their explicit membership guard.

create or replace function public.portmgr_is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or (
      coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
      and exists (
        select 1
        from public.portmgr_allowed_members member
        where member.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
    );
$$;

revoke all on function public.portmgr_is_member() from public, anon;
grant execute on function public.portmgr_is_member() to authenticated, service_role;
