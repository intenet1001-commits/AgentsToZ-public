/** Canonical host-first enrollment and remote project inventory schema. */
export const REMOTE_HOST_PROJECTS_SQL = `
-- A cloud machine is registered before any project is attached. Projects are
-- inventory children of that host, not a prerequisite for the host identity.
alter table public.portmgr_remote_device_enrollments
  alter column target_memory_id drop not null;

alter table public.portmgr_remote_devices
  add column if not exists default_workspace_root text,
  add column if not exists inventory_updated_at timestamptz,
  add column if not exists project_count integer not null default 0;

create table if not exists public.portmgr_remote_device_projects (
  device_id text not null references public.portmgr_remote_devices(device_id) on delete cascade,
  project_path text not null,
  project_name text not null,
  workspace_root text,
  memory_id text,
  git_remote_url text,
  git_head_sha text,
  git_branch text,
  git_dirty boolean,
  registered boolean not null default false,
  present boolean not null default true,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  primary key (device_id, project_path),
  check (project_path ~ '^/' and char_length(project_path) <= 1024),
  check (char_length(project_name) between 1 and 160)
);
create index if not exists idx_portmgr_remote_device_projects_memory
  on public.portmgr_remote_device_projects(memory_id, last_observed_at desc);

alter table public.portmgr_remote_device_projects enable row level security;
drop policy if exists portmgr_authenticated_read on public.portmgr_remote_device_projects;
revoke all privileges on table public.portmgr_remote_device_projects from public, anon, authenticated, service_role;
grant select,insert,update,delete on table public.portmgr_remote_device_projects to service_role;
grant select on table public.portmgr_remote_device_projects to authenticated;
create policy portmgr_authenticated_read on public.portmgr_remote_device_projects
  for select to authenticated using ((select public.portmgr_is_member()));

create or replace function public.portmgr_create_remote_host_enrollment(
  p_token text,
  p_requested_name text,
  p_environment_kind text,
  p_ttl_seconds integer default 86400
)
returns table(enrollment_id text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id text := gen_random_uuid()::text;
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

  delete from public.portmgr_remote_device_enrollments e
  where e.claimed_at is null and e.expires_at < now() - interval '1 day';
  insert into public.portmgr_remote_device_enrollments(
    id, token_hash, requested_name, environment_kind, target_memory_id, expires_at
  ) values (
    v_id, encode(digest(p_token, 'sha256'), 'hex'), btrim(p_requested_name), v_kind, null, v_expires
  );
  return query select v_id, v_expires;
end;
$$;

create or replace function public.portmgr_claim_remote_host_enrollment(
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
returns table(device_id text, device_credential text, device_name text)
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
    and e.target_memory_id is null
    and e.claimed_at is null and e.expires_at > now()
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
    select v_device_id, access.memory_id
    from public.portmgr_remote_device_memory_access access
    where access.device_id = v_previous_device_id
    on conflict on constraint portmgr_remote_device_memory_access_pkey do nothing;
    insert into public.portmgr_remote_device_projects(
      device_id, project_path, project_name, workspace_root, memory_id,
      git_remote_url, git_head_sha, git_branch, git_dirty, registered,
      present, first_observed_at, last_observed_at
    ) select
      v_device_id, project_path, project_name, workspace_root, memory_id,
      git_remote_url, git_head_sha, git_branch, git_dirty, registered,
      false, first_observed_at, last_observed_at
    from public.portmgr_remote_device_projects
    where device_id = v_previous_device_id
    on conflict on constraint portmgr_remote_device_projects_pkey do nothing;
    update public.portmgr_remote_devices
    set revoked_at = coalesce(revoked_at, now())
    where portmgr_remote_devices.device_id = v_previous_device_id;
    delete from public.portmgr_remote_device_credentials
    where portmgr_remote_device_credentials.device_id = v_previous_device_id;
  end if;

  update public.portmgr_remote_device_enrollments set
    claimed_at = now(), claimed_device_id = v_device_id
  where id = v_enrollment.id;
  return query select v_device_id, v_credential, v_enrollment.requested_name;
end;
$$;

create or replace function public.portmgr_report_remote_device_inventory(
  p_device_id text,
  p_device_credential text,
  p_workspace_root text,
  p_projects jsonb
)
returns table(device_id text, project_count integer, inventory_updated_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text;
  v_now timestamptz := now();
  v_project jsonb;
  v_path text;
  v_name text;
  v_count integer := 0;
begin
  select c.credential_hash into v_hash
  from public.portmgr_remote_device_credentials c
  join public.portmgr_remote_devices d on d.device_id = c.device_id
  where c.device_id = p_device_id and d.revoked_at is null;
  if v_hash is null or p_device_credential is null
    or v_hash <> encode(digest(p_device_credential, 'sha256'), 'hex') then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_CREDENTIAL_INVALID';
  end if;
  if p_workspace_root is null or p_workspace_root !~ '^/' or char_length(p_workspace_root) > 1024 then
    raise exception using errcode = '22023', message = 'REMOTE_WORKSPACE_ROOT_INVALID';
  end if;
  if jsonb_typeof(p_projects) <> 'array' or jsonb_array_length(p_projects) > 500 then
    raise exception using errcode = '22023', message = 'REMOTE_PROJECT_INVENTORY_INVALID';
  end if;

  update public.portmgr_remote_device_projects set present = false
  where portmgr_remote_device_projects.device_id = p_device_id;
  for v_project in select value from jsonb_array_elements(p_projects) loop
    v_path := nullif(btrim(v_project ->> 'project_path'), '');
    v_name := nullif(btrim(v_project ->> 'project_name'), '');
    if v_path is null or v_path !~ '^/' or char_length(v_path) > 1024
      or v_name is null or char_length(v_name) > 160 then
      raise exception using errcode = '22023', message = 'REMOTE_PROJECT_INVENTORY_ROW_INVALID';
    end if;
    insert into public.portmgr_remote_device_projects(
      device_id, project_path, project_name, workspace_root, memory_id,
      git_remote_url, git_head_sha, git_branch, git_dirty, registered,
      present, first_observed_at, last_observed_at
    ) values (
      p_device_id, v_path, v_name, p_workspace_root,
      nullif(btrim(v_project ->> 'memory_id'), ''),
      nullif(btrim(v_project ->> 'git_remote_url'), ''),
      nullif(btrim(v_project ->> 'git_head_sha'), ''),
      nullif(btrim(v_project ->> 'git_branch'), ''),
      case when v_project ? 'git_dirty' then (v_project ->> 'git_dirty')::boolean else null end,
      coalesce((v_project ->> 'registered')::boolean, false),
      true, v_now, v_now
    ) on conflict on constraint portmgr_remote_device_projects_pkey do update set
      project_name = excluded.project_name,
      workspace_root = excluded.workspace_root,
      memory_id = excluded.memory_id,
      git_remote_url = excluded.git_remote_url,
      git_head_sha = excluded.git_head_sha,
      git_branch = excluded.git_branch,
      git_dirty = excluded.git_dirty,
      registered = excluded.registered,
      present = true,
      last_observed_at = v_now;
    v_count := v_count + 1;
  end loop;

  update public.portmgr_remote_devices set
    default_workspace_root = p_workspace_root,
    inventory_updated_at = v_now,
    project_count = v_count,
    last_seen_at = v_now
  where portmgr_remote_devices.device_id = p_device_id;
  return query select p_device_id, v_count, v_now;
end;
$$;

revoke all on function public.portmgr_create_remote_host_enrollment(text,text,text,integer) from public,anon;
revoke all on function public.portmgr_claim_remote_host_enrollment(text,text,text,text,text,text,text,text,text,boolean) from public;
revoke all on function public.portmgr_report_remote_device_inventory(text,text,text,jsonb) from public;
grant execute on function public.portmgr_create_remote_host_enrollment(text,text,text,integer) to authenticated,service_role;
grant execute on function public.portmgr_claim_remote_host_enrollment(text,text,text,text,text,text,text,text,text,boolean) to anon,authenticated,service_role;
grant execute on function public.portmgr_report_remote_device_inventory(text,text,text,jsonb) to anon,authenticated,service_role;

comment on table public.portmgr_remote_device_projects is
  'Latest recoverable host inventory. Missing projects remain as present=false history; project content stays on the host.';
`;
