# AGENTS.md — AgentsToZ_byCS 기술 참조

> AI 에이전트, 기여자, 자동화 스크립트를 위한 상세 기술 문서.  
> 일반 사용자는 [README.md](README.md)를 보세요.

---

## 프로젝트 구조

```
portmanagement/
├── src/                    # React 프론트엔드
│   ├── App.tsx             # 메인 컴포넌트 (~6000줄, 모든 UI 로직)
│   ├── i18n.ts             # 번역 (ko/en)
│   ├── main.tsx            # React 진입점
│   └── lib/
│       └── supabaseClient.ts  # Supabase 싱글턴 클라이언트
├── src-tauri/              # Tauri 백엔드 (Rust)
│   ├── src/lib.rs          # Tauri 커맨드 전체
│   └── tauri.conf.json     # Tauri 설정 (productName, identifier, 창 크기)
├── api-server.ts           # Bun 기반 API 서버 (포트 3001)
├── update-version.ts       # 빌드 번호 자동 증가
├── build-macos.ts          # macOS 빌드 래퍼 (CARGO_TARGET_DIR 동적 설정)
├── build-win.ts            # Windows 빌드 래퍼
├── fix-dmg.ts              # DMG 빌드 후처리 (임시 DMG 복구)
├── stamp-icon.py           # 앱 아이콘에 버전 번호 스탬프 (Pillow 필요)
├── index.html              # 앱 진입 HTML
├── setup.html              # 설정 마법사 HTML
└── portal.html             # 포털 전용 HTML
```

**데이터 저장 위치 (앱·웹 공유)**
```
macOS: ~/Library/Application Support/com.portmanager.portmanager/ports.json
       ~/Library/Application Support/com.portmanager.portmanager/logs/{portId}.log
Windows: %APPDATA%\com.portmanager.portmanager\ports.json
         %APPDATA%\com.portmanager.portmanager\logs\{portId}.log
```

---

## 기술 스택

| 영역 | 기술 | 비고 |
|---|---|---|
| 런타임 | Bun | Node.js 대신 사용. `bun <file>` 직접 실행 |
| 프론트엔드 | React 19 + TypeScript | Vite 번들러 |
| 데스크탑 | Tauri 2 (Rust) | Bundle ID: `com.portmanager.portmanager` |
| API 서버 | Bun.serve() | 포트 3001, CORS: `*` (localhost-only) |
| 스타일링 | Tailwind CSS | 다크 테마 (#0a0a0b 배경, #18181b 카드) |
| DB 동기화 | Supabase | device_id 기반 기기별 격리 |
| 인증 | Google OAuth 2.0 | 포털 접근 제한용 |
| 웹 배포 | Vercel | 포털 탭 외부 배포 |

---

## 개발 명령어

```bash
# 개발 서버 (API 3001 + Vite 9000 동시 실행)
bun run dev            # vite만
bun run start          # api-server.ts + vite 동시
./실행.command         # 포트 충돌 정리 + 종료 핸들러 포함 (권장)

# API 서버만
bun api-server.ts      # --watch 금지 (헬스체크 실패)

# 커밋 전 필수 — 셋 다 통과해야 한다
bun run verify         # typecheck + bun test + cargo test 를 이 순서로
bun run typecheck      # 기준선 0 에러
bun test               # 2026-08-15 실측 1004 pass / 0 fail — 판정은 0 fail, 개수 일치가 아니다
cd src-tauri && cargo test   # 2026-08-15 실측 33 pass
bun run test:smoke     # 별개 러너 (node tests/smoke.mjs) — bun test 에 포함되지 않는다

# Tauri 개발
bun run tauri:dev

# 빌드
bun run update-version          # build-number.json 증가 + productName 고정
bun run tauri:build             # macOS .app
bun run tauri:build:dmg         # macOS DMG
bun run tauri:build:win         # Windows NSIS .exe
```

> **주의**: `vite` 직접 호출 금지 — `./node_modules/.bin/vite` 사용 (PATH 문제 방지)

**빌드 결과물 경로**
```
macOS .app:  ~/cargo-targets/portmanager/release/bundle/macos/AgentsToZ_byCS.app
macOS DMG:   ~/cargo-targets/portmanager/release/bundle/dmg/AgentsToZ_byCS_YYYY.M.D_aarch64.dmg
Windows .exe: %USERPROFILE%\cargo-targets\portmanager\release\bundle\nsis\*.exe
```

---

## API 엔드포인트 (포트 3001)

### 포트 관리
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/ports` | 포트 목록 조회 |
| POST | `/api/ports` | 포트 목록 저장 |
| POST | `/api/detect-port` | `.command` 파일 분석 (포트·폴더 경로 추출) |
| GET | `/api/detect-start-command?path=<folderPath>` | 폴더 내 매니페스트 탐색 → 실행 명령 자동 감지 |
| POST | `/api/execute-command` | `.command` 파일 실행 (로그 파일 리다이렉트) |
| POST | `/api/stop-command` | 실행 중인 명령 중지 (모든 PID 검색·종료) |
| POST | `/api/force-restart-command` | 강제 재실행 (SIGKILL → 500ms → 재실행) |
| POST | `/api/check-port-status` | 포트 실행 상태 확인 (`lsof` 사용) |

### 빌드 시스템
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/build` | Tauri 빌드 (`type: 'app' \| 'dmg'`) |
| GET | `/api/build-status` | 빌드 상태·로그 (1초 폴링용) |
| POST | `/api/open-build-folder` | 빌드 폴더 열기 |
| POST | `/api/export-dmg` | DMG를 Desktop으로 복사 |
| POST | `/api/install-app` | `.app`을 `/Applications/AgentsToZ_byCS.app`으로 설치 |

### 파일·폴더
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/open-folder` | 지정 폴더 열기 |
| GET | `/api/pick-folder` | macOS 폴더 선택 다이얼로그 (웹 모드 전용) |
| POST | `/api/create-folder` | 폴더 생성 (절대경로 필수) |
| POST | `/api/open-orca-localhost` | 선택 프로젝트/워크트리에 Orca 브라우저 탭으로 localhost 열기 (macOS) |

### 포털 설정
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/portal` | `portal.json` 로드 |
| POST | `/api/portal` | `portal.json` 저장 |

### AI 이름 생성
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/suggest-batch` | N개 포트 이름+카테고리 단일 Claude 호출 일괄 생성 |
| POST | `/api/suggest-name-and-category` | 단일 포트 이름+카테고리 |
| POST | `/api/suggest-name` | legacy shim → suggest-name-and-category 위임 |
| POST | `/api/suggest-category` | legacy shim → suggest-name-and-category 위임 |

### 공개 VOC 수집
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/voc` | 로컬 JSON 저장 후 사용자가 선택한 경우 공개 Edge Function 전송 |
| GET | `/api/voc` | 이 기기의 로컬 VOC 목록 |
| GET | `/api/voc/access` | 설치 UUID의 원격 차단 상태 확인(장애 시 fail-open) |
| GET/PUT | `/api/voc-admin/settings` | service-role 운영자의 접수 여부·일일 한도 관리 |
| POST/DELETE | `/api/voc-admin/block` | 단말 해시의 VOC/앱 차단 적용·해제 |

### 프로젝트 장기기억
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/project-memory/detect` | 프로젝트 내부 기존 기억·관리 스킬 감지 |
| POST | `/api/project-memory/init` | `.agent-memory/CORE.md`와 Claude/Codex 로컬 스킬 생성·연결 |
| POST | `/api/project-memory/update` | 선택한 Claude/Codex 비대화형 실행으로 로컬 기억 갱신 |
| POST | `/api/project-memory/upgrade-agent` | 기존 기억은 보존하고 Claude/Codex용 장기기억 에이전트만 최신화 |
| POST | `/api/project-memory/mark-remembered` | AI 호출 없이 현재 프로젝트·워크트리 활동 지문을 기억 완료 기준으로 저장 |
| POST | `/api/project-memory/push` | 현재 로컬 기억을 Supabase 새 리비전으로 백업 |
| POST | `/api/project-memory/pull` | 원격 최신 리비전을 로컬로 복원(충돌 시 덮어쓰기 금지) |
| POST | `/api/project-memory/remote-status` | 로컬·원격 해시와 백업 상태 비교 |
| POST | `/api/project-memory/history` | 프로젝트별 최근 장기기억 리비전 조회 |
| POST | `/api/project-memory/restore-revision` | 선택 리비전 복원(현재 로컬 파일은 먼저 백업) |
| POST | `/api/project-memory/session-end` | 로컬 기억 갱신 후 Supabase 백업을 한 번에 실행 |

> 장기기억의 원본은 프로젝트 로컬 파일이다. Supabase 백업 실패 시에도 로컬 갱신은 유지하고 재Push할 수 있어야 한다.
> 초기화 시 Claude/Codex용 `project-memory`와 `remember-session` 로컬 스킬 및 토큰을 사용하지 않는 `UserPromptSubmit` 활동 훅을 함께 생성한다. 훅은 프롬프트 본문을 버리고 마지막 활동 시각과 AI 종류만 로컬에 기록한다. 앱은 메인 프로젝트와 연결 워크트리의 Git 활동 지문을 30초마다 확인해 `세션 기억하기 필요`를 표시한다. Claude에서는 `/remember-session`, Codex에서는 `$remember-session` 또는 “세션 기억하기” 자연어로 실행한다. 생성 스킬 버전이 오래되면 프로젝트 영역에 `장기기억 에이전트 업데이트`를 표시한다.

> CORS: `Access-Control-Allow-Origin: *` (와일드카드, localhost-only 서버라 안전)

---

## 데이터 구조

### TypeScript (Frontend)

```typescript
interface PortInfo {
  id: string;
  name: string;
  port?: number;             // 폴더 전용 항목(포트 없는 프로젝트)은 비어 있다
  commandPath?: string;      // .command 파일 경로
  terminalCommand?: string;  // 터미널 실행 명령어
  folderPath?: string;       // 프로젝트 폴더 경로
  isRunning?: boolean;
  favorite?: boolean;
  category?: string;
  aiName?: string;
  memo?: string;
  memo_updated_at?: string;
  deployUrl?: string;
  githubUrl?: string;       // 대표 저장소 URL (레거시 호환)
  githubUrls?: string[];    // 모든 GitHub 저장소 URL, 대표 URL을 첫 항목으로 포함
  worktreePath?: string;
  manualPath?: string;      // 프로젝트 매뉴얼 파일 경로 (HTML/MD/PDF 등)
  logFilePath?: string;     // 로그 관리 문서 파일 경로
  sourceDeviceId?: string;   // 타 기기 포트 격리용
}
```

### Rust (Tauri Backend — `src-tauri/src/lib.rs`)

```rust
struct PortInfo {
    id: String,
    name: String,
    #[serde(default)]
    port: Option<u16>,   // 폴더 전용 항목은 포트가 없다 — 필수 아님
    command_path: Option<String>,
    folder_path: Option<String>,
    is_running: bool,
    // …deploy_url / github_url / github_urls / worktree_path / manual_path 등 생략.
    // 실제 필드 전체는 src-tauri/src/lib.rs 의 struct PortInfo 가 정본이다.
    // 필드 추가 시 반드시 여기도 추가 — serde가 누락 필드를 silently drop
}
```

> **주의**: Rust 구조체에 없는 필드는 `save_ports` 호출 시 JSON 역직렬화 과정에서 사라짐.  
> TypeScript ↔ Rust 필드 불일치 = 필드 사라짐 버그 1순위 원인.

---

## Supabase 테이블 스키마

### portmgr_ports
```sql
CREATE TABLE portmgr_ports (
  id text PRIMARY KEY,
  device_id text,          -- 기기별 격리 키 (필수)
  name text,
  port integer,
  command_path text,
  folder_path text,
  terminal_command text,
  deploy_url text,
  github_url text,
  github_urls text[],
  manual_path text,
  log_file_path text,
  favorite boolean DEFAULT false,
  memo text,
  memo_updated_at timestamptz,
  device_name text,
  category text,            -- 웹 포털(portal-main.tsx)의 프로젝트 추가/수정이 씀
  description text          -- 〃
);
CREATE INDEX idx_portmgr_ports_device_id ON portmgr_ports(device_id);
```

### portmgr_workspace_roots
```sql
CREATE TABLE portmgr_workspace_roots (id text, device_id text, name text, path text);
```

### portmgr_portal_items
```sql
CREATE TABLE portmgr_portal_items (
  id text PRIMARY KEY,
  device_id text,          -- 공유: '__shared__', 기기별: <UUID>
  name text, type text, url text, path text,
  category text, description text,
  pinned boolean, visit_count integer, last_visited timestamptz, created_at timestamptz
);
```

### portmgr_portal_categories
```sql
CREATE TABLE portmgr_portal_categories (
  id text PRIMARY KEY,
  device_id text,          -- 항상 '__shared__'
  name text, color text, "order" integer
);
```

### portmgr_devices
```sql
CREATE TABLE portmgr_devices (
  id text PRIMARY KEY, name text, last_push_at timestamptz,
  handoff_note text, handoff_updated_at timestamptz   -- 기기 간 인수인계 메모
);
```

### portmgr_push_snapshots
```sql
CREATE TABLE portmgr_push_snapshots (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,  -- DEFAULT 없으면 id 누락 시 조용히 실패
  created_at timestamptz, table_name text,
  device_id text, device_name text, row_count integer, snapshot jsonb
);
```

### portmgr_project_memory_revisions
```sql
CREATE TABLE portmgr_project_memory_revisions (
  id text PRIMARY KEY,
  memory_id text NOT NULL,
  parent_revision_id text,
  project_name text,
  github_url text,
  device_id text,
  device_name text,
  source_path text,
  content text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_portmgr_project_memory_latest
  ON portmgr_project_memory_revisions(memory_id, created_at DESC);
```

### 공개 VOC 서버 테이블

- `portmgr_voc_inbox`: 수신 VOC. 댓글·앱 버전·앵커와 설치 UUID의 SHA-256 해시만 저장한다.
- `portmgr_voc_daily_usage`: 날짜+단말 해시별 원자적 일일 카운터.
- `portmgr_voc_settings`: 기본 10회인 일일 한도(1~100)와 접수 여부.
- `portmgr_voc_blocklist`: `voc` 또는 `app` 범위의 단말 차단, 운영자 메모, 만료 시각.
- 네 테이블과 `portmgr_submit_voc`/`portmgr_check_voc_device` RPC는 service-role 전용이다.
- 공개 설치본에는 `VITE_VOC_ENDPOINT`만 들어가며 secret/service-role 키를 포함하지 않는다.

### RLS: 켜져 있다 — 끄지 말 것 (anon 전면 차단, authenticated 전용)

정본은 `src/schemaSql.ts`의 `rlsPolicySql()`과 마이그레이션
`supabase/migrations/20260804010000_enable_rls_authenticated_only.sql` 두 곳이며,
모든 `portmgr_*` 테이블에서 RLS를 활성화하고 anon 권한을 회수(`revoke all ... from anon`)한 뒤
`authenticated` 역할에만 `select/insert/update/delete`를 grant한다.
anon key가 유출돼도 로그인(JWT) 없이는 접근할 수 없어야 한다는 것이 이 설계의 목적이다.

401/403/PGRST301 이 뜨면 **RLS를 끄는 것이 해결책이 아니다** — Google OAuth 세션이 살아 있는지,
요청이 anon이 아니라 authenticated 역할로 나가는지를 먼저 확인하라.

---

## 기기별 격리 정책 (Per-device isolation)

| 테이블 / 조건 | 격리 단위 | device_id 값 |
|---|---|---|
| `portmgr_ports` | 기기별 | 해당 기기 UUID |
| `portmgr_portal_items` where `type = 'web'` | 공유 (전 기기) | `'__shared__'` |
| `portmgr_portal_items` where `type = 'folder'` | **Deprecated** — 앱 부팅 시 `portmgr_ports`로 자동 이전 | — |
| `portmgr_portal_categories` | 공유 (전 기기) | `'__shared__'` |

- Pull: `device_id = <내 UUID>` AND `device_id = '__shared__'` 두 결과 합산
- Push: `sourceDeviceId`가 내 UUID인 포트만 upsert (타 기기 포트 제외)
- `portal.json`에 `deviceId` (UUID) + `deviceName` (사람이 읽을 수 있는 기기명) 저장

---

## 설치 마법사 플로우

### OneClickWizard (완전 자동화 모드)

`src/SetupWizard.tsx` 내 `OneClickWizard` 컴포넌트. 이미 만든 Supabase 프로젝트를
CLI로 이 기기에 연결하는 빠른 흐름이며, GitHub/Vercel 로그인은 선택 단계다.

```
1. Choose: "처음 사용" | "추가 기기 연결"
   └─ 처음 사용:
      a. CLI 설치 안내 (macOS: brew, Windows: Scoop/직접)
      b. supabase login (브라우저 OAuth)
      c. 프로젝트 선택 또는 신규 생성
      d. SQL 마이그레이션 자동 실행 (portmgr_* 테이블 생성)
      e. CLI에서 URL + Anon Key 자동 추출 → portal.json 저장
      f. 기기 이름 입력 → deviceId 생성
      g. 연결 테스트 → 완료
   └─ 추가 기기 연결:
      a. URL + Anon Key 직접 입력 또는 "CLI 자동 가져오기"
      b. 기기 이름 입력
      c. Pull (다른 기기 데이터 불러오기)
      d. 경로 재설정 모달 자동 표시
```

### SetupGuide 컴포넌트

`src/PortalManager.tsx` 내 `SetupGuide`. 설정 모달 내 아코디언.  
3개 테이블 DDL을 Claude Code 프롬프트 형태로 제공. "Claude 프롬프트 복사" 버튼으로 클립보드 복사.

---

## 프로세스 관리 시스템

### 실행 상태 추적
- **HashMap**: 앱에서 직접 실행한 프로세스 `HashMap<String, u32>` (portId → PID)
- **lsof 기반**: 앱 재시작 후 기존 프로세스 `lsof -ti:포트번호`로 PID 검색
- **10초 자동 폴링**: `portsRef` + `setInterval(10000)` — dependency array는 반드시 `[]`

### 중지 로직
```
1. lsof -ti :포트 → 모든 PID 수집
2. 각 PID: SIGTERM → 200ms 대기 → kill -0 확인 → 생존 시 SIGKILL
3. HashMap에서 제거
```

### 강제 재실행
```
1. SIGKILL로 모든 PID 즉시 종료
2. 500ms 대기
3. 새 프로세스 실행 → 새 PID HashMap 등록
```

### 실행 우선순위
`commandPath` → `terminalCommand` → 자동 감지(`folderPath`)  
`detect_start_command`: `package.json` → `pyproject.toml` → `Cargo.toml` 순으로 탐색

---

## Tauri ACL 권한 (`src-tauri/capabilities/default.json`)

```json
{
  "permissions": [
    "core:default",
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "fs:default",
    "fs:allow-read-text-file",
    "fs:allow-read-file",
    "fs:allow-exists",
    "fs:allow-write-text-file"
  ]
}
```

**변환 공식**: 오류 `{plugin}|{operation} not allowed` → 권한 `{plugin}:allow-{operation}`  
권한 변경 후 반드시 재빌드 필요.

---

## Tauri 커맨드 (lib.rs)

| 커맨드 | 설명 |
|---|---|
| `load_ports()` | 포트 데이터 로드 |
| `save_ports(ports)` | 포트 데이터 저장 |
| `execute_command(port_id, command_path, folder_path, app_handle)` | 서버 실행 |
| `detect_start_command(folder_path)` | 실행 명령 자동 감지 |
| `stop_command(port_id, port, state)` | 프로세스 중지 |
| `force_restart_command(...)` | 강제 재실행 |
| `detect_port(file_path)` | 포트 번호 자동 감지 |
| `check_port_status(port)` | 실행 상태 확인 |
| `open_log(port_id, app_handle)` | Terminal에서 로그 열기 |
| `open_in_chrome(url)` | Chrome에서 URL 열기 |
| `build_app(build_type, app_handle)` | Tauri 빌드 (백그라운드) |
| `export_dmg()` | DMG를 Desktop으로 복사 |
| `create_folder(folder_path)` | 폴더 생성 후 Finder 열기 |

> **GUI PATH 이슈**: Tauri invoke()는 최소 PATH(`/usr/bin:/bin`). `claude` 등 사용자 설치 바이너리는 `zsh -l -c` 로 실행 필수.

---

## 로그 시스템

- 위치: `{앱 데이터}/logs/{portId}.log`
- 실행 시 stdout/stderr 자동 리다이렉트
- 앱 내 모달: 1초 폴링, 최근 500줄 슬라이딩 윈도우
- `newData.size < offset` 시 offset 0 리셋 (서버 재시작 자동 감지)

---

## 빌드 시스템 상세

```
bun run tauri:build:dmg
  └─ build-macos.ts
      ├─ CARGO_TARGET_DIR = $HOME/cargo-targets/portmanager
      ├─ update-version.ts (build-number.json 증가 + productName 고정)
      ├─ stamp-icon.py (아이콘 우하단에 vN 스탬프, Pillow 필요)
      ├─ vite build
      └─ tauri build --bundles dmg
          └─ fix-dmg.ts (macOS 버전 호환성 후처리, 임시 DMG 복사)
```

**버전 날짜 = 마지막 git 커밋 날짜** (오늘 날짜 아님). 올바른 날짜 DMG 생성하려면 빌드 전 커밋 완료 필수.

**Windows CARGO_TARGET_DIR 고정 이유**: 프로젝트가 `C:\Windows\System32\` 경로에 있으면 makensis.exe가 파일 읽기 차단(os error 2/5). `build-win.ts`가 target dir을 홈으로 자동 리다이렉트.

---

## Fork 후 체크리스트

포크 후 아래 파일만 업데이트하면 그대로 사용 가능:

1. `src-tauri/tauri.conf.json` — `identifier`를 본인 도메인으로 변경 (예: `com.yourname.agentstoZ`). 그대로 두면 macOS 서명 충돌.
2. `.env.example` → `.env` 복사 후 값 채우기:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - `VITE_VOC_ENDPOINT` — 본인 `submit-voc` Edge Function URL. 비우면 공식 수집함, `off`면 로컬 전용
   - `VITE_REPO_URL` — 포크한 저장소 URL
   - `PORTMGR_GITHUB_OWNER` / `PORTMGR_GITHUB_REPO`
   - `VITE_ALLOWED_EMAIL` — 포털 Google 로그인 허용 이메일(쉼표로 여러 개). 비워두면 로그인한 모든 Google 계정을 UI에서 허용하고, 값을 넣으면 그 계정만 허용. Supabase RLS 때문에 로그인 세션은 항상 필요하므로 공개 포털이 되지 않는다. 소스에 하드코딩하지 말고 Vercel 환경변수로 지정할 것.
3. `package.json` — `homepage`, `repository.url` 업데이트
4. `.github/workflows/build-windows.yml` — Secrets 재설정

---

## 트러블슈팅

### claude 명령을 찾을 수 없음 (DMG 빌드 후)
Tauri 앱은 사용자 PATH를 상속하지 않음. 앱은 `which claude` → `/usr/local/bin/claude` → `~/.npm-global/bin/claude` 순으로 탐색.
```bash
ln -sf $(which claude) /usr/local/bin/claude
```

### cmux 버튼 클릭 시 반응 없음
```bash
defaults write com.cmuxterm.app socketControlMode -string "allowAll"
pkill -f "cmux.app/Contents/MacOS/cmux" && sleep 2 && open -a cmux
cmux ping   # PONG이 오면 성공
```

### Windows: "running scripts is disabled"
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Windows: API 서버 PATH 문제
`api-server.ts`는 `/usr/sbin/lsof` 절대경로 사용. 문제 지속 시 `./실행.command` 또는 `start.bat`으로 재시작.

### Supabase OAuth RLS 충돌
RLS가 로그인 사용자만 허용하므로 Google OAuth 세션의 JWT를 유지해야 한다.
`createClient()` 옵션은 `auth: { persistSession: true }`여야 하며, `false`이면 로그인 후에도 anon으로 쿼리되어 Push/Pull이 거부된다 (`src/lib/supabaseClient.ts`).

### Tauri DMG bundle_dmg.sh 반복 실패
`fix-dmg.ts`로 임시 DMG 복구: `bun run fix-dmg`

---

## UI 아키텍처 핵심

- `App.tsx` 단일 파일 (~6000줄) — 모든 상태, 모달, 탭 관리
- 탭: `activeTab: 'ports' | 'portal'` — 창 크기 무관하게 항상 양쪽 표시
- 다크 테마: 배경 `#0a0a0b`, 카드 `#18181b`, 강조 민트/틸 계열
  (`src/index.css`의 `--accent-*` 토큰이 정본 — `--accent-amber`는 이름만 남고 값은 `#5eead4`다.
  2026-07-25 `15b6524`에서 웜 크림/앰버 → 쿨 니어블랙/민트로 옮겼다. 옛 `#e8a557`을 다시 쓰지 말 것)
- 10초 자동 폴링: `portsRef` (`useRef<PortInfo[]>`) + `setInterval(10000)`  
  — `useEffect` dependency array는 반드시 `[]` (무한 루프 방지)
- Toast 알림: 우측 상단 슬라이드인, 3초 자동 제거
- Claude 버튼 레이블: 이모지 없이 텍스트만 (`Claude 열기` / `새창`)

---

© 2025 CS & Company. All rights reserved.

<!-- AgentsToZ project-memory:start -->
## Project memory integration

<!-- AgentsToZ memory-agent-version:12 -->
- Read `.agent-memory/config.json` and its project-relative `sourcePath` before substantial work when historical decisions may matter.
- Once the memory outgrows a single file, `sourcePath` holds an **index** of entry titles and
  `.agent-memory/notes/` holds the bodies. Read the index, then only the notes whose titles
  match the task. The index is generated — edit the notes, never the index.
- Every durable `###` entry carries an immediately following `<!-- memory-entry-id:<24 lowercase hex> -->` marker.
  Never remove or regenerate that ID when renaming, moving, or editing the entry; only a genuinely new entry gets a new ID.
- “세션 기억하기” is the project-local memory workflow. When the user asks to remember the
  session, update the configured local memory first, mark current activity as remembered,
  and then back it up:
  `PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" http://127.0.0.1:3001/api/project-memory/mark-remembered && curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" http://127.0.0.1:3001/api/project-memory/push`
- Generated Claude/Codex `UserPromptSubmit` hooks are token-free: they discard prompt
  content and record only the last activity time and agent so AgentsToZ can highlight
  “세션 기억하기 필요”.
- If a compatible external closing workflow such as `/cs-end` runs, apply the same
  “세션 기억하기” procedure before it finishes.
- Keep each note at or under 12000 bytes; a save is asked to compact one
  over-budget note at a time. Merge or compress older entries within that note instead of
  growing it; never drop a durable decision outright.
- A failed remote backup must never roll back the local memory update. Report the failure so Push can be retried in AgentsToZ_byCS.
<!-- AgentsToZ project-memory:end -->
