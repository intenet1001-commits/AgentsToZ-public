-- Reversible long-term-memory trash. The source files, revisions, journal,
-- device observations and merge lineage remain untouched.
create table if not exists public.portmgr_project_memory_trash (
  memory_id text primary key,
  trashed_at timestamptz not null default now()
);

alter table public.portmgr_project_memory_trash enable row level security;
drop policy if exists portmgr_authenticated_all on public.portmgr_project_memory_trash;
drop policy if exists portmgr_authenticated_read on public.portmgr_project_memory_trash;
create policy portmgr_authenticated_read on public.portmgr_project_memory_trash
  for select to authenticated
  using ((select public.portmgr_is_member()));
revoke all privileges on table public.portmgr_project_memory_trash
  from public, anon, authenticated, service_role;
grant select on table public.portmgr_project_memory_trash to authenticated;
grant select, insert, update, delete on table public.portmgr_project_memory_trash to service_role;

create or replace function public.portmgr_set_project_memory_trashed(
  p_memory_id text,
  p_trashed boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_memory text := public.portmgr_resolve_project_memory_id(p_memory_id);
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if v_memory is null or btrim(v_memory) = '' then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_REQUIRED';
  end if;
  if not exists (
    select 1 from public.portmgr_project_memory_heads where memory_id = v_memory
  ) and not exists (
    select 1 from public.portmgr_project_memory_revisions where memory_id = v_memory
  ) then
    raise exception using errcode = 'P0002', message = 'PROJECT_MEMORY_NOT_FOUND';
  end if;

  if coalesce(p_trashed, false) then
    insert into public.portmgr_project_memory_trash(memory_id, trashed_at)
    values (v_memory, now())
    on conflict (memory_id) do update set trashed_at = excluded.trashed_at;
  else
    delete from public.portmgr_project_memory_trash t
    where public.portmgr_resolve_project_memory_id(t.memory_id) = v_memory;
  end if;
  return coalesce(p_trashed, false);
end;
$$;

revoke all on function public.portmgr_set_project_memory_trashed(text, boolean)
  from public, anon;
grant execute on function public.portmgr_set_project_memory_trashed(text, boolean)
  to authenticated, service_role;
