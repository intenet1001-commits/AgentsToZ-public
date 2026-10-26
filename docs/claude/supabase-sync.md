# Supabase 동기화 · 기기별 격리 · RLS

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## Supabase 동기화
- **프로젝트 관리 탭**: `portmgr_ports` 테이블에 Push(upsert) / Pull(복원)
- **포털 탭**: `portmgr_portal_items` + `portmgr_portal_categories` 테이블에 Push / Pull
- Supabase URL + anon key는 `portal.json`에 저장 — 두 탭이 공유
- `portal.json`에 `deviceId` (UUID) + **`deviceName`** (사람이 읽을 수 있는 기기명) 함께 저장
- Push: `upsert(rows, { onConflict: 'id' })` — 멱등 동작
- Pull: `device_id` 기준 필터링 (기기별 데이터), `'__shared__'` sentinel로 공유 데이터 병합
- **다른 기기 데이터 가져오기**: 설정 → 고급 설정 → 기기 조회 → 기기 선택 → "저장 후 동기화" 클릭 시 해당 기기 데이터 Pull
  - 다른 기기 선택 상태에서 "저장 후 동기화" = Pull (내 기기일 때는 Push)
  - Pull 후 React 상태 즉시 반영 (`setData` 호출) — 이후 Push도 정상 동작
- **기기 간 포트 격리**: `sourceDeviceId` 필드로 타 기기 포트가 내 device_id로 덮어쓰이는 것 방지
  - Push 시 `sourceDeviceId`가 내 UUID인 포트만 upsert (타 기기 포트 제외)
- 테이블 스키마 (DDL):
  - `portmgr_ports` (id, **device_id**, name, port, command_path, folder_path, terminal_command, deploy_url, github_url, **favorite**, memo, memo_updated_at, device_name, **category**, **description**) — device_id/favorite 필수. category/description은 웹 포털(`portal-main.tsx`) CRUD가 씀
  - `portmgr_workspace_roots` (id, device_id, name, path) — 프로젝트 관리 탭 Push/Pull
  - `portmgr_portal_items` (id, device_id, name, type, url, path, category, description, pinned, visit_count, last_visited, created_at)
  - `portmgr_portal_categories` (id, device_id, name, color, order)
  - `portmgr_devices` (id, name, last_push_at, **handoff_note**, **handoff_updated_at**) — 핸드오프 메모 (기기 간 인수인계용, nullable)
  - `portmgr_push_snapshots` (id **DEFAULT gen_random_uuid()::text**, created_at, table_name, device_id, device_name, row_count, snapshot) — `src/pushHistory.ts`가 id를 명시 전달하며, DEFAULT는 누락 시 방어책
  - ⚠️ 설치 가이드에 노출되는 DDL 정본은 `src/schemaSql.ts` 한 곳뿐 — SetupWizard/PortalManager에 DDL을 다시 하드코딩하지 말 것 (프리픽스 없는 테이블 생성 → PGRST205)
  - `portmgr_project_memory_revisions` (id, memory_id, parent_revision_id, project_name, github_url, device_id, device_name, source_path, content, content_hash, created_at) — 프로젝트 로컬 장기기억의 Supabase 리비전 백업.
    리비전 한 행이 문서 전체 사본이라 보존은 서버 함수 `portmgr_prune_project_memory_revisions`
    (`src/projectMemoryRevisionRetentionSql.ts` = 마이그레이션 `20260925020000_…`)가 맡는다: 최신 30개 +
    90일은 하루 1개·그 전은 주 1개, 그리고 head·기기 동기 지점(`portmgr_project_memory_devices.revision_id`)·
    합병 참조·기기별 최신 행은 **절대 지우지 않는다.** push 성공 뒤 호출당 최대 200행만 지운다.
    예전 클라이언트는 기억 하나의 id를 전부 읽어 500개 초과분을 지웠다 — 문서 200KB면 기억 하나가
    ~100MB였다. 함수가 없는 DB에서는 옛 500개 상한을 **한 페이지(200행)씩만** 적용한다.
- **RLS·anon 회수는 이제 라이브 DB에 적용돼 있다 (2026-09-25 읽기 전용 실측).**
  anon key만으로 `portmgr_ports`·`portmgr_devices`·`portmgr_project_memory_revisions`·
  `portmgr_push_snapshots`를 SELECT하면 전부 **401 permission denied**로 거절됐다.
  기록으로 남기는 이전 상태: 2026-08-11 실측에서는 RLS가 저장소에만 있었고, anon key만으로
  `portmgr_ports` SELECT 200 / INSERT 201 / DELETE 204 가 통과했으며 나머지 6개 테이블도 전부
  읽혔다(당시 `portmgr_device_credentials`는 없었다 — PGRST205). anon key는 배포한 Vercel 포털의
  웹 번들에 실려 나가므로, 그 상태로 되돌아가면 키를 꺼낸 누구나 전체
  데이터를 읽고 지울 수 있다 — 그래서 아래 규칙을 지킨다. 새 테이블을 추가할 때도 같은 확인
  (anon SELECT가 401)을 다시 할 것. 이번 실측은 SELECT만 봤다(쓰기는 시도하지 않았다).
- **RLS: 모든 `portmgr_*` 테이블에서 켜져 있고, 끄지 말 것.** 정본은 `src/schemaSql.ts`의
  `rlsPolicySql()` + 마이그레이션 `supabase/migrations/20260804010000_enable_rls_authenticated_only.sql`
  — anon 권한을 전면 회수(`revoke all ... from anon`)하고 `authenticated` 역할에만 grant한다.
  anon key가 유출돼도 로그인(JWT) 없이는 아무것도 못 하게 하는 것이 목적이다.
  401/403/PGRST301 이 뜨면 **RLS를 끄지 말고** Google OAuth 세션(JWT)이 살아 있는지부터 확인하라.
- **`portmgr_screen_push_*` 표 4개와 함수 8개는 마이그레이션만 있고 어디에도 적용하지 않았다**(2026-10-25, AgentsToZ Screen 알림·원격 차단 —
  `docs/design/screen-control-2026-10-24/DESIGN.md` 「6) 알림·원격 차단」).
  - 정본은 `src/screenPushSql.ts`이고 `supabase/migrations/20261025010000_screen_push.sql`과 글자까지 같다(`tests/screen-push-sql.test.ts`가 본다).
  - 다른 `portmgr_*`와 달리 **authenticated에도 아무것도 grant하지 않는다.** Supabase 함수 `screen-push`만 서비스 키로 쓰고, 앱·포털은 이 표를 읽지 않는다.
    RLS는 켜져 있고 정책이 없다(서비스 키 말고는 전부 거절). 함수는 security definer + `search_path` 고정 + 첫 줄의 `auth.role()` 확인이고, execute는 service_role에만 준다.
  - `PORTMGR_TABLES`(`src/schemaSql.ts`)에 넣지 않았다. 넣으면 마이그레이션을 적용하지 않은 DB에서 온보딩 클라우드 확인
    (`onboardingCloudEffects.ts`)이 「데이터 구조와 보안 정책을 확인하세요.」로 실패한다. 적용한 뒤에 함께 넣을지 정한다.
  - 설치 SQL(`MIGRATION_SQL`)에도 없다. 게시자 한 곳이 운영하는 중계(게시자의 APNs 키·빌드에 넣는 주소)라 직접 Supabase를 쓰는
    설치가 쓸 일이 없기 때문이다. 그래서 「마이그레이션이 만든 것은 설치 SQL에도 있다」 검사(`tests/voc-transit-storage-sql.test.ts`)의
    `NOT_APP_SCHEMA`에 이 12개 이름만 예외로 적었다. 새 이름을 더하면 그 검사가 다시 잡는다.
  - 적용은 사람이 한다(DESIGN 「사람이 할 일」 5). 적용 뒤에는 위 규칙대로 anon key SELECT가 거절되는지 확인한다.
    같은 프로젝트의 `_prisma_migrations`·`"Item"`(RLS 꺼짐)을 선례로 삼지 않았다.
- **로컬 웹(source dev) 프록시는 같은 origin GET을 `Origin` 없이 받는다.** 브라우저는 same-origin GET에
  `Origin`을 붙이지 않으므로 `/api/supabase-proxy` 게이트는 `localWebRequestOrigin`
  (`src/localWebRequestOrigin.ts`)으로, 페이지가 위조할 수 없는 `Sec-Fetch-Site: same-origin` + Referer에서
  페이지 origin을 되찾는다. 이것이 빠져 있던 동안 localhost:9000의 Supabase 읽기가 전부
  `DESKTOP_SUPABASE_PROXY_DENIED` 403 → 「자동 업로드 중단 · Supabase 인증과 접근 권한을 확인해 주세요」로
  보였다(2026-09-11 실측). 번들 사이드카는 여전히 loopback 웹을 전부 거절한다 — 풀지 말 것.
- SetupGuide 컴포넌트: 설정 모달 내 접이식 Claude 프롬프트 복사 가이드 (`PortalManager.tsx`)

### 기기별 격리 정책 (Per-device isolation)

| 테이블 / 조건 | 격리 단위 | device_id 값 |
|---|---|---|
| `portmgr_ports` (폴더 전용 항목 포함 — port 필드 없음) | 기기별 | 해당 기기 UUID |
| `portmgr_portal_items` where `type = 'web'` (URL 북마크) | 공유 (전 기기) | `'__shared__'` |
| `portmgr_portal_items` where `type = 'folder'` | **Deprecated** — 앱 부팅 시 1회 자동 `portmgr_ports` 테이블로 이전 (기기별 localStorage 마커 `folder-portal-migrated-v1`). 신규 push 차단됨. | — |
| `portmgr_portal_categories` | 공유 (전 기기) | `'__shared__'` |

- Pull 시 `device_id = <내 UUID>` AND `device_id = '__shared__'` 두 결과를 합산
- Push 시 공유 항목은 `device_id = '__shared__'`로 upsert
- 북마크 탭은 URL 전용 UI. 폴더 즐겨찾기는 "프로젝트·폴더" 탭에서 `port` 없는 `PortInfo` 로 관리.

### Supabase 테이블 이름 변경 SQL (portmgr_ 프리픽스 적용)

```sql
-- 기존 테이블 → portmgr_ 프리픽스로 이름 변경
ALTER TABLE ports             RENAME TO portmgr_ports;
ALTER TABLE workspace_roots   RENAME TO portmgr_workspace_roots;
ALTER TABLE portal_items      RENAME TO portmgr_portal_items;
ALTER TABLE portal_categories RENAME TO portmgr_portal_categories;
ALTER TABLE devices           RENAME TO portmgr_devices;
ALTER TABLE push_snapshots    RENAME TO portmgr_push_snapshots;

-- 인덱스도 재생성 (이름 변경 후)
DROP INDEX IF EXISTS idx_ports_device_id;
CREATE INDEX IF NOT EXISTS idx_portmgr_ports_device_id ON portmgr_ports(device_id);
```

### 기존 Supabase 초기 설정 SQL (신규 설치 시)

```sql
-- portmgr_ports 테이블에 device_id 컬럼 추가
ALTER TABLE portmgr_ports ADD COLUMN device_id text;
UPDATE portmgr_ports SET device_id = '<YOUR_DEVICE_UUID>' WHERE device_id IS NULL;

-- portmgr_portal_items 공유 항목 sentinel 값 설정
UPDATE portmgr_portal_items SET device_id = '__shared__' WHERE type != 'folder';

-- portmgr_portal_categories 공유 sentinel 값 설정
UPDATE portmgr_portal_categories SET device_id = '__shared__';

-- 인덱스 추가 (성능)
CREATE INDEX IF NOT EXISTS idx_portmgr_ports_device_id ON portmgr_ports(device_id);

-- 핸드오프 메모 (기기 간 인수인계 노트) — portmgr_devices에 컬럼 추가
ALTER TABLE portmgr_devices ADD COLUMN IF NOT EXISTS handoff_note text;
ALTER TABLE portmgr_devices ADD COLUMN IF NOT EXISTS handoff_updated_at timestamptz;
```
