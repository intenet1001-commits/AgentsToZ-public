# 워크룸 `@` 전달 · 작성 내용 보관 · 첫 요청 영수증

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 워크룸 `@` 전달 — 받는 AI는 보내는 AI와 달라도 된다 (2026-09-29)

`@받는 곳`은 예전에 **보내는 세션의 AI로만** 새 세션을 열고, 시작 직후 그 CLI에 핸드오프를 타이핑한 뒤 화면을
그쪽으로 옮겼다 — Antigravity로 연 OPS 워크룸은 Antigravity에게만 일을 넘길 수 있었다. 판정은
`src/workroomProjectMention.ts`의 `planWorkroomRoute`/`defaultWorkroomRouteAgent` 한 곳이다.

- 「받는 AI」를 고른다(Mac 화면에서는 앱도 고를 수 있어 라벨이 「받는 곳」이다 — 아래 「데스크톱 앱으로 보내기」. 휴대폰 포털·LAN QR
  페이지·다른 기기 경로는 CLI만이라 「받는 AI」 그대로다). 기본값은 대상에서 **이미 실행 중인 세션의 AI**(가장 최근 것), 없으면 보내는 세션의 AI.
- 같은 프로젝트·같은 AI = 지금 대화(확인 없이 그대로 보냄). 그 밖에는 **그 AI의 가장 최근 실행 중 세션에 전달**하고,
  없을 때만 새 세션을 연다. ⚠️ 새 세션에는 핸드오프를 **시작 `prompt`(첫 요청)** 로 넘긴다 — 막 뜬 CLI에 타이핑하면
  폴더 신뢰·로그인 화면이 그 글자와 Enter를 받아 버린다. `#` 참고는 `start`의 `references`로 함께 간다(`prompt`가
  있을 때만 허용). 그 키를 모르는 옛 Mac이면 참고 없이 다시 시작하고 영수증에 그 사실을 적는다.
- 확인 대화상자는 유지하고 어느 세션이 받는지 말한다. 전달 뒤 **보내는 쪽은 자기 세션에 남고** 영수증의
  「그 세션으로 이동」으로 넘어간다(`workroom-route-receipt`). 핸드오프 머리에 `보낸 AI:`가 붙는다.
- LAN QR 페이지(`remoteControlMobilePage.ts`)는 같은 함수를 **`toString()`으로 심어** 쓴다(사본이 아니다) —
  그래서 위 함수들은 **모듈 스코프를 참조하면 안 된다**(`tests/workroom-project-mention.test.ts`가 단독 실행으로 지킨다).

**전달을 안전하게 — 2026-09-29 리뷰(H1·H2·M1·M2·L1·L3·L4·L6).** 정본은 `src/workroomRouteDelivery.ts`다. 패널(데스크톱·포털)은
`deliverWorkroomRoute` 하나로 전달하고, LAN 페이지는 그 파일의 화면 함수들을 위와 같이 `toString()`으로 심는다.
- **실행 중인 세션에 넣기 전에 그 화면을 읽는다**(M2). 보고 있지 않은 세션이 승인·폴더 신뢰·메뉴·y/n 질문에서 멈춰 있으면
  핸드오프 끝의 Enter가 그 답(강조된 기본값)이 된다. 받는 세션을 `read`(`snapshot`)로 받아 버려지는 xterm에 그리고
  (`renderWorkroomScreenLines`) `workroomScreenAwaitsAnswer`로 판정한다 — 질문 화면이면 **입력하지 않고** 확인창에 마지막 줄을
  보여 주며 새 세션을 대신 열지(확인) 초안을 둘지(취소) 묻는다. 확인창은 언제나 「Enter를 누릅니다」라고 말하고, 떠 있는 동안
  질문 화면으로 바뀌었을 수 있어 **입력 직전에 한 번 더** 읽는다. 받는 세션은 탭 이름(`#n`)으로 밝힌다(L4 — 확인창·미리보기·영수증).
- **새 세션의 첫 요청이 담길 수 있는 크기는 연결마다 다르다**(H1/M1). Mac 자신은 호스트 첫 요청 24,000바이트, 휴대폰 포털은
  릴레이 평문 11,000바이트(`workroomStartCarriesPrompt`), LAN 페이지는 16KiB 프레임이다. ⚠️ **LAN 서버는 16KiB를 넘는 메시지
  하나에 1008로 닫고 그 페어링을 끝낸다**(복구하면 `SESSION_EXPIRED`, Mac에서 새 QR뿐) — 그래서 LAN 페이지는 `terminalWireRequest`가
  예산(`REMOTE_CONTROL_LAN_PAGE_MESSAGE_BUDGET_BYTES`, `src/remoteControlLanLimits.ts`)을 넘는 메시지를 **보내지 않고**, 새 세션
  첫 요청이 넘으면 확인창 전에 거절하고 초안을 둔다. 패널은 담을 수 없는 첫 요청을 새 세션을 그냥 연 뒤 **화면이 준비되면**
  (출력이 멈추고 질문 화면이 아닐 때, `waitForWorkroomReady`) 4KiB 조각으로 입력한다. 옛 Mac이 첫 요청을 거절할 때(2026-09-22 이전의
  Hermes·agy, L6)와 참고 폴더를 더해 24,000바이트를 넘어 호스트가 다시 거절할 때(L3,
  `AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR`)도 같은 길이다. 준비되지 않았거나 질문 화면이면 입력하지 않고 초안을 둔다.
- ⚠️ **LAN 페이지의 보내는 쪽은 선택한 세션 자신이다**(H2). 프로젝트·AI 드롭다운은 그 세션의 보기일 뿐이고, 받는 쪽으로는
  **받은 뒤에만** 바꾼다(입력 대기열이 거절하면 되돌린다). 예전에는 시작 전에 바꿔서, 시작이 거절되면 다음 「전송」이 핸드오프
  머리 없이 보내는 쪽 세션에 그대로 입력됐다.
- 원격 입력은 참고 폴더 해석·화면 대기(bracketed paste 판정) 뒤, **PTY에 쓰기 직전에 권한을 다시 확인한다**(L1, `#authorityLost`).

**여러 줄 입력은 붙여넣기로 보낸다** — 바이트 순서의 정본은 `src/aiTerminalSubmit.ts`의 `aiTerminalSubmitSteps` 하나다
(작성칸·`@` 전달·MCP `send_workroom_instruction`이 모두 `writeAiTerminalInput`을 거친다).
- 줄바꿈(LF)이 든 글은 세션의 headless 화면이 **DECSET 2004(bracketed paste)를 켰을 때만** `ESC[200~…ESC[201~`
  한 번으로 쓰고(줄바꿈은 xterm.js처럼 CR), 측정된 지연(Codex 150ms/그 외 40ms) 뒤 Enter를 따로 쓴다. 증거가 없으면
  바이트는 예전 그대로다. 글 안의 붙여넣기 표지는 지운다 — 남기면 나머지가 키 입력과 Enter로 읽힌다. ⚠️ 한 번에 지우면
  겹쳐 넣은 표지(`ESC[20`+`ESC[201~`+`1~`)가 새 끝 표지로 살아나므로 **없어질 때까지 반복한다**(L2). ESC가 든 글은 아예 감싸지 않는다.
- ⚠️ **키 입력은 절대 붙여넣기로 바꾸지 말 것.** 한 글자·CR만 있는 입력(직접 입력 모드의 Enter)·xterm이 이미 감싼
  붙여넣기는 그대로 간다 — 메뉴에서 「1」+Enter가 선택으로 동작해야 한다.
- 4KiB로 나눌 때 Enter가 혼자 마지막 요청이 되지 않게 `splitTerminalSubmission`이 본문 끝을 함께 싣는다.
- ⚠️ **나눈 부분은 한 묶음(`terminalSubmissionGroup`)이다 — 한 부분이 거절되거나 잃어버려지면 나머지는 보내지 않고, 그 세션에서 아직 보내지 않은
  입력도 모두 버린다.** 예전 요청 대기열은 실패한 부분 뒤에도 계속 보냈고, 휴대폰 대기열은 부분들 사이에 읽기까지 끼웠다(`MAX_WRITES_BEFORE_READ`).
  그래서 가운데가 빠진 채 앞과 뒤가 Enter까지 입력돼 **다른 명령**이 될 수 있었다(리뷰 2026-10-09 재현: `git push --force origin HEAD:` + `main`).
  같은 묶음만 멈추면 부족하다 — 실패가 알려지기 전(릴레이에서 최대 ~60초) 사용자가 보낸 다음 입력이 남은 앞부분 뒤에 붙어 같은 결과가 난다.
  메시지는 **한 번**, 진짜 원인 뒤에 `PARTIAL_SUBMISSION_NOTICE`(「입력 일부만 전달됐을 수 있습니다 — CLI 입력칸에 남은 글을 지운 뒤 다시 보내세요」)를
  붙여 보여 주고 버려진 것들은 조용하다(`partOfFailedSubmission`). 대기열 상한에 걸린 부분도 그 묶음을 실패시킨다. 워크룸 패널(작성칸 `sendBoundInput`,
  직접 입력 `flushTransport`)과 LAN 페이지(`terminalInput` — 일부러 취소한 것은 오류를 띄우지 않는다)가 같은 규칙이고, `@` 전달(`workroomRouteDelivery`)은
  원래 부분마다 기다리고 실패하면 멈춘다. 묶음은 와이어에 실리지 않는다. 한계: 직접 입력으로 붙여 넣은 큰 글이 중간에 멈추면 CLI가 붙여넣기 모드에
  남을 수 있다(끝 표지가 마지막 부분에만 있다 — 실제 CLI로는 확인 안 함). Mac의 공용 셸 대기열(`workroomSharedShellInputQueue`)은 로컬 전용이라 손대지 않았다.
  검증: `tests/ai-terminal-scheduling.test.ts`(원격·로컬 요청자, 상한, LAN 페이지 함수를 그대로 실행 — 수정 전 넷 실패).
- ⚠️ 측정된 150ms는 **CLI가 키를 읽고 있을 때만** 의미가 있다. 크기 변경 뒤 답 없는 CPR로 Codex가 멈춰 있으면 본문과 Enter가
  한 번에 읽혀 그 간격이 사라진다(위 「워크룸 터미널 질의는 호스트가 한 번만 답한다」). 지연을 늘려 덮으려 하지 말 것.
- ⚠️ **그 간격은 본문이 실제로 전달된 뒤부터 센다.** Bun의 PTY 쓰기는 다음 이벤트 루프 차례에야 CLI에 닿는다(`setImmediate`로는
  부족하고 타이머 한 차례면 된다 — 실측). 그래서 본문을 쓴 직후 사이드카 루프가 200ms 이상 막히면(동기 spawn 등) 본문과 Enter가
  한 번에 읽혀 같은 증상이 났다(실제 Codex: 200ms 정지 0/6, 크기 변경과 무관). `writeAiTerminalInput`은 기다리기 전에 타이머 한
  차례를 양보한다 — 빼지 말 것.

## 워크룸 작성 내용 보관 — 암호화·opt-in·정지된 대기열 (S3-8, 2026-10-15)

작성칸 아래 「작성 내용 보관」(`workroom-draft-vault-settings`)을 켜면 보관함에 넣은 요청과 **보내는 요청**을 이 브라우저(앱) origin의
IndexedDB에 암호화해 둔다. 정본: `src/workroomDraftVault.ts`(보관)·`src/workroomDraftQueue.ts`(복원·보내기)·`src/WorkroomDraftQueuePanel.tsx`(화면).
제출 영수증 기록(`agentstoz:pending-submission:v1`)은 글을 남기지 않으므로, 탭을 닫으면 사라지던 원문을 지키는 길은 이것뿐이다.

- **기본은 꺼짐이고 기기별이다**(localStorage `agentstoz:workroom-draft-vault:v1`). 장기기억·「내가 한 말」 동의와 별개다. 꺼져 있거나
  IndexedDB·WebCrypto·보안 컨텍스트가 없으면 금고 객체를 만들지 않는다(`draftVaultIfEnabled`) — 아무것도 열거나 쓰지 않고 작성칸은 예전 그대로다.
  끄면 보관한 요청과 키를 모두 지운다. LAN QR 페이지(http)에는 `crypto.subtle`이 없어 기능이 없고, 동의 문구가 그렇게 말한다.
- ⚠️ **끄기는 그 패널만의 일이 아니다.** 팝아웃·세션 목록 대화상자·다른 탭은 각자 금고 객체를 들고 있어서, 한 곳에서 끈 뒤에도 다른 곳의
  「현재 세션에 전송」이 원문을 계속 봉인했다(리뷰 2026-10-15). 그래서 ① 금고가 **쓰기 앞뒤로 플래그를 다시 읽고**(`createGatedDraftVault`,
  꺼져 있으면 `DRAFT_VAULT_OFF`, 쓴 뒤 꺼져 있으면 스스로 지운다) ② 끄기는 **플래그를 먼저 지우고 그다음 비운다**(`turnDraftVaultOff` —
  비우기가 실패하면 플래그를 되돌려 「꺼짐」인데 글이 남는 상태를 만들지 않는다) ③ 모든 패널이 `storage` 이벤트와 BroadcastChannel로 따라 꺼진다
  (`subscribeDraftVaultOptIn` — 같은 창의 다른 패널에는 `storage`가 오지 않는다). ①이 진짜 방어이고 ③은 화면을 맞추는 일이다.
- 키는 **추출 불가 AES-GCM 256**(IndexedDB, 첫 저장 때만 만든다 — 빈 금고를 읽는 것은 쓰기 0). AAD = 도메인·storeId·scope·sessionId·submissionId라
  다른 세션·scope·저장소로 옮긴 기록은 열리지 않고 지워진다(보여 주지 않는다). 7일·32개·각 1MiB. 32개가 차면 **밀어내지 않고 거절**한다(사용자의 글이다).
  ⚠️ **키 만들기는 한 트랜잭션의 create-if-absent(`storage.update`)다**(리뷰 2026-10-16). 읽고-만들고-쓰기였던 동안 두 창이 동시에 첫 저장을
  하면 나중 키가 앞 키를 덮어, 앞 창이 봉인한 글이 열리지 않아 「열 수 없는 기록」으로 지워졌다. 키 생성(WebCrypto)은 트랜잭션 밖에서 하고
  (IndexedDB 트랜잭션은 await를 넘지 못한다) 저장만 원자적으로 한다 — 진 쪽은 이미 저장된 키를 쓴다.
- **모든 보관 요청은 보낼 제출 id를 미리 갖는다.** 「현재 세션에 전송」도 켜져 있으면 그 id로 `attempted` 봉인을 먼저 시작하고
  (`sendWithDraftSeal`, `src/workroomDraftQueue.ts`) `written`이면 지운다. 봉인이 `WORKROOM_DRAFT_SEAL_WAIT_MS`(1.5초) **안에 끝나면**
  transport 호출 전에 저장돼 있으므로, 보낸 직후 창이 죽어도 그 요청이 대기열에 남는다. 그 안에 끝나지 않으면 요청이 **먼저** 나가고,
  봉인은 나중에 저장되더라도 `attempted`다 — 그 사이 창이 죽으면 아무것도 남지 않을 수 있다. 예전에는 봉인과 전송이 동시에 출발했고,
  그 뒤 고친 문장도 「언제나 전송 전에 저장된다」고 해서 사실보다 강했다(리뷰 2026-10-16 두 번).
  ⚠️ **금고는 보내기를 막지 않는다**(결정 2026-10-16): 봉인이 실패하거나 기다리는 시간 안에 저장되지 않으면 그래도 같은 id로 **한 번**
  보내고, 작성칸이 「이 요청은 작성 내용 보관함에 넣지 못했습니다」·「이 요청은 보관되지 않았을 수 있습니다」(`draftSealNotice`)라고 말한다
  (written이면 그 안내를 지운다). ⚠️ **이 안내는 보관만 말하고 「보냈습니다」라고 하지 않는다** — 제출 전에 뜨고, 「보내지 않았습니다」로
  끝나는 실패(기다리는 동안 휴대폰이 오프라인이 된 경우 등) 뒤에 이어 붙기 때문이다. 늦게 끝난 봉인도 attempted라 대기열이 「없음」만 보고
  다시 보내지 않고, written 영수증이 지운다.
  ⚠️ **봉인은 요청 전체 제출로 갈 때뿐이다**(통합 리뷰 w4, 4a). 일반 입력으로 가는 전송 — 제출을 모르는 Mac, 제출 기록을 쓸 수 없는
  sessionStorage(가득 참·막힘, w4 L2), 휴대폰에서 이미지를 붙인 요청 — 에는 봉인할 제출 id가 없어 보관하지 않는다. 금고가 켜져 있으면 작성칸이
  그때마다 「이 요청은 작성 내용 보관함에 넣지 않았습니다」(`DRAFT_RAW_SEND_NOTICE`)라고 말한다 — 예전에는 아무 말 없이 지나갔다.
  ⚠️ **보관함을 셀 때 값을 읽지 않는다**(`storage.keys()` — IndexedDB `getAllKeys`). 봉인(save)은 32개 한도를 확인하려고 기록을 세는데,
  `entries()`로 세면 다른 요청의 암호문(각 최대 1MiB)을 전부 읽어 보낼 때마다 지연이 보관함 크기만큼 늘었다(리뷰 2026-10-16). 실측(이 Mac,
  load 16~21, 약 1MB 요청 31개): 봉인 중앙값 Chromium 17ms → 0.8ms, WebKit 17ms → 3ms. iPhone 17 Pro에서는 아직 재지 않았다 — 1.5초
  한도는 측정값이 아니다.
- ⚠️ **복원한 대기열은 정지 상태이고 아무것도 보내지 않는다**(`restoreDraftQueue`는 transport를 받지도 않는다). 항목마다 사람이 「보내기」를 눌러야 하고,
  그때도 **먼저 그 id의 `status`를 묻는다**(`sendQueuedDraft`): 영수증이 있으면(어떤 상태든) 보내지 않고 그 상태를 보여 준다. 호스트의
  「같은 호스트 저장소의 제출 기록을 확인하지 못했습니다」(`WORKROOM_SUBMISSION_NOT_FOUND_PREFIX`)일 때만 **같은 id로** 보낸다 — 죽은 창의 요청이
  아직 오는 중이어도 호스트가 같은 id로 중복을 막는다. 그 밖의 status 실패는 아무것도 보내지 않는다. 미확정 영수증은 기존 복구 배너를 세운다.
- ⚠️ **「없음」은 그 자체로는 증거가 아니다**(리뷰 2026-10-15, 실제 저널로 두 번 실행을 재현). 호스트는 영수증을 **수신 소유자 + 세션 + id**로
  찾는데(`workroomSubmissions.ts`의 `keyOf`), 금고 scope는 그대로인 채 소유자는 바뀐다 — 새 QR(새 relay 세션), 보낸 뒤 승인된 기기 동의
  (`internet:…` → `device:…`), 다시 공개한 커뮤니티 endpoint. 그래서 기록마다 `attempted`(한 번이라도 transport에 넘겼는가)를 두고, 「현재 세션에
  전송」은 **attempted로 봉인**하며, 보관함에서 처음 누른 「보내기」는 보내기 **전에** `claimForSend`로 원자적으로 표시한다(IndexedDB 한 readwrite
  트랜잭션 — 두 창이 동시에 눌러도 하나만 `fresh`). 「없음」에서 보내는 것은 `fresh`뿐이고, 나머지는 `unproven` — 보내지 않고, 터미널을 확인한
  사람이 경고 확인 뒤 입력칸으로 꺼내거나(새 id, 중복 위험을 문구로 말한다) 지운다. `attempted`는 AAD 밖의 평문 필드다(원자적으로 바꾸려고 —
  이 origin의 코드는 어차피 무엇이든 보낼 수 있다).
- 「입력칸으로 꺼내기」는 **실행되지 않았다고 말할 수 있을 때만** 바로 나온다: 영수증이 rejected·held이거나, 그 요청이 어떤 transport에도
  넘겨진 적이 없을 때(`attempted:false` — 꺼내기 전에 `claimForSend`로 원자적으로 표시해 다른 창의 「보내기」와 둘 다 가지 않는다). 그 밖(`unproven`)은
  중복 경고를 확인한 뒤에만 나온다. 꺼내 보내면 새 id라서, 증명 없이 꺼내면 중복 실행될 수 있다.
- **다른 세션에 보관한 요청도 보인다**(감사 2026-10-16). 보관 요청이 그것을 보관한 **실행 중 세션의 작성칸에만** 나와서, 그 세션이 끝나면(종료·Mac 앱
  재시작) 보내지도·꺼내지도·지우지도 못한 채 7일 동안 기기 전체 32개 한도를 차지했다(가득 차면 「보관함에 넣기」와 모든 전송의 봉인이 실패). 지금은 같은
  scope의 다른 세션 요청을 「다른 세션에 보관한 요청」으로 함께 보이고(`listScope`·`restoreDraftQueueScope`), 선택한 세션이 끝난 화면에도 대기열을 그린다
  (보관이 켜져 있을 때만 — 꺼져 있으면 끝난 세션 화면에 보관 칸이 없다. 거기서는 꺼내기 불가 — 실행 중 세션을 열어야 한다). 할 수 있는 일은 영수증 규칙 그대로다: 「결과 확인」 = 원래 id를 **그 세션 이름으로** status만
  (`checkKeptDraft`, written이면 사본을 지운다) · 꺼내기 = rejected·held이거나 **어디에도 넘긴 적 없는** 요청(`attempted:false` — 먼저 `claimForSend`로
  원자적으로 표시해 다른 창의 「보내기」와 둘 다 가지 않는다, `takeBackKeptDraft`), `unproven`은 중복 경고 뒤에만 · 지우기는 경고 뒤에. ⚠️ **옛 id를 다른
  세션으로 보내지 않는다** — 그 목록에는 「보내기」가 없다. 꺼낼 수 없는 동안(꺼내기가 다른 창의 「보내기」에 진 뒤, 미확정 영수증 뒤) 「결과 확인」은 언제나
  다시 누를 수 있다(w5 리뷰 — 안내문이 「결과 확인」을 누르라면서 그 버튼을 숨겼다). 한도는 여전히 기기 전체이고(세려면 값을 읽어야 한다), 다른 연결(scope)에
  보관한 요청은 여기서 열지 않고 id로만 센다. 그 연결이 이 기기에서 사라졌으면(떠난 커뮤니티 기기, 휴대폰에서 지운 Mac) 그 scope를 여는 화면이 없으므로
  경고 뒤 「다른 연결의 보관 요청 N개 지우기」로 지운다(`deleteOutsideScope` — 여전히 다른 scope인 기록만 지운다).
  검증: `tests/workroom-draft-queue-earlier.test.ts`, `tests/workroom-usability.e2e.mjs`의 `kept-requests-…`·`kept-request-check-stays-available-…`·
  `ended-session-shows-no-vault-block-…` 시나리오(수정 전 코드에서 실패).
- 금고 scope는 패널 scope가 아니라 **영수증 소유자**다(`draftVaultScopeFor`): 메인 창의 작성칸은 세션 목록 대화상자(`directory:local`)에,
  팝아웃은 `popout`에 있지만 둘 다 이 Mac으로 쓰므로 `local` 하나를 쓰고, 다른 Mac은 `directory:<기기>`·`community:<기기>`가 한 큐다.
  예전엔 팝아웃만 `local`로 바꿔 메인 창과 큐가 갈렸다(통합 리뷰 2026-10-15 — 글은 잃지 않았지만 다른 창에서 보이지 않았다). 휴대폰 포털(https)도 같은 경로로 동작한다.
- 검증: `tests/workroom-draft-vault.test.ts`(꺼짐=쓰기 0·빈 금고 읽기=쓰기 0·암호문에 원문 없음·추출 불가 키·세션/저장소/scope 이동 거절·7일·32개·1MiB·
  복원은 transport 0회·실제 저널로 「이미 쓴 요청은 status만, 쓰기 1회」·「모르는 id는 같은 id로 1회」·「status 실패면 보내지 않음」 — status를 건너뛰는
  변이에서 둘이 실패, 소유자가 바뀐 뒤의 「없음」은 `unproven`·쓰기 1회, 첫 누름이 claim해 다른 소유자의 재누름도 거절, 다른 창의 금고는 끈 뒤
  저장 0·경합한 저장은 지워짐·끄기는 플래그 먼저, BroadcastChannel·`storage` 전파 — claim을 건너뛰는 변이에서 둘이 실패),
  `tests/workroom-draft-queue-panel.test.tsx`(미지원이면 아무것도 안 그림·기본 꺼짐·동의 문구·`unproven`은 중복 경고 꺼내기만). ⚠️ 보관함 대기열 흐름
  (봉인 → 복원 → 「보내기」)의 브라우저 e2e는 아직 없다 — `tests/workroom-usability.e2e.mjs` 픽스처는 세션 입력 제출(`single`/`begin`)을 흉내 내지 않는다.
  브라우저에서 도는 것은 저장소 측정(아래 `workroom-draft-vault-idb.e2e.mjs`), 금고가 켜진 채 일반 입력으로 가는 전송의 안내
  (`workroom-usability.e2e.mjs`의 `raw-send-with-the-vault-{on-says-it-was-not-kept,off-says-nothing-about-keeping}` — 켜진 쪽은 수정 전 코드에서 실패),
  그리고 복원한 대기열의 결과 확인·꺼내기·지우기·다른 연결 정리(같은 파일의 `kept-requests-…`·`kept-request-check-stays-available-…`·
  `ended-session-shows-no-vault-block-…` — 픽스처가 보관 요청의 `status`만 `keptReceipts`로 답한다)다. 봉인 → 복원 → 「보내기」 전송만 아직 브라우저에서 돌지 않는다.
  리뷰 수정(2026-10-16, 같은 파일): 두 창이 동시에 첫 저장해도 키 하나·두 글 모두 열림, 봉인 저장 전에는 transport 호출 0회·첫 호출 때
  기록이 attempted, 늦은 봉인·실패한 봉인도 쓰기 1회 + 안내, 작성칸의 직접 전송이 `sendWithDraftSeal`을 거침 — 키 경합과 작성칸 경로 검사는
  수정 전 코드에서 실패했다(봉인 도우미의 검사는 새 함수에 대한 것이라 수정 전에는 함수가 없어 실패했을 뿐이다).
  2차 리뷰(2026-10-16): 봉인 안내에 「보냈」이 없음(보관함이 가득 찬 채 보내기 전 거절되는 경우 포함), save·count가 `entries()`를 읽지 않음 —
  둘 다 수정 전 코드에서 실패했다. 실제 IndexedDB: `bun tests/workroom-draft-vault-idb.e2e.mjs [표본 수]`(Chromium·WebKit, `keys()`가
  `entries()`와 같은 키·32개 한도·모두 열림을 단언하고 봉인 시간은 보고만 한다 — 앱·3001 불필요).
- **사용자 결정(2026-10-16)**: 동의 문구(`WORKROOM_DRAFT_VAULT_CONSENT`)와 한도(7일·32개·1MiB)는 지금 그대로 승인됐다. 이번 회차의 기기 확인은
  이 Mac + iPhone 17 Pro로 한정한다(다른 기기는 이번 회차 확인 범위가 아니다).

## 새 세션의 첫 요청도 영수증으로 — `@` 전달·LAN 페이지·옛 Mac (2026-10-15, w2 후속)

패널의 「작업 시작」만 launch 영수증(`terminal-start-submission-v1`)을 썼고, `@` 전달이 여는 새 세션과 LAN QR 페이지의 `@` 전달은
여전히 평범한 `start`였다 — 답을 잃으면 다시 보내 두 번째 CLI가 같은 요청을 실행할 수 있었고, 릴레이 11,000바이트·LAN 16KiB를 넘는
첫 요청은 시작 뒤 입력하거나(포털) 아예 거절했다(LAN).
- **`@` 전달의 새 세션**(`deliverWorkroomRoute`, `submission.launch`): 받는 곳이 그 기능을 광고하면 핸드오프가 launch 제출로 간다.
  요청 하나가 4,000바이트 조각이라 어느 연결이든 24,000바이트까지 첫 요청이다. 답을 잃으면 읽기 전용 status 한 번(다시 보내지 않음),
  미확정이면 `uncertain`·`receiver:null`이고 **받는 쪽 패널의 launch 배너**(이 패널, 또는 그 기기의 `sessionScope`)에 기록을 남긴다.
  그 기록이 같은 프로젝트·AI에 있으면 확인창 전에 거절한다. 실행 전 거절 중 「첫 요청을 받을 수 없음」(참고 폴더 24,000바이트 초과 등)만
  예전처럼 일반 시작 + 준비 뒤 입력으로 이어 가고, 그 밖의 거절은 그대로 보고한다. 기능이 없는 곳·24,000바이트 초과는 요청 순서까지 예전 그대로다.
- ⚠️ **launch를 파싱 못 하는 경로의 거절은 `WorkroomLaunchUnsupportedError`다** — 아무것도 실행되지 않았고 **launch만** 일반 `start`로
  돌아간다(다음 클릭에). `WorkroomSubmissionUnsupportedError`로 뭉치면 실행 중 세션으로의 제출까지 꺼진다.
- **LAN 페이지**: `lanWorkroomSubmissionClient`가 launch를 `submitWorkroomDraft`와 요청 단위로 같게 보낸다(골든 테스트). 미확정 launch는
  기기별 기록 + 「새 세션 시작 결과 확인」/「세션 목록 확인했음」 배너(`#terminal-launch`)다. 기능이 없는 Mac은 옛 16KiB 거절 그대로다.
  `@`가 결국 현재 세션으로 풀리면 작성칸의 「전송」과 같게 보낸다(미확정 제출이 있으면 거절, 되면 전체 요청 제출).
- **옛 Mac(launch 영수증 없음)의 다시 시도**(`src/workroomLegacyStartGuard.ts`): 실패한 일반 시작 뒤 대상·AI·요청의 **digest**와 그때 알던
  세션 id를 sessionStorage에 남기고(요청 원문은 남기지 않는다, 30분), 같은 요청을 다시 시작할 때 그 뒤 같은 대상·AI의 새 실행 세션이 보이면
  묻는다 — 취소하면 그 세션을 고르고 작성 내용은 둔다. 시계가 아니라 세션 id로 판정한다(휴대폰과 Mac 시계가 다를 수 있다). 저장소가 막히면
  기록은 **이 페이지 메모리**에 둔다(닫기 전까지 묻는다, w4 L2).
  **`@` 전달의 일반 시작도 같은 가드다**(w4 L1): `deliverWorkroomRoute`의 `legacyStart`(패널은 받는 쪽 scope)와 LAN 페이지가 영수증 없는 곳에
  첫 요청을 담아 일반 `start`를 보내다 실패하면 대상·AI·핸드오프의 digest와 알던 세션 id를 남기고, 같은 핸드오프를 다시 보낼 때 받는 쪽 목록을 한 번
  읽어 그 뒤 열린 같은 대상·AI 세션이 있으면 **보내기·입력 전에** 묻는다 — 취소하면 아무것도 보내지 않고 `held`(그 세션)로 답한다.
  무엇을 기록하지 않는지는 두 표면이 다르다(w4 검토 4): 패널은 **첫 요청 자체의 거절**(옛 Mac의 prompt 거절·참고 폴더 초과 — 첫 요청 없이 다시
  시작한다)만 기록하지 않고, 그 밖의 실패는 거절이든 응답 유실이든 기록한다(로컬·릴레이 요청 함수에서 둘을 가를 수 없다 — 「CLI 미설치」도
  기록되어 나중에 묻는다). LAN 페이지는 응답의 `ok:false`를 거절로 표시해(`error.refused`) **이 Mac이 답한 거절은 기록하지 않는다**(시작은 spawn
  전에만 거절한다). 다른 기기로 넘긴 요청의 `ok:false`는 넘겨 준 Mac의 시간 초과(「실행됐는지는 알 수 없습니다」)일 수 있어 첫 요청 거절
  문구만 기록하지 않는다(`terminalStartRanNothing`). 소켓이 열리지 않았거나 대기열이 가득 차 보내지 않은 요청도 기록하지 않는다.
  가드는 `legacyStartGuard({sha256Hex})` 하나이고
  LAN 페이지는 그것을 `toString()`으로 심는다(같은 기록 형식·같은 digest — 테스트가 단독 실행으로 지킨다). LAN의 `#terminal-start`는 첫 요청을
  싣지 않으므로 지킬 것이 없다.
  ⚠️ **취소한 다시 시도(`held`)의 보호도 `@` 칩에 걸지 말 것**(w4 검토 1). 「그 세션으로 이동」이 칩을 지우고 초안은 남아서, 「현재 세션에 전송」이
  그 핸드오프를 이미 받았을 수 있는 세션에 같은 일을 한 번 더 보냈다(LAN은 그 세션을 고르면 경로가 보내는 쪽과 같아져 「전송」이 입력). 이제
  `deliverWorkroomRoute`가 응답 유실과 취소한 다시 시도를 `legacyStart.onUncertain`(그때 알던 세션 id)으로 알리고, 패널·LAN 페이지가 그것을
  페이지 메모리(`legacyRouteSuspects`, LAN은 `toString()`)에 두었다가 **같은 초안을 그때 몰랐던 같은 대상·AI 세션에 보낼 때 먼저 묻는다**
  (취소하면 보내지 않고 초안 유지, 수락하면 그 선택대로 한 번). 두 번째 실패는 첫 실패 때 알던 세션만 남긴다(교집합). 패널의 기록은 받는 쪽
  scope 기준이라 다른 기기 탭의 패널도 본다. 전달되면 지운다. 30분·16건. 새로고침하면 사라진다 — 그 뒤에는 다시 `@` 전달할 때의 질문이 남는다.
- ⚠️ **진행 중이던 capability `list`가 「옛 방식으로 보내기」 표시를 되돌리면 안 된다** — 제출이 거절돼 `legacy`로 바뀐 뒤 도착한 그 답이
  기능을 다시 켜서 다음 클릭이 같은 거절을 받았다. `list` 답은 그 사이 세운 `legacy`를 따른다.
- 릴레이 컨트롤러는 거절된 **읽기 전용 질의**(`snapshot` 읽기, capability `list`, 제출 `status`/`recent`)를 상시 오류로 남기지 않는다.
  LAN 페이지의 「터미널 결과 확인했음」은 저장소 쓰기가 막혀도 이 화면의 기록을 지우고 그렇다고 말한다.
- ⚠️ **launch 기록은 launch마다 하나다 — 한 칸에 덮어쓰지 말 것** (검토 2026-10-15). 범위(scope)마다 기록이 하나뿐이라, 다른 대상의
  launch가 결과 미확정인 앞선 launch를 덮어쓰고 성공하면 지웠다. 그 뒤로는 앞선 요청의 재전송을 아무것도 막지 않았다(`recent`가 없는
  호스트·LAN 페이지에서는 되찾을 길도 없었다). 이제 패널·`@` 전달은 `readPendingLaunches`/`withPendingLaunch`(최대 8건, 한 건은 옛 단일 모양으로
  저장해 이전 릴리스 페이지도 읽는다)로 **자기 id만** 쓰고 지우며, 같은 대상·AI의 기록만 시작을 막는다(`blockingPendingLaunch`). 배너는 첫 기록을
  보이고 나머지 건수를 말하며, 확인은 전부를 읽기 전용으로 본다. 기록을 남기지 못하면 launch를 보내지 않는다. LAN 페이지는 기기마다 기록
  하나를 유지하는 대신 **미확정 launch가 하나라도 있으면** 새 `@` launch를 거절하고, 자기 id가 아닌 기록은 지우지 않는다.
  옛 Mac용 `workroomLegacyStartGuard`도 같은 결함이 있었다(어떤 시작이든 성공하면 실패 기록을 지움) — 이제 요청별 기록이고 성공한
  **그 요청의** 기록만 지운다(`forgetFailedLegacyStart`).
- ⚠️ **미확정 `@` launch의 초안은 그 launch에 묶는다.** 초안을 남긴 채 나중에 status가 written으로 정리되면, 다시 「전송」이 그 launch가 연
  세션으로 같은 핸드오프를 입력했다(두 번 실행). 패널은 launch id ↔ 초안·대상·기기·AI를 기억해 written으로 정리될 때 초안과 `@` 칩을 지우고,
  같은 초안을 다시 보내면 `deliverWorkroomRoute`의 `earlierLaunchId`가 그 launch의 status를 먼저 읽는다 — written이면 아무것도 보내지 않고
  `delivered`(다른 기기 탭에서 정리됐어도), 시작 안 됨이면 평소대로, 그 밖에 기록이 남아 있으면 거절, 받는 쪽에서 사용자가 「세션 목록
  확인했음」으로 지웠으면 그 선택대로 보낸다. status를 못 읽으면 보내지 않는다. LAN 배너의 written 정리도 `#terminal-line`과 경로를 지운다.
- ⚠️ **세션을 바꾸면 `@` 칩이 지워지므로, 미확정 launch의 보호를 칩에 걸지 말 것**(통합 리뷰 2026-10-15). 칩 기준 검사만 있던 동안 세션을
  바꾼 뒤 같은 글을 작성칸으로(또는 `@`가 현재 세션으로 풀려) 보내면 그 launch가 열었을 수도 있는 세션에 핸드오프가 한 번 더 입력됐다.
  지금은 **입력할 세션** 기준이다(`uncertainRouteLaunchFor`): 같은 글을 같은 대상·AI 세션에 보내려 하면 작성칸·보관함 「보내기」 모두 보내지 않고
  「새 세션 시작 결과 확인」을 먼저 하라고 말한다. written으로 정리될 때는 칩이 지워졌어도 그 글을 지운다(`routeDraftClearsOnSettle` —
  같은 글을 다른 대상으로 다시 겨눴으면 사용자의 새 요청이라 둔다).
- ⚠️ **다른 기기로 가는 `@` launch는 이 브라우저 저장소가 쓸 수 있을 때만 쓴다**(`routeLaunchStorage` 탐침). 사이트 데이터가 막히면
  `sessionStorage` getter가 던져 그 기기의 launch 기록을 읽지도 쓰지도 못하고, 예전엔 「미확정」으로 영구 거절됐다 — 지금은 일반 `start`다.
- ⚠️ **패널 자신의 시작도 같다 — 쓸 수 없는 저장소는 「읽을 수 없는 기록」이 아니다**(w4 L2). 마운트가 던지는 getter를 대상 없는
  `unreadable-launch`로 읽어 「세션 목록 확인했음」을 누르기 전까지 모든 시작을 막았다. 지금은 패널이 `pendingLaunchesOnLoad(readableSessionStorage(),
  …, !!usableSessionStorage())`로 읽는다: 저장소를 아예 읽을 수 없으면(getter가 던짐) 빈 목록이고, 읽히지만 새 기록을 쓸 수 없으면(가득 참) 읽힌
  기록은 그대로 보이고 막는다(아래 「읽기와 만들기」). 어느 쪽이든 새 launch 기록을 남길 수 없으므로 시작·`@` 새 세션은 일반 `start`(위 옛 Mac 가드가
  페이지 메모리로 지킨다)이며, 패널이 한 번 `workroom-launch-storage-notice`로 그렇게 말한다. 저장소는 되는데 값이 깨진 기록은 **여전히 막는다**(실제 미확정 launch일 수 있다).
  전체 요청 제출도 같은 규칙이다: 저장소가 없으면 세션마다 「이전 제출 기록을 확인하지 못했습니다」로 막던 것을 그만두고 LAN 페이지처럼
  일반 입력으로 보낸다(기록 없는 제출은 보내지 않는다). ⚠️ 저장소 없이도 launch를 페이지 메모리 기록으로 보낼 수는 있다(더 강한 보장) —
  지금은 기기 경로·LAN과 같은 「기록할 곳이 없으면 옛 경로」 규칙을 따랐다.
  ⚠️ **읽기와 만들기는 다른 질문이다**(w4 검토 2·3). 쓰기 탐침(`usableSessionStorage`)을 기록 **읽기**의 관문으로도 쓰는 동안, 가득 찼지만 읽히는
  저장소의 실제 미확정 launch·제출이 보이지 않아 같은 대상·AI의 일반 시작과 일반 입력이 그 기록을 지나쳤다. 이제 기록은
  `readableSessionStorage`(getter와 `getItem`이 되는지)로 읽고 보이며 막고, 쓰기 탐침은 **새 기록을 만들 수 있는지**(launch ↔ 일반 시작,
  제출 ↔ 일반 입력)만 정한다. `@` 전달도 같다: 받는 세션의 미확정 제출은 지금 제출을 보낼 수 있든 없든 거절하고(`deliverWorkroomRoute`의
  `assertNoPending`이 `supported`와 무관 — 재연결 뒤 기능을 아직 모를 때도), 새 launch 기록을 남길 수 없을 때는 `submission.launchRecords`로
  읽히는 같은 대상·AI launch가 일반 시작을 막는다. 같은 초안을 다시 보낼 때 앞선 launch를 확인하는 `earlierLaunchId`도 「아직 기록됨」을
  `launch`가 없으면 `launchRecords`에서 읽는다(통합 리뷰 w4, finding 3) — `launch`만 보던 동안 쓰기가 막힌 저장소에서는 미확정 launch를
  「받는 쪽에서 지웠음」으로 읽어, 그 launch가 연 세션에 같은 핸드오프를 한 번 더 입력했다. LAN 페이지도 `terminalReadableStorage`로 읽고, `@`의 받는 세션 검사는 기능 플래그와 무관하게
  돌며, 일반 시작은 같은 대상·AI의 미확정 launch를 기다린다(`terminalAssertNoSameLaunch`).
- **LAN 페이지의 `@`가 다른 실행 중 세션으로 갈 때도 전체 요청 제출이다**(w4 L3). 기능을 광고하는 Mac이면 받는 세션의 미확정 기록부터
  보고(있으면 확인창 전에 거절), 받는 세션 id로 `terminalSubmissions.submit` 한 번 — 패널 `deliverWorkroomRoute`와 요청 단위로 같다(골든 테스트).
  확인창 뒤 받는 세션 화면을 다시 읽지 못하면 패널처럼 **입력하지 않는다**(w4 검토 5 — 그 전에는 LAN만 그대로 보냈다). 그래서 LAN 화면 읽기도
  패널처럼 `snapshot`을 모르는 Mac은 일반 읽기로 다시 읽는다.
  기록은 받는 세션에 남아 그 세션의 「제출 결과 확인」 배너가 보이고, 요청이 나간 뒤에는 화면이 받는 세션으로 옮긴다. 미확정이면 초안을 두고
  다시 보내지 않는다. 기능이 없는 Mac은 예전 그대로 일반 입력이다. 화면을 옮길 때 취소된 보내는 쪽의 `read` 폴링은 더 이상
  「아직 보내지 않은 입력을 취소」로 말하지 않는다(입력·제출이 취소될 때만).
- 검증: `tests/workroom-route-delivery.test.ts`(launch 묶음), `tests/remote-control-mobile-submission.test.ts`(LAN launch 골든),
  `tests/remote-control-lan-route-launch.integration.test.ts`(실제 LAN 서버: 16KiB 초과 launch·미확정 배너·현재 세션 제출),
  `tests/remote-control-lan-submission-reconnect.integration.test.ts`(실제 PTY: 커밋 직후 소켓 끊김 → restore → written, PTY 추가 쓰기 0),
  `tests/workroom-legacy-start-guard.test.ts`, `tests/remote-relay-probe-error.test.ts`, `tests/remote-control-mobile-submission-dismiss.test.ts`,
  브라우저: `tests/workroom-community-mention.e2e.mjs`(제출 가능한 기기: uncertain 배너·legacy 표시·launch 새 세션),
  `tests/workroom-submission-capability.e2e.mjs`, `tests/workroom-usability.e2e.mjs`의 `legacy-start-retry-asks-before-a-second-cli`.
  검토 수정(2026-10-15): `tests/workroom-launch-submission.test.ts`(launch별 기록), `tests/workroom-route-delivery.test.ts`(다른 대상 기록이
  살아남음·`earlierLaunchId` 다섯 경우), `tests/workroom-legacy-start-guard.test.ts`(요청별 기록), LAN 통합 테스트 두 건(다른 대상 launch가
  기다림·배너 written이 초안을 지움), 브라우저 `workroom-usability.e2e.mjs`의 `a-launch-of-another-target-keeps-the-unsettled-launch-banner`·
  `route-launch-settled-as-written-clears-its-draft`, `workroom-community-mention.e2e.mjs`의 막힌 저장소 검사 — 모두 수정 전 코드에서 실패한다.
  w4 후속(2026-10-16): `tests/workroom-route-delivery.test.ts`의 「remembers a failed plain start」 묶음, `tests/workroom-legacy-start-guard.test.ts`
  (단독 빌드한 가드·문구), `tests/workroom-launch-submission.test.ts`(쓸 수 없는 저장소 ≠ 깨진 기록), `tests/remote-control-mobile-terminal.test.ts`
  (LAN `@` 제출 골든·받는 쪽 미확정 거절·응답 유실·일반 시작 실패 가드·막힌 저장소), `tests/remote-control-lan-route-launch.integration.test.ts`의
  실행 중 받는 세션 제출, 브라우저 `workroom-usability.e2e.mjs`의 `blocked-storage-starts-plainly-says-so-once-and-still-asks-on-retry`·
  `an-unreadable-launch-record-in-working-storage-still-blocks`·`blocked-storage-sends-raw-input-instead-of-a-record-less-submission`·
  `legacy-route-retry-asks-before-a-second-cli` — 수정 전 코드에서 실패한다. 회귀 가드(수정 전에도 통과)는 깨진 기록 검사, 「accepting goes on as
  the user chose」, 「a definitive refusal of the first request records nothing」, LAN `#terminal-start` 고정 검사(정적)다(검토가 origin/main으로 확인).
  w4 검토 수정(2026-10-16): `tests/workroom-launch-submission.test.ts`의 「full storage still reads its records」(수정 전에는 새 export가 없어 실패),
  `tests/workroom-route-delivery.test.ts`의 「…even when a submission cannot be sent now」·「the same target and AI: refused before any question or
  start」·「the caller hears of a lost start and of a declined retry」, `tests/workroom-legacy-start-guard.test.ts`의 「sessions a lost @ handoff may have
  reached」(새 export), `tests/remote-control-mobile-terminal.test.ts`의 기능 모를 때 받는 세션 거절·가득 찬 저장소의 제출 기록·같은 대상 launch가
  일반 시작을 막음·이 Mac이 거절한 시작은 기록 안 함·다른 기기 시간 초과는 기록·두 번째 화면 읽기 실패 거절(패널 골든)·취소한 다시 시도 뒤와
  응답 유실 뒤 그 세션에 보내기 전에 물음, 브라우저 `workroom-usability.e2e.mjs`의 `full-storage-still-blocks-on-a-readable-launch-record`·
  `full-storage-still-blocks-on-a-readable-submission-record`·`legacy-route-held-session-asks-before-the-composer-sends-the-same-draft` — 모두 수정 전
  코드에서 실패한다. 「another target or AI: the plain start goes on」과 LAN 「a Mac that refuses snapshot reads」는 이번 수정이 넘치지 않는지 보는
  가드다(수정 전에도 통과). 통합 리뷰 w4: `tests/workroom-route-delivery.test.ts`의 「still unsettled and still recorded, where no new launch can be
  recorded now」(finding 3 — 수정 전 코드에서 실패).
