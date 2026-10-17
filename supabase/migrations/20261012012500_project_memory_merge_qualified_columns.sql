-- Preserve merge authority and history; fix OUT-column ambiguity and ledger lock ordering.
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

  -- Match the ledger writer lock order before locking either head.
  perform pg_advisory_xact_lock(hashtextextended('portmgr-project-memory-ledger:'||memory_id,0))
    from (select distinct unnest(array[v_a,v_b,v_target]) as memory_id) locks order by memory_id;

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
  from public.portmgr_project_memory_merge_devices d where d.merge_id = v_merge_id and d.adopted_at is null;
  if v_pending = 0 then
    update public.portmgr_project_memory_merges set status = 'complete', completed_at = now() where id = v_merge_id;
    update public.portmgr_project_memory_aliases a set all_known_devices_migrated_at = now() where a.merge_id = v_merge_id;
  end if;
  return query select v_merge_id, v_target, v_revision_id, v_pending;
end;
$$;

