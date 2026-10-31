# 워크룸 — 팝아웃 · 활동 상태 · 에포트 · Hermes 변형 · 터미널 질의 · 다시 시작

## Antigravity CLI 미완료 업무 스킬 (2026-10-29)

Antigravity CLI의 전역 스킬 경로는 IDE의 `~/.gemini/config/skills/`와 별도인 `~/.gemini/antigravity-cli/skills/`다 ([Google 설치 코드](https://github.com/google/agents-cli/blob/main/src/google/agents/cli/setup/_antigravity.py)). 부팅 시에는 기존 CLI 홈에 `agentstoz-unfinished-work`를 설치하며, 사용자 파일·심볼릭 링크·새 버전은 보존한다. 워크룸 팔레트는 agy에 `/agentstoz-unfinished-work`를 제공한다. 팔레트 및 설치 테스트는 실제 CLI에서 스킬 실행과 MCP 연결까지 성공했다는 증거는 아니다.

워크룸의 agy 시작 직전에 해당 스킬만 다시 맞춘다. 실행 파일을 확인하고 안전한 기존 `.gemini`가 있을 때는 첫 실행에도 CLI 홈과 스킬을 만든다. 부모가 없거나 심볼릭 링크인 경우 생성하지 않으며, 기존 자동 맞춤 비활성 설정도 그대로 따른다.

## 모바일 Codex 새 대화 영수증 (2026-10-29)

구형 `codex.thread.start`는 프로젝트 연결 준비·최근 대화 재사용을 유지한다. 신형 휴대폰은 `codex-new-receipt-v1` capability를 확인한 뒤 기본 프로젝트에서만 `codex.thread.start.v2`를 보낸다. 서버는 controller와 actionId, 등록 프로젝트 및 실제 폴더 identity에 결속된 `started` 영수증을 첫 전송 전에 내구 저장한다. Codex Desktop의 공통 화면을 사용하는 legacy·v2 생성과 Mac 검토는 전역 교차 프로세스 잠금으로 직렬화한다. 정확한 Desktop projectId·host·cwd와 turn 완료를 확인한 후 `completed` 영수증을 저장하며, 휴대폰이 응답을 받은 뒤 원래 actionId로 `codex.thread.ack.v2`를 보낼 때만 다음 새 요청이 가능하다. 확인된 기록은 세션 수명 동안 tombstone으로 남아 같은 ID의 재전송이 새 대화를 만들지 못한다.

연결 포트·저장소 변경 뒤에는 같은 controller의 `codex.thread.review.v2`로 미확인 상태와 opaque actionId만 확인한다. 다른 기기는 기록의 내용을 받지 못한다. Mac의 remote-control 관리 capability로 보호된 검토·복구는 등록 프로젝트 ID와 revision CAS, 사람의 명시 확인을 요구한다. `started`는 프로젝트 잠금 아래 두 fence가 모두 없어 전송 전임을 증명하거나, 보존된 정확 threadId의 Desktop 결속과 완료된 turn을 읽기 전용으로 확인한 경우만 복구한다. 결과 불명은 자동으로 지우거나 재전송하지 않는다. 워크트리는 해당 Mac 복구 경로가 준비될 때까지 v2를 거절하고, 인터넷 capability가 기존 16개 한도에 가득 차면 이 기능을 광고하지 않는다.

## 팀원 고정 에포트 모델별 선택 (2026-10-27)

`teamEffortCatalog.ts`는 자동 판정 범위(low·medium·high)와 사람이 고정하는 모델별 범위를 분리한다. 이 Mac의 Codex 모델 캐시에서 확인한 모델은 xhigh·max, 일부는 ultra까지 지원한다. Claude Code 2.1.311은 low·medium·high·xhigh·max 플래그를 제공하며 Opus·Sonnet·Haiku 5.5와 Fable 5.1은 제공자 문서로 xhigh·max를 확인했다. 다른 모델·기본 모델은 미확인 상위 단계를 노출하지 않는다. CLI 버전, 계정과 사용자 지정 모델은 달라질 수 있으므로 카탈로그는 이 날짜의 증거이지 모든 설치에서의 실행 보장이 아니다.

agy 모델 목록은 각 단계가 별도 슬러그다. 같은 계열의 확인된 단계만 표시하며 선택 시 모델도 해당 슬러그로 바꾼다. `--model gemini-4-argon-low --effort high`는 실기에서 충돌로 거절됐고, high 모델과 high effort는 `/effort`에서 high로 확인했다. 기본·미확인 직접 입력 모델의 단계는 추측하지 않는다. 고정값은 워크룸의 각 CLI 실행 인자에 전달하며, Orca의 Claude에도 선택한 `--model`과 `--effort`를 전달한다. Orca 기본 Claude 모델이 미확인인 경우에도 CLI가 받는 xhigh·max를 요청할 수 있으나 모델의 실제 지원을 단정하지 않는다. Orca의 별도 셸 환경은 확인되지 않으므로 팀 현황은 요청한 값과 실제 적용 미확인을 구분한다. 그 외 외부 앱·터미널과 열린 세션에는 적용하지 않는다. 워크룸에서 Codex 설정을 증명할 수 없거나 Claude 환경 변수가 덮어쓰는 경우 고정을 조용히 버리지 않고 시작을 거절한다. thinking이 꺼진 Claude의 xhigh/max도 거절한다.

기존 모바일 리더는 에포트 표시 수준 enum을 엄격히 검증하므로, 확장된 고정값은 요청이 `effortExtended:true`를 보낼 때만 workspace 응답에 넣는다. 새 로컬 화면은 이 표식을 보내고 구형 호스트의 거절 시 읽기 요청에 한해 기존 형식으로 재시도한다. 자동 판정과 Antigravity 자동 적용 정책은 바뀌지 않는다.
`effortExtended`는 **요청 쪽 키**이고 Mac의 자기 패널만 보낸다(`AiTerminalPanel`의 `extended:!remote`). 휴대폰은 보내지 않으므로 응답 DTO·`AiTerminalSummary`·
`REMOTE_CONTROL_PROTOCOL_VERSION`은 그대로다. 정규화기는 `true`만, `workroom.effort`에서만 받는다(다른 값·다른 동작은 구형 호스트와 같은 거절 문구 → 읽기만 한 번 대체).
쓰기(설정·모드 변경)는 다시 보내지 않는다. 검증: `tests/workroom-effort-controls.test.tsx`(정규화기·휴대폰은 키 없음·패널 조건).

### 증거 재동기화와 표면별 차이 (2026-10-28)

- **Codex 카탈로그**는 Codex 자신의 모델 메타데이터(`~/.codex/models_cache.json`, codex-cli 0.163.0, 2026-10-28 재확인)에서 온다. 이 Mac의 설정 기본 모델
  `gpt-6.1-terra`(low…ultra)가 빠져 있어 **기본 모델로 고정한 Codex 팀원은 워크룸 시작에서 전부 거절됐다**('model-unknown'). 숨김 모델 `gpt-reserve`·
  `codex-auto-review`는 low…max, 메타데이터에 없는 옛 항목(`gpt-5.5`·`gpt-daybreak-*`)은 low·medium·high만 둔다. 구성기 목록과 시작 증명은 같은
  표(`teamCodexEffortLevels`)를 쓴다 — `tests/codex-effort-model.test.ts`가 모델마다 둘이 같은지 본다.
- **카탈로그에 없는 Codex 모델**(직접 입력)은 고정할 단계가 없다 — 「자동」만 보이고 parser도 거절한다(시작이 어차피 거절하므로 미리 막는다). Codex CLI 기본
  모델은 모든 카탈로그 모델이 가진 low·medium·high를 보이고, 시작은 여전히 이 Mac 설정의 모델을 증명하며 모르는 모델이면 거절한다(fail-closed 유지).
- **Hermes**(v0.20.5)는 공급자 어댑터가 없는 단계를 말없이 바꾼다: anthropic은 이름에 haiku가 든 모델에 reasoning을 아예 보내지 않고(고정 없음),
  Opus·Sonnet·Fable 5.x는 low…max를 그대로 보낸다(ultra→max라 ultra 없음). openai-codex는 gpt-5.6 계열 none…max, 그 밖은 none…xhigh로 자르므로
  카탈로그와 교집합만 보인다. 그 밖의 공급자·공급자 없음은 예전 그대로 low·medium·high.
- **Claude 기본 모델의 표면별 차이는 의도다**(B11 결정): 워크룸의 Claude 고정은 강제된다(`CLAUDE_CODE_EFFORT_LEVEL`이 덮으면 시작 거절, thinking off의 xhigh/max 거절)
  — 모델을 모르면 low·medium·high만. Orca의 `--effort`는 요청일 뿐이고(셸 환경을 볼 수 없음) 현황이 「요청됨 · 실제 적용 확인 필요」로 말하므로 CLI가 받는
  low…max를 연다. 코드 옆 주석: `teamEffortLevels`.
- **구성기**: 실행 위치를 바꾸거나 Hermes provider를 고치면 새 조합이 제공하지 않는 고정값을 지운다(Orca 기본 Claude max → 워크룸이면 「자동」,
  Hermes anthropic Opus max → provider openrouter면 「자동」; 새 조합에도 있는 단계는 유지). xhigh·max·ultra도 「고정 · <단계>」로 읽는다(`effortPinned`).
  **팀 현황**·구성기 제목은 `teamEffortIsRequest` 하나로 정한다: 워크룸의 Claude·Codex 고정(시작이 적용 못 하면 거절)과 agy(고정이 곧 모델 변형)는
  「에포트 고정 · …」으로만, 워크룸 밖(Orca Claude)과 **Hermes는 워크룸에서도** 「요청됨 · 실제 적용 확인 필요」를 붙인다 — Hermes는 공급자 어댑터가
  `--reasoning`을 말없이 바꾸거나 빼고, 기본 모델 Hermes는 시작이 모델을 모른다(2026-10-28 B-01: 한때 워크룸 Hermes에서 이 꼬리표를 뺐던 것을 되돌렸다).
  검증: `tests/team-launch-options.test.ts`, `tests/workroom-team-builder-ui.mjs`, `tests/workroom-team-status-ui.mjs`.

## 예약 재개와 외부 앱 effort (2026-10-27)

`workroomScheduleHost/Store/Protocol.ts`, `WorkroomScheduleCard.tsx`는 기존 15초 유지보수 tick과 전체 요청 영수증을 사용한다.
입력 대기·빈 작성칸·계정/모델/대화 identity 및 input/output revision을 입력 직전에 확인하고, 새 CLI 시작의 최종 guard는
비동기 대상 재검증 뒤에도 실행한다. 원래 요청 생성/실행 ID를 읽는 것은 재실행이 아니다. 결과 불명은 영속 대화 lease를 유지하고
사람의 결과 검토와 별도 재활성화를 요구한다. 같은 세션/별도 새 대화는 별도 선택이며 새 대화는 증명된 launch model과 일반 승인을 사용한다.
현재 Codex/Claude 대상이다. 같은 호스트 프로세스에서 명시 동의한 종료 대화는 `workroomScheduleIntegration.ts`가
정확한 provider·계정·모델·완료 transcript 증명과 history 영수증을 다시 확인할 때만 복원한다. 같은 호스트에서 복원된 세션이
다시 종료된 경우에도 마지막 완료와 예약 전용 입력 revision을 증명하면 복원할 수 있다. 완료 증거는
bounded 정규 파일 전체 해시와 마지막 완료 행에 결속되므로 정상 메타데이터 추가도 거절할 수 있다. 호스트 재시작 후 증거가
없거나 사람이 입력한 경우에는 확인을 요구한다. Hermes/agy와 불명확한 대화는 추측해 열지 않는다.

예약 재개 패널은 세션의 도구 버튼으로 열 때만 표시·조회한다. 빈 카드도 항상 끼워 넣으면 1120×780·글자 16에서 원래 입력칸이 화면 밖으로 밀린다. `tests/workroom-popout.e2e.mjs`의 초기 입력칸·전송 버튼 가시성 및 예약 열기/닫기 회귀를 유지한다. 닫힌 UI와 별도로 호스트의 기존 유지보수 tick은 예약을 처리한다.

`desktopEffortHost/Native/Protocol.ts`, `DesktopEffortPanel.tsx`는 공통 desktop recommend/off 설정과 다른 세션별 최대 10분 동의다.
HTTP/MCP body로 native adapter를 등록할 수 없다. gateway의 CAS만으로 미제출 입력/선택창을 증명할 수 없어
현재 설치 앱용 Auto connector는 등록되어 있지 않다. 테스트 포트를 실제 연결로 승격하지 않는다.
상세 범위와 검증: `docs/design/workroom-scheduler-2026-10-27/EXECUTION.md`.

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 워크룸 — 넓게 보기와 새 창으로 분리(팝아웃)

워크룸(`src/AiTerminalPanel.tsx`)의 보기 줄에는 「넓게 보기」와 「새 창으로 분리」가 있다.

- **넓게 보기는 앱 사이드바(`top-toolbar`)와 워크룸 머리(프로젝트·AI 선택)만 숨긴다.** 작업 세션 목록은
  터미널 옆(좁으면 위)에 그대로 남아 넓게 보기에서도 세션을 바꿀 수 있다(2026-09-25 실측, E2E가 지킨다).
- **「새 창으로 분리」는 같은 번들을 `/?workroom-popout=1&session=…&target=…&agent=…&bypass=0|1`로 연다.**
  `src/main.tsx`가 이 쿼리를 보면 앱 대신 `WorkroomPopoutApp`(워크룸 패널 하나 + 최소 셸)을 그린다.
  URL에는 **불투명 id만** 싣는다(경로·토큰·프롬프트 금지). 문법의 정본은 `src/workroomPopout.ts`이고
  Rust `open_workroom_window`가 같은 문법을 다시 검사한다 — 둘은 `tests/fixtures/workroom-popout-golden.json`
  한 표를 함께 읽는다. 쿼리 키를 바꾸면 이 표에 케이스를 추가할 것.
- **앱(Tauri)에서는 Rust가 창을 만든다**(`src-tauri/src/workroom_popout.rs`, async 커맨드). 그래서 어떤 창에도
  JS 창 생성 권한(`core:webview:allow-create-webview-window`)을 주지 않는다. 창 라벨은 `workroom-<n>`이고
  `capabilities/workroom-popout.json`이 **그 라벨(`workroom-*`)에만** `core:window:allow-set-title` 하나를 준다
  (세션을 바꾸면 창 제목이 「프로젝트 · AI — 워크룸」으로 따라간다). `default.json`(main)은 바꾸지 않는다.
  `agent_runtime_request`·`load_ports` 같은 앱 커맨드는 로컬 origin이면 capability 없이 호출되므로 팝아웃도
  같은 사이드카를 같은 인증 경로로 쓴다. 커맨드는 main과 `workroom-*` 창에서만 받는다.
- **창을 닫아도 CLI 세션은 끝나지 않는다.** main 창만 닫기→숨김 핸들러가 있고 팝아웃은 그냥 파괴된다.
  세션 종료는 워크룸 하단의 명시적 종료뿐이다.
- **Dock 클릭(Reopen)은 main이 숨겨져 있으면 항상 되살린다**(`should_restore_main_on_reopen`). 예전 조건
  `!has_visible_windows`만 두면, 팝아웃이 하나라도 떠 있는 동안 닫아 둔 main으로 돌아갈 길이 단축키뿐이었다.
- **팝아웃도 기기 탭을 가진다**(2026-10-05): `WorkroomPopoutApp`이 `AiTerminalPanel`을 직접 그리지 않고
  `WorkroomDeviceSwitch`를 쓴다 — 창 하나에서 「호 선택 → 그 기기의 프로젝트 선택 → 새 터미널」이 끝나고
  세션 목록도 그 기기 것으로 바뀐다. 판정·전달 경로가 메인 창과 한 곳에 남는다.
- ⚠️ **팝아웃은 「선택한 세션 전용」이 아니다** — 프로젝트 목록을 받아 머리(프로젝트·AI·새 터미널)를 그대로
  그리므로 **같은 프로젝트를 다른 AI로 새로 여는 것이 이미 된다.** 안내문이 「이 창은 선택한 세션에
  연결됩니다」라 그 기능이 없는 것으로 읽혔다(VOC 2026-10-05) — 문구가 기능을 가린 경우다.
- ⚠️ **그런데 CSS가 실제로 그 기능을 없애고 있었다 (2026-10-06).** 전용 창은 네이티브 AI 앱처럼 대화에서
  시작하려고 `ai-terminal-panel--focused`로 실행 칸을 접는데, 그 규칙이 **세션 목록까지
  `display:none`** 으로 지웠다. 그래서 팝아웃 안에서 다른 세션으로 돌아갈 길이 **하나도 없었다** —
  위 문장과 정면으로 어긋난다. 지금은 사이드바만 없애고 목록은 **터미널 위 가로 줄**로 남기며, 갈 곳이
  하나뿐일 때(`[data-session-count="1"]`)만 줄도 없앤다. **`display:none`으로 되돌리지 말 것.**
  이 결함은 「팝아웃 e2e 4/6 실패」로 몇 주 기록돼 있었고 원인 추정은 entry effect였는데 **틀렸다** —
  세션은 정상적으로 선택돼 있었고(스크린샷의 터미널이 그 세션을 그리고 있었다) 탭이 그려지지 않았을 뿐이다.
  실패한 테스트를 「원인 추정」과 함께 묵히면 그 추정이 사실로 굳는다.
- ⚠️ **팝아웃도 `WorkroomDeviceSwitch`를 거치므로 `/api/agent-dialogue/control`을 부른다**(2026-10-05).
  팝아웃 픽스처가 그 경로를 stub하지 않아 「모든 요청은 mock돼야 한다」에 걸렸다 — 팝아웃에 새 배경
  조회를 더하면 `tests/workroom-popout.e2e.mjs`의 mock에도 함께 넣을 것.
- 팝아웃의 「세션 기억하기…」는 앱으로 넘길 곳이 없으므로 **같은 초안을 그 창 안에서** 연다(원격과 같은 경로).
  「프로젝트·장기기억」「내가 한 말」은 main 앱 화면으로의 이동이라 팝아웃에는 없다.
- **여러 창이 한 세션을 동시에 몰아도 된다.** 입력은 창마다 새 `requestId`로 가고 사이드카가 세션별 FIFO로
  줄 세운다(`aiTerminalService`), 읽기는 창마다 자기 커서로 비파괴 조회한다. 직접 입력(raw)·IME 상태·선택
  세션은 창마다 따로다(팝아웃은 `sessionScope="popout"`, 창마다 sessionStorage가 별개). 팝아웃이 main의
  선택을 바꾸지 않는다. ⚠️ **PTY 크기는 마지막으로 resize를 보낸 창을 따른다.** 그래서 창이 앞으로 올 때
  (`focus`·`visibilitychange`) 자기 크기를 다시 보낸다 — 이게 없던 v516 실기 앱에서, 팝아웃을 쓴 뒤 메인 창으로
  돌아오면 팝아웃 폭으로 줄바꿈된 채(「sp ersettings」) 남았다. 두 창을 **나란히 동시에** 보면 여전히 마지막에
  앞으로 온 창 기준이다. 새 창은 연 창에서 오른쪽 아래로 계단식으로 뜬다(`popout_cascade_offset`) — 같은 자리에
  겹쳐 뜨면 버튼이 안 먹은 것으로 보였다. 같은 프로젝트·AI 세션이 둘 이상이면 탭 이름에 시작 순서
  ` #n`을 붙인다(`src/workroomSessionLabel.ts`).
- **원격(휴대폰) 워크룸은 보기만 할 때 PTY 크기를 바꾸지 않는다.** 회전·리사이즈·세션 선택은 폰 xterm만
  다시 맞추고, 사용자가 실제 입력할 때 그 입력 직전에만 폰 크기를 보낸다. 늦게 붙은 원격 화면은
  `read`의 `snapshot:true`로 사이드카의 현재 headless 화면을 최대 2페이지 안에 받은 뒤 그 cursor부터 이어 읽는다.
  이전 Mac이 `snapshot` 키를 거부하면 오류를 표시하지 않고 기존 `after:0` 재생으로 폴백한다.
  ⚠️ 그 크기 주장(입력 직전 resize)이 Codex에게는 커서 위치 질의(`CSI 6 n`)를 부른다 — 호스트가 그것에 답해야 입력이 제출된다
  (아래 「워크룸 터미널 질의는 호스트가 한 번만 답한다」).
- **휴대폰의 세션 보기 도구는 줄바꿈으로 터미널을 밀어내지 않는다**(2026-10-29): 320×568에서 「미처리 업무 조회」가
  한 글자씩 줄바꿈되며 터미널이 221px로 작아졌고, 926×428에서는 도구가 두 줄을 차지해 202px만 남았다. 세션 보기의 도구는
  44px 터치 대상을 유지한 한 줄 가로 스크롤이며, 넓고 짧은 화면에서는 제목·세션 선택기 폭을 제한해 첫 줄에 둔다.
  스크롤된 「미처리 업무 조회」는 초안만 준비하고 자동 전송하지 않으며, 「워크룸 설정」 팝업은 도구 영역 밖에서도 눌러야 한다.
  `scripts/check-maintainer-web.ts mobile-terminal-full`이 WebKit·Chromium의 해당 크기와 입력·설정 접근성을 격리 검사한다.
  설정을 연 직후 하드웨어 Escape를 누르면 React의 문서 리스너가 아직 붙지 않았을 수 있으므로, `<details>`가 키를 동기 처리한다
  (`WorkroomEffortControls.tsx`). iOS 터치는 입력칸에 초점이 남을 수 있어 세션 보기의 캡처 단계에서도 열린 설정을 먼저 닫고,
  Escape가 CLI나 바깥 세션 보기에 전달되지 않게 한다(`AiTerminalPanel.tsx`).
- ⚠️ **휴대폰 워크룸 터미널이 비어 보이던 원인은 `list` 폭주였다(2026-10-02, 실기 Web Inspector로 확인).** 포털은 상태 폴링(~1초)마다
  `projects`를 새 배열로 넘기고, 패널의 `refresh`(→`list`)가 그 배열 정체성에 묶여 매번 다시 돌았다. 휴대폰 릴레이는 요청을 하나씩
  처리하므로 1분에 `list` ~32회·`read` 1회 — 버퍼가 비어 있었다(그리기 문제가 아니었다; v564의 「다시 그리기」는 틀린 진단이라 뺐다).
  패널은 `projects`를 **내용(JSON)으로** 고정한다. 새 effect가 prop 배열에 매이면 같은 함정이다 — 회귀는
  `tests/workroom-usability.e2e.mjs`의 `remote-rerenders-with-equal-projects-do-not-flood-list`가 잡는다.
  실기 디버깅: TestFlight·개발 채널 웹뷰는 `isInspectable`이고, Appium 세션을 `appium:bundleId`로 그 앱에 묶으면 `WEBVIEW_*` 컨텍스트에서 JS를 돌릴 수 있다.
- **첫 `list`가 답하기 전에는 「실행 중인 작업 세션이 없습니다」라고 하지 않는다**(2026-10-16 감사): 유휴 Mac 뒤에서 몇 초 걸리는 동안 그 문장이
  「새 작업」 옆에 떠 같은 프로젝트에 CLI를 하나 더 띄우게 했다. 그 요청 함수(`request`)의 목록이 한 번이라도 답할 때까지는
  `workroom-remote-sessions-loading`이고, Mac·기기를 바꾸면 다시 모르는 상태다. 그 줄은 **패널이 보일(`visible`) 때만** — 숨은 패널(Mac 없음·
  기기 프로젝트 목록 대기)은 아무것도 묻지 않으므로 「확인하고 있습니다」라고 하지 않는다. 성공·중립 결과(앞서 열린 세션 선택, 보관 요청 전달)는 빨간
  `ai-terminal-error`(VOC 단추)가 아니라 `workroom-notice`(role=status)이고, 오류나 새 동작(시작·전송·세션 전환·닫기·`@` 전달)이 지운다.
- **웹(로컬 dev)은 `window.open` 폴백**이다. **원격(휴대폰 포털) 워크룸에서는 분리하지 않는다** —
  페어링 키·SAS 승인·릴레이 세션이 그 페이지 메모리에만 있어서 새 창은 아무것도 몰 수 없다. 버튼은
  `aria-disabled`로 남기고 툴팁·클릭 안내로 이유를 말한다(`workroomPopoutAvailability`).
- 검증: `tests/workroom-popout.test.ts`(라우트·골든·capability 범위), Rust `workroom_popout::tests`,
  `tests/workroom-popout.e2e.mjs`(팝아웃 렌더·세션 전환·다중 창·원격 안내·넓게 보기 세션 목록).
  ⚠️ 링크된 워크트리에서는 vite 감시가 `**/worktrees/**`를 무시하므로 **파일을 고친 뒤 vite를 다시 띄워야**
  새 코드가 서빙된다(안 그러면 옛 변환본으로 테스트한다).

## 워크룸 활동 상태 — 누가 나를 기다리는가 (S1·S8, 2026-10-16)

세션마다 호스트가 `starting · working · needs-answer · turn-finished · idle · exited` 하나를 들고 있다
(`{state, since, turn(=입력 리비전), source:'screen'|'transcript'|'exit', exact}`). 정본은 `src/aiTerminalActivity.ts`
(순수 리듀서 + 로그 256개·bootId + long-poll)이고 `AiTerminalService`가 공용 1초 샘플러로 먹인다. ⚠️ **`AiTerminalSummary`에
더하지 않는다** — 휴대폰 정규화기가 모르는 키를 거절한다. 문턱값은 이름 붙은 상수이고 실제 CLI 캡처(`tests/fixtures/workroom-activity/`)로 맞춘다.

- **정확(exact)과 추정을 가른다.** 정확: 스폰, 쓴 요청(글이 있고 `\r`로 끝난 입력·전체 요청 제출·첫 요청 — `workroomInputIsRequest`.
  **Enter만 있는 입력은 키다**: 빈 입력칸 통과·Enter 버튼·agentstoz_use `enter`·팝업 확인이 「응답 멈춤」 알림이 되던 결함, 리뷰 2026-10-16), CLI 자기 기록의 턴 끝(Claude
  `stop_reason:"end_turn"` — `tool_use`는 아님, Codex `task_complete`), 프로세스 종료. 추정(`exact:false`): 화면 질문(같은 질문이
  1.5초 동안 매 샘플에 남음 + `workroomScreenAwaitsAnswer`, **starting 포함 모든 실행 상태에서**), 아무 쓰기 없이 3초 뒤의 턴 끝,
  지속된(3초) 화면 변화로 다시 working. 화면 질문이 기록의 턴 끝보다 이긴다. starting은 첫 조용한 5초에 idle이 되고 턴 끝으로 읽히지 않는다.
  ⚠️ **기록의 턴 끝은 그것이 속한 요청만 끝낸다**(리뷰 2026-10-16): CLI는 일하는 중에 보낸 Enter를 줄 세우므로, 리듀서가 열린 요청을
  순서대로 들고(`pendingSubmits`) 턴 끝 하나가 가장 오래된 것 하나만 닫는다 — 모두 닫혀야 정확한 turn-finished다. 가장 오래된 열린 요청보다
  먼저 쓰인 끝은 옛 턴이다(여유 250ms). 일하지 않던 세션에 보낸 요청은 목록을 새로 시작한다. 추정 턴 끝의 조용함은 **마지막 출력과 마지막 요청
  중 늦은 쪽**부터 센다(다시 그리기 전의 CLI가 요청 600ms 뒤 「끝」이 되던 결함).
- **문턱값은 실제 CLI 녹화로 맞췄다**(Claude Code 2.1.301·Codex 0.162.1, 격리 HOME·가짜 모델, 2026-10-16 — 녹화 8개
  `tests/fixtures/workroom-activity/`, 재생 `tests/workroom-activity-replay.test.ts`가 **서비스와 같은 샘플러**
  (`workroomSampleWantsRows`·`workroomSampleInputs`)와 리듀서를 녹화 시각의 가짜 시계로 4개 샘플 위상 × 기록 있음/없음으로 돌린다).
  ⚠️ **질문에 「출력 조용」 조건을 다시 붙이지 말 것** — 승인 화면은 기다리는 동안에도 쓴다(Claude는 ~0.6초마다 한 줄을 깜빡이고 Codex는
  ~1초마다 창 제목을 바꾼다). 옛 「1.5초 조용」 규칙은 녹화의 모든 승인 화면을 20초 내내 `working`으로 놓쳤다(신뢰 화면만 정지라 잡혔다).
  지금은 `WORKROOM_NEEDS_ANSWER_STABLE_MS`(1.5초 — Claude 깜빡임의 2.4배·Codex 제목의 1.5배)로, 1초 샘플이면 2–3초 뒤에 뜬다.
  추정 턴 끝 `WORKROOM_TURN_FINISHED_QUIET_MS`는 3초다 — 작업 중 가장 긴 무쓰기는 0.8초(Claude 스트리밍, Codex 0.12초)라 3배 넘는 여유이고
  재생 테스트가 그 여유를 지킨다(제목 쓰기도 쓰기로 센다 — 그게 CLI의 맥박이다). 기록 턴 끝은 줄이 디스크에 닿은 다음 샘플(≤1초)이다.
  ⚠️ **질문이 화면에 있던 동안의 Enter는 답(keys)이지 새 요청이 아니다** — 아니면 신뢰 화면에 답한 Enter가 `working`이 되고 3초 뒤
  아무 요청도 돌지 않았는데 「턴 끝」이 났다(녹화로 재현). 질문이 끊은 상태로 돌아간다(시작 중 신뢰 화면 → `starting` → 5초 뒤 `idle`).
  녹화가 확인한 순서: 신뢰 starting → needs-answer~ → starting~ → idle~ → working → turn-finished, 승인 working → needs-answer~ →
  working~ → turn-finished, 긴 스트리밍·말없는 모델 대기·도구 실행 동안 계속 working. agy·Hermes는 녹화하지 않았다.
- **샘플 비용**: 행은 실행 중 세션마다 출력이 있었을 때만, 초당 한 번 읽는다(최대 12개). 기록 읽기는 한 번에 모두 합쳐 512KB이고
  **읽은 모든 바이트**(tail, Windows rollout 머리)를 거기서 뺀다(`src/aiTerminalActivityTranscript.ts`). 파일은
  `O_NOFOLLOW|O_NONBLOCK`으로 열고 fstat이 stat한 그 일반 파일(dev/inode)일 때만 읽는다 — ⚠️ `O_NONBLOCK`을 빼지 말 것: stat과 open 사이에
  FIFO를 바꿔 넣으면 open이 writer를 기다리며 사이드카 전체가 멈췄다(리뷰 재현). 바뀐·잘린 파일은 다음 sweep에 최신 창부터 다시 읽는다.
  Claude는 `--session-id`로 파일 이름을 안다. Codex는 첫 요청 뒤에만 lsof 스레드 잠금으로 묶고(요청 전엔 잠금·rollout이 없다 — 측정),
  이어 연(resume) 스레드는 rollout이 옛 날짜 폴더에 있으므로 모든 날짜 폴더를 최신부터 찾는다(`codexRolloutPathById`). Windows는 세션
  시작 뒤 쓰인 rollout만 최신부터 열어 cwd·시간창이 정확히 하나일 때만 — 예산이 모자라면 추측하지 않고 다음 sweep에 다시 본다. 묶이면
  캐시한다. Hermes·agy·제한(CS 대직) 세션은 화면 단계만.
- **종료 원인**: `exit`(스스로 끝남)만 알린다. 사람이 닫은 것(`close`), 「다시 시작」(`restart`), 앱 종료(`shutdown`)는 알리지 않는다.
  원인은 **CLI에 신호를 보내기 직전에야** 붙인다 — 기억 대기열 쓰기 실패 등으로 닫기가 실패하면 원인이 남지 않아 나중의 비정상 종료가 알려진다.
- **보았음(seen)**: 보이고 초점이 있는 창이 그 세션을 보여 주면(디렉터리 대화창·팝아웃, 1.2초 지연) turn-finished → idle.
  ⚠️ **원격·커뮤니티의 읽기(`read`)는 본 것으로 치지 않는다**(리뷰 2026-10-16) — 원격 패널은 보이지 않을 때도 폴링하고 `@` 전달은
  받는 세션 화면을 읽으므로 사람이 봤다는 증거가 아니다(비판 29의 「앞에 띄운 원격 읽기」는 호스트가 알 수 없어 이번 회차에 넣지 않았다).
  원격이든 로컬이든 그 세션에 친 키·요청은 turn-finished를 넘긴다.
- **경로**: 로컬 터미널 경로의 `{operation:'activity', after?:{bootId,seq}, waitMs}`(호스트가 25초로 자른다)와 `{operation:'seen', sessionId}`.
  ⚠️ **이번 회차에는 원격(릴레이·LAN·커뮤니티) 모두 거절한다** — 와이어 파서가 모르고, `performActivity`가 authority·receiptOwner를
  거절하며, 커뮤니티 실행기 허용 목록에도 없다. Rust 프록시는 이 동작만 30초를 준다(`agent_runtime_response_timeout`, 테스트 있음).
  `after`가 다른 부팅이거나 로그보다 오래되면 `{reset:true}`와 스냅숏만 온다 — **reset에서는 아무것도 알리지 않는다.**
- **창마다 구독 하나**: App(메인 창)과 각 팝아웃이 `useWorkroomActivity`로 long-poll을 소유하고(동시 요청 1개, 숨겨지면 멈춤, 오류 백오프,
  옛 사이드카는 5분 뒤 다시). ⚠️ long-poll(25초 보류)은 **앱에서만**이다 — 로컬 웹 빌드는 보류 없이 2초마다 묻는다
  (`workroomActivityTransport`): 브라우저는 호스트당 HTTP/1.1 연결 6개라 창 6개가 각각 25초를 잡으면 페이지의 다른 요청이 전부 막혔다(리뷰 2026-10-16).
  디렉터리·사이드바 「대화 세션」 배지(응답 필요 + 턴 끝)·팝아웃 제목(「● 응답 필요 · …」/「✓ 완료 · …」/
  추정은 「◦ 응답 멈춤 · …」)은 `useWorkroomActivitySnapshot`으로 읽기만 한다.
- **대화 세션 화면은 실행 중 세션이 먼저다**: 한 줄 행을 응답 필요 → 작업 중 → 완료 → 응답 멈춤 → 대기 → 실행 중 → 종료로 묶고(종료 행은
  호스트가 정리할 때까지 — 「24시간」이라고 쓰지 말 것), 저장된 대화는 그 아래 「저장된 대화 N개」로 접고, 새 대화 시작은 맨 아래 접힌 칸이다.
  ⚠️ **제목은 그 아래 모든 행에 참이어야 한다**(리뷰 2026-10-16): 추정 턴 끝은 「완료」가 아니라 「응답 멈춤」 묶음, 상태를 모르는 세션(다른 Mac,
  옛 사이드카, 첫 응답 전)과 시작 중인 세션은 「대기」가 아니라 「실행 중」 묶음이다. 배지 툴팁은 「응답 필요·완료·응답 멈춤」, 탭의 접근 이름은
  「대화 세션, 확인할 세션 N개」(숫자는 aria-hidden).
- **알림 정책은 한 곳**(`src/workroomNotifyPolicy.ts`, 비판 28): needs-answer·턴 끝·`exit`만, (세션, 턴, 종류)마다 한 번, 세션마다 10초에
  하나(늦춘 후보는 버리지 않음), 추정 턴 끝은 8초 버틴 뒤에만, 문구는 「답이 필요합니다」/정확 「작업이 끝났습니다」/추정
  「응답이 멈췄습니다 · 확인해 보세요」/「종료됨(코드 N)」. 골든 표 `tests/fixtures/workroom-notify-golden.json`을 Rust가 나중에 함께 읽는다.
  **이번 회차에는 전달(Mac 알림·푸시)이 없다.**
- 검증: `tests/ai-terminal-activity.test.ts`(리듀서 표·가짜 PTY+가짜 시계·원격 거절·reset·기록 tail·예산·종료 원인),
  `tests/workroom-activity-replay.test.ts`(녹화 8개 재생 — 상태 순서·질문 지연·작업 중 거짓 턴 끝 없음·idle 중 거짓 working 없음·문턱 여유),
  `tests/workroom-activity-fixtures.test.ts`(녹화 화면의 질문 판정), `tests/workroom-notify-policy.test.ts`, `tests/workroom-activity-store.test.ts`, Rust `workroom_activity_long_poll_gets_thirty_seconds…`,
  `bun tests/workroom-session-directory-activity.e2e.mjs`(네 상태 네 라벨·저장된 대화 50개에도 첫 행이 화면 안(800×700·1280×800)·요청 1개·
  seen·숨김 멈춤·팝아웃 제목·웹 빌드는 보류 없이 묻는다). 리뷰 수정(2026-10-16)의 회귀: 줄 선 요청·늦게 읽힌 끝·요청 기준 조용함·Enter만의 입력·
  실패한 닫기의 원인·원격 읽기는 seen 아님·FIFO 경합(자식 프로세스로 강제)·바뀐 파일과 Windows 머리의 예산·옛 날짜 폴더의 이어 연 스레드
  (`tests/ai-terminal-activity.test.ts`), 제목이 행에 참(`tests/workroom-session-directory.test.ts`), 배지 문구·웹 보류
  (`tests/workroom-activity-store.test.ts`).

## 워크룸 에포트 자동 — 요청에 맞는 추론 강도로 시작한다 (w16, 2026-10-16)

**사용자 결정(2026-10-16)**: 「워크룸 자체에서는 아젠투지가 관리할 수 있으니, 옵션값에 에포트 자동적용을 켜짐 기본으로, 필요한 에포트가
모델에 따라 자동으로 적용되게」. 사람이 켠 **제품 기능**이고 기본 켜짐, 끄는 것은 설정 하나다. 위 「Task-aware model and reasoning advice」의
「에이전트는 스스로 설정을 바꾸지 않는다」는 **AI 에이전트의 행동 규칙**이라 이 기능과 충돌하지 않는다 — 이 결정을 근거로 그 규칙을 넓히지 말 것.
정본: 표 `src/workroomEffortPolicy.ts`(+ 골든 `tests/fixtures/workroom-effort-golden.json`)·세션 상태 `src/workroomEffortSession.ts`·
설정 `src/workroomEffortSetting.ts`·Codex 모델 증명 `src/codexEffortModel.ts`·실행 인자 `aiTerminalLaunchArgs`(8번째 인자).

- **판정은 로컬·결정적이다(AI 호출 없음).** 첫 요청 글(`#` 참고 덧붙이기 전, 첨부 블록·끝 Enter 제외, 앞 4,000자, NFKC·소문자)로
  `high`(동시성·보안/권한 격리·파괴적 마이그레이션·원인 불명 반복 실패·설계/리뷰/감사 — 표의 순서대로 첫 단서가 이유) > `low`(300자 이하의
  오타·문구·이름 바꾸기·번역·서식) > `medium`(그 밖). `/`·`$`·`!`로 시작하거나 비면 판정 없음(플래그 없음). 한국어는 그대로, 영어는 단어 경계로
  맞춘다. 알려진 한계(골든에 남김): 부정(「동시성 문제는 아니고 오타만」 → high). 「감사합니다」·「리뷰 페이지」·「왜 안내」는 단서가 아니다.
- ⚠️ **자동은 `high`보다 높게 정하지 않는다** — Claude는 생각이 꺼져 있으면 xhigh/max 턴을 「Effort 'xhigh' isn't available with thinking
  turned off」로 끝내고, max/ultra는 가장 비싸다. minimal/none도 고르지 않는다.
- **시작할 때만 정한다**(CLI마다 자기 플래그): Claude `--effort <l>`(프롬프트 앞), Codex `-c model_reasoning_effort="<l>"`(상태 줄 `-c` 뒤, `resume`
  뒤에도), Hermes `chat --reasoning <l>`. 플래그를 주지 않는 시작: 첫 요청 없음(「새 터미널」)·CLI 명령·대화 기록 재개(w14)·제한 실행(CS 대직은
  자기 규칙 그대로)·Antigravity·`CLAUDE_CODE_EFFORT_LEVEL`이 있는 환경(그것이 플래그를 이긴다)·증명되지 않은 Codex 모델·설정 꺼짐.
  「다시 시작」은 바뀐 세션의 tier를 이어받되 CLI 쪽 검사는 다시 한다. 휴대폰·LAN·다른 기기에서 이 Mac으로 오는 시작도 **이 Mac의 설정**을 따른다.
- ⚠️ **실행 중인 Claude에 `/effort <level>`을 입력하지 말 것.** Claude Code 2.1.301에서 인자를 붙여 친 `/effort`는 「(saved as your default for
  new sessions)」 — **사람의 전역 기본값을 바꾼다**(바이너리 문자열 확인). 세션 한정 경로는 picker(`/effort`⏎ → ←/→ → `s`)뿐이고 실제 PTY 녹화로
  확인하기 전에는 쓰지 않는다(설계 Build C, 이번에 넣지 않음). 그래서 실행 중에는 **아무것도 입력하지 않고**, 전체 요청 제출이 다른 강도를 원하면
  호스트 전용 기록에 `advice`만 남긴다(지금보다 높은 강도에서 hard 요청을 낮추라고 권하지 않는다; 현재 강도를 모르면 low/high만).
- **Codex는 모델을 증명할 때만**: Codex는 모델이 지원하지 않는 강도를 「Reasoning effort … is not supported for model …」로 거절한다. 0.162.1 번들
  카탈로그 11개 모델은 모두 low·medium·high를 지원한다. `$CODEX_HOME/config.toml`·`/etc/codex/managed_config.toml`·작업 폴더에서 저장소 루트까지의
  `.codex/config.toml` 맨 위 키만 읽어(각 64 KiB) `model` 없음 또는 카탈로그 모델일 때만 통과하고, 다른 모델·`model_provider`(openai 외)·`profile`·
  `model_catalog_json`·`oss_provider`·`openai_base_url`/`OPENAI_BASE_URL`·모델을 고르는 실행 인자·못 읽는 줄·못 읽는 파일은 전부 플래그 없음이다.
  카탈로그가 바뀐 Codex로 올라가면 `CODEX_EFFORT_CATALOG`를 다시 확인할 것.
- **Antigravity는 지원하지 않는다**: agy 1.3.1에는 `--effort`가 있지만 강도가 모델 변형 선택과 묶여 있다(바이너리의 변경 기록: 맨 `--effort`가
  「다른 모델로 옮겼다」). 화면은 「지원 안 함」이라고 말한다.
- **사람이 직접 바꾸면 그 세션에서는 멈춘다**: 입력 경로의 `/effort`·`/model`(Claude), `/model`(Codex), `/reasoning`·`/model`(Hermes), 또는 화면에
  **새로** 나타난 변경 줄(Claude 「Set effort level to / Kept effort level as / Effort level set to auto / Set model to」, Codex 「Model changed to」),
  또는 처음 읽은 뒤 화면의 강도가 바뀜. 첫 행 읽기는 기준선이라 재개된 대화에 남은 옛 줄은 세지 않는다. 멈춘 세션의 「다시 시작」은 플래그를 주지 않는다.
  화면 확인은 w9 활동 샘플러가 **이미 읽은 행**으로만 한다(추가 읽기 없음) — 처음 보인 강도가 시작 값과 다르면(CLI가 낮춤) 그대로 보여 주고 고치지 않는다.
- **설정은 이 Mac 것이다**: `<appData>/workroom-effort-auto.json` `{version:1,auto,updatedAt}`(0600, 임시 파일 + rename, 심볼릭 링크 따라가지 않음),
  **없거나 깨졌으면 켜짐**, 메모리에 두지 않고 시작·제출마다 다시 읽는다(같은 데이터 폴더의 두 번째 사이드카도 같은 값). 끄면 앞으로의 시작·advice가 멈추고,
  실행 중인 세션은 시작 때의 강도로 계속된다.
- **화면은 같은 workspace 동작을 사용한다**: `workroom.effort`는 이 프로젝트를 허용한 휴대폰과 Mac 창에서 설정을 읽고 바꾸며,
  다른 커뮤니티 Mac은 읽기만 한다. 토글은 시작 옵션의 권한 우회 옆, 적용 강도·이유는 세션 하단, 후속 요청의 권고는 그 아래에 표시한다.
  지원하지 않는 옛 호스트는 한 번 거절하면 토글·배지를 숨기고 다시 묻지 않는다. 화면이 보일 때·선택 변경·창 복귀·요청 후에만 읽고 상시 폴링하지 않는다.
  이전 Mac의 늦은 응답과 설정 변경 전 조회는 새 표시를 덮지 않는다. React StrictMode의 정리 후에는 새 reader를 만든다.
- **터미널 DTO는 그대로다**: 로컬 `{operation:'effort', requestId?, set?, sessionIds?≤24}`는 원격 authority와 community 소유자를 거절한다.
  휴대폰은 위 workspace 경로만 사용한다. 설정·세션 기록은 `AiTerminalSummary`에 싣지 않으며 기능 목록·Rust/Tauri 권한을 늘리지 않는다.
  설정 쓰기 실패는 사용자용 오류만 반환하고 로컬 파일 경로·원시 파일시스템 오류를 내보내지 않는다.
- **내부 워크룸 팀원 에포트**(2026-10-25): 자동인 팀원은 지시문 전체가 아니라 **자기 작업**으로 판정한다(`requestText`). 사람이 고정한 팀원은
  설정이 꺼짐·권고만이어도 그 강도로 시작하고, 이후 자동 조정·advice·다시 시작이 바꾸지 않는다(`WorkroomEffortState.pinned`, 호스트 전용 —
  기록·화면에는 tier 없는 level로만 보이고, 세션 배지는 CLI가 보여 줄 때까지 「에포트 요청 · <강도> · 적용 확인 전」, 보인 뒤 「… · CLI 표시 <강도>」).
  자세한 것은 `mcp-ops.md` 「팀 작전」.
- **팀 실행 위치와 현황**(2026-10-25): 구성기와 MCP는 같은 `teamLaunchOptions.ts` 카탈로그·parser를 사용한다. 지원 위치별 옵션을 지시문의 version 1 선택 블록에 보존한다.
  팀 현황(`WorkroomTeamStatus`, Mac)은 내부 세션 상태와 외부 실행 위치·전달 상태·수동 확인 출처를 구분한다. 리더는 지시문 복사·시작/전달 확인·옮긴 보고를 기록할 수 있다.
  외부 창 열림·prefill·복사만으로 작업 중이나 완료로 판정하지 않고, 연결 대기·수동 합류·응답 대기·미확정으로 남긴다. 외부 위치의 계정 선택은 제공하지 않고, 모델·에포트는 Orca의 Claude에만 요청으로 전달한다(적용 확인 전 — 위 「증거 재동기화와 표면별 차이」).
  실제 read/send/reveal, 초기 지시 한 번 전달, 재시작 후 자동 재실행 금지는 [mcp-ops.md](mcp-ops.md) 「팀 실행 위치·영수증」을 따른다.
- **자연어 MCP의 AI 선택**(2026-10-25): `agentstoz_use_prepare_agent_launch`에서 AI → 실행 위치 → Hermes 기본/Claude/Codex 중 미정만 질문한다.
  agent 이름만으로 앱·터미널·워크룸을 정하지 않으며, 연결 클라이언트는 답 전까지 실행하지 않는다. 값이 모두 알려진 prepare도 비실행이다.
  사람이 명시한 값과 실제 버튼·팀 선택 블록을 유지하고, 실행 도구 이름이나 호출 중인 AI를 선택 증거로 삼지 않는다. 명시적인 위임 범위 밖에서 자동 선택하지 않는다.
  Hermes의 model/provider 고정 변형은 현재 워크룸만 지원한다. 외부/app 불가 조합은 이유와 대안을 알리고 답을 기다리며 워크룸으로 자동 대체하지 않는다.
  start/open에는 선택한 surface를 명시하며 워크룸도 `internal`을 보낸다. Hermes Workroom start는 `hermesVariant: default/claude/codex`를 명시하고, Hermes open은 현재 앱/CLI 설정인 `default`만 허용한다. 다른 변형 세션을 재사용하지 않는다.
  새 팀원도 surface와 Hermes variant 또는 model+provider가 필요하다. 새 raw 선택 블록은 기본값을 명시하며, 과거 유효한 v1 블록에서 생략된 internal/plain-Hermes 기본값은 클라이언트가 MCP에 명시해 재질문하지 않는다. 열린 sessionId 합류는 기존 설정을 유지한다.
  prepare의 `executionRoutes`가 팀 생성만 제공하면 단일 요청을 임의로 팀으로 바꾸지 않는다.
- 열린 결정: 보통 요청의 `medium`이 사람의 더 높은 개인 기본값(예: Claude `effortLevel`, Codex config의 effort)을 이번 세션에 한해 낮춘다(D1 — 요청대로
  「그 밖은 medium」). Claude Code의 Haiku 5.5는 effort low…max를 받는다(제공자 문서). Hermes의 anthropic 어댑터는 haiku 모델에 reasoning을 보내지 않으므로 Hermes·Haiku 팀원에는
  고정을 제공하지 않는다. 시작이 Hermes 모델·provider를 **골랐을 때**(팀원·「Hermes · Claude/Codex」, `launchModel`) `planWorkroomEffort`는 같은 표
  (`teamHermesEffortLevels`)로 거른다(`hermesModel`): Hermes·anthropic Haiku의 **자동**은 `--reasoning`을 넘기지 않고 「모델을 확인하지 못해 CLI 기본값」
  (`model-unknown`)으로 말하며, 그 표에 없는 고정은 시작을 거절한다(2026-10-28). ⚠️ Hermes **자기 설정**(`~/.hermes/config.yaml`)의 기본 모델은 여전히
  모른다 — 그 모델이 Haiku면 자동 `--reasoning`은 무시되는데 배지는 「에포트 자동 · <단계>」라고 말한다(미해결: 호스트가 그 설정을 읽어야 한다).
- 검증: `tests/workroom-effort-policy.test.ts`(골든·high 상한·4,000자·300자·단어 경계·첨부 제외), `tests/codex-effort-model.test.ts`(카탈로그·모델/공급자/
  프로필/카탈로그/base URL/실행 인자·맨 위 키 스캐너·실제 파일의 없음/64 KiB/권한/디렉터리), `tests/workroom-launch-options.test.ts`(CLI별 플래그 위치·생략 시
  바이트 동일·agy/제한 실행 무시), `tests/workroom-effort-launch.test.ts`(실제 서비스 + 가짜 PTY: 켜짐/꺼짐·요청 없음·CLI 명령·agy·Codex 증명·Hermes·
  `CLAUDE_CODE_EFFORT_LEVEL`·CS 대직·기록 재개·다시 시작 유지/수동 뒤 없음/꺼진 뒤 없음·휴대폰 권한·launch 제출), `tests/workroom-effort-screen.test.ts`(화면 강도·
  낮춤 표시·변경 줄/입력으로 수동·기준선·advice가 아무것도 입력하지 않음·MCP/꺼짐/수동 뒤 advice 없음·high 위에서 낮추라 하지 않음),
  `tests/workroom-effort-setting.test.ts`(없으면 켜짐·0600 원자적 저장·깨진 파일/심볼릭 링크·요청 형식·원격/커뮤니티 거절·`normalizeAiTerminalRequest` 거절).
  ⚠️ 실제 CLI(Claude·Codex·Hermes)로 플래그를 넣어 띄워 보지는 않았다(돈·네트워크) — 인자는 각 CLI `--help`와 바이너리 문자열로만 확인했다.

### 에포트 자동은 전송을 붙잡지 않는다 — 쓰기 전 대기는 4초, 거절은 `rejected` (2026-10-30)

설치본 1577에서 「현재 세션에 전송」이 Claude는 두 번째 요청부터, Codex는 첫 요청부터, 팀 작전 리더에게는 일하는 중에 멈췄다(「앞서 보낸 요청의
전송 결과를 확인해야 합니다」). 설치본 기록의 해당 영수증은 모두 `prepared`로 남아 있었다. 원인: 전체 요청 제출의 **쓰기 울타리 앞**에서 실행 중 에포트 조절(`#adjustEffort` →
`changeWorkroomEffort`)이 「빈 작성칸 + idle」을 **최대 60초** 기다렸다. 그 대기는 모든 클라이언트 대기(브라우저 15초·앱 프록시와 MCP 20초)와
조립 수명 30초보다 길다. Claude 2.1.314는 턴이 끝날 때마다 다음 프롬프트 제안을 작성칸에 흐리게(`ESC[2m`) 그려
`effortComposerEmpty`가 거짓이 된다. 일하는 리더(「Orchestrating…」)는 idle이 아니다. Codex의 hooks 검토 화면은 질문 화면이라 즉시 거절했다.
거절된 입력 영수증은 `prepared`로 영원히 남았고, 패널은 그 위에 울타리를 쳤다. 실측: 시험 세션 `fa7c78b8`에서 C1·C2는 written, 제안이 뜬 뒤 C4는 20초
타임아웃·`prepared`·입력 0바이트였다. 팀 리더 `cfdc3925`의 두 번째 요청도 같은 `prepared`, 같은 시각 리더→팀원 후속 지시(MCP)는 written.
- **준비 대기는 `WORKROOM_EFFORT_READY_WAIT_MS`(4초)**. 넘기면 `WorkroomEffortNotReadyError`가 난다. 화면이 강도를 보여 주지 않으면 기다리지 않고
  곧바로 `unsupported`다. 질문 화면 거절이 이 둘보다 먼저다 — 승인·선택 화면에 요청을 치지 않는다. 키를 하나도 치지 않았으면 강도는 그대로 두고
  (`runtimeStatus`는 비우고 advice를 남긴다 — `deferred`는 바꾸는 동안에만이다) 요청은 쓰기 경로로 간다. Claude·Codex는 일하는 중 입력을 자기
  대기열에 넣는다.
- **그때 작성칸이 비었음을 새로 증명해야 한다(ROOT 리뷰)**: 바꿀 수 있는 Claude·Codex TUI(`claudeSessionPicker`·`codexDefaultKeys`)에서는 쓰기
  울타리 직전에 화면을 **다시** 읽고 `effortComposerEmpty`가 참일 때만 요청을 쓴다(흐린 자리표시자는 빈 칸이다). 진짜 초안·대기 중에 생긴 초안·
  읽을 수 없는 작성칸이면 쓰기 울타리 전에 거절한다 — 요청 0바이트, 사람의 초안은 그대로, 영수증은 `rejected`. `NotReadyError`는 「바쁨」과
  「초안 있음」을 가르지 못하기 때문이다(그대로 쓰면 초안에 요청이 이어 붙는다). 일하는 리더라도 작성칸이 비어 있으면 받는다.
  런타임에 바꿀 수 없는 CLI(피커·기본 키 없음)와 Hermes는 예전 쓰기 경로 그대로다.
- **「바꾸지 않았다」를 화면이 말한다(ROOT 리뷰)**: 자동 모드(`mode==='auto'`)에서 바꾸는 중(`deferred`)도 확인 필요(`unconfirmed`)도 아닌데 advice가
  있으면, 에포트 자동이 강도를 바꾸지 않은 것이다. 배지는 「에포트 자동 · 이번 요청은 변경 안 함」, 안내는 「에포트는 지금 xhigh 그대로입니다 · 이번
  요청의 권장 보통으로 바꾸지 않았습니다 · 바꾸려면 「에포트 변경」」(`workroomEffortView.ts`의 `notAdjusted`). **전달 여부는 말하지 않는다** —
  advice는 쓰기 울타리 전에 남고 그 뒤 권한·교정·작성칸 확인이 요청을 거절할 수 있다. 전달은 제출 영수증만 증명한다. 기존 DTO 필드만 쓴다 — 새 `runtimeStatus` 값을
  더하면 휴대폰의 엄격한 정규화기가 응답 전체를 거절한다. 추천 모드와 mode가 없는 옛 응답의 문구는 그대로다.
- **키를 하나도 치지 않았으면 `seen`을 지킨다**: 강도 줄은 턴이 지나면 화면에서 사라진다. 그래서 다음 요청은 지켜 둔 강도로 다시 판단해 바꾼다.
  키를 쳤으면 기준선을 새로 잡는다(예전 그대로).
- **강도는 낱말로만 읽는다**: Claude 2.1.314는 시작 화면에 `◉ xhigh · /effort`를 그린다(실측). `cliInfoFromScreen`이 `◉`를 받아들인다.
  그러나 강도는 늘 `/effort` 앞의 낱말에서 읽는다 — 글리프만으로 짐작하지 않는다(`◉ · /effort`·`◉ turbo · /effort`는 읽지 않는다).
- **흐린 자리표시자는 빈 작성칸이다 — 기하가 정확할 때만**(`effortComposerEmpty`): 커서 뒤 글자가 **모두** 흐려야 한다(`dimmedCursorTail`).
  또 커서가 표시(`❯`/`›`) 바로 다음 칸에 있어야 한다.
  ⚠️ Codex 0.166은 `ultra`에서만 작성칸 표시를 `»`로 그린다(none…max는 `›` — 2026-10-31 3호 격리 tmux 실측, 같은 바이너리).
  `»`를 몰랐던 1634까지는 ultra 세션의 모든 요청이 「확인할 수 없는 내용」으로 거절됐다(1호 OPS). 작성칸 표시 정규식에는 `»`를 함께 둔다.
  Claude는 여기에 더해 작성칸 줄 **바로 위·아래가 규칙선**이어야 하고 200자 이하여야 한다(낱말은 무엇이든 — CLI의 추측이다).
  Codex는 「Ask a follow-up question」 문자열일 때만이다(0.166 바이너리 문자열 — 실기 미확인). 흐리지 않은 같은 글자, 커서가 뒤에 있음,
  `git ` 뒤의 흐린 자동완성, 다른 열, 아래가 규칙선이 아님 — 이런 경우는 모두 진짜 초안으로 보고 손대지 않는다.
  ⚠️ 기존 「preserve my draft」 검사의 초안은 `dim:false`로 바꿨다. 그 검사는 Home에서 규칙선 사이에 놓인 **완전히 흐린** 꼬리를 초안이라고 불렀다.
  그런데 그 모양이 바로 2.1.314의 자리표시자다. 흐리지 않은 초안은 지금도 그대로 지켜진다.
- **키를 친 뒤 확인 못 한 변경은 여전히 요청을 거절한다**(`unconfirmed`). 요청 글자는 하나도 쓰지 않는다. 같은 id는 `rejected`로 남고,
  다시 보내도 거절만 다시 답한다(검사: Claude는 `/effort⏎`만, Codex는 `ESC ,`만 친 뒤).
- **쓰기 울타리 전 거절 = `rejected`**: 입력 제출도 시작 제출처럼, 작성기가 `start` 전에 던지면 영수증을 `rejected`로 남긴다(`refuseUnwritten`).
  여기에는 질문 화면, 오래된 교정, 이미지 경로, 준비 기간 만료가 들어간다. 같은 id 재시도는 그 거절을 다시 답하고 나중에 쓰이지 않는다(`#submitWhole`).
  MCP에서는 NOT_SENT로 남는다. 아무 요청 없이 **만료만 된** 입력 조립은 예전처럼 `prepared`다.
- **클라이언트**: `pendingAfterStatus`는 written과 함께 `rejected`·`held`(=`launchNeverStarted`)도 정리한다. 다만 **written처럼 다루지 않는다** —
  패널 `settleSubmission`과 LAN 페이지는 초안·칩·첨부·브라우저 접근을 그대로 두고 「앞선 요청은 터미널에 입력되지 않았습니다(…)」라고 말한다.
  ⚠️ `pendingAfterStatus`는 LAN 페이지가 소스째 싣는다 — 다른 모듈 심볼을 부르지 말 것.
- **실패 뒤 상태 조회는 한 번, 울타리를 놓은 뒤에**(`statusAfterFailure`): 전송의 `finally`가 `submissionInFlight`를 푼 다음에 같은 id의 읽기 전용
  status를 묻는다. 예전처럼 `catch` 안에서 물으면, 빨리 오는 답이 아직 걸린 울타리 때문에 버려질 수 있었다. 기록은 선택된 세션의 상태가 아니라
  **그 세션의 sessionStorage 키**에서 다시 읽는다. 그래서 응답이 오기 전에 다른 세션으로 옮겨도 원래 세션만 정리된다(수정 전에는 원래 세션에
  울타리가 남았다). `outcomeCheck`를 뮤텍스로 쓰고, 다른 확인이 돌거나 새 전송이 진행 중이면 배너의 수동 확인에 맡긴다 —
  자동 조회는 같은 id에 한 번 이하다. `unknown`·`prepared`·무응답은 울타리를 유지하며 다시 보내지 않는다.
- 팀 작전: 리더의 후속 지시(`workroomTeamHost.instruct` → `submitHostInstruction`)도 같은 쓰기 경로다. 같은 세션 대기열에서 60초씩 밀리던 것이 사라졌다.
- **증거의 종류를 나눠 둔다**:
  - 실기(설치본 기록·시험 세션): `prepared`로 막힌 것은 Codex `b4709981`의 첫 요청, Claude `a862a581`의 두 번째 요청, 리더 `cfdc3925`의 두 번째
    요청(Orchestrating 중)이다. 팀원 `636a4129`의 후속 지시는 written이었다. 시험 세션 `fa7c78b8`에서 C1·C2는 written이었고, C4는 20초 타임아웃·
    `prepared`·0바이트였다. 그 화면에서 `◉ xhigh · /effort`(시작)와 흐린 제안(턴 뒤 4행 2열, 규칙선 사이)을 확인했다.
  - 가짜 PTY만(실제 CLI·모델 없음): 수정 뒤의 모든 흐름 — 4초 뒤 현재 강도로 쓰기와 그 문구, idle Claude 2.1.314에서 자동 변경 적용,
    부분 변경 거절, 진짜 초안 거절, 일하는 리더 3연속과 팀 후속 지시 2개의 순서. **수정본으로 실제 리더·팀원 세션을 돌려 본 적은 없다.**
- 검증: `tests/workroom-submission-effort-gate.test.ts`(실제 서비스·저장소·에포트 런타임, 가짜 PTY 12개 — 수정 전 첫 4개 모두 실패. Claude·Codex의
  진짜 초안·강도 못 읽는 화면의 초안·대기 중 생긴 초안 4개는 작성칸 증명을 끄면 모두 실패, 바꿀 수 없는 CLI의 예전 쓰기 경로 가드 1개),
  `tests/claude-effort-placeholder.test.ts`(2.1.314·Codex 자리표시자 양성/음성, `◉` 피커 왕복), `tests/workroom-cli-commands.test.ts`(`◉` 낱말),
  `tests/workroom-effort-view.test.ts`(바꾸지 않았다 문구·추천 그대로), `tests/remote-control-mobile-submission-never-ran.test.ts`(LAN 상태 버튼),
  `tests/workroom-submission-refusal.e2e.mjs`(실제 React 패널: 거절·유실·새로고침·늦은 거절 중 세션 전환 × 기본 창·팝아웃, 버튼·Enter, 같은 id
  조회 한 번 — 처음 6개는 수정 전 0/6, 세션 전환 검사는 `catch` 안 조회로 되돌리면 2개 모두 실패).
  계약 갱신: `workroom-submission.test.ts`(준비 기간이 지난 쓰기 시작 → rejected), `workroom-submission-attachments.test.ts`(이미지 거절 → rejected),
  `community-submission.test.ts`(rejected·held → 정리).
- 남은 것: Codex 흐린 자리표시자는 실기 미확인이다. 자동 변경 뒤에도 시작 화면의 `◉ xhigh` 줄이 화면에 남아 있으면, 그 줄 때문에 세션이 수동
  설정으로 잡힐 수 있다(실기 미확인). 이번 수정은 설치본에 이미 남은 `prepared` 기록을 고치지 않는다. 새 앱으로 다시 시작하면 이전 부팅의
  `prepared`는 `held`로 읽히고, `held`도 정리 대상이라 상태 확인 한 번으로 풀린다(초안 유지). 그 전에는 「제출 결과 확인」·「터미널 결과 확인했음」을
  사람이 누른다.
### 낮은 워크룸에서 Claude 슬라이더가 열린 채 남았다 · Codex 단축키 거절 (2026-10-31)

설치본 1594의 Codex 클릭 QA에서 Testforcsagents1 새 워크룸 첫 요청이 Claude·Codex 모두 「에포트 자동 변경 결과를 확인하지 못했습니다」로
거절됐다. Claude 터미널은 `Effort · xhigh` 슬라이더에 멈춰 있었다. 세션 크기는 **105×11**이었다(`list_workroom_sessions`).
- **실측(Claude 2.1.314, 별도 tmux 소켓, 요청 없음)**: `/effort`⏎는 「Faster … Smarter」 슬라이더와 한 줄짜리 강도 행
  (`low medium high xhigh max`)을 그린다. 안내 줄 「←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel」은
  **13줄부터** 보이고 12줄 이하에서는 화면 밖으로 잘린다. 60칸에서는 `…s for this session` / `only…`로 접힌다. 키는 그대로다
  (바이너리 기본 바인딩 `s: effortSlider:thisSessionOnly`). `s` 뒤 「Set effort level to medium (this session only)」·`◐ medium · /effort`,
  사람의 `~/.claude/settings.json`은 md5 그대로였다. **Esc 한 번**은 「⎿  Cancelled」를 남기고 강도·빈 작성칸을 되돌린다.
- **안내 줄만이 `s`의 증거다** — 안 보이면 `s`도 Enter도 치지 않는다. 행을 공백으로 이어 붙여 접힌 안내도 읽는다(`claudeSessionOnlyHint`).
  슬라이더가 열렸는데 안내가 25번 읽는 동안 안 보이면 잘린 것으로 본다(한 프레임에 그려진다).
- **열린 슬라이더는 Esc로 닫고, 증명되면 요청을 보낸다**(`cancelClaudePicker`): 슬라이더가 열려 있을 때만 Esc를 치고, 슬라이더가 닫히고
  작성칸이 비고 강도가 `before`일 때만 `unchanged`다. 증명되지 않으면 원래 거절(`unconfirmed`)이다. `s`가 확인되지 않은 경우와 강도
  항목을 못 읽은 경우도 같다. `unchanged`는 내부 결과일 뿐이다 — `runtimeStatus`는 비우고 advice를 남긴다(새 DTO 값 없음, 화면은
  「에포트 자동 · 이번 요청은 변경 안 함」).
- **슬라이더는 구조로만 알아본다**(`claudeSlider`, 같은 날 독립 리뷰): 정확히 「Effort」뿐인 줄 → 4줄 안의 트랙(`───▲───`), 그 아래에 작성칸(`❯`)
  행이 없을 것 — 이것이 「열려 있다」(Esc로 닫을 근거)다. 강도를 **바꾸는** 것은 트랙 바로 아래 강도 행에 low·medium·high가 온전할 때만이다.
  실측(2.1.314, 50·40·34칸): 50칸은 슬라이더가 온전하고 안내만 접힌다. **42칸쯤보다 좁으면 행이 양옆에서 잘린다**(40칸 「aster … Smarte」,
  「ow  medium  high  xhigh  ma」) — 그때는 Esc로 닫고 `unchanged`, **너비만** 기억한다(그 너비 이하에서는 높이와 상관없이 키를 치지 않는다).
  처음 고친 판은 「Faster … Smarter」를 요구해 좁은 화면에서 슬라이더를 못 알아보고 열린 채 두었다. 처음 판정(화면 어디든 `effort` 낱말 + 세 강도가 든 행)은 상태줄 `◉ xhigh · /effort`와
  `const LEVELS = ['low', 'medium', 'high'];` 같은 대화 행을 슬라이더로 읽었다 — 정상 변경을 거절했고, 화살표 수를 그 행으로 셌고,
  슬라이더가 열리지 않았는데 일반 작성칸에 Esc를 쳤다(재현 후 수정). 사용 가능한 강도·「이 세션만」 안내는 **제목 줄 아래에서만** 읽는다.
  ⚠️ 「Adjust effort level」 화면은 실제 Claude에 없다(2.1.309·2.1.314 바이너리에 그 문자열 없음) — 검사 fixture는 실제 슬라이더 모양을 쓴다.
  더 오래된 Claude가 다르게 그리면 슬라이더를 못 찾아 Esc 없이 예전처럼 거절된다(안전한 쪽).
- **Codex**: 0.166은 gpt-6.1-sol에서 `ESC ,`에 「Reasoning shortcuts are unavailable for gpt-6.1-sol.」로 답하고 강도를 그대로 둔다. 바이너리에서 이
  문장은 「Voice set to」 등과 같은 **정보 행**(대화 기록 쪽)이다. 그래서 **문장 하나뿐인 행**(앞에 `•`·`■` 등 글리프 하나 허용)만 거절로 세고,
  흘러나오는 출력이 그 문장을 인용한 행은 세지 않는다. 그 행이 **새로** 보이고, 첫 단계이며, 강도가 `before`이고, 작성칸이 그대로이고,
  **200 ms 뒤 다시 읽어도** 강도가 `before`일 때만 `unchanged`다(적용된 단축키는 하단줄을 조금 늦게 다시 그린다). 「…disabled until startup
  completes」도 `unchanged`이지만 기억하지 않는다.
- **같은 곳에서 되풀이하지 않는다**(호스트 전용 `effortRefusal`, 기록 `workroomEffortRecord`에서 뺀다): 잘린 슬라이더는 그때의 **높이·너비**를
  남기고 그 크기 이하(더 좁으면 안내가 더 접힌다)에서는 키를 치지 않는다. 더 넓거나 높으면 다시 시도한다. 「unavailable for <모델>」은 **모델**을
  남기고 화면 하단줄의 모델이 같을 때만(대소문자 무시 — 0.166 하단줄은 「GPT-6.1-Sol high」, 거절 문장은 「gpt-6.1-sol」) 건너뛴다 — `/model`로 바꾸면 다시 시도한다.
  ⚠️ `~/.codex`의 기본 계정에서는 같은 gpt-6.1-sol에 `ESC ,`가 **먹었다**(실측 2026-10-31, high→medium, 거절 줄 없음). 거절은 워크룸이 고른
  계정 쪽 모델 정보에서 난 것으로 보인다 — 실제 거절 줄의 모양은 아직 캡처하지 못했다(정규식은 QA 인용 문장 기준). 높이만 기억하던 첫 판은 모델이 바뀌어도 막았다.
- **시간 한도**: 준비 대기 4초 뒤 키와 그 증명은 **마감 하나**(6초)를 함께 쓰고, Esc 취소는 따로 1.5초다(`WORKROOM_EFFORT_CHANGE_WAIT_MS`·
  `…CANCEL_WAIT_MS`). 80회 대기 셋을 따로 두면 `s` 실패 뒤 잠만 13.6초로 브라우저 15초 한도에 닿았다. `s` 뒤 확인은 마감이 거의 지났어도
  최소 1초를 받는다(늦게 열린 슬라이더에서 `s` 처리 중에 Esc를 치지 않게).
- 증거의 종류: 슬라이더·안내·Esc는 **실제 CLI**(tmux 프로브)이고, Codex 거절 줄은 **Codex 클릭 QA 화면 인용 + 0.166 바이너리 문자열**이다
  (그 줄의 정확한 위치·글리프는 미확인). 수정본으로 실제 워크룸을 다시 돌린 것은 다음 설치본의 클릭 QA다.
- 검증: `tests/workroom-submission-effort-gate.test.ts`(잘린 슬라이더 → Esc → 요청 한 번, 다음 요청은 키 없음; Codex 거절 → 요청, 다음은 키 없음 —
  수정 전 둘 다 실패), `tests/claude-effort-placeholder.test.ts`(60칸 접힌 안내 → 적용, 105×11 → 취소·높이 기억, `s` 미확인 → Esc 되돌림·증명 없는
  취소는 거절, Codex 시작 전 거절은 기억 안 함 — 수정 전 4개 모두 실패). 리뷰 수정분(같은 파일): 대화 행 「low / medium / high」·`const LEVELS …` 위의
  실제 슬라이더 → 적용, 강도가 모자란 대화 행 → 슬라이더 행으로 화살표 수, 열리지 않은 슬라이더 → Esc 없음, Codex 인용 행 → 거절 아님,
  거절 뒤 하단줄이 바뀜 → 거절(부분 변경), 모델별 기억, 크기별 기억(더 넓으면 다시) — 수정 전 8개 모두 실패.

## 「Hermes · Claude」·「Hermes · Codex」 — Hermes가 어느 모델로 뜨는지 고르기만 하면 된다 (2026-10-25)

**사용자 요청(2026-10-25)**: 「헤르메스는 헤르메스에 코덱스, 클로드 둘다 적용할수있으니 별도버튼으로 만들어져야」 — 초보자가 Hermes를
띄운 뒤 모델을 치는 것이 아니라, 목록에서 **항목 하나를 고르면** 그 provider로 뜬다.

정본 한 곳: `src/hermesVariants.ts`. 두 항목의 모델·provider는 **팀 구성기의 프리셋**(`TEAM_MODEL_CHOICES.hermes`,
`src/workroomTeamInstruction.ts`)에서 그 provider의 **첫 항목**을 가져온다. 프리셋 목록을 고치면 버튼도 같이 바뀐다 — 모델 문자열을
화면마다 적지 않는다.
- `HERMES_VARIANT_PROVIDER`: `claude → anthropic`, `codex → openai-codex`. 자격 판정이 보는 것은 **이 provider 이름뿐**이다.
- `WORKROOM_LAUNCH_CHOICES` / `workroomLaunchChoices(agents)`: `AI_TERMINAL_AGENTS` 순서를 유지하면서 `hermes` **바로 옆**에
  `hermes:claude`·`hermes:codex`를 끼운다. 라벨은 다른 목록과 같은 `WORKROOM_AGENT_NAMES`를 써서 「Hermes · Claude」로 만든다.
- `hermesVariantOf(launchModel)`는 **provider와 모델이 둘 다** 맞을 때만 그 항목이다. 팀원이 고른 다른 Anthropic 모델을
  「Hermes · Claude」라고 적지 않는다(실측: 팀 e2e의 `claude-opus-5` 팀원이 그렇게 보였다).

**자격 판정(비밀값을 읽지 않는 근거)** — `src/hermesProviderCredentials.ts`
- `hermes auth list`의 **머리글 줄만** 읽는다(`anthropic (2 credentials):`). 열 0에서 시작하는 줄만 머리글이고, 자격 행은 들여쓰기가
  있어 통째로 건너뛴다. provider 이름 외에는 어떤 값도 남기거나 돌려주지 않는다.
- `~/.hermes/auth.json`은 **열지 않는다**(그 파일이 토큰 자체다). `hermes auth status <provider>`도 쓰지 않는다 — 실측(2026-10-25)
  존재하지 않는 provider에도 종료 코드 0을 주어 구분하지 못한다.
- 30초 창에 한 번만 묻고(`HermesProviderCredentials`), CLI를 물을 수 없으면 `null`=「모름」이다. 모름은 **「자격 없음」이 아니다**:
  그때는 두 항목을 모두 그대로 제공한다(있는 provider를 없다고 말하지 않는다). 사이드카 쪽 호출은 8초 상한·stderr 버림.
- 화면에는 `{provider} 자격 없음`만 적는다(7개 언어 `hermesVariantCopy`). 자격값·계정·경로는 적지 않는다.

**시작 옵션은 이 Mac 전용** (절대 규칙: 원격 DTO·`AiTerminalSummary`에 키를 더하지 않는다)
- 패널은 보통 start 요청에 `hermesVariant: 'claude'|'codex'` **열거형 하나**를 얹어 로컬 사이드카에 보낸다. 사이드카는
  `splitHermesVariantStart()`로 그 키를 **떼어낸 뒤** 평소대로 `normalizeAiTerminalRequest`에 넘기고, 호스트 전용 `launchModel`로 바꾼다.
- 따라서 `AiTerminalRequest`/`AiTerminalSummary`는 그대로다. 휴대폰·중계 경로가 이 키를 보내면 모르는 키라서 **요청 전체가 거절**된다.
  휴대폰은 지금처럼 Hermes 하나다.
- 분리기는 start·`agent:'hermes'`가 아니거나 `resumeFrom`이 같이 오면 거절한다. 「다시 시작」은 `resumeFrom`으로 호스트의
  이전 세션 `launchModel`을 그대로 이어가므로 변형을 다시 보낼 필요가 없다.
- 이 Mac의 항목 목록·세션별 변형은 터미널 DTO가 아니라 별도 로컬 경로 `POST /api/agent-runtime/hermes-variants`
  (`HERMES_VARIANTS_PATH`, 팀 현황판과 같은 방식)로 읽는다. 브라우저(배포 포털)에서는 묻지 않고 두 항목을 그대로 제공한다.

**보이는 곳**: 워크룸 「새 작업」(`AiWorkRequestPanel`), 워크룸 머리의 「터미널 AI」·「새 창에서 열 AI」(`AiTerminalPanel`),
「이 프로젝트에서 작업」(`ProjectLaunchActions`), 프로젝트 카드의 AI 실행 버튼(`ProjectTerminalLauncher`). 세션 목록·탭은
`workroomSessionLabels(…, variantOf)`로 「프로젝트 · hermes · claude」처럼 보여 Hermes 탭 둘을 구분한다.
`ProjectWorkroomLauncher.open(targetId, agent, bypass, variant)`는 변형을 **재사용 키에 포함**하므로 「Hermes · Claude」가
「Hermes · Codex」 세션을 물려받지 않는다.

**아직 아닌 것**
- 첨부가 있는 start는 접수형 제출 경로(`submitWorkroomDraft`)를 쓰고 그 경로는 변형을 싣지 못한다. 그래서 변형 + 첨부는
  조용히 평범한 Hermes로 뜨는 대신 **사람에게 말하고 멈춘다**.
- 구형 사이드카가 `resumeFrom`을 거절해 예전 방식으로 다시 시작하는 경우에는 변형이 유지되지 않는다(그 사이드카는 이 열거형도 모른다).
- 실제 provider 인증·실제 Claude/Codex 응답은 이 검사 범위가 아니다. 인자는 `aiTerminalLaunchArgs` 검사와 팀 e2e의 가짜 CLI
  출력(`MODEL:gpt-6.1-sol:openai-codex`)으로만 확인했다.

검사: `tests/hermes-variants.test.ts`(프리셋 한 곳·목록 순서·라벨·열거형 거절·분리기·DTO 거절·정규화·자격 머리글 파서·30초 창),
`tests/workroom-team-e2e.test.ts`(실제 사이드카: `hermesVariant` start → 가짜 Hermes CLI가 받은 모델·provider, 로컬 경로의 세션 변형,
다른 AI·모르는 값·`resumeFrom` 400), `tests/ai-work-request.e2e.mjs`·`tests/project-launch-actions.e2e.mjs`(실제 React: 두 항목이
목록에 있고 자격 없는 쪽은 고를 수 없으며 start가 `hermesVariant`를 싣는다).

## 워크룸 터미널 질의는 호스트가 한 번만 답한다 (DA·CPR, 2026-10-09)

CLI가 터미널에 묻는 것(「너는 어떤 터미널이냐」 DA, 「커서가 어디냐」 CPR `CSI 6 n`·DECXCPR `CSI ? 6 n`)에는 **사이드카의
headless 화면(`AiTerminalScreen`)이 PTY 자신의 크기로 답한다** — 보는 화면이 있든 없든. 정본은 `src/aiTerminalScreen.ts`(답)·
`src/aiTerminalReplyFilter.ts`(중복 제거)·`src/aiTerminalDeviceAttributes.ts`(브라우저용 정규식)다.

- **DA**: agy가 시작 때 `CSI > c`를 묻고 답이 올 때까지 아무것도 그리지 않았다(3호, 2026-10-07).
- **CPR**: Codex 0.160은 **PTY 크기가 바뀔 때마다** `CSI 6 n`을 한 번 보내고 답을 최대 2초 기다리는 동안 키를 처리하지 않는다.
  휴대폰은 입력 직전에 자기 크기를 주장(resize)하므로, 본문과 150ms 뒤의 Enter가 그 2초 안에 쌓였다가 한 번에 읽혔고 Codex의
  paste-burst 규칙이 Enter를 줄바꿈으로 바꿔 **요청이 입력칸에 남았다**(TestFlight 712, 7회 중 2회). 실제 Codex 0.160을 격리 HOME·
  가짜 응답 서버로 돌려 확인했다: 답이 없으면 늘이기·줄이기·폭 변경 모두 0/6 제출, 호스트가 답하면 36/36. 줄이기도 실패한다 —
  실기에서 줄이기가 괜찮았던 것은 입력이 2초 뒤에 도착했기 때문으로 보인다(미확인). 답은 질의 뒤 1~4ms에 나간다.
- 예전에는 「CPR 답은 Shift/Ctrl+F3(`CSI 1;m R`)과 모양이 같다」는 이유로 DA만 답했다. 그 모호함은 **키보드가 있는 화면**의 문제다 —
  headless 사본에는 키보드가 없으므로 그 답은 프로그램이 보낸 질의에 대한 것일 수밖에 없다.
- ⚠️ **답은 하나여야 한다.** crossterm은 청하지 않은 CPR을 버리지 않고 쌓아 두었다가 **다음 질의의 답으로 쓴다**(중복을 보내
  보니 27회 중 25회 낡은 좌표를 읽었다). 그래서 보는 쪽(직접 입력 모드의 패널, 모든 응답을 보내는 LAN 페이지, 옛 출력 재생)이
  보낸 DA·DECXCPR·CPR 답은 **호스트 입력 경로에서 지운다**(`stripViewerTerminalReplies`). 붙여넣기(`ESC[200~…ESC[201~`) 안은
  요청을 넘어가도 건드리지 않는다. `CSI 1;m R`(m 2–16) 모양은 Codex 세션이거나 호스트가 30초 안에 CPR에 답했을 때만 답으로 본다 —
  그 밖에는 진짜 F3 키로 남긴다. 지우고 남은 것이 없으면 아무것도 쓰지 않고 입력 리비전도 올리지 않는다.
- ⚠️ **한 세션의 입력 요청들은 하나의 흐름으로 읽는다.** 클라이언트는 큰 묶음을 4096바이트/JSON 7500자에서 escape와 상관없이
  자른다(`splitTerminalInput`, LAN 페이지). 그래서 붙여넣기 끝 표지가 두 요청에 걸치면 앞 요청만 보고는 붙여넣기가 계속 열린 것으로
  읽혀 그 뒤의 중복 답이 모두 지나갔다(리뷰 재현: 4,085–4,089자 붙여넣기). 지금은 열린 붙여넣기의 끝 몇 글자(`tail`)로 잘린 끝
  표지를 찾고, 1024자 이상인 요청(= 잘린 앞부분)의 끝에 남은 미완성 escape(`ESC`, `ESC[…`)는 잡아 두었다가 다음 요청 앞에 붙인다
  (`held`). 1024자보다 짧은 요청 끝의 `ESC`는 진짜 Esc 키라 잡지 않는다.
- ⚠️ **호스트의 답은 보는 쪽 붙여넣기 한가운데로 들어가면 안 된다.** 답은 세션 FIFO를 거치지 않고 바로 쓰이므로, 여러 요청에 걸친
  붙여넣기 사이에 크기 변경이 끼면 답이 붙여넣은 글자가 됐다(리뷰 재현). 쓴 바이트 기준으로 CLI가 보는 쪽 붙여넣기 안에 있는 동안
  (`ptyInViewerPaste`) 답은 쌓아 두고(최대 8개), 붙여넣기를 닫는 쓰기 바로 뒤에 쓴다.
- ⚠️ **보는 쪽에서 CPR 답을 막지 말 것.** 옛 Mac(답하지 않는 호스트)에서는 직접 입력 모드의 늦은 답이 유일한 답이다 — 답은 직접
  입력 중인 보는 쪽 수만큼(0개면 Codex가 크기 변경마다 최대 2초 멈춘다). 그래서 **휴대폰 제출 문제는 Mac 앱 업데이트로만 고쳐진다**.
  새 Mac에서는 호스트가 답하고 보는 쪽 중복을 지운다. 화면 쪽에 새 키·기능 플래그를 더하지 않았다(옛 휴대폰 정규화기 호환).
- xterm.js는 줄 끝에서 줄바꿈이 대기 중일 때 열을 cols+1로 보고한다 — 실제 터미널처럼 마지막 열로 자른다.
- 여전히 답하지 않는 질의: DSR5, DECRQM, DECRQSS, OSC 색 질의, XTVERSION, kitty `CSI ? u`. 필요해지면 같은 두 곳(답·중복 제거)을 함께 넓힐 것.
- Hermes는 POSIX에서 prompt_toolkit CPR을 끄고(`enable_cpr=False`) hermes-ink는 묻지 않는다. Claude Code는 iTerm/Terminal에서만
  DECXCPR을 묻는다. agy 바이너리에는 `CSI 6 n`이 있다. Windows(ConPTY)에서 질의가 출력으로 지나오는지는 2호에서 아직 재지 않았다.
- 검증: `tests/ai-terminal-cursor-position.test.ts`(크기 변경 뒤의 좌표·열 자르기·중복 제거·붙여넣기 보존·실제 PTY, Codex처럼
  2초를 기다리는 가짜 CLI로 늘이기·줄이기·폭 변경 직후 입력이 제출되는지 — 수정 전 코드에서는 0/3, 4 KiB 분할에 걸친 표지·답,
  붙여넣기 중 질의의 답 위치, 본문 직후 300ms 정지에도 Enter가 따로 읽히는지 — 앞 셋은 흐름 처리 전 코드에서 실패),
  `tests/ai-terminal-device-attributes.test.ts`. 실제 Codex 0.160(격리 HOME·가짜 응답 서버)으로 브랜치 코드 그대로 60/60 제출.

## 워크룸 「다시 시작」·이미지 넣기 (VOC 2026-10-02)

화면이 깨지거나(CLI 입력칸에 `PPPP)))`·`용용용…`이 쌓인 채 멈춤 — 제출된 메시지에는 없었다) 끝난 CLI를 되살릴 방법이
없었고, 다른 앱 화면을 워크룸 요청에 넣을 방법도 없었다. 둘 다 **Mac 화면(메인·팝아웃) 전용**이고 휴대폰에는 없다.

- **「다시 시작」 = `start` + `resumeFrom: <이전 세션 id>` 한 번.** 호스트가 ① 그 CLI가 **아직 살아 있을 때** 어떤 대화를
  돌리는지 읽고(`src/aiTerminalResume.ts`) ② 이전 세션을 닫은 뒤 ③ 같은 프로젝트·AI·**그 세션의 권한 모드**로 새 CLI를 띄운다.
  응답의 `resumed`(이 요청에만 실림)가 이어 열었는지를 말한다. `resumeFrom`에는 prompt·references·bypassPermissions를 함께 보낼 수 없다.
  호스트는 원격 권한(authority)이 붙은 `resumeFrom`을 거절한다 — 원격 프로토콜이 같은 검사기를 재사용하기 때문이다.
- **Claude는 `--resume <대화 id>`(fork 없이)**. `--session-id`와 `--resume`은 `--fork-session` 없이 함께 못 쓰는데(바이너리 규칙),
  fork는 이전 발언을 새 파일로 복사해 「내가 한 말」에 **두 번 저장**된다(기록 ID = 파일+줄 번호). 그래서 새 워크룸 id ≠ Claude 대화 id가
  되고, 호스트가 세션별 `conversationId`를 따로 들고 있다(두 번째 재시작도 처음 대화를 잇는다). 워크룸 id는 기억 대기열의 키일 뿐이라 문제없다.
- **Codex는 `codex resume <thread>`**. 대화 id는 실행 중인 프로세스 그룹이 잡은 `~/.codex/thread-writer-locks/<id>.lock`
  (`lsof -Fn -g <pgid>`, 실측 46ms)으로 정확히 안다. 기록 파일(rollout)은 **첫 메시지 때** 생기고 이어 쓴 대화는 원래 날짜 폴더에 남으므로,
  저장 여부는 날짜 범위 없이 찾는다. 이미 끝난 세션은 같은 폴더·CLI·시간 창의 rollout이 **정확히 하나**일 때만 잇는다.
- ⚠️ **저장된 대화가 없으면 이어 열지 않는다** — 두 CLI 모두 빈 대화를 resume하면 바로 종료해서, 살아 있던 세션을 죽은 세션으로 바꾼다.
  모든 불확실성은 새 대화로 떨어지고 안내가 `/resume`을 알려 준다. 이어 열지 못한 이전 세션은 일반 종료처럼 기억 대기열에 들어간다
  (이어 연 세션은 대화가 끝난 게 아니라서 넣지 않는다). Hermes·agy는 항상 새 대화다.
- 옛 사이드카가 `resumeFrom`을 「허용되지 않은 터미널 요청」으로 거절하면 클라이언트가 닫기 + 일반 시작으로 후퇴하고 그렇게 말한다.
- **이미지**(사진·파일 첨부·끌어 놓기 전체는 아래 「워크룸 첨부」 절): 입력칸 ⌘V 붙여넣기(Shottr 등으로 클립보드에 찍은 것) · 「화면 캡처 ▾」 메뉴의 「영역 캡처 ⌥⌘4 / 창 캡처 ⌥⌘5 / 전체 화면 ⌥⌘3」
  (워크룸이 앞에 있을 때만 — macOS ⇧⌘·Shottr 전역 키와 겹치지 않게). 정본은 `src/workroomImages.ts`(호스트)·
  `src/workroomImageAttachments.ts`(화면)이고 경로는 `POST /api/agent-runtime/terminals/images`(`save`/`capture`)다.
  파일은 **프로젝트가 아니라** 앱 데이터 `workroom-images/YYYY-MM-DD/`(0600, 14일 뒤 정리)에 두고, 요청 끝에
  `[첨부 이미지 N개 — 각 파일을 열어 확인하세요]` + 절대 경로 줄을 붙인다 — Claude는 Read, Codex는 view_image로 연다.
  형식은 바이트로 판정한다(PNG·JPEG·GIF·WebP·HEIC, 15MB).
- 캡처하는 동안 **앱 전체를 숨긴다**(⌘H처럼 — 팝아웃만 숨기면 메인이 대상을 가린다). Rust 커맨드 `workroom_capture_hide_app`
  (main·`workroom-*`만)로 하고 capability는 넓히지 않았다. 화면 기록 권한이 없으면 PNG가 아닌 결과를 지우고 그 권한을 안내한다.
- Rust 프록시는 이 경로만 요청 21MB·응답 대기 310초(capture)/30초(save)를 준다(`agent_runtime_request_max_bytes`) — 다른 요청은 256KB 그대로.
- 함께 들어온 역벤치마크(NHCS 0.10.0 터미널 창): 새 CLI는 100×28이 아니라 **그 창이 마지막으로 맞춘 크기**로 시작하고,
  Dock에서 연 앱은 locale이 없어서(실측: 워크룸 Codex env에 PATH·TERM뿐) `LANG`·`LC_ALL`·`LC_CTYPE`이 모두 없을 때만 `LANG=en_US.UTF-8`을 준다.
  보기 줄은 최소 창(800px·125%)에서 넘치지 않게 줄바꿈한다.
- **입력칸에서도 CLI 키가 된다**(VOC 2026-10-02, NHCS 0.10.1 `draftKeyToCli`와 같은 규칙, 정본 `src/workroomComposerKeys.ts`):
  입력칸이 **비어 있으면**(글·이미지·`@` 받는 곳 모두 없음) 방향키·Tab/Shift+Tab·Enter·Backspace·Delete·Home/End·PageUp/Down이
  CLI로 가고, Esc·Ctrl+C는 언제나 간다. 글이 있으면 예전처럼 입력칸을 편집·전송한다. ⚠️ `@`/`#`/`/` 후보 목록이 떠 있을 때의 Esc는
  보내지 않는다(목록에서 나가려다 작업 중인 AI를 멈추게 된다). 자동 반복된 Backspace/Delete는 보내지 않는다(입력칸을 지우던 반복이 CLI 입력까지 지운다).
  ⌘/⌥ 조합과 IME 조합 중(`isComposing`·keyCode 229)은 손대지 않는다. 화살표는 DECCKM을 따라 하단 키 버튼과 같은 바이트다.
- 검증: `tests/workroom-composer-keys.test.ts`, `tests/ai-terminal-resume.test.ts`(인자·Claude 기록·Codex 잠금·rollout 유일성), `tests/ai-terminal-restart.test.ts`(실제 PTY로
  재시작·권한 모드 유지·두 번째 재시작·원격 거절·LANG), `tests/workroom-images.test.ts`, Rust `workroom_images_use_exact_post_route…`,
  `node tests/workroom-restart-images.e2e.mjs http://127.0.0.1:<vite 포트>`(버튼·확인창·옛 Mac 후퇴·붙여넣기 칩·⌥⌘4·휴대폰에 없음).
## 워크룸·OPS 손질 (VOC 2026-10-04)

- **OPS 워크룸이 Codex로 고정돼 있었다.** 음성 경로는 이미 저장된 선택(`readOpsLaunchPreference`)을 따르는데
  `App.tsx`의 `openOpsWorkroom`만 리터럴 `'codex'`였다. 그래서 「아젠투지 설정」에서 Claude·Hermes·
  Antigravity를 골라도 버튼은 Codex를 열었다. 두 경로가 같은 파일을 읽는다 — 판정은
  `opsWorkroomAgentFrom`(`src/opsLaunchPreference.ts`) 한 곳이고, 읽기 실패·손상은 codex로 떨어진다.
  실행 중인 OPS 세션이 있으면 AI를 가리지 않고 그것을 재사용하는 동작은 그대로다.
- **「세션 기억하기」는 살아 있는 CLI에 그 CLI의 명령을 입력하고 Enter까지 보낸다**
  (`workroomMemoryCommand` — claude `/remember-session`, hermes `/remember_session`). 대화 맥락을 가진
  주체가 쓰는 것이 더 정확하다. ⚠️ **codex·agy에는 그런 슬래시 명령이 없으므로 기존 초안 경로를 유지한다** —
  없는 명령을 입력하면 그대로 글자가 남는다. 라벨이 무엇이 일어나는지 말한다(「이 세션에서 기억하기」 /
  「세션 기억하기…」). 하단 「지금 저장」은 **별도 프로세스**로 저장하는 다른 일이라 지우지 않는다.
  원격(휴대폰) 버튼은 초안을 그대로 둔다 — 보고 있지 않은 화면에 눈먼 입력을 하지 않는다.
- **「저장 상태 확인」은 저장 중에 조용히 빠졌다.** `refresh()`가 `flight`·`saveFlight` 중이면 그냥
  return하므로, 정작 누를 이유가 있을 때 아무 반응이 없어 고장으로 읽혔다. 이제 그 자리에
  「저장 요청이 진행 중입니다」를 말한다(`workroom-save-check-notice`).
- **「새 작업 요청 작성」은 Mac에서 새 창을 연다**(`workroom-new-window`). 같은 프로젝트·같은 AI로 깨끗한
  세션을 하나 더 띄운다 — Mac의 실행은 원래 첫 턴부터 전용 창이었다. ⚠️ **휴대폰은 접기 토글을 유지한다** —
  릴레이가 그 페이지에 묶여 있어 두 번째 창이 아무것도 몰 수 없다. 작성 중인 글이 있으면 토글로 돌아간다.
- **「이 기기에서 공개 중」 체크박스가 실제 등록 상태를 반영한다.** 예전에는 선택이
  `useState<string[]>(['ops'])`로 하드코딩돼 `status.enabled`와 한 번도 동기화되지 않아, 여러 개가 등록돼
  있어도 머리글이 항상 「1/101개 선택」이고 OPS만 연결된 것처럼 읽혔다. 판정은
  `src/agentDialoguePublishRows.ts` 한 곳이고 체크 = 공개 상태 그 자체다. ⚠️ **해제는 파괴적이다** —
  endpoint가 폐기되고 다시 켜면 새 `endpointId`라 걸려 있던 초대·대화방·페어링이 따라오지 않는다. 그래서
  행마다·전체 해제마다 확인을 받는다. 앱 목록에 없는 공개 대상도 행으로 남겨 끌 수 있다(`missing`).

## Workroom browser chrome

- 네이티브 페이지는 React 위에 그려진다. 소유권 테두리는 슬롯 밖에 두고, 메뉴·다른 대화창이 열리면 페이지를 숨긴다. 슬롯의 위치·크기는 애니메이션하지 않는다.
- 페이지 상단은 소유권·로딩·알림·오류·활동 펼침으로 움직이지 않는다. 패널 자체를 스크롤해 맞추지 말고, 작업용 6개 탭과 주 동작이 있는 기본 자동 배치에서 800×814 창의 페이지 높이 200px·패널 점유율 65%를 검사한다. 사람이 높이를 직접 줄인 상태는 페이지 200px와 실제 chrome을 하한으로 유지한다.
- **크기 조절(2026-10-25 후속):** 기존 800×814 production UI에서 좌우 전체 이동이 21.95px이고 세로 handle이 없음을 실제로 확인했다. 작은 창을 50/50 근처에 고정하던 JS/CSS 바닥을 terminal `min(160px,25%)`·browser `min(220px,30%)`로 함께 낮췄다. `workroom-browser-divider`(vertical)는 좌우 5%·Home/End·더블클릭 50%, 새 `workroom-browser-height-divider`(horizontal)는 위아래 20px·Home/End·더블클릭 자동 높이 복원을 제공한다. 세로 handle은 browser panel 아래에 있으며 browser 보기의 작성칸 앞과 split browser 열에서 모두 작동한다. 후속 실제 UI에서 가로 이동 325.19px, 높이 500.03→376px(124.03px 감소)을 확인했다.
- 양축 설정은 `agentstoz.workroomBrowserSplit`·`agentstoz.workroomBrowserHeight`에 세션별 최근 8개만 보존한다. 드래그 중 native shield를 유지하며 pointerup에서 저장한다. pointercancel/capture 유실/blur/resize/Escape/뷰·세션 전환/숨김/unmount는 이전 설정으로 복원하고 capture·listener·shield를 해제한다. 기본 자동 배치와 작성 내용·실제 작업의 보존을 없애지 않는다.
- 실제 native가 기본 자동 높이 **190.44px(<200)**를 잡았다. 페이지+chrome 최소치를 panel·column·Frame의 자동 배치에도 적용하고, 가용 높이는 실제 grid 행·handle·content inset·viewport로 계산한다. 가용 범위 0이면 조절을 잠근다. 최소 높이 수정 직후의 이전 QA 배율에서는 원래 800×814 native 창의 페이지 **202.04px**를 확인했다. 양축 변화 검사용 임시 창 확대는 QA window의 안쪽 크기·배율 조회와 크기 변경 3개 권한에만 한정하며 검사 뒤 원래 크기를 복구한다.
- **검색 정규화와 제출은 별도 경계다:** 현 개발 코드의 단어→Google URL 정규화는 기존에 정상 동작했다. 새 보강은 IME 조합 확정 Enter의 제출을 막고 제출 시 입력 DOM의 최신 값을 사용한다. 이를 검색 기능의 신규 구현이나 설치본 실패 원인 확정으로 기록하지 않는다.
- 확인하지 못한 결과는 사람이 직접 확인하고 정리한다. 자동 재전송하지 않는다. 한 번의 넘기기는 새 관찰 뒤 한 번의 grant만 작성칸의 전용 경로로 전달한다.
- `workroom-browser-craft.mjs`는 실제 production frame·키보드·computed style을 Chromium/WebKit에서 검사하고 native·broker는 합성 응답을 쓴다. 설치 CEF·실제 계정 성공과 구분한다. `CRAFT_SHOTS=/tmp/<폴더>`로 저장소 밖에 비교용 화면을 남긴다.
- CSS 토큰 계약은 기존 browser 계약 묶음에 자동 포함되며 layout·craft는 기존 `web-workroom` 안에서 순서대로 돈다. 검사 ID·프로필·승인되지 않은 페르소나를 추가하지 않는다.
- 후속 layout은 Chromium/WebKit **16/16**(`/tmp/agentstoz-browser-resize-layout.log`), 검색 owned scenario 12는 **2/2**(`/tmp/agentstoz-browser-search-owned.log`, `connectedTo` 단언 유지), source 계약은 **20파일 240 pass / 0 fail / 173121 expects**(`/tmp/agentstoz-browser-bun-contracts-20261025-144300-rerun.log`)다. 대형 presentation 행렬 한 개는 격리 653ms 통과·병렬 GUI 부하 6060ms timeout을 확인해 기능 단언을 유지하고 timeout만 5→15초로 늘렸다. OS IME와 실제 외부 Google 접속은 미검증이다.
- Cmd-L 수정 전 실제 native는 **main 26개까지 통과**해 양축 resize·임시 창 확대/원상복구·native 정렬/가시성·refused/blocked/popup을 확인했지만 **작성칸 기원 Cmd-L의 주소창 포커스 전달은 실제 실패**했다(`/tmp/agentstoz-native-composer-shortcut-before-fix.log`). 앞선 native 38/38은 resize 전 preflight이고 후속 layout·계약 결과도 이후 자동 높이·Cmd-L 변경 전체의 최종 판정을 대신하지 않는다.
- **Cmd-L native 전달 수정:** 원시 `NSEvent` 재전송을 제거했다. CEF의 최신 human 소유·focus·visible와 session/tab/target을 확인하고, 허용한 key와 식별자만 신뢰된 WK UI의 `CustomEvent`로 보낸다. Owned는 현재 session·active tab·known target·visible 및 기존 owner/phase gate를 재검사한다. DOM terminal guard는 유지하고 Cmd-L만 WK 포커스로 이동한다. Cocoa는 WK 문서 포커스 복귀 뒤 rAF에서 한 번 전달하며 최대 200ms·새 입력·창 blur의 취소와 정리를 적용한다. native source 단위 **31 pass / 511 asserts**와 clang ARC·Werror가 통과했다. passive 관찰자로 event·주소 focus 각 1회, 초안 보존과 key 주입 0을 확인했다. ARIA·최종 QA 배율까지 포함한 실제 native 결과는 아래와 실행 기록에서 구분한다.
- **최종 native 38/38:** ARIA min/max/now의 반올림을 일치시킨 Home/End 범위 검사와 새 QA 배율을 포함한 재빌드가 통과했고 `sourceVerified`·`cleanExit`는 true다(`output/workroom-browser-native-qa/report.json`). OS 화면 제한을 피하는 QA 전용 500×550 logical·zoom 0.625와 렌더 전 실측 content-size 보정(최대 3회)으로 CSS 800×814를 맞추며 titlebar 높이를 가정하지 않는다. 페이지 200px·양축 40px·원래 PhysicalSize 복구 단언은 유지하고 일반 앱 배율·호스트 해상도·권한 범위를 바꾸지 않는다.
- **최종 craft·A2:** `/tmp/agentstoz-browser-craft-release-review.log`의 matrix120+locale12+extended72, 합계 **204사례**가 통과했고 `/tmp/agentstoz-browser-craft-release-review-1519`에 **206 PNG**를 저장했다. en/de/ja 확장 각 24장(72장)과 root 대표 4장을 실제로 열람했다. 전체 206장 직접 검토나 정적 이미지의 탭 스크롤·tooltip·키보드·드래그 동작 검증으로 확대하지 않는다.
- 사용자 제보의 설치 앱은 **1263.0.0**이며 위 resize/search·native 단축키 변경은 아직 미반영이다. native 변경은 UI 새로고침으로 적용되지 않아 QA/helper 재빌드가 필요하다. OS IME·외부 Google 접속은 미검증이다. 전체 verify는 소스 35파일 지문 `33707dc9bdddf3ba88da7097a4629185832e42191c642383b92b730ca4f12a5e`로 동결해 exit 0으로 완료했다(Python 131개, TypeScript exit 0, Bun 8601 pass / 0 fail / 10 skip, Rust 120 pass / 0 fail). 검증 후 결과 문서만 갱신했으며 normal profile·configured personas는 후속 영수증에서 확인한다. 이전 중단·실패를 pass로 읽지 않는다. [실행 기록](../design/browser-workroom-craft-2026-10-25/EXECUTION.md)과 최종 `output/browser-workroom-verification-final.json`에서 실제 영수증을 확인한다.
- **800×814 나란히 보기의 chrome 예산(2026-10-28):** native QA가 창을 키웠다가 원래 크기로 되돌리는 단계에서 페이지를 trusted UI 위로 28.8px 밀어 실패했다(frame 아래 815.2 > 814, `.ai-terminal-panel` scrollHeight 729 > clientHeight 685). chrome을 두 번 센 것이 아니다 — 하한은 200 + panel chrome 158.8, 여기에 handle 8 + 전환 줄 51.2를 더한 418.2px로 맞다. 본문(456px)이 그만큼을 줄 수 없었다: 줄바꿈된 세션 머리줄 114px와 gap 8px를 빼면 314px였다. 두 가지로 고쳤다. ① 나란히 보기의 「터미널/나란히/브라우저」 전환은 페이지 열 위가 아니라 터미널 열 머리에 겹친다(`WorkroomBrowserFrame.tsx`·`.css`). panes의 첫 자식이라 Tab 순서(전환 → 페이지 열)가 그대로이고, grid 1열 1행에 놓이며, 터미널 열은 측정한 높이 + 8px(`--workroom-browser-switch-block`)의 투명 border-top 아래에서 내용을 시작한다. 그래서 터미널 열 상자는 페이지 상단과 같은 높이에서 시작한다(기존 `stack.top≈browser.top` 단언 유지). 브라우저 보기에서는 전환이 페이지 위에 남고, 터미널 보기는 display:contents라 배치가 예전과 같다. ② 브라우저를 연 전용 표면(dialog·popout)에서 세션 머리줄은 한 줄이다(`AiTerminalPanel.css`) — view controls는 줄바꿈 대신 가로로 스크롤하고 세션 이름이 먼저 줄어든다. 재빌드한 native 실측: 머리줄 114→52px, 페이지 217.2px, 높이 범위 359–376(이제 조절된다), 모든 조상 scrollTop 0. 확대(800×1454)·수동 최소/최대·복구에서도 frame·panel·slot·handle가 모든 clip 상자 안에 있었다.
- **값싼 재현:** `tests/workroom-browser-layout.mjs`의 native mirror 시나리오가 native fixture의 chrome을 Chromium/WebKit에서 그대로 만든다. mount 전 16px 글꼴, 실행 중 워크룸 2개, `임시 실제 PTY 워크룸`, 빈 팀 장부, account manager 없는 QA 호스트의 계정 거절(머리 알림), 사람 초안과 grant chip이 그 내용이다. 각 부분이 자기 clip 조상(overflow≠visible)의 padding box와 viewport 안에 있는지, dialog content·panel·workspace·body의 초과 스크롤이 2px 이하인지, 페이지 200px 이상·native rect = slot·머리줄 한 줄인지를 본다. native와 같은 확대 → 양축 키보드 → 더블클릭 복원 → 원래 크기 왕복도 돈다. 수정 전 같은 stub의 probe에서는 body가 31px 넘쳤다 — 이 검사가 있었다면 native 전에 잡혔다.
- **native fixture 계측:** `assertFloorInView`는 viewport뿐 아니라 모든 clip 조상(panel의 overflow:auto, dialog의 overflow:hidden)의 padding box를 본다. 기본·확대·수동 높이·복구 단언 전에는 `settle`이 같은 기하(네 부분 rect 0.5px 반올림 + 조상 scrollTop + viewport)가 연속 세 프레임 반복될 때까지 기다린다. 고정 sleep이 아니며, 가로 단계의 rAF 두 번 대기도 이것으로 바꿨다. 단계별 geometry probe는 `qa_log`(호스트가 `ATZ_NATIVE_QA_PROBE:` 한 줄로 출력, 16000자 한도)로 나가고, runner가 마지막 24줄을 `report.json`의 `processReports[].probes`에 성공·실패 모두 담는다 — WKWebView console은 전달되지 않는다. probe와 실패 보고의 `layout`(조상 체인·body/panel 자식 포함)에는 기하만 넣고 글·입력값·접근 정보는 넣지 않는다.
- **QA 창 노출:** 호스트는 시작할 때 창을 가운데 두고, 모든 Space에서 일반 창 위에 띄운 뒤(always-on-top·visible-on-all-workspaces) show·앱 show·focus한다. 가려지거나 숨은 WKWebView는 requestAnimationFrame을 멈추기 때문이다. focus는 macOS 협력 활성화가 거절할 수 있어 best effort다. 프레임이 멈추면 fixture가 `qa_raise`(같은 raise 뒤 visible/focused/minimized를 돌려준다)를 부르고 같은 5초 예산 안에서 다시 기다린다. 끝내 멈추면 `Native QA viewport animation frames were suspended` 문구에 `visibilityState`·`hasFocus()`·raise 결과가 함께 남는다.
  띄움은 **되찾는 동안만** 유지한다(2026-10-28 검토): 800×814 보정이 끝나 프레임이 오면, 그리고 멈춘 프레임이 raise 뒤 돌아오면 fixture가 `qa_lower`로 두 설정을 끈다. 창은 앞에 남은 일반 창이 되고, 약 65초 동안 사람의 다른 창을 모든 Space에서 덮지 않는다. 보정 뒤 단계는 E3 이전처럼 띄움 없이 돌며, `frames()`를 쓰는 대기(보정·settle)는 멈추면 다시 띄운다. 이 변경 뒤의 실제 native 재실행 결과는 아래 결과 줄이 아니라 그 실행의 `report.json`으로 판정한다.
- **결과(2026-10-28):** `bun tests/workroom-browser-native.mjs --build` 한 번에 main 32·cold 2·slow 4·lost 2, 합계 **40/40**이 통과했고 `sourceVerified`·`cleanExit`는 true다(`output/workroom-browser-native-qa/report.json`, 단계별 probe 포함). layout은 Chromium/WebKit **22/22**(native mirror 포함), craft·screen·owned-requests 통과, browser 단위 229 pass / 0 fail, tsc 0이다. 설치 앱 반영과 사람의 화면 확인은 하지 않았다. 확대 창의 자동 높이에서 `aria-valuenow` 965가 `aria-valuemax` 964를 넘는 반올림 불일치가 probe에 보였다 — 고치지 않았다.
- **키보드 포커스·ARIA 검토 수정(2026-10-28):** ① 전환은 브라우저 보기에서 section 자식, 터미널·나란히 보기에서 panes 자식이라 그 사이를 오가면 remount되어 포커스가 문서(body)로 떨어졌다. 내 Chrome 소스에는 포커스를 받을 주소창이 없어 키보드 사용자가 dialog 맨 앞부터 다시 Tab해야 했다. `chooseView`는 rAF에서 주소창(내장 브라우저)이 있으면 그것을, 없으면 누른 보기 버튼을 포커스한다. 포커스가 이미 다른 요소로 옮겨 갔으면 건드리지 않는다. ② 한 줄 세션 머리줄은 가로 scroller라 맨 오른쪽 control(「새 창으로 분리」)의 2px ring + 2px offset 오른쪽이 모든 폭에서 잘렸다. 머리줄에 사방 4px padding을 주고 같은 음수 margin으로 body padding에서 되돌린다. 브라우저는 32px 넘게 보이는 control에 포커스가 와도 스크롤하지 않기 때문에(800px에서 66%만 보임) frame이 키보드 포커스(`:focus-visible`)일 때만 머리줄을 ring까지 보이게 민다. 포인터 포커스는 click이 다른 버튼에 떨어질 수 있어 밀지 않는다. ③ 자동 높이의 `aria-valuenow`는 패널의 반올림 전 높이이고 max는 floor라 .5 이상의 소수에서 now가 max보다 1 컸다(native 965 > 964, 800×814 mirror 388 > 387). now를 [min, max(min,max)]로 자른다. 회귀: `tests/workroom-browser-layout.mjs` 마지막 시나리오(Chrome 소스의 여섯 보기 전환 포커스, 내장 브라우저 주소창, 1280·800px 머리줄 ring)와 native mirror의 모든 단계·817–843px 자동 높이 범위 검사. 수정 전 소스로 돌린 변형에서 셋 다 실패했다.
