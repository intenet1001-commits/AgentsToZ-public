// Supabase 스키마 정본(단일 출처).
//
// 앱 런타임은 `portmgr_` 프리픽스 테이블만 조회한다(App.tsx / PortalManager.tsx / portal-main.tsx).
// 설치 가이드가 프리픽스 없는 구버전 테이블을 만들면 Push/Pull이 전부 PGRST205로 실패하므로,
// 화면에 노출되는 SQL은 반드시 이 파일에서만 가져온다.
// api-server.ts 의 /api/supabase-cli/create-tables DDL과 동일하게 유지할 것.

/** Server-side membership owner. The Vite allowlist is only a UX mirror;
 * authorization stays in Postgres so direct PostgREST calls cannot bypass it.
 * Existing function-based allowlists are migrated before replacement. Empty
 * membership is deliberately fail-closed.
 */
export const PORTMGR_MEMBERSHIP_SQL = `create table if not exists public.portmgr_allowed_members (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint portmgr_allowed_members_normalized check (
    email = lower(btrim(email))
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
  )
);
alter table public.portmgr_allowed_members enable row level security;

do $portmgr_membership_migrate$
begin
  if to_regprocedure('public.portmgr_allowed_emails()') is not null then
    execute $copy$
      insert into public.portmgr_allowed_members(email)
      select distinct lower(btrim(value))
      from unnest(public.portmgr_allowed_emails()) as value
      where btrim(value) <> ''
      on conflict (email) do nothing
    $copy$;
  end if;
end
$portmgr_membership_migrate$;

alter table public.portmgr_allowed_members enable row level security;
revoke all privileges on table public.portmgr_allowed_members from public, anon, authenticated;
grant select, insert, update, delete on table public.portmgr_allowed_members to service_role;

create or replace function public.portmgr_allowed_emails()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(email order by email), array[]::text[])
  from public.portmgr_allowed_members;
$$;

create or replace function public.portmgr_is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
    and exists (
      select 1
      from public.portmgr_allowed_members member
      where member.email = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

revoke all on function public.portmgr_allowed_emails() from public, anon, authenticated;
revoke all on function public.portmgr_is_member() from public, anon;
grant execute on function public.portmgr_is_member() to authenticated;`;

/**
 * RLS 정본. anon key가 유출돼도 로그인(JWT) 없이는 아무것도 못 하게 한다.
 * supabase/migrations/20260804010000_enable_rls_authenticated_only.sql 과 같은 정책이며,
 * 설치 가이드/자동 DDL이 이 블록을 빠뜨리면 마법사 재실행이 RLS를 도로 꺼버린다.
 *
 * device_id / '__shared__' 격리는 정책 조건에 등장하지 않는다 — 앱 레벨 필터가 담당한다.
 * (RLS로 device_id를 강제하면 "다른 기기 데이터 가져오기" 기능이 깨진다.)
 */
export function rlsPolicySql(tables: string[]): string {
  const perTable = tables
    .filter(table => table !== 'portmgr_allowed_members')
    .map(t => `alter table ${t} enable row level security;
drop policy if exists "anon_all" on ${t};
drop policy if exists "Enable read access for all users" on ${t};
drop policy if exists portmgr_authenticated_all on ${t};
create policy portmgr_authenticated_all on ${t}
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table ${t} from anon;
revoke all privileges on table ${t} from public;
grant select, insert, update, delete on table ${t} to authenticated;`).join('\n\n');

  return `-- ── RLS: 서버 allowlist 회원만 접근 (anon 전면 차단) ──────────────────────
${PORTMGR_MEMBERSHIP_SQL}

${perTable}`;
}

export const PORTMGR_CORE_TABLES = [
  'portmgr_ports',
  'portmgr_workspace_roots',
  'portmgr_portal_items',
  'portmgr_portal_categories',
  'portmgr_devices',
  'portmgr_push_snapshots',
] as const;

export const PROJECT_MEMORY_TABLES = [
  'portmgr_project_memory_revisions',
  'portmgr_project_memory_journal',
  'portmgr_project_memories',
  'portmgr_project_memory_heads',
  'portmgr_project_memory_feedback',
] as const;

/** Public VOC is written only by the Edge Function's service-role RPC. */
export const VOC_SERVER_TABLES = [
  'portmgr_voc_settings',
  'portmgr_voc_daily_usage',
  'portmgr_voc_blocklist',
  'portmgr_voc_inbox',
] as const;

export const PORTMGR_SECURITY_TABLES = [
  'portmgr_allowed_members',
] as const;

/** 앱이 설치·검사·안내하는 정식 Supabase 테이블 목록. */
export const PORTMGR_TABLES = [
  ...PORTMGR_CORE_TABLES,
  ...PROJECT_MEMORY_TABLES,
  ...VOC_SERVER_TABLES,
  ...PORTMGR_SECURITY_TABLES,
] as const;

/** 설치 가이드에서 안내하는 테이블 개수. 목록에서 파생해 문구가 DDL과 어긋나지 않는다. */
export const SCHEMA_TABLE_COUNT = PORTMGR_TABLES.length;

/** v9 project-memory identity registry + atomic head CAS. */
export const PROJECT_MEMORY_IDENTITY_SQL = `create or replace function public.portmgr_canonical_repo_key(p_url text)
returns text language sql immutable set search_path = public as $$
  select case
    when p_url is null or btrim(p_url) = '' then null
    when lower(btrim(p_url)) ~ '^git@github\\.com:' then
      'https://github.com/' || lower(regexp_replace(regexp_replace(btrim(p_url), '^git@github\\.com:', '', 'i'), '\\.git/?$', '', 'i'))
    when lower(btrim(p_url)) ~ '^ssh://git@github\\.com/' then
      'https://github.com/' || lower(regexp_replace(regexp_replace(btrim(p_url), '^ssh://git@github\\.com/', '', 'i'), '\\.git/?$', '', 'i'))
    when lower(btrim(p_url)) ~ '^https?://github\\.com/' then
      'https://github.com/' || lower(regexp_replace(regexp_replace(btrim(p_url), '^https?://github\\.com/', '', 'i'), '\\.git/?$', '', 'i'))
    when lower(btrim(p_url)) ~ '^[a-z][a-z0-9+.-]*://[^/]+/.+' then
      lower(regexp_replace(rtrim(btrim(p_url), '/'), '\\.git$', '', 'i'))
    else null
  end;
$$;
create table if not exists portmgr_project_memories (
  memory_id text primary key,
  canonical_repo_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists portmgr_project_memory_heads (
  memory_id text primary key,
  head_revision_id text,
  updated_at timestamptz not null default now()
);
create table if not exists portmgr_project_memory_feedback (
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
  on portmgr_project_memory_feedback(memory_id, entry_key, recorded_at);
with candidates as (
  select public.portmgr_canonical_repo_key(github_url) as repo_key,
         min(memory_id) as memory_id,
         count(distinct memory_id) as lineage_count
  from portmgr_project_memory_revisions
  where public.portmgr_canonical_repo_key(github_url) is not null
  group by public.portmgr_canonical_repo_key(github_url)
)
insert into portmgr_project_memories(memory_id, canonical_repo_key)
select memory_id, repo_key from candidates where lineage_count = 1
on conflict do nothing;
insert into portmgr_project_memory_heads(memory_id, head_revision_id, updated_at)
select distinct on (memory_id) memory_id, id, coalesce(created_at, now())
from portmgr_project_memory_revisions
order by memory_id, created_at desc nulls last, id desc
on conflict (memory_id) do update
set head_revision_id = excluded.head_revision_id, updated_at = excluded.updated_at
where portmgr_project_memory_heads.head_revision_id is null;

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
  select m.memory_id into v_existing from portmgr_project_memories m
  where m.canonical_repo_key = v_key for update;
  if v_existing is not null then return query select v_existing, false; return; end if;
  select array_agg(distinct r.memory_id order by r.memory_id) into v_legacy_ids
  from portmgr_project_memory_revisions r
  where public.portmgr_canonical_repo_key(r.github_url) = v_key;
  if coalesce(array_length(v_legacy_ids, 1), 0) > 1 then
    raise exception using errcode = 'P0001', message = 'PROJECT_MEMORY_IDENTITY_AMBIGUOUS',
      detail = array_to_string(v_legacy_ids, ',');
  end if;
  v_existing := coalesce(v_legacy_ids[1], p_proposed_memory_id);
  insert into portmgr_project_memories(memory_id, canonical_repo_key)
  values (v_existing, v_key) on conflict (canonical_repo_key) do nothing;
  select m.memory_id into v_existing from portmgr_project_memories m
  where m.canonical_repo_key = v_key;
  return query select v_existing, true;
end;
$$;

create or replace function public.portmgr_append_project_memory_revision(
  p_id text, p_memory_id text, p_expected_parent_revision_id text,
  p_project_name text, p_github_url text, p_device_id text, p_device_name text,
  p_source_path text, p_content text, p_content_hash text
)
returns table(inserted boolean, current_head_revision_id text)
language plpgsql security invoker set search_path = public as $$
declare v_head text;
begin
  insert into portmgr_project_memory_heads(memory_id, head_revision_id)
  values (p_memory_id, null) on conflict (memory_id) do nothing;
  select h.head_revision_id into v_head from portmgr_project_memory_heads h
  where h.memory_id = p_memory_id for update;
  if v_head is distinct from p_expected_parent_revision_id then
    return query select false, v_head; return;
  end if;
  insert into portmgr_project_memory_revisions(
    id, memory_id, parent_revision_id, project_name, github_url,
    device_id, device_name, source_path, content, content_hash
  ) values (
    p_id, p_memory_id, p_expected_parent_revision_id, p_project_name, p_github_url,
    p_device_id, p_device_name, p_source_path, p_content, p_content_hash
  );
  update portmgr_project_memory_heads set head_revision_id = p_id, updated_at = now()
  where memory_id = p_memory_id;
  return query select true, p_id;
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
    insert into portmgr_project_memories(memory_id, canonical_repo_key)
    values (new.memory_id, v_key)
    on conflict (canonical_repo_key) do nothing;
    select m.memory_id into v_registered_memory_id
    from portmgr_project_memories m
    where m.canonical_repo_key = v_key
    for update;
    if v_registered_memory_id is distinct from new.memory_id then
      raise exception using errcode = 'P0001', message = 'PROJECT_MEMORY_IDENTITY_MISMATCH',
        detail = v_registered_memory_id;
    end if;
  end if;
  insert into portmgr_project_memory_heads(memory_id, head_revision_id)
  values (new.memory_id, null) on conflict (memory_id) do nothing;
  select h.head_revision_id into v_head from portmgr_project_memory_heads h
  where h.memory_id = new.memory_id for update;
  if v_head is distinct from new.parent_revision_id then
    raise exception using errcode = '40001', message = 'PROJECT_MEMORY_STALE_PARENT',
      detail = coalesce(v_head, 'null');
  end if;
  update portmgr_project_memory_heads set head_revision_id = new.id, updated_at = now()
  where memory_id = new.memory_id;
  return new;
end;
$$;
drop trigger if exists portmgr_guard_project_memory_revision_insert
  on public.portmgr_project_memory_revisions;
create trigger portmgr_guard_project_memory_revision_insert
before insert on public.portmgr_project_memory_revisions
for each row execute function public.portmgr_guard_project_memory_revision_insert();
grant select, insert, update, delete on table public.portmgr_project_memories to authenticated, service_role;
grant select, insert, update, delete on table public.portmgr_project_memory_heads to authenticated, service_role;
grant select, insert, update, delete on table public.portmgr_project_memory_feedback to authenticated, service_role;
revoke all on function public.portmgr_claim_project_memory(text, text) from public, anon;
revoke all on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.portmgr_claim_project_memory(text, text) to authenticated, service_role;
grant execute on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) to authenticated, service_role;`;

export const PROJECT_MEMORY_LEDGER_SECURITY_SQL = `-- Project-memory is server-mediated. Authenticated clients may inspect their
-- member-scoped rows, but may not forge, rewrite, or delete the CAS/append-only
-- ledger directly. The local API uses a server-only service_role key.
do $$
declare
  t text;
  read_predicate text;
begin
  -- Some legacy installations predate the member helper even though they have
  -- project-memory tables. Keep the migration deployable and fail closed: such
  -- installations expose zero rows to authenticated until the canonical helper
  -- is installed, while service_role remains available to the local API.
  read_predicate := case
    when to_regprocedure('public.portmgr_is_member()') is null then 'false'
    else '(select public.portmgr_is_member())'
  end;
  foreach t in array array[
    'portmgr_project_memory_revisions',
    'portmgr_project_memory_journal',
    'portmgr_project_memories',
    'portmgr_project_memory_heads',
    'portmgr_project_memory_feedback'
  ]
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists portmgr_authenticated_all on public.%I', t);
    execute format('drop policy if exists portmgr_authenticated_read on public.%I', t);
    execute format($p$
      create policy portmgr_authenticated_read on public.%I
        for select to authenticated
        using (%s)
    $p$, t, read_predicate);
    execute format('revoke all privileges on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;

-- Service-role permissions are still least-privilege. Revisions are pruned by
-- retention, while journal and feedback remain immutable append-only evidence.
grant select, insert, delete on table public.portmgr_project_memory_revisions to service_role;
grant select, insert on table public.portmgr_project_memory_journal to service_role;
grant select, insert on table public.portmgr_project_memory_feedback to service_role;
grant select, insert, update, delete on table public.portmgr_project_memories to service_role;
grant select, insert, update, delete on table public.portmgr_project_memory_heads to service_role;

revoke all on function public.portmgr_claim_project_memory(text, text) from public, anon, authenticated;
revoke all on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.portmgr_claim_project_memory(text, text) to service_role;
grant execute on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) to service_role;
revoke all on function public.portmgr_guard_project_memory_revision_insert() from public, anon, authenticated;
grant execute on function public.portmgr_guard_project_memory_revision_insert() to service_role;`;

/** Complete, canonical repair/install unit for every Project Memory relation and RPC. */
export const PROJECT_MEMORY_MIGRATION_SQL = `create table if not exists portmgr_project_memory_revisions (
  id text primary key,
  memory_id text not null,
  parent_revision_id text,
  project_name text,
  github_url text,
  device_id text,
  device_name text,
  source_path text,
  content text not null,
  content_hash text not null,
  created_at timestamptz default now()
);
create index if not exists idx_portmgr_project_memory_latest on portmgr_project_memory_revisions(memory_id, created_at desc);
create index if not exists idx_portmgr_project_memory_github on portmgr_project_memory_revisions(github_url, created_at desc);

-- 세션 일지. 리비전과 달리 통합·재작성 대상이 아니고 절대 지우지 않는다.
-- 리비전은 파일 전체 스냅샷이라 최신 50개만 남기는데(약 한 달), 그것만으로는
-- 수년치 노하우를 보존할 수 없다. 여기에 한 세션 = 한 행으로 쌓아 두면
-- 정리된 기억이 나중에 어떻게 압축되든 원본 근거가 남는다.
-- entry_hash에 unique를 걸어 재-push가 멱등이고, 두 기기가 각자 append해도
-- 합집합이 되어 리비전과 달리 충돌이 발생하지 않는다.
create table if not exists portmgr_project_memory_journal (
  id text primary key,
  memory_id text not null,
  entry_hash text not null,
  device_id text,
  device_name text,
  project_name text,
  agent text,
  recorded_at timestamptz not null,
  head_commit text,
  summary text not null,
  body text not null,
  created_at timestamptz default now()
);
create unique index if not exists idx_portmgr_project_memory_journal_entry on portmgr_project_memory_journal(memory_id, entry_hash);
create index if not exists idx_portmgr_project_memory_journal_recent on portmgr_project_memory_journal(memory_id, recorded_at desc);

${PROJECT_MEMORY_IDENTITY_SQL}

${rlsPolicySql([...PROJECT_MEMORY_TABLES])}

${PROJECT_MEMORY_LEDGER_SECURITY_SQL}`;

/**
 * Public VOC receiver schema. Unlike ordinary app tables these relations are
 * service-role only: unknown installations submit through the rate-limited
 * Edge Function and never receive direct table privileges.
 */
export const VOC_SERVER_SQL = `create table if not exists public.portmgr_voc_settings (
  id text primary key default 'default' check (id = 'default'),
  accepting boolean not null default true,
  daily_device_limit integer not null default 10 check (daily_device_limit between 1 and 100),
  updated_at timestamptz not null default now()
);
insert into public.portmgr_voc_settings(id, accepting, daily_device_limit)
values ('default', true, 10) on conflict (id) do nothing;

create table if not exists public.portmgr_voc_daily_usage (
  usage_date date not null,
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  submission_count integer not null default 0 check (submission_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_date, device_hash)
);

create table if not exists public.portmgr_voc_blocklist (
  device_hash text primary key check (device_hash ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope in ('voc', 'app')),
  operator_note text not null default '' check (char_length(operator_note) <= 500),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portmgr_voc_inbox (
  id uuid primary key,
  received_at timestamptz not null default now(),
  app_version text not null default '' check (char_length(app_version) <= 100),
  tab text not null default '' check (char_length(tab) <= 50),
  anchor jsonb not null default '{}'::jsonb,
  comment text not null check (char_length(comment) between 1 and 4000),
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'reviewing', 'done', 'spam')),
  handled_at timestamptz
);
create index if not exists idx_portmgr_voc_inbox_status_received
  on public.portmgr_voc_inbox(status, received_at desc);

create or replace function public.portmgr_check_voc_device(p_device_hash text)
returns table(blocked boolean, block_scope text, expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select true, b.scope, b.expires_at from public.portmgr_voc_blocklist b
  where b.device_hash = p_device_hash and (b.expires_at is null or b.expires_at > now()) limit 1;
$$;

create or replace function public.portmgr_submit_voc(
  p_id uuid, p_device_hash text, p_app_version text, p_tab text, p_anchor jsonb, p_comment text
)
returns table(accepted boolean, remaining integer, daily_limit integer, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_accepting boolean;
  v_daily_limit integer;
  v_count integer;
  v_block_scope text;
begin
  select accepting, daily_device_limit into v_accepting, v_daily_limit
  from public.portmgr_voc_settings where id = 'default';
  if not coalesce(v_accepting, false) then
    return query select false, 0, coalesce(v_daily_limit, 10), 'disabled'::text; return;
  end if;
  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid device hash';
  end if;
  select b.scope into v_block_scope from public.portmgr_voc_blocklist b
  where b.device_hash = p_device_hash and (b.expires_at is null or b.expires_at > now());
  if v_block_scope is not null then
    return query select false, 0, v_daily_limit, (v_block_scope || '_blocked')::text; return;
  end if;
  if p_comment is null or char_length(btrim(p_comment)) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'comment must be 1..4000 characters';
  end if;
  insert into public.portmgr_voc_daily_usage(usage_date, device_hash, submission_count, updated_at)
  values (current_date, p_device_hash, 1, now())
  on conflict (usage_date, device_hash) do update
    set submission_count = public.portmgr_voc_daily_usage.submission_count + 1, updated_at = now()
    where public.portmgr_voc_daily_usage.submission_count < v_daily_limit
  returning submission_count into v_count;
  if v_count is null then
    return query select false, 0, v_daily_limit, 'rate_limited'::text; return;
  end if;
  insert into public.portmgr_voc_inbox(id, app_version, tab, anchor, comment, device_hash)
  values (p_id, left(coalesce(p_app_version, ''), 100), left(coalesce(p_tab, ''), 50),
          coalesce(p_anchor, '{}'::jsonb), btrim(p_comment), p_device_hash);
  return query select true, greatest(v_daily_limit - v_count, 0), v_daily_limit, null::text;
end;
$$;

alter table public.portmgr_voc_settings enable row level security;
alter table public.portmgr_voc_daily_usage enable row level security;
alter table public.portmgr_voc_blocklist enable row level security;
alter table public.portmgr_voc_inbox enable row level security;
revoke all privileges on table public.portmgr_voc_settings from public, anon, authenticated;
revoke all privileges on table public.portmgr_voc_daily_usage from public, anon, authenticated;
revoke all privileges on table public.portmgr_voc_blocklist from public, anon, authenticated;
revoke all privileges on table public.portmgr_voc_inbox from public, anon, authenticated;
grant select, insert, update on table public.portmgr_voc_settings to service_role;
grant select, insert, update, delete on table public.portmgr_voc_daily_usage to service_role;
grant select, insert, update, delete on table public.portmgr_voc_blocklist to service_role;
grant select, insert, update, delete on table public.portmgr_voc_inbox to service_role;
revoke all on function public.portmgr_check_voc_device(text) from public, anon, authenticated;
grant execute on function public.portmgr_check_voc_device(text) to service_role;
revoke all on function public.portmgr_submit_voc(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.portmgr_submit_voc(uuid, text, text, text, jsonb, text) to service_role;`;

export const MIGRATION_SQL = `create table if not exists portmgr_ports (
  id text primary key,
  device_id text,
  device_name text,
  name text not null,
  port integer,
  command_path text,
  terminal_command text,
  folder_path text,
  deploy_url text,
  github_url text,
  github_urls text[],
  manual_path text,
  log_file_path text,
  favorite boolean default false,
  category text,
  description text,
  memo text,
  memo_updated_at timestamptz,
  created_at timestamptz default now()
);
alter table portmgr_ports add column if not exists device_id text;
alter table portmgr_ports add column if not exists device_name text;
alter table portmgr_ports add column if not exists github_urls text[];
alter table portmgr_ports add column if not exists manual_path text;
alter table portmgr_ports add column if not exists log_file_path text;
alter table portmgr_ports add column if not exists category text;
alter table portmgr_ports add column if not exists description text;
create index if not exists idx_portmgr_ports_device_id on portmgr_ports(device_id);

create table if not exists portmgr_workspace_roots (
  id text primary key,
  device_id text,
  name text,
  path text
);

create table if not exists portmgr_portal_items (
  id text primary key,
  device_id text,
  name text not null,
  type text not null,
  url text,
  path text,
  category text,
  description text,
  pinned boolean default false,
  visit_count integer default 0,
  last_visited timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_portmgr_portal_items_device_id on portmgr_portal_items(device_id);

create table if not exists portmgr_portal_categories (
  id text primary key,
  device_id text,
  name text not null,
  color text,
  "order" integer default 0
);

create table if not exists portmgr_devices (
  id text primary key,
  name text,
  last_push_at timestamptz default now(),
  handoff_note text,
  handoff_updated_at timestamptz
);
alter table portmgr_devices add column if not exists handoff_note text;
alter table portmgr_devices add column if not exists handoff_updated_at timestamptz;

create table if not exists portmgr_push_snapshots (
  id text primary key default gen_random_uuid()::text,
  created_at timestamptz default now(),
  table_name text,
  device_id text,
  device_name text,
  row_count integer,
  snapshot jsonb
);
alter table portmgr_push_snapshots alter column id set default gen_random_uuid()::text;

${rlsPolicySql([...PORTMGR_CORE_TABLES])}

${PROJECT_MEMORY_MIGRATION_SQL}

${VOC_SERVER_SQL}`;

function normalizeAllowedEmails(emails: readonly string[]): string[] {
  const normalized = Array.from(new Set(emails.map(email => email.trim().toLowerCase()).filter(Boolean)));
  if (normalized.length === 0) {
    throw new Error('서버 RLS에 등록할 허용 이메일이 하나 이상 필요합니다.');
  }
  for (const email of normalized) {
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`올바른 이메일 형식이 아닙니다: ${email}`);
    }
  }
  return normalized.sort();
}

/** Personalizes canonical setup without committing an owner's email to source. */
export function migrationSqlForAllowedEmails(emails: readonly string[]): string {
  const values = normalizeAllowedEmails(emails)
    .map(email => `('${email.replace(/'/g, "''")}')`)
    .join(',\n  ');
  return `${MIGRATION_SQL}\n\n-- 서버 권한 소유자: VITE_ALLOWED_EMAIL UI gate와 같은 목록을 유지한다.\ninsert into public.portmgr_allowed_members(email)\nvalues ${values}\non conflict (email) do nothing;`;
}

/** 포털(Vercel) 배포에 필요한 최소 테이블만. */
export const PORTAL_SQL = `create table if not exists portmgr_portal_items (
  id text primary key,
  device_id text,
  name text not null,
  type text not null,
  url text,
  path text,
  category text,
  description text,
  pinned boolean default false,
  visit_count integer default 0,
  last_visited timestamptz,
  created_at timestamptz default now()
);

create table if not exists portmgr_portal_categories (
  id text primary key,
  device_id text,
  name text not null,
  color text,
  "order" integer default 0
);

${rlsPolicySql(['portmgr_portal_items', 'portmgr_portal_categories'])}`;

/** Portal-only setup still needs the same server-side owner membership. */
export function portalSqlForAllowedEmails(emails: readonly string[]): string {
  const values = normalizeAllowedEmails(emails)
    .map(email => `('${email.replace(/'/g, "''")}')`)
    .join(',\n  ');
  return `${PORTAL_SQL}\n\ninsert into public.portmgr_allowed_members(email)\nvalues ${values}\non conflict (email) do nothing;`;
}

/** 이미 프리픽스 없는 구버전 테이블을 만든 경우의 복구 SQL. */
export const LEGACY_RENAME_SQL = `-- 이미 프리픽스 없는 구버전 테이블을 만들었다면 먼저 실행하세요
alter table if exists ports             rename to portmgr_ports;
alter table if exists workspace_roots   rename to portmgr_workspace_roots;
alter table if exists portal_items      rename to portmgr_portal_items;
alter table if exists portal_categories rename to portmgr_portal_categories;`;

/** Claude Code + Supabase MCP 용 프롬프트. */
export const AI_TABLE_PROMPT = `포트 관리 프로그램(portmanagement)의 Supabase 테이블을 설정해줘.
Supabase MCP를 사용해서 아래 ${SCHEMA_TABLE_COUNT}개 테이블을 생성하고, 함께 들어있는 RLS 정책까지 그대로 적용해줘.
RLS를 끄지 마. anon key가 유출돼도 로그인 없이는 접근할 수 없어야 한다.
적용 전에 나에게 서버 RLS를 허용할 Google owner 이메일을 물어보고, 아래 <OWNER_GOOGLE_EMAIL>을 그 값으로 교체해.
<OWNER_GOOGLE_EMAIL>을 literal placeholder 상태로 실행하지 마. owner seed까지 성공하지 않으면 완료로 보고하지 마.

-- ※ 테이블 이름은 반드시 portmgr_ 프리픽스를 유지할 것 (앱이 이 이름만 조회함)
-- ※ 멀티 단말 지원: device_id로 단말 구분, '__shared__' sentinel로 공유 데이터 표시

${MIGRATION_SQL}

insert into public.portmgr_allowed_members(email)
values ('<OWNER_GOOGLE_EMAIL>')
on conflict (email) do nothing;`;

/** Setup UI must never hand an agent an unchecked owner placeholder. */
export function aiTablePromptForAllowedEmails(emails: readonly string[]): string {
  return `포트 관리 프로그램(portmanagement)의 Supabase 테이블을 설정해줘.
Supabase MCP를 사용해서 아래 ${SCHEMA_TABLE_COUNT}개 테이블과 RLS 정책을 그대로 적용해줘.
RLS를 끄지 마. anon key가 유출돼도 로그인 없이는 접근할 수 없어야 한다.
아래 SQL은 검증된 서버 owner 이메일을 이미 포함한다. owner seed까지 성공하지 않으면 완료로 보고하지 마.

${migrationSqlForAllowedEmails(emails)}`;
}
