-- Agent upgrades happen independently from enrollment. Let a host-scoped
-- credential refresh the displayed agent version on every status report.
create or replace function public.portmgr_report_remote_device_agent_version(
  p_device_id text,
  p_device_credential text,
  p_agent_version text
)
returns table(device_id text, agent_version text, reported_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_now timestamptz := now(); v_version text;
begin
  select c.credential_hash into v_hash
  from public.portmgr_remote_device_credentials c
  join public.portmgr_remote_devices d on d.device_id = c.device_id
  where c.device_id = p_device_id and d.revoked_at is null;
  if v_hash is null or p_device_credential is null
    or v_hash <> encode(digest(p_device_credential, 'sha256'), 'hex') then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_CREDENTIAL_INVALID';
  end if;
  v_version := left(nullif(btrim(p_agent_version), ''), 40);
  if v_version is null then
    raise exception using errcode = '22023', message = 'REMOTE_DEVICE_AGENT_VERSION_INVALID';
  end if;
  update public.portmgr_remote_devices set agent_version = v_version, last_seen_at = v_now
  where portmgr_remote_devices.device_id = p_device_id;
  return query select p_device_id, v_version, v_now;
end;
$$;

revoke all on function public.portmgr_report_remote_device_agent_version(text,text,text) from public;
grant execute on function public.portmgr_report_remote_device_agent_version(text,text,text) to anon,authenticated,service_role;
