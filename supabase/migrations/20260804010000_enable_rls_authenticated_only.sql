-- ============================================================================
-- portmgr_* 7개 테이블 RLS 활성화 — anon 전면 차단, 로그인 사용자만 전체 허용
-- ============================================================================
--
-- 무엇을 하는 SQL인가
--   1) portmgr_ 로 시작하는 앱 테이블 7개에 Row Level Security를 켠다.
--   2) `TO authenticated` 정책만 만든다 → anon key가 유출돼도 로그인(JWT) 없이는
--      SELECT/INSERT/UPDATE/DELETE가 전부 거부된다.
--   3) (방어 심층화) anon 롤에서 테이블 권한 자체를 REVOKE 한다.
--      혹시 나중에 누군가 RLS를 다시 끄더라도 anon은 여전히 접근하지 못한다.
--
-- 왜 정책이 "로그인했으면 전부 허용"인가
--   이 앱은 단일 사용자 개인 도구다. 멀티테넌트가 아니다.
--   device_id / '__shared__' 격리는 앱 레벨 필터링(Push/Pull 로직)이며
--   RLS로 device_id를 강제하면 "다른 기기 데이터 가져오기" 기능이 깨진다.
--   따라서 RLS는 "로그인 여부"만 판정하고 device_id는 건드리지 않는다.
--
-- 적용 방법
--   Supabase Dashboard → SQL Editor → 이 파일 전체 붙여넣기 → Run.
--   (또는 supabase db push)
--   재실행 안전(idempotent). 존재하지 않는 테이블은 자동으로 건너뛴다.
--
-- 되돌리는 법
--   파일 맨 아래 "ROLLBACK" 주석 블록 참조.
--
-- 1) 서버 소유 membership. 빈 테이블은 모두 차단한다.
create table if not exists public.portmgr_allowed_members (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint portmgr_allowed_members_lowercase check (email = lower(email))
);
alter table public.portmgr_allowed_members enable row level security;

-- 과거 함수 배열을 사용한 설치라면 현재 값을 먼저 보존한다.
do $$
declare
  old_members text[] := array[]::text[];
begin
  if to_regprocedure('public.portmgr_allowed_emails()') is not null then
    execute 'select public.portmgr_allowed_emails()' into old_members;
  end if;
  insert into public.portmgr_allowed_members(email)
  select distinct lower(trim(value))
  from unnest(coalesce(old_members, array[]::text[])) as value
  where trim(value) <> ''
  on conflict (email) do nothing;
end $$;

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

-- 2) 접근 판정 함수 — authenticated JWT의 이메일이 table에 있어야 한다.
--    role 판정에 auth.role()을 쓰지 않는다: Supabase가 deprecated 처리한 헬퍼라
--    프로젝트에 따라 없을 수 있고, 없으면 정책 평가 자체가 42883으로 터진다.
--    auth.jwt()는 현행 권장 API이며 claims가 비어도 null을 반환할 뿐 에러가 없다.
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
      select 1 from public.portmgr_allowed_members m
      where m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

revoke all privileges on table public.portmgr_allowed_members from public, anon, authenticated;
grant select, insert, update, delete on table public.portmgr_allowed_members to service_role;
revoke all on function public.portmgr_allowed_emails() from public, anon, authenticated;
revoke all on function public.portmgr_is_member()      from public, anon;
grant execute on function public.portmgr_is_member() to authenticated;


-- 3) 테이블별 RLS ON + 정책 재생성
--    대상 7개 테이블:
--      portmgr_ports, portmgr_workspace_roots, portmgr_portal_items,
--      portmgr_portal_categories, portmgr_devices, portmgr_push_snapshots,
--      portmgr_project_memory_revisions
--    포털 전용 설치처럼 일부 테이블만 있는 환경도 있으므로 존재할 때만 적용한다.
do $$
declare
  t text;
begin
  foreach t in array array[
    'portmgr_ports',
    'portmgr_workspace_roots',
    'portmgr_portal_items',
    'portmgr_portal_categories',
    'portmgr_devices',
    'portmgr_push_snapshots',
    'portmgr_project_memory_revisions'
  ]
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'skip (table not found): %', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- 과거 설치에서 만들어졌을 수 있는 느슨한 정책 제거
    execute format('drop policy if exists "anon_all" on public.%I', t);
    execute format('drop policy if exists "Enable read access for all users" on public.%I', t);
    execute format('drop policy if exists "portmgr_authenticated_all" on public.%I', t);

    -- 로그인 사용자 전체 허용 (select/insert/update/delete 모두 = upsert 가능)
    -- (select ...) 로 감싸는 이유: stable 함수를 그냥 두면 행마다 재평가된다.
    -- 서브쿼리로 만들면 InitPlan 으로 승격돼 쿼리당 1회만 평가된다.
    execute format($p$
      create policy "portmgr_authenticated_all" on public.%I
        as permissive
        for all
        to authenticated
        using ((select public.portmgr_is_member()))
        with check ((select public.portmgr_is_member()))
    $p$, t);

    -- 방어 심층화: anon/public 롤은 테이블 권한 자체를 갖지 않는다
    execute format('revoke all privileges on table public.%I from anon', t);
    execute format('revoke all privileges on table public.%I from public', t);

    -- 위 REVOKE(특히 FROM PUBLIC)의 부수효과로 로그인 사용자가 막히지 않도록 명시 GRANT.
    -- Supabase 기본 권한이 이미 있으면 멱등한 no-op이다.
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
  end loop;
end
$$;


-- ============================================================================
-- 검증 쿼리 — 아래 A~E를 실행해 결과를 확인한다
-- ============================================================================

-- (A) 조회되는 portmgr_* 테이블이 전부 rowsecurity = true 여야 한다.
--     대상 7개 외에 portmgr_device_credentials(별도 마이그레이션에서 이미 잠금)도 함께 나온다.
select tablename, rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public' and tablename like 'portmgr\_%'
order by tablename;

-- (B) 각 테이블에 portmgr_authenticated_all 정책이 roles = {authenticated} 로 1개씩
--     anon 이 roles에 포함된 정책이 하나도 없어야 한다
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename like 'portmgr\_%'
order by tablename, policyname;

-- (C) anon 롤에 남은 테이블 권한이 0건이어야 한다
select table_name, privilege_type, grantee
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name like 'portmgr\_%'
  and grantee in ('anon', 'PUBLIC')
order by table_name, grantee, privilege_type;

-- (D) 화이트리스트 현재 값 확인 (빈 배열이면 "로그인한 모든 사용자" 허용)
select public.portmgr_allowed_emails() as allowed_emails;

-- (E) 실제 차단 확인 — anon 역할로 전환해 읽기를 시도한다.
--     "ERROR: permission denied for table portmgr_ports" 가 떠야 정상이다.
--     행이 반환되면 이 마이그레이션이 적용되지 않은 것이다. (의도적으로 에러를 내므로 주석 상태)
-- begin;
--   set local role anon;
--   select * from public.portmgr_ports limit 1;
-- rollback;


-- ============================================================================
-- ROLLBACK — 되돌리는 법 (아래 블록 전체를 주석 해제해서 실행)
-- ⚠ 되돌리면 anon key만으로 전체 접근이 가능해진다(원래의 취약 상태).
-- ============================================================================
-- do $$
-- declare
--   r record;
-- begin
--   -- 하드코딩 목록이 아니라 실제로 존재하는 정책을 지운다.
--   -- (테이블이 나중에 추가돼 목록과 어긋나면 아래 drop function 이 의존성 때문에 실패한다.)
--   for r in
--     select schemaname, tablename from pg_policies
--     where schemaname = 'public' and policyname = 'portmgr_authenticated_all'
--   loop
--     execute format('drop policy if exists "portmgr_authenticated_all" on %I.%I', r.schemaname, r.tablename);
--   end loop;
--
--   for r in
--     select tablename from pg_tables
--     where schemaname = 'public' and tablename like 'portmgr\_%'
--       and tablename <> 'portmgr_device_credentials'   -- 토큰 테이블은 잠금 유지
--   loop
--     execute format('alter table public.%I disable row level security', r.tablename);
--     execute format('grant all privileges on table public.%I to anon, authenticated, service_role', r.tablename);
--   end loop;
-- end
-- $$;
-- drop function if exists public.portmgr_is_member();
-- drop function if exists public.portmgr_allowed_emails();
