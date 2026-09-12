import { MEMORY_DEVICE_REGISTRY_SQL } from './memoryDeviceRegistrySql';
import { SHARED_PROMPT_GUIDE_SQL } from './sharedPromptGuideSql';
import { PROJECT_MEMORY_FEED_SQL } from './projectMemoryFeedSql';
// Supabase 스키마 정본(단일 출처).
//
// 앱 런타임은 `portmgr_` 프리픽스 테이블만 조회한다(App.tsx / PortalManager.tsx / portal-main.tsx).
// 설치 가이드가 프리픽스 없는 구버전 테이블을 만들면 Push/Pull이 전부 PGRST205로 실패하므로,
// 화면에 노출되는 SQL은 반드시 이 파일에서만 가져온다.
// api-server.ts 의 /api/supabase-cli/create-tables DDL과 동일하게 유지할 것.
import { REMOTE_DEVICE_SQL } from './remoteDeviceSql';
import { REMOTE_DEVICE_RECONNECT_SQL } from './remoteDeviceReconnectSql';
import { REMOTE_HOST_PROJECTS_SQL } from './remoteHostProjectsSql';
import { SAFE_REMOTE_DEVICE_ROTATION_SQL } from './safeRemoteDeviceRotationSql';
import { REMOTE_DEVICE_CLAIM_RECOVERY_SQL } from './remoteDeviceClaimRecoverySql';
import { REMOTE_DEVICE_AGENT_VERSION_SQL } from './remoteDeviceAgentVersionSql';
import { REMOTE_DEVICE_HISTORY_TOPIC_SQL } from './remoteDeviceHistoryTopicSql';
import { REMOTE_DEVICE_RECONNECT_LINEAGE_SQL } from './remoteDeviceReconnectLineageSql';
import { REMOTE_DEVICE_HISTORY_TRIGGER_FIX_SQL } from './remoteDeviceHistoryTriggerFixSql';
import { REMOTE_CONTROL_RELAY_SQL } from './remoteControlRelaySql';
import { WHAT_I_SAID_REMOTE_SQL, WHAT_I_SAID_REMOTE_TABLES } from './whatISaidRemoteSql';
import { WHAT_I_SAID_FEED_KEY_SQL, WHAT_I_SAID_FEED_KEY_TABLES } from './whatISaidFeedKeySql';

export { REMOTE_CONTROL_RELAY_SQL } from './remoteControlRelaySql';
export { WHAT_I_SAID_REMOTE_SQL, WHAT_I_SAID_REMOTE_TABLES } from './whatISaidRemoteSql';
export { WHAT_I_SAID_FEED_KEY_SQL, WHAT_I_SAID_FEED_KEY_TABLES } from './whatISaidFeedKeySql';

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
    coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or (
      coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
      and exists (
        select 1
        from public.portmgr_allowed_members member
        where member.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
    );
$$;

revoke all on function public.portmgr_allowed_emails() from public, anon, authenticated;
revoke all on function public.portmgr_is_member() from public, anon;
grant execute on function public.portmgr_is_member() to authenticated, service_role;`;

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
    .map(t => t === 'portmgr_project_memory_feed_keys' ? `alter table ${t} enable row level security;
drop policy if exists portmgr_authenticated_all on ${t};
revoke all privileges on table ${t} from public, anon, authenticated;
grant select, insert, update, delete on table ${t} to service_role;` : `alter table ${t} enable row level security;
drop policy if exists "anon_all" on ${t};
drop policy if exists "Enable read access for all users" on ${t};
drop policy if exists portmgr_authenticated_all on ${t};
create policy portmgr_authenticated_all on ${t}
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table ${t} from anon;
revoke all privileges on table ${t} from public;
grant select, insert, update, delete on table ${t} to authenticated, service_role;`).join('\n\n');

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
  'portmgr_github_repository_roles',
] as const;

/** Permanent CAS/deletion generations are readable for synchronization, never directly writable. */
export const PORT_DURABLE_FENCE_TABLES = [
  'portmgr_port_fences',
] as const;

/**
 * Client-side failure reports.
 *
 * A portal error happens on a phone, which cannot reach the Mac's localhost
 * `/api/voc`, and `portmgr_voc_inbox` is a service-role write-only outbox the
 * Mac cannot read back. This table is the missing half: the phone writes as an
 * authenticated member, and the Mac reads its own device's rows into the local
 * VOC list. It records only what makes a failure actionable — never a local
 * path, command, or credential.
 */
export const CLIENT_ERROR_TABLES = [
  'portmgr_client_errors',
] as const;

export const CLIENT_ERROR_SQL = `create table if not exists public.portmgr_client_errors (
  id text primary key,
  device_id text,
  device_name text,
  surface text,
  code text,
  message text,
  detail text,
  app_version text,
  resolved boolean default false,
  created_at timestamptz default now()
);
alter table public.portmgr_client_errors add column if not exists device_name text;
alter table public.portmgr_client_errors add column if not exists detail text;
alter table public.portmgr_client_errors add column if not exists resolved boolean default false;
create index if not exists idx_portmgr_client_errors_device
  on public.portmgr_client_errors(device_id, created_at desc);`;


export const PROJECT_MEMORY_TABLES = [
  'portmgr_project_memory_revisions',
  'portmgr_project_memory_journal',
  'portmgr_project_memory_ledger_changes',
  'portmgr_project_memories',
  'portmgr_project_memory_heads',
  'portmgr_project_memory_feedback',
  'portmgr_project_memory_devices',
] as const;

export const PROJECT_MEMORY_MERGE_TABLES = [
  'portmgr_project_memory_labels',
  'portmgr_project_memory_merges',
  'portmgr_project_memory_aliases',
  'portmgr_project_memory_merge_devices',
  'portmgr_project_memory_device_retirements',
  'portmgr_project_memory_trash',
  'portmgr_project_memory_mentions',
] as const;

export const REMOTE_DEVICE_TABLES = [
  'portmgr_remote_devices',
  'portmgr_remote_device_credentials',
  'portmgr_remote_device_enrollments',
  'portmgr_remote_device_memory_access',
  'portmgr_remote_device_projects',
  'portmgr_device_identity_aliases',
] as const;

/** RPC-only ephemeral relay tables. Their own SQL forces RLS and revokes all
 * direct grants; never pass this list to the generic authenticated CRUD policy.
 */
export const REMOTE_CONTROL_RELAY_TABLES = [
  'portmgr_remote_control_hosts',
  'portmgr_remote_control_pairings',
  'portmgr_remote_control_sessions',
  'portmgr_remote_control_messages',
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
  ...PORT_DURABLE_FENCE_TABLES,
  ...CLIENT_ERROR_TABLES,
  ...PROJECT_MEMORY_TABLES,
  ...PROJECT_MEMORY_MERGE_TABLES,
  ...REMOTE_DEVICE_TABLES,
  ...REMOTE_CONTROL_RELAY_TABLES,
  ...WHAT_I_SAID_REMOTE_TABLES,
  ...WHAT_I_SAID_FEED_KEY_TABLES,
  'portmgr_project_memory_feed_keys',
  'portmgr_prompt_guides',
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
  origin_event_id text,
  memory_id text not null,
  entry_key text not null,
  kind text not null check (kind in ('applied', 'confirmed', 'corrected', 'contradicted')),
  evidence text,
  device_id text,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table portmgr_project_memory_feedback
  add column if not exists origin_event_id text;
create index if not exists idx_portmgr_project_memory_feedback_entry
  on portmgr_project_memory_feedback(memory_id, entry_key, recorded_at);
create table if not exists portmgr_project_memory_devices (
  memory_id text not null,
  device_id text not null,
  device_name text,
  platform text,
  revision_id text,
  content_hash text,
  last_synced_at timestamptz,
  last_seen_at timestamptz not null default now(),
  git_head_sha text,
  git_branch text,
  git_remote_url text,
  git_upstream_sha text,
  git_ahead integer,
  git_behind integer,
  git_dirty boolean,
  git_commit_at timestamptz,
  git_checked_at timestamptz,
  primary key (memory_id, device_id)
);
alter table portmgr_project_memory_devices add column if not exists git_head_sha text;
alter table portmgr_project_memory_devices add column if not exists git_branch text;
alter table portmgr_project_memory_devices add column if not exists git_remote_url text;
alter table portmgr_project_memory_devices add column if not exists git_upstream_sha text;
alter table portmgr_project_memory_devices add column if not exists git_ahead integer;
alter table portmgr_project_memory_devices add column if not exists git_behind integer;
alter table portmgr_project_memory_devices add column if not exists git_dirty boolean;
alter table portmgr_project_memory_devices add column if not exists git_commit_at timestamptz;
alter table portmgr_project_memory_devices add column if not exists git_checked_at timestamptz;
create index if not exists idx_portmgr_project_memory_devices_seen
  on portmgr_project_memory_devices(memory_id, last_seen_at desc);
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
grant select, insert, update, delete on table public.portmgr_project_memory_devices to authenticated, service_role;
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
    'portmgr_project_memory_ledger_changes',
    'portmgr_project_memories',
    'portmgr_project_memory_heads',
    'portmgr_project_memory_feedback',
    'portmgr_project_memory_devices'
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
grant select on table public.portmgr_project_memory_ledger_changes to service_role;
grant select, insert, update on table public.portmgr_project_memory_devices to service_role;
grant select, insert, update, delete on table public.portmgr_project_memories to service_role;
grant select, insert, update, delete on table public.portmgr_project_memory_heads to service_role;

revoke all on function public.portmgr_claim_project_memory(text, text) from public, anon, authenticated;
revoke all on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.portmgr_claim_project_memory(text, text) to service_role;
grant execute on function public.portmgr_append_project_memory_revision(text, text, text, text, text, text, text, text, text, text) to service_role;
revoke all on function public.portmgr_guard_project_memory_revision_insert() from public, anon, authenticated;
grant execute on function public.portmgr_guard_project_memory_revision_insert() to service_role;`;

/** v10: human labels + lossless lineage merge with permanent old-ID forwarding. */
export const PROJECT_MEMORY_MERGE_SQL = `create extension if not exists pgcrypto with schema extensions;
create table if not exists public.portmgr_project_memory_labels (
  memory_id text primary key,
  display_name text not null check (char_length(display_name) between 1 and 60),
  updated_at timestamptz not null default now()
);
create table if not exists public.portmgr_project_memory_merges (
  id text primary key, source_memory_ids text[] not null, target_memory_id text not null,
  source_head_revision_ids text[] not null, merged_revision_id text,
  repository_strategy text not null check (repository_strategy in ('a','b','new','memory-only')),
  repository_url text, status text not null default 'awaiting-devices'
    check (status in ('awaiting-devices','complete')),
  created_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists public.portmgr_project_memory_aliases (
  alias_memory_id text primary key, canonical_memory_id text not null,
  merge_id text not null references public.portmgr_project_memory_merges(id),
  created_at timestamptz not null default now(), all_known_devices_migrated_at timestamptz,
  check (alias_memory_id <> canonical_memory_id)
);
create index if not exists idx_portmgr_project_memory_aliases_canonical
  on public.portmgr_project_memory_aliases(canonical_memory_id);
create table if not exists public.portmgr_project_memory_merge_devices (
  merge_id text not null references public.portmgr_project_memory_merges(id),
  device_id text not null, previous_memory_id text not null, device_name text,
  adopted_at timestamptz, primary key (merge_id,device_id,previous_memory_id)
);
create table if not exists public.portmgr_project_memory_device_retirements (
  memory_id text not null, device_id text not null,
  retired_at timestamptz not null default now(),
  primary key (memory_id,device_id)
);
create table if not exists public.portmgr_project_memory_trash (
  memory_id text primary key,
  trashed_at timestamptz not null default now()
);

-- A lineage merge must carry the immutable ledgers even when every source
-- device is offline forever. Source rows remain untouched; target copies use
-- deterministic identities so retries and migration replay are idempotent.
create or replace function public.portmgr_project_memory_feedback_lineage_id(
  p_target_memory_id text,p_origin_event_id text
)
returns text language sql immutable strict security invoker set search_path=public as $$
  select substr(encode(extensions.digest(convert_to(
    p_target_memory_id||chr(10)||p_origin_event_id,'UTF8'
  ),'sha256'),'hex'),1,32);
$$;

create or replace function public.portmgr_copy_project_memory_ledgers(
  p_source_memory_ids text[],p_target_memory_id text
)
returns void language plpgsql security invoker set search_path=public as $$
begin
  if p_target_memory_id is null or btrim(p_target_memory_id)=''
    or coalesce(array_length(p_source_memory_ids,1),0)=0 then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_COPY_TARGET_REQUIRED';
  end if;

  insert into public.portmgr_project_memory_journal(
    id,memory_id,entry_hash,device_id,device_name,project_name,agent,
    recorded_at,head_commit,summary,body
  )
  select p_target_memory_id||':'||source.entry_hash,p_target_memory_id,
    source.entry_hash,source.device_id,source.device_name,source.project_name,
    source.agent,source.recorded_at,source.head_commit,source.summary,source.body
  from (
    select distinct on (j.entry_hash)
      j.entry_hash,j.device_id,j.device_name,j.project_name,j.agent,
      j.recorded_at,j.head_commit,j.summary,j.body,j.id
    from public.portmgr_project_memory_journal j
    where j.memory_id=any(p_source_memory_ids) and j.memory_id<>p_target_memory_id
    order by j.entry_hash,j.recorded_at asc,j.id asc
  ) source
  on conflict(memory_id,entry_hash) do nothing;

  insert into public.portmgr_project_memory_feedback(
    id,origin_event_id,memory_id,entry_key,kind,evidence,device_id,recorded_at
  )
  select public.portmgr_project_memory_feedback_lineage_id(
      p_target_memory_id,coalesce(f.origin_event_id,f.id)),
    coalesce(f.origin_event_id,f.id),p_target_memory_id,
    f.entry_key,f.kind,f.evidence,f.device_id,f.recorded_at
  from public.portmgr_project_memory_feedback f
  where f.memory_id=any(p_source_memory_ids) and f.memory_id<>p_target_memory_id
    and not exists(
      select 1 from public.portmgr_project_memory_feedback existing
      where existing.memory_id=p_target_memory_id
        and coalesce(existing.origin_event_id,existing.id)=coalesce(f.origin_event_id,f.id)
    )
  order by f.recorded_at asc,f.id asc
  on conflict(id) do nothing;
end; $$;

create or replace function public.portmgr_copy_project_memory_ledgers_on_merge()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform public.portmgr_copy_project_memory_ledgers(new.source_memory_ids,new.target_memory_id);
  return new;
end; $$;
create or replace function public.portmgr_lock_project_memory_merge_ledgers()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_memory_id text;
begin
  for v_memory_id in
    select distinct candidate
    from unnest(new.source_memory_ids||array[new.target_memory_id]) candidate
    where candidate is not null and btrim(candidate)<>''
    order by candidate
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'portmgr-project-memory-ledger:'||v_memory_id,0
    ));
  end loop;
  return new;
end; $$;
drop trigger if exists portmgr_lock_project_memory_merge_ledgers
  on public.portmgr_project_memory_merges;
create trigger portmgr_lock_project_memory_merge_ledgers
before insert on public.portmgr_project_memory_merges
for each row execute function public.portmgr_lock_project_memory_merge_ledgers();
drop trigger if exists portmgr_copy_project_memory_ledgers_on_merge
  on public.portmgr_project_memory_merges;
create trigger portmgr_copy_project_memory_ledgers_on_merge
after insert on public.portmgr_project_memory_merges
for each row execute function public.portmgr_copy_project_memory_ledgers_on_merge();

create or replace function public.portmgr_resolve_project_memory_id(p_memory_id text)
returns text language plpgsql stable security invoker set search_path=public as $$
declare v_current text:=p_memory_id; v_next text; v_depth integer;
begin
  if v_current is null or btrim(v_current)='' then return v_current; end if;
  for v_depth in 1..20 loop
    select canonical_memory_id into v_next from public.portmgr_project_memory_aliases where alias_memory_id=v_current;
    if v_next is null then return v_current; end if;
    if v_next=v_current then raise exception using errcode='P0001',message='PROJECT_MEMORY_ALIAS_CYCLE'; end if;
    v_current:=v_next; v_next:=null;
  end loop;
  raise exception using errcode='P0001',message='PROJECT_MEMORY_ALIAS_CHAIN_TOO_DEEP';
end; $$;

create or replace function public.portmgr_claim_project_memory(p_repository_key text,p_proposed_memory_id text)
returns table(memory_id text,claimed boolean)
language plpgsql security invoker set search_path=public as $$
declare v_key text:=public.portmgr_canonical_repo_key(p_repository_key); v_existing text; v_legacy_ids text[];
begin
  if v_key is null or v_key='' then raise exception using errcode='22023',message='canonical repository key is required'; end if;
  if p_proposed_memory_id is null or btrim(p_proposed_memory_id)='' then raise exception using errcode='22023',message='proposed memory id is required'; end if;
  select m.memory_id into v_existing from public.portmgr_project_memories m where m.canonical_repo_key=v_key for update;
  if v_existing is not null then return query select public.portmgr_resolve_project_memory_id(v_existing),false; return; end if;
  select array_agg(distinct public.portmgr_resolve_project_memory_id(r.memory_id)
    order by public.portmgr_resolve_project_memory_id(r.memory_id)) into v_legacy_ids
  from public.portmgr_project_memory_revisions r where public.portmgr_canonical_repo_key(r.github_url)=v_key;
  if coalesce(array_length(v_legacy_ids,1),0)>1 then
    raise exception using errcode='P0001',message='PROJECT_MEMORY_IDENTITY_AMBIGUOUS',detail=array_to_string(v_legacy_ids,',');
  end if;
  v_existing:=coalesce(v_legacy_ids[1],public.portmgr_resolve_project_memory_id(p_proposed_memory_id));
  insert into public.portmgr_project_memories(memory_id,canonical_repo_key) values(v_existing,v_key)
  on conflict(canonical_repo_key) do nothing;
  select public.portmgr_resolve_project_memory_id(m.memory_id) into v_existing
  from public.portmgr_project_memories m where m.canonical_repo_key=v_key;
  return query select v_existing,true;
end; $$;

create or replace function public.portmgr_guard_project_memory_revision_insert()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_head text; v_key text:=public.portmgr_canonical_repo_key(new.github_url); v_registered text;
begin
  if v_key is not null then
    insert into public.portmgr_project_memories(memory_id,canonical_repo_key) values(new.memory_id,v_key)
    on conflict(canonical_repo_key) do nothing;
    select public.portmgr_resolve_project_memory_id(m.memory_id) into v_registered
    from public.portmgr_project_memories m where m.canonical_repo_key=v_key for update;
    if v_registered is distinct from public.portmgr_resolve_project_memory_id(new.memory_id) then
      raise exception using errcode='P0001',message='PROJECT_MEMORY_IDENTITY_MISMATCH',detail=v_registered;
    end if;
  end if;
  insert into public.portmgr_project_memory_heads(memory_id,head_revision_id) values(new.memory_id,null)
  on conflict(memory_id) do nothing;
  select head_revision_id into v_head from public.portmgr_project_memory_heads where memory_id=new.memory_id for update;
  if v_head is distinct from new.parent_revision_id then
    raise exception using errcode='40001',message='PROJECT_MEMORY_STALE_PARENT',detail=coalesce(v_head,'null');
  end if;
  update public.portmgr_project_memory_heads set head_revision_id=new.id,updated_at=now() where memory_id=new.memory_id;
  return new;
end; $$;

create or replace function public.portmgr_merge_project_memories(
  p_memory_a text,p_memory_b text,p_target_memory_id text,p_expected_head_a text,p_expected_head_b text,
  p_project_name text,p_display_name text,p_repository_strategy text,p_repository_url text,p_content text,p_content_hash text
)
returns table(merge_id text,target_memory_id text,merged_revision_id text,pending_device_count integer)
language plpgsql security definer set search_path=public as $$
declare v_a text:=public.portmgr_resolve_project_memory_id(p_memory_a); v_b text:=public.portmgr_resolve_project_memory_id(p_memory_b);
  v_target text:=p_target_memory_id; v_head_a text; v_head_b text; v_parent text;
  v_merge_id text:=gen_random_uuid()::text; v_revision_id text:=gen_random_uuid()::text; v_pending integer:=0;
begin
  if not(select public.portmgr_is_member()) then raise exception using errcode='42501',message='PORTMGR_MEMBER_REQUIRED'; end if;
  if v_a is null or v_b is null or v_a=v_b then raise exception using errcode='22023',message='PROJECT_MEMORY_MERGE_SOURCES_INVALID'; end if;
  if p_repository_strategy not in('a','b','new','memory-only') then raise exception using errcode='22023',message='PROJECT_MEMORY_REPOSITORY_STRATEGY_INVALID'; end if;
  if char_length(btrim(coalesce(p_display_name,''))) not between 1 and 60 then raise exception using errcode='22023',message='PROJECT_MEMORY_DISPLAY_NAME_INVALID'; end if;
  if octet_length(coalesce(p_content,''))=0 or octet_length(p_content)>1000000 then raise exception using errcode='22023',message='PROJECT_MEMORY_MERGED_CONTENT_INVALID'; end if;
  if encode(extensions.digest(convert_to(p_content,'UTF8'),'sha256'),'hex')<>p_content_hash then raise exception using errcode='22023',message='PROJECT_MEMORY_MERGED_HASH_INVALID'; end if;
  select head_revision_id into v_head_a from public.portmgr_project_memory_heads where memory_id=v_a for update;
  select head_revision_id into v_head_b from public.portmgr_project_memory_heads where memory_id=v_b for update;
  if v_head_a is distinct from p_expected_head_a or v_head_b is distinct from p_expected_head_b then raise exception using errcode='40001',message='PROJECT_MEMORY_MERGE_HEAD_CHANGED'; end if;
  if v_head_a is null or v_head_b is null then raise exception using errcode='22023',message='PROJECT_MEMORY_MERGE_HEAD_MISSING'; end if;
  if v_target=p_memory_a then v_target:=v_a; end if; if v_target=p_memory_b then v_target:=v_b; end if;
  if v_target not in(v_a,v_b) and exists(select 1 from public.portmgr_project_memory_heads where memory_id=v_target union all select 1 from public.portmgr_project_memory_aliases where alias_memory_id=v_target)
    then raise exception using errcode='23505',message='PROJECT_MEMORY_MERGE_TARGET_EXISTS'; end if;
  v_parent:=case when v_target=v_a then v_head_a when v_target=v_b then v_head_b else null end;
  insert into public.portmgr_project_memory_merges(id,source_memory_ids,target_memory_id,source_head_revision_ids,repository_strategy,repository_url)
  values(v_merge_id,array[v_a,v_b],v_target,array[v_head_a,v_head_b],p_repository_strategy,public.portmgr_canonical_repo_key(p_repository_url));
  update public.portmgr_project_memory_aliases set canonical_memory_id=v_target,merge_id=v_merge_id,all_known_devices_migrated_at=null
  where canonical_memory_id in(v_a,v_b) and alias_memory_id<>v_target;
  if v_a<>v_target then insert into public.portmgr_project_memory_aliases(alias_memory_id,canonical_memory_id,merge_id) values(v_a,v_target,v_merge_id)
    on conflict(alias_memory_id) do update set canonical_memory_id=excluded.canonical_memory_id,merge_id=excluded.merge_id,all_known_devices_migrated_at=null; end if;
  if v_b<>v_target then insert into public.portmgr_project_memory_aliases(alias_memory_id,canonical_memory_id,merge_id) values(v_b,v_target,v_merge_id)
    on conflict(alias_memory_id) do update set canonical_memory_id=excluded.canonical_memory_id,merge_id=excluded.merge_id,all_known_devices_migrated_at=null; end if;
  insert into public.portmgr_project_memory_merge_devices(merge_id,device_id,previous_memory_id,device_name)
  select v_merge_id,d.device_id,d.memory_id,max(d.device_name) from(
    select memory_id,device_id,device_name from public.portmgr_project_memory_devices where memory_id in(v_a,v_b)
    union all select memory_id,device_id,device_name from public.portmgr_project_memory_revisions where memory_id in(v_a,v_b)
  )d where d.device_id is not null group by d.device_id,d.memory_id on conflict do nothing;
  insert into public.portmgr_project_memory_heads(memory_id,head_revision_id) values(v_target,null) on conflict(memory_id) do nothing;
  insert into public.portmgr_project_memory_revisions(id,memory_id,parent_revision_id,project_name,github_url,device_id,device_name,source_path,content,content_hash)
  values(v_revision_id,v_target,v_parent,coalesce(nullif(btrim(p_project_name),''),'합병된 장기기억'),public.portmgr_canonical_repo_key(p_repository_url),null,'계보 합병','.agent-memory/CORE.md',p_content,p_content_hash);
  update public.portmgr_project_memory_merges set merged_revision_id=v_revision_id where id=v_merge_id;
  insert into public.portmgr_project_memory_labels(memory_id,display_name,updated_at) values(v_target,btrim(p_display_name),now())
  on conflict(memory_id) do update set display_name=excluded.display_name,updated_at=now();
  select count(*)::integer into v_pending from public.portmgr_project_memory_merge_devices where merge_id=v_merge_id and adopted_at is null;
  if v_pending=0 then update public.portmgr_project_memory_merges set status='complete',completed_at=now() where id=v_merge_id;
    update public.portmgr_project_memory_aliases set all_known_devices_migrated_at=now() where merge_id=v_merge_id; end if;
  return query select v_merge_id,v_target,v_revision_id,v_pending;
end; $$;

create or replace function public.portmgr_ack_project_memory_merge_device(p_target_memory_id text,p_device_id text)
returns integer language plpgsql security definer set search_path=public as $$
declare v_remaining integer;
begin
  if p_device_id is null or p_device_id='' then return 0; end if;
  update public.portmgr_project_memory_merge_devices d set adopted_at=coalesce(d.adopted_at,now())
  from public.portmgr_project_memory_merges m where m.target_memory_id=p_target_memory_id and d.merge_id=m.id and d.device_id=p_device_id and d.adopted_at is null;
  select count(*)::integer into v_remaining from public.portmgr_project_memory_merge_devices d join public.portmgr_project_memory_merges m on m.id=d.merge_id
  where m.target_memory_id=p_target_memory_id and d.adopted_at is null;
  if v_remaining=0 then update public.portmgr_project_memory_merges set status='complete',completed_at=coalesce(completed_at,now()) where target_memory_id=p_target_memory_id and status='awaiting-devices';
    update public.portmgr_project_memory_aliases set all_known_devices_migrated_at=coalesce(all_known_devices_migrated_at,now()) where canonical_memory_id=p_target_memory_id; end if;
  return v_remaining;
end; $$;

create or replace function public.portmgr_skip_retired_project_memory_merge_device()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if exists(
    select 1 from public.portmgr_project_memory_device_retirements r
    where r.device_id=new.device_id
      and public.portmgr_resolve_project_memory_id(r.memory_id)=public.portmgr_resolve_project_memory_id(new.previous_memory_id)
  ) then return null; end if;
  return new;
end; $$;
drop trigger if exists portmgr_skip_retired_project_memory_merge_device
  on public.portmgr_project_memory_merge_devices;
create trigger portmgr_skip_retired_project_memory_merge_device
before insert on public.portmgr_project_memory_merge_devices
for each row execute function public.portmgr_skip_retired_project_memory_merge_device();

create or replace function public.portmgr_set_project_memory_device_retired(
  p_memory_id text,p_device_id text,p_retired boolean
)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_memory text:=public.portmgr_resolve_project_memory_id(p_memory_id); v_merge record; v_remaining integer;
begin
  if not(select public.portmgr_is_member()) then raise exception using errcode='42501',message='PORTMGR_MEMBER_REQUIRED'; end if;
  if v_memory is null or btrim(v_memory)='' or p_device_id is null or btrim(p_device_id)='' then
    raise exception using errcode='22023',message='PROJECT_MEMORY_DEVICE_REQUIRED';
  end if;
  if coalesce(p_retired,false) then
    insert into public.portmgr_project_memory_device_retirements(memory_id,device_id,retired_at)
    values(v_memory,btrim(p_device_id),now())
    on conflict(memory_id,device_id) do update set retired_at=excluded.retired_at;
  else
    delete from public.portmgr_project_memory_device_retirements r
    where r.device_id=btrim(p_device_id)
      and public.portmgr_resolve_project_memory_id(r.memory_id)=v_memory;
  end if;
  for v_merge in select id,target_memory_id from public.portmgr_project_memory_merges where target_memory_id=v_memory loop
    select count(*)::integer into v_remaining
    from public.portmgr_project_memory_merge_devices d
    where d.merge_id=v_merge.id and d.adopted_at is null
      and not exists(
        select 1 from public.portmgr_project_memory_device_retirements r
        where r.device_id=d.device_id and public.portmgr_resolve_project_memory_id(r.memory_id)=v_memory
      );
    if v_remaining=0 then
      update public.portmgr_project_memory_merges set status='complete',completed_at=coalesce(completed_at,now()) where id=v_merge.id;
      update public.portmgr_project_memory_aliases set all_known_devices_migrated_at=coalesce(all_known_devices_migrated_at,now()) where merge_id=v_merge.id;
    elsif not coalesce(p_retired,false) then
      update public.portmgr_project_memory_merges set status='awaiting-devices',completed_at=null where id=v_merge.id;
      update public.portmgr_project_memory_aliases set all_known_devices_migrated_at=null where merge_id=v_merge.id;
    end if;
  end loop;
  return coalesce(p_retired,false);
end; $$;

create or replace function public.portmgr_set_project_memory_trashed(
  p_memory_id text,p_trashed boolean
)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_memory text:=public.portmgr_resolve_project_memory_id(p_memory_id);
begin
  if not(select public.portmgr_is_member()) then raise exception using errcode='42501',message='PORTMGR_MEMBER_REQUIRED'; end if;
  if v_memory is null or btrim(v_memory)='' then raise exception using errcode='22023',message='PROJECT_MEMORY_REQUIRED'; end if;
  if not exists(select 1 from public.portmgr_project_memory_heads where memory_id=v_memory)
    and not exists(select 1 from public.portmgr_project_memory_revisions where memory_id=v_memory) then
    raise exception using errcode='P0002',message='PROJECT_MEMORY_NOT_FOUND';
  end if;
  if coalesce(p_trashed,false) then
    insert into public.portmgr_project_memory_trash(memory_id,trashed_at) values(v_memory,now())
    on conflict(memory_id) do update set trashed_at=excluded.trashed_at;
  else
    delete from public.portmgr_project_memory_trash t
    where public.portmgr_resolve_project_memory_id(t.memory_id)=v_memory;
  end if;
  return coalesce(p_trashed,false);
end; $$;

do $$ declare t text; begin foreach t in array array['portmgr_project_memory_labels','portmgr_project_memory_merges','portmgr_project_memory_aliases','portmgr_project_memory_merge_devices','portmgr_project_memory_device_retirements','portmgr_project_memory_trash'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('drop policy if exists portmgr_authenticated_all on public.%I',t);
  execute format('drop policy if exists portmgr_authenticated_read on public.%I',t);
  execute format('create policy portmgr_authenticated_read on public.%I for select to authenticated using ((select public.portmgr_is_member()))',t);
  execute format('revoke all privileges on table public.%I from public, anon, authenticated, service_role',t);
  execute format('grant select on table public.%I to authenticated',t);
  execute format('grant select,insert,update,delete on table public.%I to service_role',t);
end loop; end $$;
drop policy if exists portmgr_authenticated_read on public.portmgr_project_memory_labels;
create policy portmgr_authenticated_all on public.portmgr_project_memory_labels for all to authenticated
using((select public.portmgr_is_member())) with check((select public.portmgr_is_member()));
grant select,insert,update,delete on table public.portmgr_project_memory_labels to authenticated;
revoke all on function public.portmgr_merge_project_memories(text,text,text,text,text,text,text,text,text,text,text) from public,anon;
grant execute on function public.portmgr_merge_project_memories(text,text,text,text,text,text,text,text,text,text,text) to authenticated,service_role;
revoke all on function public.portmgr_ack_project_memory_merge_device(text,text) from public,anon,authenticated;
grant execute on function public.portmgr_ack_project_memory_merge_device(text,text) to service_role;
revoke all on function public.portmgr_set_project_memory_device_retired(text,text,boolean) from public,anon;
grant execute on function public.portmgr_set_project_memory_device_retired(text,text,boolean) to authenticated,service_role;
revoke all on function public.portmgr_set_project_memory_trashed(text,boolean) from public,anon;
grant execute on function public.portmgr_set_project_memory_trashed(text,boolean) to authenticated,service_role;
revoke all on function public.portmgr_skip_retired_project_memory_merge_device() from public,anon,authenticated;
grant execute on function public.portmgr_skip_retired_project_memory_merge_device() to service_role;
revoke all on function public.portmgr_copy_project_memory_ledgers(text[],text) from public,anon,authenticated;
grant execute on function public.portmgr_copy_project_memory_ledgers(text[],text) to service_role;
revoke all on function public.portmgr_project_memory_feedback_lineage_id(text,text) from public,anon,authenticated;
grant execute on function public.portmgr_project_memory_feedback_lineage_id(text,text) to service_role;
revoke all on function public.portmgr_copy_project_memory_ledgers_on_merge() from public,anon,authenticated;
grant execute on function public.portmgr_copy_project_memory_ledgers_on_merge() to service_role;
revoke all on function public.portmgr_lock_project_memory_merge_ledgers() from public,anon,authenticated;
grant execute on function public.portmgr_lock_project_memory_merge_ledgers() to service_role;
grant execute on function public.portmgr_resolve_project_memory_id(text) to authenticated,service_role;`;

/** v15: cursor-based immutable-ledger replication and head-based directory paging. */
export const PROJECT_MEMORY_LEDGER_SCALE_SQL = `create table if not exists public.portmgr_project_memory_ledger_changes (
  sync_seq bigint generated always as identity primary key,
  layer text not null check(layer in('journal','feedback')),
  memory_id text not null,
  row_id text not null,
  created_at timestamptz not null default now(),
  unique(layer,row_id)
);
create index if not exists idx_portmgr_project_memory_ledger_changes_memory_seq
  on public.portmgr_project_memory_ledger_changes(memory_id,sync_seq);

create or replace function public.portmgr_record_project_memory_ledger_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_layer text:=tg_argv[0];
  v_canonical_memory_id text;
begin
  if v_layer not in('journal','feedback') then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_LAYER_INVALID';
  end if;
  -- Identity allocation is not commit order. Serialize both immutable layers
  -- per memory before allocating sync_seq so a cursor can never skip a late
  -- commit with a lower sequence.
  perform pg_advisory_xact_lock(hashtextextended(
    'portmgr-project-memory-ledger:'||new.memory_id,0
  ));
  insert into public.portmgr_project_memory_ledger_changes(layer,memory_id,row_id)
  values(v_layer,new.memory_id,new.id)
  on conflict(layer,row_id) do nothing;
  -- Late writes from an offline pre-merge device must remain visible on the
  -- canonical lineage. Forward only NEW (O(1)); the canonical trigger call
  -- resolves to itself and therefore terminates recursion.
  v_canonical_memory_id:=public.portmgr_resolve_project_memory_id(new.memory_id);
  if v_canonical_memory_id<>new.memory_id then
    if v_layer='journal' then
      insert into public.portmgr_project_memory_journal(
        id,memory_id,entry_hash,device_id,device_name,project_name,agent,
        recorded_at,head_commit,summary,body
      ) values(
        v_canonical_memory_id||':'||new.entry_hash,
        v_canonical_memory_id,new.entry_hash,new.device_id,new.device_name,
        new.project_name,new.agent,new.recorded_at,new.head_commit,new.summary,new.body
      ) on conflict(memory_id,entry_hash) do nothing;
    elsif v_layer='feedback' then
      insert into public.portmgr_project_memory_feedback(
        id,origin_event_id,memory_id,entry_key,kind,evidence,device_id,recorded_at
      ) select
        public.portmgr_project_memory_feedback_lineage_id(
          v_canonical_memory_id,coalesce(new.origin_event_id,new.id)
        ),
        coalesce(new.origin_event_id,new.id),v_canonical_memory_id,
        new.entry_key,new.kind,new.evidence,
        new.device_id,new.recorded_at
      where not exists(
        select 1 from public.portmgr_project_memory_feedback existing
        where existing.memory_id=v_canonical_memory_id
          and coalesce(existing.origin_event_id,existing.id)=coalesce(new.origin_event_id,new.id)
      ) on conflict(id) do nothing;
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists portmgr_record_project_memory_journal_change
  on public.portmgr_project_memory_journal;
create trigger portmgr_record_project_memory_journal_change
after insert on public.portmgr_project_memory_journal
for each row execute function public.portmgr_record_project_memory_ledger_change('journal');
drop trigger if exists portmgr_record_project_memory_feedback_change
  on public.portmgr_project_memory_feedback;
create trigger portmgr_record_project_memory_feedback_change
after insert on public.portmgr_project_memory_feedback
for each row execute function public.portmgr_record_project_memory_ledger_change('feedback');

-- Existing rows get an ingestion cursor once. Ordering among historical rows is
-- not semantic; every row only needs a stable position before new inserts.
insert into public.portmgr_project_memory_ledger_changes(layer,memory_id,row_id,created_at)
select 'journal',j.memory_id,j.id,coalesce(j.created_at,now())
from public.portmgr_project_memory_journal j
order by j.created_at nulls first,j.id
on conflict(layer,row_id) do nothing;
insert into public.portmgr_project_memory_ledger_changes(layer,memory_id,row_id,created_at)
select 'feedback',f.memory_id,f.id,coalesce(f.created_at,now())
from public.portmgr_project_memory_feedback f
order by f.created_at nulls first,f.id
on conflict(layer,row_id) do nothing;

create or replace function public.portmgr_lock_project_memory_merge_ledgers()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_memory_id text;
begin
  for v_memory_id in
    select distinct candidate
    from unnest(new.source_memory_ids||array[new.target_memory_id]) candidate
    where candidate is not null and btrim(candidate)<>''
    order by candidate
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'portmgr-project-memory-ledger:'||v_memory_id,0
    ));
  end loop;
  return new;
end; $$;
drop trigger if exists portmgr_lock_project_memory_merge_ledgers
  on public.portmgr_project_memory_merges;
create trigger portmgr_lock_project_memory_merge_ledgers
before insert on public.portmgr_project_memory_merges
for each row execute function public.portmgr_lock_project_memory_merge_ledgers();

-- Replay older merges in creation order. This is additive: source ledgers are
-- never changed, and deterministic target identities make reruns no-ops.
do $$ declare merged record; begin
  for merged in
    select source_memory_ids,target_memory_id
    from public.portmgr_project_memory_merges
    order by created_at asc,id asc
  loop
    perform public.portmgr_copy_project_memory_ledgers(
      merged.source_memory_ids,merged.target_memory_id
    );
  end loop;
end $$;

-- Repair missing, null, dangling, and stale heads from the deterministic latest
-- revision before the directory starts paging by one row per memory.
with latest as (
  select distinct on(r.memory_id) r.memory_id,r.id,
    coalesce(r.created_at,'epoch'::timestamptz) as updated_at
  from public.portmgr_project_memory_revisions r
  order by r.memory_id,r.created_at desc nulls last,r.id desc
)
insert into public.portmgr_project_memory_heads as head(memory_id,head_revision_id,updated_at)
select latest.memory_id,latest.id,latest.updated_at from latest
on conflict(memory_id) do update
set head_revision_id=excluded.head_revision_id,updated_at=excluded.updated_at
where head.head_revision_id is distinct from excluded.head_revision_id;
update public.portmgr_project_memory_heads head
set head_revision_id=null,updated_at=now()
where head.head_revision_id is not null
  and not exists(
    select 1 from public.portmgr_project_memory_revisions r
    where r.memory_id=head.memory_id
  );

create or replace function public.portmgr_project_memory_ledger_delta(
  p_memory_id text,p_after_seq text default '0',p_limit integer default 1000
)
returns table(seq text,layer text,row_id text,payload jsonb)
language plpgsql stable security invoker set search_path=public as $$
declare
  v_memory_id text;
  v_after_seq bigint;
  v_limit integer:=least(greatest(coalesce(p_limit,1000),1),1000);
begin
  if p_memory_id is null or btrim(p_memory_id)='' then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_MEMORY_ID_REQUIRED';
  end if;
  if coalesce(p_after_seq,'')!~'^[0-9]+$' then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end if;
  begin
    v_after_seq:=p_after_seq::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end;
  v_memory_id:=public.portmgr_resolve_project_memory_id(btrim(p_memory_id));

  return query
  select ledger_change.sync_seq::text,ledger_change.layer,ledger_change.row_id,
    case ledger_change.layer
      when 'journal' then case when journal.id is null then null::jsonb else jsonb_build_object(
        'memory_id',journal.memory_id,'entry_hash',journal.entry_hash,
        'recorded_at',journal.recorded_at,'agent',journal.agent,
        'head_commit',journal.head_commit,'summary',journal.summary,'body',journal.body
      ) end
      when 'feedback' then case when feedback.id is null then null::jsonb else jsonb_build_object(
        'id',feedback.id,'origin_event_id',feedback.origin_event_id,
        'memory_id',feedback.memory_id,'entry_key',feedback.entry_key,
        'kind',feedback.kind,'evidence',feedback.evidence,'device_id',feedback.device_id,
        'recorded_at',feedback.recorded_at
      ) end
      else null::jsonb
    end
  from public.portmgr_project_memory_ledger_changes ledger_change
  left join public.portmgr_project_memory_journal journal
    on ledger_change.layer='journal' and journal.id=ledger_change.row_id
  left join public.portmgr_project_memory_feedback feedback
    on ledger_change.layer='feedback' and feedback.id=ledger_change.row_id
  where ledger_change.memory_id=v_memory_id and ledger_change.sync_seq>v_after_seq
  order by ledger_change.sync_seq asc
  limit v_limit;
end; $$;

create or replace function public.portmgr_project_memory_ledger_cursor_status(
  p_memory_id text,p_cursor text,p_layer text,p_row_id text
)
returns table(cursor_valid boolean,max_seq text)
language plpgsql stable security invoker set search_path=public as $$
declare
  v_memory_id text;
  v_cursor bigint;
begin
  if p_memory_id is null or btrim(p_memory_id)=''
    or p_layer not in('journal','feedback')
    or p_row_id is null or p_row_id=''
    or octet_length(p_row_id)>1024 then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_ANCHOR_INVALID';
  end if;
  if coalesce(p_cursor,'')!~'^[0-9]+$' then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end if;
  begin
    v_cursor:=p_cursor::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode='22023',message='PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end;
  v_memory_id:=public.portmgr_resolve_project_memory_id(btrim(p_memory_id));
  return query select
    exists(
      select 1 from public.portmgr_project_memory_ledger_changes ledger_change
      where ledger_change.memory_id=v_memory_id and ledger_change.sync_seq=v_cursor
        and ledger_change.layer=p_layer and ledger_change.row_id=p_row_id
    ),
    coalesce((
      select max(ledger_change.sync_seq)
      from public.portmgr_project_memory_ledger_changes ledger_change
      where ledger_change.memory_id=v_memory_id
    ),0)::text;
end; $$;

create or replace function public.portmgr_list_project_memory_head_page(
  p_after_memory_id text default null,p_limit integer default 100
)
returns table(
  id text,memory_id text,project_name text,github_url text,device_id text,
  device_name text,content_hash text,created_at timestamptz
)
language sql stable security invoker set search_path=public as $$
  select
    case when selected_head.id is not null then selected_head.id else fallback.id end,
    head.memory_id,
    case when selected_head.id is not null then selected_head.project_name else fallback.project_name end,
    case when selected_head.id is not null then selected_head.github_url else fallback.github_url end,
    case when selected_head.id is not null then selected_head.device_id else fallback.device_id end,
    case when selected_head.id is not null then selected_head.device_name else fallback.device_name end,
    case when selected_head.id is not null then selected_head.content_hash else fallback.content_hash end,
    case when selected_head.id is not null then selected_head.created_at else fallback.created_at end
  from public.portmgr_project_memory_heads head
  left join public.portmgr_project_memory_revisions selected_head
    on selected_head.id=head.head_revision_id and selected_head.memory_id=head.memory_id
  left join lateral (
    select r.id,r.project_name,r.github_url,r.device_id,r.device_name,r.content_hash,r.created_at
    from public.portmgr_project_memory_revisions r
    where r.memory_id=head.memory_id and selected_head.id is null
    order by r.created_at desc nulls last,r.id desc
    limit 1
  ) fallback on true
  where (p_after_memory_id is null or head.memory_id>p_after_memory_id)
    and (selected_head.id is not null or fallback.id is not null)
  order by head.memory_id asc
  limit least(greatest(coalesce(p_limit,100),1),500);
$$;

alter table public.portmgr_project_memory_ledger_changes enable row level security;
drop policy if exists portmgr_authenticated_all on public.portmgr_project_memory_ledger_changes;
drop policy if exists portmgr_authenticated_read on public.portmgr_project_memory_ledger_changes;
do $$ declare predicate text; begin
  predicate:=case when to_regprocedure('public.portmgr_is_member()') is null
    then 'false' else '(select public.portmgr_is_member())' end;
  execute format(
    'create policy portmgr_authenticated_read on public.portmgr_project_memory_ledger_changes for select to authenticated using (%s)',
    predicate
  );
end $$;
revoke all privileges on table public.portmgr_project_memory_ledger_changes
  from public,anon,authenticated,service_role;
grant select on table public.portmgr_project_memory_ledger_changes
  to authenticated,service_role;
revoke all on function public.portmgr_record_project_memory_ledger_change()
  from public,anon,authenticated;
grant execute on function public.portmgr_record_project_memory_ledger_change()
  to service_role;
revoke all on function public.portmgr_project_memory_feedback_lineage_id(text,text)
  from public,anon,authenticated;
grant execute on function public.portmgr_project_memory_feedback_lineage_id(text,text)
  to service_role;
revoke all on function public.portmgr_project_memory_ledger_delta(text,text,integer)
  from public,anon;
grant execute on function public.portmgr_project_memory_ledger_delta(text,text,integer)
  to authenticated,service_role;
revoke all on function public.portmgr_project_memory_ledger_cursor_status(text,text,text,text)
  from public,anon;
grant execute on function public.portmgr_project_memory_ledger_cursor_status(text,text,text,text)
  to authenticated,service_role;
revoke all on function public.portmgr_list_project_memory_head_page(text,integer)
  from public,anon;
grant execute on function public.portmgr_list_project_memory_head_page(text,integer)
  to authenticated,service_role;
revoke all on function public.portmgr_lock_project_memory_merge_ledgers()
  from public,anon,authenticated;
grant execute on function public.portmgr_lock_project_memory_merge_ledgers()
  to service_role;`;

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

-- Server-ingestion order for cursor-based journal/feedback replication. The
-- ledger rows keep their original schema so older clients remain compatible.
create table if not exists portmgr_project_memory_ledger_changes (
  sync_seq bigint generated always as identity primary key,
  layer text not null check(layer in('journal','feedback')),
  memory_id text not null,
  row_id text not null,
  created_at timestamptz not null default now(),
  unique(layer,row_id)
);
create index if not exists idx_portmgr_project_memory_ledger_changes_memory_seq
  on portmgr_project_memory_ledger_changes(memory_id,sync_seq);

${PROJECT_MEMORY_IDENTITY_SQL}

${rlsPolicySql([...PROJECT_MEMORY_TABLES])}

${PROJECT_MEMORY_LEDGER_SECURITY_SQL}

${PROJECT_MEMORY_MERGE_SQL}

${PROJECT_MEMORY_LEDGER_SCALE_SQL}

${REMOTE_DEVICE_SQL}

${REMOTE_DEVICE_RECONNECT_SQL}

${REMOTE_HOST_PROJECTS_SQL}

${SAFE_REMOTE_DEVICE_ROTATION_SQL}

${REMOTE_DEVICE_CLAIM_RECOVERY_SQL}

${REMOTE_DEVICE_AGENT_VERSION_SQL}

${REMOTE_DEVICE_HISTORY_TOPIC_SQL}

${REMOTE_DEVICE_RECONNECT_LINEAGE_SQL}

${REMOTE_DEVICE_HISTORY_TRIGGER_FIX_SQL}

${MEMORY_DEVICE_REGISTRY_SQL}
${PROJECT_MEMORY_FEED_SQL}`;

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
grant execute on function public.portmgr_submit_voc(uuid, text, text, text, jsonb, text) to service_role;

create or replace function public.portmgr_submit_voc_admin(
  p_id uuid, p_device_hash text, p_app_version text, p_tab text, p_anchor jsonb, p_comment text
)
returns table(accepted boolean, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_accepting boolean;
  v_block_scope text;
begin
  select s.accepting into v_accepting
  from public.portmgr_voc_settings s where s.id = 'default';
  if not coalesce(v_accepting, false) then
    return query select false, 'disabled'::text; return;
  end if;
  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid device hash';
  end if;
  select b.scope into v_block_scope from public.portmgr_voc_blocklist b
  where b.device_hash = p_device_hash and (b.expires_at is null or b.expires_at > now());
  if v_block_scope is not null then
    return query select false, (v_block_scope || '_blocked')::text; return;
  end if;
  if p_comment is null or char_length(btrim(p_comment)) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'comment must be 1..4000 characters';
  end if;
  insert into public.portmgr_voc_inbox(id, app_version, tab, anchor, comment, device_hash)
  values (p_id, left(coalesce(p_app_version, ''), 100), left(coalesce(p_tab, ''), 50),
          coalesce(p_anchor, '{}'::jsonb), btrim(p_comment), p_device_hash)
  on conflict (id) do nothing;
  return query select true, null::text;
end;
$$;

revoke all on function public.portmgr_submit_voc_admin(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.portmgr_submit_voc_admin(uuid, text, text, text, jsonb, text) to service_role;`;

/**
 * Durable generation CAS and deletion fencing for port rows.
 *
 * Authenticated clients mutate through the atomic RPCs. Row triggers still
 * serialize privileged/legacy direct writes and require the active generation.
 * Actual existing-row changes advance the generation once; byte-identical
 * patches do not. The fence survives physical deletion forever.
 */
export const PORT_DURABLE_FENCE_PREREQUISITES_SQL = `-- Additive repair for legacy databases whose ports table predates the current
-- installer. RPC bodies use the complete row type, even for a partial patch.
-- Keep existing rows/values and their unknown creation times unchanged.
alter table public.portmgr_ports add column if not exists device_id text;
alter table public.portmgr_ports add column if not exists device_name text;
alter table public.portmgr_ports add column if not exists terminal_command text;
alter table public.portmgr_ports add column if not exists worktree_parent_id text;
alter table public.portmgr_ports add column if not exists github_urls text[];
alter table public.portmgr_ports add column if not exists manual_path text;
alter table public.portmgr_ports add column if not exists log_file_path text;
alter table public.portmgr_ports add column if not exists favorite boolean default false;
alter table public.portmgr_ports add column if not exists category text;
alter table public.portmgr_ports add column if not exists description text;
alter table public.portmgr_ports add column if not exists memo text;
alter table public.portmgr_ports add column if not exists memo_updated_at timestamptz;
alter table public.portmgr_ports add column if not exists memory_id text;
alter table public.portmgr_ports add column if not exists created_at timestamptz;
alter table public.portmgr_ports alter column created_at set default now();
`;

export const PORT_DURABLE_FENCE_SQL = `${PORT_DURABLE_FENCE_PREREQUISITES_SQL}
alter table public.portmgr_ports
  add column if not exists sync_generation bigint not null default 0;
alter table public.portmgr_ports add column if not exists memory_id text;
alter table public.portmgr_ports alter column sync_generation set default 0;
update public.portmgr_ports set sync_generation = 0 where sync_generation is null;
alter table public.portmgr_ports alter column sync_generation set not null;

create table if not exists public.portmgr_port_fences (
  port_id text primary key,
  generation bigint not null default 0 check (generation >= 0),
  state text not null default 'active' check (state in ('active', 'deleted')),
  owner_device_id text,
  deleted_name text,
  operation_id uuid,
  operation_base_generation bigint check (
    operation_base_generation is null or operation_base_generation >= 0
  ),
  operation_payload_sha256 text check (
    operation_payload_sha256 is null
    or operation_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  changed_at timestamptz not null default now()
);
alter table public.portmgr_port_fences add column if not exists deleted_name text;
alter table public.portmgr_port_fences
  add column if not exists operation_base_generation bigint;
alter table public.portmgr_port_fences
  add column if not exists operation_payload_sha256 text;
alter table public.portmgr_port_fences drop column if exists operation_payload;

-- Existing rows become active generation zero. A replay never rewrites a
-- permanent tombstone or a later restored generation.
insert into public.portmgr_port_fences(
  port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
)
select port.id, port.sync_generation, 'active', port.device_id, null, null, now()
from public.portmgr_ports port
on conflict (port_id) do nothing;

create or replace function public.portmgr_enforce_port_fence_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fence public.portmgr_port_fences%rowtype;
  v_upsert_operation_id text;
  v_upsert_port_id text;
  v_upsert_base_generation text;
  v_upsert_target_generation text;
begin
  if new.id is null or new.id = '' then
    raise exception using errcode = '23502', message = 'PORT_FENCE_ID_REQUIRED';
  end if;
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    raise exception using errcode = '22023', message = 'PORT_FENCE_ID_IMMUTABLE';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-port-fence:' || new.id, 0)
  );
  select fence.* into v_fence
  from public.portmgr_port_fences fence
  where fence.port_id = new.id
  for update;

  if not found then
    if tg_op = 'UPDATE' then
      insert into public.portmgr_port_fences(
        port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
      ) values (
        old.id, old.sync_generation, 'active', old.device_id, null, null, now()
      )
      on conflict (port_id) do nothing;
    else
      insert into public.portmgr_port_fences(
        port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
      ) values (
        new.id, 0, 'active', new.device_id, null, null, now()
      )
      on conflict (port_id) do nothing;
    end if;
    select fence.* into strict v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = new.id
    for update;
  end if;

  if v_fence.state <> 'active' then
    raise exception using
      errcode = '55000',
      message = 'PORT_FENCE_DELETED',
      detail = new.id;
  end if;

  if tg_op = 'INSERT' then
    if new.sync_generation is distinct from v_fence.generation then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_GENERATION_MISMATCH',
        detail = new.id;
    end if;
    if v_fence.owner_device_id is distinct from new.device_id then
      raise exception using
        errcode = '22023',
        message = 'PORT_FENCE_OWNER_IMMUTABLE',
        detail = new.id;
    end if;
    return new;
  end if;

  if new.device_id is distinct from old.device_id
    or v_fence.owner_device_id is distinct from old.device_id then
    raise exception using
      errcode = '22023',
      message = 'PORT_FENCE_OWNER_IMMUTABLE',
      detail = new.id;
  end if;

  if new.sync_generation is not distinct from old.sync_generation then
    if new.sync_generation is distinct from v_fence.generation then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_GENERATION_MISMATCH',
        detail = new.id;
    end if;
    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_UPSERT_RPC_REQUIRED',
        detail = new.id;
    end if;
    return new;
  end if;

  if old.sync_generation = 9223372036854775807 then
    raise exception using
      errcode = '22003',
      message = 'PORT_FENCE_GENERATION_EXHAUSTED',
      detail = new.id;
  end if;
  if new.sync_generation is distinct from old.sync_generation + 1
    or v_fence.generation is distinct from new.sync_generation then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_GENERATION_ADVANCE_INVALID',
      detail = new.id;
  end if;

  v_upsert_operation_id := nullif(
    current_setting('portmgr.port_upsert_operation_id', true),
    ''
  );
  v_upsert_port_id := nullif(
    current_setting('portmgr.port_upsert_port_id', true),
    ''
  );
  v_upsert_base_generation := nullif(
    current_setting('portmgr.port_upsert_base_generation', true),
    ''
  );
  v_upsert_target_generation := nullif(
    current_setting('portmgr.port_upsert_target_generation', true),
    ''
  );
  if v_fence.operation_id is null
    or v_fence.operation_payload_sha256 is null
    or v_upsert_operation_id is distinct from v_fence.operation_id::text
    or v_upsert_port_id is distinct from new.id
    or v_upsert_base_generation is distinct from old.sync_generation::text
    or v_upsert_target_generation is distinct from new.sync_generation::text
    or v_fence.operation_base_generation is distinct from old.sync_generation then
    raise exception using
      errcode = '42501',
      message = 'PORT_FENCE_GENERATION_ADVANCE_UNAUTHORIZED',
      detail = new.id;
  end if;
  return new;
end;
$$;

create or replace function public.portmgr_tombstone_port_fence_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fence public.portmgr_port_fences%rowtype;
  v_operation_setting text;
  v_operation_id uuid;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-port-fence:' || old.id, 0)
  );
  select fence.* into v_fence
  from public.portmgr_port_fences fence
  where fence.port_id = old.id
  for update;

  if not found then
    insert into public.portmgr_port_fences(
      port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
    ) values (
      old.id, old.sync_generation, 'active', old.device_id, null, null, now()
    )
    on conflict (port_id) do nothing;
    select fence.* into strict v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = old.id
    for update;
  end if;

  if v_fence.state <> 'active'
    or v_fence.generation is distinct from old.sync_generation then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_DELETE_GENERATION_MISMATCH',
      detail = old.id;
  end if;
  if v_fence.generation = 9223372036854775807 then
    raise exception using
      errcode = '22003',
      message = 'PORT_FENCE_GENERATION_EXHAUSTED',
      detail = old.id;
  end if;

  v_operation_setting := nullif(
    current_setting('portmgr.port_deletion_operation_id', true),
    ''
  );
  v_operation_id := case
    when v_operation_setting is null then gen_random_uuid()
    else v_operation_setting::uuid
  end;

  update public.portmgr_port_fences fence
  set generation = fence.generation + 1,
      state = 'deleted',
      owner_device_id = old.device_id,
      deleted_name = old.name,
      operation_id = v_operation_id,
      operation_base_generation = old.sync_generation,
      operation_payload_sha256 = null,
      changed_at = now()
  where fence.port_id = old.id
    and fence.state = 'active'
    and fence.generation = old.sync_generation;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_DELETE_GENERATION_MISMATCH',
      detail = old.id;
  end if;
  return old;
end;
$$;

drop trigger if exists portmgr_enforce_port_fence_write
  on public.portmgr_ports;
create trigger portmgr_enforce_port_fence_write
before insert or update on public.portmgr_ports
for each row execute function public.portmgr_enforce_port_fence_write();

drop trigger if exists portmgr_tombstone_port_fence_on_delete
  on public.portmgr_ports;
create trigger portmgr_tombstone_port_fence_on_delete
before delete on public.portmgr_ports
for each row execute function public.portmgr_tombstone_port_fence_on_delete();

create or replace function public.portmgr_upsert_ports_if_generation_matches(
  p_rows jsonb,
  p_upsert_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_payload jsonb;
  v_payload_sha256 text;
  v_row public.portmgr_ports%rowtype;
  v_existing public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_existing_found boolean;
  v_fence_found boolean;
  v_port_id text;
  v_new_generation bigint;
  v_row_changed boolean;
  v_mutation_count integer := 0;
  v_replay_count integer := 0;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_upsert_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_rows is null
    or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_UPSERT_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in (
          'id', 'sync_generation', 'device_id', 'device_name', 'name', 'port',
          'command_path', 'terminal_command', 'folder_path', 'worktree_parent_id',
          'deploy_url', 'github_url', 'github_urls', 'manual_path', 'log_file_path',
          'favorite', 'category', 'description', 'memo', 'memo_updated_at', 'memory_id',
          'created_at'
        )
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_UPSERT_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct (item ->> 'id'))
    from jsonb_array_elements(p_rows) as supplied(item)
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_UPSERT_ROW_DUPLICATE';
  end if;

  for v_port_id in
    select item ->> 'id'
    from jsonb_array_elements(p_rows) as supplied(item)
    order by item ->> 'id'
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  for v_item in
    select item
    from jsonb_array_elements(p_rows) as supplied(item)
    order by item ->> 'id'
  loop
    v_port_id := v_item ->> 'id';
    v_payload := jsonb_set(
      v_item,
      '{sync_generation}',
      to_jsonb(((v_item ->> 'sync_generation')::bigint)::text),
      true
    );
    v_payload_sha256 := encode(
      sha256(convert_to(v_payload::text, 'UTF8')),
      'hex'
    );
    select port.* into v_existing
    from public.portmgr_ports port
    where port.id = v_port_id
    for update;
    v_existing_found := found;

    if v_existing_found then
      select * into v_row
      from jsonb_populate_record(v_existing, v_item);
      v_row_changed := (to_jsonb(v_existing) - 'sync_generation')
        is distinct from (to_jsonb(v_row) - 'sync_generation');
    else
      select * into v_row
      from jsonb_populate_record(null::public.portmgr_ports, v_item);
      if not (v_item ? 'favorite') then v_row.favorite := false; end if;
      if not (v_item ? 'created_at') then v_row.created_at := now(); end if;
      v_row_changed := true;
    end if;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_port_id
    for update;
    v_fence_found := found;

    if not v_fence_found then
      if v_existing_found or v_row.sync_generation <> 0 then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
          detail = v_row.id;
      end if;
      v_mutation_count := v_mutation_count + 1;
    elsif v_fence.state <> 'active' then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_DELETED',
        detail = v_row.id;
    elsif v_fence.operation_id = p_upsert_op_id then
      if not v_existing_found
        or v_fence.operation_base_generation is distinct from v_row.sync_generation
        or v_fence.operation_payload_sha256 is distinct from v_payload_sha256
        or v_existing.sync_generation is distinct from v_fence.generation
        or v_existing.device_id is distinct from v_row.device_id
        or v_fence.owner_device_id is distinct from v_existing.device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_UPSERT_OPERATION_REUSED',
          detail = v_row.id;
      end if;
      v_replay_count := v_replay_count + 1;
    elsif not v_existing_found
      or v_fence.generation is distinct from v_row.sync_generation
      or v_existing.sync_generation is distinct from v_row.sync_generation then
      -- A caller that lost a committed response may retry with a fresh UUID
      -- and the old generation. Adopt only the immediately preceding exact
      -- base+payload operation. A generic partial-patch no-op is insufficient:
      -- it could otherwise grant a stale client write authority over omitted
      -- columns that another client changed.
      if v_existing_found
        and v_fence.generation is not distinct from v_existing.sync_generation
        and v_existing.sync_generation > v_row.sync_generation
        and not v_row_changed
        and v_existing.device_id is not distinct from v_row.device_id
        and v_fence.owner_device_id is not distinct from v_existing.device_id
        and v_fence.operation_base_generation is not distinct from v_row.sync_generation
        and v_fence.operation_payload_sha256 is not distinct from v_payload_sha256 then
        v_mutation_count := v_mutation_count + 1;
      else
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
          detail = v_row.id;
      end if;
    elsif v_existing.device_id is distinct from v_row.device_id
      or v_fence.owner_device_id is distinct from v_existing.device_id then
      raise exception using
        errcode = '22023',
        message = 'PORT_FENCE_OWNER_IMMUTABLE',
        detail = v_row.id;
    elsif v_row_changed
      and v_fence.generation = 9223372036854775807 then
      raise exception using
        errcode = '22003',
        message = 'PORT_FENCE_GENERATION_EXHAUSTED',
        detail = v_row.id;
    else
      v_mutation_count := v_mutation_count + 1;
    end if;
  end loop;

  if v_mutation_count > 0 and v_replay_count > 0 then
    raise exception using errcode = '40001', message = 'PORT_FENCE_UPSERT_MIXED_REPLAY';
  end if;

  if v_mutation_count > 0 then
    for v_item in
      select item
      from jsonb_array_elements(p_rows) as supplied(item)
      order by item ->> 'id'
    loop
      v_port_id := v_item ->> 'id';
      v_payload := jsonb_set(
        v_item,
        '{sync_generation}',
        to_jsonb(((v_item ->> 'sync_generation')::bigint)::text),
        true
      );
      v_payload_sha256 := encode(
        sha256(convert_to(v_payload::text, 'UTF8')),
        'hex'
      );
      select port.* into v_existing
      from public.portmgr_ports port
      where port.id = v_port_id
      for update;
      v_existing_found := found;
      if v_existing_found then
        select * into v_row
        from jsonb_populate_record(v_existing, v_item);
        v_row_changed := (to_jsonb(v_existing) - 'sync_generation')
          is distinct from (to_jsonb(v_row) - 'sync_generation');
      else
        select * into v_row
        from jsonb_populate_record(null::public.portmgr_ports, v_item);
        if not (v_item ? 'favorite') then v_row.favorite := false; end if;
        if not (v_item ? 'created_at') then v_row.created_at := now(); end if;
        v_row_changed := true;
      end if;

      if v_existing_found then
        -- A byte-identical patch records bounded latest-operation metadata but
        -- keeps the generation stable, avoiding a Push/Pull feedback loop.
        update public.portmgr_port_fences fence
        set generation = case
              when v_row_changed then fence.generation + 1
              else fence.generation
            end,
            deleted_name = null,
            operation_id = p_upsert_op_id,
            operation_base_generation = v_row.sync_generation,
            operation_payload_sha256 = v_payload_sha256,
            changed_at = now()
        where fence.port_id = v_row.id
          and fence.state = 'active'
          and fence.generation = v_existing.sync_generation
          and fence.owner_device_id is not distinct from v_existing.device_id
        returning fence.generation into v_new_generation;
        if not found then
          raise exception using
            errcode = '40001',
            message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
            detail = v_row.id;
        end if;

        if v_row_changed then
          v_row.sync_generation := v_new_generation;
          perform set_config(
            'portmgr.port_upsert_operation_id',
            p_upsert_op_id::text,
            true
          );
          perform set_config('portmgr.port_upsert_port_id', v_row.id, true);
          perform set_config(
            'portmgr.port_upsert_base_generation',
            v_existing.sync_generation::text,
            true
          );
          perform set_config(
            'portmgr.port_upsert_target_generation',
            v_new_generation::text,
            true
          );
          update public.portmgr_ports port
          set device_id = v_row.device_id,
              device_name = v_row.device_name,
              name = v_row.name,
              port = v_row.port,
              command_path = v_row.command_path,
              terminal_command = v_row.terminal_command,
              folder_path = v_row.folder_path,
              worktree_parent_id = v_row.worktree_parent_id,
              deploy_url = v_row.deploy_url,
              github_url = v_row.github_url,
              github_urls = v_row.github_urls,
              manual_path = v_row.manual_path,
              log_file_path = v_row.log_file_path,
              favorite = v_row.favorite,
              category = v_row.category,
              description = v_row.description,
              memo = v_row.memo,
              memo_updated_at = v_row.memo_updated_at,
              memory_id = v_row.memory_id,
              created_at = v_row.created_at,
              sync_generation = v_row.sync_generation
          where port.id = v_row.id
            and port.sync_generation = v_existing.sync_generation
            and port.device_id is not distinct from v_existing.device_id;
          if not found then
            raise exception using
              errcode = '40001',
              message = 'PORT_FENCE_UPSERT_GENERATION_MISMATCH',
              detail = v_row.id;
          end if;
          perform set_config('portmgr.port_upsert_operation_id', '', true);
          perform set_config('portmgr.port_upsert_port_id', '', true);
          perform set_config('portmgr.port_upsert_base_generation', '', true);
          perform set_config('portmgr.port_upsert_target_generation', '', true);
        end if;
      else
        insert into public.portmgr_port_fences(
          port_id, generation, state, owner_device_id, deleted_name, operation_id,
          operation_base_generation, operation_payload_sha256, changed_at
        ) values (
          v_row.id, 0, 'active', v_row.device_id, null, p_upsert_op_id,
          0, v_payload_sha256, now()
        );
        insert into public.portmgr_ports
        select (v_row).*;
      end if;
    end loop;
  end if;

  return query
  select item ->> 'id', fence.generation
  from jsonb_array_elements(p_rows) as supplied(item)
  join public.portmgr_port_fences fence on fence.port_id = (item ->> 'id')
  where fence.state = 'active'
    and fence.operation_id = p_upsert_op_id
    and fence.operation_base_generation = (item ->> 'sync_generation')::bigint
    and fence.operation_payload_sha256 = encode(
      sha256(convert_to(jsonb_set(
        item,
        '{sync_generation}',
        to_jsonb(((item ->> 'sync_generation')::bigint)::text),
        true
      )::text, 'UTF8')),
      'hex'
    )
  order by (item ->> 'id');
end;
$$;

create or replace function public.portmgr_delete_ports_if_identity_matches(
  p_expected_rows jsonb,
  p_deletion_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_expected record;
  v_port public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_found boolean;
  v_port_id text;
  v_active_count integer := 0;
  v_replay_count integer := 0;
  v_deleted_count integer := 0;
  v_previous_operation_setting text;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_deletion_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_expected_rows is null
    or jsonb_typeof(p_expected_rows) <> 'array'
    or jsonb_array_length(p_expected_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_expected_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct expected.id)
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_DUPLICATE';
  end if;

  -- Lock the complete batch in one deterministic order before inspecting any
  -- identity. This prevents opposite-order delete batches from deadlocking.
  for v_port_id in
    select expected.id
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    select port.* into v_port
    from public.portmgr_ports port
    where port.id = v_expected.id
    for update;
    v_port_found := found;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_expected.id
    for update;
    if not found then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_MISSING',
        detail = v_expected.id;
    end if;

    if v_fence.state = 'deleted'
      and v_fence.operation_id = p_deletion_op_id then
      if v_port_found
        or v_fence.generation - 1 is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_expected.device_id
        or v_fence.deleted_name is distinct from v_expected.name then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_DELETE_REPLAY_MISMATCH',
          detail = v_expected.id;
      end if;
      v_replay_count := v_replay_count + 1;
    elsif v_fence.state = 'active' then
      if not v_port_found
        or v_port.device_id is distinct from v_expected.device_id
        or v_port.name is distinct from v_expected.name
        or v_port.sync_generation is distinct from v_expected.sync_generation
        or v_fence.generation is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_port.device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_DELETE_IDENTITY_MISMATCH',
          detail = v_expected.id;
      end if;
      v_active_count := v_active_count + 1;
    else
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_DELETE_IDENTITY_MISMATCH',
        detail = v_expected.id;
    end if;
  end loop;

  if v_active_count > 0 and v_replay_count > 0 then
    raise exception using errcode = '40001', message = 'PORT_FENCE_DELETE_MIXED_REPLAY';
  end if;

  if v_active_count > 0 then
    v_previous_operation_setting := current_setting(
      'portmgr.port_deletion_operation_id',
      true
    );
    perform set_config(
      'portmgr.port_deletion_operation_id',
      p_deletion_op_id::text,
      true
    );
    delete from public.portmgr_ports port
    using jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    where port.id = expected.id;
    get diagnostics v_deleted_count = row_count;
    perform set_config(
      'portmgr.port_deletion_operation_id',
      coalesce(v_previous_operation_setting, ''),
      true
    );
    if v_deleted_count <> jsonb_array_length(p_expected_rows) then
      raise exception using errcode = '40001', message = 'PORT_FENCE_DELETE_COUNT_MISMATCH';
    end if;
  end if;

  return query
  select expected.id, fence.generation
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where fence.state = 'deleted'
    and fence.operation_id = p_deletion_op_id
    and fence.generation - 1 = expected.sync_generation
  order by expected.id;
end;
$$;

create or replace function public.portmgr_tombstone_absent_ports(
  p_expected_rows jsonb,
  p_deletion_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_expected record;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_id text;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_deletion_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_expected_rows is null
    or jsonb_typeof(p_expected_rows) <> 'array'
    or jsonb_array_length(p_expected_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_expected_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct expected.id)
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_DUPLICATE';
  end if;

  for v_port_id in
    select expected.id
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  -- This RPC has intentionally disjoint authority from the delete RPC: every
  -- supplied ID must already be absent before a missing permanent fence can be
  -- synthesized from the caller's captured identity.
  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform 1 from public.portmgr_ports port where port.id = v_expected.id;
    if found then
      raise exception using
        errcode = '55000',
        message = 'PORT_FENCE_ABSENT_ROW_PRESENT',
        detail = v_expected.id;
    end if;
    if v_expected.sync_generation = 9223372036854775807 then
      raise exception using
        errcode = '22003',
        message = 'PORT_FENCE_GENERATION_EXHAUSTED',
        detail = v_expected.id;
    end if;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_expected.id
    for update;
    if found then
      if v_fence.state <> 'deleted'
        or v_fence.generation - 1 is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_expected.device_id
        or v_fence.deleted_name is distinct from v_expected.name then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_ABSENT_IDENTITY_MISMATCH',
          detail = v_expected.id;
      end if;
    end if;
  end loop;

  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    insert into public.portmgr_port_fences(
      port_id, generation, state, owner_device_id, deleted_name, operation_id, changed_at
    ) values (
      v_expected.id, v_expected.sync_generation + 1, 'deleted',
      v_expected.device_id, v_expected.name, p_deletion_op_id, now()
    )
    on conflict (port_id) do nothing;
  end loop;

  return query
  select expected.id, fence.generation
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where fence.state = 'deleted'
    and fence.generation - 1 = expected.sync_generation
    and fence.owner_device_id is not distinct from expected.device_id
    and fence.deleted_name is not distinct from expected.name
  order by expected.id;
end;
$$;

create or replace function public.portmgr_delete_or_tombstone_ports_if_identity_matches(
  p_expected_rows jsonb,
  p_deletion_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_expected record;
  v_port public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_found boolean;
  v_fence_found boolean;
  v_port_id text;
  v_present_count integer := 0;
  v_deleted_count integer := 0;
  v_result_count integer := 0;
  v_previous_operation_setting text;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_deletion_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_expected_rows is null
    or jsonb_typeof(p_expected_rows) <> 'array'
    or jsonb_array_length(p_expected_rows) = 0 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROWS_REQUIRED';
  end if;

  for v_item in select value from jsonb_array_elements(p_expected_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_INVALID';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct expected.id)
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_EXPECTED_ROW_DUPLICATE';
  end if;

  -- One deterministic lock order covers both physical rows and absent IDs.
  -- No validation below may mutate either table.
  for v_port_id in
    select expected.id
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  -- Prevalidate the complete mixed batch before deleting or synthesizing any
  -- tombstone. A committed exact tombstone is accepted with a new UUID so a
  -- caller can reconcile a lost response without knowing the original UUID.
  for v_expected in
    select expected.id, expected.device_id, expected.name, expected.sync_generation
    from jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    order by expected.id
  loop
    if v_expected.sync_generation = 9223372036854775807 then
      raise exception using
        errcode = '22003',
        message = 'PORT_FENCE_GENERATION_EXHAUSTED',
        detail = v_expected.id;
    end if;

    select port.* into v_port
    from public.portmgr_ports port
    where port.id = v_expected.id
    for update;
    v_port_found := found;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_expected.id
    for update;
    v_fence_found := found;

    if v_port_found then
      if not v_fence_found
        or v_fence.state <> 'active'
        or v_port.device_id is distinct from v_expected.device_id
        or v_port.name is distinct from v_expected.name
        or v_port.sync_generation is distinct from v_expected.sync_generation
        or v_fence.generation is distinct from v_expected.sync_generation
        or v_fence.owner_device_id is distinct from v_port.device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_MIXED_IDENTITY_MISMATCH',
          detail = v_expected.id;
      end if;
      v_present_count := v_present_count + 1;
    elsif not v_fence_found then
      -- Exact missing identities are synthesized after every row validates.
      null;
    elsif v_fence.state = 'active' then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_ACTIVE_WITHOUT_PORT',
        detail = v_expected.id;
    elsif v_fence.state <> 'deleted'
      or v_fence.generation is distinct from v_expected.sync_generation + 1
      or coalesce(
        v_fence.operation_base_generation,
        v_fence.generation - 1
      ) is distinct from v_expected.sync_generation
      or v_fence.owner_device_id is distinct from v_expected.device_id
      or v_fence.deleted_name is distinct from v_expected.name then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_MIXED_IDENTITY_MISMATCH',
        detail = v_expected.id;
    end if;
  end loop;

  if v_present_count > 0 then
    v_previous_operation_setting := current_setting(
      'portmgr.port_deletion_operation_id',
      true
    );
    perform set_config(
      'portmgr.port_deletion_operation_id',
      p_deletion_op_id::text,
      true
    );
    delete from public.portmgr_ports port
    using jsonb_to_recordset(p_expected_rows) as expected(
      id text, device_id text, name text, sync_generation bigint
    )
    where port.id = expected.id
      and port.device_id is not distinct from expected.device_id
      and port.name is not distinct from expected.name
      and port.sync_generation = expected.sync_generation;
    get diagnostics v_deleted_count = row_count;
    perform set_config(
      'portmgr.port_deletion_operation_id',
      coalesce(v_previous_operation_setting, ''),
      true
    );
    if v_deleted_count <> v_present_count then
      raise exception using errcode = '40001', message = 'PORT_FENCE_MIXED_DELETE_COUNT_MISMATCH';
    end if;
  end if;

  -- After the physical deletes every supplied port is absent. Only IDs that
  -- had no fence before validation can still satisfy this insert predicate.
  insert into public.portmgr_port_fences(
    port_id, generation, state, owner_device_id, deleted_name, operation_id,
    operation_base_generation, operation_payload_sha256, changed_at
  )
  select expected.id, expected.sync_generation + 1, 'deleted',
         expected.device_id, expected.name, p_deletion_op_id,
         expected.sync_generation, null, now()
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  where not exists (
    select 1 from public.portmgr_port_fences fence
    where fence.port_id = expected.id
  );

  select count(*) into v_result_count
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where not exists (
      select 1 from public.portmgr_ports port where port.id = expected.id
    )
    and fence.state = 'deleted'
    and fence.generation = expected.sync_generation + 1
    and coalesce(
      fence.operation_base_generation,
      fence.generation - 1
    ) = expected.sync_generation
    and fence.owner_device_id is not distinct from expected.device_id
    and fence.deleted_name is not distinct from expected.name;
  if v_result_count <> jsonb_array_length(p_expected_rows) then
    raise exception using errcode = '40001', message = 'PORT_FENCE_MIXED_RESULT_COUNT_MISMATCH';
  end if;

  return query
  select expected.id, fence.generation
  from jsonb_to_recordset(p_expected_rows) as expected(
    id text, device_id text, name text, sync_generation bigint
  )
  join public.portmgr_port_fences fence on fence.port_id = expected.id
  where fence.state = 'deleted'
    and fence.generation = expected.sync_generation + 1
    and coalesce(
      fence.operation_base_generation,
      fence.generation - 1
    ) = expected.sync_generation
    and fence.owner_device_id is not distinct from expected.device_id
    and fence.deleted_name is not distinct from expected.name
  order by expected.id;
end;
$$;

create or replace function public.portmgr_restore_port_if_generation_matches(
  p_row jsonb,
  p_deleted_generation bigint,
  p_restore_op_id uuid
)
returns table(id text, generation bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.portmgr_ports%rowtype;
  v_existing public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_existing_found boolean;
  v_new_generation bigint;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_restore_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_row is null
    or jsonb_typeof(p_row) <> 'object'
    or not (p_row ? 'id')
    or not (p_row ? 'device_id')
    or not (p_row ? 'name')
    or not (p_row ? 'sync_generation')
    or jsonb_typeof(p_row -> 'id') <> 'string'
    or jsonb_typeof(p_row -> 'device_id') not in ('string', 'null')
    or jsonb_typeof(p_row -> 'name') <> 'string'
    or jsonb_typeof(p_row -> 'sync_generation') not in ('string', 'number')
    or coalesce(p_row ->> 'id', '') = ''
    or coalesce(p_row ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
    or exists (
      select 1
      from jsonb_object_keys(p_row) as supplied(field_name)
      where supplied.field_name not in (
        'id', 'sync_generation', 'device_id', 'device_name', 'name', 'port',
        'command_path', 'terminal_command', 'folder_path', 'worktree_parent_id',
        'deploy_url', 'github_url', 'github_urls', 'manual_path', 'log_file_path',
        'favorite', 'category', 'description', 'memo', 'memo_updated_at', 'memory_id',
        'created_at'
      )
    ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_RESTORE_ROW_INVALID';
  end if;
  if p_deleted_generation is null
    or p_deleted_generation < 1
    or p_deleted_generation = 9223372036854775807 then
    raise exception using errcode = '22023', message = 'PORT_FENCE_DELETED_GENERATION_INVALID';
  end if;

  select * into v_row
  from jsonb_populate_record(null::public.portmgr_ports, p_row);
  if v_row.sync_generation is distinct from p_deleted_generation - 1 then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_RESTORE_SOURCE_GENERATION_MISMATCH',
      detail = v_row.id;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('portmgr-port-fence:' || v_row.id, 0)
  );
  select fence.* into v_fence
  from public.portmgr_port_fences fence
  where fence.port_id = v_row.id
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'PORT_FENCE_MISSING',
      detail = v_row.id;
  end if;

  select port.* into v_existing
  from public.portmgr_ports port
  where port.id = v_row.id
  for update;
  v_existing_found := found;

  -- A committed restore can be retried with the same operation UUID.
  if v_fence.state = 'active'
    and v_fence.operation_id = p_restore_op_id
    and v_fence.generation = p_deleted_generation + 1 then
    if not v_existing_found
      or v_existing.sync_generation is distinct from v_fence.generation
      or v_fence.owner_device_id is distinct from v_row.device_id
      or (to_jsonb(v_existing) - 'sync_generation')
        is distinct from (to_jsonb(v_row) - 'sync_generation') then
      raise exception using
        errcode = '40001',
        message = 'PORT_FENCE_RESTORE_REPLAY_MISMATCH',
        detail = v_row.id;
    end if;
    return query select v_row.id, v_fence.generation;
    return;
  end if;

  if v_fence.state <> 'deleted'
    or v_fence.generation is distinct from p_deleted_generation
    or v_fence.owner_device_id is distinct from v_row.device_id
    or v_fence.deleted_name is distinct from v_row.name
    or v_existing_found then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_RESTORE_GENERATION_MISMATCH',
      detail = v_row.id;
  end if;

  update public.portmgr_port_fences fence
  set generation = fence.generation + 1,
      state = 'active',
      owner_device_id = v_row.device_id,
      deleted_name = null,
      operation_id = p_restore_op_id,
      operation_base_generation = p_deleted_generation,
      operation_payload_sha256 = null,
      changed_at = now()
  where fence.port_id = v_row.id
    and fence.state = 'deleted'
    and fence.generation = p_deleted_generation
  returning fence.generation into v_new_generation;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'PORT_FENCE_RESTORE_GENERATION_MISMATCH',
      detail = v_row.id;
  end if;

  v_row.sync_generation := v_new_generation;
  insert into public.portmgr_ports
  select (v_row).*;

  return query select v_row.id, v_new_generation;
end;
$$;

create or replace function public.portmgr_restore_ports_snapshot_if_preflight_matches(
  p_device_id text,
  p_restore_rows jsonb,
  p_exact_extra_rows jsonb,
  p_upsert_op_id uuid,
  p_delete_op_id uuid
)
returns table(id text, generation bigint, outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_row jsonb;
  v_candidate jsonb;
  v_expected_generation bigint;
  v_payload_sha256 text;
  v_port public.portmgr_ports%rowtype;
  v_fence public.portmgr_port_fences%rowtype;
  v_port_found boolean;
  v_fence_found boolean;
  v_regular_match boolean;
  v_replay_match boolean;
  v_port_id text;
  v_upsert_rows jsonb := '[]'::jsonb;
  v_skipped_rows jsonb := '[]'::jsonb;
begin
  if not (select public.portmgr_is_member()) then
    raise exception using errcode = '42501', message = 'PORTMGR_MEMBER_REQUIRED';
  end if;
  if p_upsert_op_id is null or p_delete_op_id is null then
    raise exception using errcode = '22023', message = 'PORT_FENCE_OPERATION_ID_REQUIRED';
  end if;
  if p_upsert_op_id = p_delete_op_id then
    raise exception using
      errcode = '22023',
      message = 'PORT_FENCE_SNAPSHOT_OPERATION_IDS_NOT_DISTINCT';
  end if;
  if p_restore_rows is null or jsonb_typeof(p_restore_rows) <> 'array'
    or p_exact_extra_rows is null or jsonb_typeof(p_exact_extra_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_ROWS_INVALID';
  end if;

  -- Desired snapshot bytes are separate from read-only preflight authority.
  -- A null expected_generation means that exact ID was absent at preflight.
  for v_item in select value from jsonb_array_elements(p_restore_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'row')
      or not (v_item ? 'expected_generation')
      or jsonb_typeof(v_item -> 'row') <> 'object'
      or jsonb_typeof(v_item -> 'expected_generation') not in ('string', 'null')
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('row', 'expected_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_RESTORE_ROW_INVALID';
    end if;
    v_row := v_item -> 'row';
    if not (v_row ? 'id')
      or not (v_row ? 'device_id')
      or not (v_row ? 'name')
      or jsonb_typeof(v_row -> 'id') <> 'string'
      or jsonb_typeof(v_row -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_row -> 'name') <> 'string'
      or coalesce(v_row ->> 'id', '') = ''
      or (v_row ->> 'device_id') is distinct from p_device_id
      or (jsonb_typeof(v_item -> 'expected_generation') = 'string'
        and coalesce(v_item ->> 'expected_generation', '') !~ '^(0|[1-9][0-9]*)$')
      or exists (
        select 1
        from jsonb_object_keys(v_row) as supplied(field_name)
        where supplied.field_name not in (
          'id', 'device_id', 'device_name', 'name', 'port',
          'command_path', 'terminal_command', 'folder_path', 'worktree_parent_id',
          'deploy_url', 'github_url', 'github_urls', 'manual_path', 'log_file_path',
          'favorite', 'category', 'description', 'memo', 'memo_updated_at', 'memory_id',
          'created_at'
        )
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_RESTORE_ROW_INVALID';
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_exact_extra_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'id')
      or not (v_item ? 'device_id')
      or not (v_item ? 'name')
      or not (v_item ? 'sync_generation')
      or jsonb_typeof(v_item -> 'id') <> 'string'
      or jsonb_typeof(v_item -> 'device_id') not in ('string', 'null')
      or jsonb_typeof(v_item -> 'name') <> 'string'
      or jsonb_typeof(v_item -> 'sync_generation') not in ('string', 'number')
      or coalesce(v_item ->> 'id', '') = ''
      or (v_item ->> 'device_id') is distinct from p_device_id
      or coalesce(v_item ->> 'sync_generation', '') !~ '^(0|[1-9][0-9]*)$'
      or exists (
        select 1
        from jsonb_object_keys(v_item) as supplied(field_name)
        where supplied.field_name not in ('id', 'device_id', 'name', 'sync_generation')
      ) then
      raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_EXTRA_ROW_INVALID';
    end if;
  end loop;

  if exists (
    select 1
    from (
      select item -> 'row' ->> 'id' as port_id
      from jsonb_array_elements(p_restore_rows) as supplied(item)
      union all
      select item ->> 'id' as port_id
      from jsonb_array_elements(p_exact_extra_rows) as supplied(item)
    ) supplied_ids
    group by supplied_ids.port_id
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'PORT_FENCE_SNAPSHOT_ROW_DUPLICATE';
  end if;

  -- Only the exact preflight scope is locked. A newly created unrelated row is
  -- intentionally preserved rather than inferred as a snapshot extra.
  for v_port_id in
    select supplied_ids.port_id
    from (
      select item -> 'row' ->> 'id' as port_id
      from jsonb_array_elements(p_restore_rows) as supplied(item)
      union
      select item ->> 'id' as port_id
      from jsonb_array_elements(p_exact_extra_rows) as supplied(item)
    ) supplied_ids
    order by supplied_ids.port_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('portmgr-port-fence:' || v_port_id, 0)
    );
  end loop;

  for v_item in
    select item
    from jsonb_array_elements(p_restore_rows) as supplied(item)
    order by item -> 'row' ->> 'id'
  loop
    v_row := v_item -> 'row';
    v_port_id := v_row ->> 'id';
    v_expected_generation := case
      when jsonb_typeof(v_item -> 'expected_generation') = 'null' then null
      else (v_item ->> 'expected_generation')::bigint
    end;
    v_candidate := v_row || jsonb_build_object(
      'sync_generation', coalesce(v_expected_generation, 0)::text
    );
    v_payload_sha256 := encode(
      sha256(convert_to(v_candidate::text, 'UTF8')),
      'hex'
    );

    select port.* into v_port
    from public.portmgr_ports port
    where port.id = v_port_id
    for update;
    v_port_found := found;

    select fence.* into v_fence
    from public.portmgr_port_fences fence
    where fence.port_id = v_port_id
    for update;
    v_fence_found := found;

    if v_fence_found and v_fence.state = 'deleted' then
      if v_port_found or v_fence.owner_device_id is distinct from p_device_id then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_SNAPSHOT_DELETED_IDENTITY_MISMATCH',
          detail = v_port_id;
      end if;
      v_skipped_rows := v_skipped_rows || jsonb_build_array(jsonb_build_object(
        'id', v_port_id,
        'generation', v_fence.generation::text
      ));
      continue;
    end if;

    v_replay_match := v_port_found
      and v_fence_found
      and v_fence.state = 'active'
      and v_fence.operation_id = p_upsert_op_id
      and v_fence.operation_base_generation is not distinct from coalesce(v_expected_generation, 0)
      and v_fence.operation_payload_sha256 is not distinct from v_payload_sha256
      and v_port.sync_generation is not distinct from v_fence.generation
      and v_port.device_id is not distinct from p_device_id
      and v_fence.owner_device_id is not distinct from p_device_id;

    if v_expected_generation is null then
      -- Zero alone is ambiguous: a different concurrent create can also be at
      -- generation zero. Only this exact child UUID + digest proves our replay.
      if not ((not v_port_found and not v_fence_found) or v_replay_match) then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_SNAPSHOT_CONCURRENT_APPEARANCE',
          detail = v_port_id;
      end if;
    else
      v_regular_match := v_port_found
        and v_fence_found
        and v_fence.state = 'active'
        and v_port.sync_generation is not distinct from v_expected_generation
        and v_fence.generation is not distinct from v_expected_generation
        and v_port.device_id is not distinct from p_device_id
        and v_fence.owner_device_id is not distinct from p_device_id;
      if not (v_regular_match or v_replay_match) then
        raise exception using
          errcode = '40001',
          message = 'PORT_FENCE_SNAPSHOT_GENERATION_MISMATCH',
          detail = v_port_id;
      end if;
    end if;

    v_upsert_rows := v_upsert_rows || jsonb_build_array(v_candidate);
  end loop;

  if jsonb_array_length(v_upsert_rows) > 0 then
    return query
    select restored.id, restored.generation, 'restored'::text
    from public.portmgr_upsert_ports_if_generation_matches(
      v_upsert_rows,
      p_upsert_op_id
    ) restored;
  end if;

  if jsonb_array_length(p_exact_extra_rows) > 0 then
    return query
    select removed.id, removed.generation, 'deleted_extra'::text
    from public.portmgr_delete_or_tombstone_ports_if_identity_matches(
      p_exact_extra_rows,
      p_delete_op_id
    ) removed;
  end if;

  return query
  select skipped.id, skipped.generation, 'skipped_deleted'::text
  from jsonb_to_recordset(v_skipped_rows) as skipped(id text, generation bigint)
  order by skipped.id;
end;
$$;

alter table public.portmgr_port_fences enable row level security;
drop policy if exists anon_all on public.portmgr_port_fences;
drop policy if exists "Enable read access for all users" on public.portmgr_port_fences;
drop policy if exists portmgr_authenticated_all on public.portmgr_port_fences;
drop policy if exists portmgr_authenticated_read on public.portmgr_port_fences;
create policy portmgr_authenticated_read on public.portmgr_port_fences
  for select to authenticated
  using ((select public.portmgr_is_member()));

revoke all privileges on table public.portmgr_port_fences
  from public, anon, authenticated, service_role;
grant select on table public.portmgr_port_fences to authenticated, service_role;
revoke all privileges on table public.portmgr_ports
  from authenticated, service_role;
grant select on table public.portmgr_ports to authenticated, service_role;

revoke all on function public.portmgr_enforce_port_fence_write()
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_tombstone_port_fence_on_delete()
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_upsert_ports_if_generation_matches(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_delete_ports_if_identity_matches(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_delete_or_tombstone_ports_if_identity_matches(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_tombstone_absent_ports(jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_restore_port_if_generation_matches(jsonb, bigint, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.portmgr_restore_ports_snapshot_if_preflight_matches(text, jsonb, jsonb, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.portmgr_upsert_ports_if_generation_matches(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_delete_ports_if_identity_matches(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_delete_or_tombstone_ports_if_identity_matches(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_tombstone_absent_ports(jsonb, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_restore_port_if_generation_matches(jsonb, bigint, uuid)
  to authenticated, service_role;
grant execute on function public.portmgr_restore_ports_snapshot_if_preflight_matches(text, jsonb, jsonb, uuid, uuid)
  to authenticated, service_role;`;

export const PROJECT_MEMORY_MENTION_SQL = `create table if not exists public.portmgr_project_memory_mentions (
  alias text not null check (alias ~ '^[a-zA-Z0-9가-힣]+(?:-[a-zA-Z0-9가-힣]+)*$'),
  memory_id text not null,
  status text not null check (status in ('primary','redirect')),
  updated_at timestamptz not null default now(),
  primary key (alias)
);
create unique index if not exists one_primary_per_memory on public.portmgr_project_memory_mentions(memory_id) where status = 'primary';
create or replace function public.portmgr_save_project_memory_mention(p_memory_id text, p_alias text)
returns setof public.portmgr_project_memory_mentions language plpgsql security definer set search_path = public as $$
begin
  if p_memory_id is null or btrim(p_memory_id) = '' or p_alias !~ '^[a-zA-Z0-9가-힣]+(?:-[a-zA-Z0-9가-힣]+)*$' then raise exception 'MENTION_ALIAS_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('project-memory-mentions', 0));
  if exists(select 1 from public.portmgr_project_memory_mentions where alias = p_alias and memory_id <> p_memory_id) then raise exception 'MENTION_ALIAS_RESERVED'; end if;
  update public.portmgr_project_memory_mentions set status = 'redirect', updated_at = now() where memory_id = p_memory_id and status = 'primary' and alias <> p_alias;
  insert into public.portmgr_project_memory_mentions(alias,memory_id,status) values (p_alias,p_memory_id,'primary')
    on conflict (alias) do update set status = 'primary', updated_at = now() where portmgr_project_memory_mentions.memory_id = excluded.memory_id;
  return query select * from public.portmgr_project_memory_mentions where memory_id = p_memory_id order by status,alias;
end; $$;
alter table public.portmgr_project_memory_mentions enable row level security;
drop policy if exists portmgr_project_memory_mentions_read on public.portmgr_project_memory_mentions;
create policy portmgr_project_memory_mentions_read on public.portmgr_project_memory_mentions
  for select to authenticated using ((select public.portmgr_is_member()));
revoke all on table public.portmgr_project_memory_mentions from public, anon;
grant select on table public.portmgr_project_memory_mentions to authenticated;
revoke all on function public.portmgr_save_project_memory_mention(text,text) from public, anon, authenticated;
grant execute on function public.portmgr_save_project_memory_mention(text,text) to service_role;`;

export const MIGRATION_SQL = `create table if not exists portmgr_ports (
  id text primary key,
  sync_generation bigint not null default 0,
  device_id text,
  device_name text,
  name text not null,
  port integer,
  command_path text,
  terminal_command text,
  folder_path text,
  worktree_parent_id text,
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
  memory_id text,
  created_at timestamptz default now()
);
alter table portmgr_ports add column if not exists sync_generation bigint not null default 0;
alter table portmgr_ports alter column sync_generation set default 0;
alter table portmgr_ports add column if not exists memory_id text;
alter table portmgr_ports add column if not exists device_id text;
alter table portmgr_ports add column if not exists device_name text;
alter table portmgr_ports add column if not exists worktree_parent_id text;
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

create table if not exists portmgr_github_repository_roles (
  repository_url text primary key,
  owner_login text not null,
  collaborators text[] not null default '{}',
  updated_at timestamptz not null default now()
);

${rlsPolicySql([...PORTMGR_CORE_TABLES])}

${CLIENT_ERROR_SQL}

${rlsPolicySql([...CLIENT_ERROR_TABLES])}

${PORT_DURABLE_FENCE_SQL}

${PROJECT_MEMORY_MIGRATION_SQL}

${REMOTE_CONTROL_RELAY_SQL}

${WHAT_I_SAID_REMOTE_SQL}

${WHAT_I_SAID_FEED_KEY_SQL}
${PROJECT_MEMORY_MENTION_SQL}

${VOC_SERVER_SQL}

${SHARED_PROMPT_GUIDE_SQL}`;

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
  return `${MIGRATION_SQL}\n\n-- 서버 권한의 단일 정본: 포털은 portmgr_is_member()로 이 목록을 확인한다.\ninsert into public.portmgr_allowed_members(email)\nvalues ${values}\non conflict (email) do nothing;`;
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

${rlsPolicySql(['portmgr_portal_items', 'portmgr_portal_categories'])}

${SHARED_PROMPT_GUIDE_SQL}`;

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
