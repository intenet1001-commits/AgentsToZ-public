-- Reversible device retirement. Historical revisions stay intact, but retired
-- devices no longer count as stale or block a lineage merge from completing.
create table if not exists public.portmgr_project_memory_device_retirements (
  memory_id text not null,
  device_id text not null,
  retired_at timestamptz not null default now(),
  primary key (memory_id, device_id)
);

alter table public.portmgr_project_memory_device_retirements enable row level security;
drop policy if exists portmgr_authenticated_all on public.portmgr_project_memory_device_retirements;
drop policy if exists portmgr_authenticated_read on public.portmgr_project_memory_device_retirements;
create policy portmgr_authenticated_read on public.portmgr_project_memory_device_retirements
  for select to authenticated
  using ((select public.portmgr_is_member()));
revoke all privileges on table public.portmgr_project_memory_device_retirements
  from public, anon, authenticated, service_role;
grant select on table public.portmgr_project_memory_device_retirements to authenticated;
grant select, insert, update, delete on table public.portmgr_project_memory_device_retirements to service_role;

create or replace function public.portmgr_skip_retired_project_memory_merge_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.portmgr_project_memory_device_retirements r
    where r.device_id = new.device_id
      and public.portmgr_resolve_project_memory_id(r.memory_id)
        = public.portmgr_resolve_project_memory_id(new.previous_memory_id)
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists portmgr_skip_retired_project_memory_merge_device
  on public.portmgr_project_memory_merge_devices;
create trigger portmgr_skip_retired_project_memory_merge_device
before insert on public.portmgr_project_memory_merge_devices
for each row execute function public.portmgr_skip_retired_project_memory_merge_device();

create or replace function public.portmgr_set_project_memory_device_retired(
  p_memory_id text,
  p_device_id text,
  p_retired boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_memory text := public.portmgr_resolve_project_memory_id(p_memory_id);
  v_merge record;
  v_remaining integer;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if v_memory is null or btrim(v_memory) = ''
    or p_device_id is null or btrim(p_device_id) = '' then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_DEVICE_REQUIRED';
  end if;

  if coalesce(p_retired, false) then
    insert into public.portmgr_project_memory_device_retirements(memory_id, device_id, retired_at)
    values (v_memory, btrim(p_device_id), now())
    on conflict (memory_id, device_id) do update set retired_at = excluded.retired_at;
  else
    delete from public.portmgr_project_memory_device_retirements r
    where r.device_id = btrim(p_device_id)
      and public.portmgr_resolve_project_memory_id(r.memory_id) = v_memory;
  end if;

  for v_merge in
    select id, target_memory_id
    from public.portmgr_project_memory_merges
    where target_memory_id = v_memory
  loop
    select count(*)::integer into v_remaining
    from public.portmgr_project_memory_merge_devices d
    where d.merge_id = v_merge.id
      and d.adopted_at is null
      and not exists (
        select 1
        from public.portmgr_project_memory_device_retirements r
        where r.device_id = d.device_id
          and public.portmgr_resolve_project_memory_id(r.memory_id) = v_memory
      );

    if v_remaining = 0 then
      update public.portmgr_project_memory_merges
      set status = 'complete', completed_at = coalesce(completed_at, now())
      where id = v_merge.id;
      update public.portmgr_project_memory_aliases
      set all_known_devices_migrated_at = coalesce(all_known_devices_migrated_at, now())
      where merge_id = v_merge.id;
    elsif not coalesce(p_retired, false) then
      update public.portmgr_project_memory_merges
      set status = 'awaiting-devices', completed_at = null
      where id = v_merge.id;
      update public.portmgr_project_memory_aliases
      set all_known_devices_migrated_at = null
      where merge_id = v_merge.id;
    end if;
  end loop;

  return coalesce(p_retired, false);
end;
$$;

revoke all on function public.portmgr_set_project_memory_device_retired(text, text, boolean)
  from public, anon;
grant execute on function public.portmgr_set_project_memory_device_retired(text, text, boolean)
  to authenticated, service_role;
revoke all on function public.portmgr_skip_retired_project_memory_merge_device()
  from public, anon, authenticated;
grant execute on function public.portmgr_skip_retired_project_memory_merge_device()
  to service_role;
