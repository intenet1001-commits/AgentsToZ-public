-- 「내가 한 말」 원격 검색에 trigram 인덱스를 건다. (작성만 했고 적용은 사람이 한다)
--
-- 이전 RPC는 `position(lower(normalize(q)) in lower(normalize(body))) > 0` 으로 찾았다.
-- position()은 어떤 인덱스도 쓰지 못해서, 검색 한 번(그리고 「더 불러오기」마다)이
-- 선택한 장기기억의 모든 본문을 NFKC 정규화했다. 같은 정규화 식에 pg_trgm GIN
-- 인덱스를 걸고, 조회는 그 식에 LIKE(와일드카드 이스케이프한 리터럴)로 묻는다.
-- 의미는 그대로다: 대소문자·호환문자를 무시한 부분 문자열 일치, '%'·'_'는 글자 그대로.
--
-- ⚠️ 인덱스 생성은 표를 쓰기 잠근다(CONCURRENTLY는 트랜잭션 안에서 못 쓴다). 행 수가
-- 많으면 한가한 시간에 적용할 것. 3글자 미만 검색어는 trigram을 못 쓰므로 예전처럼 훑는다.
begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';

-- 원격 검색이 인덱스를 쓰게 한다. position()은 어떤 인덱스도 못 쓰므로 선택한 장기기억의
-- 모든 본문을 매번 NFKC 정규화했다(기록이 쌓일수록 느려지는 바로 그 증상). 같은 식에
-- trigram GIN 인덱스를 걸고, 조회 RPC는 이 식에 LIKE(이스케이프한 리터럴)로 묻는다.
-- pg_trgm 이 이미 다른 스키마에 있으면 그 스키마의 연산자 클래스를 쓴다.
do $what_i_said_trgm$
declare
  v_schema text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      create extension pg_trgm with schema extensions;
    else
      create extension pg_trgm;
    end if;
  end if;
  select n.nspname into v_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  execute format(
    'create index if not exists portmgr_what_i_said_prompts_body_trgm_idx '
    || 'on public.portmgr_what_i_said_prompts '
    || 'using gin ((lower(normalize(body, NFKC))) %I.gin_trgm_ops) '
    || 'where body is not null',
    v_schema
  );
end
$what_i_said_trgm$;

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
  -- '%'·'_'·'\'는 와일드카드가 아니라 사용자가 입력한 글자 그대로다.
  v_needle text := replace(replace(replace(lower(normalize(v_query, NFKC)), '\', '\\'), '%', '\%'), '_', '\_');
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
    and (v_query = '' or lower(normalize(p.body, NFKC)) like ('%' || v_needle || '%') escape '\')
    and not exists (
      select 1 from public.portmgr_what_i_said_memory_policy mp
      where mp.memory_id = p.memory_id and mp.upload_excluded
    )
  order by p.feed_seq desc
  limit v_limit + 1;
end;
$$;

revoke all on function public.portmgr_list_what_i_said_prompts(text[], text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_list_what_i_said_prompts(text[], text, text, text, text, integer)
  to service_role;

commit;
