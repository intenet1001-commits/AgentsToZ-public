# AgentsToZ OPS 표면 패리티 — 착수 전 현황

작성일: 2026-09-20 · 상태: 현황 조사 완료 / 시작 Task 합의 대기.

이 문서는 사용자의 「운영(ops) 레이어 완성 지시 (최종본)」 §11의 첫 단계 결과다.
아래의 “있음”은 현재 소스의 경로·계약을 읽어 확인했다는 뜻이다. 실제 설치 앱,
다른 AI, Telegram/AWS, 다른 Mac에서 실행했다는 뜻이 아니다.

## 적용 기준과 조사 범위

- 기존 Control Profile을 모든 표면에서 열고·호출하고·저장할 수 있도록 연결한다.
  프로필/기억 통합을 새로 구현하거나 프로젝트 USE/DEV 라우팅 봇과 합치지 않는다.
- 사용자 표시만 `AgentsToZ OPS` / 운영으로 정리한다. `agentstoz_use_*`,
  `CONTROL_PROFILE_*`, `/api/control-profile/*`, `control-profile-*` testid는 유지한다.
- `AgentsToZ-Control`, `.agentstoz-control-profile.json`,
  `.agentstoz-private/control-bootstrap.json` 및 그 identity 필드는 보존한다.
- 호스트마다 자기 loopback sidecar를 사용한다. 호스트 간 기억은 같은 memoryId와
  기존 Control Git/Supabase 동기화, 원격 조작은 기존 LAN/relay만 사용한다.
- control-folder 저장은 후보 → 인증된 사람의 검토 → 저장/백업을 유지해야 한다.
  AI의 후보 생성과 승인 권한을 분리한다. app-data 로컬 프로필의 즉시 저장 허용은
  공유 control-folder 예외로 확장하지 않는다.
- B 이상 구현, 스킬 생성 구현, TUI 구현, 다중 프로필 추가는 이번 조사에서 착수하지 않는다.

읽은 정본: `docs/control-profile.md`,
`docs/plans/app-first-onboarding-2026-09-13/AGENTSTOZ-PROFILE-PLAN.md`,
동일 경로의 `CONTROL-BOOTSTRAP-PLAN.md`, `CLAUDE.md`의 tmux·AI 실행·Orca·원격제어·
세션 기억 절, 요청된 Control/MCP/원격 코드. 관련 프로젝트 기억은 canonical root의
`.agent-memory/CORE.md`와 DEV/USE 분리·테스터 정체성에 해당하는 노트만 읽었다.

## 작업 상태와 기존 작업과의 충돌

조사 대상은 `AgentsToZ_byCS`의 현재 작업트리다. HEAD는
`af7b2d7b3ebce09269ebf9c58a97e1d8feb79898` (`chore: bump to v474`), 현재 브랜치는
`main`이다. 기존 변경에는 tracked 파일 45개의 미커밋 수정과 신규 identity/handoff/
테스터 관련 소스·테스트·계획이 있다. 아래 현황은 이 미커밋 변경까지 포함한다.

요청 브랜치 `claude/agentstoz-memory-profile-structure-8wuogh`는 로컬/remote-tracking
목록에 없었고, origin에 대한 정확한 `git ls-remote --exit-code --heads` 조회도
결과 없이 exit 2였다. origin에서 해당 브랜치를 찾지 못했다는 뜻이며 Git 접근 실패로
판정하지 않는다. 코드 fetch/pull, 브랜치 전환, 커밋, push, PR 생성은 수행하지 않았다.
현재 실행 중인 하위 에이전트도 없었다.

| 이전 작업 | 새 지침과의 정합 / 처리 제안 |
|---|---|
| OPS/DEV 표시 라벨, 기존 ID 유지 | 방향 일치. Task A에 문구 변경만 선별 가능 |
| `.tdd-plans/agentstoz-ops-dev-identity-2026-09-14/PLAN.md:16`의 Phase C 폴더 이동·R08 | 이번 지침과 충돌. 이 작업의 실행/완료 조건에서 제외. 과거 계획과 증거는 삭제하지 않음 |
| `README.md:55`의 “최종 승인 마이그레이션 이름 AgentsToZ-OPS” | 최신 지침에 맞춰 Task A에서 안내 정정 필요 |
| `src/agentsToZIdentityCatalog.ts:9`의 Phase C 폴더 상수, `src/controlCenterProject.ts:50`의 새 이름 탐색 | 기존 WIP에 있음. 명칭만 정리하는 A에 migration 의도나 탐색 동작 변경을 함께 포함하지 않음 |
| 프로필 DTO의 role/display projection | `src/controlProfileContract.ts:17`, `src/controlProfileStore.ts:86`에 WIP로 있음. 등록 프로젝트의 `role: ops/dev/managed` 구현과 다름 |
| DEV_HANDOFF DB·MCP 3개·DEV 기억 후보·테스터 증거 | 이전 별도 작업. 새 표면 패리티 작업에 일괄 포함/완료 처리하지 않음. 기존 파일 보존 |

기존 WIP의 MCP 서버 버전은 `1.15.0 → 1.16.0`이며 DEV handoff 도구 3개가 추가됐다
(`agentstoz-use-mcp-server.ts:28,261`). 이번 조사에서 바꾼 것이 아니다. 설치된
런타임이 이 WIP 버전을 제공한다고 판정하지 않는다.

## 표면 패리티 매트릭스

| 표면 | 이미 있는 재사용 경로 (현재 파일:라인) | OPS 열기·호출·라벨의 현황 / 남은 갭 |
|---|---|---|
| 외부 AI 앱: Codex·Claude·Hermes | `agentstoz-use-mcp-server.ts:238,421` → `src/agentstozUseControl.ts:156` → `api-server.ts:16534,19539`; `code-app-links.ts` | 프로젝트 열기 있음. `portId` 필수이며 서버가 등록 프로젝트 경로를 해석함. 등록된 Control backend는 이 프로젝트 경로를 재사용할 수 있지만 OPS 전용 대상/버튼은 없음. projectId가 null인 app-data 프로필의 열기 경로도 없음. 기존 MCP는 Codex mode를 전달하나 bypass 필드는 제공하지 않음; 데스크톱의 기존 bypass 처리와 고지 규칙은 C에서 유지해야 함 |
| 대시보드 포그라운드 | `agentstoz-use-mcp-server.ts:232`; `api-server.ts:2728,16379`; `src/App.tsx:13605` | macOS 앱 포그라운드 경로 있음. 이 호출이 OPS 패널을 열도록 전달하는 상태는 없음. `control-profile-open` 클릭은 별도로 패널을 엶. 따라서 라벨 변경만으로 이 행은 완료되지 않음 |
| Workroom | `agentstoz-use-mcp-server.ts:377`; `api-server.ts:16390,16427`; `src/App.tsx:2557` | 등록 projectId 기반 start/list/read/send와 기존 세션 포커스 전달 있음. OPS 대상 선택·app-data 연결은 없음. 시작 후 출력 확인과 정확한 세션 ID 검증을 재사용해야 함. CLI tmux를 거치는 표면은 기존 `src/tmuxSessionName.ts` 규칙 유지 |
| Orca 플로팅/워크트리 내부 | `api-server.ts:20304`; `src/orcaFloatingTerminal.ts:89`; `src/App.tsx:5003`; `src/orcaWorktreeSupport.ts` | 프로젝트 Orca 실행 경로 있음. 실제 앵커는 `/api/open-orca-agent` 등이며 `/api/open-code-app`의 agent enum에는 Orca가 없음. OPS 전용 연결은 없음. floating/worktree 판정, 재사용, selector-not-found 폴백·안내를 기존 실행기로 전달해야 함 |
| Buzz 채널 | `agentstoz-use-mcp-server.ts:94,250`; `api-server.ts:16296,16511` | 등록 portId용 채널 연결·DEV 채널 조회·Buzz 포그라운드 있음. OPS 대상을 프로필로 연결하는 표면은 없음. 응답의 `exactChannelOpened:false` 유지; 채널 이름을 반환해도 정확한 채널을 열었다고 주장하지 않음 |
| Hermes/Telegram, AWS 포함 | `src/controlProfileConnections.ts:40,63`; `src/agentstozInvocationInstaller.ts:93,116,128`; `agentstoz-use-mcp-server.ts:439` | 기본/custom home와 기존 Hermes 프로필에 공통 skill/MCP 설정을 설치하는 코드 있음. 프로필 token으로 cwd와 독립 호출 가능. Telegram·AWS 실제 대화의 동일 memoryId 확인은 이번 조사에서 미실행. AWS도 그 호스트의 sidecar·Control 복원·Hermes 연결이 전제이며 새 원격 포트는 필요 없음 |
| 원격제어: 폰→Mac | `src/remoteControlCore.ts:102,117`; `src/remoteControlMobilePage.ts:516,968`; `src/RemoteControlProjectCard.tsx:4`; `src/mobileWorkspaceProtocol.ts:6` | 프로젝트 제어와 프로젝트 기억/Workroom 관리 경로 있음. OPS 대상 DTO, 운영 기억 조회·후보·승인 동작/라벨은 없음. 일반 프로젝트 memory.save를 OPS 승인으로 간주하면 안 됨. DTO/동작 확장 시 현재 v7에서 버전 상승 및 QR·포털 양쪽 동시 변경 필요 |
| 원격제어: Mac→Mac | `src/remote-control-portal-main.tsx:408,764,2383`; `src/remoteControlRelayController.ts` | 기존 웹 컨트롤러·호스트 선택·SAS 승인 UI 있음. Mac 브라우저에서 같은 경로를 사용할 수 있는 기반은 있으나 Mac→Mac 실증은 없음. 별도 네이티브 Mac 컨트롤러 UI와 OPS 조작 UI는 확인되지 않음. 네이티브 전용 UI를 요구하면 별도 범위로 확인하고 기존 transport 재사용 |
| 데스크톱 진입점 | `src/App.tsx:13605,14094,15064`; `src/ControlProfilePanel.tsx:31` | 도구·AI 작업 → 프로필 패널은 이미 있음. WIP로 첫 진입점/패널에 OPS 표시 반영. AI 작업의 “AgentsToZ · 나의 관제”, 일반 프로필 버튼/안내 문구 등은 아직 통일되지 않음 |

## 저장·권한·연결 계약의 확인 결과

1. **cwd 독립 회상은 기존 구현이다.** MCP의 get/recall/propose는 portId 입력 없이
   프로필 접속 키를 사용한다 (`agentstoz-use-mcp-server.ts:306,439`,
   `api-server.ts:16127,16162`). 기억 동기화·검색 상한·후보 중복 방지를 재사용한다.
2. **후보는 아직 저장이 아니다.** `ControlProfileStore.propose()`는 pending만 기록하고,
   `review()`가 문서 저장을 호출한다 (`src/controlProfileStore.ts:159,172`). MCP 응답도
   `saved:false`다. app-data도 현재는 동일한 후보/검토 경로이며 즉시 저장 분기는 없다.
3. **Task F의 사람 승인 경계는 미완성이다.** `/api/control-profile/review`는
   id/accept/expectedRevision을 검사한 뒤 바로 store.review를 호출한다
   (`api-server.ts:16025`). 이 경로에는 사람 승인 증명 또는 별도 관리 capability 검사가
   없다. 공통 Origin 검사는 Origin 없는 로컬 CLI 요청을 허용한다 (`api-server.ts:9459`).
   MCP에 승인 도구가 없다는 사실만으로 AI 자기승인을 차단했다고 판정할 수 없다.
4. **B/F는 기존 프로젝트 기억 쓰기 경로도 확인해야 한다.** Control backend는 등록된
   프로젝트일 수 있다. 일반 패널의 update/session-end와 호스트의 해당 경로에는 OPS
   대상 여부에 따른 승인 분리가 보이지 않는다 (`src/ProjectMemoryPanel.tsx:281,311`,
   `api-server.ts:17603,18371`). 공유 OPS가 일반 프로젝트 저장·자동 저장·Git 동작을 통해
   후보 검토를 우회하지 않는지도 검증 대상이다. 이번 조사에서 실제 쓰기는 하지 않았다.
5. **Task B의 등록 role은 없다.** 등록 어댑터는 id/name/folderPath/category를 저장한다
   (`api-server.ts:4286`). `src/ports-merge.ts:1`은 필드 보존형 일반 레코드이고 Rust
   PortInfo(`src-tauri/src/lib.rs:66`)에는 role이 없다. role 추가 시 TS/Rust 저장 왕복,
   sidecar/UI/원격 메타데이터의 하위호환 검토가 필요하다. 기존 포맷 강제 rewrite는 금지다.
6. **원격 버전은 현재 `agentstoz-local-v7`이다** (`src/remoteControlProtocol.ts:2`).
   `src/qrRemoteControlContract.ts:245,266`은 알 수 없는 카드 키를 거절한다. 기억 원문을
   프로젝트 목록 DTO에 임의로 넣지 않고, 승인된 세션의 기존 관리 요청 경로에 제한된
   조회/검토를 연결하는 계약을 E/F에서 먼저 확정해야 한다.
7. **호출 설치는 기존 v2이다.** 자연어 3개 별칭·Claude command·Hermes skill이 있다.
   `remember_agentstoz` 어댑터와 “아젠투지, 기억해” 전용 안내는 아직 없다.
   `addressedAgentsToZ`의 `@` 및 한글 앞 `/` 미지원은 선택 개선으로 남긴다.
8. **loopback와 private strip은 유지돼 있다.** MCP endpoint 검사
   (`agentstoz-use-mcp-server.ts:282`), 서버 bind (`api-server.ts:13952`),
   공개 배포의 `.agentstoz-private/` 제외 (`scripts/publish.ts:86`)를 확인했다.
   seed 원문이나 접속 키를 이번 보고서에 복사하지 않았다.

## 시작 Task 제안 — A만

합의 후 현재 main HEAD를 기반으로 **요청된 정확한 브랜치명**의 격리 작업트리를
만들어 기존 루트의 큰 미커밋 변경을 보존한다. 요청 브랜치가 그 사이 생겼으면
다시 확인해 그 브랜치를 사용하며 기존 원격 이력을 덮어쓰지 않는다.

Task A에 포함할 검토 가능한 최소 범위:

- `src/App.tsx`: 도구 진입점, AI 작업 진입점, 연결/복원 안내의 표시 문구 정리.
- `src/ControlProfilePanel.tsx`: 제목·운영 기억 라벨·AI 연결/후보 안내의 명칭 일관성.
- `docs/control-profile.md`, `README.md`: 사용자 표시 정책, 실제 Control 이름 유지,
  구 WIP의 폴더 이동 예고 정정. 기존 동작을 넘어서는 지원 완료 문구는 쓰지 않는다.
- 기존 UI 회귀를 보완해 진입 버튼 클릭 → 같은 `control-profile-panel` 열림,
  후보 저장 버튼 → 기존 review 요청 유지, 구 testid·API·ID·폴더 유지 여부를 확인한다.
  순수 라벨 작업에 role DTO/identity 해석기/새 handoff 도구를 함께 넣지 않는다.

이후 B → C → D → E → F는 각각 범위 합의와 독립 커밋으로 진행한다. 특히 대시보드의
OPS 패널 포커스 전달은 문구 변경보다 큰 동작이므로 C의 열기 패리티에 포함하도록
제안한다. 장기기억→스킬 설계 및 TUI는 사용자가 지정한 별도 게이트를 유지한다.

## 검증 상태와 다음 단계의 완료 기준

- 이번 결과: 문서·현재 소스·diff·로컬/원격 브랜치 조회. 구현/계약 변경 없음.
- 새 회귀 테스트, `bun run verify`, 실제 앱/AI/Telegram/AWS/Mac→Mac 시험은 미실행.
  pass/fail 결과를 생성하지 않았으며 과거 실행 기록을 현재 통과로 사용하지 않는다.
- 기존 재사용 테스트: `tests/control-profile-api.test.ts`, `tests/control-profile-store.test.ts`,
  `tests/control-profile-connections.test.ts`, `tests/agentstoz-invocation-installer.test.ts`,
  `tests/agentstoz-use-code-app-mode.test.ts`, `tests/onboarding-first-project-app-ui.mjs`,
  `tests/remote-control-mobile-page.test.ts`, `tests/qr-remote-control-contract.test.ts`.
- 현재 원격 라벨 누락 테스트는 문자열 존재 검사다
  (`tests/remote-control-mobile-page.test.ts:106`). E 완료에는 실제 두 UI 렌더링과
  요청/응답 계약 검증을 추가해야 한다. 소스 grep만으로 완료하지 않는다.
- 로컬 API `127.0.0.1:3001` 연결은 실패했다. 프로젝트 기억 Pull을 한 번 시도했지만
  가져오지 못했다. 이 보고서 작성으로 장기기억 저장·백업이 완료된 것은 아니다.
- 각 Task 커밋 전 `bun run verify`의 typecheck → Bun → Cargo 순서로 0 fail을 확인하고,
  필요한 UI/프로토콜 시험을 별도로 기록한다. GitHub 계정과 커밋 이메일 연결도 확인한다.
  push는 지정 브랜치만 허용하며 PR은 별도 명시 요청 전 생성하지 않는다.

합의 요청: **현재 main 기반 격리 작업트리에 지정 브랜치를 준비하고 Task A부터 진행할지**.
이 합의는 사용자 최종 지시 §11의 요구이며, 스킬에서 추가로 추론한 승인 단계가 아니다.
