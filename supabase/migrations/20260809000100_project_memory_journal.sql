-- ============================================================================
-- portmgr_project_memory_journal — 세션 일지 (append-only, 영구 보존)
-- ============================================================================
--
-- 왜 리비전 테이블로 부족한가
--   portmgr_project_memory_revisions 는 CORE.md "파일 전체" 스냅샷이고,
--   앱이 최신 N개만 남기고 지운다. 실측 push 빈도(하루 약 1.5회)에서 예전 상한
--   50개는 약 한 달치였다 — "장기기억"이 사실상 "지난 한 달, 마지막으로 요약된
--   모습"이었다는 뜻이다. 게다가 기억 갱신은 파일을 통째로 재생성하므로 통합
--   과정에서 항목이 조용히 사라질 수 있다(실제로 발생했고 해시 대조로만 발견됨).
--
-- 이 테이블의 역할
--   한 세션 = 한 행. 절대 재작성/통합/삭제하지 않는 불변 층이다.
--   정리된 기억이 나중에 어떻게 압축되든 원본 근거가 여기 남는다.
--
-- 왜 (memory_id, entry_hash) UNIQUE 인가
--   1) 멱등성: Push가 실패해 재시도해도 같은 세션이 두 번 쌓이지 않는다.
--   2) 충돌 없는 병합: 기기 두 대가 각자 append해도 결과가 합집합이다.
--      파일 전체를 다투는 리비전과 달리 여기서는 충돌이 발생하지 않는다.
--   entry_hash 는 시각이 아니라 "내용"으로 계산한다 — 같은 세션을 다시 기록해도
--   같은 해시가 나와야 중복이 걸러진다.
--
-- 적용 방법
--   supabase db push  (또는 Dashboard → SQL Editor에 붙여넣기)
--   재실행 안전(idempotent).
--
-- 되돌리는 법
--   drop table if exists portmgr_project_memory_journal;
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS portmgr_project_memory_journal (
  id text PRIMARY KEY,
  memory_id text NOT NULL,
  entry_hash text NOT NULL,
  device_id text,
  device_name text,
  project_name text,
  agent text,
  recorded_at timestamptz NOT NULL,
  head_commit text,
  summary text NOT NULL,
  body text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portmgr_project_memory_journal_entry
  ON portmgr_project_memory_journal(memory_id, entry_hash);

CREATE INDEX IF NOT EXISTS idx_portmgr_project_memory_journal_recent
  ON portmgr_project_memory_journal(memory_id, recorded_at DESC);

-- 다른 portmgr_* 테이블과 동일한 RLS: anon 차단, 로그인 사용자만 전체 허용.
-- 20260804010000_enable_rls_authenticated_only.sql 이 만든 헬퍼를 재사용한다.
-- 헬퍼가 없는 환경(구버전 스키마)에서도 이 마이그레이션이 실패하지 않도록,
-- 함수 존재 여부를 확인한 뒤에만 정책을 만든다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'portmgr_is_member'
  ) THEN
    EXECUTE 'ALTER TABLE portmgr_project_memory_journal ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS portmgr_authenticated_all ON portmgr_project_memory_journal';
    EXECUTE 'CREATE POLICY portmgr_authenticated_all ON portmgr_project_memory_journal
               FOR ALL TO authenticated
               USING ((SELECT public.portmgr_is_member()))
               WITH CHECK ((SELECT public.portmgr_is_member()))';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE portmgr_project_memory_journal FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE portmgr_project_memory_journal FROM public';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE portmgr_project_memory_journal TO authenticated';
  END IF;
END
$$;
