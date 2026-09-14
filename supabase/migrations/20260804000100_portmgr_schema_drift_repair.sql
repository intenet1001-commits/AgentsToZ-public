-- 코드가 쓰지만 자동 생성 DDL에 빠져 있던 컬럼/기본값 복구.
-- 이미 적용된 프로젝트에서도 안전하게 재실행 가능(idempotent).

-- 1) 웹 포털(src/portal-main.tsx)의 프로젝트 추가/수정이 쓰는 컬럼
ALTER TABLE portmgr_ports ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE portmgr_ports ADD COLUMN IF NOT EXISTS description text;

-- 2) 핸드오프 메모(src/PortalManager.tsx saveHandoffNote)가 쓰는 컬럼
ALTER TABLE portmgr_devices ADD COLUMN IF NOT EXISTS handoff_note text;
ALTER TABLE portmgr_devices ADD COLUMN IF NOT EXISTS handoff_updated_at timestamptz;

-- 3) push 스냅샷 id 기본값 — id 누락 시 NOT NULL 위반으로 조용히 실패하던 문제 방어
ALTER TABLE portmgr_push_snapshots ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
