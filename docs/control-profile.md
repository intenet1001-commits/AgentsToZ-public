# AgentsToZ OPS · 운영 프로필

AgentsToZ OPS는 이 OS 사용자의 여러 프로젝트에서 함께 쓰는 운영 기억을 제공합니다.
프로젝트 목록에 OPS 운영 폴더(`AgentsToZ-OPS`, 예전 이름 `AgentsToZ-Control`)가 없어도 **도구 및 설정 → 아젠투지 설정**
또는 장기기억 화면의 **아젠투지 설정 열기**에서 준비 상태를 볼 수 있습니다(둘 다 같은 「아젠투지 설정」 패널을 엽니다).

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

이 문서의 프로필은 **아젠투지의 OPS 운영 맥락**이다. 사람의 선호는
[장기기억 → 내 프로필](user-profile.md)에서, 지시 원문은 「내가 한 말」에서 별도로 관리한다.
`profileId`나 운영 기억의 `memoryId`는 사람 계정의 식별자가 아니다.

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
| `agentstoz_use_get_control_profile` | 연결된 아젠투지 OPS 운영 프로필, 기억 기준 revision, 갱신 시각과 동기화 상태 |
| `agentstoz_use_recall_user_memory` | 등록 프로젝트 ID와 query로 그 프로젝트의 로컬 과거 지시 최대 5건·16 KiB 미만을 회상. 프로필 인증 필요, 과거 근거이며 현재 명령과 구분 |
| `agentstoz_use_list_user_memory_history` | 등록 프로젝트 ID와 기간 `[start,end)`로 이 기기의 과거 지시를 한 페이지씩 읽음(저장 순서, `nextCursor`로 이어 읽기). 프로필 인증 필요, 읽기 전용. 아래 「미처리 업무 조회」 |
| `agentstoz_use_recall_user_profile` | 이 기기에 직접 확인해 저장한 활성 개인 선호를 정확한 프로젝트와 질의 범위에서 최대 5개·8,000 bytes로 조회. 원문·OPS 기억과 별도이며 쓰기나 AI 추론은 하지 않음 |
| `agentstoz_use_recall_control_context` | 질의와 관련된 운영 기억 최대 8개·16 KiB |
| `agentstoz_use_propose_control_memory` | 운영 기억 저장 후보. 실제 저장 완료가 아님 |

후보는 「아젠투지 설정」에서 내용·근거를 검토하고 저장합니다. 로컬 저장과 원격 백업 결과는 따로 표시합니다.
후보 목록은 상태·지금 할 일 카드 아래에 있습니다. 긴 후보는 **전체 보기**로 확인한 뒤 저장합니다.
이미 저장된 운영 기억은 같은 패널의 **저장된 운영 기억 · N**을 펼쳐 읽기 전용으로 봅니다
(`GET /api/control-profile/entries` — 최근 순 제목 최대 200개, 펼친 항목 하나의 본문만 `?entryId=`로 최대 12,000자).
이 경로는 Mac 패널 전용이며 원격 `ops.status` DTO나 휴대폰 응답에는 들어가지 않습니다. 저장은 항목을 덧붙이기만 하므로
이 화면에 기존 항목을 고치는 경로는 없습니다.
OPS 운영 기억과 구현 프로젝트의 장기기억은 분리됩니다. 작업이 필요하면 워크룸에서 프로젝트와 AI를 명시적으로 선택합니다.
이 기능은 지원 AI가 전달하는 음성/텍스트 요청을 받습니다. 항상 켜진 마이크나 모든 AI 서비스의 자동 도구 지원을 뜻하지 않습니다.

### 운영 기억 동기화 확인 (지금 할 일)

동기화 상태가 `needs-attention`(로컬·원격 운영 기억이 다름, 또는 원격을 읽지 못함)이면 상태 카드의 동기화 줄이 경고색으로
보이고 **지금 할 일**에 「운영 기억 동기화 확인」이 들어갑니다. 이때 「기다리는 후보나 연결 확인이 없습니다.」는 나오지 않습니다.
「장기기억 현황 보기」는 장기기억 탭(기기별 기억 상태 현황판)으로 **이동만** 합니다. 패널은 Pull·Push·준비·검토 요청을
보내지 않고 어느 쪽도 덮어쓰지 않습니다. 다시 확인은 「아젠투지 준비·연결 다시 확인」입니다.
2026-10-28부터 **운영 기억 비교**가 별도로 열립니다(`ControlMemoryConflictPanel`). OPS는 여전히 DEV 기억 편집기를 열지 않습니다.
비교 버튼은 두 문서를 읽기만 하며 claim·별칭 추적·스키마 복구·Pull·Push·설정 쓰기를 실행하지 않습니다. 사람이 로컬·원격·직접 병합을
선택하고 확인한 뒤에만 기존 CAS 충돌 해결기가 두 버전을 검사해 적용합니다. 원격은 리비전으로 보존하고 로컬 교체 전에는 백업합니다.
화면에서 검토한 profileId·memoryId와 연결된 폴더를 서버가 다시 확인하며 요청에서 경로를 받지 않습니다. OPS 전용 해결은 identity claim과
schema repair를 생략하고 정확한 계보만 읽기 확인합니다. 별칭·연결·내용이 달라지면 다시 비교해야 합니다.
이 경로는 MCP·모바일에 노출되지 않습니다. 설치 앱은 전용 Tauri command `control_memory_conflict_request`와 기존 로컬 management capability를
사용하며 POST `/api/control-profile/memory-conflict`만 허용합니다. 각 원문 1MB 상한을 유지하고 JSON escape를 포함한 전송은 요청 6.1MB·응답 12.1MB로
제한합니다. 다른 management 경로의 4KB 한도는 바꾸지 않습니다. 적용 요청의 응답이 불명확하면 자동 재전송하지 않고 다시 비교합니다.
적용 뒤 「아젠투지 준비·연결 다시 확인」으로 동기화 상태를 갱신합니다. 실제 운영 기억을 AI가 임의로 선택해 해결하지 않습니다.

## 미처리 업무 조회 — 스킬 · 워크룸 버튼 · 기간 기록 도구

등록 프로젝트의 장기기억과 근거로 요청했지만 끝나지 않은 일을 **읽기 전용으로** 찾고, 그다음 사람이 고를 **개선 지시 초안**을
내는 흐름입니다(커밋 `9f3ffcc3b`, 2026-10-29 워크룸 밖 호출·이름 지정 프로젝트·개선 지시 단계 추가).

- **스킬 `agentstoz-unfinished-work`** (`src/unfinishedWorkSkill.ts`, 스킬 버전 2): 프로젝트 장기기억 색인·노트·회상, 「내가 한 말」 회상,
  기간 기록 도구를 차례로 쓰고 결과를 **미처리 / 상태 불확실 / 완료**로 나눕니다. 계획·검색 무응답·커밋·테스트·빌드·설치만으로
  완료로 보지 않고, 빈·잘린·실패한 조회를 「남은 일이 없다」의 근거로 쓰지 않습니다. 조회 단계에서는 작업 실행, 원문 가져오기,
  기억 쓰기, 수집 설정 변경, 메시지 전송을 하지 않습니다.
  - **설명(트리거 문구)**: AgentsToZ 등록 프로젝트(현재 또는 아젠투지데브처럼 이름으로 지정)의 미처리·미완료 업무/과제, 후속 작업,
    백로그, 장기기억 기반 진행 현황, 개선 지시와 unfinished/pending/outstanding work를 담습니다. 「남은 일」 같은 일상어는
    「장기기억에서 남은 일」처럼 묶어서만 넣었습니다 — 전역 스킬이라 AgentsToZ와 무관한 할 일 요청에서 무거운 기억 조회가
    시작되면 안 됩니다. 1,024자 이하이고 따옴표로 감싼 YAML입니다(Codex 검증 한도).
  - **0단계 — 대상 고르기**: 프로젝트 이름·별명을 말했거나 OPS·등록되지 않은 폴더에서 부르면 `agentstoz_use_get_control_profile` →
    `agentstoz_use_resolve_target`으로 정하고 **돌려받은 ID만** 씁니다. 모호하거나 후보가 여럿이거나 실패하면 묻고 기다립니다.
    현재 프로젝트가 아니면 폴더를 찾지 않고 `agentstoz_use_read_reference`(role `dev`, 그 ID를 `portId`로)를 짧은 질의 여러 개로 부르고
    같은 ID로 「내가 한 말」 회상·기간 기록 도구를 씁니다. 이 경로는 **제한된 조회**라고 밝힙니다 — 참조 질의당 발췌 5건, 날짜별
    작업 기록(journal) 제외, 「내가 한 말」은 이 기기에서 수집한 것만. 다른 기기에만 있는 프로젝트는 이렇게 읽을 수 없다고 말하고,
    사람이 명시적으로 요청할 때만 OPS 요청(`agentstoz_use_list_ops_devices` → `agentstoz_use_submit_ops_request`)으로 보냅니다.
  - **5단계 — 개선 지시**: 보고 뒤 미처리·상태 불확실 항목에 번호를 붙이고 항목마다 짧은 지시 초안(목표, 먼저 볼 근거, 완료 확인 방법)을
    냅니다. 사람이 고르기 전에는 아무것도 시작하지 않습니다. 고른 뒤 **같은 프로젝트**면 그 세션에서 이어 하고, **다른 프로젝트**면
    공통 실행 규칙대로 `agentstoz_use_prepare_agent_launch` → 질문하고 기다림 → 고른 AI·명시한 실행 위치로 워크룸 시작/목록 →
    첫 화면 읽기 → 고른 지시를 한 번 보냅니다. 돌려받은 requestId를 지키고, 결과가 불확실하면 같은 requestId로 확인할 뿐 자동으로
    다시 보내거나 새 ID로 보내지 않습니다. `self:true`인 세션(자기 자신)에는 지시·키 입력·닫기를 하지 않습니다.
- **설치**: 사이드카가 시작할 때 `src/agentstozInvocationInstaller.ts`가 Codex(`~/.codex/skills`), Claude(`~/.claude/skills`),
  Antigravity(`~/.gemini/skills`, agy가 만든 `~/.gemini/config/skills`가 있을 때만 그곳도), Hermes(설정된 각 home의 `skills`)에
  같은 본문을 둡니다. 관리 표식(`<!-- AgentsToZ agentstoz-unfinished-work skill -->`)이 있는 우리 파일만 갱신하고,
  남의 `SKILL.md`, 심볼릭 링크인 `SKILL.md`나 **폴더**, 폴더가 아닌 같은 이름, `SKILL.md` 없이 다른 파일이 든 폴더는 건드리지 않습니다.
  비어 있거나 우리 임시 파일만 남은 폴더(첫 쓰기가 중단된 경우)만 이어서 채웁니다.
- **워크룸 밖에서 부르는 길**(remember-session처럼 여러 경로):
  - **항상 켜진 한 줄 — invocation 10**: 전역 지침(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, agy의
    `~/.gemini/config/GEMINI.md`, Hermes `SOUL.md`)과 `/agentstoz` 스킬·명령의 AgentsToZ 블록에 「등록 프로젝트(현재 또는 이름 지정)의
    미처리·미완료 업무 → 이 스킬, Claude `/agentstoz-unfinished-work`, Codex `$agentstoz-unfinished-work`」 줄이 들어갑니다.
    ⚠️ **Claude Code는 사용자 스킬이 많으면(이 Mac 약 1,000개) 설명 없이 이름만 나열**하므로 스킬 설명이 닿지 않습니다 —
    Claude에서는 이 줄과 명시 명령이 실제 트리거입니다. Codex·agy·Hermes는 스킬 설명도 봅니다.
  - **명시 호출**: Claude `/agentstoz-unfinished-work`, Codex `$agentstoz-unfinished-work`, Hermes CLI `/agentstoz-unfinished-work`
    (Hermes는 `<HERMES_HOME>/skills`의 스킬을 frontmatter 이름으로 슬래시 명령에 등록합니다 — 설치된 hermes-agent 소스로 확인,
    실기 미확인). 워크룸 명령 모음(`src/workroomCliCommands.ts`)에도 같은 항목이 있습니다. Claude 목록에서는 `/agents` 뒤에 둡니다 —
    입력한 접두어에서 Enter는 첫 후보를 실행하므로 `/agent`는 계속 `/agents`입니다.
    agy에는 그런 명령이 없습니다. Hermes Telegram 메뉴에는 등록하지 않았습니다(메뉴 플러그인 변경은 장기기억 버전 상승이 필요해 보류).
  - **절대 되돌리지 않음**: 관리 블록과 `/agentstoz` 스킬·명령은 `invocation-version`, 이 스킬은 `skill-version` 표식을 갖고, 설치기는 **자기보다
    높은 버전이 적힌 사본을 그대로 둡니다**(같거나 낮거나 표식 없는 사본만 교체). 다만 invocation 10 이전 빌드(v1549 이하 설치본·백업 번들·
    옛 체크아웃의 dev api-server)에는 이 검사가 없어 시작할 때 한 번 옛 내용으로 되돌립니다 — 확인은 새 설치본으로, 옛 dev 서버 없이 합니다.
  - **다시 시작**: `CLAUDE.md`·`AGENTS.md`와 MCP 도구 목록은 세션 시작 때 읽으므로 설치 뒤 새 세션(ChatGPT Codex 앱은 새 스레드)에서 확인합니다.
- **워크룸 버튼 「미처리 업무 조회」** (`data-testid="workroom-unfinished-work"`, 문구 `src/workroomUnfinishedWorkCopy.ts`):
  실행 중인 프로젝트 세션에만 보이고 OPS 세션에는 숨깁니다(OPS에서는 명령 모음이나 「아젠투지데브 미완료 업무」처럼 이름을 말해 0단계로 갑니다).
  누르면 그 세션의 입력칸에 스킬 사용 요청을 **채우기만** 하고 보내지 않습니다. 작성 중인 글·첨부·참조가 있으면 바꾸지 않고 그대로 둔다고 알립니다. 휴대폰 원격 워크룸에도 같은 버튼이 있고
  역시 보내지 않습니다(`tests/workroom-popout.e2e.mjs`).
- **기간 기록 도구 `agentstoz_use_list_user_memory_history`** (`src/userMemoryHistoryServer.ts`):
  - **이 기기에서 수집한** 그 프로젝트의 과거 지시만 읽습니다. 다른 기기의 기록이나 수집 완전성을 증명하지 않습니다
    (`coverage.deviceScope: local-device`, `historical: unknown`).
  - 저장 순서(최신 저장 먼저)로 읽습니다. 타임스탬프 순서가 아니므로 기간 밖 행이 섞이고, 빈 페이지 뒤에도 `nextCursor`로 이어 읽습니다.
    `complete: true`는 저장소 끝까지 읽었고 마지막 수집 검사가 완전했으며 잘린 본문이 없을 때만입니다.
  - 한 페이지는 저장된 행 50개를 읽고, 기간 안 결과는 직렬화 기준 14,000 bytes까지 싣습니다(결과 하나는 2,800 bytes·본문 2,048 bytes 이내).
    예산이 차면 마지막으로 실은 행에서 페이지를 끝내고 커서가 바로 다음 행부터 이어 읽으므로 건너뛰는 행이 없습니다.
    행 위치(seq)를 주지 않는 목록에서 예산이 차면 그 자리에서 이어 읽을 수 없으므로, 남은 행을 조용히 넘기지 않고
    `state: unavailable`로 답합니다(그 기간은 검색하지 못한 것으로 보고). 현재 로컬 목록은 항상 seq를 줍니다.
    예전에는 페이지가 5행이라 스킬의 첫 순회(10페이지·15초)가 최신 50행만 봤습니다.
  - 커서는 프로젝트 기억 ID·기간·위치를 HMAC으로 묶은 값이고 **호스트가 다시 시작하면 무효**입니다. 다른 프로젝트·기간에는 쓰지 못합니다.
  - `agentstoz_use_recall_user_memory`의 최대 5건은 의도된 경계입니다(문자열 포함 검색 한 번의 크기 상한 · `complete`로 더 있음을 알림).
    기간 전체를 훑을 때는 이 기록 도구를 씁니다.
- **설치 앱 반영**: 스킬은 이 커밋을 포함한 앱의 사이드카가 시작할 때 깔리고, MCP 도구 목록은 CLI 세션 시작 때 고정되므로
  새 도구를 쓰려면 그 뒤 세션을 다시 시작해야 합니다.

## OPS 열기 — 앱 · Workroom · Orca

「아젠투지 설정」의 상태 카드에서 현재 선택으로 바로 열 수 있습니다. **열기 방식 바꾸기**를 누르면 실행 표면과 AI 선택이 펼쳐집니다. 기존 프로젝트
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
