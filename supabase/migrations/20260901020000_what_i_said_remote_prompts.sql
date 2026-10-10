-- 「내가 한 말」 원격 적재. 로컬 저장소가 정본이고 이 테이블은 피드 투영의 사본이다
-- (redactWhatISaidForFeed 통과분만; 고신뢰 시크릿 프롬프트는 본문 없는 withheld 행).
--
-- 목적은 셋이다: 여러 단말 기록을 한자리에 모으고, 다른 단말의 앱이 API로 소비하고,
-- 프롬프트 자체를 분석·모니터링하는 것. 서버에서 읽을 수 있어야 하므로 E2E 암호화와
-- 양립하지 않는다 — 대신 레닥션 + RLS(회원 전용, anon 전면 차단) + 보관기간으로 지킨다.
--
-- 보관기간·삭제는 원격까지 전파돼야 한다. 로컬만 지우면 "삭제했다"가 거짓이 되고,
-- 원격이 만료를 강제하지 않으면 "90일 보관"이 거짓이 된다.

create table if not exists public.portmgr_what_i_said_prompts (
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
  recorded_at timestamptz not null,
  captured_at timestamptz not null,
  -- withheld 행은 본문이 없다. 있음/없음이 곧 레닥션 결과다.
  body text,
  content_hash text not null,
  redaction_state text not null check (redaction_state in ('clean', 'redacted', 'withheld')),
  redaction_reasons text[] not null default '{}',
  truncated boolean not null default false,
  -- 로컬 보관기간의 사본. NULL 은 'forever'.
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  constraint portmgr_what_i_said_prompts_body_check
    check ((redaction_state = 'withheld' and body is null)
        or (redaction_state <> 'withheld' and body is not null))
);
alter table public.portmgr_what_i_said_prompts
  add column if not exists device_name text;
alter table public.portmgr_what_i_said_prompts
  add column if not exists project_name text;
create index if not exists idx_portmgr_what_i_said_prompts_cursor
  on public.portmgr_what_i_said_prompts(device_id, memory_id, local_seq desc);
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

alter table portmgr_what_i_said_prompts enable row level security;
drop policy if exists "anon_all" on portmgr_what_i_said_prompts;
drop policy if exists "Enable read access for all users" on portmgr_what_i_said_prompts;
drop policy if exists portmgr_authenticated_all on portmgr_what_i_said_prompts;
create policy portmgr_authenticated_all on portmgr_what_i_said_prompts
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all privileges on table portmgr_what_i_said_prompts from anon;
revoke all privileges on table portmgr_what_i_said_prompts from public;
grant select, insert, update, delete on table portmgr_what_i_said_prompts to authenticated, service_role;