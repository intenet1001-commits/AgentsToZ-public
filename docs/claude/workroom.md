# 워크룸 — 팝아웃 · 활동 상태 · 에포트 · Hermes 변형 · 터미널 질의 · 다시 시작

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
  기록·화면에는 tier 없는 level로만 보이고 배지는 「에포트 고정 · <강도>」). 자세한 것은 `mcp-ops.md` 「팀 작전」.
- **팀 실행 위치와 현황**(2026-10-25): 구성기와 MCP는 같은 `teamLaunchOptions.ts` 카탈로그·parser를 사용한다. 지원 위치별 옵션을 지시문의 version 1 선택 블록에 보존한다.
  팀 현황(`WorkroomTeamStatus`, Mac)은 내부 세션 상태와 외부 실행 위치·전달 상태·수동 확인 출처를 구분한다. 리더는 지시문 복사·시작/전달 확인·옮긴 보고를 기록할 수 있다.
  외부 창 열림·prefill·복사만으로 작업 중이나 완료로 판정하지 않고, 연결 대기·수동 합류·응답 대기·미확정으로 남긴다. 외부 위치의 모델/에포트/계정 선택은 현재 제공하지 않는다.
  실제 read/send/reveal, 초기 지시 한 번 전달, 재시작 후 자동 재실행 금지는 [mcp-ops.md](mcp-ops.md) 「팀 실행 위치·영수증」을 따른다.
- **자연어 MCP의 AI 선택**(2026-10-25): `agentstoz_use_prepare_agent_launch`에서 AI → 실행 위치 → Hermes 기본/Claude/Codex 중 미정만 질문한다.
  agent 이름만으로 앱·터미널·워크룸을 정하지 않으며, 연결 클라이언트는 답 전까지 실행하지 않는다. 값이 모두 알려진 prepare도 비실행이다.
  사람이 명시한 값과 실제 버튼·팀 선택 블록을 유지하고, 실행 도구 이름이나 호출 중인 AI를 선택 증거로 삼지 않는다. 명시적인 위임 범위 밖에서 자동 선택하지 않는다.
  Hermes의 model/provider 고정 변형은 현재 워크룸만 지원한다. 외부/app 불가 조합은 이유와 대안을 알리고 답을 기다리며 워크룸으로 자동 대체하지 않는다.
  start/open에는 선택한 surface를 명시하며 워크룸도 `internal`을 보낸다. Hermes Workroom start는 `hermesVariant: default/claude/codex`를 명시하고, Hermes open은 현재 앱/CLI 설정인 `default`만 허용한다. 다른 변형 세션을 재사용하지 않는다.
  새 팀원도 surface와 Hermes variant 또는 model+provider가 필요하다. 새 raw 선택 블록은 기본값을 명시하며, 과거 유효한 v1 블록에서 생략된 internal/plain-Hermes 기본값은 클라이언트가 MCP에 명시해 재질문하지 않는다. 열린 sessionId 합류는 기존 설정을 유지한다.
  prepare의 `executionRoutes`가 팀 생성만 제공하면 단일 요청을 임의로 팀으로 바꾸지 않는다.
- 열린 결정: 보통 요청의 `medium`이 사람의 더 높은 개인 기본값(예: Claude `effortLevel`, Codex config의 effort)을 이번 세션에 한해 낮춘다(D1 — 요청대로
  「그 밖은 medium」). Haiku처럼 effort를 받지 않는 모델에서 `--effort`가 무시되는지는 확인하지 않았다.
- 검증: `tests/workroom-effort-policy.test.ts`(골든·high 상한·4,000자·300자·단어 경계·첨부 제외), `tests/codex-effort-model.test.ts`(카탈로그·모델/공급자/
  프로필/카탈로그/base URL/실행 인자·맨 위 키 스캐너·실제 파일의 없음/64 KiB/권한/디렉터리), `tests/workroom-launch-options.test.ts`(CLI별 플래그 위치·생략 시
  바이트 동일·agy/제한 실행 무시), `tests/workroom-effort-launch.test.ts`(실제 서비스 + 가짜 PTY: 켜짐/꺼짐·요청 없음·CLI 명령·agy·Codex 증명·Hermes·
  `CLAUDE_CODE_EFFORT_LEVEL`·CS 대직·기록 재개·다시 시작 유지/수동 뒤 없음/꺼진 뒤 없음·휴대폰 권한·launch 제출), `tests/workroom-effort-screen.test.ts`(화면 강도·
  낮춤 표시·변경 줄/입력으로 수동·기준선·advice가 아무것도 입력하지 않음·MCP/꺼짐/수동 뒤 advice 없음·high 위에서 낮추라 하지 않음),
  `tests/workroom-effort-setting.test.ts`(없으면 켜짐·0600 원자적 저장·깨진 파일/심볼릭 링크·요청 형식·원격/커뮤니티 거절·`normalizeAiTerminalRequest` 거절).
  ⚠️ 실제 CLI(Claude·Codex·Hermes)로 플래그를 넣어 띄워 보지는 않았다(돈·네트워크) — 인자는 각 CLI `--help`와 바이너리 문자열로만 확인했다.
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
