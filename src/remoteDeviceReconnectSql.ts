/**
 * Canonical post-enrollment upgrades: practical token lifetime and safe
 * server identity rotation. Keep byte-for-byte aligned with migration 008.
 */
export const REMOTE_DEVICE_RECONNECT_SQL = `
-- The command expiry protects the one-time token only. A claimed device stays
-- connected until the user revokes it. Allow a practical 24-hour hand-off
-- window for servers that are not immediately reachable from the portal.
create or replace function public.portmgr_create_remote_device_enrollment(
  p_token text,
  p_requested_name text,
  p_environment_kind text,
  p_target_memory_id text,
  p_ttl_seconds integer default 86400
)
returns table(enrollment_id text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id text := gen_random_uuid()::text;
  v_memory text := public.portmgr_resolve_project_memory_id(p_target_memory_id);
  v_expires timestamptz := now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 86400), 60), 86400));
  v_kind text := lower(btrim(coalesce(p_environment_kind, 'linux')));
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'REMOTE_ENROLLMENT_TOKEN_INVALID';
  end if;
  if p_requested_name is null or char_length(btrim(p_requested_name)) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'REMOTE_DEVICE_NAME_INVALID';
  end if;
  if v_kind not in ('aws','linux','cloud','container','wsl') then
    raise exception using errcode = '22023', message = 'REMOTE_ENVIRONMENT_KIND_INVALID';
  end if;
  if v_memory is null or btrim(v_memory) = '' or not exists (
    select 1 from public.portmgr_project_memory_revisions r
    where public.portmgr_resolve_project_memory_id(r.memory_id) = v_memory
  ) then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_NOT_FOUND';
  end if;

  delete from public.portmgr_remote_device_enrollments e
  where e.claimed_at is null and e.expires_at < now() - interval '1 day';
  insert into public.portmgr_remote_device_enrollments(
    id, token_hash, requested_name, environment_kind, target_memory_id, expires_at
  ) values (
    v_id, encode(digest(p_token, 'sha256'), 'hex'), btrim(p_requested_name), v_kind, v_memory, v_expires
  );
  return query select v_id, v_expires;
end;
$$;

-- The extra force flag intentionally rotates the server identity. This is
-- needed when a historical installation reused another machine's device_id.
-- Access grants move forward, while the old device and its observations stay
-- as immutable history and its credential is revoked.
drop function if exists public.portmgr_claim_remote_device_enrollment(text,text,text,text,text,text,text,text,text);

create or replace function public.portmgr_claim_remote_device_enrollment(
  p_token text,
  p_hostname text,
  p_platform text,
  p_environment_kind text,
  p_os_release text,
  p_architecture text,
  p_agent_version text,
  p_existing_device_id text default null,
  p_existing_credential text default null,
  p_force_new boolean default false
)
returns table(
  device_id text,
  device_credential text,
  target_memory_id text,
  device_name text
)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_enrollment public.portmgr_remote_device_enrollments%rowtype;
  v_device_id text;
  v_credential text;
  v_existing_hash text;
  v_previous_device_id text;
  v_kind text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'REMOTE_ENROLLMENT_TOKEN_INVALID';
  end if;
  select * into v_enrollment
  from public.portmgr_remote_device_enrollments e
  where e.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and e.claimed_at is null and e.expires_at > now()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'REMOTE_ENROLLMENT_EXPIRED_OR_CLAIMED';
  end if;

  v_kind := lower(btrim(coalesce(nullif(p_environment_kind, ''), v_enrollment.environment_kind)));
  if v_kind not in ('aws','linux','cloud','container','wsl') then
    raise exception using errcode = '22023', message = 'REMOTE_ENVIRONMENT_KIND_INVALID';
  end if;

  if nullif(btrim(coalesce(p_existing_device_id, '')), '') is not null
    or nullif(btrim(coalesce(p_existing_credential, '')), '') is not null then
    if nullif(btrim(coalesce(p_existing_device_id, '')), '') is null
      or nullif(btrim(coalesce(p_existing_credential, '')), '') is null then
      raise exception using errcode = '22023', message = 'REMOTE_DEVICE_EXISTING_CREDENTIAL_INCOMPLETE';
    end if;
    select c.credential_hash into v_existing_hash
    from public.portmgr_remote_device_credentials c
    join public.portmgr_remote_devices d on d.device_id = c.device_id
    where c.device_id = btrim(p_existing_device_id) and d.revoked_at is null;
    if v_existing_hash is not null
      and v_existing_hash = encode(digest(p_existing_credential, 'sha256'), 'hex') then
      if coalesce(p_force_new, false) then
        v_previous_device_id := btrim(p_existing_device_id);
      else
        v_device_id := btrim(p_existing_device_id);
        v_credential := p_existing_credential;
      end if;
    end if;
  end if;

  -- Invalid or revoked local credentials cannot strand a server. A new
  -- one-time enrollment creates a distinct identity and preserves old rows.
  if v_device_id is null then
    v_device_id := gen_random_uuid()::text;
    v_credential := encode(gen_random_bytes(32), 'hex');
    insert into public.portmgr_remote_devices(
      device_id, display_name, hostname, platform, environment_kind, os_release, architecture, agent_version
    ) values (
      v_device_id, v_enrollment.requested_name, left(nullif(btrim(p_hostname), ''), 255),
      left(coalesce(nullif(btrim(p_platform), ''), 'linux'), 40), v_kind,
      left(nullif(btrim(p_os_release), ''), 255), left(nullif(btrim(p_architecture), ''), 80),
      left(nullif(btrim(p_agent_version), ''), 40)
    );
    insert into public.portmgr_remote_device_credentials(device_id, credential_hash)
    values (v_device_id, encode(digest(v_credential, 'sha256'), 'hex'));
  end if;

  update public.portmgr_remote_devices set
    display_name = v_enrollment.requested_name,
    hostname = coalesce(left(nullif(btrim(p_hostname), ''), 255), hostname),
    platform = left(coalesce(nullif(btrim(p_platform), ''), platform), 40),
    environment_kind = v_kind,
    os_release = coalesce(left(nullif(btrim(p_os_release), ''), 255), os_release),
    architecture = coalesce(left(nullif(btrim(p_architecture), ''), 80), architecture),
    agent_version = coalesce(left(nullif(btrim(p_agent_version), ''), 40), agent_version),
    revoked_at = null
  where portmgr_remote_devices.device_id = v_device_id;

  if v_previous_device_id is not null then
    insert into public.portmgr_remote_device_memory_access(device_id, memory_id)
    select v_device_id, access.memory_id
    from public.portmgr_remote_device_memory_access access
    where access.device_id = v_previous_device_id
    on conflict on constraint portmgr_remote_device_memory_access_pkey do nothing;

    update public.portmgr_remote_devices
    set revoked_at = coalesce(revoked_at, now())
    where portmgr_remote_devices.device_id = v_previous_device_id;
    delete from public.portmgr_remote_device_credentials
    where portmgr_remote_device_credentials.device_id = v_previous_device_id;
  end if;

  insert into public.portmgr_remote_device_memory_access(device_id, memory_id)
  values (v_device_id, v_enrollment.target_memory_id)
  on conflict on constraint portmgr_remote_device_memory_access_pkey do nothing;
  update public.portmgr_remote_device_enrollments set
    claimed_at = now(), claimed_device_id = v_device_id
  where id = v_enrollment.id;

  return query select v_device_id, v_credential, v_enrollment.target_memory_id, v_enrollment.requested_name;
end;
$$;

revoke all on function public.portmgr_claim_remote_device_enrollment(text,text,text,text,text,text,text,text,text,boolean) from public;
grant execute on function public.portmgr_claim_remote_device_enrollment(text,text,text,text,text,text,text,text,text,boolean) to anon,authenticated,service_role;
`;
