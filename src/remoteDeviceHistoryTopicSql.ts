export const REMOTE_DEVICE_HISTORY_TOPIC_SQL = String.raw`-- Restore a revoked host as one physical-device lineage and preserve Telegram topic metadata.
alter table public.portmgr_remote_device_projects
  add column if not exists telegram_chat_id text,
  add column if not exists telegram_thread_id text;

create or replace function public.portmgr_create_remote_host_reconnect_enrollment(
  p_token text,
  p_requested_name text,
  p_environment_kind text,
  p_previous_device_id text,
  p_ttl_seconds integer default 86400
)
returns table(enrollment_id text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id text := gen_random_uuid()::text;
  v_expires timestamptz := now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 86400), 60), 86400));
  v_kind text := lower(btrim(coalesce(p_environment_kind, 'linux')));
  v_previous text := btrim(coalesce(p_previous_device_id, ''));
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
  if not exists (
    select 1 from public.portmgr_remote_devices d
    where d.device_id = v_previous and d.revoked_at is not null
  ) then
    raise exception using errcode = '22023', message = 'REMOTE_RECONNECT_HISTORY_NOT_FOUND';
  end if;

  insert into public.portmgr_remote_device_enrollments(
    id, token_hash, requested_name, environment_kind, target_memory_id,
    expires_at, previous_device_id
  ) values (
    v_id, encode(digest(p_token, 'sha256'), 'hex'), btrim(p_requested_name),
    v_kind, null, v_expires, v_previous
  );
  return query select v_id, v_expires;
end;
$$;

create or replace function public.portmgr_inherit_revoked_remote_host_on_seen()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_previous text;
begin
  select e.previous_device_id into v_previous
  from public.portmgr_remote_device_enrollments e
  join public.portmgr_remote_devices predecessor on predecessor.device_id = e.previous_device_id
  where e.claimed_device_id = new.device_id
    and e.claimed_at is not null
    and predecessor.revoked_at is not null
  order by e.claimed_at desc
  limit 1;
  if v_previous is null then return new; end if;

  insert into public.portmgr_remote_device_memory_access(device_id, memory_id)
  select new.device_id, access.memory_id
  from public.portmgr_remote_device_memory_access access
  where access.device_id = v_previous
  on conflict on constraint portmgr_remote_device_memory_access_pkey do nothing;

  insert into public.portmgr_remote_device_projects(
    device_id, project_path, project_name, workspace_root, memory_id,
    git_remote_url, git_head_sha, git_branch, git_dirty, registered,
    present, first_observed_at, last_observed_at, telegram_chat_id, telegram_thread_id
  ) select
    new.device_id, source.project_path, source.project_name, source.workspace_root, source.memory_id,
    source.git_remote_url, source.git_head_sha, source.git_branch, source.git_dirty, source.registered,
    false, source.first_observed_at, source.last_observed_at,
    source.telegram_chat_id, source.telegram_thread_id
  from public.portmgr_remote_device_projects source
  where source.device_id = v_previous
  on conflict on constraint portmgr_remote_device_projects_pkey do update set
    memory_id = coalesce(excluded.memory_id, portmgr_remote_device_projects.memory_id),
    git_remote_url = coalesce(excluded.git_remote_url, portmgr_remote_device_projects.git_remote_url),
    git_head_sha = coalesce(excluded.git_head_sha, portmgr_remote_device_projects.git_head_sha),
    telegram_chat_id = coalesce(excluded.telegram_chat_id, portmgr_remote_device_projects.telegram_chat_id),
    telegram_thread_id = coalesce(excluded.telegram_thread_id, portmgr_remote_device_projects.telegram_thread_id),
    last_observed_at = greatest(excluded.last_observed_at, portmgr_remote_device_projects.last_observed_at);

  insert into public.portmgr_device_identity_aliases(alias_device_id, canonical_device_id, linked_at)
  values (v_previous, new.device_id, now())
  on conflict (alias_device_id) do update
  set canonical_device_id = excluded.canonical_device_id, linked_at = excluded.linked_at;
  update public.portmgr_device_identity_aliases
  set canonical_device_id = new.device_id, linked_at = now()
  where canonical_device_id = v_previous and alias_device_id <> new.device_id;
  return new;
end;
$$;

drop trigger if exists portmgr_inherit_revoked_remote_host_on_seen on public.portmgr_remote_devices;
create trigger portmgr_inherit_revoked_remote_host_on_seen
after update of last_seen_at on public.portmgr_remote_devices
for each row when (new.last_seen_at is distinct from old.last_seen_at)
execute function public.portmgr_inherit_revoked_remote_host_on_seen();

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
      present, first_observed_at, last_observed_at, telegram_chat_id, telegram_thread_id
    ) values (
      p_device_id, v_path, v_name, p_workspace_root,
      nullif(btrim(v_project ->> 'memory_id'), ''),
      nullif(btrim(v_project ->> 'git_remote_url'), ''),
      nullif(btrim(v_project ->> 'git_head_sha'), ''),
      nullif(btrim(v_project ->> 'git_branch'), ''),
      case when v_project ? 'git_dirty' then (v_project ->> 'git_dirty')::boolean else null end,
      coalesce((v_project ->> 'registered')::boolean, false),
      true, v_now, v_now,
      nullif(btrim(v_project ->> 'telegram_chat_id'), ''),
      nullif(btrim(v_project ->> 'telegram_thread_id'), '')
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
      telegram_chat_id = excluded.telegram_chat_id,
      telegram_thread_id = excluded.telegram_thread_id,
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

revoke all on function public.portmgr_create_remote_host_reconnect_enrollment(text,text,text,text,integer) from public,anon;
grant execute on function public.portmgr_create_remote_host_reconnect_enrollment(text,text,text,text,integer) to authenticated,service_role;
revoke all on function public.portmgr_report_remote_device_inventory(text,text,text,jsonb) from public;
grant execute on function public.portmgr_report_remote_device_inventory(text,text,text,jsonb) to anon,authenticated,service_role;`;
