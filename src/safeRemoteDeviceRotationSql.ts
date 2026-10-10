export const SAFE_REMOTE_DEVICE_ROTATION_SQL = String.raw`-- A force reconnect is a two-phase rotation. Claiming creates the replacement
-- identity but keeps the previous credential alive until the host confirms that
-- its atomic local config update succeeded.
alter table public.portmgr_remote_device_enrollments
  add column if not exists previous_device_id text references public.portmgr_remote_devices(device_id);

drop function if exists public.portmgr_claim_remote_host_enrollment(text,text,text,text,text,text,text,text,text,boolean);

create function public.portmgr_claim_remote_host_enrollment(
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
returns table(device_id text, device_credential text, device_name text, previous_device_id text)
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
  select * into v_enrollment from public.portmgr_remote_device_enrollments e
  where e.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and e.target_memory_id is null and e.claimed_at is null and e.expires_at > now()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'REMOTE_HOST_ENROLLMENT_EXPIRED_OR_CLAIMED';
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
    select v_device_id, access.memory_id from public.portmgr_remote_device_memory_access access
    where access.device_id = v_previous_device_id
    on conflict on constraint portmgr_remote_device_memory_access_pkey do nothing;
    insert into public.portmgr_remote_device_projects(
      device_id, project_path, project_name, workspace_root, memory_id,
      git_remote_url, git_head_sha, git_branch, git_dirty, registered,
      present, first_observed_at, last_observed_at
    ) select
      v_device_id, source.project_path, source.project_name, source.workspace_root, source.memory_id,
      source.git_remote_url, source.git_head_sha, source.git_branch, source.git_dirty, source.registered,
      false, source.first_observed_at, source.last_observed_at
    from public.portmgr_remote_device_projects source where source.device_id = v_previous_device_id
    on conflict on constraint portmgr_remote_device_projects_pkey do nothing;
  end if;

  update public.portmgr_remote_device_enrollments set
    claimed_at = now(), claimed_device_id = v_device_id, previous_device_id = v_previous_device_id
  where id = v_enrollment.id;
  return query select v_device_id, v_credential, v_enrollment.requested_name, v_previous_device_id;
end;
$$;

create or replace function public.portmgr_finalize_remote_device_rotation(
  p_device_id text,
  p_device_credential text,
  p_previous_device_id text
)
returns table(device_id text, previous_device_id text, finalized boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text;
begin
  select c.credential_hash into v_hash
  from public.portmgr_remote_device_credentials c
  join public.portmgr_remote_devices d on d.device_id = c.device_id
  where c.device_id = p_device_id and d.revoked_at is null;
  if v_hash is null or p_device_credential is null
    or v_hash <> encode(digest(p_device_credential, 'sha256'), 'hex') then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_CREDENTIAL_INVALID';
  end if;
  if p_previous_device_id is null or p_previous_device_id = p_device_id then
    raise exception using errcode = '22023', message = 'REMOTE_DEVICE_ROTATION_PREVIOUS_INVALID';
  end if;
  if not exists (
    select 1 from public.portmgr_remote_device_enrollments enrollment
    where enrollment.claimed_device_id = p_device_id
      and enrollment.previous_device_id = p_previous_device_id
      and enrollment.claimed_at is not null
  ) then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_ROTATION_NOT_AUTHORIZED';
  end if;

  insert into public.portmgr_remote_device_memory_access(device_id, memory_id)
  select p_device_id, access.memory_id from public.portmgr_remote_device_memory_access access
  where access.device_id = p_previous_device_id
  on conflict on constraint portmgr_remote_device_memory_access_pkey do nothing;
  insert into public.portmgr_remote_device_projects(
    device_id, project_path, project_name, workspace_root, memory_id,
    git_remote_url, git_head_sha, git_branch, git_dirty, registered,
    present, first_observed_at, last_observed_at
  ) select
    p_device_id, source.project_path, source.project_name, source.workspace_root, source.memory_id,
    source.git_remote_url, source.git_head_sha, source.git_branch, source.git_dirty, source.registered,
    false, source.first_observed_at, source.last_observed_at
  from public.portmgr_remote_device_projects source where source.device_id = p_previous_device_id
  on conflict on constraint portmgr_remote_device_projects_pkey do update set
    memory_id = coalesce(excluded.memory_id, portmgr_remote_device_projects.memory_id),
    git_remote_url = coalesce(excluded.git_remote_url, portmgr_remote_device_projects.git_remote_url),
    git_head_sha = coalesce(excluded.git_head_sha, portmgr_remote_device_projects.git_head_sha),
    last_observed_at = greatest(excluded.last_observed_at, portmgr_remote_device_projects.last_observed_at);

  update public.portmgr_remote_devices set revoked_at = coalesce(revoked_at, now())
  where portmgr_remote_devices.device_id = p_previous_device_id;
  delete from public.portmgr_remote_device_credentials
  where portmgr_remote_device_credentials.device_id = p_previous_device_id;
  return query select p_device_id, p_previous_device_id, true;
end;
$$;

revoke all on function public.portmgr_claim_remote_host_enrollment(text,text,text,text,text,text,text,text,text,boolean) from public;
revoke all on function public.portmgr_finalize_remote_device_rotation(text,text,text) from public;
grant execute on function public.portmgr_claim_remote_host_enrollment(text,text,text,text,text,text,text,text,text,boolean) to anon,authenticated,service_role;
grant execute on function public.portmgr_finalize_remote_device_rotation(text,text,text) to anon,authenticated,service_role;

comment on function public.portmgr_finalize_remote_device_rotation(text,text,text) is
  'Revokes the prior credential only after the replacement host has durably stored its new identity.';`;
