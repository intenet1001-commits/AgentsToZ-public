/**
 * 「내가 한 말」 외부 앱 연결 키.
 *
 * **키의 단위는 소비하는 앱이고, 범위는 기본이 "올라간 전부"다.** 적재 정책이
 * "모든 장기기억 − 제외"이므로 읽기도 같은 모양이어야 둘이 맞물린다. 키를 장기기억
 * 하나에 묶으면 소비하는 앱이 프로젝트 수만큼 키를 등록해야 하고, 애초에 몇 개가
 * 필요한지 알아낼 방법도 없다.
 *
 * 제외한 장기기억은 **걸러지는 것이 아니라 없는 것**이다 — 적재 자체가 안 된다.
 *
 * ⚠️ 범위를 넓히면 예전에 "키 하나 = 장기기억 하나"가 대신 해 주던 방어가 사라진다.
 * 레닥션은 거부목록이라 고객명·계약 금액·내부 호스트명 같은 것은 보지 못한다.
 * 그래서 넓히는 것과 **같은 변경에서** 다음을 함께 둔다:
 *  - `allowed_memory_ids` — null 이면 전부, 배열이면 그 장기기억만. 좁은 키가
 *    필요해지면 스키마를 또 바꾸지 않고 이 컬럼으로 만든다.
 *  - `daily_limit` + 사용량 — 새어 나간 키가 조용히 전량을 긁어 가지 못하게 한다.
 *  - `expires_at` — 붙여 놓고 잊은 연결이 영원히 살아 있지 않게 한다.
 *
 * Edge Function 은 service_role 로 RPC 만 부르고 테이블을 직접 읽지 않는다
 * (submit-voc 와 같은 규약). 그래야 함수가 유출돼도 토큰 목록을 훑을 수 없다.
 */
export const WHAT_I_SAID_FEED_KEY_TABLES = [
  'portmgr_what_i_said_feed_keys',
  'portmgr_what_i_said_feed_key_usage',
  'portmgr_what_i_said_memory_policy',
] as const;

export const WHAT_I_SAID_FEED_KEY_SQL = `-- 장기기억 단위 정책. 수집·동기화와 제외 모두 이 축에 있어야 한다 — 기기별로 두면
-- Mac A에서 켜거나 제외해도 Mac B가 다른 정책으로 움직여 같은 기억의 결과가 갈린다.
create table if not exists public.portmgr_what_i_said_memory_policy (
  memory_id text primary key,
  -- 수집·동기화 동의는 Mac 설정이 아니라 장기기억 계보의 설정이다. 다른 Mac이
  -- 같은 memoryId를 복원하면 이 값을 읽어 같은 정책을 적용한다.
  capture_configured boolean not null default false,
  capture_enabled boolean not null default false,
  capture_enabled_at timestamptz,
  retention_days text not null default '90',
  analysis_allowed boolean not null default false,
  upload_excluded boolean not null default false,
  excluded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint portmgr_what_i_said_memory_policy_retention_days_check
    check (retention_days in ('30', '90', '365', 'forever'))
);
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists capture_configured boolean not null default false;
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists capture_enabled boolean not null default false;
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists capture_enabled_at timestamptz;
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists retention_days text not null default '90';
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists analysis_allowed boolean not null default false;
do $policy_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portmgr_what_i_said_memory_policy'::regclass
      and conname = 'portmgr_what_i_said_memory_policy_retention_days_check'
  ) then
    alter table public.portmgr_what_i_said_memory_policy
      add constraint portmgr_what_i_said_memory_policy_retention_days_check
      check (retention_days in ('30', '90', '365', 'forever')) not valid;
  end if;
end;
$policy_constraint$;
alter table public.portmgr_what_i_said_memory_policy
  validate constraint portmgr_what_i_said_memory_policy_retention_days_check;
create index if not exists idx_portmgr_what_i_said_memory_policy_excluded
  on public.portmgr_what_i_said_memory_policy(memory_id)
  where upload_excluded;

-- 제외를 저장 트랜잭션 안에서 강제한다. 클라이언트 판정만 믿으면 그 판정이 한 번
-- 어긋나는 순간(읽기 실패·경쟁·구버전 앱) 제외한 장기기억의 이력이 통째로 올라간다.
-- 여기서 막으면 어떤 경로로 들어와도 못 들어온다.
create or replace function public.portmgr_what_i_said_reject_excluded_upload()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- Serialize this memory with exclusion changes. Without the shared lock an
  -- upload that started just before exclusion could commit after the cleanup
  -- DELETE and leave a row behind.
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-memory:' || new.memory_id, 0));
  if exists (
    select 1 from public.portmgr_what_i_said_memory_policy p
    where p.memory_id = new.memory_id and p.upload_excluded
  ) then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_MEMORY_EXCLUDED';
  end if;
  return new;
end;
$$;

-- 여러 기억을 한 번에 켜거나 끄되, 정책의 정본은 각 memory_id 행이다. 다시
-- 적용할 때 이미 켜진 기억의 동의 시각은 보존하고, 껐다 다시 켤 때만 새 시각을
-- 잡아 OFF 기간의 transcript가 자동으로 따라 들어오지 않게 한다.
create or replace function public.portmgr_set_what_i_said_capture_policy(
  p_memory_ids text[],
  p_enabled boolean,
  p_retention_days text,
  p_analysis_allowed boolean
)
returns table(
  memory_id text,
  capture_configured boolean,
  capture_enabled boolean,
  capture_enabled_at timestamptz,
  retention_days text,
  analysis_allowed boolean,
  updated_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_ids is null or cardinality(p_memory_ids) < 1 or cardinality(p_memory_ids) > 2048
     or p_enabled is null or p_analysis_allowed is null
     or p_retention_days not in ('30', '90', '365', 'forever')
     or exists (
       select 1 from unnest(p_memory_ids) as value
       where value is null or btrim(value) = '' or char_length(value) > 512
     ) then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_CAPTURE_POLICY_INVALID';
  end if;

  return query
  insert into public.portmgr_what_i_said_memory_policy as policy (
    memory_id, capture_configured, capture_enabled, capture_enabled_at,
    retention_days, analysis_allowed, updated_at
  )
  select distinct btrim(value), true, p_enabled,
         case when p_enabled then now() else null end,
         p_retention_days, p_analysis_allowed, now()
  from unnest(p_memory_ids) as value
  on conflict on constraint portmgr_what_i_said_memory_policy_pkey do update
    set capture_configured = true,
        capture_enabled = excluded.capture_enabled,
        capture_enabled_at = case
          when excluded.capture_enabled and policy.capture_enabled
            then policy.capture_enabled_at
          else excluded.capture_enabled_at
        end,
        retention_days = excluded.retention_days,
        analysis_allowed = excluded.analysis_allowed,
        updated_at = excluded.updated_at
  returning policy.memory_id, policy.capture_configured, policy.capture_enabled,
            policy.capture_enabled_at, policy.retention_days,
            policy.analysis_allowed, policy.updated_at;
end;
$$;

-- 데스크톱의 교차-Mac 조회·검색 경로. 경로와 device_id를 입력으로 받지 않고,
-- 서버가 검증한 memoryId 집합만 받는다. position()을 쓰므로 '%'와 '_'도 와일드카드가
-- 아니라 사용자가 입력한 글자 그대로이며, NFKC 정규화로 한글/호환문자 검색을 맞춘다.
drop function if exists public.portmgr_list_what_i_said_prompts(text[], text, text, text, integer);
create or replace function public.portmgr_list_what_i_said_prompts(
  p_memory_ids text[],
  p_query text default '',
  p_agent text default null,
  p_prompt_origin text default null,
  p_before_feed_seq text default null,
  p_limit integer default 50
)
returns table(
  id text,
  memory_id text,
  project_name text,
  device_id text,
  device_name text,
  feed_seq text,
  agent text,
  prompt_origin text,
  recorded_at timestamptz,
  body text,
  redaction_state text
)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_query text := coalesce(p_query, '');
  v_before numeric := null;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_ids is null or cardinality(p_memory_ids) < 1 or cardinality(p_memory_ids) > 2048
     or octet_length(v_query) > 1024
     or (p_agent is not null and p_agent not in ('claude', 'codex'))
     or (p_prompt_origin is not null and p_prompt_origin not in ('human', 'agentstoz', 'unknown'))
     or exists (
       select 1 from unnest(p_memory_ids) as value
       where value is null or btrim(value) = '' or char_length(value) > 512
     )
     or (p_before_feed_seq is not null
       and (p_before_feed_seq !~ '^[0-9]+$' or char_length(p_before_feed_seq) > 20)) then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_LIST_INPUT_INVALID';
  end if;
  if p_before_feed_seq is not null then v_before := p_before_feed_seq::numeric; end if;

  return query
  select p.id, p.memory_id, p.project_name, p.device_id, p.device_name,
         p.feed_seq::text, p.agent, p.prompt_origin, p.recorded_at, p.body, p.redaction_state
  from public.portmgr_what_i_said_prompts p
  where p.memory_id = any(p_memory_ids)
    and p.body is not null
    and p.redaction_state <> 'withheld'
    and (p_agent is null or p.agent = p_agent)
    and (p_prompt_origin is null or p.prompt_origin = p_prompt_origin)
    and (v_before is null or p.feed_seq < v_before)
    and (v_query = '' or position(
      lower(normalize(v_query, NFKC)) in lower(normalize(p.body, NFKC))
    ) > 0)
    and not exists (
      select 1 from public.portmgr_what_i_said_memory_policy mp
      where mp.memory_id = p.memory_id and mp.upload_excluded
    )
  order by p.feed_seq desc
  limit v_limit + 1;
end;
$$;
drop trigger if exists portmgr_what_i_said_prompts_exclusion_guard
  on public.portmgr_what_i_said_prompts;
drop trigger if exists portmgr_what_i_said_prompts_10_exclusion_guard
  on public.portmgr_what_i_said_prompts;
create trigger portmgr_what_i_said_prompts_10_exclusion_guard
  before insert or update on public.portmgr_what_i_said_prompts
  for each row execute function public.portmgr_what_i_said_reject_excluded_upload();

-- Exclusion means both "reject future rows" and "no existing remote rows".
-- Keep the policy update and all-device cleanup in one transaction so callers
-- can never receive a successful policy write paired with a failed delete.
create or replace function public.portmgr_set_what_i_said_memory_exclusion(
  p_memory_id text,
  p_excluded boolean
)
returns bigint
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted bigint := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_id is null or btrim(p_memory_id) = '' or char_length(p_memory_id) > 512
     or p_excluded is null then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_MEMORY_POLICY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-memory:' || btrim(p_memory_id), 0));
  insert into public.portmgr_what_i_said_memory_policy(
    memory_id, upload_excluded, excluded_at, updated_at
  ) values (
    btrim(p_memory_id), p_excluded, case when p_excluded then now() else null end, now()
  )
  on conflict (memory_id) do update
    set upload_excluded = excluded.upload_excluded,
        excluded_at = excluded.excluded_at,
        updated_at = excluded.updated_at;
  if p_excluded then
    delete from public.portmgr_what_i_said_prompts p
    where p.memory_id = btrim(p_memory_id);
    get diagnostics v_deleted = row_count;
  end if;
  return v_deleted;
end;
$$;

-- Remote-first deletion uses the same memory advisory lock as INSERT's
-- exclusion guard. This closes database-transaction races; the sidecar also
-- holds its app-data file lock through the following local purge so another
-- local process cannot re-upload a page in the commit-to-purge gap.
create or replace function public.portmgr_delete_what_i_said_prompts(
  p_memory_id text,
  p_device_id text default null,
  p_ids text[] default null,
  p_all_devices boolean default false
)
returns bigint
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted bigint := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_id is null or btrim(p_memory_id) = '' or char_length(p_memory_id) > 512
     or p_all_devices is null
     or (not p_all_devices and (p_device_id is null or btrim(p_device_id) = ''))
     or (p_ids is not null and (
       cardinality(p_ids) = 0 or cardinality(p_ids) > 1000 or exists (
         select 1 from unnest(p_ids) as candidate(id)
         where candidate.id is null or candidate.id <> btrim(candidate.id)
           or candidate.id = '' or char_length(candidate.id) > 512
       )
     )) then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_REMOTE_DELETE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-memory:' || btrim(p_memory_id), 0));
  delete from public.portmgr_what_i_said_prompts p
  where p.memory_id = btrim(p_memory_id)
    and (p_all_devices or p.device_id = btrim(p_device_id))
    and (p_ids is null or p.id = any(p_ids));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create table if not exists public.portmgr_what_i_said_feed_keys (
  -- 회전은 같은 키의 값만 바꾼다. token_hash 를 PK 로 두면 회전이 곧 신원 변경이라
  -- UI 가 손잡이를 잃고 "회전"이 사실상 "회수 후 재발급"이 된다.
  id uuid primary key default extensions.gen_random_uuid(),
  -- 나중에 어느 연결을 끊을지 고르는 유일한 근거다. 비면 고를 수 없다.
  label text not null check (char_length(btrim(label)) between 1 and 120),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- 재열람용 원문. 같은 RLS 뒤의 프롬프트 본문보다 덜 민감하다.
  token text not null check (token ~ '^[0-9a-f]{64}$'),
  -- null 이면 올라간 전부. 배열이면 그 장기기억만.
  allowed_memory_ids text[],
  daily_limit integer not null default 20000 check (daily_limit between 1 and 1000000),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists idx_portmgr_what_i_said_feed_keys_active
  on public.portmgr_what_i_said_feed_keys(token_hash)
  where revoked_at is null;

-- 하루 사용량. 새어 나간 키가 조용히 전량을 긁어 가는 것을 막는 유일한 장치다.
create table if not exists public.portmgr_what_i_said_feed_key_usage (
  key_id uuid not null references public.portmgr_what_i_said_feed_keys(id) on delete cascade,
  usage_date date not null,
  rows_served bigint not null default 0,
  primary key (key_id, usage_date)
);

create or replace function public.portmgr_what_i_said_issue_feed_key(
  p_label text,
  p_token text,
  p_key_id uuid default null,
  p_allowed_memory_ids text[] default null,
  p_expires_at timestamptz default null
)
returns table(key_id uuid, key_label text, key_created_at timestamptz, key_rotated_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_TOKEN_INVALID';
  end if;
  if p_key_id is null and (p_label is null or char_length(btrim(p_label)) not between 1 and 120) then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_LABEL_INVALID';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  if p_key_id is null then
    insert into public.portmgr_what_i_said_feed_keys(label, token_hash, token, allowed_memory_ids, expires_at)
    values (btrim(p_label), v_hash, p_token, p_allowed_memory_ids, p_expires_at)
    returning id into v_id;
  else
    -- 회전은 제자리 UPDATE 다. 옛 해시가 살아남을 수 있는 경로를 만들지 않는다.
    update public.portmgr_what_i_said_feed_keys k
    set token_hash = v_hash,
        token = p_token,
        label = coalesce(nullif(btrim(coalesce(p_label, '')), ''), k.label),
        rotated_at = now(),
        revoked_at = null
    where k.id = p_key_id
    returning k.id into v_id;
    if v_id is null then
      raise exception using errcode = 'P0002', message = 'WHAT_I_SAID_KEY_NOT_FOUND';
    end if;
  end if;
  return query
    select k.id, k.label, k.created_at, k.rotated_at
    from public.portmgr_what_i_said_feed_keys k where k.id = v_id;
end;
$$;

create or replace function public.portmgr_what_i_said_revoke_feed_key(p_key_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_deleted integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  -- 회수는 행을 남기지 않는다. revoked_at 만 세우면 원문이 계속 남아 있어,
  -- "연결을 끊었다"고 믿는 사용자의 기대와 어긋난다.
  delete from public.portmgr_what_i_said_feed_keys k where k.id = p_key_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- Identity values are allocated before commit and therefore are not commit
-- ordered. Keep the existing GENERATED ALWAYS identity (schema compatibility),
-- but replace its final value with an O(1) nextval obtained while a transaction-
-- scoped lock is held. The unused default value creates a harmless gap; the
-- locked final values cannot be overtaken by a visible later transaction.
create or replace function public.portmgr_assign_what_i_said_feed_seq()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_sequence regclass;
begin
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-feed-sequence-v1', 0));
  v_sequence := pg_get_serial_sequence('public.portmgr_what_i_said_prompts', 'feed_seq')::regclass;
  if v_sequence is null then
    raise exception using errcode = '55000', message = 'WHAT_I_SAID_FEED_SEQUENCE_UNAVAILABLE';
  end if;
  new.feed_seq := nextval(v_sequence);
  return new;
end;
$$;
drop trigger if exists portmgr_what_i_said_prompts_feed_sequence
  on public.portmgr_what_i_said_prompts;
drop trigger if exists portmgr_what_i_said_prompts_00_feed_sequence
  on public.portmgr_what_i_said_prompts;
-- PostgreSQL runs same-kind triggers alphabetically. Inserts must always take
-- the global commit-order lock before the per-memory exclusion lock; otherwise
-- two multi-memory transactions can invert those locks and deadlock.
create trigger portmgr_what_i_said_prompts_00_feed_sequence
  before insert on public.portmgr_what_i_said_prompts
  for each row execute function public.portmgr_assign_what_i_said_feed_seq();
revoke all on function public.portmgr_assign_what_i_said_feed_seq()
  from public, anon;
grant execute on function public.portmgr_assign_what_i_said_feed_seq()
  to authenticated, service_role;

drop function if exists public.portmgr_what_i_said_feed(text, bigint, integer);
drop function if exists public.portmgr_what_i_said_feed(text, text, integer);
create or replace function public.portmgr_what_i_said_feed(
  p_token text,
  p_after text default '0',
  p_limit integer default 100
)
returns table(
  feed_seq text,
  id text,
  memory_id text,
  project_name text,
  device_name text,
  agent text,
  prompt_origin text,
  recorded_at timestamptz,
  retention_until timestamptz,
  body text,
  projection_hash text,
  redaction_state text,
  redaction_reasons text[],
  truncated boolean,
  next_cursor text,
  daily_remaining bigint
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_key public.portmgr_what_i_said_feed_keys%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  v_after bigint;
  v_used bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_FEED_UNAUTHORIZED';
  end if;
  if p_after is null or p_after !~ '^[0-9]{1,19}$' then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_CURSOR_INVALID';
  end if;
  begin
    v_after := p_after::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_CURSOR_INVALID';
  end;
  select * into v_key
  from public.portmgr_what_i_said_feed_keys k
  where k.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
    and k.revoked_at is null
  for update;
  -- 없는 키·회수된 키·만료된 키를 구분해 주지 않는다. 구분해 주면 키를 추측하는
  -- 쪽에 유효한 접두사를 알려 주는 셈이다.
  if not found or (v_key.expires_at is not null and v_key.expires_at <= now()) then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_FEED_UNAUTHORIZED';
  end if;

  insert into public.portmgr_what_i_said_feed_key_usage(key_id, usage_date, rows_served)
  values (v_key.id, current_date, 0)
  on conflict (key_id, usage_date) do nothing;
  select u.rows_served into v_used
  from public.portmgr_what_i_said_feed_key_usage u
  where u.key_id = v_key.id and u.usage_date = current_date
  for update;
  if v_used >= v_key.daily_limit then
    raise exception using errcode = '53400', message = 'WHAT_I_SAID_FEED_RATE_LIMITED';
  end if;
  -- The request limit may exceed today's remaining allowance. Cap the query,
  -- not merely the preflight check, so rows_served can never overshoot.
  v_limit := least(v_limit, (v_key.daily_limit - v_used)::integer);

  -- Select, charge, and return one MATERIALIZED page in one SQL statement.
  -- Separate count/max and return queries use different READ COMMITTED
  -- snapshots, so a concurrent commit can make the charged count, cursor, and
  -- returned rows disagree. The locked usage row serializes requests for this
  -- key and the page cap above prevents concurrent daily-limit overshoot.
  return query
    with selected as materialized (
      select p.feed_seq, p.id, p.memory_id, p.project_name, p.device_name, p.agent, p.prompt_origin,
             p.recorded_at, p.retention_until, p.body, p.projection_hash,
             p.redaction_state, p.redaction_reasons, p.truncated
      from public.portmgr_what_i_said_prompts p
      where p.feed_seq > v_after
        and (p.retention_until is null or p.retention_until > now())
        and (v_key.allowed_memory_ids is null or p.memory_id = any(v_key.allowed_memory_ids))
        and not exists (
          select 1 from public.portmgr_what_i_said_memory_policy mp
          where mp.memory_id = p.memory_id and mp.upload_excluded
        )
      order by p.feed_seq
      limit v_limit
    ), charged as (
      update public.portmgr_what_i_said_feed_key_usage u
      set rows_served = u.rows_served + (select count(*) from selected)
      where u.key_id = v_key.id and u.usage_date = current_date
      returning u.rows_served
    ), touched_key as (
      update public.portmgr_what_i_said_feed_keys k
      set last_used_at = now()
      where k.id = v_key.id
      returning k.id
    )
    select s.feed_seq::text, s.id, s.memory_id, s.project_name, s.device_name, s.agent, s.prompt_origin,
           s.recorded_at, s.retention_until, s.body, s.projection_hash,
           s.redaction_state, s.redaction_reasons, s.truncated,
           (max(s.feed_seq) over ())::text,
           (v_key.daily_limit - charged.rows_served)::bigint
    from selected s
    cross join charged
    cross join touched_key
    order by s.feed_seq;
end;
$$;

revoke all on function public.portmgr_what_i_said_feed(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_feed(text, text, integer) to service_role;
revoke all on function public.portmgr_set_what_i_said_memory_exclusion(text, boolean)
  from public, anon, authenticated;
grant execute on function public.portmgr_set_what_i_said_memory_exclusion(text, boolean) to service_role;
revoke all on function public.portmgr_set_what_i_said_capture_policy(text[], boolean, text, boolean)
  from public, anon, authenticated;
grant execute on function public.portmgr_set_what_i_said_capture_policy(text[], boolean, text, boolean)
  to service_role;
revoke all on function public.portmgr_list_what_i_said_prompts(text[], text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_list_what_i_said_prompts(text[], text, text, text, text, integer)
  to service_role;
revoke all on function public.portmgr_delete_what_i_said_prompts(text, text, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.portmgr_delete_what_i_said_prompts(text, text, text[], boolean)
  to service_role;
revoke all on function public.portmgr_what_i_said_issue_feed_key(text, text, uuid, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_issue_feed_key(text, text, uuid, text[], timestamptz) to service_role;
revoke all on function public.portmgr_what_i_said_revoke_feed_key(uuid)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_revoke_feed_key(uuid) to service_role;

-- Fresh schema is appended after the core RLS generator. Secure every table
-- created here explicitly so setup SQL and migrations have the same posture.
alter table public.portmgr_what_i_said_memory_policy enable row level security;
alter table public.portmgr_what_i_said_feed_keys enable row level security;
alter table public.portmgr_what_i_said_feed_key_usage enable row level security;

drop policy if exists "anon_all" on public.portmgr_what_i_said_memory_policy;
drop policy if exists "Enable read access for all users" on public.portmgr_what_i_said_memory_policy;
drop policy if exists portmgr_authenticated_all on public.portmgr_what_i_said_memory_policy;
create policy portmgr_authenticated_all on public.portmgr_what_i_said_memory_policy
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));

drop policy if exists "anon_all" on public.portmgr_what_i_said_feed_keys;
drop policy if exists "Enable read access for all users" on public.portmgr_what_i_said_feed_keys;
drop policy if exists portmgr_authenticated_all on public.portmgr_what_i_said_feed_keys;
create policy portmgr_authenticated_all on public.portmgr_what_i_said_feed_keys
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));

drop policy if exists "anon_all" on public.portmgr_what_i_said_feed_key_usage;
drop policy if exists "Enable read access for all users" on public.portmgr_what_i_said_feed_key_usage;
drop policy if exists portmgr_authenticated_all on public.portmgr_what_i_said_feed_key_usage;
create policy portmgr_authenticated_all on public.portmgr_what_i_said_feed_key_usage
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));

revoke all privileges on table public.portmgr_what_i_said_memory_policy from anon, public;
revoke all privileges on table public.portmgr_what_i_said_feed_keys from anon, public;
revoke all privileges on table public.portmgr_what_i_said_feed_key_usage from anon, public;
grant select, insert, update, delete on table public.portmgr_what_i_said_memory_policy
  to authenticated, service_role;
grant select, insert, update, delete on table public.portmgr_what_i_said_feed_keys
  to authenticated, service_role;
grant select, insert, update, delete on table public.portmgr_what_i_said_feed_key_usage
  to authenticated, service_role;`;
