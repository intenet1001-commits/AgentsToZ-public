-- Headless hosts (AWS/Linux/containers) cannot open the desktop setup wizard.
-- A member creates a short-lived one-time enrollment; the host claims it with
-- the public anon key and receives a host-scoped credential. The service role
-- never leaves the local sidecar/Supabase boundary.
create extension if not exists pgcrypto with schema extensions;

alter table public.portmgr_project_memory_devices
  add column if not exists source_path text,
  add column if not exists git_fetch_ok boolean,
  add column if not exists git_fetch_error text;

create table if not exists public.portmgr_remote_devices (
  device_id text primary key,
  display_name text not null check (char_length(display_name) between 1 and 80),
  hostname text,
  platform text not null default 'linux',
  environment_kind text not null default 'linux'
    check (environment_kind in ('aws','linux','cloud','container','wsl')),
  os_release text,
  architecture text,
  agent_version text,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.portmgr_remote_device_credentials (
  device_id text primary key references public.portmgr_remote_devices(device_id) on delete cascade,
  credential_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table if not exists public.portmgr_remote_device_enrollments (
  id text primary key,
  token_hash text not null unique,
  requested_name text not null,
  environment_kind text not null,
  target_memory_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_device_id text references public.portmgr_remote_devices(device_id)
);
create index if not exists idx_portmgr_remote_device_enrollments_expiry
  on public.portmgr_remote_device_enrollments(expires_at);

create table if not exists public.portmgr_remote_device_memory_access (
  device_id text not null references public.portmgr_remote_devices(device_id) on delete cascade,
  memory_id text not null,
  granted_at timestamptz not null default now(),
  primary key (device_id, memory_id)
);

-- Physical-device lineage is separate from project-memory lineage. Linking an
-- old installation id never rewrites or deletes revision history.
create table if not exists public.portmgr_device_identity_aliases (
  alias_device_id text primary key,
  canonical_device_id text not null,
  linked_at timestamptz not null default now(),
  check (alias_device_id <> canonical_device_id)
);
create index if not exists idx_portmgr_device_identity_aliases_canonical
  on public.portmgr_device_identity_aliases(canonical_device_id);

do $$
declare t text;
begin
  foreach t in array array[
    'portmgr_remote_devices',
    'portmgr_remote_device_credentials',
    'portmgr_remote_device_enrollments',
    'portmgr_remote_device_memory_access',
    'portmgr_device_identity_aliases'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists portmgr_authenticated_read on public.%I', t);
    execute format('revoke all privileges on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select,insert,update,delete on table public.%I to service_role', t);
  end loop;
end $$;

create policy portmgr_authenticated_read on public.portmgr_remote_devices
  for select to authenticated using ((select public.portmgr_is_member()));
create policy portmgr_authenticated_read on public.portmgr_device_identity_aliases
  for select to authenticated using ((select public.portmgr_is_member()));
grant select on table public.portmgr_remote_devices to authenticated;
grant select on table public.portmgr_device_identity_aliases to authenticated;

create or replace function public.portmgr_create_remote_device_enrollment(
  p_token text,
  p_requested_name text,
  p_environment_kind text,
  p_target_memory_id text,
  p_ttl_seconds integer default 600
)
returns table(enrollment_id text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id text := gen_random_uuid()::text;
  v_memory text := public.portmgr_resolve_project_memory_id(p_target_memory_id);
  v_expires timestamptz := now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 600), 60), 1800));
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

create or replace function public.portmgr_remote_device_enrollment_status(p_enrollment_id text)
returns table(
  claimed boolean,
  device_id text,
  device_name text,
  claimed_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  return query
    select e.claimed_at is not null, e.claimed_device_id, d.display_name, e.claimed_at, d.last_seen_at
    from public.portmgr_remote_device_enrollments e
    left join public.portmgr_remote_devices d on d.device_id = e.claimed_device_id
    where e.id = p_enrollment_id;
end;
$$;

create or replace function public.portmgr_claim_remote_device_enrollment(
  p_token text,
  p_hostname text,
  p_platform text,
  p_environment_kind text,
  p_os_release text,
  p_architecture text,
  p_agent_version text,
  p_existing_device_id text default null,
  p_existing_credential text default null
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
      v_device_id := btrim(p_existing_device_id);
      v_credential := p_existing_credential;
    end if;
  end if;

  -- A revoked or otherwise stale local credential must not strand the host.
  -- A fresh one-time enrollment intentionally creates a new identity while the
  -- old row remains as immutable operational history.
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

  insert into public.portmgr_remote_device_memory_access(device_id, memory_id)
  values (v_device_id, v_enrollment.target_memory_id)
  on conflict on constraint portmgr_remote_device_memory_access_pkey do nothing;
  update public.portmgr_remote_device_enrollments set
    claimed_at = now(), claimed_device_id = v_device_id
  where id = v_enrollment.id;

  return query select v_device_id, v_credential, v_enrollment.target_memory_id, v_enrollment.requested_name;
end;
$$;

create or replace function public.portmgr_update_remote_device(
  p_device_id text,
  p_display_name text default null,
  p_revoked boolean default null
)
returns table(device_id text, display_name text, revoked_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_id text := btrim(coalesce(p_device_id, ''));
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if v_id = '' or not exists (
    select 1 from public.portmgr_remote_devices d where d.device_id = v_id
  ) then
    raise exception using errcode = '22023', message = 'REMOTE_DEVICE_NOT_FOUND';
  end if;
  if p_display_name is not null and (v_name is null or char_length(v_name) > 80) then
    raise exception using errcode = '22023', message = 'REMOTE_DEVICE_NAME_INVALID';
  end if;

  update public.portmgr_remote_devices d set
    display_name = coalesce(v_name, d.display_name),
    revoked_at = case
      when p_revoked is true then coalesce(d.revoked_at, now())
      when p_revoked is false then null
      else d.revoked_at
    end
  where d.device_id = v_id;

  -- Registration removal is a credential revocation, not historical deletion.
  -- This preserves memory/Git observations for audit and orphan recovery.
  if p_revoked is true then
    delete from public.portmgr_remote_device_credentials c where c.device_id = v_id;
  end if;

  return query
    select d.device_id, d.display_name, d.revoked_at
    from public.portmgr_remote_devices d where d.device_id = v_id;
end;
$$;

create or replace function public.portmgr_report_remote_device_status(
  p_device_id text,
  p_device_credential text,
  p_memory_id text,
  p_source_path text,
  p_content_hash text,
  p_git_head_sha text,
  p_git_branch text,
  p_git_remote_url text,
  p_git_upstream_sha text,
  p_git_ahead integer,
  p_git_behind integer,
  p_git_dirty boolean,
  p_git_commit_at timestamptz,
  p_git_fetch_ok boolean,
  p_git_fetch_error text
)
returns table(memory_id text, in_sync boolean, observed_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_memory text := public.portmgr_resolve_project_memory_id(p_memory_id);
  v_credential_hash text;
  v_device_name text;
  v_revision_id text;
  v_remote_hash text;
  v_now timestamptz := now();
  v_in_sync boolean := false;
begin
  select c.credential_hash, d.display_name into v_credential_hash, v_device_name
  from public.portmgr_remote_device_credentials c
  join public.portmgr_remote_devices d on d.device_id = c.device_id
  where c.device_id = btrim(coalesce(p_device_id, '')) and d.revoked_at is null;
  if v_credential_hash is null
    or v_credential_hash <> encode(digest(coalesce(p_device_credential, ''), 'sha256'), 'hex') then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_CREDENTIAL_INVALID';
  end if;
  if not exists (
    select 1 from public.portmgr_remote_device_memory_access a
    where a.device_id = p_device_id and public.portmgr_resolve_project_memory_id(a.memory_id) = v_memory
  ) then
    raise exception using errcode = '42501', message = 'REMOTE_DEVICE_MEMORY_NOT_GRANTED';
  end if;
  if p_source_path is null or char_length(btrim(p_source_path)) not between 1 and 1024 then
    raise exception using errcode = '22023', message = 'REMOTE_PROJECT_PATH_INVALID';
  end if;
  if p_content_hash is not null and p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'REMOTE_MEMORY_HASH_INVALID';
  end if;
  if p_git_head_sha is not null and p_git_head_sha !~ '^[0-9a-f]{7,64}$' then
    raise exception using errcode = '22023', message = 'REMOTE_GIT_HEAD_INVALID';
  end if;
  if p_git_upstream_sha is not null and p_git_upstream_sha !~ '^[0-9a-f]{7,64}$' then
    raise exception using errcode = '22023', message = 'REMOTE_GIT_UPSTREAM_INVALID';
  end if;

  select r.id, r.content_hash into v_revision_id, v_remote_hash
  from public.portmgr_project_memory_revisions r
  where public.portmgr_resolve_project_memory_id(r.memory_id) = v_memory
  order by r.created_at desc nulls last, r.id desc limit 1;
  v_in_sync := p_content_hash is not null and p_content_hash = v_remote_hash;

  insert into public.portmgr_project_memory_devices(
    memory_id, device_id, device_name, platform, revision_id, content_hash,
    last_synced_at, last_seen_at, source_path,
    git_head_sha, git_branch, git_remote_url, git_upstream_sha,
    git_ahead, git_behind, git_dirty, git_commit_at, git_checked_at,
    git_fetch_ok, git_fetch_error
  ) values (
    v_memory, p_device_id, v_device_name, 'linux', case when v_in_sync then v_revision_id else null end,
    p_content_hash, case when v_in_sync then v_now else null end, v_now, btrim(p_source_path),
    p_git_head_sha, left(nullif(btrim(p_git_branch), ''), 255), left(nullif(btrim(p_git_remote_url), ''), 1024),
    p_git_upstream_sha, least(greatest(coalesce(p_git_ahead, 0), 0), 1000000),
    least(greatest(coalesce(p_git_behind, 0), 0), 1000000), p_git_dirty, p_git_commit_at, v_now,
    p_git_fetch_ok, left(nullif(btrim(p_git_fetch_error), ''), 500)
  ) on conflict on constraint portmgr_project_memory_devices_pkey do update set
    device_name = excluded.device_name,
    platform = excluded.platform,
    revision_id = excluded.revision_id,
    content_hash = excluded.content_hash,
    last_synced_at = coalesce(excluded.last_synced_at, portmgr_project_memory_devices.last_synced_at),
    last_seen_at = excluded.last_seen_at,
    source_path = excluded.source_path,
    git_head_sha = excluded.git_head_sha,
    git_branch = excluded.git_branch,
    git_remote_url = excluded.git_remote_url,
    git_upstream_sha = excluded.git_upstream_sha,
    git_ahead = excluded.git_ahead,
    git_behind = excluded.git_behind,
    git_dirty = excluded.git_dirty,
    git_commit_at = excluded.git_commit_at,
    git_checked_at = excluded.git_checked_at,
    git_fetch_ok = excluded.git_fetch_ok,
    git_fetch_error = excluded.git_fetch_error;

  update public.portmgr_remote_devices set last_seen_at = v_now
  where portmgr_remote_devices.device_id = p_device_id;
  return query select v_memory, v_in_sync, v_now;
end;
$$;

create or replace function public.portmgr_set_device_identity_alias(
  p_alias_device_id text,
  p_canonical_device_id text default null
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_alias text := btrim(coalesce(p_alias_device_id, ''));
  v_canonical text := nullif(btrim(coalesce(p_canonical_device_id, '')), '');
  v_cursor text;
  v_next text;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if v_alias = '' then
    raise exception using errcode = '22023', message = 'DEVICE_ALIAS_REQUIRED';
  end if;
  if v_canonical is null then
    delete from public.portmgr_device_identity_aliases where alias_device_id = v_alias;
    return false;
  end if;
  if v_alias = v_canonical then
    raise exception using errcode = '22023', message = 'DEVICE_ALIAS_SELF_REFERENCE';
  end if;

  v_cursor := v_canonical;
  for i in 1..20 loop
    if v_cursor = v_alias then
      raise exception using errcode = '22023', message = 'DEVICE_ALIAS_CYCLE';
    end if;
    select a.canonical_device_id into v_next
    from public.portmgr_device_identity_aliases a where a.alias_device_id = v_cursor;
    exit when v_next is null;
    v_cursor := v_next;
    v_next := null;
  end loop;
  if v_next is not null then
    raise exception using errcode = '22023', message = 'DEVICE_ALIAS_CHAIN_TOO_DEEP';
  end if;

  insert into public.portmgr_device_identity_aliases(alias_device_id, canonical_device_id, linked_at)
  values (v_alias, v_cursor, now())
  on conflict (alias_device_id) do update
  set canonical_device_id = excluded.canonical_device_id, linked_at = excluded.linked_at;
  update public.portmgr_device_identity_aliases
  set canonical_device_id = v_cursor, linked_at = now()
  where canonical_device_id = v_alias and alias_device_id <> v_cursor;
  return true;
end;
$$;

revoke all on function public.portmgr_create_remote_device_enrollment(text,text,text,text,integer) from public,anon;
revoke all on function public.portmgr_remote_device_enrollment_status(text) from public,anon;
revoke all on function public.portmgr_set_device_identity_alias(text,text) from public,anon;
revoke all on function public.portmgr_update_remote_device(text,text,boolean) from public,anon;
grant execute on function public.portmgr_create_remote_device_enrollment(text,text,text,text,integer) to authenticated,service_role;
grant execute on function public.portmgr_remote_device_enrollment_status(text) to authenticated,service_role;
grant execute on function public.portmgr_set_device_identity_alias(text,text) to authenticated,service_role;
grant execute on function public.portmgr_update_remote_device(text,text,boolean) to authenticated,service_role;

revoke all on function public.portmgr_claim_remote_device_enrollment(text,text,text,text,text,text,text,text,text) from public;
revoke all on function public.portmgr_report_remote_device_status(text,text,text,text,text,text,text,text,text,integer,integer,boolean,timestamptz,boolean,text) from public;
grant execute on function public.portmgr_claim_remote_device_enrollment(text,text,text,text,text,text,text,text,text) to anon,authenticated,service_role;
grant execute on function public.portmgr_report_remote_device_status(text,text,text,text,text,text,text,text,text,integer,integer,boolean,timestamptz,boolean,text) to anon,authenticated,service_role;

comment on table public.portmgr_remote_device_credentials is
  'Server-only hashes for headless host credentials; raw credentials are returned once at claim time.';
comment on column public.portmgr_project_memory_devices.source_path is
  'Absolute project path reported by the device; never interpreted on another host.';
comment on column public.portmgr_project_memory_devices.git_fetch_ok is
  'Whether the reporting headless agent refreshed its Git remote before collecting upstream state.';
