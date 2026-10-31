# UI/UX · 디자인 시스템 · 휴대폰 화면

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## UI/UX
- **화면 문구 용어집은 `docs/ui-glossary.md`가 정본이다** — 아젠투지(OPS 프로필·음성·호출) · 워크룸(Workroom 아님) ·
  기기(단말 아님) · 올리기/받기(Push/Pull은 괄호) · 프로젝트 코드(해시 아님). `tests/ui-glossary.test.ts`가 소스를 검사한다.
  test id·help key·와이어 형식(`[로컬프로젝트해시: …]`)은 바꾸지 않는다.
- **긴 목록은 한 페이지씩 그린다** — 북마크·내가 한 말·정리 검토·아카이브는 `src/incrementalList.ts` +
  `components/IncrementalListMore.tsx`(관찰 센티널 + 「더 보기」 버튼)를 거친다. 새 긴 목록도 같은 것을 쓸 것.
- **북마크 탭 (2026-10-07)**: 앱 기본 창(1000px)에서 카테고리 칸이 접히면 대신 나오는 칩 줄이 가로 스크롤 상자라
  세로로 눌려(min-height 0) 칩이 전부 잘렸다 — `.portal-category-tabs`의 `flex-shrink:0`을 빼지 말 것. 900px 이하 컨테이너는
  칸 172px·카드 196px로 두 줄, 카테고리 묶음 안 카드는 카테고리 이름을 다시 붙이지 않고(`showCategory={false}`), 열어본 횟수는 「N회」.
  카드처럼 마우스가 늘 머무는 큰 영역은 `data-help-passive`로 hover 설명을 끈다(가이드 모드에서만 설명) — `TitleTipHost`의 `TIP_ANCHOR`.
  검증: `vite build --outDir <dir> && bun tests/portal-bookmarks-layout.e2e.mjs <dir>`.
- **도움말(가이드) 모드는 VOC 모드처럼 세션 한정이다** — 저장하면 다음 실행에서 모든 클릭이 막힌다.
  정적 `data-help-key`는 전부 `GUIDE_CONTENT` 항목이 있어야 한다(`tests/guide-content-coverage.test.ts`).
- **「도구 및 설정」(`WorkspaceTools` 접이식 패널)은 그 위의 모달을 누른 것을 바깥 클릭으로 세지 않는다 (2026-10-31)** —
  패널에서 연 대화상자(앱 열기 단축키·채널 연동 상태·작업공간 잠금 복구·AI 사용량 등)는 패널 바깥에 그려진다.
  예전에는 그 안을 누르기만 해도 패널의 `pointerdown` 바깥 클릭 처리가 패널을 접어, 대화상자를 닫고 나면 패널을 다시 열어야 했다
  (v1601 Codex 클릭 QA: 단축키 입력칸 클릭 → Esc). 판정은 `isModalLayerTarget`(`src/dialogEscape.ts`)이다.
  `aria-modal="true"` 요소 안이거나 그것을 **직계 자식**으로 둔 바깥 막이면 모달 층으로 본다.
  ⚠️ 새 대화상자는 `aria-modal="true"`를 대화상자 자신이나 바깥 막의 직계 자식에 둘 것 — 더 깊이 두면 바깥 막 클릭이 패널을 접는다.
  검증: `tests/dialog-escape.test.ts`, `tests/projects-tab-ui.e2e.mjs --tools-dialog-only`.
  ⚠️ 포커스된 입력칸이 대화상자와 함께 지워지면 WebKit은 blur를 보내지 않는다 — `onBlur`로 푸는 상태(예: 단축키 「기록 중」)는
  대화상자 닫힘에서도 풀 것. Esc가 기록 칸에서 대화상자를 닫게 된 뒤(949ce0b5) 다시 열면 「키를 누르세요...」가 남았다(v1603 QA, 닫힘 effect로 해결).
- **디자인 시스템 (2026-09 리디자인)**: 정본은 Claude Design 프로젝트
  `https://claude.ai/design/p/ccba361f-f7c9-4c63-b089-dcbedf5a0f9b`의 `AgentsToZ Redesign.dc.html` ·
  `AgentsToZ Mobile.dc.html` · `Design Tokens & Components.dc.html` 세 파일이다.
  - **토큰은 `src/index.css` 한 곳**: 웜 스톤 중립 + 코퍼 액센트 하나. `:root`가 다크, `[data-app-theme="gray"]`가
    기본(라이트). 의미 토큰 `--bg --surface --raised --sunken --line --line-2 --ink --ink-2 --ink-3 --accent* --term --scrim --shadow*`
    와 **의미 고정 상태색** `--ok`(실행) `--danger`(중지·삭제) `--info`(동기화) `--violet`(AI·별명) `--warn`(오래됨).
    알파가 필요하면 `rgb(var(--accent-rgb) / .12)` 처럼 `*-rgb` 삼중값을 쓴다.
  - **레거시 이름은 브릿지로 살아 있다**: `--bg-base/--bg-card/--text-primary/--border-subtle/--accent-amber(→accent)…`,
    Tailwind `zinc-*`·`text-<hue>-*`는 `--zinc-N`·`--ink-<hue>`를 거치고, 인라인 hex 색 `--ink-<hex>`는 전부 의미 토큰으로
    resolve 된다. 그래서 **새 색을 hex/rgba 리터럴로 쓰지 말 것** — teal(`#5eead4`/`rgba(94,234,212,…)`)은 옛 브랜드색이다.
  - **폰트**: `--font-sans`(Manrope Variable → Pretendard → 시스템 한글) · `--font-mono`(JetBrains Mono → 시스템).
    `@fontsource-variable/*` 로 **self-host** 한다 — Tauri CSP가 `font-src 'self'`라 Google Fonts CDN은 앱에서 막힌다.
  - **셸은 `src/workspaceDesign.css`**: 264px 사이드바(브랜드 → 탭 → 프로젝트 목록 → 작업 루트 → 화면 설정·「도구 및 설정」)
    + 56px 헤더(제목 15/700 · 카운트 mono · 「업데이트 N」 · 「실행 도구」 팝오버 · 「새 프로젝트」). 흩어져 있던 도구는
    두 팝오버로 묶는다 — **「도구 및 설정」= 데이터·연결**(내보내기/불러오기/클라우드에 올리기(Push)·받기(Pull)/QR/AI 사용량/마법사/작업공간 잠금 복구/채널 연동 상태),
    **「실행 도구」= 배율·터미널·AI 빠른 실행·Claude --bg/tmux/권한 우회·빌드**. 이동만 했지 testid·핸들러는 그대로다.
  - 위계는 색이 아니라 크기·굵기(제목 22/800 · 화면 제목 15/700 · 섹션 13/700 · 본문 13 · 보조 11.5 · 캡션 11), 테두리 우선,
    그림자는 떠 있는 것(팝오버·다이얼로그·토스트)에만. 터미널(`--term`)과 코드 블록은 두 테마 모두 어둡게 고정하고
    **xterm 내부(span·canvas·textarea·ANSI)는 전역 CSS로 덮어쓰지 않는다.**
  - 모바일(≤640px): 입력 16px, 버튼 44px 이상. 원격제어·포털 모바일 화면은 `AgentsToZ Mobile.dc.html`이 정본.
  - ⚠️ **iOS는 16px 미만 글자칸에 포커스하면 페이지를 16/글자크기 배로 확대하고 blur 뒤에도 그대로 둔다.** 워크룸 입력칸이
    13px라 휴대폰 포털이 1.23배로 확대돼 428pt 화면이 528pt 「페이지」가 됐다(TestFlight 712, 2026-10-09 — 「기록」 탭 365–468pt,
    종료 대화상자 왼쪽 잘림. CSS 폭은 그대로라 `scrollWidth`로는 안 보인다). `index.css`의 전역 16px 하한은 명시도 (0,0,1)이라
    `.ai-terminal-panel .ai-terminal-command textarea` 같은 컴포넌트 규칙에 **진다** — 글자 크기를 정하는 컴포넌트는 자기 모바일
    블록에서 16px를 다시 적고, iPhone 가로(640px 초과)·iPad도 확대하므로 `(max-width:640px), (pointer:coarse)`로 건다.
    `select`는 iOS가 메뉴로 열어 확대하지 않는다. 또 WebKit은 `appearance:none` select가 트랙 전체를 차지하는 grid 칸에 있으면
    선택된 긴 이름을 페이지 스크롤 폭에 더한다(428에서 692px) — `.ai-terminal-select`의 `overflow:hidden`을 빼지 말 것.
    검증: `tests/remote-workroom-ios-zoom.e2e.mjs`(Chromium·WebKit, 390/428/가로 926).
  - **휴대폰 레이아웃 감사(2026-10-16)**: 워크룸의 터치 크기(44px·select 16px)도 `(max-width:640px), (pointer:coarse)`에 건다 —
    iPhone 가로(926×428)가 데스크톱 밀도였다(키 30px·버튼 32px·기기 탭 28px·428pt 화면에 466px 터미널). 그 블록은
    `AiTerminalPanel.css` **맨 끝**에 둔다(같은 명시도의 세션 탭 36px 규칙을 이겨야 한다). 아이콘 버튼(「작업 세션 새로고침」)과 툴바 마지막 칸의
    44px도 `(pointer:coarse)`에서는 컨테이너 폭과 상관없이 준다 — ≤760px 컨테이너 안에만 두었더니 패널이 870px인 iPad 가로에서 32px로 남았다. 휴대폰 포털의 세션 목록은 160px 상자에
    가두지 않는다(두 번째 실행 중 세션이 숨은 안쪽 스크롤 뒤에 있었다). QR 스캐너 배경은 음성 도크(1000·전체 화면 1200)보다 위(1300)다.
    프로젝트 탭 「기기 선택」 팝오버는 하단 탭(z 40) 아래(39)이고 ≤430px에서는 도구 줄에 매단다. 검증: 포털 빌드 +
    `bun tests/remote-phone-layout.e2e.mjs <dir> [shots]`(WebKit·Chromium, 320/390/428·가로 926·iPad 가로 1180×820 — 문서 폭은 innerWidth가 아니라
    기기 폭과 비교, 44px, elementFromPoint로 겹침).
  - **휴대폰 화면 밀도(2026-10-02 아이폰 17 실기 점검)**: 내용 앞의 머리가 탭마다 ~200px였고 프로젝트 행 하나가 ~180px(버튼 5~6개), 북마크 카드가 ~200px였다.
    지금 ≤640px에서는 머리에 탭 이름만(`.remote-brand`·「내 작업 공간」 숨김), 자주 쓰는 프롬프트 줄은 홈·원격 작업에서만, 「QR 스캔」 큰 버튼은
    응답하는 Mac이 없을 때만(있으면 「연결 정보」 안 `remote-portal-scan-more`), 프로젝트 행은 「작업 · 더 보기」(`portal-project-row-more`),
    북마크 카드는 카드 탭 = 열기라서 「열기」 버튼을 숨기고 한 줄 바닥, 도크는 대기 중 「눌러서 말하기」 줄을 숨긴다. 버튼을 지운 것이 아니라 접은 것이다.
    워크룸은 **실행 중인 세션이 있으면 빈 「새 작업」 칸을 접는다**(`workroom-composer-toggle`, 초안 진입은 연다) —
    2026-10-05부터 휴대폰만이 아니라 Mac도 그렇다(세션 2개가 도는데 그 위에 빈 칸과 `0/24,000바이트`가 먼저 보였다).
    지우는 것이 아니라 접는 것이다: 첫 요청을 담아 새 세션을 여는 유일한 길이기 때문이다. ⚠️ 머리에서 브랜드를 숨기면
    그리드 첫 칸이 제목이 되도록 열 정의도 바꿔야 한다 — 안 그러면 VOC 버튼·「연결됨」이 1fr 칸으로 밀려 가로로 늘어난다(v565 실기에서 났다).
  - **휴대폰 워크룸은 세션을 전체 화면으로 연다 (w7, 2026-10-16)**: 카드 안의 카드에 머리·Mac 탭·하단 탭·음성 도크가 화면을 먹어 터미널이
    1/3쯤이었다(VOC: 「클로드·코덱스 원격은 안 답답한데」). Mac이 워크룸을 늘 새 창으로 여는 것처럼, 휴대폰(≤640px 또는 coarse pointer —
    `useWorkroomSessionFullscreen`, `src/workroomSessionView.ts`)의 원격 작업은 **두 단계**다. 포털이 `AiTerminalPanel`에 `sessionFullscreen`을
    명시적으로 넘기고(이 Mac·커뮤니티 기기 패널 둘 다), 패널은 `remote`일 때만 따른다.
    - **목록**: 기기 탭·대화 기록·커뮤니티는 그대로이고(실행 칸은 w11부터 「새 작업」 시트에 있다), 세션은 행(이름·AI, 소유, 상태, 「HH:mm 시작」, 44px+)이다. **터미널도 세션 입력칸도
      없다** — 그래서 목록에서는 `read`를 보내지 않고 `list`(5초)만 돈다(`sessionShown`이 xterm·읽기 effect를 막는다).
    - **세션 화면**(`workroom-session-view`, `role=dialog aria-modal`): body에 portal한 층이라 포털 머리·Mac 탭·하단 탭(40)·음성 도크(1000)를 덮고
      (z 1100), 자막 전체 화면(1200)·QR 스캐너(1300) 아래다. 위 줄 「← 워크룸」·세션 이름·세션 바꾸기 select·A−/A+·원본/읽기, 가운데 터미널(남은 높이
      − 32px — 나머지는 한 번 내리면: 사용법·교정 안내·작성 내용 보관·슬래시 줄·세션 하단(종료)), 아래 고정 입력칸 + 키 줄. **visual viewport**를 덮는다
      (`--workroom-view-top/height`) — iOS 키보드가 올라오면 함께 줄어 입력칸이 키보드 위에 남는다. 열린 동안 `:root[data-workroom-session-view]`가 페이지 스크롤을 막는다.
      가로 iPhone(가로 방향·높이 ≤500px)에서는 입력칸과 키 줄이 **한 줄**이다 — 위아래로 쌓으면 터미널이 428 중 202px로 인라인 카드(248px)보다 작았다.
      포털의 오프라인 배너와 음성 도크를 덮으므로 둘 다 스스로 말한다: 오프라인이면 `workroom-session-view-offline`(닫지 않는다), 음성 대화가 이어지는
      중이면 `workroom-session-view-voice`(「음성 대화가 계속됩니다 · 누구」 + 「음성 창 보기」(= 「←」) · 「음성 종료」) — 음성 상대 전환이 바로 이 화면을 여는
      것 중 하나라서, 통화 중에 도크의 상태·종료가 가려졌다(w7 리뷰).
    - **여는 것**: 새로 고른 세션은 무엇이든 — 행 탭, 「작업 시작」, 대화 기록 이어 열기(keepDraft entry), 세션을 지목한 entry·`resumeLatest`(프로젝트
      「작업하기」, 음성 상대 전환), 「그 세션으로 이동」, 그리고 (w11) 새로고침 전에 열려 있던 세션(아래). 열면 초점이 대화상자로 간다 — 입력칸에 주지 않아
      키보드가 바로 올라오지 않는다.
    - **닫는 것**: 「←」, 하드웨어 Escape(입력칸·터미널·목록·select 안이 아닐 때 — 거기서는 CLI의 Esc다. 화면에서 연 대화상자(「세션 종료」) 안의
      Escape는 그 대화상자만 닫는다 — `sessionViewEscapeCloses`의 세 번째 인자가 세션 화면 자신이다), 웹 포털(Safari·Chrome)의 브라우저 뒤로. 세션은 계속 돈다.
      ⚠️ **iOS 앱(TestFlight)에는 뒤로 제스처가 없다** — WKWebView가 `allowsBackForwardNavigationGestures = false`이고(`LANWorkroomView.swift`)
      페이지 기록용 뒤로 버튼도 없다. 앱에서는 「←」와 하드웨어 Escape만 닫으며, 앱의 네이티브 머리(「내 작업 공간」)는 이 화면 위에 그대로 남는다.
      초점은 그 세션의 행으로 돌아간다. 열 때 history 항목 **하나**(`{...state, workroomSessionView: token}`)를 push하고, 이미 열린 채 다시 열면 push하지
      않으며, 안에서 닫으면 그 항목을 `history.back()`으로 뺀다. 「세션 종료」 뒤에는 다른 세션을 열지 않고 목록으로 돌아온다. 탭·pane 전환·Mac 전환
      (언마운트)·선택 해제·넓은 화면이 되면 닫는다. Tab 키 초점 가두기는 없다(`aria-modal`과 덮개뿐).
      언마운트·남은 항목 정리는 한 턴 뒤에 한다 — StrictMode의 흉내 언마운트가 entry가 막 연 화면을 닫지 않게, 앞 Mac 패널이 자기 항목을 먼저 빼게.
    - ⚠️ **「워크룸을 떠남」은 `visible`이 아니라 `onScreen`이다.** 포털은 Mac의 프로젝트를 더 받는 동안(자동 sweep 재시도, 약 5초 뒤) `visible`을
      내린다. 그것을 떠남으로 읽던 동안 열어 둔 세션이 사용자가 아무것도 누르지 않았는데 닫혔고 다시 열리지 않았다(w7 리뷰). 포털이 두 패널에
      `onScreen={visible}`(탭·pane, 그리고 그 Mac이 연결됨)을 따로 넘기고, 불러오는 동안 세션 화면은 열린 채 터미널만 비었다가 돌아온다. Mac 연결이
      `online`을 벗어나면(다시 페어링·해지) 그것은 연결이 바뀐 것이라 예전처럼 닫는다.
    - ⚠️ **빈 걸음을 남기지 않는다** — 화면에 아무 변화 없는 뒤로·앞으로는 고장으로 읽힌다(w7 리뷰). 「←」 뒤의 **앞으로**는 그 항목에서 세션 화면을
      다시 연다(보일 세션이 없으면 그 항목을 건너뛴다). **새로고침**(iOS가 회수한 WebContent를 다시 띄울 때도)이 남긴 항목은 한 걸음 뒤로 물러나 그
      앞의 목록 항목으로 간다 — 제자리에서 표지만 지우면 똑같은 목록 항목 둘이 남았다. 판정은 이 로드가 만든 token 집합(`newWorkroomSessionViewToken`·
      `isStaleWorkroomSessionViewState`)이다. 패널이 스스로 부른 `back()`은 `viewBacks`로 세는데, 화면이 넓어져 닫힐 때는 listener가 이미 떨어진 뒤라
      그 popstate를 아무도 못 들었다 — 그래서 listener를 다시 달 때 0으로 돌린다(안 그러면 다음 진짜 뒤로가 삼켜졌다).
    - **키보드가 올라와도 PTY는 키보드 없는 크기다.** 휴대폰은 입력 직전에만 크기를 주장하는데, 그 순간은 대개 키보드가 올라와 있다. 줄어든 화면으로
      주장하던 동안 Mac의 CLI가 ~12줄로 다시 그려진 채 남았고, 키보드를 내리면 읽기 보기가 전체 화면에 12줄만 보였다(w7 리뷰). 지금은 키보드가
      올라온 동안(`visualKeyboardOpen` — visual viewport가 layout보다 120px·15% 넘게 짧음) xterm이 **키보드 없을 때의 행 수**를 유지하고(`fitScreen`,
      폭·글자 크기가 같을 때만), 위 행을 잘라 **커서 행이 보이게** 스크립트로 스크롤한다. 주장도 그 크기다. 키보드 없는 크기를 아직 모르면 예전처럼 맞춘다.
      키보드가 올라온 동안 입력칸 아래 홈 인디케이터 여백(`env(safe-area-inset-bottom)`)은 뺀다.
    - `@`·`/` 후보 목록은 입력칸 위로 열리되 **위 줄과 입력칸 사이의 높이**(`--workroom-menu-room`)를 넘지 않는다 — 가로 + 키보드에서 화면 위로 넘어가
      첫 후보를 누를 수 없었다. 세션 화면의 버튼은 `touch-action: manipulation`이다(`.remote-shell button` 규칙이 body 층에 닿지 않아, 키를 빨리 두 번
      누르면 iOS가 두 번째를 확대로 읽을 수 있었다).
    - ⚠️ **포털의 `navigateWorkspace`는 세션 화면 항목을 replace한다**(`withoutWorkroomSessionView`). `{...history.state}`를 그대로 push하면 새 탭 항목이
      그 표지를 들고 가 패널이 자기 항목으로 읽고 `back()`해 탭 전환을 되돌린다.
    - ⚠️ **로그인 정리의 `replaceState(null, …)`가 탭을 지웠다** — 상태 없는 항목은 popstate에서 「홈」으로 읽혀, 세션 화면에서 뒤로 가면 홈에 떨어졌다
      (이번 e2e가 잡았다). 이제 `workspaceTab`을 남긴다.
    - ⚠️ **body 층이라 범위 규칙이 닿지 않는다**: 루트에 `.ai-terminal-panel`을 함께 달아 패널 토큰·공용 규칙은 받지만, `.remote-workroom-content …`
      (글자 14/13px)와 `.remote-shell textarea`(16px 하한)는 `.ai-terminal-session-view`로 다시 적었다 — 빠뜨리자 가로 iPhone에서 xterm 보조 textarea가
      14px라 iOS 확대 대상이 됐다(`remote-workroom-ios-zoom.e2e.mjs`의 세 번째 상태가 잡았다).
    - 목록은 터미널을 읽지 않으므로, 보관된 입력(`REQUEST_UNSENT`·`…_AHEAD`)과 오프라인 입력 오류는 **성공한 `list`**도 지운다 — 컨트롤러는 outbox에
      무엇이 남아 있으면 모든 터미널 요청을 거절하므로 `list`가 됐다면 보관된 요청은 이미 나갔다(읽기 성공과 같은 근거). 예전에는 그 오류가 다음 탭까지 목록에 남았다.
    - 바뀌지 않는 것: Mac 앱·팝아웃·Mac이 다른 기기를 모는 `WorkroomDeviceSwitch`·데스크톱 브라우저(fine pointer)는 예전처럼 인라인이다. 보기만으로 PTY
      크기를 바꾸지 않는 규칙(주장은 여전히 입력 직전에만 한다), `projects` 내용 고정, 읽기 박자·snapshot, 제출 영수증·작성 내용 보관·`@` 전달·launch 영수증은 그대로다.
      **같은 Wi‑Fi QR 페이지(`remoteControlMobilePage.ts`)에는 전체 화면 보기를 넣지 않는다(결정, w11·critique 36)** — 그 페이지는 터미널
      하나가 본문인 비상용 화면이고(세션 목록이 select 하나), React 패널이 아니라 `toString()`으로 심은 함수들이라 두 번째 구현을
      만들면 표면이 두 배가 된다. 휴대폰 작업의 주 화면은 포털이다. 대신 그 페이지의 「세션 종료」는 확인을 받고 키 줄에서 떨어져
      세션 줄(「세션 기억하기…」 옆)에 있고, 입력칸은 textarea다(Enter 전송·Shift+Enter 줄바꿈·IME 조합 중 Enter는 무시, 여러 줄은 한 번에).
    - 검증: 포털 빌드 + `bun tests/remote-phone-layout.e2e.mjs <dir> [shots]`(WebKit·Chromium, 320/390/428·가로 926·iPad 1180: 목록에 터미널 없음, 행 탭 =
      화면 전체 덮개·터미널 ≥55%(375pt 이상 세로)·머리/하단 탭/도크 덮임, 흉내 낸 키보드에서도 입력칸이 보이는 영역 안, 「←」·뒤로·Escape·초점 복귀·history
      push 1회·back 1회, 탭 전환이 항목을 replace, 「작업 시작」이 연다, 목록에서 read 0, 오프라인 안내, 데스크톱 1280 fine pointer는 인라인 그대로;
      w7 리뷰: 버튼의 touch-action, 가로 터미널 ≥ 인라인 카드, 키보드 위 입력의 주장 행 수 ≥ 키보드 없는 행 수·원본 터미널에서 커서 행이 보임, 가로·320pt +
      키보드에서 `@` 목록이 화면 안, 「세션 종료」 대화상자의 Escape, 「←」 뒤 앞으로, 그리고 따로 도는 세 경우 — 자동 sweep 재시도 중 열린 화면 유지,
      보관된 입력 오류가 `list`로 지워짐, 600px 데스크톱 창을 넓혔다 좁힌 뒤 뒤로 한 번에 닫힘),
      `tests/workroom-usability.e2e.mjs`의 `remote-fullscreen-*`(entry·이어 열기 keepDraft·resumeLatest·시작·「그 세션으로 이동」·세션 종료; 불러오는 동안
      유지·대화상자 Escape·음성 대화 줄·새로고침이 남긴 항목), `tests/remote-workroom-ios-zoom.e2e.mjs`, `tests/workroom-session-view.test.ts`.
      ⚠️ Playwright에는 화면 키보드가 없다 — 키보드는 visualViewport 값을 덮어써 흉내 냈을 뿐이고(세로 42%·SE 46%·가로 49%) 실기 iPhone 키보드로는 아직
      확인하지 않았다. 음성 대화 줄은 `voiceMediaClient`의 상태를 직접 넣어 확인했다(실제 통화로는 아니다).
  - **휴대폰 워크룸 다듬기 (w11, 2026-10-16 — 계획 S4, critique 17·34·35·36)**:
    - **받은 편지함 먼저**: 휴대폰(`sessionFullscreen`)의 원격 작업은 머리·Mac 탭 바로 아래가 워크룸 카드이고, 카드 첫 줄이
      「작업 세션 N · ⟳ · 새 작업」(`workroom-new-task`) 한 줄, 그다음 기기 탭·세션 행·「종료된 세션 보기」·「세션 기억하기…/내가 한 말」,
      카드 뒤에 접힌 「더 보기」(`remote-workroom-more` / `-toggle`) — 프로젝트 관리·워크룸 이어가기·쌓인 VOC·커뮤니티·
      대직 버튼과 자주 쓰는 프롬프트 줄이 그 안에 있다(지운 것이 아니다, testid 그대로). 그중 한 칸을 고르면 「더 보기」는 열린 채 세션
      자리에 온다. 휴대폰은 원격 작업을 `workroom` 칸으로 열고, 커뮤니티·대직을 다시 누르면 `projects`가 아니라 세션으로 돌아간다.
      ⚠️ 프롬프트 줄은 **한 요소를 두 자리(맨 위·「더 보기」) 사이로 옮긴다**(`guideHost` + 포털) — 두 번 렌더하면 다시 마운트돼 불러온
      목록이 사라진다. 기기 탭은 휴대폰에서 한 줄 가로 스크롤이다. 첫 실행 중 행은 세로 모든 크기에서 253–372px, 가로 926×428·844×390에서
      263–328px이다(예전 390×844에서 1,273px).
      ⚠️ **「새 작업」을 목록 끝에 두지 말 것(리뷰)** — 쉬고 있는 화면에서 떠 있는 음성 도크가 그 자리(하단 탭 바로 위 띠)를 덮어, 390×844에서
      「새 작업」을 누르면 음성 패널이 열렸고 SE(375×667)에서는 첫 행까지 도크 아래였다. 그래서 머리 줄에 두고(Claude·Codex 앱도 「새」는 위에
      있다), 「기기」 라벨·소유 줄·「누르면 전체 화면」 안내는 화면 읽기용으로만 남기며(`ai-terminal-panel--overview`), 카드 가장자리를 줄이고
      (`remote-workroom-content--overview`), 넓은 칸(≥560px)에서는 행을 한 줄로 한다(이름은 말줄임). ⟳는 세션이 없어도 머리 줄에 있다 — 예전에는
      목록 머리에만 있어 빈 목록에서 「터미널 새로고침」이라는 안내가 없는 버튼을 가리켰다. 짧은 가로 화면에서는 도크가 첫 행의 오른쪽 끝(시작 시각·꺾쇠)
      위에 뜬다 — 행 전체가 한 탭 대상이라 왼쪽·가운데가 비어 있으면 된다고 보았다.
    - **「새 작업」 시트**(`workroom-new-task-sheet`, body 층 z 1100, visual viewport): 프로젝트·AI·권한 우회 칩·계정(**계정이 둘 이상일
      때만**, `CliAccountPicker onlyWhenChoice`)·첫 요청·**시작 버튼 하나**. 도움말은 「?」(`workroom-new-task-help` → `-hints`) 뒤에 있다.
      세션 화면의 @/#·IME 안내도 「?」(`workroom-command-help`) 뒤다. 요청 칸을 여는 모든 것(요청을 실은 entry, 세션 기억하기…, 기억 검토)은
      휴대폰에서 이 시트를 연다. 시작하면 새 세션이 전체 화면으로 열리며 시트는 닫힌다. 시트의 입력칸도 16px 하한을 다시 적었다.
      시트는 세션 화면처럼 **history 항목 하나**(`workroomNewTask` 표지)를 가진다 — 웹 포털의 뒤로(Safari 가장자리 밀기)는 시트만 닫고(초안 유지)
      원격 작업에 남는다, 앞으로는 다시 연다, 「닫기」·Escape·떠남은 그 항목을 한 턴 뒤에 뺀다, 시작하면 세션 화면 항목이 그 자리를 **대신한다**
      (새 세션에서 뒤로 가면 목록이지 시트가 아니다), 이전 로드가 남긴 항목은 한 걸음 물러난다. 포털 탭 이동은 그 항목을 view 항목처럼 replace한다.
      시트는 개요를 덮으므로 **결과 미확정 launch 배너와 「새 세션 시작 결과 확인」이 시트 안에도 나온다**(열려 있을 때는 시트에만) — 없던 동안 같은
      프로젝트·AI의 시작 버튼이 이유 없이 꺼졌다. 막힌 그 조합은 `workroom-new-task-blocked`가 말한다. 시트의 OPS 안내는 「이 창을 닫고」
      「아젠투지 호출」을 누르라고 한다(도크가 시트 아래다). 새로고침 뒤 첫 목록을 기다리는 「있던 곳으로」 복원은 그 사이 사용자가 시트나 요청 칸을
      열었으면 하지 않는다(예전엔 시트를 닫고 키보드를 내리고 세션을 열었다).
    - **읽기 보기는 아래에 붙는다**: 바닥에서 40px 안이면 새 출력을 따라가고, 위로 읽고 있으면 「새 출력 ↓」(`workroom-readable-new-output`).
    - **있던 곳으로**: 열린 세션은 Mac별(`sessionScope`)로 localStorage에 30분 TTL로 기억한다(`src/workroomSessionView.ts`의
      `rememberOpenWorkroomSession`, 숨겨질 때 그리고 보고 있는 동안 그 세션을 읽을 때마다 1분에 한 번 `refreshOpenWorkroomSession`으로 갱신 —
      TTL은 연 때가 아니라 마지막으로 본 때부터 센다(리뷰: 30분 넘게 앞에 둔 채 새로고침하면 목록에 떨어졌다)) — 새로고침·iOS가 회수한 WebContent의 재로드 뒤 첫 목록에서 그 세션이 **아직 실행 중이면**
      전체 화면으로 다시 연다(끝났으면 목록). 닫으면(「←」·뒤로·종료·떠남) 잊는다. 새로고침이 남긴 항목은 예전처럼 한 걸음 물러난 뒤 다시
      열므로 history 길이가 늘지 않는다. ⚠️ 이게 되려면 **`remote/index.html`의 인라인 부트스트랩이 `history.state`를 보존해야 한다** —
      예전에는 `replaceState(null,…)`로 지워 새로고침마다 홈에 떨어졌다(탭도 잃었다). 그 스크립트를 바꾸면 CSP 해시를 세 곳(`remote/index.html`·
      `vercel.json` 두 줄·`mobile/ios/App/PortalSchemeHandler.swift`) 함께 바꾼다. `?tab=workroom`은 패널까지 연다(`terminalOpen`).
    - **정직한 전송 상태**: 전체 요청 제출이 가는 중이면 「보내는 중…」(`workroom-submission-sending`)이고, 복구 배너(`workroom-submission-recovery`)는
      결과를 모를 때(답 유실·시간 초과·미확정 영수증·로드 때 남은 기록)만이다. 배너의 두 버튼은 `ai-terminal-btn`(휴대폰 44px).
      ⚠️ **휴대폰(`sessionFullscreen`)에서만이다** — Mac·팝아웃·데스크톱 브라우저는 예전처럼 보내는 동안에도 복구 배너(꾸밈 없는 버튼)와
      「요청 전송 확인 중」이다(리뷰: 이 변경이 모든 표면에 번졌었다).
    - **launch 영수증만 온 시작**: `refresh()`가 읽은 목록을 돌려준다 — 예전엔 렌더 뒤에야 바뀌는 `sessionsRef`를 읽어 새 세션을 못 찾고
      아무것도 하지 않았다. 세 번까지 목록을 읽어 고르고, 그래도 없으면 「새 세션이 열렸습니다 — 목록을 확인하세요」. 그동안 시작 버튼은 꺼져 있다.
    - **음성 도크가 가리지 않는다**: 포털의 `html { scroll-padding-bottom }`이 하단 탭 + `--voice-dock-offset`이라, 끝으로 스크롤되는
      대상(초점·scrollIntoView)이 탭과 도크 위에 선다.
    - 검증: 포털 빌드 + `bun tests/remote-phone-layout.e2e.mjs <dir> [shots]`의 `inbox-first`·`new-task`·`dock-clear`·`readable-bottom` 단계와
      `reload-`·`sending-`·`launch-` 검토 사례(WebKit·Chromium), `tests/workroom-open-session.test.ts`, `tests/remote-control-mobile-close-and-line.test.ts`,
      `tests/workroom-usability.e2e.mjs`의 `remote-fullscreen-reload-reopens-the-open-session`. 리뷰 수정: remote-phone-layout의 `rest-<크기>`
      (쉬는 개요를 320·375·390·393·428 세로와 926×428·844×390 가로에서 — 첫 행·「새 작업」이 하단 탭 위에서 도크에 덮이지 않음)·`new-task-back`·
      `new-task`의 OPS 문구, workroom-usability의 `mac-submission-in-flight-keeps-the-recovery-banner`·
      `remote-fullscreen-reload-restore-yields-to-an-open-new-task-sheet`·`remote-fullscreen-sheet-shows-the-unsettled-launch-that-blocks-its-start`·
      `remote-fullscreen-open-session-record-stays-fresh-while-watched`·`remote-fullscreen-empty-list-keeps-the-refresh` — 모두 수정 전 코드에서 실패한다
      (`session-start`의 「새 세션에서 뒤로 = 목록」 검사는 시트 항목을 넣으면서 같이 지키는 가드다). ⚠️ 실기 iPhone(WebContent 회수 재로드 자체·화면
      키보드)로는 아직 확인하지 않았다 — 재로드는 Playwright `page.reload()`로만 흉내 냈다.
- **자주 쓰는 프롬프트 — 간단 프롬프트 / 규격 명령 (2026-09-25)**: 한 저장본(`prompt-guides.v1.enc` · 공유 `portmgr_prompt_guides`)에
  두 종류가 섞여 있다. 판정은 `src/promptLibrary.ts` 한 곳(`promptKindOf`) — `kind`가 없으면 **간단 프롬프트**(그 전의 모든 항목),
  `kind:'command'`만 **규격 명령**이다. 간단 프롬프트는 5개 키 그대로 저장한다(옛 sidecar·옛 DB와 호환). 공유 DB가 규격 명령을
  받으려면 마이그레이션 `20260925040000_prompt_guide_kind.sql`이 필요하다(정본 `src/sharedPromptGuideSql.ts`).
  **라이브에 적용돼 있다(2026-10-06 실측)** — 이력에 기록돼 있고 `portmgr_prompt_guides_save` 본문이 `kind`를 다룬다.
  ⚠️ 이 마이그레이션은 **컬럼을 더하지 않는다**(함수만 교체, `kind`는 `entries` jsonb 안에 있다) — `portmgr_prompt_guides`에
  `kind` 컬럼이 있는지로 적용 여부를 판정하지 말 것(그렇게 보면 영원히 미적용으로 읽힌다).
  - 고정 위치가 종류로 갈린다: 고정한 간단 프롬프트 → 상단 막대 칩, 고정한 규격 명령 → 「도구 및 설정 → 도구·연결」 복사 버튼
    (`components/PinnedCommandButtons.tsx`). 도구 영역은 저장본을 따로 읽지 않고 막대가 `promptLibraryHub`로 알린 목록을 쓴다.
  - 예전 하드코딩 두 버튼(VOC 처리→…, 깃허브 최신화→…)은 **기본 규격 명령**(`builtin-voc-workflow`·`builtin-git-sync-workflow`)이다.
    사용자가 손대기 전엔 저장되지 않은 가상 항목이고 복사 시 현재 프로젝트 경로로 예전과 같은 문자열을 만든다. 고치거나 순서를
    바꾸거나 고정을 풀면 그때 사본이 저장된다. 삭제 대신 고정 해제만 준다. test id(`voc-workflow-prompt-copy` 등)는 그대로다.
  - 「AI로 규격 명령 만들기」는 고른 워크룸(기본 **OPS 운영 워크룸**, 없으면 DEV)에 요청문(`buildStandardCommandMetaPrompt`, 목적·전제·단계·확인 기준·
    금지 사항·보고 형식)을 **초안으로** 넣고 빈 규격 명령 초안을 준비할 뿐이다. ⚠️ AI 결과를 자동 저장하지 말 것 — 사용자가
    붙여 넣고 저장 버튼을 눌러야 저장된다. 워크룸이 없는 표면(포털)은 「요청문만 복사」.
  - 그 선택 칸은 **소유 프로젝트가 아니라 초안을 쓸 AI를 띄울 곳**이다 — 규격 명령은 어느 프로젝트에도 묶이지 않는다.
    라벨이 「프로젝트」였고 기본값이 DEV라서 "명령이 그 프로젝트 소속"으로 읽혔다(VOC 2026-09-25). 라벨·안내문을 되돌리지 말 것.
  - 프롬프트 버튼에는 `title`을 두지 않는다 — `usePromptPreview`(`components/PromptPreview.tsx`)가 마우스 오버·키보드 초점·
    길게 누르기(터치)로 처음 6줄 높이의 스크롤 미리보기를 그린다. 모달 `<dialog>` 안에서는 그 dialog에 포털한다(top layer).
  - ⚠️ `PromptGuideBar`·`DesktopPromptGuideBar`는 `memo`이고 App은 **모듈 수준/ref 고정 콜백**만 넘긴다. 인라인 람다를 넘기면
    App이 렌더될 때마다 대화상자 트리 전체가 다시 그려진다(실측: 호스트 50회 렌더에 75ms → 0ms, `tests/prompt-library.e2e.mjs`).
- **Toast 알림 시스템**: 서버 실행/중지 시 플로팅 배너 표시
  - 우측 하단 잉크색 알약(`.workspace-toast`) — 앞의 점 색으로 성공/경고/실패 구분(초록/앰버/빨강)
  - 3초 후 자동 제거 또는 수동 닫기 가능
  - Non-blocking UI로 사용자 작업 방해 없음
- **SetupGuide 컴포넌트**: Supabase 초기 설정 안내 (포털 설정 모달 내 아코디언)
  - 3개 테이블 DDL을 Claude Code 프롬프트 형태로 제공
  - "Claude 프롬프트 복사" 버튼으로 클립보드 복사 (2초 후 초기화)
  - 위치: `PortalManager.tsx` `SetupGuide` 컴포넌트
- **포트 정렬**: 3가지 옵션 + 오름차순/내림차순 토글 (최근 등록순, 이름순, 포트순)
- **고정 그룹 순서 변경(사이드바)**: 순서 계산은 `src/pinnedOrder.ts` 한 곳, 저장은 기기별
  localStorage(`portmanager-pinned-order`)다. ⚠️ **HTML5 드래그(`draggable`+`dragover`/`drop`)로
  구현하지 말 것 — 앱에서 동작하지 않는다.** Tauri 웹뷰의 파일 드롭 핸들러가 드래그를 전부
  가로채서(`tauri-runtime-wry`의 리스너가 항상 true를 반환 → wry가 WebKit 기본 동작을 호출하지
  않음) `dragstart`만 뜨고 `dragover`/`drop`이 도달하지 않는다. 웹에서는 잘 돼서 앱에서만 죽는
  형태다. 핸들러를 끄면 FolderDropZone의 절대경로 파일 드롭이 죽으므로, 순서 변경은
  포인터 이벤트(`pointerdown`/`move`/`up` + `setPointerCapture`)로 하고 네이티브 드래그
  세션을 시작하지 않는다. 드롭 위치는 좌표→행 매핑(`pinnedDropTargetAt`)으로 정하며,
  목록 위/아래로 벗어난 좌표는 첫/마지막 행으로 붙인다(끝으로 옮기는 길을 막지 않기 위해).
- **최적화된 창 크기**: MacBook 14인치 기준 세로 최대화 (1000x1050)
- **터미널 스플릿뷰 수정/삭제 컨트롤**: 헤더 우측 아이콘 버튼(`Pencil`/`Trash2`)으로 배치 (App.tsx:3935–3941) — 워크트리 패널 버튼과의 혼동 방지
- **Claude 버튼 레이블**: 이모지 없이 텍스트만 사용 (`Claude 열기` / `새창`) — 🤖 재추가 금지
- **프로젝트 상세 패널 AI 이름/카테고리**: `aiName`/`category`를 InlineUrlRow로 표시+클릭 수정, "AI 생성" 버튼(Sparkles 아이콘)으로 단일 프로젝트만 재생성 가능 (`handleAiSuggestSingle`, App.tsx) — 폴더 경로 없는 프로젝트는 버튼 비활성화
- **프로젝트 코드 복사**: 상세 패널 메타 정보 첫 줄 "코드" — `projectCode(sel.id)`(`src/projectCode.ts`, 기존 `id`의 UUID 첫 세그먼트 8자 대문자)를 표시하고 "코드 복사" 버튼으로 클립보드 복사. 이름은 바뀌지만 이 코드는 고정이라, 블로그 초안처럼 프로젝트 폴더 밖의 노트·대화에서 "이 내용이 어느 프로젝트에서 나왔는지"를 절대경로 없이 참조할 때 붙여넣는 용도. 새 필드나 데이터 마이그레이션 없이 기존 `id`에서 파생 — 표시 전용
