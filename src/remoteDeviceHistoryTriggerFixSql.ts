export const REMOTE_DEVICE_HISTORY_TRIGGER_FIX_SQL = String.raw`-- OLD is a PL/pgSQL trigger record; never reuse it as a table alias.
create or replace function public.portmgr_inherit_revoked_remote_host_on_seen()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_previous text;
begin
  select e.previous_device_id into v_previous
  from public.portmgr_remote_device_enrollments e
  join public.portmgr_remote_devices predecessor
    on predecessor.device_id = e.previous_device_id
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
$$;`;
