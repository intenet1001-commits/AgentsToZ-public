-- 외부 앱 연결 키를 **장기기억 단위**로 옮긴다.
-- 예전 키는 각 Mac의 로컬 저장소 안에 있어서, 같은 장기기억을 두 대에서 쓰면 키가
-- 두 개가 되고 소비하는 앱이 단말 수만큼 키를 등록해야 했다. 저장소의 신원이 이미
-- memoryId 이므로 키도 같은 축으로 맞춘다.
--
-- 함께 고치는 두 가지 (여러 단말이 한 장기기억에 적재하면 드러나는 문제다):
--  1) feed_seq — 소비자용 커서. local_seq 는 저장소마다 1부터 다시 시작해서 교차
--     단말 페이징에 쓰면 기기가 통째로 건너뛰어진다. created_at 도 한 배치가 같은
--     now() 를 공유해 유일하지 않다. 서버가 삽입 시 매기는 값만 안전하다.
--  2) projection_hash — content_hash 는 기기 키로 HMAC 되어 같은 글도 기기마다
--     값이 달라진다. 단말을 가로지르는 중복 판정에는 키 없는 해시가 필요하다.

alter table public.portmgr_what_i_said_prompts
  add column if not exists projection_hash text;
alter table public.portmgr_what_i_said_prompts
  add column if not exists feed_seq bigint generated always as identity;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'portmgr_what_i_said_prompts_feed_seq_key'
  ) then
    alter table public.portmgr_what_i_said_prompts
      add constraint portmgr_what_i_said_prompts_feed_seq_key unique (feed_seq);
  end if;
end
$$;
create index if not exists idx_portmgr_what_i_said_prompts_feed
  on public.portmgr_what_i_said_prompts(memory_id, feed_seq);

create table if not exists public.portmgr_what_i_said_feed_keys (
  -- 장기기억 단위가 곧 키의 단위다. 단말이 몇 대든 키는 하나.
  memory_id text primary key,
  label text,
  -- 검증용. Edge Function 은 이 값으로만 조회한다.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- 재열람용 원문. 같은 RLS 뒤의 프롬프트 본문보다 덜 민감하다.
  token text not null check (token ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists idx_portmgr_what_i_said_feed_keys_active
  on public.portmgr_what_i_said_feed_keys(token_hash)
  where revoked_at is null;

-- 발급/회전. 같은 장기기억에 다시 부르면 기존 행을 교체하므로, 회전과 발급이
-- 같은 경로다 — 두 경로로 갈라 두면 "회전했는데 옛 키가 살아 있는" 상태가 생긴다.
create or replace function public.portmgr_what_i_said_issue_feed_key(
  p_memory_id text,
  p_token text,
  p_label text default null
)
returns table(memory_id text, created_at timestamptz, rotated_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_id is null or btrim(p_memory_id) = '' or char_length(p_memory_id) > 512 then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_MEMORY_ID_INVALID';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_TOKEN_INVALID';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  insert into public.portmgr_what_i_said_feed_keys(memory_id, label, token_hash, token)
  values (btrim(p_memory_id), nullif(btrim(coalesce(p_label, '')), ''), v_hash, p_token)
  on conflict (memory_id) do update
    set token_hash = excluded.token_hash,
        token = excluded.token,
        label = coalesce(excluded.label, public.portmgr_what_i_said_feed_keys.label),
        rotated_at = now(),
        revoked_at = null;
  return query
    select k.memory_id, k.created_at, k.rotated_at
    from public.portmgr_what_i_said_feed_keys k
    where k.memory_id = btrim(p_memory_id);
end;
$$;

create or replace function public.portmgr_what_i_said_revoke_feed_key(p_memory_id text)
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
  delete from public.portmgr_what_i_said_feed_keys k where k.memory_id = btrim(p_memory_id);
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- 외부 앱이 읽는 유일한 경로. Edge Function 이 service_role 로 이것만 부르고,
-- 테이블을 직접 읽지 않는다 — 함수가 유출돼도 토큰 목록을 훑을 수 없게 하기 위해서다.
-- 키가 곧 장기기억 단위의 선택자다: 어떤 memory_id 를 읽을지는 호출자가 정하지 않는다.
create or replace function public.portmgr_what_i_said_feed(
  p_token text,
  p_after bigint default 0,
  p_limit integer default 100
)
returns table(
  feed_seq bigint,
  id text,
  memory_id text,
  device_name text,
  agent text,
  recorded_at timestamptz,
  body text,
  projection_hash text,
  redaction_state text,
  redaction_reasons text[],
  truncated boolean
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_memory_id text;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  v_after bigint := greatest(coalesce(p_after, 0), 0);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_FEED_UNAUTHORIZED';
  end if;
  select k.memory_id into v_memory_id
  from public.portmgr_what_i_said_feed_keys k
  where k.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
    and k.revoked_at is null;
  if v_memory_id is null then
    -- 없는 키와 회수된 키를 구분해 주지 않는다.
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_FEED_UNAUTHORIZED';
  end if;
  update public.portmgr_what_i_said_feed_keys k
  set last_used_at = now() where k.memory_id = v_memory_id;
  return query
    select p.feed_seq, p.id, p.memory_id, p.device_name, p.agent, p.recorded_at,
           p.body, p.projection_hash, p.redaction_state, p.redaction_reasons, p.truncated
    from public.portmgr_what_i_said_prompts p
    where p.memory_id = v_memory_id
      and p.feed_seq > v_after
      and (p.retention_until is null or p.retention_until > now())
    order by p.feed_seq
    limit v_limit;
end;
$$;
revoke all on function public.portmgr_what_i_said_feed(text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_feed(text, bigint, integer) to service_role;

revoke all on function public.portmgr_what_i_said_issue_feed_key(text, text, text)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_issue_feed_key(text, text, text) to service_role;
revoke all on function public.portmgr_what_i_said_revoke_feed_key(text)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_revoke_feed_key(text) to service_role;

alter table portmgr_what_i_said_feed_keys enable row level security;
drop policy if exists "anon_all" on portmgr_what_i_said_feed_keys;
drop policy if exists "Enable read access for all users" on portmgr_what_i_said_feed_keys;
drop policy if exists portmgr_authenticated_all on portmgr_what_i_said_feed_keys;
create policy portmgr_authenticated_all on portmgr_what_i_said_feed_keys
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table portmgr_what_i_said_feed_keys from anon;
revoke all privileges on table portmgr_what_i_said_feed_keys from public;
grant select, insert, update, delete on table portmgr_what_i_said_feed_keys to authenticated, service_role;