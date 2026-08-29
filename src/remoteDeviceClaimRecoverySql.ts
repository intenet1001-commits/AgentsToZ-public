export const REMOTE_DEVICE_CLAIM_RECOVERY_SQL = String.raw`-- A claimed token is not durable until the host has atomically written its identity.
-- New identities remain provisional for at most one day, can be cancelled by the
-- just-issued credential, and are confirmed independently from project inventory.
alter table public.portmgr_remote_devices
  add column if not exists provisioning_expires_at timestamptz;
update public.portmgr_remote_devices set provisioning_expires_at = null;
alter table public.portmgr_remote_devices
  alter column provisioning_expires_at set default (now() + interval '1 day');

create or replace function public.portmgr_confirm_remote_device_claim(
  p_device_id text,
  p_device_credential text
)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text;
begin
  select credential_hash into v_hash from public.portmgr_remote_device_credentials
  where device_id = p_device_id;
  if v_hash is null or p_device_credential is null
    or v_hash <> encode(digest(p_device_credential, 'sha256'), 'hex') then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_CREDENTIAL_INVALID';
  end if;
  update public.portmgr_remote_devices set provisioning_expires_at = null
  where device_id = p_device_id and revoked_at is null;
  return found;
end;
$$;

create or replace function public.portmgr_cancel_remote_device_claim(
  p_device_id text,
  p_device_credential text
)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text;
begin
  select credential_hash into v_hash from public.portmgr_remote_device_credentials
  where device_id = p_device_id;
  if v_hash is null or p_device_credential is null
    or v_hash <> encode(digest(p_device_credential, 'sha256'), 'hex') then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_CREDENTIAL_INVALID';
  end if;
  if not exists (
    select 1 from public.portmgr_remote_devices
    where device_id = p_device_id and provisioning_expires_at is not null and last_seen_at is null
  ) then
    return false;
  end if;
  update public.portmgr_remote_device_enrollments set
    claimed_at = null, claimed_device_id = null, previous_device_id = null
  where claimed_device_id = p_device_id;
  delete from public.portmgr_remote_devices where device_id = p_device_id;
  return found;
end;
$$;

create or replace function public.portmgr_cleanup_remote_device_provisioning()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_ids text[]; v_count integer := 0;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  select coalesce(array_agg(device_id), array[]::text[]) into v_ids
  from public.portmgr_remote_devices
  where provisioning_expires_at < now() and last_seen_at is null;
  v_count := cardinality(v_ids);
  if v_count = 0 then return 0; end if;
  update public.portmgr_remote_device_enrollments set
    claimed_at = null, claimed_device_id = null, previous_device_id = null
  where claimed_device_id = any(v_ids);
  delete from public.portmgr_remote_devices where device_id = any(v_ids);
  return v_count;
end;
$$;

create or replace function public.portmgr_clear_remote_device_provisioning_on_seen()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.last_seen_at is not null then new.provisioning_expires_at := null; end if;
  return new;
end;
$$;
drop trigger if exists portmgr_clear_remote_device_provisioning_on_seen on public.portmgr_remote_devices;
create trigger portmgr_clear_remote_device_provisioning_on_seen
before insert or update of last_seen_at on public.portmgr_remote_devices
for each row execute function public.portmgr_clear_remote_device_provisioning_on_seen();

revoke all on function public.portmgr_confirm_remote_device_claim(text,text) from public;
revoke all on function public.portmgr_cancel_remote_device_claim(text,text) from public;
revoke all on function public.portmgr_cleanup_remote_device_provisioning() from public;
grant execute on function public.portmgr_confirm_remote_device_claim(text,text) to anon,authenticated,service_role;
grant execute on function public.portmgr_cancel_remote_device_claim(text,text) to anon,authenticated,service_role;
grant execute on function public.portmgr_cleanup_remote_device_provisioning() to authenticated,service_role;
`;
