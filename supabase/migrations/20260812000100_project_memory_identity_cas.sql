-- v9 project-memory identity registry + atomic revision head CAS.
-- Safe to re-run. Existing repositories are adopted only when one canonical key
-- maps to exactly one historical memory_id; split lineages require review.

-- Canonicalize the historical URL forms v8 may have stored. This must match
-- src/projectMemoryIdentity.ts: GitHub SSH/HTTPS clones share one key; forks do not.
create or replace function public.portmgr_canonical_repo_key(p_url text)
returns text language sql immutable set search_path = public as $$
  select case
    when p_url is null or btrim(p_url) = '' then null
    when lower(btrim(p_url)) ~ '^git@github\.com:' then
      'https://github.com/' || lower(regexp_replace(regexp_replace(btrim(p_url), '^git@github\.com:', '', 'i'), '\.git/?$', '', 'i'))
    when lower(btrim(p_url)) ~ '^ssh://git@github\.com/' then
      'https://github.com/' || lower(regexp_replace(regexp_replace(btrim(p_url), '^ssh://git@github\.com/', '', 'i'), '\.git/?$', '', 'i'))
    when lower(btrim(p_url)) ~ '^https?://github\.com/' then
      'https://github.com/' || lower(regexp_replace(regexp_replace(btrim(p_url), '^https?://github\.com/', '', 'i'), '\.git/?$', '', 'i'))
    when lower(btrim(p_url)) ~ '^[a-z][a-z0-9+.-]*://[^/]+/.+' then
      lower(regexp_replace(rtrim(btrim(p_url), '/'), '\.git$', '', 'i'))
    else null
  end;
$$;

create table if not exists public.portmgr_project_memories (
  memory_id text primary key,
  canonical_repo_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portmgr_project_memory_feedback (
  id text primary key,
  memory_id text not null,
  entry_key text not null,
  kind text not null check (kind in ('applied', 'confirmed', 'corrected', 'contradicted')),
  evidence text,
  device_id text,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_portmgr_project_memory_feedback_entry
  on public.portmgr_project_memory_feedback(memory_id, entry_key, recorded_at);

create table if not exists public.portmgr_project_memory_heads (
  memory_id text primary key,
  head_revision_id text,
  updated_at timestamptz not null default now()
);

-- Backfill only unambiguous legacy identities. github_url was normalized by the
-- application; lower/rtrim also absorbs older trailing .git/slash rows.
with candidates as (
  select
    public.portmgr_canonical_repo_key(github_url) as repo_key,
    min(memory_id) as memory_id,
    count(distinct memory_id) as lineage_count
  from public.portmgr_project_memory_revisions
  where public.portmgr_canonical_repo_key(github_url) is not null
  group by public.portmgr_canonical_repo_key(github_url)
)
insert into public.portmgr_project_memories(memory_id, canonical_repo_key)
select memory_id, repo_key
from candidates
where lineage_count = 1
on conflict do nothing;

-- One latest head per lineage. created_at ties are broken by id for determinism.
insert into public.portmgr_project_memory_heads(memory_id, head_revision_id, updated_at)
select distinct on (memory_id) memory_id, id, coalesce(created_at, now())
from public.portmgr_project_memory_revisions
order by memory_id, created_at desc nulls last, id desc
on conflict (memory_id) do update
set head_revision_id = excluded.head_revision_id,
    updated_at = excluded.updated_at
where public.portmgr_project_memory_heads.head_revision_id is null;

create or replace function public.portmgr_claim_project_memory(
  p_repository_key text,
  p_proposed_memory_id text
)
returns table(memory_id text, claimed boolean)
language plpgsql
security invoker
set search_path = public
as $$
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

  select m.memory_id into v_existing
  from public.portmgr_project_memories m
  where m.canonical_repo_key = v_key
  for update;
  if v_existing is not null then
    return query select v_existing, false;
    return;
  end if;

  select array_agg(distinct r.memory_id order by r.memory_id)
  into v_legacy_ids
  from public.portmgr_project_memory_revisions r
  where public.portmgr_canonical_repo_key(r.github_url) = v_key;

  if coalesce(array_length(v_legacy_ids, 1), 0) > 1 then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_MEMORY_IDENTITY_AMBIGUOUS',
      detail = array_to_string(v_legacy_ids, ',');
  end if;

  v_existing := coalesce(v_legacy_ids[1], p_proposed_memory_id);
  insert into public.portmgr_project_memories(memory_id, canonical_repo_key)
  values (v_existing, v_key)
  on conflict (canonical_repo_key) do nothing;

  select m.memory_id into v_existing
  from public.portmgr_project_memories m
  where m.canonical_repo_key = v_key;
  return query select v_existing, true;
end;
$$;

create or replace function public.portmgr_append_project_memory_revision(
  p_id text,
  p_memory_id text,
  p_expected_parent_revision_id text,
  p_project_name text,
  p_github_url text,
  p_device_id text,
  p_device_name text,
  p_source_path text,
  p_content text,
  p_content_hash text
)
returns table(inserted boolean, current_head_revision_id text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_head text;
begin
  -- Ensure a row exists, then lock it. A concurrent caller blocks here and sees
  -- the newly committed head before deciding whether its expected parent is stale.
  insert into public.portmgr_project_memory_heads(memory_id, head_revision_id)
  values (p_memory_id, null)
  on conflict (memory_id) do nothing;

  select h.head_revision_id into v_head
  from public.portmgr_project_memory_heads h
  where h.memory_id = p_memory_id
  for update;

  if v_head is distinct from p_expected_parent_revision_id then
    return query select false, v_head;
    return;
  end if;

  insert into public.portmgr_project_memory_revisions(
    id, memory_id, parent_revision_id, project_name, github_url,
    device_id, device_name, source_path, content, content_hash
  ) values (
    p_id, p_memory_id, p_expected_parent_revision_id, p_project_name, p_github_url,
    p_device_id, p_device_name, p_source_path, p_content, p_content_hash
  );

  update public.portmgr_project_memory_heads
  set head_revision_id = p_id, updated_at = now()
  where memory_id = p_memory_id;

  return query select true, p_id;
end;
$$;

-- Enforce the same parent/head invariant on every insert, including v8 clients
-- and manual SQL that bypass the v9 RPC. The transaction rolls back the head
-- update if the revision insert later fails.
create or replace function public.portmgr_guard_project_memory_revision_insert()
returns trigger language plpgsql security invoker set search_path = public as $$
declare
  v_head text;
  v_key text := public.portmgr_canonical_repo_key(new.github_url);
  v_registered_memory_id text;
begin
  if v_key is not null then
    insert into public.portmgr_project_memories(memory_id, canonical_repo_key)
    values (new.memory_id, v_key)
    on conflict (canonical_repo_key) do nothing;
    select m.memory_id into v_registered_memory_id
    from public.portmgr_project_memories m
    where m.canonical_repo_key = v_key
    for update;
    if v_registered_memory_id is distinct from new.memory_id then
      raise exception using
        errcode = 'P0001',
        message = 'PROJECT_MEMORY_IDENTITY_MISMATCH',
        detail = v_registered_memory_id;
    end if;
  end if;
  insert into public.portmgr_project_memory_heads(memory_id, head_revision_id)
  values (new.memory_id, null)
  on conflict (memory_id) do nothing;
  select h.head_revision_id into v_head
  from public.portmgr_project_memory_heads h
  where h.memory_id = new.memory_id
  for update;
  if v_head is distinct from new.parent_revision_id then
    raise exception using
      errcode = '40001',
      message = 'PROJECT_MEMORY_STALE_PARENT',
      detail = coalesce(v_head, 'null');
  end if;
  update public.portmgr_project_memory_heads
  set head_revision_id = new.id, updated_at = now()
  where memory_id = new.memory_id;
  return new;
end;
$$;
drop trigger if exists portmgr_guard_project_memory_revision_insert
  on public.portmgr_project_memory_revisions;
create trigger portmgr_guard_project_memory_revision_insert
before insert on public.portmgr_project_memory_revisions
for each row execute function public.portmgr_guard_project_memory_revision_insert();

-- Same authenticated-only posture as the other project-memory tables.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'portmgr_is_member'
  ) then
    alter table public.portmgr_project_memories enable row level security;
    alter table public.portmgr_project_memory_heads enable row level security;
    alter table public.portmgr_project_memory_feedback enable row level security;
    drop policy if exists portmgr_authenticated_all on public.portmgr_project_memories;
    drop policy if exists portmgr_authenticated_all on public.portmgr_project_memory_heads;
    drop policy if exists portmgr_authenticated_all on public.portmgr_project_memory_feedback;
    create policy portmgr_authenticated_all on public.portmgr_project_memories
      for all to authenticated using ((select public.portmgr_is_member()))
      with check ((select public.portmgr_is_member()));
    create policy portmgr_authenticated_all on public.portmgr_project_memory_heads
      for all to authenticated using ((select public.portmgr_is_member()))
      with check ((select public.portmgr_is_member()));
    create policy portmgr_authenticated_all on public.portmgr_project_memory_feedback
      for all to authenticated using ((select public.portmgr_is_member()))
      with check ((select public.portmgr_is_member()));
  end if;
end $$;

revoke all on table public.portmgr_project_memories from public, anon;
revoke all on table public.portmgr_project_memory_heads from public, anon;
revoke all on table public.portmgr_project_memory_feedback from public, anon;
grant select, insert, update, delete on table public.portmgr_project_memories to authenticated, service_role;
grant select, insert, update, delete on table public.portmgr_project_memory_heads to authenticated, service_role;
grant select, insert, update, delete on table public.portmgr_project_memory_feedback to authenticated, service_role;
revoke all on function public.portmgr_claim_project_memory(text, text) from public, anon;
revoke all on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.portmgr_claim_project_memory(text, text) to authenticated, service_role;
grant execute on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) to authenticated, service_role;
