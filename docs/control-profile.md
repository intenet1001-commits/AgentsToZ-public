# AgentsToZ OPS · 운영 프로필

AgentsToZ OPS는 이 OS 사용자의 여러 프로젝트에서 함께 쓰는 운영 기억을 제공합니다.
프로젝트 목록에 OPS 운영 폴더(`AgentsToZ-OPS`, 예전 이름 `AgentsToZ-Control`)가 없어도 도구 및 설정의
**AgentsToZ OPS · 운영 프로필** 또는 장기기억 화면의 **AgentsToZ OPS · 운영 기억 확인**에서 준비 상태를 볼 수 있습니다.

## 표시 이름과 호환 계약

사용자에게 보이는 운영 레이어 이름은 **AgentsToZ OPS**입니다. 기존 Control Profile과
같은 대상이며 별도 프로필이나 새 기억 시스템이 아닙니다. 운영 폴더와 GitHub 저장소의
이름은 **`AgentsToZ-OPS`**입니다(2026-09-29 `AgentsToZ-Control`에서 변경 — 아래 「폴더 이름 변경」).
`.agentstoz-control-profile.json`, `.agentstoz-private/control-bootstrap.json`의
`repositoryUrl`·`repositoryNodeId`, `profileId`·`memoryId`는 그대로 유지합니다.

설치된 AI 연결을 위해 `agentstoz_use_*`(`agentstoz_use_create_control_center` 포함), `CONTROL_PROFILE_*`,
`/api/control-profile/*`, `/api/control-center/create`, `X-AgentsToZ-Control-Profile` 헤더,
`AGENTSTOZ_CONTROLLER_PORT_ID` 환경 변수, `control-profile-*`·`control-center-*` testid도 유지합니다
(`tests/ops-folder-name.test.ts`가 지킵니다). OPS 운영 기억과 프로젝트별 USE/DEV 기억은
각각의 목적에 따라 분리하며 프로젝트 라우팅 봇의 USE/DEV 전환과 혼합하지 않습니다.

## 폴더 이름 변경 — `AgentsToZ-Control` → `AgentsToZ-OPS`

GitHub 저장소는 제자리에서 이름을 바꿨습니다(같은 node ID, 옛 URL은 새 URL로 넘어갑니다).
다른 Mac, Supabase 등록 행, 기억 리비전은 옛 이름을 언제든 들고 올 수 있으므로 **두 이름을 영구히
같은 OPS로 인식합니다.** 판정은 `src/opsFolderName.ts`의 `isOpsFolderName` 한 곳이고, 어떤 이름을
인정하는지는 `tests/fixtures/ops-folder-names-golden.json`이 고정합니다.

- **OPS는 하나다.** 첫 실행 화면(`/api/control-center/create`)과 MCP `create_control_center`는
  프로필에 연결된 프로젝트 → 등록 역할 `ops` → 두 폴더 이름 순으로 기존 OPS를 찾고, 있으면
  새로 만들지 않고 그것을 돌려줍니다(`effect: existing-control-center`). 새로 만들 때만 `AgentsToZ-OPS`와
  `.agents/rules/agentstoz-ops.md`를 씁니다. 옛 규칙 파일은 지우거나 바꾸지 않습니다.
- **앱 시작 때 옮긴다** (`src/opsFolderMigration.ts`의 `runOpsFolderBoot`, 프로필 준비 전에 실행).
  **설치된 앱의 사이드카(`IS_BUNDLED_API_SIDECAR`)에서만** 돈다 — 소스·워크트리 서버(`bun api-server.ts`,
  `API_PORT=… bun api-server.ts`)는 같은 앱 데이터를 쓰므로, 명시적으로 `AGENTSTOZ_OPS_FOLDER_MIGRATION=1`을 줄 때만 옮긴다.
  프로필 준비는 어느 서버에서든 매번 한다. 조건이 하나라도 안 맞으면
  이유 코드와 함께 건너뛰고 다음 시작에 다시 봅니다: 연결 상태 `ready` + `control-folder` + 폴더 이름이 옛 이름,
  폴더의 프로필 표식과 기억 ID가 연결과 같음, 그 프로젝트 ID의 등록 행이 정확히 하나이고 이 폴더를 가리킴,
  `<부모>/AgentsToZ-OPS` 없음, 연결 워크트리 없음, 이 앱 말고 그 폴더 안을 작업 폴더로 쓰는 프로세스 없음(`lsof`),
  작업공간 잠금 획득. 커밋 안 한 변경은 그대로 옮깁니다.
- **기다리는 이유는 「아젠투지 설정」에 보인다.** 매 시작의 결과를 `control-profile/ops-folder-rename-last.json`에 남기고
  (다음 시작이 덮어씀), 데스크톱 `GET /api/control-profile/status`가 `opsFolderMigration`(프로필 **옆**, 안이 아님)으로 싣습니다.
  패널은 기다림(폴더를 쓰는 프로세스 이름·PID 포함)·멈춤·미완료에만 한 줄을 보여 줍니다. 원격 `ops.status` DTO는 바꾸지 않습니다.
- 옮기는 순서와 기록: 이름 변경 전용 잠금(`ops-folder-rename.json.lock` — 새로 시작하든 저널에서 이어가든, origin 후속
  처리까지 모두 이 하나를 잡는다) → `control-profile/ops-folder-rename.json` 저널 + `ports.json`·`binding.json` 백업
  (`*.before-ops-folder-rename-<시각>`, 파일마다 가장 최근 시도 직전 것 **하나만** 남김) → 폴더 이름 변경 → 등록 행의 경로
  (이름이 옛 이름일 때만 이름, 역할이 없을 때만 `ops`) → 프로필 연결 이동(`binding.legacyRoots`에 옛 경로 보관,
  `schemaVersion`은 1 그대로) → Orca 플로팅 터미널·미처리 워크룸 기억 저장·채팅/채널 연결의 경로 → 저장소 키 고정(로컬만)
  → 신뢰 설정 → 저널 삭제 후 프로필 준비 → **그 다음에야** 이름이 바뀐 저장소 확인·origin 변경(네트워크).
  중간에 멈추면 다음 시작에 저널에서 이어갑니다. 저널의 경로 쌍은 `[옛 폴더, 새 폴더]`(+ 같은 폴더의 실제 경로 쌍)만
  인정하고, 그 밖이면 `JOURNAL_INVALID`로 멈춥니다. 두 폴더가 다 있거나, 둘 다 없거나, 새 폴더가 다른 프로필이면
  **아무것도 지우거나 합치지 않고** `needs-attention`으로 멈춥니다.
- `legacyRoots`는 연결이 폴더를 따라갈 **모든** 경로에서 남긴다 — 이동이 한 번 실패한 뒤 프로필 준비가 새 위치를
  다시 찾은 경우에도 옛 경로를 적고, 이미 새 위치에 있는 연결을 다시 옮기라는 요청은 옛 경로만 한 번 보탭니다.
- **기억 정체성 고정.** Supabase 기억 레지스트리는 `memory_id`(PK)와 저장소 키(UNIQUE)를 묶습니다. origin이 옛 URL인
  연결된 OPS 폴더는 **이름 변경 조건과 상관없이 매 시작** `git config --local agentstoz.repositoryKey`에 옛 저장소 키를
  고정합니다(현재 키와 같으므로 origin이 바뀌기 전까지는 아무것도 바꾸지 않음). 폴더가 사용 중이라 옮기지 못하는 동안
  누군가 origin을 바꿔도(git의 «저장소 이동» 안내, `gh repo rename`) 같은 계보를 계속 씁니다.
  `projectRepositoryKey`는 이 값이 정규 키일 때만 쓰고, 전역 설정 값은 무시합니다.
- **origin이 이미 새 URL인데 고정이 없으면 레지스트리가 정한다.** 기억 claim이 `portmgr_project_memories`를 먼저 봐서
  (claim RPC와 같은 service-role 클라이언트) 이 기억이 같은 소유자의 옛 키로 등록돼 있으면, 또는 레지스트리가 모르는 새
  clone이고 새 키로 등록된 계보가 없으며 옛 키 계보가 정확히 하나면 그 옛 키를 고정합니다. 다른 Mac에서 새 URL로 clone해도
  OPS 계보가 갈라지지 않습니다. 이 기억이 새 키로 등록돼 있으면(처음부터 `AgentsToZ-OPS`로 만든 OPS) 그 키를 고정해
  다음 claim부터는 레지스트리를 다시 묻지 않습니다. 가드된 자동 백업은 자기 기억의 키만 배우고 다른 계보를 채택하지 않습니다.
- **origin은 같은 저장소임을 증명할 때만 바꾼다.** 새 이름이 응답한다는 것은 증거가 아닙니다(사용자가 새 저장소를
  만들었을 수 있음). `gh repo view <옛 이름>`이 새 URL을 돌려주거나 두 이름의 node ID가 같을 때, gh가 답하지 못하면 두 URL의
  `git ls-remote` 목록이 비어 있지 않고 같을 때만 같은 형식(HTTPS/SSH)으로 바꿉니다. 다른 저장소면 origin을 두고
  `unverified`로 기록하고, 응답이 없으면 다음 시작에 다시 봅니다. 다른 remote는 건드리지 않습니다.
  Git은 묻지 않지만(`GIT_TERMINAL_PROMPT=0`), 사용자의 `GIT_SSH_COMMAND`·`GIT_SSH`·`core.sshCommand`(다중 계정)는 덮지 않고
  그런 설정이 없을 때만 `ssh -o BatchMode=yes`를 씁니다.
- **신뢰 설정은 덧붙이기만 한다.** 옛 경로가 신뢰돼 있던 경우에만 Codex `~/.codex/config.toml`에 새 경로 섹션을 덧붙이고
  Antigravity `~/.gemini/antigravity-cli/settings.json`의 `trustedWorkspaces`에 새 경로를 추가합니다. 새 경로가 이미 어떤
  형태로든(주석 달린 헤더, 점 표기 키, `[projects]` 인라인 표) 언급돼 있으면 덧붙이지 않습니다 — 같은 표를 두 번 쓰면
  Codex 설정 전체가 TOML 오류가 됩니다.
  Claude Code 설정(`~/.claude.json`)은 고치지 않으므로 새 경로에서 한 번 신뢰를 묻습니다.
- 알려진 한계: 경로 기준으로 저장된 Private GitHub 기억 보관 승인은 의도적으로 폴더 이동을 따라가지 않으므로
  옮긴 뒤 다시 켜야 합니다.

## 시작과 복원

- 새 공개 사용자: 첫 로컬 API/앱 실행에서 사용자 전용 앱 데이터에 프로필을 준비합니다. 프로젝트, GitHub, 작업 루트는 필요하지 않습니다.
- 기존 OPS 운영 폴더: 등록된 OPS 운영 폴더(`AgentsToZ-OPS` 또는 옮기기 전의 `AgentsToZ-Control`)의 실제 기억 ID와 내용을 유지합니다. 여러 후보가 있으면 화면에서 하나를 선택합니다.
- 다른 Mac에서 개인 byCS 업데이트: Private 소스에만 있는 복원 메타데이터로 기존 Private 저장소의 불변 ID를 확인하고, byCS 옆의 `AgentsToZ-OPS`로 복원합니다. 그 자리에 같은 저장소·같은 기억의 clone(`AgentsToZ-OPS` 또는 옛 `AgentsToZ-Control`)이 이미 있으면 다시 clone하지 않고 그것을 씁니다. origin은 seed URL, GitHub가 알려 준 새 URL, 또는 같은 node ID로 확인되는 URL이면 같은 저장소로 인정합니다. 기억 Pull이 완료되어야 연결 완료로 표시합니다.
- 공개 사용자가 자기 운영 폴더를 복원한 경우: 기존 GitHub 복원 흐름을 완료한 뒤 OPS 프로필 화면에서 등록된 운영 기억을 연결합니다. 이미 운영 기록이 쌓인 다른 프로필은 자동 교체하지 않습니다.

`git pull`은 실행 중인 앱 바이너리를 교체하지 않습니다. 소스를 Pull한 뒤 **최신 런타임을 실행**해야 합니다.
개인 복원 정보는 공개 snapshot에서 제외되며 토큰이나 Mac 절대경로를 포함하지 않습니다.

## AI에서 사용

프로필 화면에서 설치된 AI의 연결을 확인·준비하고 해당 AI의 MCP 도구를 새로고침합니다.
Codex와 agy는 CLI의 MCP 등록 명령, Claude Code는 사용자 MCP 설정, Hermes는 실제로 설정된
기본/custom home 및 개별 프로필에 연결합니다. 다른 모델·인증·MCP 설정을 교체하지 않습니다.
agy CLI 설정 확인은 Antigravity IDE에서의 실제 실행 확인과 구분합니다.

예: “아젠투지, 운영 기억을 확인하고 프로젝트 목록을 보여줘.”

자연어 호출 `아젠투지` / `에이전츠투지` / `agentstoz`가 네 AI의 공통 진입점입니다.
Claude command와 Hermes skill은 네이티브 슬래시를 사용할 수 있지만 Codex·agy의
슬래시는 인식되는 별칭이며 네이티브 슬래시 명령 등록을 뜻하지 않습니다.
프로필 조회·회상·후보 생성은 현재 폴더나 등록 프로젝트가 없어도 프로필 연결 키로
동작합니다. 프로젝트 대상 작업에는 명시적인 등록 프로젝트가 필요합니다.

공통 도구는 다음과 같습니다.

| 도구 | 결과 |
|---|---|
| `agentstoz_use_get_control_profile` | 현재 사용자 프로필, 기억 기준 revision, 갱신 시각과 동기화 상태 |
| `agentstoz_use_recall_control_context` | 질의와 관련된 운영 기억 최대 8개·16 KiB |
| `agentstoz_use_propose_control_memory` | 운영 기억 저장 후보. 실제 저장 완료가 아님 |

후보는 프로필 화면에서 내용·근거를 검토하고 저장합니다. 로컬 저장과 원격 백업 결과는 따로 표시합니다.
OPS 운영 기억과 구현 프로젝트의 장기기억은 분리됩니다. 작업이 필요하면 워크룸에서 프로젝트와 AI를 명시적으로 선택합니다.
이 기능은 지원 AI가 전달하는 음성/텍스트 요청을 받습니다. 항상 켜진 마이크나 모든 AI 서비스의 자동 도구 지원을 뜻하지 않습니다.

## OPS 열기 — 앱 · Workroom · Orca

OPS 패널의 **AgentsToZ OPS 열기**에서 실행 표면과 AI를 선택합니다. 기존 프로젝트
실행기를 사용하며 DEV로 대체하거나 새 운영 기억/프로젝트를 만들지 않습니다.

| 표면 | 기존 MCP 도구와 추가 선택 | 범위 |
|---|---|---|
| 대시보드 OPS 패널 | `agentstoz_use_open_dashboard` + `target: "ops"` | 등록 폴더가 없는 로컬 전용 프로필도 지원. 기존 navigation/focus 경로 재사용 |
| Codex·Claude·Hermes 앱 | `agentstoz_use_open_code_app` + `target: "ops"` | 기본은 기존 대화 열기. Codex 첫 연결은 명시적 `mode: "prepare"`만 |
| Workroom | 기존 start/list/read/send Workroom 도구 + `target: "ops"` | Codex·Claude·Hermes·agy. 시작/목록의 세션 ID로 초기 출력 확인 후 지시 |
| Orca | `agentstoz_use_open_code_app` + `target: "ops"`, `surface: "orca-floating"` 또는 `"orca-worktree"` | 네 AI. 기존 selector 실패 시 같은 폴더의 플로팅 전환·재사용 규칙 유지 |

`target: "ops"`와 `portId`를 함께 보내지 않습니다. 기존 `portId` 호출은 그대로이며
현재 cwd와 무관하게 로컬 프로필 토큰·기억 ID·등록 폴더를 재확인합니다. 표시 이름이나
등록 `role`만으로 실행 대상을 추측하지 않습니다. OPS Workroom 조회·지시는 정확한
바인딩의 메인 실행 대상에 한정하며 DEV/다른 프로젝트 세션을 선택하지 않습니다.

**현재 한계:** 등록된 `control-folder` 프로필에서 앱·Workroom·Orca를 지원합니다.
프로젝트가 없는 `app-data` 프로필은 패널·조회·회상·후보 접수는 되지만 이 세 실행 표면은
`CONTROL_PROFILE_SURFACE_UNAVAILABLE`로 차단합니다. 자동 등록/새 기억 생성으로
우회하지 않습니다. 기존 운영 폴더를 명시적으로 연결하거나 별도의 비등록 실행 대상
설계를 검토해야 합니다. 로컬 전용 OPS의 기억 조회·후보 접수 기능은 계속 사용할 수 있습니다.

권한 우회는 사용자가 요청했을 때만 전달합니다. Claude 앱은 기존 권한모드 계약을
따르고 Codex·Hermes 앱에는 외부 권한모드가 적용되지 않는다는 경고를 표시합니다.
Orca의 전환/화면 표시 경고도 숨기지 않습니다. Workroom이 시작된 뒤 앱 포그라운드만
실패하면 세션 영수증과 `openedWorkroom: false`를 함께 반환하며 재생성을 권하지 않습니다.
MCP의 동일 요청 ID 재전송은 기존 Workroom 멱등 실행 규칙을 따릅니다.

기존 도구명·API 경로는 유지합니다. 로컬 패널 어댑터 `POST /api/control-profile/open`만
추가했으며 프로필 키는 sidecar 안에서만 사용하고 브라우저/응답에는 보내지 않습니다.
MCP 서버 기능 버전은 `1.16.0`; MCP wire/원격제어 프로토콜·원격 DTO 변경은 없습니다.

## 저장과 재시작

### 로컬 등록 역할과 기억 화면

등록 행의 선택 필드 `role: 'ops' | 'dev' | 'managed'`는 탐색용 분류이며 권한이나
기억 ID가 아닙니다. 새 Control 등록은 `ops`, 대화로 새로 만든 일반 프로젝트는
`managed`를 기록합니다. 기존 행은 일괄 재작성하지 않습니다. 명시된 역할을 우선하고,
역할이 없으면 기존 Control/개발 프로젝트 해석을 재사용하며 나머지는 관리 프로젝트로
표시합니다. 실제 연결된 OPS의 `projectId`는 폴더 이름이나 역할 라벨보다 우선합니다.
연결 워크트리는 부모 역할을 따르며 별도 역할·기억을 만들지 않습니다.

사이드바의 역할 필터·배지와 프로젝트 기억 패널은 같은 분류를 사용합니다. OPS에서는
일반 프로젝트 DEV 기억 편집기를 열지 않고 기존 운영 프로필의 후보 검토 화면으로
연결합니다. 미지원 역할이나 프로필 정체성 조회 실패는 일반 기억 편집으로 자동
전환하지 않습니다. 다시 OPS 패널을 열어 연결을 확인하고 닫으면 상태를 재조회합니다.
개발/관리 프로젝트의 기존 기억 편집 흐름과 프로젝트별 USE/DEV 봇 구분은 유지됩니다.

구버전 화면이 `role`을 생략해 저장해도 Bun/Tauri 저장 merge가 디스크의 역할을
보존합니다. 역할을 일반 프로젝트로 바꿀 때는 `managed`를 명시하며 null로 지우지
않습니다. 새 미지원 값은 거부하고, 이미 저장된 미래 버전 값은 임의로 없애지 않습니다.
이 필드는 이번 단계에서 **로컬 전용**입니다. Supabase 등록 DTO·모바일 DTO·프로토콜은
변경하지 않으며 다른 Mac의 사용자 지정 역할 동기화를 구현했다고 주장하지 않습니다.

이 UI 분리는 공유 OPS 기억의 쓰기 권한을 보장하는 보안 장치가 아닙니다. 일반 기억
API의 우회 차단과 인증된 사람의 승인 증명은 Task F에서 별도로 검증해야 합니다.

### 기존 저장 정체성

- `control-profile/binding.json`: 고정 프로필/기억 ID와 이 사용자에 해당하는 로컬 위치.
- `control-profile/access.json`: 해당 OS 사용자만 읽는 로컬 MCP 연결 키. 응답 DTO나 공개 소스에 포함하지 않습니다.
- `control-profile/proposals.json`: 검토 후보와 처리 결과. request ID와 기억 revision으로 중복·충돌을 확인합니다.
- OPS 운영 폴더의 `.agentstoz-control-profile.json`: 토큰 없는 공유 정체성 표식. 폴더 이름이 바뀌어도 파일 이름은 그대로입니다.
- `control-profile/binding.json`의 `legacyRoots`: 폴더를 옮기기 전의 경로 목록(선택 필드, 최대 8개). 경로가 섞인 옛 기록을 대조할 때만 씁니다.
- `control-profile/ops-folder-rename.json`: 폴더 이름 변경이 진행 중일 때만 있는 저널. 남아 있으면 다음 시작에 이어갑니다.
- `control-profile/ops-folder-rename-last.json`: 마지막 시작의 이름 변경 결과(상태·이유·폴더를 쓰던 프로세스). 표시 전용입니다.
- 명시적인 Control 연결 전환은 기존 바인딩과 기억을 보존합니다. 기록된 전환을 재시작 후 이어가며 임의의 새 기억/키를 생성하지 않습니다.

원격 백업이 설정된 운영 기억은 시작·수동 연결 재확인·MCP 프로필 조회에서 기존 Pull/충돌 처리를 사용합니다.
MCP 조회에 따른 원격 대조는 60초 이내 재사용하고 동시에 들어온 요청은 하나로 처리합니다. 별도 AI 호출이나 상시 폴링은 없습니다.
오프라인/충돌에서는 마지막 로컬 기억을 유지하고 동기화 확인 필요를 표시합니다. 상태 조회만으로 기억 후보를 저장하지 않습니다.

각 호스트는 자기 loopback sidecar만 사용합니다. 기억 공유는 같은 memoryId와 기존
Control Git/Supabase 동기화로, 원격 조작은 기존 LAN/relay 승인 채널로 연결합니다.
OPS MCP를 네트워크에 직접 공개하지 않습니다. AWS의 Telegram 사용도 해당 호스트의
sidecar·Hermes 연결·Control 복원이 전제입니다.

명칭 정리만으로 모든 표면의 OPS 열기나 원격 승인 기능이 완성되는 것은 아닙니다.
등록 Control의 외부 앱·Workroom·Orca 연결은 위 범위까지 구현했습니다. Buzz 연결,
원격 표면, 공유 운영 기억의 인증된 사람 승인 강화는
[표면 패리티 실행 기록](plans/ops-surface-parity-2026-09-20/EXECUTION.md)의 후속 Task입니다.
후보 → 검토 → 저장 절차는 유지하며 AI의 자기승인을 허용하지 않습니다.

실제 앱 배포 서명, TestFlight 설치, 다른 물리 Mac, 네 AI의 모델 호출 결과는 각각 별도 검증 대상입니다.
구현 및 검증 기록은 [실행 기록](plans/app-first-onboarding-2026-09-13/CONTROL-PROFILE-EXECUTION.md)을 참조하세요.
