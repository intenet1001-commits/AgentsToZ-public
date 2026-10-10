-- 키의 단위를 "장기기억 하나"에서 "소비하는 앱"으로 바꾸고, 범위를 "올라간 전부"로
-- 넓힌다. 적재가 "모든 장기기억 − 제외"이므로 읽기도 같은 모양이어야 맞물린다.
-- 예전 구조에서는 소비하는 앱이 프로젝트 수만큼 키를 등록해야 했고, 몇 개가
-- 필요한지 알아낼 방법조차 없었다.
--
-- 범위를 넓히면 "키 하나 = 장기기억 하나"가 대신 해 주던 방어가 사라진다. 그래서
-- 같은 변경에 함께 넣는다:
--   allowed_memory_ids  좁은 키가 필요할 때의 수단(스키마를 또 바꾸지 않는다)
--   daily_limit + 사용량  새어 나간 키가 조용히 전량을 긁어 가지 못하게
--   expires_at           붙여 놓고 잊은 연결이 영원히 살지 않게
--   제외 트리거           클라이언트 판정이 어긋나도 제외분이 저장되지 않게
--   커서 안전선           뒤의 forward migration이 feed_seq 자체를 commit-order로 만든다.
-- 기존 memory-scoped 키는 좁은 allowed_memory_ids 키로 보존한다. 배포 사이에 발급된
-- 키가 0개라고 가정하고 DROP하면 실제 연결을 조용히 끊을 수 있다.

drop function if exists public.portmgr_what_i_said_feed(text, bigint, integer);
drop function if exists public.portmgr_what_i_said_issue_feed_key(text, text, text);
drop function if exists public.portmgr_what_i_said_revoke_feed_key(text);
do $$
begin
  if to_regclass('public.portmgr_what_i_said_feed_keys') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'portmgr_what_i_said_feed_keys'
         and column_name = 'memory_id'
     ) then
    if to_regclass('public.portmgr_what_i_said_feed_keys_memory_legacy') is not null then
      raise exception 'WHAT_I_SAID_FEED_KEY_MIGRATION_AMBIGUOUS';
    end if;
    alter table public.portmgr_what_i_said_feed_keys
      rename to portmgr_what_i_said_feed_keys_memory_legacy;
  end if;
end
$$;
-- The index name follows the renamed legacy table; free the canonical name for
-- the new table before creating it.
drop index if exists public.idx_portmgr_what_i_said_feed_keys_active;

-- 장기기억 단위 정책. 제외는 이 축에 있어야 한다 — 기기별로 두면 Mac A 에서
-- 제외해도 Mac B 가 계속 올려서, 사용자가 "뺐다"고 믿는 프로젝트가 원격에 남는다.
-- 전역 스위치(이 Mac 이 적재를 하는가)는 기기의 결정이라 로컬에 남는다.
create table if not exists public.portmgr_what_i_said_memory_policy (
  memory_id text primary key,
  upload_excluded boolean not null default false,
  excluded_at timestamptz,
  updated_at timestamptz not null default now()
);
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
  if exists (
    select 1 from public.portmgr_what_i_said_memory_policy p
    where p.memory_id = new.memory_id and p.upload_excluded
  ) then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_MEMORY_EXCLUDED';
  end if;
  return new;
end;
$$;
drop trigger if exists portmgr_what_i_said_prompts_exclusion_guard
  on public.portmgr_what_i_said_prompts;
create trigger portmgr_what_i_said_prompts_exclusion_guard
  before insert or update on public.portmgr_what_i_said_prompts
  for each row execute function public.portmgr_what_i_said_reject_excluded_upload();

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

do $$
begin
  if to_regclass('public.portmgr_what_i_said_feed_keys_memory_legacy') is not null then
    execute $migrate$
      insert into public.portmgr_what_i_said_feed_keys(
        label, token_hash, token, allowed_memory_ids, created_at, rotated_at, last_used_at, revoked_at
      )
      select coalesce(nullif(btrim(label), ''), '기존 연결 · ' || right(memory_id, 8)),
             token_hash, token, array[memory_id], created_at, rotated_at, last_used_at, revoked_at
      from public.portmgr_what_i_said_feed_keys_memory_legacy
      on conflict (token_hash) do nothing
    $migrate$;
    drop table public.portmgr_what_i_said_feed_keys_memory_legacy cascade;
  end if;
end
$$;

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

create or replace function public.portmgr_what_i_said_feed(
  p_token text,
  p_after bigint default 0,
  p_limit integer default 100
)
returns table(
  feed_seq bigint,
  id text,
  memory_id text,
  project_name text,
  device_name text,
  agent text,
  recorded_at timestamptz,
  retention_until timestamptz,
  body text,
  projection_hash text,
  redaction_state text,
  redaction_reasons text[],
  truncated boolean,
  next_cursor bigint,
  daily_remaining bigint
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_key public.portmgr_what_i_said_feed_keys%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  v_after bigint := greatest(coalesce(p_after, 0), 0);
  v_used bigint;
  v_watermark bigint;
  v_served bigint;
  v_next bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_FEED_UNAUTHORIZED';
  end if;
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

  -- 커서 안전선. feed_seq 는 identity 라 **커밋 순서를 보장하지 않는다** — 100 번이
  -- 아직 커밋되지 않은 사이에 101 번이 보이면, 커서를 101 로 옮긴 소비자는 100 번을
  -- 영원히 못 본다. 그래서 아직 정착하지 않았을 수 있는 꼬리는 커서를 전진시키지
  -- 않는다. 행 자체는 돌려주므로 앱은 즉시 보고 다음 요청 때 다시 받을 뿐이다.
  -- **중복은 허용하고 유실은 허용하지 않는다.** 소비자는 id 로 중복을 제거한다.
  select coalesce(max(p.feed_seq), 0) into v_watermark
  from public.portmgr_what_i_said_prompts p
  where p.created_at < now() - interval '10 seconds';

  select count(*), coalesce(max(s.feed_seq) filter (where s.feed_seq <= v_watermark), v_after)
  into v_served, v_next
  from (
    select p.feed_seq
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
  ) s;

  update public.portmgr_what_i_said_feed_key_usage u
  set rows_served = u.rows_served + v_served
  where u.key_id = v_key.id and u.usage_date = current_date;
  update public.portmgr_what_i_said_feed_keys k
  set last_used_at = now() where k.id = v_key.id;

  return query
    select p.feed_seq, p.id, p.memory_id, p.project_name, p.device_name, p.agent,
           p.recorded_at, p.retention_until, p.body, p.projection_hash,
           p.redaction_state, p.redaction_reasons, p.truncated,
           v_next, (v_key.daily_limit - v_used - v_served)::bigint
    from public.portmgr_what_i_said_prompts p
    where p.feed_seq > v_after
      and (p.retention_until is null or p.retention_until > now())
      and (v_key.allowed_memory_ids is null or p.memory_id = any(v_key.allowed_memory_ids))
      and not exists (
        select 1 from public.portmgr_what_i_said_memory_policy mp
        where mp.memory_id = p.memory_id and mp.upload_excluded
      )
    order by p.feed_seq
    limit v_limit;
end;
$$;

revoke all on function public.portmgr_what_i_said_feed(text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_feed(text, bigint, integer) to service_role;
revoke all on function public.portmgr_what_i_said_issue_feed_key(text, text, uuid, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_issue_feed_key(text, text, uuid, text[], timestamptz) to service_role;
revoke all on function public.portmgr_what_i_said_revoke_feed_key(uuid)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_revoke_feed_key(uuid) to service_role;

alter table portmgr_what_i_said_feed_keys enable row level security;
alter table portmgr_what_i_said_feed_key_usage enable row level security;
drop policy if exists portmgr_authenticated_all on portmgr_what_i_said_feed_keys;
create policy portmgr_authenticated_all on portmgr_what_i_said_feed_keys
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
drop policy if exists portmgr_authenticated_all on portmgr_what_i_said_feed_key_usage;
create policy portmgr_authenticated_all on portmgr_what_i_said_feed_key_usage
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table portmgr_what_i_said_feed_keys from anon, public;
revoke all privileges on table portmgr_what_i_said_feed_key_usage from anon, public;
grant select, insert, update, delete on table portmgr_what_i_said_feed_keys to authenticated, service_role;
grant select, insert, update, delete on table portmgr_what_i_said_feed_key_usage to authenticated, service_role;
