# 아젠투지 음성 도크 · Codex Voice

## 도크·음성 패널이 창 안에 머문다 — 화면 배율과 머리 띠 (2026-11-01)

전수 클릭 검사(1440×900)가 두 결함을 찾았다. ① 음성 패널의 「음성 패널 닫기」·「대화 패널 닫기」가 창 위(패널 top y=-200)로 나가
누를 수 없었다. ② 「실행 도구」를 열면 권한 우회 토글과 빌드 메뉴가 도크(z 1000) 밑에 깔려 클릭이 도크에 먹혔다.

- **원인 ①**: 브라우저 빌드는 `#root`를 화면 배율(기본 125%, `src/uiZoom.ts`)로 `transform: scale`한다. `#root` 안의 fixed 요소는
  `#root`의 논리 px로 놓이는데, 패널이 `100dvh`(창 높이 = 논리 높이의 125%)와 `getBoundingClientRect()`로 잰 **확대된** 도크 높이로
  자기 높이를 잡았다. 지금은 `--ui-viewport-height`(배율로 나눈 창 높이, Tauri는 미설정 → `100dvh`)를 쓰고 도크 높이는 `offsetHeight`
  (논리 px)로 잰다. ⚠️ **`#root` 안의 fixed 표면에 `100dvh`/`100vw`·`getBoundingClientRect` 높이를 쓰지 말 것** — 배율이 1이 아니면 어긋난다.
- **패널 머리 고정**: 패널은 자기 안에서 스크롤한다(오류 안내를 `scrollIntoView`한다). 머리(`.voice-panel>header`)는 sticky이고
  `top: calc(-1 * var(--voice-panel-pad))`라 패널 위 끝에 붙어 스크롤된 본문을 가린다 — 패딩은 `--voice-panel-pad` 하나로 맞춘다.
- **도크 상한**: 도크(`max-height`)는 머리 띠(논리 ~131px, 오프라인 배너 포함 실측) 아래에서 멈추고, 늘어나는 것은 「열린 AI 세션」 목록
  (`flex-shrink: 1`)뿐이다. 휴대폰 원격 도크(`data-remote`)는 상한이 없다. 음성 패널과 세션 목록은 한 번에 하나만 뜬다(서로 닫는다). 패널이 열리면 도크의 설정 메뉴·담당자 고르기도 접힌다 — 「대화 방식 → 음성」이 메뉴 안에서 동의 패널을 열면 메뉴(z 1000)가 그 체크박스를 덮었다(휴대폰 390px, sticky 머리와 겹쳐 누를 자리가 14px만 남았다).
- **원인 ②와 고침**: `WorkspaceTools.fitPanel`이 목록 높이를 창 끝까지 잡았다. 지금은 `src/cornerFloatClearance.ts`의 `popoverPlacement`가
  같은 열의 도크·떠 있는 알림 스택 위에서 끝나게 하고, 그 위 공간이 160 논리 px 미만이면(펼친 도크) 창 높이를 쓰되 `data-over-dock`을 단다.
  그동안 `body:has(...)` 규칙이 도크와 알림 스택을 **z 9**로 내린다. ⚠️ 머리 팝오버는 `[data-testid="project-main-header"]`의
  z 10 쌓임 맥락 안에 있어 팝오버의 z(60)는 바깥에서 의미가 없다 — 이 9는 머리의 10보다 작아야 한다(`tests/corner-float-clearance.test.ts`가 지킨다).
- **검증**: `tests/voice-dock-viewport.e2e.mjs`(격리 빌드, 1280×800·1440×900·1920×1200 × 배율 125%/100%, 한가한 도크·펼친 도크).
  닫기 버튼과 `#bypass-toggle`·빌드 summary의 가운데 점 `elementFromPoint`가 자기 자신인지 + 실제 클릭으로 본다. 고치기 전 빌드는
  101건 실패(같은 피복 대상: `voice-dock-call`·`voice-dock-type`), 고친 뒤 204/0. Tauri 본창은 `NativeVoiceLauncher`를 띄우고
  네이티브 배율을 쓰므로 이 검사는 브라우저 빌드 기준이다.

## 기억 저장 확인 필요 → 진단 워크룸 (2026-10-29)

설치 앱의 알림은 음성 독립 창에 있으므로 일반 `/api/agent-runtime/terminals`를 호출하면 Rust의 창별 경계에서
거절된다. 일반 터미널 경로는 계속 막고, 고정 `POST /api/agent-runtime/memory-save-recovery`만 추가한다.
앱 Runtime capability와 Tauri Origin으로 보호하며 What I Said·QR 원격제어 capability는 사용할 수 없다.

이 경로는 2KiB 안의 operation(start/list)·requestId·등록 targetId·Codex/Claude·문제 종류만 받는다.
prompt·폴더·임의 명령·bypass는 거절한다. 호스트가 진단 프롬프트를 만들고 현재 등록 대상을 다시 검증하는 기존
터미널 서비스로 시작한다. 목록은 같은 프로젝트·AI의 최신 세션 16개 메타데이터뿐이다. 본문·기억 원문은 반환하지 않는다.
요청은 실패 알림을 본 사람이 AI를 선택하고 누를 때만 생기며, 시작 결과 유실 후 자동 재실행은 없다.

행별 버튼은 펼침 버튼 밖에 두고 오류 목록은 화면 높이의 48%/340px 안에서 스크롤한다. 280px 창의 Chromium/WebKit
검사에서 입력칸·닫기·복구 버튼의 표시, 충돌·미확정·백업·등록 실패·시작 유실·창 열기 실패를 각각 확인한다.

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 아젠투지 음성 도크 — 누구와 말하는지가 곧 저장 위치다 (2026-09-29)

「아젠투지 호출」은 헤더 칩이 아니라 **모든 탭·페이지에 떠 있는 도크**다(`src/components/AgentsToZVoiceDock.tsx`, Mac은 App 루트,
휴대폰은 포털 루트에 Mac별로). 설계·결정은 `docs/plans/voice-dock-2026-09-29/PLAN.md`.

- **본부장 비유**: 총괄(부서장)을 통해 시킬 수도, 프로젝트 담당자(부서원)와 직접 말할 수도 있다. 총괄과 나눈 말은 OPS 음성 세션,
  담당자로 전환한 뒤의 말은 **그 프로젝트의 음성 세션**(구간 세션)에 저장되고, 총괄로 돌아오거나 음성을 끝내면 OPS 기록에
  「[아젠투지 기록] <라벨> 담당자와 직접 대화 N개 발언 →」 한 줄이 남는다(`VoiceSessionHost.syncSegment`). 예전에는 전환해도 전부 OPS에
  저장됐는데 모델은 「프로젝트 쪽으로 이어진다」고 말했다 — 지시문(`VOICE_OPS_RECORD_GUIDANCE`)이 실제 규칙을 말한다.
- 발언의 소속은 **말한 시점**(OpenAI item committed/added)의 상대다 — 전사가 전환 뒤에 도착해도 옮기지 않는다. Gemini는 완료 시점.
- 도크 버튼 전환(`partner`)은 음성 도구 `connect_project_delegate`/`return_to_ops`와 **같은 전환**이다. 초안·전송 중에는 거절, OPS
  프로젝트 자신의 워크룸은 목록에서 뺀다(총괄의 손이지 대화 상대가 아니다). 모델에는 「[화면 전환 · 명령 아님]」 문맥만 보낸다.
- 동의는 기기에 한 번 — 그 뒤 캐릭터를 누르면 패널 없이 바로 시작한다. 저장(내가 한 말) 여부도 패널에서 고른 값을 기기에 기억해 도크가 따른다.
  ⚠️ iPhone 앱은 여기에 WebKit 마이크 확인이 한 겹 더 있었다 — `requestMediaCapturePermissionFor`가 늘 `.prompt`라 앱을 다시 열 때마다
  「마이크 접근 허용?」을 물었다. 이 앱에 iOS 마이크 권한이 이미 있으면(`AVAudioApplication.recordPermission == .granted`) 자기 포털 origin의
  메인 프레임에 한해 `.grant`한다(`LANWorkroomView.swift`). 처음 한 번은 여전히 iOS가 묻는다. 카메라(포털 안 「작업 기기 연결 · QR 스캔」)도
  같은 규칙이다(`AVCaptureDevice.authorizationStatus(for: .video) == .authorized`, 2026-10-16).
- **자막**: 기본 원문+통역(한→영, 영→한), 세션 제공자의 텍스트 모델(`VOICE_CAPTION_MODELS`, 실측 0.8~1.5초). 글자만 보낸다.
- ⚠️ 새 동작(`partners`·`partner`·`caption`)을 모르는 옛 Mac은 「지원하지 않는 음성 요청」으로 거절한다 — 클라이언트는 목록·전환 버튼을
  숨기고 자막은 원문만 보인다(오류를 띄우지 않는다). 응답 새 키는 새 동작에만 실리므로 옛 클라이언트는 영향이 없다.
- **「OPS 워크룸 열기」는 기기 목록이다**(2026-10-05): 「이 기기」 + 커뮤니티에 들어와 있는 다른 호. 누르면
  워크룸 화면에서 **그 기기 탭 + 그 기기의 OPS 프로젝트**가 골라진다(`src/workroomDeviceSelection.ts`의
  창 전용 이벤트 → `WorkroomDeviceSwitch`/포털이 듣고 목록이 온 뒤 `entry`로 한 번 고른다).
  ⚠️ **음성으로 다른 호를 모는 것은 넣지 않았다** — 폰→1호→상대 두 홉이고 제어 우편함이 유휴 3초·활성
  0.6초라 한 번 말할 때마다 입력·읽기 왕복이 붙어 대화 리듬이 깨진다. 「여는 것」은 요청 한 번이다.
- **음성 입구는 도크 하나다**(VOC 2026-09-29/30): 헤더 칩·OPS 워크룸 「음성으로 시작」·워크룸별 「음성」 버튼은 없앴다. 상대 전환은
  도크의 상대 버튼과 ⋯(허용된 모든 프로젝트 검색 `projects` + 담당 AI)뿐이다. 「도구 및 설정」·아젠투지 설정의 버튼은 같은 루트 패널을
  여는 「음성 설정」이다(두 번째 VoiceButton 인스턴스를 두지 말 것). 총괄을 눌러도 아젠투지 설정은 열리지 않는다.
- **담당자 모드 = 릴레이**(VOC 2026-09-30 「음성이나 텍스트가 전달되어야지」): 프로젝트 AI와 대화하는 동안(OPS 음성의 담당자, 또는 OPS 없는
  휴대폰의 워크룸 음성) 사람의 말·도크 입력은 **호스트가 그 워크룸에 그대로 입력**하고(`relay`, 현재 세션에 전송과 같은 경로), 모델은
  관찰된 출력만 읽어 준다. OpenAI는 릴레이 동안 `create_response:false`(`session.update`, 실API 확인)로 스스로 답하지 않는다.
  「아젠투지/총괄/메인으로…」로 부르는 말은 모델에게 간다(`addressedToAgentsToZ` — 채움말·띄어쓰기·뒷문장 허용, 「총괄적으로」는 제외).
  릴레이 동안 초안(prepare_*)은 거절한다(두 번 입력 방지). 전환 중·전환 뒤 끝난 말은 어디에도 입력하지 않고 알린다. 한 번에 여러 줄이면
  읽어 주기는 한 번. 도크의 「그대로 들어갑니다」는 Mac이 `relay` 동작에 답할 때만 보인다(옛 Mac은 약속하지 않는다).
- **음성이 실제로 동작한다**: 초안(prepare_*)을 만들면 모델이 읽어 주고 「보낼까요?」 → 「응/보내」면 `send_prepared_instruction`이
  「현재 세션에 전송」과 같은 입력 경로로 친다. 도크 초안 카드의 「보내기」도 같다(체크박스 없음). 워크룸 화면이 질문(신뢰·승인·메뉴·y/n)을
  기다리면 Mac이 **입력을 거절**하고(`workroomScreenAwaitsAnswer`), 사용자가 말한 답만 `answer_workroom_prompt`(MCP와 같은 허용 키,
  Shift+Tab 없음)로 누른다 — 담당자가 없으면 OPS 초안의 OPS 워크룸. 그 키 뒤에만 초안의 입력 리비전이 따라가고(`rebase`, 사람이 친
  입력은 여전히 막는다), 보낸 내용은 그 워크룸 입력칸 아래 `VoiceSentReceipt`(`workroom-voice-sent`, 호스트 notice라 새 와이어 키 없음)와
  도크 알림에 나온다. 도크 입력칸(`say`)은 지금 응답하는 상대에게 글로 말한다(워크룸 CLI 직접 입력이 아니다).
- ⚠️ **휴대폰은 워크룸을 자기 controlId로 부른다** — 호스트는 runtime id를 쓴다. 그래서 `partner`의 워크룸은 **세션 id로 찾고**
  찾은 실제 프로젝트 id로 허용 범위를 확인한다(`switchPartner`). targetId를 그대로 믿으면 휴대폰 도크의 워크룸 전환이 항상 실패한다.
- ⚠️ **휴대폰 OPS 음성의 권한 집합**: `prepare` 뒤 요청에는 target이 없다. 예전엔 그 요청들에 OPS id 하나만 넘겨, 프로젝트를 둘 이상
  허용한 휴대폰의 connect·partner·say·caption이 전부 「음성 세션의 프로젝트가 요청과 다릅니다」로 거절됐다(휴대폰 「무반응」의 원인).
  규칙은 `remoteVoiceAllowedTargets`(`src/remoteVoiceAuthority.ts`) 한 곳 — 이후 요청은 현재 허용 집합을 싣는다.
- 제공자 선택은 음성 중에도 바꿀 수 있고 「다음 대화부터」라고 말한다(잠가 두면 고장으로 읽혔다, VOC 2026-09-30).
- OPS가 허용되지 않은 휴대폰도 음성이 있다: 도크가 휴대폰에 열린 워크룸 목록(control id)을 보여 주고 고른 워크룸 대상 음성을 연다
  (`workroomFallback`). 도크가 오류·종료 사유·「…에 보냄」을 보여 주므로 OPS 패널은 그것을 반복하지 않는다.
- 녹음 구간(segment)은 **전사가 올 항목만** 기다린다(`claim(...,track)`) — 도구 호출·결과·메모·입력 글까지 기다리면 모든 프로젝트 기록이
  「일부 기록 확인 필요」가 됐다(리뷰 2라운드). OpenAI로는 `silent` 같은 호스트 전용 키를 보내지 않는다(`realtimeWireEvent`).
- 휴대폰 OPS 음성은 이제 탭을 옮겨도 끊기지 않는다(예전엔 워크룸 탭·online일 때만 마운트돼 있었다). Mac을 바꾸면 끝낸다.
- **도크 입력칸의 `@ 호출`·`# 언급`은 워크룸 입력칸과 같은 기호다**(VOC 2026-09-30). `@프로젝트`는 칩이 되고 그 **한 번의 입력만** 그 프로젝트
  워크룸에 넣는다 — 대화 상대는 바뀌지 않는다(`say.route` → `routeInput`: 실행 중 워크룸이면 `review.send` + 읽어 주기, 없으면 새 워크룸의
  **첫 요청 `prompt`**로 — 막 뜬 CLI의 신뢰 화면에 타이핑하지 않는다). `#프로젝트`는 글에 남고 `say.references`로 간다: 총괄에게는 정확한
  targetId 줄로, 담당자(relay)에게는 워크룸 입력의 `references`(폴더)로. 옛 Mac은 `references`를 거절하므로 글만 다시 보내고(「#이름」은 남는다),
  `route`는 **폴백하지 않는다** — 지금 상대에게 가 버리기 때문이다. 기호 매핑은 Slack·GitHub 관례(@=사람을 부름, #=채널·이슈를 가리킴)와 같다.
- ⚠️ **음성은 「exit」 항목을 고르는 Enter·숫자 키를 누르지 않는다**(`workroomKeyChoosesExit`). Claude의 새 신뢰 화면은 번호 없이
  「❯ No, exit」가 강조돼 있어서, 「신뢰해 줘」에 Enter를 누른 음성이 워크룸을 끝냈다(VOC 2026-09-30 — 끝난 워크룸은 입력칸이 사라져
  "텍스트창이 없어졌다"로 보였다). 권한 하나를 거부하는 「No」는 정상 답이라 막지 않는다. 키 뒤 CLI가 끝났으면 결과가 `workroom-exited`이고,
  담당자의 워크룸이 끝나면 도크가 **총괄로 돌아오며** 한 번 알린다(`takeEndedPartner` → `notePartnerEnded`, 구간 기록 닫기·relay 해제).
  끝난 워크룸의 안내는 입력칸이 있던 자리(터미널 아래, `workroom-exited-hint`)에 나온다.
- 검증: `tests/voice-dock.test.ts`(실제 호스트·PTY·암호화 기록), `tests/voice-media-client.test.ts`, `bun scripts/check-voice-dock.ts`
  (Chromium·WebKit, 데스크톱·390px, 옛 Mac), `bun scripts/check-voice-media.ts`.
## 도크 알림 스택 · 「열린 AI 세션」 (VOC 2026-10-24)

「컨텍스트 N% 기준 자동 세션 기억을 로컬에 저장했습니다」 배너가 모든 페이지 맨 위를 가렸다. 지금은 「아젠투지 호출」 바로 위에 쌓이는
알림 카드이고, 도크에는 열린 프로젝트+에이전트 세션을 펼쳐 보는 목록이 있다. 둘 다 **이 Mac 전용**이다(휴대폰 포털에는 로컬 API가 없다).

- **어디에 뜨나**: 설치 앱은 「아젠투지 호출」 독립 창(`VoicePopoutApp`)의 도크 안, 브라우저(dev) 빌드는 App의 도크 안. 독립 창을 닫아
  「아젠투지 호출 열기」 버튼이 떠 있는 동안에만 본창이 같은 스택을 그 버튼 위에 띄운다(`NativeVoiceLauncher`, `placement="floating"`).
  도크는 `notifications` 슬롯과 `localSessions` 플래그만 받는다 — 로컬 API를 모른다(휴대폰 도크는 둘 다 넘기지 않는다).
- **알림**(`src/AutomaticSaveNotice.tsx`): 판정은 그대로 `automaticSaveNotices`(실제 완료 기록만, 7일). 최신이 도크에 가장 가깝게 아래에,
  3개까지 보이고 나머지는 「알림 N개 더 보기」. 카드를 누르면 설명이 펼쳐지고 ×로 닫는다, 2개 이상이면 「알림 모두 지우기」.
  ⚠️ **닫은 기록은 localStorage**(`agentstoz:automatic-save-notices:dismissed:v2`, 96개)이고 `storage` 이벤트로 창끼리 맞춘다 — 독립 창과 본창은
  별개 웹뷰라 sessionStorage가 따로여서, 예전 키로는 한 창에서 닫아도 다른 창에 다시 떴다. 알림 id에 `lastCheckpointAt`이 들어가므로 같은 저장은 다시 뜨지 않는다.
  읽기는 15초·문서가 보일 때만(예전 배너와 같은 비용 — 배너를 지웠으므로 이중 폴링은 없다).
- **「열린 AI 세션」**(도크의 겹친 사각형 버튼 `voice-dock-sessions`, `src/components/DockSessionsPanel.tsx`): AI 사용량 패널과 같은 자료
  (`/api/context-usage`, `visibleContextSessions` — 오래됨·닫힌 표면 제외)와 같은 판정(`sessionMemoryAction`, `voiceProjectMemoryIsBlocked` —
  AiUsagePanel에서 export)으로 행마다 프로젝트·AI·「컨텍스트 N%」(70% 이상 주황·90% 빨강)·상태 한 줄과 「지금 저장」·「동기화」를 준다.
  로컬 저장/Supabase 백업 시각은 접힌 「저장·백업 시각」(`voice-dock-session-times`) 안에 있다 — 현재 상태와 경쟁하지 않게. 충돌은 접지 않고 상태 줄에 그대로 보인다.
  프로젝트 이름은 펼칠 때 한 번 읽는 `/api/ports`로 붙인다(독립 창에는 본창의 워크트리 목록이 없다 — 워크트리는 부모 경로 포함 판정으로 잡힌다).
  - 머리 아래 한 줄은 「Claude·Codex 자동 체크포인트 켜짐 · 컨텍스트 50·70·75·90%」(또는 꺼짐)이다. 한 조정기가 Claude·Codex 세션을 함께
    저장하므로(`readCodexAutoRememberObservations`+`readClaudeAutoRememberObservations`, AI 사용량 패널 문구와 같다) 「Codex …」만 쓰면 Claude 행 위에서
    틀린 말이 된다(2026-10-28 바로잡음). 이 줄과 컨텍스트 칸만 `dockSessionsCopy`(`src/i18n.ts`, 7개 언어)로 번역되고 나머지 목록은 아직 한국어 전용이다.
  - ⚠️ 컨텍스트 칸(`az-session__pct`)은 일반 `<span>`이라 `aria-label`을 달지 않는다 — ARIA 1.2가 generic 역할의 이름 붙이기를 금지해 무시될 수 있다.
    스크린 리더는 칸의 글자 「컨텍스트 72%」를 읽고, 모르는 값은 보이는 「—」를 숨기고 `az-voice-dock__sr-only`의 「확인 안 됨」을 읽는다. 검사는 속성이
    아니라 Playwright `ariaSnapshot()`으로 실제로 읽히는 글자를 본다.
  - 「지금 저장」 = 그 세션의 AI로 `session-end`(`preservePreferredAgent:true` — 프로젝트의 기본 AI를 바꾸지 않는다). 버튼은 **자기 질문만** 답한다
    (`resolveProjectMemorySaveButtonAction`과 같은 규칙, 프로젝트 패널과 같다): 새 활동이 있거나 장기기억이 아직 없으면 켜지고, 충돌이면 꺼진다.
    백업이 밀려 있는 것은 저장을 막지 않는다. 누를 때 상태를 다시 읽는다(자동 체크포인트나 다른 창이 방금 저장했을 수 있다).
    ⚠️ **장기기억을 새로 만드는 것(`start`)은 등록된 프로젝트·그 워크트리에서만** 한다 — AI 사용량 패널은 아무 폴더에나 「시작」을 주지만,
    한 번 누르는 이 목록에서는 `~/Downloads` 같은 폴더에 기억이 조용히 생길 수 있다. 등록되지 않은 폴더 행은 「등록되지 않은 폴더 · 장기기억 없음」.
  - 「동기화」 = `/api/project-memory/sync`(해시로 안전한 방향만). 충돌이면 덮어쓰지 않고 「프로젝트 화면에서 검토」라고 말한다.
    양쪽이 이미 같으면(`sessionMemorySyncDirection`이 `synced`) 「동기화됨」으로 꺼진다(`dockSyncButtonState`, VOC 2026-10-29 「동기화 누른 뒤에도
    켜져 있음」). 행의 `action`(`saved`·`remember`)으로 판정하지 말 것 — `remember`도 이미 동기화된 상태일 수 있다. 백업 꺼짐·비교 실패는 켜 둔다.
    ⚠️ Compact·Clear의 `canSync`(동기화할 수 있는 기억인가)와 버튼 켜짐은 다른 질문이다 — 섞으면 동기화된 행의 Compact가 꺼진다.
  - **5초 폴링은 펼친 동안에만**(세션 5초, 기억 상태는 폴더마다 30초 캐시·한 번에 하나). 접으면 그 타이머가 사라지고 아래 「저장 안 된 작업」의 1분 검사가 이어받는다. 바깥 클릭으로 닫지 않는다 —
    저장 중에 다른 곳을 눌러 결과를 잃지 않게. Escape·토글로 닫는다. 설정 메뉴를 열면 닫힌다(둘이 쌓여 창이 길어지지 않게).
  - ⚠️ **패널은 `lazy`로만 가져온다** — `projectMemoryApi`가 든 `ProjectMemoryPanel`을 끌고 오므로, 항상 실리는 도크가 정적으로 가져오면
    지연 로딩이 깨진다(`tests/dock-notices-sessions.test.ts`가 지킨다).
  - 저장은 장기기억을 갱신할 뿐 열린 대화의 컨텍스트 %를 줄이지 않는다 — 패널이 그렇게 말한다.
  - **2026-10-26: 최근 기록과 실제 열린 창을 구분한다.** 머리는 「최근 AI 세션」이다. `guardian_review`·`subagent` 내부 실행은 API 수집·공유 UI 판정에서 제외한다(제목으로 판정하지 않는다). `Guardian review`가 같은 프로젝트의 충돌 경고를 여러 번 반복한 원인이었다.
  - **주간 잔여량**은 목록 상단의 Claude·Codex·Antigravity 3칸이다. 컨텍스트 %와 별개다. Codex는 기존 app-server 읽기, Claude는 공식 statusline의 `rate_limits.seven_day`, Antigravity는 `quota`의 명시적 weekly bucket만 쓴다. 여러 bucket은 최소 잔여량이라고 표시하고 세부 한도·초기화 시각은 툴팁에 둔다. 조회 실패는 확인 안 됨, 15분 초과·리셋 경과는 이전 값이며 0/100%를 추정하지 않는다. 계정 단위의 최근 CLI 활동 기준이며 앱 계정과 같다고 보장하지 않는다.
    Codex 사용량 읽기 전용 child는 Orca·AgentsToZ 관리 계정 경로의 `CODEX_HOME`이 상속되면 `OPENAI_`·`CODEX_` 환경 전체를 제외하고 기본 CLI 계정을 읽는다. 다른 계정의 인증이나 endpoint가 기본 계정에 섞이지 않도록 하는 기존 계정 격리 정책이다. 일반 프록시·TLS 환경과 부모 환경, 기존 세션·로그인 파일은 유지한다. 관리 경로가 아닌 명시적 `CODEX_HOME`과 그 provider 설정은 그대로 쓰므로 이 경우 해당 CLI 계정 기준이다. 관리 경로를 사용자가 명시 선택한 것과 앱에 상속된 것은 경로만으로 구분할 수 없어 두 경우 모두 기본 CLI를 읽는다. 열린 모든 세션의 계정을 대변하지 않는다. 실시간 조회는 성공했지만 주간 창이 없는 경우 「주간 자료 없음」과 확인 경과를 표시하며 15분을 넘기면 「이전 확인」을 덧붙인다. 조회 실패는 「확인 안 됨」이다. 주간 한도 자체가 없다고 단정하지 않는다.
  - Claude·agy의 「사용량 연결」은 이 Mac 기본 CLI의 상태줄을 감싸는 명시적 opt-in이다. 고정된 Python shim이 주간 숫자·시각만 기기 내 0600 파일 하나씩 원자 교체하고 원래 상태줄의 입력·출력을 유지한다(원래 명령 최대 3초). 대화·이메일·토큰은 저장하지 않는다. 연결 해제는 현재 명령이 앱 소유일 때만 원래 설정을 복원하며 외부 변경을 덮지 않는다. Python·CLI가 없거나 Windows이면 연결 미지원이다. 연결 직후 숫자는 다음 CLI 활동부터 들어온다. 도크 패널을 펼친 동안·문서가 보일 때만 60초 폴링하며, 별도 권한이 있는 휴대폰에는 같은 호스트의 마지막 주간 사용량 스냅샷만 전달한다([원격 주간 잔여](remote-control.md)).
  - **목록 정리와 네이티브 `/compact`·`/clear`는 별개다.** ×는 관측 시각까지의 표시만 숨기고, 「지난 목록 정리」는 유휴·표면 미확인 기록만 일괄로 숨긴다. 실행 중이거나 `live`인 표면은 일괄 대상이 아니다. `contextSessionCleanup`의 localStorage 256개 상한·storage 이벤트를 도크/사용량/미저장 검사에 공유한다. 새 `capturedAt`이면 다시 표시하며 원본 대화·기억·로그를 삭제하지 않는다.
  - **Compact·Clear 버튼은 모든 행에 그리고, 자동 전송은 두 곳뿐이다**(2026-10-29, `contextCommandAvailability`·`contextCommandButtonState`). 행별 안내는
    표면의 고정된 사실이다(「나중에」 류 금지, 문구는 `dockSessionsCopy(lang).command`). ① 정확히 연결된 로컬 Claude Code **워크룸**: 기존
    `workroom.save`의 동일 세션·입력 리비전 영수증 → 해시 기반 sync → 보호된 terminal 경로의 고정 명령. 서버가 저장 증거·동기화·입력 리비전·빈 입력칸·유휴를
    쓰기 직전에 재확인한다. ② **Orca의 Claude**(사용자 결정 2026-10-29) — 아래. 일반 터미널·iTerm·VS Code·cmux·백그라운드 에이전트·위치 미확인 Claude와
    Codex(앱 「Codex 앱에서 직접 실행」, CLI 「Codex에서 직접 실행」)는 수동이고 원본 창 안내만 한다. 지원 행이 기억 상태로만 막히면 그 기억 상태를 말한다.
    임의 shell·외부 창 자동 타이핑·원격 DTO 확장은 없다.
  - **Orca Claude 경로**(`src/contextOrcaCommand.ts`, `context.orca.execute·receipt·acknowledge`): 버튼은 목록의 `surfacePresence:'live'`(정확히 한 터미널)이고
    기억이 이미 `saved`(저장·동기화 완료)일 때만 켜진다 — 이 경로는 저장하지 않는다. 클릭은 sync 확인 후 요청 ID(UUID)만 보낸다. 서버는 손잡이·경로·문자열을
    받지 않고 행의 캡처(`orcaPaneKey`·`orcaWorktreeId`) → Orca 저장 세션(`profile-state.db`) 정확히 하나 → 기억 저장·동기화 → `terminal list`에서 그 탭·leaf·
    워크트리의 살아 있는 손잡이 정확히 하나 → `show`(claude·local·writable, runtime·incarnation 기록) → `wait --for tui-idle` → 기억 재확인 → `read --screen`(두
    규칙선 사이 빈 `❯`, draft 없음, 「esc to interrupt」 없음) → `show` 재확인(같은 runtime·손잡이·incarnation) → 영수증 `write_started` → `terminal send --text
    /compact --enter --wait-submit 2 --retry-request <requestId>` 순서다. ⚠️ 빈 입력칸을 읽은 뒤 쓰기까지는 `show` 한 번과 로컬 영수증뿐이다 — Orca 전송은
    입력칸에 있는 글 뒤에 붙여 Enter를 누르므로, 느린 기억·Supabase 확인을 그 사이로 옮기지 말 것. 받은 응답의 runtimeId·handle·
    `prompt.processIncarnation`이 모두 같고 `accepted:true`일 때만 `written`, `accepted:false`는 `rejected`, 그 밖(시간 초과·불일치·오류)은 전부 `unknown`이다.
    ⚠️ Orca 1.4는 저장 세션을 `profile-state.db`(SQLite)로 옮겼고 `orca-data.json`은 그 뒤 갱신되지 않는다(1호 2026-10-13에 멈춤). 예전 판정은 JSON만 읽어
    새로 연 Orca Claude를 `gone`으로 숨겼다 — 읽기는 `src/orcaProfileState.ts` 하나(DB가 있으면 DB만, 못 읽으면 `unverified`).
  - **Orca 울타리**: `unknown`(또는 재시작 뒤 `write_started`)인 영수증이 하나라도 있으면 그 대화에는 다시 보내지 않는다. 같은 requestId는 영수증으로만 답한다.
    풀리는 길은 사람이 Orca 화면을 확인하고 누르는 「직접 확인함 · 미확정 해제」(`acknowledgeSubmission`이 그 영수증 하나에 `acknowledgedAt`만 찍고 상태는
    `unknown` 그대로)뿐이다 — 자동 해제·만료는 없다. 영수증은 워크룸 제출 저널(owner `local-context-orca`, target `orca-context`)에 둔다.
    쓰기 전 거절도 `rejected` 영수증으로 남긴다 — 응답이 유실돼도(사이드카 재시작, Orca 잠금을 기다리다 프록시 20초 초과) 「전송 확인」이 도크 표시를 푼다.
    기록이 없는 요청(서버에 닿기 전에 유실)을 해제하면 같은 키에 묘비(`rejected`+`acknowledgedAt`)를 남겨, 늦게 도착한 그 요청은 거절되고 보내지 않는다.
    이미 확정된(written·rejected) 영수증의 해제는 기록을 바꾸지 않고 그 상태만 답해 도크 표시를 지운다.
  - **세션 창이 닫힐 때**(2026-10-29): ① 클릭 전 — Orca `gone` 행은 목록에서 빠지고, 워크룸은 바인딩이 사라져 수동 안내가 된다(보내지 않음).
    ② 저장·동기화 중이나 쓰기 직전 — 호스트가 다시 확인해 `rejected`(워크룸 「워크룸 세션이 닫혀 명령을 보내지 않았습니다」). 도크 표시가 풀린다.
    ③ 쓰기 결과 모름(`unknown`) — **미확정 명령이 있는 행은 창이 닫혀도·×로 숨겨도 목록에 남는다**(`surfacePresence:'gone'`으로 표시, 「세션 창이
    닫혔습니다」, Compact·Clear는 `closed` 안내로 꺼짐). 그 행의 「전송 확인」·「미확정 해제」가 사라지면 울타리가 보이지 않게 그 대화를 막기 때문이다.
    워크룸에는 호스트 울타리가 없으므로 `context.receipt`가 `sessionOpen`을 답하고, **그 워크룸 세션이 닫힌 뒤에만** 사람이 「창 닫힘 확인 · 미확정 해제」로
    로컬 표시를 푼다(닫힌 세션에는 늦은 요청도 `rejected`, 다시 연 대화는 다른 세션). `sessionOpen`이 없는 옛 호스트는 해제하지 않는다.
  - ⚠️ **주간 사용량 정지(WIP)와의 관계**: 주간 정지가 들어오면 `/compact`·`/clear`(워크룸·Orca 둘 다)는 정지 중에도 허용해야 한다 — 컨텍스트를 줄이는
    명령이지 새 작업이 아니다. 이 트랙은 그 게이트를 구현하지 않았다.
  - 명령은 기존 durable submission 영수증을 재사용한다. 응답 유실은 localStorage에 남긴 원래 requestId로 조회할 뿐 다시 보내지 않는다. `/clear` 뒤에는 옛 provider ID의 바인딩을 폐기한다. 옛 행은 전송 즉시가 아니라 같은 창의 새 대화가 확인된 뒤에 숨긴다(아래 「처리 결과」). 워크룸에서 직접 `/clear`·별칭·`/resume`·`/fork`를 실행해도 옛 바인딩을 폐기한다(직접 입력의 Enter는 현재 입력칸도 확인). 새 대화의 정확한 바인딩이 확인되기 전까지 도크 명령은 지원하지 않으며 워크룸에서 직접 조작한다. Codex 데스크톱 앱에는 Claude 명령을 보내지 않는다.
  - **처리 결과를 행에서 말한다**(VOC 2026-11-01 「처리결과도 여기서 알아야 하는 거 아님?」, `src/contextCommandOutcome.ts`). 예전에는 「…전송했습니다.
    처리 결과는 Orca에서 확인하세요」로 끝났고, 머리에는 「컨텍스트 0%」가 떠 있었다.
    - ⚠️ **Claude의 0은 「측정 전」이다**(`src/contextUsageReading.ts` `measuredContextPercent`): 시작·재개·요약 직후 첫 응답 전까지 statusline이
      `used_percentage:0`·`current_usage` 전부 0을 보낸다. 도크·AI 사용량 패널·워크룸 꼬리줄은 이것을 0%가 아니라 「확인 안 됨」(—)으로 보인다.
      토큰이 0보다 크면 0%도 진짜 값이다. 그래서 컨텍스트 %만으로는 요약을 판정할 수 없다 — 실측 2026-10-31(이 Mac의 Orca Claude): `/compact`가 끝난 뒤에도 스냅샷은 0 그대로였다.
    - **Compact**의 1차 증거는 transcript의 `{"type":"system","subtype":"compact_boundary",…,"compactMetadata":{preTokens,postTokens}}` 행이다
      (`src/contextCommandEvidence.ts`). 따옴표가 이스케이프되지 않은 표식이라 대화 본문(JSON 문자열)에는 걸리지 않는다. ⚠️ 그 뒤에 요약·첨부가
      ~418 KB 붙어 512 KB 꼬리 읽기에서 빠질 수 있어, 같은 파일이 자랐으면 꼬리가 덮지 못한 덧붙은 부분만(최대 8 MB) 표식으로 훑는다.
      보조 증거는 누른 뒤 캡처된 값이 1포인트 이상 내려감(`reading`), 또는 알던 값이 Claude의 0으로 바뀜(「요약된 것으로 보입니다」, `reset`).
      더 강한 증거가 늦게 오면 약한 답을 덮는다(기록 > 감소 > 초기화 > 확인 안 됨). 대기 5분.
    - **Clear**의 증거는 **같은 터미널**의 새 세션 ID다 — 워크룸 `launchContext.agentstozWorkroomSessionId`, Orca `orcaWorktreeId`+`orcaPaneKey`가 같고
      누른 뒤 캡처된 다른 세션. 서버가 행의 `nextConversation`으로 붙인다(사용량이 없는 행을 거르기 전에 계산 — 새 대화는 첫 응답 전 0이다). 옛 호스트를 위해
      워크룸은 행의 `workroomSessionId`로도 찾는다. 확인되면 옛 행을 숨기고 결과는 새 대화 행으로 옮긴다. 대기 2분. 옛 대화가 창에서 빠지는 것은 Clear의
      정상 경과라 기다린다(Compact는 창이 닫히면 바로 「결과 확인 안 됨」).
    - 증거는 누른 시각보다 새것만 센다. 대기 표시는 보낸 시각부터 센다. 시간이 지나면 「결과 확인 안 됨 · <사유>. Orca|워크룸 화면에서 확인하세요.
      명령은 다시 보내지 않았습니다.」 **절대 다시 보내지 않는다.** 따로 폴링하지 않고 패널이 이미 하는 5초 읽기마다 진행한다(접혀 있으면 멈춘다).
      추적은 localStorage `agentstoz:context-command:outcome:v1`(16개, 두 도크 창이 storage 이벤트로 공유)이고, 결과는 10분 보인 뒤 사라진다.
      결과를 보이는 행은 숨겨졌거나 창이 닫혀도 남는다(울타리 행과 같은 고정). 「전송 확인」으로 늦게 확정된 요청도 누른 시각부터 따라간다.
    - `lastCompaction`·`nextConversation`은 로컬 `/api/context-usage` 행에만 있다 — 원격 DTO·`AiTerminalSummary`에는 넣지 않았다.
    - ⚠️ `CLAUDE_CONFIG_DIR`로 다른 계정을 쓰는 Claude의 transcript는 색인하지 않으므로 그 대화의 Compact는 기록 없이 % 보조 증거만 쓴다.
    - 검증: `tests/context-command-outcome.test.ts`(상태 기계·문구·저장소), `tests/context-command-evidence.test.ts`(경계 행·덧붙은 부분 훑기·같은 터미널의
      다음 대화·0 = 측정 전·API 계약), `scripts/check-voice-dock-sessions.ts`(Chromium·WebKit: 요약 완료 줄, Clear 뒤 옛 행 유지 → 새 대화 행으로 이동).
      ⚠️ 설치 앱에서 실제 Claude로 /clear 뒤 상태줄 캡처를 관측하지 않았다.
  - **Claude 행은 어디서 오나 · 저장 확인의 범위**(2026-10-31):
    - ⚠️ `<appData>/context/<session_id>.json`을 쓰는 것은 Claude 「사용량 연결」의 상태줄 shim(`src/weeklyUsageHook.ts` **v2**)뿐이다. v1은 주간 숫자만
      써서 이 폴더가 어디서도 생기지 않았고, `/api/context-usage`의 Claude 행은 0개(`captureInstalled:false`)라 도크에 Codex만 보였다. v2는 같은 입력에서
      세션 ID(UUID만)·cwd·project_dir·model·`context_window`의 숫자·비용·`launchContext`(Orca·cmux 식별자·TERM_PROGRAM·entrypoint, 워크룸이면
      `AGENTSTOZ_WORKROOM_SESSION_ID` 하나만)를 0700 폴더의 0600 파일로 원자 교체한다. 대화·transcript 경로·이메일·토큰·Orca hook 토큰은 쓰지 않는다.
      같은 값은 15초 안에 다시 쓰지 않고, 새 세션 파일을 만들 때 30일 지난 자기 파일만 지운다. 쓰기 실패는 전부 무시한다 — 상태줄 출력·주간 숫자·원래 명령 통과는 그대로다.
    - 파일 이름은 `statusline-v1.py` 그대로 둔다(설정의 명령이 바뀌지 않게). 내용 해시가 `RELEASED_WEEKLY_USAGE_HOOK_SHA256`에 있을 때만 제자리에서 교체한다
      (`WeeklyUsageHost.upgradeHook` — 사이드카 시작·status). 사람이 고친 shim은 건드리지 않는다. shim을 바꾸면 버전을 올리고 이전 해시를 목록에 더한다
      (`tests/fixtures/weekly-usage-hook-v1.py`가 v1 원문). 캡처 폴더가 없으면 목록이 「Claude 세션은 위의 Claude 「사용량 연결」을 켠 뒤 …」를 말한다(`voice-dock-sessions-capture`).
    - **워크룸 `/compact`·`/clear`의 저장 확인은 이 대화만 본다**(`src/workroomSavedReceipt.ts`, purpose `context`): 같은 세션·입력 리비전의 `workroom.save`
      영수증 + 같은 폴더 + **그 저장이 시작된 뒤 이 대화의 활동 전환이 없음**(tracker `activity.since` ≤ 영수증 `at`). 종료(`close`)는 그대로 프로젝트 전체
      증거(`projectMemoryCloseEvidence` — 모든 워크트리의 git 지문 + 프로젝트 활동 표식)를 비교한다. 예전에는 컨텍스트 명령도 종료 검사를 그대로 써서, 다른
      워크트리·다른 에이전트가 저장 뒤 무엇이든 바꾸면 종료 문구(「…다시 저장 후 종료하세요」)로 거절했다. ⚠️ 프로젝트 증거를 뺐으므로 입력 리비전만으로는
      저장 뒤 이 대화의 출력(입력 없이 끝난 턴)을 못 본다 — 그래서 활동 전환 시각을 함께 본다. `seen`(turn-finished→idle)도 시각을 바꾸므로 한 번 불필요하게
      거절될 수 있다(fail-closed, 다시 누르면 새로 저장한다). 거절 문구는 `WORKROOM_CONTEXT_SAVE_REFUSALS`(「…명령을 보내지 않았습니다」) — 종료·터미널 유지 표현 없음.
    - **Orca 경로는 그대로 프로젝트 전체 `needsRemember`를 본다.** 이 경로는 저장하지 않아 대화별 저장 영수증도 입력 리비전도 없다 — 대화 단위로 좁히려면
      provider 세션에 묶인 Orca 저장 작업과 대화별 활동 증인이 먼저 있어야 한다. 그 거절 문구에는 이미 종료 표현이 없다.
    - **Clear 뒤 워크룸의 새 대화**: 워크룸 Claude는 `--session-id <워크룸 id>`로 시작하므로, 캡처의 `launchContext.agentstozWorkroomSessionId`(행의
      `workroomSessionId`)가 행의 세션 ID와 다르면 그 워크룸의 바인딩되지 않은 새 대화다 — 안내는 「위치 미확인」 대신 `workroomUnbound`. 이 표식은 문구용일 뿐
      전송 권한이 아니다(보내는 것은 정확한 바인딩뿐).
    - **끝난 워크룸의 첫 대화**(표식 = 행 세션 ID인데 바인딩 없음): 안내는 `workroomNotBound`(「워크룸이 연결돼 있지 않아… 닫혔다면 다시 연 뒤」).
      앱을 다시 시작하면 워크룸이 모두 끝나므로 그 뒤의 회색 버튼이 전부 「창을 확인하지 못해」라 고장처럼 읽혔다(3호 2026-10-31). 「닫혀」라고
      단정하지 않는 것은 독이 아직 바인딩을 못 읽은 실행 중 워크룸도 같은 모양이라서다. 같은 날 살아 있는 워크룸에서 Compact를 실제로 눌러
      `/compact` → PreCompact 훅 → 요약 완료까지 확인했다(Codex 컴퓨터 유즈 1회 클릭, 기록에 요약 경계 생김).
    - 검증: `tests/weekly-usage.test.ts`(캡처 필드·권한·15초·워크룸 표식·쓸 수 없는 폴더에도 상태줄 유지·v1 제자리 업그레이드·멱등·고친 shim 보존),
      `tests/workroom-saved-receipt.test.ts`(실제 git + 링크 워크트리: 저장 뒤 다른 워크트리 변경이 종료는 막고 컨텍스트 명령은 막지 않음, 입력 미저장은 여전히 막음),
      `tests/context-session-command.test.ts`(저장 뒤 이 대화의 활동 → 쓰기 없음), `tests/context-session-command-availability.test.ts`(`workroomUnbound`).
      ⚠️ 이 Mac의 실제 Claude로 v2 shim을 돌려 보지 않았고, 설치 앱에서 누르지 않았다.
- 쉬는 Mac 도크의 한 줄(호출 · 텍스트로만 · 열린 세션 · 설정)은 줄바꿈하지 않는다(`data-active="false"`이고 휴대폰이 아닐 때) —
  shrink-to-fit 도크에서 설정 버튼이 혼자 둘째 줄로 떨어졌다. 대화 중(컨트롤 최대 6개)은 예전처럼 줄바꿈한다.
- **「저장 안 된 작업」 · 「모두 저장」**(VOC 2026-10-24, `src/unsavedSessionMemory.ts`): 자동 저장은 컨텍스트 기준에 닿을 때만 돌아서,
  그 아래에서 쌓인 작업은 사람이 목록을 펼쳐 봐야 알았다. 이제 접힌 도크에서도 안다.
  - **판정은 목록과 같다**: 열린 세션(`visibleContextSessions`) → 기억 폴더(`contextSessionMemoryPath`, 확인 안 된 Voice 바인딩·Codex 스레드 작업 폴더 제외)
    → 폴더마다 `/api/project-memory/detect`의 `activity.needsRemember`. 폴더당 한 줄(가장 최근 세션의 AI), 최대 12개, 한 번에 하나씩.
  - **검사는 알림 스택 하나가 1분마다**(`useUnsavedSessionMemory({check:true})`, 문서가 보일 때만, 20초 안의 재검사는 건너뜀). 도크 버튼의 숫자는
    읽기만 한다(`check:false`) — 휴대폰 도크에는 스택이 없어 검사도 숫자도 없다. 목록이 펼쳐져 있으면 검사는 쉬고(`pauseBackgroundCheck`)
    목록이 읽은 결과를 `publishUnsaved`로 넘긴다(같은 폴더를 두 번 detect하지 않게).
  - ⚠️ **이 모듈은 항상 실리는 도크가 정적으로 가져온다** — `ProjectMemoryPanel`·`AiUsagePanel`을 import하지 않는다(plain fetch). 그래서
    `ContextSession`과 Voice 가드(`voiceProjectMemoryIsBlocked` 등)를 `src/contextSessionMemoryPath.ts`로 옮겼다(AiUsagePanel은 재수출만).
  - **카드**: 「저장 안 된 작업 · 프로젝트 N개」 + 이름 + 「모두 저장 (N)」(1개면 「지금 저장」). ×로 접으면 **저장 안 된 집합이나 그중 하나의
    마지막 저장이 바뀔 때까지** 다시 뜨지 않는다(id = 폴더@lastRememberedAt 해시, 같은 localStorage 닫은 목록). 숫자는 버튼에 남는다.
  - **실행기는 화면이 아니라 저장소에 있다** — 목록을 접어도 남은 저장이 이어진다. 진행·결과는 스택의 「기억 저장 중 · k/N」 카드.
    목록의 행 「지금 저장」도 같은 실행기를 지난다(대상 1개, 등록된 프로젝트의 `start`만 `allowStart`).
  - **하나씩 차례로**: 호스트는 기억 저장을 한 번에 하나만 돌리고(`memorySaveDispatcher`, 대기 30초 뒤 `MEMORY_SAVE_BUSY`), 저장마다 AI가 최대 5분
    돈다. 그래서 동시에 보내지 않는다. 각 저장 직전에 detect를 다시 읽어 이미 최신이면 건너뛴다(자동 체크포인트·다른 창이 방금 저장했을 수 있다).
  - **결과 해석**: `MEMORY_SAVE_BUSY`는 시작 안 됨 → 건너뜀(목록에 남는다). 충돌(`preflightConflict`)은 실패. 로컬 저장 뒤 백업 실패는 저장됨
    (「동기화」 안내). **타임아웃·연결 끊김은 결과 모름 → 다시 보내지 않고 남은 저장도 시작하지 않는다**(호스트가 아직 돌리고 있으면 다음 것은
    대기열 뒤에서 BUSY가 될 뿐이다). `REQUEST_BODY_UNREADABLE`만 한 번 더 보낸다(호스트가 본문을 못 읽었다 = 시작 안 됨).
  - ⚠️ 예전 행 「지금 저장」은 `memoryRequest`(20초 타임아웃 + 타임아웃 1회 재시도)로 `session-end`를 불렀다. AI가 20초를 넘기면 재시도가
    같은 루트의 BUSY를 받아, 저장이 실제로 진행되는데도 「다른 기억 저장이 실행 또는 대기 중」을 보였을 것이다. 실행기는 8분 한도·재시도 없음이다.
    (프로젝트 패널의 「세션 기억하기」는 아직 `memoryRequest`를 쓴다 — 손대지 않았다.)
- 검증: `bun scripts/check-voice-dock-sessions.ts [shots]`(Chromium·WebKit, 1280×800·420×760, 합성 로컬 API — 3개+더 보기·도크 바로 위·
  펼치기·닫기 뒤 새로고침에도 닫힘·모두 지우기·접힌 동안 5초 폴링 없음·행 내용·컨텍스트 칸이 읽히는 글자(확인 안 됨 포함)·체크포인트 줄 두 언어·
  접힌 시각·충돌은 접지 않음·접힌 네이티브 명령·저장 1회 본문·동기화·Escape 뒤 폴링 멈춤·가로 스크롤 없음,
  저장 안 된 카드·버튼 숫자·접어 둔 뒤 새 집합이면 다시 뜸·「모두 저장」 차례 저장(동시 1개)·목록 「모두 저장」을 접어도 끝까지),
  `tests/unsaved-session-memory.test.ts`(판정·쉬기/넘기기·차례 저장·직전 재확인·start 제한·BUSY/충돌/백업 실패/결과 모름),
  `tests/dock-notices-sessions.test.ts`(배선·저장소·지연 로딩·규칙), `tests/voice-popout-ui.mjs`(독립 창 — 픽스처가 3001 읽기를 대신 답한다).
  ⚠️ 설치 앱(실제 독립 창·실제 세션)에서는 아직 눌러 보지 않았다.

## Codex Voice — 범위 지정 시작은 불가능, 이동은 접수되지만 적용 안 됨

두 가지를 구분해야 한다. 뭉뚱그려 "불가능"이라고 쓰면 사용자가 **실제로 본 동작**과 어긋난다.

**① 새 Voice를 프로젝트 범위로 시작 — 불가능.** 번들의 유일한 realtime-voice starter가
`workspaceRootsForLocalExecution:[]`를 고정으로 넘겨 항상 `projectless` +
`~/Documents/Codex/<날짜>/realtime-voice-chat-N` cwd가 된다. `codex://`에 voice 라우트가 없고,
CLI에도 voice 서브커맨드가 없으며, `.codex-global-state.json`은 부팅 시 1회만 읽히고 매 쓰기마다
전체가 덮어써지므로 외부 주입도 불가능하다.

**② 기존 Voice를 프로젝트로 이동 — UI에 있고 배정도 기록되지만, 전환이 커밋되지 않는다.**
실측(스레드 `019fe081`, `019fe107`): `thread-project-assignments`에 ShadowLoop이 `cwd`까지
정확히 박혀 있는데 `pendingCoreUpdate: true`이고, workspace 상태는
`applied.cwd` = 임시 폴더 / `pending.cwd` = 프로젝트로 갈라져 있다. 롤아웃의 모든
`turn_context`가 끝까지 임시 폴더였다. **이동은 진짜로 일어났고 실행 범위만 따라가지 않았다.**

- **"Start voice chat을 누르면 범위가 유지된다"는 문구를 다시 쓰지 말 것.** 실측으로 반증됐다.
- 단계 문구에 **조건부를 쓰지 말 것** — "임시 대화로 열리면"은 "안 그럴 수도 있나?"로 읽혀
  사용자가 같은 절차를 반복하게 만든다. 항상 그렇다고 단정해서 쓴다.
- 버튼은 **`applied` 상태로 결합된 기존 voice 대화만** 재개한다. `pending`을 재개해 주면
  쓰기가 임시 폴더로 가므로 가짜 보장이 된다.
- 상태는 셋이다: 없음(`PROJECT_VOICE_SESSION_NOT_FOUND`) / **이동 대기
  (`PROJECT_VOICE_MOVE_PENDING`, 실제 실행 폴더를 함께 알려준다)** / 재개 가능.
- 폴더 범위가 보장되는 경로는 **프로젝트 Codex 작업**(`codex://threads/new?path=`)뿐이다.
