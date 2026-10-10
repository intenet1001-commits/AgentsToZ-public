# AgentsToZ OPS 표면 패리티 — 실행 기록

## 범위와 기준선

- 2026-09-20: [착수 전 현황](AUDIT.md)을 보고하고, 격리 작업트리에서 Task A부터
  진행하자는 제안에 사용자가 “체계적으로”라고 응답했다. 첫 실행 범위는 **A만**이었다.
- Task A 완료 보고 뒤 사용자가 “ㅇㅇ”, 이어 “진행해”로 **B** 진행을 승인했다.
  B 이후 C~F의 일괄 구현을 승인받은 것으로 해석하지 않는다.
- B 완료 뒤 “c진행해”로 **C만** 승인했다. 이후 사용자가 실제 앱·기억·AI 작업 검증과
  D/E/F·VOC 개선까지 명시적으로 요청해 후속 Task를 한 단계씩 독립 커밋으로 진행한다.
- 브랜치: `claude/agentstoz-memory-profile-structure-8wuogh`.
- 시작 HEAD: `af7b2d7b3ebce09269ebf9c58a97e1d8feb79898`.
- 작업트리: `/Users/gwanli/product_2026/AgentsToZ_ops_surface_parity`.
  기존 `AgentsToZ_byCS`의 main 및 45개 tracked WIP·신규 handoff/테스터 파일은 보존한다.
  AUDIT의 줄 번호는 기존 WIP 기준이며 이번 구현에 그 WIP를 합치지 않았다.
- 최신 정책은 표시 이름만 OPS로 바꾸고 물리 Control 정체성을 유지하는 것이다.
  기존 WIP의 Phase C 폴더 이동 계획은 이번 완료 조건에서 제외한다.
- 로컬 sidecar가 꺼져 있어 기억 Pull은 한 번 실패했다. canonical root의 기존 로컬
  기억을 사용했으며 새 작업트리에 별도 기억을 만들지 않았다.

## Task A — 표시 문구 정리 · 구현/검증 완료

### 재사용 / 신규

- `src/App.tsx:13598,14087` (안내 `9203,9933,15778`): 기존 도구 메뉴·AI 작업·복원/생성 안내의 표시만 AgentsToZ OPS로 통일.
  운영 프로필 열기와 실제 운영 폴더 열기를 서로 구분한다.
- `src/ControlProfilePanel.tsx:30`: 기존 프로필 패널의 제목·연결·닫기 안내를 통일.
  후보 접수와 저장/백업의 구분, prepare/policy/attach/review handler는 그대로다.
- `src/OnboardingFirstProject.tsx:20`: 기존 준비/복원 callback과 testid를 유지하며 라벨 변경.
  “처음 사용”은 폴더 생성이 아닌 프로필 준비임을 정확히 안내한다.
- `src/AiWorkRequestPanel.tsx:144`: 미션 관제의 표시만 OPS로 변경. mode/policy 값과
  Control 프로젝트 해석, Workroom 실행/권한/이어가기 동작은 유지한다.
- `README.md:53`, `docs/control-profile.md:1`: 사용자 이름과 실제 저장 이름을 구분하고
  지원되지 않은 후속 표면을 완료된 것으로 안내하지 않는다.
- 신규 런타임 파일 없음. 이번 계획 폴더의 문서만 새로 추가했다.

### 계약 / 버전

- MCP 도구명/서버, API, 상수, DTO, testid, marker, seed 및 publish strip 변경 없음.
- `AgentsToZ-Control` 실제 폴더/저장소, 프로필·기억 ID 변경 없음.
- 원격 프로토콜은 기존 `agentstoz-local-v7`; 버전 상승 없음.
- candidate → review → save 흐름 유지. A의 UI 회귀는 기존 review 요청의 보존을
  검증하는 것이며 Task F의 인증된 사람 승인 경계 완성을 증명하지 않는다.

### 동작 회귀

- 기존 `tests/onboarding-first-project-app-ui.mjs` 확장: 실제 App 렌더링에서 도구·
  온보딩·AI 작업 진입점이 같은 OPS 패널을 열고 프로필 조회만으로 prepare를 하지
  않는지 확인. prepare의 빈 body, policy, 기억 ID, 저장/제외의 정확한 review body,
  후보를 보기만 했을 때 저장하지 않는 동작, 기존 복원 동선을 확인한다.
- 기존 `tests/onboarding-first-project-ui.mjs`: 실제 SetupWizard의 준비/복원 callback과
  외부 쓰기 없음 확인. 예전 “내 Control 자동 만들기”의 오래된 selector도 현재 문구에 맞춤.
- 기존 `tests/ai-work-request.e2e.mjs`: OPS 미션 표시를 확인하고 기존 Control targetId와
  네 AI 작업 배정 계약의 회귀를 그대로 실행한다.
- `tests/control-center-project.test.ts`의 기존 표시 문구 기대값도 함께 갱신했다.
  기능 검증을 이 문자열 검사로 대신하지 않고 위 실제 App 클릭 회귀와 함께 실행한다.
- fixture는 별도 임시 Vite/API이며 개인 Supabase/실행 중 앱에 요청하지 않는다.
  설치 앱·실제 AI·Telegram/AWS·다른 Mac 성공을 뜻하지 않는다.

### 현재 검증 기록

- `bun install --frozen-lockfile`: 성공, package/lockfile 변경 없음.
- Python `quick` 기준선: 2 checks passed (Python 34 + Bun 116), 0 fail.
  run `20260920T030933Z-ee5261fc`.
- RED: 새 OPS 라벨을 기대하는 SetupWizard UI 테스트는 구현 전 해당 버튼을 찾지 못해
  실패했다. 구현 후 같은 테스트는 통과했다.
- `web-orchestration`: 2 fixtures passed (AI 관제 10개 시나리오 + 실제 App),
  run `20260920T031714Z-0767b595`, source unchanged.
  첫 실행은 추가한 테스트가 모달을 닫은 뒤 접힌 도구 메뉴를 다시 열지 않아 실패했다.
  실제 사용자 동선대로 메뉴를 다시 여는 테스트 단계만 보완했고 앱 동작은 바꾸지 않았다.
- 표시 문자열을 제외한 TypeScript AST 비교: UI 4개 파일 모두 동일.
  handler·testid·API 호출·선택 값과 프로젝트 이름 판정이 그대로임을 보조 확인했다.
- `bun run verify`: **PASS**, run `20260920T070019Z-a181ddeb`, exit 0,
  source unchanged, 360.428초. Python maintainer → typecheck → Bun → sidecar build → Cargo
  순차 완료. **Bun 4,284 pass / 0 fail (578 files), Rust 58 pass / 0 fail**.
  runner는 출력의 끝부분만 보존하므로 전체 원시 로그를 보존했다고 주장하지 않는다.
- 첫 verify run `20260920T031802Z-b81be9a6`는 완료 영수증 없이 중단됐다.
  잔존 프로세스가 없음을 확인한 뒤 위 전체 재실행으로 대체했으며 첫 run은 pass/fail에 넣지 않는다.
- Git author email은 GitHub 현재 로그인 계정의 verified email 목록과 일치함을 확인했다.
- canonical 프로젝트 기억에 OPS/Control 명칭 경계·단계 게이트를 저장했다.
  기존 설치 앱의 안전한 sync(`ok:true`) 후 로컬 note 저장, mark-remembered 성공,
  Supabase Push의 `contentBackedUp`, `journalBackedUp`, `backupComplete` 모두 true.
  Git 소스의 기존 미커밋 작업과 linked worktree의 기억 정체성은 분리하지 않았다.

## Task B — 로컬 등록 역할 · 구현/검증 완료

### 범위 / 재사용 / 신규

- 새 `src/projectRole.ts:1`: 선택적 역할의 표시용 해석. 연결된 OPS ID, 부모 프로젝트,
  명시적 역할, 기존 이름/개발 루트 해석을 사용한다. 기존 행·폴더·기억 ID를 변경하지
  않는다. 미지원 역할·깨진 워크트리 계보는 `unknown`으로 읽기 전용 안내한다.
- 기존 `api-server.ts:4142` Control 복원 등록과 `api-server.ts:2414` 대화형 프로젝트 생성에 역할을 기록한다.
  이미 있는 Control 등록 행은 강제 rewrite하지 않고 기존 프로필 binding으로 표시한다.
- 기존 `src/ports-merge.ts:12`, `src-tauri/src/lib.rs:2616`의 잠금→merge→원자적 저장 재사용.
  레거시/3-way 저장에서 역할 생략은 삭제가 아니며, 명시된 새 미지원 값은 저장 전 거부한다.
  디스크에 이미 존재하는 미래 값은 일반 저장 왕복에서 보존한다. typed import의
  Rust enum은 미지원 값을 silently drop하지 않고 역직렬화를 거부한다.
- 새 `src/ProjectRoleLabels.tsx:4`: 두 사이드바에서 재사용하는 필터/배지.
  `src/App.tsx:3572,9944`는 기존 status 읽기와 OPS 패널을 재사용한다. 새 타이머 폴링 없음.
- 기존 `src/ProjectMemoryPanel.tsx:318`: OPS/미지원 역할은 일반 기억 편집기를 mount하지
  않고 운영 프로필로 안내한다. DEV/managed의 기존 편집기는 유지한다.
  장기기억 탭에는 기억 경계 안내와 같은 OPS 패널 진입점을 추가했다.

### 계약 / 한계

- 로컬 `ports.json` 선택 필드 추가. 기존 `/api/ports`와 `/api/ports/merge`를 유지하며,
  새 잘못된 역할의 저장만 `400 / PROJECT_ROLE_INVALID`로 거부한다.
- MCP 도구명/DTO, Control API·상수·testid, marker·seed·repo·publish strip 변경 없음.
  원격 DTO·Supabase 스키마·`agentstoz-local-v7` 유지, 버전 상승 없음.
- 역할은 로컬 분류이며 권한·profileId·memoryId·프로젝트 USE/DEV purpose가 아니다.
  다른 Mac으로 사용자 지정 role을 동기화하는 기능과 클라우드 기억 목록의 행별 역할
  분류는 이번에 추가하지 않았다. 기존 기억 동기화와 호스트별 Control 복원은 유지한다.
- 일반 기억 API의 공유 OPS 쓰기 우회 차단·사람 승인 증명은 F의 별도 보안 작업이다.
  B의 화면 분리만으로 이 보안 경계가 완성됐다고 보고하지 않는다.

### 회귀와 현재 증거

- Python 기준선: MCP run `20260920T071223Z-433a1a81`, quick 2 checks passed,
  source unchanged. 등록된 동일 프로젝트의 승인된 작업트리 대상으로 실행했다.
- RED: 역할 회귀를 먼저 추가했을 때 기존 저장의 역할 소실/잘못된 값 허용을 재현했다.
- `tests/fixtures/project-role-merge.json`: Bun/Rust가 같은 11개 golden 사례 실행.
  누락·동시 수정·삭제 후 부활 금지·미지원 값 보존/거부를 검증한다.
- `tests/project-role-api.test.ts`: 격리된 실제 API의 저장·재조회·읽기 시 무마이그레이션,
  잘못된 역할의 400과 디스크 무변경을 검증한다.
- 기존 MCP/API 생성 회귀는 실제 등록 행의 ops/managed와 기존 DTO를 확인한다.
  클라우드 업로드 회귀는 role이 DTO나 자동 Push 트리거에 추가되지 않음을 확인한다.
- 관련 Bun 44 pass / 0 fail (5 files), typecheck pass. Rust golden test pass.
- 실제 App 클릭 회귀: 역할 필터·배지, 이름이 바뀐 기존 OPS의 바인딩,
  DEV/managed 기억 편집 유지, 미지원 역할 차단, 조회/클릭만으로 초기화·저장 없음.
  첫 UI 실행은 기존 앱의 `isRunning:false` 정규화 때문에 fixture 전체 비교가 실패했다.
  그 기존 상태를 fixture에 명시해 실제 역할 데이터의 무변경 검사를 유지했다.
- 최종 `bun scripts/check-maintainer-web.ts orchestration`: **PASS**, AI 관제 10개
  시나리오(3.3초) + 실제 App(9.6초). 프로필 상태 조회 실패 시 기억 편집 보류,
  연결 재확인 뒤 OPS 필터에서 다시 선택하는 복구 동선까지 확인했다.
  중간 복구 테스트는 역할이 회복되어 managed 필터에서 빠진 행을 그대로 기다려
  실패했으며, 실제 사용자 동선대로 OPS 필터에서 재선택하는 테스트 단계로 수정했다.
- `bun run verify`: **PASS**, MCP run `20260920T102315Z-7e2d25b1`, 351.539초,
  source unchanged. **Bun 4,301 pass / 0 fail (580 files), Rust 60 pass / 0 fail**.
  Python maintainer·typecheck·sidecar build를 포함한 순차 명령이 exit 0으로 완료됐다.
  MCP의 출력은 잘리므로 같은 run의 로컬 JSON 영수증에서 위 Bun/Rust 합계를 확인했다.
- 커밋 직전 `git diff --check` 통과. Git author email의 GitHub verified 일치 재확인.
- 실제 설치 앱·실제 AI·다른 Mac·Telegram/AWS 테스트나 배포를 수행한 것은 아니다.

## Task C — OPS 실행 표면 연결 · 등록 Control 기준 구현/검증 완료

### 착수 전 재확인 / 구현 범위

| 표면 | 착수 시 기존 경로 | C에서 재사용/추가 |
|---|---|---|
| 외부 앱 | MCP `open_code_app` → action → `/api/open-code-app`; Codex/Claude/Hermes | 기존 도구에 명시적 `target: ops`, 기존 mode/bypass 전달. 경고·오류 코드 보존 |
| Workroom | start/list/read/send → `aiTerminalService`; 등록 target inventory | 같은 도구에서 바인딩된 OPS ID를 해석. 네 AI/초기 출력/멱등 요청/세션 대상 검증 재사용 |
| Orca | `/api/open-orca-agent`, `shouldUseOrcaFloatingTerminal`, selector 실패 fallback | `open_code_app.surface`로 기존 실행기 연결. floating/worktree와 fallback/reuse 경고 전달 |
| 대시보드 | app foreground + `/api/agentstoz-use/workroom-navigation` focus hook | 같은 navigation에 OPS panel 선택. 폴더 없는 프로필도 지원 |

- 신규 `src/controlProfileSurface.ts:9`: 준비된 프로필의 live 기억·기억 ID·실제 등록 폴더
  일치를 확인한다. 비동기 조회 중 프로필 전환, 다른 프로젝트/워크트리 경로, 중복 등록은
  fail-closed. 이름/role/cwd를 권한으로 사용하지 않는다.
- `src/agentstozUseControl.ts:120`, `agentstoz-use-mcp-server.ts:137,242`: 기존 도구에 호환 가능한
  대상·표면 옵션. `target: ops` + `portId` 혼용·잘못된 표면/AI/권한 옵션은 거부한다.
- `api-server.ts:15415,15751,15907`: 기존 action·외부 앱·Workroom·Orca 실행기를 재사용한다. 새 로컬
  `/api/control-profile/open`은 패널의 bounded 어댑터이며, 토큰은 sidecar 내부에서만 사용한다.
- `src/ControlProfilePanel.tsx:35`, `src/App.tsx:2553,15104`: 실제 OPS 열기 선택/버튼, 기존 navigation
  포커스, Workroom 진입, 권한/Orca 경고 토스트. 불확실한 Workroom 재시도는 같은 request ID.
- Workroom 시작 후 앱 포그라운드만 실패한 경우 시작된 세션 영수증을 잃지 않고
  `openedWorkroom: false`와 경고를 반환한다. 새 세션 재생성 성공으로 덮지 않는다.

### 계약 / 경계 / 명시적 갭

- 기존 `agentstoz_use_*` 도구명·`CONTROL_PROFILE_*` 값·API 경로·testid 변경 없음.
  `target: ops`, `surface`, `bypass` 선택 필드와 로컬 `POST /api/control-profile/open` 추가.
  MCP 서버 기능 버전만 `1.15.0 → 1.16.0`; wire protocol/원격 v7/모바일 DTO는 그대로다.
- Control repo/실제 폴더/marker/seed/memoryId 및 propose→review→save, publish strip 유지.
  새 포트·채널·relay·원격 승인·저장 기능은 없다. 기존 파일을 옮기거나 기억을 합치지 않았다.
- **비등록 app-data OPS의 앱·Workroom·Orca 실행은 미지원으로 명시**한다. 기존 실행
  대상 inventory가 등록 프로젝트 기반이므로 무단 등록·가상 target 삽입으로 우회하지 않는다.
  운영 패널/기억 호출과 기존 AI 작업의 폴더 없는 관제 모드는 유지한다.
- 실기기/실제 AI 모델/설치 앱/다른 Mac은 미검증. OS 호출을 격리한 실행기·API·UI 검증을
  개인 앱/외부 AI 계정의 완료로 표현하지 않는다. 대시보드 결과는 포커스 요청 영수증이며
  설치 앱의 버전/실제 화면은 별도 확인 대상이다.

### 회귀 검증

- quick 기준선 `20260920T104437Z-18a8864c`: passed, sourceUnchanged true.
- 신규 parser/MCP + resolver 동작: 12 pass / 0 fail. 모호한 target, 지원하지 않는 옵션,
  동시 프로필 전환, 중복/워크트리 등록 차단과 기존 `portId` 호출 보존.
- 신규 `tests/control-profile-surface-api.test.ts`: 7 pass / 0 fail. 실제 격리 API/MCP,
  네 CLI의 실제 PTY 시작→초기 출력→입력→응답, 멱등 요청·다른 프로젝트 차단,
  로컬 어댑터/키 비노출·app-data 거부·포그라운드 부분 실패 영수증 확인.
- `tests/fixtures/ops-orca-api.ts`: 프로덕션 Orca route를 그대로 실행하고 OS process만
  대체한다. 실제 selector_not_found 재시도→floating fallback→두 번째 요청에서 같은
  핸들 재사용, 추가 create/send 없음 확인. 개인 Orca/AI는 실행하지 않는다.
- 기존 MCP/프로필 회귀 포함 집중 실행 33 pass / 0 fail.
- 실제 App browser fixture: A/B 경로 유지와 OPS dashboard focus, app/Orca/Workroom 전달,
  bypass/fallback 고지·app-data 비활성화 확인. AI orchestration 10개 시나리오도 통과.
- 최종 전체 **`bun run verify` 통과**: MCP 실행 `20260920T111013Z-ef1140bd`,
  sourceUnchanged true, 339.907초. Bun **4320 pass / 0 fail · 583 files**,
  Rust **60 pass / 0 fail**, 선행 Python·typecheck와 sidecar 빌드도 전체 게이트 통과.
- 마지막 코드 기준 `bun scripts/check-maintainer-web.ts orchestration` 재실행도 통과:
  AI orchestration 10개 시나리오 + 실제 App의 A/B/C 동작 회귀. 설치 앱 테스트는 아님.
- `git diff --check` 통과. 작성자 `intenet1001@gmail.com`은 `gh api user/emails`로
  GitHub 연결·verified true 확인. 지정 브랜치 독립 로컬 커밋만 만들며 push/PR/설치 없음.
- 코드 검증 종료 뒤 이 완료 증거 문단만 추가했다. canonical main의 45개 tracked 변경과
  기존 미추적 파일은 C 커밋에 포함하지 않는다. 검증된 교훈은 기존 DEV 프로젝트 기억에
  저장하며, 실제 OPS 공유 기억 후보/승인을 대신 수행하지 않는다.

## Task D — Buzz · Hermes/Telegram 표면 연결 · 구현/검증 완료

### 재사용 / 신규

- 기존 `agentstoz_use_connect_buzz_channel`, `agentstoz_use_open_buzz_dev`에 C와 같은
  `target: ops` 선택지만 추가했다. 프로필 바인딩의 등록 ID·live memoryId·canonical root를
  다시 확인하며 이름·role·cwd로 OPS를 추측하지 않는다.
- 기존 Buzz binding 파일, 채널 UUID 검증, workspace lease와 앱 foreground 경로를 그대로
  재사용한다. OPS 패널에는 같은 dispatcher를 호출하는 `Buzz 채널` 표면을 추가했다.
- 정확한 채널 딥링크는 만들지 않았다. 성공 응답은 `exactChannelOpened: false`, 정확한
  channelId/name과 “앱에서 선택” 안내를 함께 반환한다.
- Hermes는 기존 host별 `config.yaml` MCP 연결과 invocation skill/SOUL 설치가 이미 전역
  프로필 토큰을 사용하므로 새 transport를 만들지 않았다. AWS/Telegram도 해당 호스트의
  sidecar와 복원된 Control, Hermes/Telegram 연결이 있어야 같은 기억을 호출할 수 있다.

### 계약 / 검증

- 도구명, `/api/control-profile/*`, `CONTROL_PROFILE_*`, Control repo/marker/seed는 변경 없음.
  기존 Buzz 프로젝트 호출의 `portId` 계약은 유지하고 OPS만 상호배타적 선택지로 추가했다.
- MCP 기능 버전 `1.16.0 → 1.17.0`. 원격제어 DTO·프로토콜은 D에서 변경하지 않아 v7 유지.
- parser/MCP/API 회귀는 프로젝트 호출과 OPS 호출, 모호한 target 거부를 함께 실행한다.
  격리 sidecar에서 실제 OPS binding 생성→Buzz channel 연결→foreground adapter→정확한
  채널 제한 응답을 확인했고, 로컬 경로·프로필 토큰이 응답에 없음을 확인했다.
- 실제 Telegram/AWS 메시지 송수신 성공은 해당 외부 호스트·계정 연결이 없어 주장하지 않는다.
  기존 Hermes 다중 profile 테스트는 모델 선택과 다른 MCP 설정을 보존하면서 각 home에 같은
  invocation/MCP 연결을 설치함을 검증한다.

## Task E — 기존 원격제어의 OPS 진입점 · 구현/검증 완료

### 재사용 / 신규

- 기존 `RemoteControlCore`의 QR one-time token, session token, actionId 멱등성, read/mutation
  rate budget과 `remoteConfirmed`를 그대로 재사용해 `ops.status`, `ops.open` 두 host action만
  추가했다. 프로젝트 controlId·경로·명령·기억 ID는 요청/응답에 넣지 않는다.
- `ops.status`는 상태·backend·대기 후보 수·마지막 저장 시각·동기화 상태만 반환한다.
  `ops.open`은 휴대폰/브라우저 확인 후 기존 대시보드 foreground와 OPS panel navigation을
  재사용한다. foreground 실패 시 이전 navigation을 복구하며 성공으로 보고하지 않는다.
- 같은 Wi-Fi QR 페이지와 인터넷 개인 포털에 `운영기억 상태 확인`, `AgentsToZ OPS 열기`
  라벨을 동시에 추가했다. 포털은 브라우저 기반이라 phone→Mac과 Mac 브라우저→다른 Mac에
  같은 승인·E2EE relay 경로를 쓴다. 별도 네이티브 Mac 채널이나 포트는 만들지 않았다.

### 계약 / 보안 / 검증

- 기본 원격 protocol `agentstoz-local-v7 → agentstoz-local-v8`. 웹 두 표면, controller
  strict normalizer, release metadata와 iOS wire/build 상수를 함께 올렸다. `session.ready`의
  exact-key shape, relay protocol v4, task/conversation 별도 scope는 변경하지 않았다.
- 인터넷은 기존 Google 로그인→P-256 E2EE→Mac SAS 승인된 controller authority만 core에
  전달한다. LAN은 기존 QR pairing identity를 사용한다. 상태 읽기와 패널 열기 외 기억 원문
  조회·저장·승인은 E에 추가하지 않았다.
- 신규 core 회귀는 확인 없는 `ops.open` 거부, LAN authority 파생, project ID/path/memoryId
  비노출, strict extra-key 거부를 검증한다. LAN/포털은 동일 두 라벨과 각 action wiring을
  함께 검증한다. 관련 원격 core/relay/portal/mobile 계약 160개 테스트가 통과했다.
- Mac→Mac 실기기 두 대를 물리적으로 연결한 검증은 아직 아니다. 기기 중립 포털의 동일
  controller 코드를 데스크톱 viewport에서도 후속 UI 검증하며, 네이티브 전용 UI는 별도
  범위로 만들지 않는다.

## 후속 Task

| Task | 다음 범위 / 게이트 |
|---|---|
| C 후속 | 비등록 app-data 실행 대상의 설계/명시적 연결 정책과 실제 설치 앱·AI 계정 확인. 현재 미지원 표면은 위와 같이 공개 |
| F | 구현·집중 검증 완료. 전체 verify·실제 앱 사용자 테스트·Supabase 영수증은 아래 최종 검증에서 확정 |

장기기억→스킬은 docs 설계 승인 전 구현 금지. TUI·다중 프로필은 제외한다.
지정 브랜치 외 push, main 병합, 배포/설치, PR 생성은 이번 작업에 포함하지 않는다.

### 높은 추론 강도로 이어갈 검토

- B의 역할 분류는 로컬 UI/저장 호환성이다. 공유 OPS 쓰기 권한 증명이나
  다른 Mac의 사용자 지정 역할 동기화를 대신하는 것으로 사용하지 않는다.
- E/F: MCP 토큰·Origin만으로 사람 승인을 대신하지 않는다. 데스크톱/원격 승인 증명,
  SAS·기기 grant·revision·동일 요청 재전송과 일반 기억 저장의 우회 경로를 검증한다.
- A의 fixture 통과는 이 보안 검토나 다른 Mac·AWS Telegram의 실증을 대체하지 않는다.
  후속 설계/구현은 해당 Task 범위 합의 후 시작한다.

## Task F — 어디서나 캡처 · 인증된 사람만 공유 저장

### 저장 정책과 호출 관문

- `아젠투지, 기억해`를 네 AI 공통 자연어 정본으로 명시했다. Claude에는 네이티브
  `remember_agentstoz` command, Hermes에는 같은 이름의 skill만 추가했다. Codex/agy에는
  지원하지 않는 네이티브 slash를 가장하지 않고 기존 자연어 invocation 지침을 갱신한다.
- MCP에는 읽기 전용 `agentstoz_use_list_control_memory_candidates`만 추가했다. 기존
  `agentstoz_use_propose_control_memory`는 공유 `control-folder`에서 계속 pending 후보를
  반환하며 AI가 호출할 review/approve 도구는 없다.
- 로컬 전용 `app-data`는 공유문서가 아니므로 store 계층에서 제안 즉시 저장하고
  `saved:true`를 반환한다. 공유 `control-folder`는 동일 store 계층에서 항상 후보로 남아
  데스크톱 패널 또는 SAS 승인 원격 검토 전에는 문서를 쓰지 않는다.

### 원격 승인과 우회 차단

- 같은 Wi-Fi LAN과 개인 포털 모두 `저장 후보 확인`을 제공한다. 후보 DTO는 현재 revision과
  제한된 id/title/body/evidence/baseRevision/createdAt뿐이며 경로·memoryId·token은 없다.
  LAN은 조회 전용이고 저장/거절 버튼 자체가 없다.
- 개인 포털은 기존 Google 로그인→E2EE→Mac SAS 승인 authority를 그대로 사용해 사람의
  저장/거절을 전달한다. core와 API gateway가 모두 `internet:` authority를 재확인한다.
  후보 ID+expected revision+명시적 accept를 요구하며 결과 저장 뒤 기존 backup을 호출한다.
- `/api/project-memory/init|update|sync|push|pull|restore-revision|resolve-conflict|session-end`,
  session/document recovery, thread sync 및 generic project worker는 바인딩된 공유 OPS root를
  직접 변경하거나 백업할 수 없다. `CONTROL_PROFILE_REVIEW_REQUIRED`로 fail-closed한다.
  Control host의 내부 review→save→backup 경로는 이 HTTP 우회 차단과 분리돼 유지된다.

### 계약 변경과 집중 검증

- MCP 기능 버전 `1.17.0 → 1.18.0`, invocation `v2 → v3`.
- 원격 기본/Task transport `agentstoz-local-v8 → agentstoz-local-v9`. candidateId,
  expectedRevision, accept는 `ops.memory.review`에서만 허용되는 strict 필드다. 두 웹 표면,
  relay normalizer, release metadata, iOS wire/build 상수를 함께 올렸다.
- 신규 회귀는 app-data 즉시 저장, 공유 후보 무저장·멱등 review, 읽기 전용 MCP 목록,
  일반 프로젝트 기억 API 우회 차단, LAN 승인 거부, Internet SAS authority 승인,
  additive secret/extra-key 거부, 양쪽 원격 라벨과 LAN 저장 버튼 부재를 검증한다.
- Telegram/AWS·물리적 다른 Mac·실제 원격 SAS 세션은 외부 연결이 필요한 후속 실증이다.
  이 로컬 검증을 해당 외부 성공으로 표현하지 않는다.

### Task F 최종 게이트

- 공유 후보 승인 뒤 Control 문서 저장은 성공했지만 Supabase/Git 백업이 실패한 경우,
  원격 응답은 로컬 저장 완료와 백업 보류를 분리해 반환한다. 백업 실패를 전체 저장 실패나
  완전 성공으로 바꾸지 않는다.
- `bun run verify` 통과: Bun 4,330 pass / 0 fail (584 files), Rust 60 pass / 0 fail.
  typecheck, Python maintainer와 sidecar build도 exit 0이었다.
- 마지막 백업 결과 정직성 수정 뒤 집중 회귀 56 pass / 0 fail, iOS Swift 1 pass / 0 fail,
  quick maintainer pass. 지정 브랜치의 독립 커밋 `d2a9a98`에 포함했다.

## VOC · AI 작업 실제 사용성 후속 개선

### 적용한 개선

- 장기기억 첫 화면에 `1 · DEV 프로젝트 기억`, `2 · 이 단말 연결`,
  `3 · Buzz 앱 Agent` 순서를 추가해 DEV 기억, 호스트 연결, 별도 USE Agent 생성을 분리했다.
- Buzz 생성 문구를 `Buzz 앱용 USE 서비스 Agent`로 통일하고 기존 DEV 기억을 바꾸지 않는다고
  명시했다. 이 변경은 프로젝트 라우팅 봇이나 OPS 기억 합병이 아니다.
- AI 작업은 `프로젝트 → 실행 방식·AI → 요청 → 실행` 순서를 먼저 보여 주고, 부분 inventory
  실패 때 마지막 확인 목록은 선택 가능하되 실행 직전에 등록·경로를 다시 검사하며 삭제·연결
  해제된 대상은 시작하지 않는다고 설명한다. 시작 불가 시 현재 단계의 이유를 표시한다.
- Workroom의 기억 영역을 `워크룸 종료 후 장기기억 저장 결과`로 바꾸고 대화 입력창이 아닌
  결과판임을 명시했다. `로컬 장기기억 저장`과 `Supabase 백업`을 분리하고 미확정 작업은
  자동 재실행하지 않는 기존 안전 정책을 사용자 문구에 드러냈다.
- Node smoke가 ESM에서 `projectRole`을 찾지 못하던 경로는 명시적 `.ts` import로 정정했다.
- 고배율 AI 대화에서 `ai-structured-runtime`을 `flex-1 min-h-0`로 고정해 실제 내용보다
  바깥 scrollHeight가 작아지는 문제를 수정했다. 구조화 런타임은 자연 높이로 바깥 스크롤에
  포함하고, 대화 본문 최소 높이는 논리 viewport에 맞춰 20rem~34rem으로 제한한다.
  테스트의 `세션 종료`도 확인 대화상자에서 실제 `저장 없이 종료`를 누르는 사용자 흐름으로
  바로잡았다.

### 실제 사용자 표면과 회귀 증거

- Ego Lite 실제 포인터 검증: 수정 전 바깥 scrollHeight/clientHeight가 595/549이고 입력창이
  실제 클릭 영역 밖에 있었다. 수정 뒤 scrollHeight가 2,059 이상으로 계산됐고, 브라우저가
  입력창으로 스크롤한 뒤 실제 포인터 접기와 `elementFromPoint === SUMMARY`를 확인했다.
- `bun run test:smoke`: **216/216 pass**. 100%/125%/150%에서 대화 입력 접기·재열기,
  초안 보존과 실제 pointer hit-test를 포함한다.
- `node tests/workroom-usability.e2e.mjs`: **34/34 pass**.
  `node tests/ai-work-request.e2e.mjs`: **10/10 pass**.
  VOC/Buzz 집중 Bun 회귀: **9 pass / 0 fail**, typecheck pass.
- 최종 전체 `bun run verify`: **PASS**, Rust **60 pass / 0 fail**, Bun/TypeScript/Python/
  sidecar build 전체 exit 0. quick maintainer run `20260920T155917Z-81bd92bc`도 두 check pass.
- 로컬 VOC 3건은 코드 개선과 소스 앱 실제 브라우저 검증까지 완료했다. 다만 workflow가
  `voc/done/` 이동 전에 설치 앱 확인을 요구하므로, 미배포 로컬 빌드의 실앱 검증이 끝나기
  전에는 open 상태를 보존한다. 설치·배포 권한을 이 검증으로 추정하지 않는다.

## v476 격리 앱 · 실제 AI 작업 후속 검증

### OPS → Codex

- `bun build-macos.ts --allow-unpublished-source`로 v476 로컬 테스트 앱과 DMG를 만들었다.
  이 산출물은 ad-hoc·미공개 테스트용이며 설치·공증·배포하지 않았다.
- v476 테스트 앱의 sidecar가 `127.0.0.1:3001`을 단독 점유한 상태에서, 같은 번들의
  `agentstoz-use-mcp`를 stdio로 초기화해 실제 `agentstoz_use_open_code_app`을 호출했다.
  새 MCP는 version `1.18.0`과 읽기 전용 후보 조회 도구를 광고했다.
- `target: ops`, `agent: codex`, `mode: reopen` 호출은 예전 설치 앱에서 보였던 일반
  `지원하지 않는 요청입니다.`가 아니라 `CODEX_PROJECT_SESSION_NOT_FOUND`를 반환했다.
  `mode: prepare`는 정확한 composer를 찾지 못한 경우 `CODEX_DESKTOP_COMPOSER_NOT_READY`로
  닫혔고 첫 메시지를 임의 전송하지 않았다. 따라서 C의 새 route와 fail-closed 계약은
  격리 sidecar에서 동작한다. Codex 앱에 기존 프로젝트 세션/composer가 준비된 성공 클릭은
  별도 실사용 조건이 필요하다.
- 현재 Codex 호스트가 읽은 전역 MCP 설정은 설치된 `/Applications/AgentsToZ_byCS.app`의
  이전 번들을 가리킨다. 새 target schema가 설치 앱 교체와 호스트 재시작 전에 현재 대화에
  hot reload된 것으로 간주하지 않는다.

### AI 작업 / Workroom

- AgentsToZ_byCS의 Codex Workroom은 정확한 프로젝트 cwd에서 시작했지만 `Hooks need review`
  신뢰 선택 화면에서 멈췄다. 사용자 대신 trust 결정을 내리거나 요청을 전송하지 않았다.
- `song-app`의 Codex Workroom도 정확한 cwd에서 시작했지만 CLI update 선택 화면에서 멈췄다.
  installer 실행이나 영구 skip 결정을 대신하지 않았다.
- 같은 `song-app`을 Claude Workroom으로 열고 초기 화면을 먼저 읽은 뒤, 파일 수정이나 명령
  실행 없이 현재 폴더 이름만 답하도록 한 요청을 정확히 한 번 보냈다. Claude는 도구 호출
  없이 `song-app`이라고 응답했다. 저장소에는 이미 사용자 변경이 있으므로 전체 status만으로
  이번 요청의 무변경을 역추론하지 않고 세션 출력의 무도구 응답을 증거로 삼는다.

### 남은 실제 사용자 게이트

- 네이티브 v476 창을 computer-use로 조작하려 했으나 Mac이 잠겨 자동 해제가 되지 않아
  화면 클릭 검증은 중단했다. 잠금 해제 전에는 OPS→Codex 성공 클릭이나 설치 앱 검증으로
  보고하지 않는다.
- VOC 3건은 설치 앱에서 사용자가 확인하기 전까지 open 상태를 유지한다. Telegram/AWS,
  물리적 다른 Mac, 실제 Internet SAS 원격 승인도 외부 환경을 갖춘 후속 실증이다.

## 2026-09-21 다른 Mac 소스·브라우저 검증

- GitHub 지정 브랜치 `claude/agentstoz-memory-profile-structure-8wuogh`의
  `200b1c4bbf4bbdc34e47b1e414fd898c660b229e`를 별도 clean worktree로 받아 검증했다.
  canonical 기억 Pull은 `alreadySynced`였고, 기존 main의 로컬 전용 이력은 변경하지 않았다.
- 첫 `quick`은 두 check 통과, 첫 전체 `verify`는 Bun **4,334 pass / 0 fail**,
  Rust **60 pass / 0 fail**, TypeScript·sidecar build 통과였다.
- 추가 `web` 프로필에서 Bun 1.3.14의 Vite 7.3.6 `listen()`이 의존성 최적화 뒤 반환되지 않아
  tester·Workroom·관제 검사가 fixture 시작 전에 timeout 됐다. 테스트 드라이버를 고정 의존성
  `tsx`/Node와 표준 child-process·HTTP API로 이식했다. 실제 테스트 내용과 격리 API 경계는
  바꾸지 않았고, 재실행에서 tester 27.203초·Workroom 180.496초·관제 15.195초·모바일
  35.054초·성능 21.035초로 모두 통과했다. 공식 run은
  `20260921T015935Z-10087b93`이다.
- 실제 App 회귀에서 runtime 패널의 공통 `flex: 1 !important`가 OPS 안내 카드 높이를 0에
  가깝게 줄여 뒤의 AI 작업 패널이 버튼 클릭을 가로챘다. `ops-runtime-summary`를 AI 작업
  패널과 같은 비축소 직계 자식으로 선언한 뒤 실제 포인터 클릭, 동일 OPS 프로필, 후보 검토,
  역할 필터, Codex/Orca/Workroom 전달 회귀가 통과했다.
- 취소 회귀는 자식 프로세스의 실제 종료를 계속 요구하되, 느린 Mac의 정상 process-group
  정리 시간을 자르지 않도록 helper 관찰 한도를 전체 테스트 제한 안의 10초로 맞췄다.
- 수정 뒤 최종 `verify` run `20260921T020427Z-e58dcc1e`: Bun **4,334 pass / 0 fail**
  (585 files), Rust **60 pass / 0 fail**, TypeScript·sidecar build 통과, source unchanged.
- 이 결과는 소스·격리 브라우저 증거다. Telegram/AWS, 실제 Internet SAS, 설치 앱 교체와
  VOC 3건 완료는 증명하지 않았으며 기존 후속 게이트를 유지한다.
