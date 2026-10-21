/**
 * 「내가 한 말」 원격 적재 스키마.
 *
 * 로컬 저장소가 정본이고 이 테이블은 그 **피드 투영의 사본**이다 — 원문이 아니라
 * `redactWhatISaidForFeed`를 통과한 결과만 올라간다. 고신뢰 시크릿이 든 프롬프트는
 * 본문 없이 `withheld` 행으로만 남아서, 개수는 정직하게 유지되면서 시크릿은
 * 기기 밖으로 나가지 않는다.
 *
 * 이 사본이 존재하는 이유는 세 가지다: 여러 단말의 기록을 한자리에 모으고,
 * 다른 단말의 앱이 API로 소비하고, 나중에 프롬프트 자체를 분석·모니터링하는 것.
 * 그래서 서버에서 읽을 수 있어야 하고 — E2E 암호화와 양립하지 않는다. 대신
 * 레닥션 + RLS(회원 전용, anon 전면 차단) + 보관기간으로 지킨다.
 *
 * ⚠️ 보관기간과 삭제는 반드시 원격까지 전파돼야 한다. 로컬에서 지웠는데 원격에
 * 남으면 "삭제했다"가 거짓이 되고, 로컬 보관기간이 지나 사라졌는데 원격이
 * 영구히 남으면 "90일 보관"이 거짓이 된다. 이 앱은 이미 포트 삭제에서 같은
 * 사고를 겪었다(로컬만 지워 원격 150행 중 138행이 회수 불가능한 고아가 됨).
 */
export const WHAT_I_SAID_REMOTE_TABLES = [
  'portmgr_what_i_said_prompts',
] as const;

export const WHAT_I_SAID_REMOTE_SQL = `create table if not exists public.portmgr_what_i_said_prompts (
  -- 로컬 저장소가 만든 안정적인 이벤트 id. 재적재는 이 키로 멱등이다.
  id text primary key,
  device_id text not null,
  device_name text,
  memory_id text not null,
  project_name text,
  -- 로컬 시퀀스. 기기·프로젝트별로 "어디까지 올렸는지"를 원격에서 되읽는 근거라
  -- 로컬에 커서를 따로 두지 않는다(커서가 어긋나면 조용히 구멍이 생긴다).
  local_seq bigint not null,
  agent text not null check (agent in ('claude', 'codex')),
  prompt_origin text not null default 'unknown',
  recorded_at timestamptz not null,
  captured_at timestamptz not null,
  -- withheld 행은 본문이 없다. 있음/없음이 곧 레닥션 결과다.
  body text,
  content_hash text not null,
  -- 레닥션을 통과한 보이는 글의 키 없는 해시. content_hash 는 기기 키로 HMAC 되어
  -- 같은 글도 기기마다 값이 달라서, 여러 단말 기록이 섞인 이 테이블에서는
  -- 중복 판정·본문 대조에 쓸 수 없다.
  projection_hash text,
  redaction_state text not null check (redaction_state in ('clean', 'redacted', 'withheld')),
  redaction_reasons text[] not null default '{}',
  truncated boolean not null default false,
  -- 로컬 보관기간의 사본. NULL 은 'forever'.
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  -- 소비자용 커서. local_seq 는 저장소마다 1부터 다시 시작하는 값이라 여러 단말을
  -- 가로질러 페이징하면 통째로 건너뛰는 기기가 생긴다. created_at 도 한 배치가
  -- 같은 now() 를 공유해 유일하지 않다. 삽입 시 서버가 매기는 이 값만이 안전하다.
  -- 재적재(upsert)가 이 값을 다시 매기면 행이 소비자 커서 뒤로 밀려 영영 읽히지
  -- 않으므로, 갱신 목록에서 반드시 제외한다.
  feed_seq bigint generated always as identity,
  constraint portmgr_what_i_said_prompts_feed_seq_key unique (feed_seq),
  constraint portmgr_what_i_said_prompts_body_check
    check ((redaction_state = 'withheld' and body is null)
        or (redaction_state <> 'withheld' and body is not null)),
  constraint portmgr_what_i_said_prompts_prompt_origin_check
    check (prompt_origin in ('human', 'agentstoz', 'unknown'))
);
alter table public.portmgr_what_i_said_prompts
  add column if not exists device_name text;
alter table public.portmgr_what_i_said_prompts
  add column if not exists project_name text;
alter table public.portmgr_what_i_said_prompts
  add column if not exists projection_hash text;
alter table public.portmgr_what_i_said_prompts
  add column if not exists prompt_origin text not null default 'unknown';
alter table public.portmgr_what_i_said_prompts
  drop constraint if exists portmgr_what_i_said_prompts_prompt_origin_check;
alter table public.portmgr_what_i_said_prompts
  add constraint portmgr_what_i_said_prompts_prompt_origin_check
  check (prompt_origin in ('human', 'agentstoz', 'unknown'));
-- 생산자(각 Mac)가 "어디까지 올렸는지" 되읽는 커서.
create index if not exists idx_portmgr_what_i_said_prompts_cursor
  on public.portmgr_what_i_said_prompts(device_id, memory_id, local_seq desc);
-- 소비자(외부 앱)가 장기기억 단위로 페이징하는 커서.
create index if not exists idx_portmgr_what_i_said_prompts_feed
  on public.portmgr_what_i_said_prompts(memory_id, feed_seq);
create index if not exists idx_portmgr_what_i_said_prompts_recorded
  on public.portmgr_what_i_said_prompts(recorded_at desc);
create index if not exists idx_portmgr_what_i_said_prompts_retention
  on public.portmgr_what_i_said_prompts(retention_until)
  where retention_until is not null;

-- 보관기간이 지난 행을 지운다. 로컬 purge 와 짝이며, 로컬이 꺼져 있어도
-- 원격이 혼자 영구 보관본이 되지 않도록 서버에서도 만료를 강제한다.
create or replace function public.portmgr_what_i_said_cleanup(p_limit integer default 500)
returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_deleted integer;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  with doomed as (
    select p.id
    from public.portmgr_what_i_said_prompts p
    where p.retention_until is not null and p.retention_until <= now()
    order by p.retention_until
    limit v_limit
    for update skip locked
  )
  delete from public.portmgr_what_i_said_prompts p
  using doomed d where d.id = p.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.portmgr_what_i_said_cleanup(integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_cleanup(integer) to service_role;

-- Fresh-install parity with the deployed migration: later schema fragments are
-- appended after the core RLS generator, so this table must secure itself.
alter table public.portmgr_what_i_said_prompts enable row level security;
drop policy if exists "anon_all" on public.portmgr_what_i_said_prompts;
drop policy if exists "Enable read access for all users" on public.portmgr_what_i_said_prompts;
drop policy if exists portmgr_authenticated_all on public.portmgr_what_i_said_prompts;
create policy portmgr_authenticated_all on public.portmgr_what_i_said_prompts
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table public.portmgr_what_i_said_prompts from anon, public;
grant select, insert, update, delete on table public.portmgr_what_i_said_prompts
  to authenticated, service_role;`;
