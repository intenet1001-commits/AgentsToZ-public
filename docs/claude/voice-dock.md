# 아젠투지 음성 도크 · Codex Voice

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
  AiUsagePanel에서 export)으로 행마다 프로젝트·AI·컨텍스트 %(70% 이상 주황·90% 빨강)·로컬 저장/Supabase 백업 시각과 「지금 저장」·「동기화」를 준다.
  프로젝트 이름은 펼칠 때 한 번 읽는 `/api/ports`로 붙인다(독립 창에는 본창의 워크트리 목록이 없다 — 워크트리는 부모 경로 포함 판정으로 잡힌다).
  - 「지금 저장」 = 그 세션의 AI로 `session-end`(`preservePreferredAgent:true` — 프로젝트의 기본 AI를 바꾸지 않는다). 버튼은 **자기 질문만** 답한다
    (`resolveProjectMemorySaveButtonAction`과 같은 규칙, 프로젝트 패널과 같다): 새 활동이 있거나 장기기억이 아직 없으면 켜지고, 충돌이면 꺼진다.
    백업이 밀려 있는 것은 저장을 막지 않는다. 누를 때 상태를 다시 읽는다(자동 체크포인트나 다른 창이 방금 저장했을 수 있다).
    ⚠️ **장기기억을 새로 만드는 것(`start`)은 등록된 프로젝트·그 워크트리에서만** 한다 — AI 사용량 패널은 아무 폴더에나 「시작」을 주지만,
    한 번 누르는 이 목록에서는 `~/Downloads` 같은 폴더에 기억이 조용히 생길 수 있다. 등록되지 않은 폴더 행은 「등록되지 않은 폴더 · 장기기억 없음」.
  - 「동기화」 = `/api/project-memory/sync`(해시로 안전한 방향만). 충돌이면 덮어쓰지 않고 「프로젝트 화면에서 검토」라고 말한다.
  - **5초 폴링은 펼친 동안에만**(세션 5초, 기억 상태는 폴더마다 30초 캐시·한 번에 하나). 접으면 그 타이머가 사라지고 아래 「저장 안 된 작업」의 1분 검사가 이어받는다. 바깥 클릭으로 닫지 않는다 —
    저장 중에 다른 곳을 눌러 결과를 잃지 않게. Escape·토글로 닫는다. 설정 메뉴를 열면 닫힌다(둘이 쌓여 창이 길어지지 않게).
  - ⚠️ **패널은 `lazy`로만 가져온다** — `projectMemoryApi`가 든 `ProjectMemoryPanel`을 끌고 오므로, 항상 실리는 도크가 정적으로 가져오면
    지연 로딩이 깨진다(`tests/dock-notices-sessions.test.ts`가 지킨다).
  - 저장은 장기기억을 갱신할 뿐 열린 대화의 컨텍스트 %를 줄이지 않는다 — 패널이 그렇게 말한다.
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
  펼치기·닫기 뒤 새로고침에도 닫힘·모두 지우기·접힌 동안 5초 폴링 없음·행 내용·저장 1회 본문·동기화·Escape 뒤 폴링 멈춤·가로 스크롤 없음,
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
