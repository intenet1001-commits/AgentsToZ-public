# MCP 런처 · 채널 연동 · OPS 폴더 · 워크룸 오케스트레이션

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## MCP 명령은 앱 번들을 직접 가리키지 않는다 — 고정 런처 (2026-10-06)

네 AI 설정에 적히던 `agentstoz_use` 명령은 **앱 번들 안**(`…/AgentsToZ_byCS.app/Contents/Resources/
resources/agentstoz-use-mcp`)이었다. 그런데 앱 업데이트는 그 번들을 **통째로 지웠다 복사한다**(DMG를
끌어다 놓는 보통의 설치도 같다). 그 창에 시작한 CLI 세션은 서버를 **아예 띄우지 못하고**, 그 세션이
끝날 때까지 `agentstoz_use` 도구가 **하나도 없는 채로** 돈다.

실측(2026-10-06): 맥의 Codex 세션이 13:33에 「스킬은 `agentstoz_use_create_project`를 쓰라는데 그 도구를
사용할 수 없다」고 보고했고, 그때 설치된 앱 바이너리의 mtime 이 **13:34**였다. 같은 시각 직접 핸드셰이크한
서버는 정상이었다(v1.28.0, 도구 55개, `create_project` 포함) — 즉 서버가 아니라 **그 세션의 기동**이 깨졌다.

- 설정에는 이제 **`~/.agentstoz/bin/agentstoz-use-mcp`** 를 적는다(`src/agentsToZUseMcpLauncher.ts`).
  런처는 실행 시점에 ① `AGENTSTOZ_USE_MCP_PATH` ② 앱이 적어 둔 번들 경로 ③ 개발 소스 순으로 찾고,
  **없으면 최대 20초(0.5초×40) 기다렸다가** 실행한다 — 기다리는 쪽이 「도구 없음」보다 언제나 낫다.
  인자와 stdio 는 그대로 넘기고 권한은 늘리지 않는다.
- ⚠️ **두 설치기가 같은 답을 써야 한다.** OPS 프로필 연결과 Buzz 부트스트랩이 서로 다른 명령을 기대하면
  상대가 쓴 항목을 「충돌」로 판정해 사용자에게 고치라고 한다(이 저장소가 이미 한 번 겪었다). 판정은
  `agentsToZUseMcpConfiguredCommand` 한 곳 — 런처가 있으면 런처, 없으면 번들.
- **우리가 적은 옛 모양은 충돌이 아니라 `outdated`** 다. 조용히 런처로 다시 적는다. 남이 만든 연결
  (`npx`, 다른 실행 파일)은 **여전히 충돌**로 보고하고 손대지 않는다.
- Windows 는 셸 런처를 쓰지 않는다(번들 경로 그대로).
- ⚠️ 셸 스크립트를 만들 때 **따옴표를 `파라미터 확장`의 기본값 안에 넣지 말 것** — 리터럴이 되어 경로가
  깨진다(실측). 기본값은 따로 대입한다. 템플릿 리터럴 안의 주석에 `${…}` 를 쓰면 TS 가 보간한다.
- 검증: `tests/agentstoz-use-mcp-launcher.test.ts`(실제 셸로 실행·인자·종료 코드 전달, **바이너리가 늦게
  생겨도 기다렸다 실행**, 따옴표 있는 경로), `tests/agentstoz-use-codex-mcp-entry.test.ts`(옛 모양 = outdated,
  남의 연결 = conflict, 두 설치기의 기대값 일치).
- ⚠️ **고치는 코드가 있어도 그것을 돌리는 경로가 없으면 없는 것이다 (2026-10-06, 같은 날 재발).**
  위 런처를 넣었는데도 다음 날 워크룸의 AI가 「현재 작업에 AgentsToZ 연결 도구가 제공되지 않습니다」라고
  답했다. 실측: `~/.agentstoz/bin/agentstoz-use-mcp`가 **아예 없었고** codex·claude 설정 모두 여전히 번들
  경로였다. 다시 적는 코드는 **사용자가 앱에서 「연결」을 누를 때만**(`POST /api/control-profile/connections`)
  돌았고, 그 화면은 「연결돼 있습니다」로 보이니 누를 이유가 없었다. 이제 **시작할 때 스스로 맞춘다**
  (`AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC=1`로 끌 수 있다) — Hermes 어댑터 자동 맞춤과 같은 이유다.
  바꾸는 것은 `upgradable`(우리가 적은 옛 모양)뿐이고 남의 연결은 그대로 둔다.
- ⚠️ **자동 보정은 루프가 되지 않아야 한다.** 올린 뒤에도 `upgradable`이면 부팅마다 사용자의 AI 설정을
  덮어쓴다. `compatible()`은 `command`·`args`·`disabled`만 보고 **`env`는 보지 않으므로**, OPS 설치기가
  적은 `AGENTSTOZ_CONTROLLER_PORT_ID` 고정이 남아 있어도 다시 쓰지 않는다(두 설치기가 번갈아 쓰지 않는다).
  실측으로 확인했다: 네 AI 모두 보정 뒤 `upgradable:false`. 회귀는
  `tests/control-profile-connections.test.ts`의 두 테스트가 잡는다.
- ⚠️ **실행 중인 CLI 세션은 보정해도 도구가 생기지 않는다** — MCP 도구 목록은 **세션 시작 때 고정**된다.
  설정을 고친 뒤에는 그 워크룸/CLI를 **다시 시작**해야 한다. 이것을 안내하지 않으면 「고쳤다는데 그대로」가 된다.

## 채널 연동 상태 — 설정은 연결이 아니다

「도구 및 설정 → 채널 연동 상태」(`btn-channel-health`)가 AI별 `agentstoz_use` MCP와 Hermes 프로필별
텔레그램 봇을 **다섯 상태**로 보여준다: 연결됨·확인됨 / 설정됨·아직 확인 안 됨 / 설정됨·응답 없음 /
설치 안 됨 / 확인할 수 없음. 판정은 `src/channelHealth.ts`의 `classifyChannelHealth` 한 곳이다.

- **설정 파일에 항목이 있다는 것은 「설정됨」까지다.** 「연결됨·확인됨」은 30분 안에 성공한 프로브만
  준다. `GET /api/channels/health`는 설정·게이트웨이 상태 파일·`ps`만 읽는다(읽기 전용).
  `POST /api/channels/health/probe`만 MCP를 실제로 띄우고, **읽기 전용 `agentstoz_use_list_projects` 하나만**
  부른다(`src/channelHealthProbe.ts`). 등록된 명령이 이 앱의 실행 파일과 같을 때만 돌리고(남의 설정에 적힌
  명령을 실행하지 않는다), 중립 cwd `/`에서 띄운 뒤 자기 자식만 끝낸다. 결과는 메모리에만 있어 재시작하면
  「아직 확인 안 됨」으로 돌아간다 — 그게 맞다.
- **AI가 띄운 MCP 프로세스는 절대 죽이지 않는다.** 실행 파일이 교체된 뒤에도 살아 있는 프로세스
  (`replaced-after-start`)나 다른 위치의 사본(`other-executable`)은 안내 문구로만 보여준다.
- MCP `serverInfo.version`은 `1.20.0+build.<build-number.json>`이다(`src/agentstozUseMcpVersion.ts`).
  예전 고정값 `1.20.0`으로는 옛 빌드의 프로세스가 현재 것과 구분되지 않았다. 도구 계약을 바꾸면
  `AGENTSTOZ_USE_MCP_CONTRACT_VERSION`을 올린다.
- **텔레그램 「연결됨」은 게이트웨이 PID가 살아 있을 때만이다.** `gateway_state.json`은 게이트웨이가
  죽어도 `connected`를 남기므로 `effectiveTelegramState`가 `gateway-stopped`로 낮춘다. 토큰 판정은
  `envDeclaresTelegramBotToken`(`src/hermesTelegramStatus.ts`) — `/api/hermes/profiles`의 인라인 정규식이
  이중 이스케이프(`/^\\s*TELEGRAM…/`)라 **모든 프로필이 `telegramConfigured:false`였다.**
- **Codex `agentstoz_use` 항목은 한 모양이다**(`src/agentstozUseCodexMcpEntry.ts`). OPS 프로필 설치기와
  Buzz 부트스트랩 설치기가 같은 argv 빌더와 같은 판정을 쓴다. `AGENTSTOZ_CONTROLLER_PORT_ID` env 고정은
  선택이다 — API가 읽을 수 있는 프로필 토큰을 먼저 인가하기 때문이다. 부트스트랩은 고정 없는 항목을
  프로필을 읽을 수 있을 때만 준비됨으로 본다. 예전에는 한쪽이 쓴 항목을 다른 쪽이 「충돌」로 판정했다.

## OPS 운영 폴더 이름 — `AgentsToZ-OPS` (예전 `AgentsToZ-Control`)

폴더와 GitHub 저장소 이름을 `AgentsToZ-OPS`로 바꿨다(저장소는 제자리 rename, 같은 node ID). 전체 계약은
`docs/control-profile.md`의 「폴더 이름 변경」이 정본이다.

- ⚠️ **이름 판정은 `isOpsFolderName`(`src/opsFolderName.ts`) 한 곳만 쓴다.** 다른 Mac·Supabase 행·기억 리비전이
  옛 이름을 영구히 들고 오므로 리터럴 `'agentstoz-control'` 비교를 다시 쓰지 말 것. 인정 범위는
  `tests/fixtures/ops-folder-names-golden.json`이 고정한다.
- 앱 시작 때 `src/opsFolderMigration.ts`(`runOpsFolderBoot`)가 조건이 다 맞을 때만 폴더를 옮긴다(프로필 준비 전).
  ⚠️ **설치된 앱의 사이드카에서만 돈다** — `bun api-server.ts`(스모크 절차)나 워크트리의 `API_PORT=…` 서버는 실제 앱 데이터를
  쓰므로 `AGENTSTOZ_OPS_FOLDER_MIGRATION=1` 없이는 옮기지 않는다(프로필 준비는 한다). 테스트 서버에서는 아예 안 돈다.
  조건이 안 맞으면 이유 코드로 건너뛰고 다음 시작에 다시 본다. 두 폴더가 다 있으면 **지우거나 합치지 않고** 멈춘다.
  기다리는 이유(폴더를 쓰는 프로세스 포함)는 「아젠투지 설정」에 한 줄로 보인다(`opsFolderMigration`, 원격 DTO는 그대로).
- ⚠️ **`git config --local agentstoz.repositoryKey`로 옛 저장소 키를 고정한다 — origin이 옛 URL이면 이름 변경 조건과
  상관없이 매 시작.** 기억 레지스트리가 `memory_id`(PK) ↔ 저장소 키(UNIQUE)라서, 고정 없이 origin만 바뀌면 push·claim이
  전부 충돌한다. origin이 **이미** 새 URL인데 고정이 없으면 claim이 레지스트리(`portmgr_project_memories`)에서 등록된 옛 키를
  찾아 고정한다 — 다른 Mac의 새 URL clone도 같은 계보에 붙는다.
- ⚠️ **복원 seed는 폴더 이름으로 고르지 않는다**(2026-10-05, 2호 실측). `control-profile-server.ts`의 `seed()`가
  디스크 basename이 `/^AgentsToZ_(?:byCS|public)$/i`인 등록 폴더만 봐서, 다른 이름으로 clone한 앱 소스
  (`AgentsToZ_byCS-win`, 워크트리 등)는 `.agentstoz-private/control-bootstrap.json`을 찾지 못하고 **조용히 새
  profileId**를 받았다 — 그 Mac은 자기만의 운영 프로필과 커뮤니티 방을 들고 고아가 된다(실측: 프로필
  `8f712828…`, 방 `1c9015e5…`, 메시지 0건. 2026-10-05에 그 다섯 행을 지웠고 정상 프로필 `51c574e8…`은
  endpoint 140개·커뮤니티 3대·메시지 9건으로 그대로다). 지금은 **내용**이 신뢰 경계다 —
  `isAgentsToZControlProject`가 package.json `name === "AgentsToZ_byCS"` + `api-server.ts` + `src/App.tsx`를
  함께 확인하므로 등록된 아무 폴더의 seed를 읽는 일은 없다. seed가 둘 이상이고 profileId가 다르면
  `CONTROL_PROFILE_SEED_AMBIGUOUS`로 멈추고 **새 프로필을 만들지 않는다**(그 판정이 이름 제한의 역할을 대신한다).
  `tests/control-profile-restore.test.ts`가 다른 이름의 clone·내용 검사 실패 폴더·모호한 두 seed를 함께 본다.
- origin은 **같은 저장소로 증명될 때만**(gh: 옛 이름 → 새 URL, 또는 같은 node ID / gh 없으면 두 URL의 `ls-remote`가 같음)
  프로필 준비 **뒤에** 바꾼다. 사용자의 `core.sshCommand`·`GIT_SSH_COMMAND`는 덮지 않는다.
- ⚠️ **이름 변경은 포트 자동 업로드의 「충돌」이 아니다**(2026-10-02). 충돌 판정(`findPortUploadMetadataConflicts`)은 기준값 없이
  양쪽 값을 비교하므로, 이 Mac의 마이그레이션이 바꾼 이름·폴더·GitHub 주소가 원격의 옛 값과 달라 **140개 전체의 자동 업로드가
  몇 주 멈춰** 있었다(휴대폰 「프로젝트」 탭이 9/12 스냅샷). 원격=옛 OPS 이름, 로컬=새 이름인 경우만 같은 값으로 보고 로컬을
  올린다(`sameAfterOpsRename`). 반대 방향(아직 옮기지 않은 기기가 옛 이름을 올리는 것)은 여전히 검토 대상이다.
  `normalizeOpsGithubUrl`은 `githubUrl`과 `githubUrls` **둘 다** 옮긴다 — 하나만 옮기던 동안 행이 두 값을 함께 들고 있었다.
  자동 업로드가 멈추면 프로젝트 헤더에 「자동 업로드 중단 · 확인」이 보인다(`ports-auto-upload-alert`).
- 바꾸지 않는 것: `.agentstoz-control-profile.json`, 복원 seed, `X-AgentsToZ-Control-Profile`, `AGENTSTOZ_CONTROLLER_PORT_ID`,
  `agentstoz_use_create_control_center`, `/api/control-profile/*`, `/api/control-center/create`, `CONTROL_PROFILE_*`, testid.
  `tests/ops-folder-name.test.ts`가 지킨다.
## 워크룸 오케스트레이션(agentstoz_use) — 어떤 AI든 어떤 AI의 워크룸이든 몬다

OPS 워크룸을 agy로 열었어도 거기서 Claude·Codex·Hermes 워크룸을 시작하고 몰 수 있다 — 도구는 모델을 가리지 않는다.
권장 순서는 **start → wait → read(view=tail) → send → wait → read → close**이고, 막힌 신뢰·승인·로그인 화면은
`send_workroom_keys`로 답한다. 계약 1.21.0(`AGENTSTOZ_USE_MCP_CONTRACT_VERSION`)에서 도구 3개와 옵션이 추가됐고,
1.22.0에서 `open_dashboard`의 `portId`·호출자 `self:true`·재시도 장부가 더해졌다(아래).

- **자연어 AI 실행은 선택부터 준비한다**(2026-10-25): `agentstoz_use_prepare_agent_launch`는 AI → 실행 위치 → Hermes 구성 순으로 **미정인 값만** 묻는 비실행 도구다.
  Codex·Claude·Hermes·agy 중 무엇인지, 워크룸/앱/외부 터미널 중 어디인지, Hermes라면 기본/Claude/Codex 중 무엇인지 구분한다. 「Claude」만 지정했다고 앱이나 워크룸으로 추정하지 않는다.
  도구가 반환한 `selectionRequired`의 question/choices는 연결 클라이언트가 사람에게 질문한다. 답 전에는 start/open/create_team을 호출하지 않는다.
  모두 정해진 prepare도 `performed:false`이며 설치·인증·실행 확인이 아니다. `executionRoutes`는 현재 가능한 MCP 실행 경로를 나타낸다.
  cmux·일반 터미널 등 팀 생성 경로만 있는 위치에서 단일 실행을 요청하면 그 제한과 대안을 묻고, 단일 요청을 팀으로 자동 대체하지 않는다.
  사용자가 말한 값, 실제 버튼 선택, 유효한 팀 selection block은 재질문 없이 보존한다. 현재 AI·저장 기본값·이전 start/open 도구 이름을 사람의 표면 선택 증거로 만들지 않는다.
  자율 선택은 사람이 명시적으로 위임한 범위에만 허용한다. MCP start/open은 선택한 `surface`를 명시해야 하며 워크룸도 `internal`을 보낸다. 도구 이름만으로 위치를 채우지 않는다.
  agent/surface 누락, create_team의 members/멤버 agent 누락, 새 팀원의 surface/Hermes 구성 누락은 실행 대신 선택을 요구한다. 잘못된 타입·모르는 agent는 기존처럼 거절한다.
  Hermes 기본과 Hermes · Claude/Codex는 서로 다르다. 현재 model/provider 고정 변형은 **워크룸만** 지원하므로 외부/app 조합은 불가 이유와 대안을 알리고 선택을 기다린다.
  단일 Workroom start는 `hermesVariant: default|claude|codex`를 명시해 host의 기존 preset에 매핑한다. default는 현재 CLI 설정을 따르며, 다른 변형 세션을 재사용하거나 같은 requestId의 모델 결속을 바꾸지 않는다.
  Hermes open_code_app은 `hermesVariant: default`만 허용해 현재 앱/CLI 설정을 유지한다. Claude/Codex 고정 변형을 받을 수 있다고 안내하거나 워크룸으로 자동 대체하지 않는다.
  기존 선택을 버리거나 워크룸으로 자동 전환하지 않는다. 원문은 `agentstozMcpAgentChoice.ts`의 공통 지침, `agentstozInvocationInstaller.ts`의 invocation 9,
  `agentstozMention.ts`의 mentions 2, `agentstozTeamSkill.ts`이며 홈 생성물을 직접 고치지 않는다.
- ⚠️ **Claude Code는 MCP instructions를 약 2,000자에서 자른다**(2026-09-29 실측: 설치본이 2,095자 근처에서 잘림).
  오케스트레이션 핵심은 `agentstoz-use-mcp-server.ts`의 `WORKROOM_ORCHESTRATION_BRIEF`에 모아 호출 규칙 바로 뒤에 둔다 —
  문장을 뒤에 덧붙이면 Claude Code 오케스트레이터에게는 도달하지 않는다. `tests/workroom-orchestration-guards.test.ts`가
  핵심 문구가 2,000자 안에서 끝나는지 본다.
- **「<프로젝트> 열어」는 앱에서 그 프로젝트를 보여 주기만 한다.** `open_dashboard`에 `portId`(target과 배타)를 주면
  `focusAgentsToZUseProject`가 등록 프로젝트를 확인하고 내비게이션 `{nonce, projectId}`를 건 뒤 앱을 앞으로 가져온다
  (실패하면 이전 내비게이션으로 되돌린다). OPS 음성의 `open_project`도 같은 함수다. 앱은
  `src/agentstozUseNavigation.ts`로 **보일 때 2초마다** 폴링한다 — 이미 포커스된 앱에는 focus 이벤트가 오지 않아
  폴링 없이는 요청을 놓쳤다. 「담당자 불러」는 여전히 `start_workroom_session(reuse:true)`/`connect_project_delegate`다.
- **호출한 AI 자신의 워크룸은 `self:true`**다(`src/workroomCaller.ts`). MCP 서버가 자기 프로세스 조상(pid·pgid, 최대 6단계,
  `ps`)과 `AGENTSTOZ_WORKROOM_SESSION_ID`/`_TARGET_ID`(워크룸 시작 때 CLI env에 넣는다)를 헤더로 보내고, 호스트가
  세션 CLI pid(프로세스 그룹 리더)와 대조한다. Codex는 MCP env를 걸러서 **pid 대조가 주 경로**다. 쓰임은 reuse에서 제외,
  목록 표시, 자기 세션에 대한 send·keys·close 거절(`AGENTSTOZ_USE_WORKROOM_SELF_TARGET`)뿐이고 **권한 판단에 쓰지 않는다.**
  예전에는 agy OPS가 `reuse:true`로 agy를 부르면 자기 입력창에 지시를 쳤고 close로 자기를 죽일 수 있었다.
- **장기기억은 Buzz만 요구한다.** 워크룸 도구·`open_code_app`·`project_status`는 `resolveRegisteredUseProject`,
  `open_buzz_dev`만 `buzzProjectFrom`을 거친다(등록 프로젝트의 절반이 기억 없이 막혀 있었다). OPS는 여전히
  `resolveOpsSurfaceProject`가 묶인 memoryId와 대조해 fail-closed다.
- **읽기 기본값은 `view=tail`**(after 생략 시): 최근 출력을 **버려지는 headless 터미널에 다시 그려서**
  (`src/terminalPlainText.ts`) 평문 8,000바이트까지 준다. 이스케이프를 정규식으로 지우면 TUI가 다시 그린
  프레임이 몇 번이고 겹쳐 보여 읽을 수 없다. `view=screen`은 현재 화면 행, cursor(`after`)를 주면 예전 raw `stream`이다.
- **`lastOutputAt`·tail·screen·입력 모드는 호스트 전용**이다(`AiTerminalService.inspectSession`/`outputTail`/
  `screenText`/`inputModes`). 원격 요약(`AiTerminalSummary`)에 필드를 더하지 말 것 — 휴대폰 정규화기가
  모르는 키를 통째로 거부한다.
- **여러 줄 지시는 한 번의 bracketed paste**다. CLI가 DECSET 2004를 켰을 때만, ESC가 없는 여러 줄 본문을
  `ESC[200~…ESC[201~`(줄바꿈은 터미널처럼 `\r`)로 감싸고 Enter를 따로 보낸다. 판정은 `AiTerminalService`
  입력 경로 한 곳이라 워크룸 UI·음성·MCP가 같이 쓴다. 한 글자 입력은 화면을 기다리지 않는다.
- **정확히 한 번**: `reuse=true`는 같은 AI의 실행 중 세션을 돌려주고(200, `reused:true`), 지시는 파생 입력 ID로
  한 번만 친다. 이미 쓴 start requestId는 reuse여도 그 start를 재생한다. 키는 키마다 파생 ID + 80ms 간격이고
  화살표는 CLI의 cursor-key 모드(DECCKM)를 따른다. 허용 키 밖(`ctrl-d`, 임의 문자열)은 양쪽에서 거절한다.
- ⚠️ **재시도는 첫 시도의 선택을 따른다 — 세션 집합으로 다시 고르지 말 것.** 파생 ID는 고른 세션에 매이고 세션이
  끝나면 잊히므로, 예전에는 같은 requestId 하나가 A에 치고, 새 세션 B가 생기자 B에 치고, 둘 다 닫히자 C를 새로 열어
  **세 번 전달**됐다(리뷰 재현). 이제 호스트 장부(`src/workroomRequestLedger.ts`, 4,096개·24시간)가 requestId →
  {세션, 지문}을 await 전에 잡아 두고 재시도는 그 세션에만 재생한다. 그 세션이 끝났으면
  `AGENTSTOZ_USE_WORKROOM_REUSE_OUTCOME_UNKNOWN`(409)이고 새 세션을 열지 않는다. 같은 ID에 다른 요청은
  `AGENTSTOZ_USE_WORKROOM_REQUEST_ID_CONFLICT`다. 키도 같은 장부로 **키 이름**을 지문으로 삼고 첫 바이트를 재생한다
  (그 사이 DECCKM이 바뀌어도 「다른 입력」 오류가 나지 않는다).
- **`send_workroom_instruction`도 장부에 적는다(`agentsToZUseSendLedger`, 2026-10-15).** 지시는 이제 호스트 전용
  전체 요청 제출(`src/agentstozUseWorkroomInstruction.ts`)로 가고 제출 id가 requestId+세션에서 파생되므로, 장부 없이는
  같은 requestId로 **다른 세션**을 고른 재시도나 start의 requestId를 쓴 지시가 새 제출로 한 번 더 입력됐다. 지금은
  requestId → {세션, 지시}를 await 전에 잡고, 다르면(또는 start·reuse가 쓴 ID면) `…_REQUEST_ID_CONFLICT`다(반대 방향도).
  쓰기 전에 거절된 지시는 `AGENTSTOZ_USE_WORKROOM_INSTRUCTION_NOT_SENT`(409) — 그 파생 요청 ID가 같은 거절을 계속
  돌려주므로 **새 requestId**로 보내라고 말한다. 지시는 받은 그대로 입력한다(`skipCorrections`) — 작성칸 제출에 붙는
  교정 문맥을 다른 AI의 지시·슬래시 명령 뒤에 붙이면 인자가 바뀌고, 교정 기록을 못 읽었다고 거절하지도 않는다.
- **권한을 올리는 입력은 막는다.** `shift-tab`은 허용 키에서 뺐다(Claude Code에서 권한 모드 순환). `!`로 시작하는
  instruction은 양쪽에서 `AGENTSTOZ_USE_WORKROOM_INSTRUCTION_SHELL_PREFIX`로 거절한다(Claude·Gemini 계열 셸 모드).
  `/`는 허용하되 설명에 「그 CLI의 슬래시 명령」이라고 적는다.
- **옛 AgentsToZ와 새 MCP 서버**: 앱은 떠 있는 사이드카를 채택하므로 새 옵션을 모르는 호스트가 조용히 무시할 수 있다.
  MCP 서버는 instruction(`delivered`)·reuse(`reused` boolean)·foreground·view·portId(`projectId`+`focusRequested`)의
  에코가 없으면 `AGENTSTOZ_USE_HOST_OUTDATED`로 실패시키고 호스트 결과를 `hostResult`에 싣는다.
- **wait의 조용함은 max(마지막 출력, wait 시작)부터 센다** — 지시 직후 wait가 CLI 반응 전에 끝나지 않게.
  **마감은 요청 도착 시각부터** 세고 렌더 여유(최대 1초, 짧은 wait는 1/4)를 뺀다(`workroomWaitBudgetMs`) — 앞단의
  프로필·기억·인벤토리 확인이 느려도 MCP 클라이언트(timeoutMs+5초, 최대 55초, Bun `idleTimeout` 90초 안쪽)보다 먼저 답한다.
- **잘린 세션도 답한다.** 세션이 24개를 넘으면 종료된 것부터 목록에서 빠지는데, 그 뒤의 read·wait는 404/500 대신
  `exited`와 마지막 출력(최근 48,000자, 최대 32개)을 준다(`AiTerminalService.retiredSession`). tail 창이 이스케이프
  중간에서 시작하면(청크는 1,024자마다 잘린다) 커서 읽기는 앞 청크의 미완 시퀀스를 붙여 고치고, 잘린 창은 첫 LF/ESC까지 버린다.
- `close_workroom_session`은 기본 `memoryPolicy:'skip'`이다. `saveMemory:true`만 일반 세션 종료 저장을 태운다.
- 검증: `tests/agentstoz-use-nested-orchestration.test.ts`(가짜 CLI 안에서 실제 MCP 서버를 stdio로 띄워
  4×4=16쌍을 몰고 닫는다), `tests/agentstoz-use-workroom-orchestration-api.test.ts`, `tests/workroom-orchestration.test.ts`,
  `tests/agentstoz-use-workroom-retry.test.ts`(재시도·키 재생·wait 마감·잘린 세션), `tests/agentstoz-use-workroom-caller.test.ts`
  (OPS agy가 같은 OPS의 agy를 몰 때 자기 세션 보호), `tests/agentstoz-use-open-project.test.ts`, `tests/voice-open-project.test.ts`,
  `tests/ai-terminal-tail-retired.test.ts`, `tests/workroom-orchestration-guards.test.ts`. `bun test` 밖의 served-surface 검사:
  `./node_modules/.bin/vite build --outDir <dir> && bun tests/agentstoz-use-open-project.e2e.mjs <dir>`(격리 빌드 + 합성 API —
  이미 포커스된 앱이 focus 이벤트 없이 프로젝트를 고르고, 같은 요청은 한 번만 따른다).

## 팀 작전(workroom-team) — 어느 AI든 리더, 팀원은 각자 워크트리 (2026-10-25)

한 작업을 여러 AI(Codex·Claude·Hermes·agy)에 나눠 맡기고 리더가 취합한다. 로컬 MCP에 연결된 AI가 같은 팀 엔진을 호출하며,
호출자 워크룸이 확인되면 그 세션을 리더로 결속한다. UI 입구는 둘: 워크룸 입력창 머리의 「팀 작전」(`WorkroomTeamBuilder`, Mac만)과 업무 스레드 새 작업의
「팀 작전」(그 스레드의 「작업 AI」가 리더). 둘 다 **지시문을 입력칸에 채우기만** 하고 보내지 않는다. 지시문 머리
`[AgentsToZ 팀 작전 · 리더]`와 `agentstoz-team` 스킬(`src/agentstozTeamSkill.ts`, 네 AI 전역 설치 — invocation 9)이 순서를 준다.

- **호스트가 맡는 것만 호스트에**(`src/workroomTeam.ts` 장부·규칙, `src/workroomTeamHost.ts` Git·PTY): 같은 기준 커밋 — **리더 워크룸이 같은 저장소의
  연결 워크트리에서 돌면 그 체크아웃의 HEAD**(예전처럼 주 HEAD로 잡으면 리더가 자기 브랜치에 커밋한 것을 팀원이 못 봤다), 아니면 주 체크아웃 HEAD.
  미커밋 검사도 그 기준 체크아웃에서 한다. 다른 저장소(OPS 등)의 리더는 무시하고 주 HEAD.
  ⚠️ **기준 체크아웃은 「병합했는가」의 기준이기도 하다**(1.55.0, 2026-10-25): `read_team`의 `git.merged`와 `close_team`의 `git branch -d`를
  주 체크아웃 HEAD로 판정하면, 연결 워크트리에서 일하는 리더가 **자기 체크아웃에 제대로 병합한 뒤에도** `merged:false`·`kept-unmerged`를 받아
  팀 브랜치가 계속 쌓였다(실측: 주 체크아웃에서 `merge-base --is-ancestor`=no, `git branch -d`=「not fully merged」). 두 질문 모두
  `TeamGitScope{primaryPath, baseCheckout}`를 받아 **기준 체크아웃에서** 묻는다(그 워크트리가 사라졌으면 주 체크아웃으로 폴백).
  워크트리 추가·제거는 그대로 주 체크아웃에서 한다.
  기본 팀원 워크트리는 `<주 워크트리>/worktrees/team-<6hex>-<이름>` + 브랜치 `team/<6hex>/<이름>`이다. `orca-worktree`는 아래 「팀 실행 위치·영수증」의
  Orca 관리 체크아웃 경로·브랜치를 기록한다. 내부 팀원은 호스트가 쓴 지시문으로 워크룸을 시작하고, 외부 팀원은 선택한 실행 위치를 유지한다.
  **병합은 리더가 셸로** 한다(충돌 해결은 AI가 버튼보다 낫다). 아무것도 push하지 않는다.
- **기본 도구**: `create_team`(1–6명, 팀원별 지원 옵션은 아래 공통 계약) · `read_team`(teamId 또는 portId 최근 10개) ·
  `wait_team`(until any/all, **`afterCursor`에는 마지막 응답의 `settledCursor`**를 그대로 전달한다. 다른 조회자가 같은 settled 수를
  받아도 내 커서가 이동하지 않으며, 앱 재시작 전 커서는 현재 뷰를 즉시 반환해 새 기준을 준다. 기존 `afterSettled`는 호환용이며
  여러 조회자의 같은 count를 구별하지 못한다. 둘 다 빼면 「지금부터」 기다린다) · `report_team_task`(팀원 전용) · `close_team`. 모두 action `workroom-team` 하나로
  간다(`team.op`). `team_member`(read/send/reveal)·`confirm_team_member`도 같은 엔진을 쓴다. 로컬 MCP 전용(`Origin`이 있으면 403).
  옛 앱은 이 action을 모른다 → MCP 서버가 `AGENTSTOZ_USE_HOST_OUTDATED`로 바꾼다.
- **정확히 한 번**: create requestId → 장부(`workroom-teams.v1.json`, 앱 데이터, 0600·원자적 쓰기, 닫힌 팀부터 40개 유지)가 같은 팀을
  재생하고 팀원을 다시 시작하지 않는다. 다른 요청에 같은 ID는 409. 팀은 **부작용 전에** 기록되고, 팀원마다 **체크아웃 생성 직후·시작 전에**
  워크트리 경로와 `targetId`가 한 번 더 기록된다(1.55.0) — 그 사이에 죽으면 디스크에는 워크트리가 있는데 장부에는 `targetId:null`만 남아
  정리가 그것을 `missing`으로 보고 영구히 남겼다(PTY는 `detached`라 팀원 CLI까지 살아남을 수 있다). 시작 실패한 팀원은 `failed`로 남고
  자동 재시도하지 않는다. 자리를 만들려고 **버린 닫힌 팀의 requestId는 묘비**(`retiredRequestIds`, 400개)로 남아 재시도가 두 번째 팀을
  만들지 못하게 `WORKROOM_TEAM_REQUEST_ID_RETIRED`로 거절된다(옛 빌드는 `teams`만 읽어 이 키를 무시한다).
- **커밋 안 된 추적 변경이 있으면 거절**(`WORKROOM_TEAM_SOURCE_DIRTY`) — 팀원이 리더의 미커밋 코드를 못 보는데도 본다고 착각하게
  하지 않는다. 미추적 파일은 허용하고 개수만 알린다(`untracked`). `worktrees/`·`.claude/worktrees/`는 변경으로 세지 않는다.
- **팀원 상태는 볼 수 있는 것만 말한다**(1.55.0): `starting`·`working` 외에 `exited`(워크룸이 보고 없이 끝났다)와
  `unknown`(앱 재시작 등으로 **현재 실행을 관측할 수 없음** — 브랜치·워크트리로 확인할 것)이 있다. 예전에는 세션이 사라져도 `working`으로
  남아 있고 `wait(until:'all')`이 「전원 완료」를 즉시 돌려줘, 아무도 보고하지 않았는데 끝난 것처럼 보였다. 둘 다 settled로 센다.
  (팀 상태 패널을 그리는 쪽은 이 두 값을 함께 다룬다.)
- **보고는 장부 직렬화 뒤에 서지 않는다**(1.55.0): `report`는 읽기~쓰기 사이에 `await`가 없어 원자적이므로 `#serial` 밖에 둔다. 예전에는
  팀원 6명을 띄우는 `create`(최대 180초) 뒤에 큐에 서서, 먼저 끝난 팀원의 보고가 MCP 기본 20초 타임아웃에 끊기면서 호스트는 나중에 반영하는
  미확정 변경이 됐다. 보고 쪽 MCP 타임아웃도 60초로 둔다.
- **보고 권한은 힌트 기반**: 호출자 워크룸(`workroomCaller.ts`)이 **다른 팀원 세션**이면 `WORKROOM_TEAM_REPORT_DENIED`, 팀원 세션이
  `close_team`을 부르면 `WORKROOM_TEAM_CLOSE_DENIED`. 호출자를 모르면(외부 CLI) 허용 — 권한 판단이 아니라 실수 방지다.
  생성 시 실제 리더의 target이 주어지면 장부의 선택 필드 `leader.targetId`로 보존한다. 리더의 「다시 시작」도 그 target의 검증된
  `resumeFrom` 계보에서만 현재 sessionId로 갱신하며 팀 화면·팀원 조회/지시·수동 확인/보고가 이어진다. target 근거가 없는 옛 장부나
  앱 재시작 뒤 임의로 연 세션을 리더로 바꾸지 않는다. 이 추적은 기존 caller 힌트의 거절 경계를 유지하며 새 실행 권한을 부여하지 않는다.
- **내부 팀원 정리는 잃지 않는다**: 실행 중 팀원 워크룸 종료 → 깨끗한 워크트리만 `git worktree remove`(no `--force`, 잠금 아래) →
  `git branch -d`(**기준 체크아웃** HEAD에 병합된 것만). 미커밋 워크트리는 `kept-dirty`(그 브랜치도 유지), 미병합 브랜치는 `kept-unmerged`.
  정리는 **장부가 기억하는 것이 아니라 워크트리 실존**을 따른다(1.55.0): `targetId`가 없어도 `worktreePath`로 제거를 시도하고,
  장부에 기록된 세션과 검증된 `resumeFrom` 계보만 끝낸다. `sessionId`가 없거나, 같은 작업 폴더에 다른 실행 중 워크룸이 있으면
  그 세션·폴더·브랜치를 보존하고 팀을 `active`로 남긴다. 사람이 그 워크룸을 닫은 뒤 다시 정리한다. 같은 target만으로 팀 소유라 추정하지 않는다.
  계보는 프로세스 내에서만 유지하며 앱 재시작 뒤 임의로 다시 연 세션을 팀원에 결속하지 않는다.
  내부 `team_member read`의 출력 cursor는 세션에 결속된다. 받은 문자열을 그대로 다음 조회에 돌려주면 검증된 재개 계보에서만
  새 세션의 출력 처음부터 읽는다. 다른 세션의 cursor는 거절하며, 구형 숫자 cursor는 현재 세션 안에서만 셈한다.
  팀원별로 **예외를 가둔다**: 한 명의 `worktree remove` 실패(잠금·`index.lock`)가 나머지 정리를 취소하고 500으로 끝나던 것을 멈추고,
  그 팀원만 `worktree:'kept-error'`·`branch:'kept-error'`·`error`로 보고한 뒤 **팀은 `active`로 남겨** 다시 정리할 수 있게 한다.
  ⚠️ **호스트가 복사해 넣은 설정은 팀원의 작업이 아니다**(2026-10-24, 실제 에이전트 실측): `seedWorktreeLocalConfig`가 `.claude/`와
  루트 `.env*`를 새 워크트리에 복사하는데, 프로젝트가 그것을 무시하지 않으면 `?? .claude/`로 보여 **모든 팀원이 `kept-dirty`** 가 됐다.
  `removeWorktree`는 미추적 항목이 **전부** 그 복사 대상(`SEEDED`)이고 주 체크아웃과 **바이트 단위로 같을 때만**(`sameAsPrimary`,
  심볼릭 링크·새 파일·고친 파일이면 다름) 그것을 지우고 일반 `worktree remove`를 한다. 하나라도 다르면 통째로 `kept-dirty`.
- **내부 워크룸 모델 지정**(`aiTerminalLaunchArgs.ts` `launchModelArgs`): Claude `--model`, Codex `-m`, Hermes `chat -m`(+`--provider`), agy `--model`.
  호스트 전용 옵션(`perform(..., {launchModel})`)이라 원격 요청으로는 못 준다. 「다시 시작」은 같은 모델을 유지한다. Codex 에포트는
  **앱이 고른 `-m` 모델을 카탈로그로 증명한다**(`codexEffortModel({launchModel})` — config의 `model`은 그때 보지 않고, 공급자·프로필·
  카탈로그·base URL 검사는 그대로). 카탈로그 밖 모델은 증명 불가 → 에포트 플래그 없음. 사람이 친 다른 `-m` 실행 인자는 여전히 증명 불가다.
- **내부 워크룸 팀원 에포트**(2026-10-25 사용자 결정: 「세부모델을 선택할수있어야하고, 에포트도 선택할수있어야하고, 팀원들의 에포트 자동변경적용이
  디폴트이고 필요시 특정에포트 고정」): `effort` 없음 = **자동** — 이 Mac의 에포트 자동이 **팀원 자기 작업(task)** 으로 정한다. 팀원 지시문
  전체(brief)로 판정하면 공통 규칙에 든 「충돌」·「보안」 같은 말 때문에 모든 팀원이 high가 됐다(`launchEffort:{requestText}`).
  `low`/`medium`/`high` = **고정**(`launchEffort:{pinned}`): 이 Mac의 자동 설정이 꺼짐·권고만이어도 적용하고(사람이 명시한 선택), 실행 중 자동
  조정(`#adjustEffort`)·advice·「다시 시작」 재판정이 손대지 않는다(`previous.pinned`로 이어짐). xhigh/max는 받지 않는다(자동 상한과 같은 이유).
  agy는 에포트가 모델 이름에 있어 `effort`를 거절한다. `pinned`는 **호스트 전용** — 기록(`workroomEffortRecord`)에서 빼고, 화면은 「tier 없는
  level」을 「에포트 고정 · 높음」으로 읽는다(휴대폰 정규화기가 모르는 키를 거절하므로 키를 더하지 않았다). `launchEffort`는 이 Mac의 새 시작에만
  (원격·`resumeFrom`·제한 실행·기록 재개면 거절).
- **구성기**(`WorkroomTeamBuilder`): 팀원마다 AI · 모델 목록(`TEAM_MODEL_CHOICES` — 설치된 CLI에서 읽은 2026-10-25 목록, 맨 앞 「기본 모델」,
  맨 뒤 「직접 입력…」이 이름·Hermes provider 칸을 연다) · 에포트(「에포트 자동」 기본, 「고정 · 낮음/보통/높음」, agy는 「모델에 포함」 비활성).
  AI를 바꾸면 그 AI의 기본값으로 돌아간다. 좁은 구성기(컨테이너 420px 이하)는 에포트를 AI 아래 줄로 내린다 — 한 줄에 셋을 두면 WebKit이
  모델 목록을 2px로 줄였다(실측).
- **검토 담당**(1.56.0, 2026-10-25 — 사용자 요청 「바보도 쉽게 엄청난 기능을」): `create_team` 팀원의 `role:"reviewer"`(없으면 작업 팀원).
  검토 담당은 **읽기 전용**이다 — 호스트가 쓰는 지시문(`reviewerBrief`)이 파일 수정·커밋·병합·push를 금하고, 작업 팀원이 있으면
  `wait_team(afterCursor)`로 그 보고를 기다려 브랜치마다 `git log/diff <기준>...<브랜치>`로 읽게 한다(「보고는 증거가 아니다」 — 검사를 직접
  돌려 볼 때만 `git checkout --detach`, 끝나면 기준으로 돌아온다). 작업 팀원이 없으면 그 task가 정한 범위를 기준 커밋의 기록에서 읽는다.
  결과는 `report_team_task` 한 번(심각도 순 발견 사항·위치·근거·돌린 검사). 작업 팀원의 지시문에는 「검토 담당(m2)이 이 브랜치를 읽습니다」가
  붙고, 리더 지시문은 3단계에 role 넣는 법을, 5단계에 「검토 담당의 보고를 받은 뒤 병합」을 더한다. 역할은 요청의 일부라 재시도 지문에 든다.
  ⚠️ 읽기 전용은 **지시로 지키는 규칙**이다 — 워크트리는 다른 팀원과 같다(호스트가 쓰기를 막지 않는다). 정리 규칙도 같아서, 검토 담당이 실수로
  커밋했으면 `kept-unmerged`로 남는다. 구성기는 팀원 줄마다 「작업/검토」 선택과 **빠른 구성** 세 단추(나눠서 구현 · 구현 + 검토 · 교차 검토 —
  리더가 아닌 AI들로 채우고 작업은 비운다)를 둔다. 팀 현황은 검토 담당 이름 옆에 「검토」 꼬리표를 붙인다.
- **열린 세션 합류**(1.57.0 · 가드 보강 1.59.0, 2026-10-25 — 로드맵 ④): `create_team` 팀원의 `sessionId` = 이 Mac에서 이미 열린 워크룸. 새 워크트리·워크룸 없이
  호스트가 그 세션에 팀원 지시문을 **한 번** 입력한다(`instruct` = `submitHostInstruction`, 영수증 네임스페이스 `workroom-team`, 요청 ID
  `team-<teamId>-<memberId>`). `written`이 아니면 그 팀원은 `failed` + 「다시 입력하지 않습니다」 — 미확정 결과는 자동 재전송하지 않는다(절대 규칙).
  같은 create의 재시도는 장부를 재생할 뿐 다시 입력하지 않는다. **부작용 전에 전부 검사**(`attachable`, 실패는 `WORKROOM_TEAM_ATTACH_REFUSED`
  409 — 팀도 워크트리도 남지 않는다): 이 Mac에서 실행 중, agent 일치, 리더 자신 아님, **다른 진행 중 팀의 팀원 아님**(1.59.0 — 상태와
  무관하다. `blocked`는 그 리더의 답을 기다리는 중이고 `reported`도 아직 그 팀 것이니, 거절 메시지가 먼저 close할 팀 ID를 말한다),
  **같은 저장소**(그 세션 체크아웃의 주 워크트리 = 팀의 주 워크트리), 작업 팀원이면 **자기 연결 워크트리**(주 체크아웃·리더 체크아웃이면
  검토 담당만 — 그곳에 커밋하면 리더의 브랜치가 된다)이고 브랜치 위(detached 아님).
  ⚠️ 판정 기준은 **그 세션의 체크아웃 루트**(`rev-parse --show-toplevel`)다 — 등록 폴더가 아니다(1.59.0). 저장소 하위 폴더로 등록된
  프로젝트의 세션은 등록 폴더만 비교하면 「자기 워크트리」로 보여, 작업 팀원이 리더가 병합할 브랜치(main 등)에 직접 커밋할 수 있었다.
  `attachable`의 `cwd`도 그 루트이고, 팀원의 `worktreePath`·지시문도 루트를 가리킨다.
  ⚠️ **체크아웃 하나에 작업 팀원 하나**(1.59.0): 같은 워크트리의 세션 둘(워크룸 「새 작업」이 한 대상에 두 번째 세션을 연다)이 모두
  작업 팀원이 되면 한 작업 트리·한 브랜치에 두 AI가 커밋한다. 작업 팀원이 끼면 거절하고(검토 담당끼리는 같은 체크아웃을 공유해도 된다),
  팀원 둘이 같은 브랜치(또는 기준 브랜치)에 앉는 구성도 거절한다.
  ⚠️ **리더 워크룸에서만**(1.59.0): 호스트가 어느 워크룸이 리더인지 확인하지 못한 create(호출자 hint 없음)는 `sessionId` 합류를 거절한다 —
  그렇지 않으면 「리더 자신 아님」이 아무것도 막지 못해 리더가 자기 세션에 지시문을 넣을 수 있다. 새 워크룸만으로 만드는 팀은 그대로 된다.
  `sessionId` 형식은 터미널 자체의 규칙(`^[A-Za-z0-9_-]{8,160}$`, `TEAM_SESSION_ID` 한 곳)이라 제출 도중에 거절되지 않는다(팀 현황도 같은 규칙).
  작업 팀원은 그 워크트리의 브랜치에서 일하고, 브랜치가 기준 커밋을
  포함하지 않으면 지시문이 먼저 `git merge <기준>`을 시킨다(`behindBase`). 합류한 검토 담당은 브랜치가 없고(`branch:''`, git 요약 없음)
  지시문이 `git checkout`을 금한다 — 그 체크아웃은 사람(또는 리더)의 것이다. 장부의 `attached:true` 팀원은 `close_team`이 세션을 끝내지도,
  워크트리를 지우지도, 브랜치를 지우지도 않는다(outcome `kept`). 모델·에포트·계정·권한·실행 위치는 그 세션 그대로라 새 실행 옵션을 같이 주면 거절한다.
  구성기: AI 목록 아래 「열린 세션」 묶음(리더 프로젝트의 다른 실행 중 세션 — `projectTargetId`로 주 체크아웃과 워크트리를 한 프로젝트로 본다,
  워크트리 세션만 「작업」 가능). 팀 현황은 「열린 세션」 꼬리표와 「세션 설정 그대로」를 보인다.
- **팀 현황**(2026-10-25, `WorkroomTeamStatus` · `src/workroomTeamPanel.ts`): 리더·팀원 워크룸의 터미널 위 띠. 팀원마다 AI · 모델 · 에포트,
  상태(시작 중/작업 중/보고함/막힘/시작 실패/정리됨/**끝남 · 보고 없음** — 장부의 `exited`, 보고 없이 세션이 끝난 팀원/
  **확인 불가 · 앱 재시작 전** — `unknown`), 마지막 출력, 보고 요약, 커밋·병합,
  「열기」(이 워크룸 목록에 있는 세션만). 팀원은 「나는 m2-…」와 「리더 열기」를 본다. 외부 팀원은 실행 위치·전달 상태·수동 확인 출처를 보이고,
  리더에게 지시문 복사·시작/전달 확인·옮긴 보고 동작을 제공한다. 이 동작은 실행·전송·종료를 대신하지 않는다. 병합·정리는 여전히 리더가 한다.
  경로 `POST /api/agent-runtime/workroom-teams`(`{sessionId, git?}`, 관리 경로 — Rust 허용 목록·TS 가드·capability 검사에 있다): 그 세션이
  리더거나 팀원인 팀을 진행 중 먼저·최근 순 3개, **로컬 경로(`primaryPath`·`worktreePath`·`baseCheckout`)·targetId 없이** 준다.
  ⚠️ **폴링은 Git을 돌리지 않는다**: `view(team, {git:false})`가 팀원당 git 4번을 건너뛴다. 화면은 진행 중 팀이 있으면 5초, 없으면 15초마다
  묻고(나중에 만든 팀도 나타나게), 상태·보고가 바뀐 그때와 열 때·새로 고침만 `git:true`로 다시 읽는다. 창이 숨으면 쉰다. 원격·다른 Mac
  세션은 이 Mac의 장부에 없으므로 띄우지 않는다. 검증: `tests/workroom-team-panel.test.ts`(요청 형식·역할·경로 제거·git 없는 폴링·순서·정규화),
  `bun tests/workroom-team-status-ui.mjs`(Chromium/WebKit, 구성기 검사가 함께 돈다 — 매니페스트가 96개 상한).
- **내부 팀원 워크룸은 워크트리 대상**(`rwt_` = `deriveAgentRuntimeWorktreeTargetId(projectId, realpath)`)이라 기존 list/read/send/wait/close가
  그대로 몬다(`projectTargetId` 필터). 의존성은 워크트리마다 따로다 — 지시문이 팀원에게 설치를 맡긴다(호스트는 설치하지 않는다).
- ⚠️ MCP instructions 2,000자 예산: `TEAM_BRIEF`(「팀 작전: create_team → wait_team → merge → close_team.」)가 1,940자에서 끝나고
  기존 별칭 문구가 1,986자다. 더 길게 쓰면 `아젠투지오피에스` 가드가 깨진다(실측). 자세한 순서는 스킬과 도구 설명에 둔다.
- 검증: `tests/workroom-team.test.ts`(요청·재생·거절·보고·대기 커서·정리 규칙·시작 전 장부 기록·정리 예외 격리·`exited`/`unknown`·
  create 중 보고·묘비, 가짜 호스트), `tests/workroom-team-host.test.ts`
  (실제 Git: 같은 기준 워크트리·**리더 워크트리에서 병합하면 `merged:true`이고 close가 그 브랜치를 지운다**·장부에 없는 워크트리와 워크룸 정리·
  병합 후 정리·미커밋 보존·더러운 주 트리 거절·MCP 매핑), `tests/workroom-team-e2e.test.ts`(실제 API·MCP 서버·PTY의
  가짜 CLI: 워크트리 cwd·모델 플래그·지시문·재생·커밋·다른 팀원 행세 거절·팀원 보고·대기·병합·정리), `bun tests/workroom-team-builder-ui.mjs`
  (Chromium/WebKit 구성기). 복사된 설정 정리는 `workroom-team-host.test.ts`가 실제처럼 `.claude/`·`.env`를 복사해 본다 — 예전 실제 Git
  검사는 `seedConfig`를 빈 함수로 둬서 위 결함을 놓쳤다.
- **실제 에이전트 실측**(2026-10-24, v1235, QA 프로젝트): Claude 리더 + Codex·Hermes 팀원으로 생성→대기→검토→병합→검사→정리가 끝까지 돌았다.
  리더는 보고하지 않은 팀원의 화면을 읽고 diff로 확인했고, 설정 안 된 테스터를 통과로 세지 않았다. 남은 마찰:
  ① **bypass 없이 연 워크룸은 승인을 묻는다** — 리더의 MCP 호출·셸마다, Codex 팀원(`--sandbox workspace-write`)은 `.git`이 보호돼
  **커밋마다**. 팀원 권한은 리더에게서 물려받지 않는다(호출자 힌트는 권한이 아니다). 당시 미구현이던 팀원별 bypass 선택은 아래 공통 계약에 추가됐다.
  ② **Hermes는 앱 업데이트 뒤 팀 도구를 못 본다** — `hermes chat`은 오래 사는 Hermes 데스크톱 백엔드의 MCP를 쓰므로, 그 백엔드를
  다시 시작하기 전까지 옛 도구 목록(팀 도구 없음)이다. 그 팀원은 보고 대신 화면에 결과를 적었다. 앱이 Hermes를 대신 재시작하지 않는다.

### 팀 실행 위치·영수증 (2026-10-25)

구성기와 MCP `create_team`은 `src/teamLaunchOptions.ts`의 카탈로그·`parseTeamMemberSelection`을 함께 쓴다(`teamLaunchPlan.ts`는 위임만 한다).
구성기가 채운 `agentstoz-team-selection` version 1 JSON 블록은 선택값의 정본이다. 리더는 자연어로 옵션을 다시 추측하지 않는다.
기존 필드에 `accountId`, `bypassPermissions`, `surface`, `launchOptions`가 추가됐다. 새 선택 블록의 raw JSON은 새 팀원마다 `surface`(워크룸도 `internal`)와 기본 Hermes의 `hermesVariant: default`를 명시한다.
canonical parser는 그 기본값을 정규화해 기존 fingerprint를 유지한다. 과거 version 1 canonical 블록의 생략된 internal/plain-Hermes 값도 이미 선택된 기본값이므로,
클라이언트는 `surface: internal`, `hermesVariant: default`를 MCP 요청에 명시해 재질문을 피한다. 새 Hermes 팀원은 variant 또는 선택된 model+provider를 함께 보낸다. 열린 sessionId 합류는 기존 설정을 유지하며 새 실행 옵션을 주지 않는다.
실제 버튼/유효한 구성기 블록의 선택은 보존하지만, 일반 MCP 요청의 누락을 그 선택 증거로 추정하지 않는다. 자연어 팀 요청에서 AI·위치·Hermes 구성이 빠졌다면
위 선택 준비 순서로 미정만 확인하고, 전부 정해지기 전에는 팀 생성·실행을 하지 않는다. 위험한 작업의 검토 담당도 미선택 AI를 자동으로 추가하지 않는다.

| 선택 | 현재 제공 범위 |
|---|---|
| 실행 위치 | 플랫폼별 기존 프로젝트 런처가 제공하는 `internal`, `orca-floating`, `orca-worktree`, `cmux`, `iterm`, `terminal`, `powershell`, `wsl`, `app` |
| 모델·공급자·에포트·계정 | 모델과 low/medium/high 에포트는 내부 워크룸, provider는 내부 Hermes, CLI 계정은 내부 Codex·Claude. 외부 위치에 이 필드를 주면 거절한다. agy 에포트는 모델에 포함된다. |
| 권한 우회 | 기본 false, 지원 조합에서 명시한 true만 적용. 리더의 권한을 물려받지 않는다. |
| 외부 실행 옵션 | 지원 경로의 Claude `bgMode`, `tmuxMode`, `reuse: new/reuse-or-new`, 앱별 `appMode: new/reopen/open`. 실제 제공 조합만 허용하며 `bgMode`와 `tmuxMode`를 함께 켤 수 없다. 새 창이 기본이고, false도 보존한다. |

모르는 필드·지원하지 않는 조합은 거절한다. 다른 실행 위치나 워크룸으로 조용히 대체하지 않는다. `requested`는 요청, `applied`의
`automatic`/`manual-settings`/`unknown`/`inherit`와 evidence는 적용 근거다. argv에 옵션을 넣었다는 기록만으로 실제 계정·모델 적용을 증명하지 않는다.
외부 CLI 계정의 child 환경 적용을 증명할 수 없는 host 조합은 `needs-setup`으로 남기며 기본 계정으로 실행하지 않는다.

- **상태와 확인**: 내부 워크룸은 관리형 PTY다. 외부는 `awaiting-connection`(연결 없음), `awaiting-manual-join`(수동 시작/확인 필요),
  `awaiting-ack`(지시 수락 후 실제 에이전트 확인 필요), `unknown`(결과·현재 결속 미확정)을 구분한다. 창 열림·입력칸 채움·복사만으로 `working`이 되지 않는다.
  관리형 `working`은 현재 실행 결속과 에이전트·전달 근거가 필요하다. 수동 `started`/`delivered` 확인은 출처를 별도로 남기고 완료 보고를 대신하지 않는다.
- **Orca**: 공개 CLI의 정확한 terminal handle로 create/show/read/send한다. host 실행 ID·팀/팀원·target/cwd·generation과 Orca runtime ID + terminal incarnation을
  결속한다. floating의 `worktreePath`를 실제 cwd 증거로 쓰지 않는다. 필요한 증명이 없으면 지원 런처로 같은 위치·옵션의 창을 한 번 열고 수동 합류로 남기거나
  설정 필요로 보존한다. 관리 신원이 없는 창에 자동 입력·종료하지 않는다.
- **Orca 사이드바 체크아웃**: 일반 `git worktree add` 결과를 adopt한 것으로 가정하지 않는다. `teamOrcaCheckout.ts`는 공개
  `worktree create --repo path:<primary> --name atz-<teamId>-<memberId> --base-branch <exactSHA> --setup skip --no-parent --json`을 한 번 호출한다.
  반환 경로·브랜치와 같은 Git common-dir, 정확한 HEAD, 새 안전 브랜치·중복 체크아웃 없음까지 검증한 뒤 실제 경로를 장부와 target에 반영한다.
  결과 미확정이면 후보를 보존하고 재생성·자동 삭제하지 않는다. 이 단계에서 AI나 setup을 시작하지 않는다.
- **cmux·일반 터미널·앱**: 현재 API 배선의 cmux는 기존 소켓의 `ping`/`PONG` 연결만 확인한다. 오프라인은 연결 대기이며 앱을 대신 켜거나 다른 터미널로 보내지 않는다.
  연결됐을 때만 `new-workspace --cwd … --command …`를 한 번 요청하고 수동 합류로 남긴다. 일반 터미널·bg/tmux는 검증된 기존 런처에 정확한 cwd/argv/초기 지시를 넘긴다.
  앱은 해당 대화 모드를 유지하며 Codex 새 대화의 채움 요청도 미제출이다. CLI 수락·prefill은 실제 작업 증거가 아니다.
- **한 번 실행과 복구**: `teamExternalRuntime.ts`는 외부 부작용 전에 CAS 영수증을 예약한다. 같은 ID·같은 요청은 기록만 재생하고 다른 내용은 충돌이다.
  재시작 때 남은 reserved/sending과 미확정 launch/send/close는 자동 재실행하지 않는다. launch가 이미 초기 지시를 전달했으면 submit을 두 번 하지 않는다.
  알려진 전달 완료 뒤의 명시적인 새 지시만 새 operation ID로 한 번 보낼 수 있다. 이전 전달이 미확정이면 새 ID로도 재전송하지 않는다.
  외부 `close_team`은 현재 결속과 팀 소유 종료 근거가 있는 실행만 닫고, 체크아웃·브랜치는 보존한다. 종료 미확정이면 팀을 열어 두고 보존 이유를 반환한다.
- **통합 팀원 조작**: `agentstoz_use_team_member {teamId, memberId, operation: read|send|reveal}`는 같은 팀 엔진과 `teamRuntimeBridge.ts`를 사용한다.
  native handle·임의 경로·shell·환경·secret을 요청으로 받지 않는다. read는 최대 8,000자와 cursor·`agentVerified`를 반환한다. 정확한 소유 결속이면 에이전트 신원 미확인 상태의
  read/reveal도 가능하지만 작업 중·쓰기·종료 증거로 승격하지 않는다. send는 현재 관리형 결속·신원·전달 상태를 검사한다. 미확정 뒤에는 원래 requestId/text로 영수증만 확인한다.
  reveal은 해당 팀원만 대상으로 하며 내부 워크룸은 UI가 열 sessionId와 `performed:false`를 반환한다. 호출자 세션이 알려졌으면 리더만 허용하고 자기 세션 조작을 막는다.
  외부 결과는 리더가 실제로 읽은 뒤 `report_team_task(manual:true)`로 옮긴 보고로 기록한다. 로컬 MCP 연결이 원격 권한을 늘리지 않는다.

소스 기준: `teamExternalHost.ts`, `teamProjectLauncher.ts`, `teamCmuxManualLauncher.ts`, `workroomTeamMemberOperation.ts`.
원장·private plan 예산은 [자원 관리](../resource-management.md)를 따른다. 계약 회귀는 `team-launch-options`, `team-external-runtime`,
`team-external-host`, `team-project-launcher`, `team-orca-checkout`, `team-cmux-manual-launcher`, `team-runtime-bridge` 테스트에 있다.
이 문서는 구현 계약을 설명한다. 단위·합성 UI 검사나 예전 내부 팀 실측을 외부 앱 전체의 실제 계정 적용, Windows 실행, native GUI 검증 완료로 확대하지 않는다.

## 제품 USE 켜기·끄기 — 「USE 끄기」는 마이그레이션 되돌리기가 아니다 (2026-10-25)

USE의 정본 상태는 `src/serviceUseHost.ts` 하나가 읽는다(`ServiceUseHost`). `@프로젝트-USE`·`#프로젝트-USE` 후보(Mac 워크룸·커뮤니티·
휴대폰 `#`)는 모두 `mentionServices`의 명단이고, 로컬 `/api/service-memory/*`·MCP `agentstoz_use_service_operation`·음성 `operate_product`·
USE 스레드(`workroomThreadService.ts`)는 모두 같은 호스트의 `status`/`bind`/`execute`/`receipt`를 지난다. 새 읽기 경로를 만들면 이 명단과
`bind`를 거칠 것 — `activation.v1.json`을 직접 읽지 않는다.

- **끄기 = 활성화 행의 `enabled:false`.** 프로젝트 USE 기억(`project-namespace-v1`)·그 memoryId/serviceKey·앱 연결(암호화 vault)·영수증은
  그대로 둔다. 다시 켜기는 기존 `enable`(설정 대화상자의 같은 버튼 경로)이 **같은 행**의 결속을 다시 확인하고 플래그만 켠다.
  `disable`은 기억을 읽지 않으므로 기억이 망가진 상태에서도 끌 수 있다.
- 파일 형식: 꺼진 행은 `services`가 아니라 **`off` 배열**에 쓴다. 옛 빌드는 `services`만 읽고 거기의 `enabled:false`는 파일 전체를 거절하므로,
  이렇게 해야 되돌려 설치해도 다른 USE는 그대로 돌고 꺼진 USE는 꺼진 채다. `services`에 `enabled:false`, `off`에 `enabled:true`,
  두 배열에 걸친 같은 serviceMemoryId는 모두 fail-closed(「USE 활성화 설정을 검증하지 못했습니다」).
- 꺼진 동안: `@`/`#` 후보에서 빠지고(`#` 참고도 꺼졌다고 답한다), 새 실행·새 스레드·새 답장은 `SERVICE_USE_OFF_PROBLEM`으로 거절한다 —
  잃은 것이 없고 「USE 다시 켜기」로 돌아온다고 말한다. **상태는 읽힌다**(`turnedOff`는 Mac 로컬 응답에만 있고 `publicServiceUseStatus`가
  대화 경로로 내보내지 않는다). **이전 요청의 영수증과 USE 스레드의 결과는 계속 답한다** — `bind(..., {reading:true})`가 플래그만 빼고
  기억·연결·범위·도구를 똑같이 확인한다. 영수증 조회는 앱에 묻기만 하고 작업을 다시 보내지 않는다.
  끄기 전에 받아들여진 요청 ID를 다시 보내면(응답 유실 뒤 재확인) 거절이 아니라 그 스레드를 돌려준다.
- MCP `resolve_target`은 이름 해석이라 꺼진 USE도 `executionRole:'use'`로 해석한다 — 그래야 다른 세션의 AI도 이전 요청 ID의 receipt를
  물을 수 있다. 실행 여부는 이어지는 `service_operation`의 status/execute가 말한다.
- 라우트: `POST /api/service-memory/disable-use`(enable-use와 같은 허용 목록·본문 검증·`consent:true`). 설정 대화상자 3단계는 켜져 있을 때만
  「USE 끄기」를 보이고, 쉬운 말로 한 번 묻고(기억·연결은 남고 다시 켜면 그대로 이어진다), `SERVICE_USE_CHANGED_EVENT`로 `@` 목록을 새로 고친다.
- 검증: `tests/service-use-off.test.ts`(호스트 왕복·파일 형식·후보 제외·실행 거절·꺼진 동안 영수증·스레드), `tests/service-use-off-api.test.ts`
  (실제 API·MCP), `bun tests/service-use-screen.mjs`(대화상자, Chromium·WebKit). 모두 `service-use-contracts`/`service-use-screen` 검사 안에서 돈다.
