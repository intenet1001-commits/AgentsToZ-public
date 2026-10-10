export const MEMORY_DEVICE_REGISTRY_SQL = `-- A memory-only desktop must appear in the device inventory without pretending
-- that it pushed projects. Historical aliases and remote hosts remain separate.
create or replace function public.portmgr_register_memory_device(p_device_id text, p_device_name text default null)
returns boolean language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare inherited_name text;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501', message='SERVICE_ROLE_REQUIRED'; end if;
  if p_device_id is null or p_device_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or length(coalesce(p_device_name,'')) > 120 or coalesce(p_device_name,'') ~ '[[:cntrl:]]' then
    raise exception 'INVALID_DEVICE_IDENTITY';
  end if;
  if exists(select 1 from public.portmgr_device_identity_aliases where alias_device_id=p_device_id)
    or exists(select 1 from public.portmgr_remote_devices where device_id=p_device_id) then return false; end if;
  select d.name into inherited_name from public.portmgr_device_identity_aliases a
    join public.portmgr_devices d on d.id=a.alias_device_id
    where a.canonical_device_id=p_device_id and nullif(btrim(d.name),'') is not null
    order by d.last_push_at desc nulls last, d.id limit 1;
  insert into public.portmgr_devices(id,name,last_push_at)
    values(p_device_id,coalesce(nullif(btrim(p_device_name),''),inherited_name,'단말 '||left(p_device_id,8)),null)
    on conflict(id) do nothing;
  return true;
end $$;
revoke all on function public.portmgr_register_memory_device(text,text) from public, anon, authenticated;
grant execute on function public.portmgr_register_memory_device(text,text) to service_role;
`;
