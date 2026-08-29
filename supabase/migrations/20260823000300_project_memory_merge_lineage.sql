-- Safe two-phase project-memory lineage merge. Old IDs remain permanent aliases;
-- known devices acknowledge the new canonical ID as they next complete a sync.
create extension if not exists pgcrypto with schema extensions;
create table if not exists public.portmgr_project_memory_labels (
  memory_id text primary key,
  display_name text not null check (char_length(display_name) between 1 and 60),
  updated_at timestamptz not null default now()
);

create table if not exists public.portmgr_project_memory_merges (
  id text primary key,
  source_memory_ids text[] not null,
  target_memory_id text not null,
  source_head_revision_ids text[] not null,
  merged_revision_id text,
  repository_strategy text not null check (repository_strategy in ('a', 'b', 'new', 'memory-only')),
  repository_url text,
  status text not null default 'awaiting-devices' check (status in ('awaiting-devices', 'complete')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.portmgr_project_memory_aliases (
  alias_memory_id text primary key,
  canonical_memory_id text not null,
  merge_id text not null references public.portmgr_project_memory_merges(id),
  created_at timestamptz not null default now(),
  all_known_devices_migrated_at timestamptz,
  check (alias_memory_id <> canonical_memory_id)
);
create index if not exists idx_portmgr_project_memory_aliases_canonical
  on public.portmgr_project_memory_aliases(canonical_memory_id);

create table if not exists public.portmgr_project_memory_merge_devices (
  merge_id text not null references public.portmgr_project_memory_merges(id),
  device_id text not null,
  previous_memory_id text not null,
  device_name text,
  adopted_at timestamptz,
  primary key (merge_id, device_id, previous_memory_id)
);

create or replace function public.portmgr_resolve_project_memory_id(p_memory_id text)
returns text language plpgsql stable security invoker set search_path = public as $$
declare
  v_current text := p_memory_id;
  v_next text;
  v_depth integer;
begin
  if v_current is null or btrim(v_current) = '' then return v_current; end if;
  for v_depth in 1..20 loop
    select a.canonical_memory_id into v_next
    from public.portmgr_project_memory_aliases a
    where a.alias_memory_id = v_current;
    if v_next is null then return v_current; end if;
    if v_next = v_current then
      raise exception using errcode = 'P0001', message = 'PROJECT_MEMORY_ALIAS_CYCLE';
    end if;
    v_current := v_next;
    v_next := null;
  end loop;
  raise exception using errcode = 'P0001', message = 'PROJECT_MEMORY_ALIAS_CHAIN_TOO_DEEP';
end;
$$;

-- Existing repository claims now follow lineage aliases instead of reviving an
-- old ID. This is the phone-number-forwarding part of the transition.
create or replace function public.portmgr_claim_project_memory(
  p_repository_key text, p_proposed_memory_id text
)
returns table(memory_id text, claimed boolean)
language plpgsql security invoker set search_path = public as $$
declare
  v_key text := public.portmgr_canonical_repo_key(p_repository_key);
  v_existing text;
  v_legacy_ids text[];
begin
  if v_key is null or v_key = '' then
    raise exception using errcode = '22023', message = 'canonical repository key is required';
  end if;
  if p_proposed_memory_id is null or btrim(p_proposed_memory_id) = '' then
    raise exception using errcode = '22023', message = 'proposed memory id is required';
  end if;
  select m.memory_id into v_existing from public.portmgr_project_memories m
  where m.canonical_repo_key = v_key for update;
  if v_existing is not null then
    return query select public.portmgr_resolve_project_memory_id(v_existing), false;
    return;
  end if;
  select array_agg(distinct public.portmgr_resolve_project_memory_id(r.memory_id)
                   order by public.portmgr_resolve_project_memory_id(r.memory_id))
    into v_legacy_ids
  from public.portmgr_project_memory_revisions r
  where public.portmgr_canonical_repo_key(r.github_url) = v_key;
  if coalesce(array_length(v_legacy_ids, 1), 0) > 1 then
    raise exception using errcode = 'P0001', message = 'PROJECT_MEMORY_IDENTITY_AMBIGUOUS',
      detail = array_to_string(v_legacy_ids, ',');
  end if;
  v_existing := coalesce(v_legacy_ids[1], public.portmgr_resolve_project_memory_id(p_proposed_memory_id));
  insert into public.portmgr_project_memories(memory_id, canonical_repo_key)
  values (v_existing, v_key) on conflict (canonical_repo_key) do nothing;
  select public.portmgr_resolve_project_memory_id(m.memory_id) into v_existing
  from public.portmgr_project_memories m where m.canonical_repo_key = v_key;
  return query select v_existing, true;
end;
$$;

create or replace function public.portmgr_guard_project_memory_revision_insert()
returns trigger language plpgsql security invoker set search_path = public as $$
declare
  v_head text;
  v_key text := public.portmgr_canonical_repo_key(new.github_url);
  v_registered_memory_id text;
begin
  if v_key is not null then
    insert into public.portmgr_project_memories(memory_id, canonical_repo_key)
    values (new.memory_id, v_key) on conflict (canonical_repo_key) do nothing;
    select public.portmgr_resolve_project_memory_id(m.memory_id) into v_registered_memory_id
    from public.portmgr_project_memories m where m.canonical_repo_key = v_key for update;
    if v_registered_memory_id is distinct from public.portmgr_resolve_project_memory_id(new.memory_id) then
      raise exception using errcode = 'P0001', message = 'PROJECT_MEMORY_IDENTITY_MISMATCH', detail = v_registered_memory_id;
    end if;
  end if;
  insert into public.portmgr_project_memory_heads(memory_id, head_revision_id)
  values (new.memory_id, null) on conflict (memory_id) do nothing;
  select h.head_revision_id into v_head from public.portmgr_project_memory_heads h
  where h.memory_id = new.memory_id for update;
  if v_head is distinct from new.parent_revision_id then
    raise exception using errcode = '40001', message = 'PROJECT_MEMORY_STALE_PARENT', detail = coalesce(v_head, 'null');
  end if;
  update public.portmgr_project_memory_heads set head_revision_id = new.id, updated_at = now()
  where memory_id = new.memory_id;
  return new;
end;
$$;

create or replace function public.portmgr_merge_project_memories(
  p_memory_a text,
  p_memory_b text,
  p_target_memory_id text,
  p_expected_head_a text,
  p_expected_head_b text,
  p_project_name text,
  p_display_name text,
  p_repository_strategy text,
  p_repository_url text,
  p_content text,
  p_content_hash text
)
returns table(merge_id text, target_memory_id text, merged_revision_id text, pending_device_count integer)
language plpgsql security definer set search_path = public as $$
declare
  v_a text := public.portmgr_resolve_project_memory_id(p_memory_a);
  v_b text := public.portmgr_resolve_project_memory_id(p_memory_b);
  v_target text := p_target_memory_id;
  v_head_a text;
  v_head_b text;
  v_parent text;
  v_merge_id text := gen_random_uuid()::text;
  v_revision_id text := gen_random_uuid()::text;
  v_pending integer := 0;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if v_a is null or v_b is null or v_a = v_b then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_MERGE_SOURCES_INVALID';
  end if;
  if p_repository_strategy not in ('a', 'b', 'new', 'memory-only') then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_REPOSITORY_STRATEGY_INVALID';
  end if;
  if char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 60 then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_DISPLAY_NAME_INVALID';
  end if;
  if octet_length(coalesce(p_content, '')) = 0 or octet_length(p_content) > 1000000 then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_MERGED_CONTENT_INVALID';
  end if;
  if encode(extensions.digest(convert_to(p_content, 'UTF8'), 'sha256'), 'hex') <> p_content_hash then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_MERGED_HASH_INVALID';
  end if;

  select h.head_revision_id into v_head_a from public.portmgr_project_memory_heads h where h.memory_id = v_a for update;
  select h.head_revision_id into v_head_b from public.portmgr_project_memory_heads h where h.memory_id = v_b for update;
  if v_head_a is distinct from p_expected_head_a or v_head_b is distinct from p_expected_head_b then
    raise exception using errcode = '40001', message = 'PROJECT_MEMORY_MERGE_HEAD_CHANGED';
  end if;
  if v_head_a is null or v_head_b is null then
    raise exception using errcode = '22023', message = 'PROJECT_MEMORY_MERGE_HEAD_MISSING';
  end if;

  if v_target = p_memory_a then v_target := v_a; end if;
  if v_target = p_memory_b then v_target := v_b; end if;
  if v_target not in (v_a, v_b) and exists (
    select 1 from public.portmgr_project_memory_heads where memory_id = v_target
    union all select 1 from public.portmgr_project_memory_aliases where alias_memory_id = v_target
  ) then
    raise exception using errcode = '23505', message = 'PROJECT_MEMORY_MERGE_TARGET_EXISTS';
  end if;
  v_parent := case when v_target = v_a then v_head_a when v_target = v_b then v_head_b else null end;

  insert into public.portmgr_project_memory_merges(
    id, source_memory_ids, target_memory_id, source_head_revision_ids,
    repository_strategy, repository_url
  ) values (
    v_merge_id, array[v_a, v_b], v_target, array[v_head_a, v_head_b],
    p_repository_strategy, public.portmgr_canonical_repo_key(p_repository_url)
  );

  update public.portmgr_project_memory_aliases
  set canonical_memory_id = v_target, merge_id = v_merge_id,
      all_known_devices_migrated_at = null
  where canonical_memory_id in (v_a, v_b) and alias_memory_id <> v_target;
  if v_a <> v_target then
    insert into public.portmgr_project_memory_aliases(alias_memory_id, canonical_memory_id, merge_id)
    values (v_a, v_target, v_merge_id)
    on conflict (alias_memory_id) do update set canonical_memory_id = excluded.canonical_memory_id,
      merge_id = excluded.merge_id, all_known_devices_migrated_at = null;
  end if;
  if v_b <> v_target then
    insert into public.portmgr_project_memory_aliases(alias_memory_id, canonical_memory_id, merge_id)
    values (v_b, v_target, v_merge_id)
    on conflict (alias_memory_id) do update set canonical_memory_id = excluded.canonical_memory_id,
      merge_id = excluded.merge_id, all_known_devices_migrated_at = null;
  end if;

  insert into public.portmgr_project_memory_merge_devices(merge_id, device_id, previous_memory_id, device_name)
  select v_merge_id, d.device_id, d.memory_id, max(d.device_name)
  from (
    select memory_id, device_id, device_name from public.portmgr_project_memory_devices where memory_id in (v_a, v_b)
    union all
    select memory_id, device_id, device_name from public.portmgr_project_memory_revisions where memory_id in (v_a, v_b)
  ) d
  where d.device_id is not null
  group by d.device_id, d.memory_id
  on conflict do nothing;

  insert into public.portmgr_project_memory_heads(memory_id, head_revision_id)
  values (v_target, null) on conflict (memory_id) do nothing;
  insert into public.portmgr_project_memory_revisions(
    id, memory_id, parent_revision_id, project_name, github_url,
    device_id, device_name, source_path, content, content_hash
  ) values (
    v_revision_id, v_target, v_parent, coalesce(nullif(btrim(p_project_name), ''), '합병된 장기기억'),
    public.portmgr_canonical_repo_key(p_repository_url), null, '계보 합병', '.agent-memory/CORE.md', p_content, p_content_hash
  );
  update public.portmgr_project_memory_merges set merged_revision_id = v_revision_id where id = v_merge_id;
  insert into public.portmgr_project_memory_labels(memory_id, display_name, updated_at)
  values (v_target, btrim(p_display_name), now())
  on conflict (memory_id) do update set display_name = excluded.display_name, updated_at = now();

  select count(*)::integer into v_pending
  from public.portmgr_project_memory_merge_devices where merge_id = v_merge_id and adopted_at is null;
  if v_pending = 0 then
    update public.portmgr_project_memory_merges set status = 'complete', completed_at = now() where id = v_merge_id;
    update public.portmgr_project_memory_aliases set all_known_devices_migrated_at = now() where merge_id = v_merge_id;
  end if;
  return query select v_merge_id, v_target, v_revision_id, v_pending;
end;
$$;

create or replace function public.portmgr_ack_project_memory_merge_device(
  p_target_memory_id text, p_device_id text
)
returns integer language plpgsql security definer set search_path = public as $$
declare v_remaining integer;
begin
  if p_device_id is null or p_device_id = '' then return 0; end if;
  update public.portmgr_project_memory_merge_devices d
  set adopted_at = coalesce(d.adopted_at, now())
  from public.portmgr_project_memory_merges m
  where m.target_memory_id = p_target_memory_id
    and d.merge_id = m.id
    and d.device_id = p_device_id
    and d.adopted_at is null;
  select count(*)::integer into v_remaining
  from public.portmgr_project_memory_merge_devices d
  join public.portmgr_project_memory_merges m on m.id = d.merge_id
  where m.target_memory_id = p_target_memory_id and d.adopted_at is null;
  if v_remaining = 0 then
    update public.portmgr_project_memory_merges set status = 'complete', completed_at = coalesce(completed_at, now())
    where target_memory_id = p_target_memory_id and status = 'awaiting-devices';
    update public.portmgr_project_memory_aliases set all_known_devices_migrated_at = coalesce(all_known_devices_migrated_at, now())
    where canonical_memory_id = p_target_memory_id;
  end if;
  return v_remaining;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'portmgr_project_memory_labels', 'portmgr_project_memory_merges',
    'portmgr_project_memory_aliases', 'portmgr_project_memory_merge_devices'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists portmgr_authenticated_all on public.%I', t);
    execute format('drop policy if exists portmgr_authenticated_read on public.%I', t);
    execute format('create policy portmgr_authenticated_read on public.%I for select to authenticated using ((select public.portmgr_is_member()))', t);
    execute format('revoke all privileges on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- Labels are harmless shared metadata and remain directly editable by members.
drop policy if exists portmgr_authenticated_read on public.portmgr_project_memory_labels;
create policy portmgr_authenticated_all on public.portmgr_project_memory_labels
  for all to authenticated using ((select public.portmgr_is_member())) with check ((select public.portmgr_is_member()));
grant select, insert, update, delete on table public.portmgr_project_memory_labels to authenticated;

revoke all on function public.portmgr_merge_project_memories(text,text,text,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.portmgr_merge_project_memories(text,text,text,text,text,text,text,text,text,text,text) to authenticated, service_role;
revoke all on function public.portmgr_ack_project_memory_merge_device(text,text) from public, anon, authenticated;
grant execute on function public.portmgr_ack_project_memory_merge_device(text,text) to service_role;
grant execute on function public.portmgr_resolve_project_memory_id(text) to authenticated, service_role;
