# 워크룸 첨부 — Mac · 휴대폰

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 워크룸 첨부 — 사진·파일·끌어 놓기 (S3, 2026-10-16, Mac 전용)

「맥 직접 또는 원격제어시 사진첨부 파일첨부 버튼이 없다 … 터미널이나 입력박스에 드래그앤드랍 되어야」. 이번 범위는 **Mac 화면**(메인 창·팝아웃·웹/dev 빌드)이고
휴대폰은 w13이다(아래 「휴대폰 워크룸 첨부」 절 — Mac 쪽 수신과 휴대폰 화면). 정본: `src/WorkroomAttachBar.tsx`(버튼·칩·붙여넣기·DOM 드롭) · `src/workroomAttachmentRules.ts`(이름·경로 규칙, 한도) ·
`src/workroomFiles.ts`·`src/workroomAttachmentHost.ts`(호스트) · `src/workroomDropArbiter.ts`(드롭 주인 판정, 순수) · `src/workroomDropRouter.ts`(전달) ·
`src-tauri/src/workroom_drop.rs`(팝아웃 드롭·네이티브 선택 창). `AiTerminalPanel.tsx`는 이미지 줄과 핸들러를 이 컴포넌트로 바꾼 것뿐이다(w7 충돌 최소화).

- **버튼**: 「사진 첨부」·「파일 첨부」(여러 개) + 「화면 캡처 ▾」(세 모드는 메뉴 안, ⌥⌘3/4/5 그대로, Windows에서는 메뉴를 숨긴다 — 호스트가 macOS만 캡처한다).
  앱에서는 **Rust가 네이티브 선택 창을 연다**(`workroom_pick_attachments`, main·`workroom-*`만, async, `tauri-plugin-dialog`를 Rust에서 호출 — JS dialog 권한을
  넓히지 않는다). 이유: wry 0.54의 `<input type=file>` 패널은 열리지만(`runOpenPanelWithParameters`) **`accept`를 무시해** 사진 필터가 안 되고, 경로 없는 바이트만
  줘서 15MB를 넘는 파일·폴더를 넣을 수 없다. 명령이 없거나 실패하면 `<input type=file>`로 물러난다. 웹/dev 빌드는 `<input type=file>`(사진은 `accept="image/*"`)이다.
  선택 창 명령은 `{paths, total}`을 돌려준다 — 16개 넘게 고르거나 UTF-8이 아닌 경로가 섞이면 남은 수를 화면이 말한다(조용히 버리지 않는다).
  「화면 캡처 ▾」는 메뉴 패턴이다: 열면 첫 항목에 초점, ↑↓·Home/End, Esc는 메뉴를 닫고 버튼으로 초점을 돌려준다. ⚠️ **메뉴의 Esc는 capture 단계에서 멈춘다** —
  입력칸의 Esc는 언제나 AI로 가므로, 멈추지 않으면 메뉴를 닫으려던 Esc가 실행 중인 AI를 끊었다. 초점이 메뉴를 떠나면 메뉴를 닫는다.
  칩을 키보드로 빼면 다음 칩(없으면 입력칸)으로 초점이 간다. 문구는 플랫폼을 따른다(`workroomAttachCopy`: ⌘V/Ctrl+V, 이 Mac/이 PC).
- **요청 글**: 이미지 블록 뒤에 둘째 블록 `[첨부 파일 N개 — 각 파일을 열어 확인하세요]` + 줄마다 절대 경로(`workroomAttachmentMessage`). 이미지만 있으면 바이트가 예전 그대로다.
  호스트 분리(`splitWorkroomAttachmentBlock`)는 그대로 「바이트 단위로 다시 만들어지는 꼬리 블록만」 인정하고 `files`는 있을 때만 싣는다. 한도: 이미지 6 · 파일 10(넘친 이름은 말한다).
- **경로가 있는 항목은 복사하지 않는다**: Finder 드롭·선택 창의 파일·폴더는 그 자리 경로로 참조하고, 이미지(바이트로 판정, ≤15MB)만 `workroom-images`로 복사해 썸네일을 단다
  (`import` 연산). **쓰기 직전에 다시 본다**(`assertWorkroomFileAttachments`, 서비스의 `submissionAttachments(paths, files)`): 이 Mac 소유자만, 절대 경로, 존재, 일반 파일·폴더,
  이름·경로에 C0·C1·DEL·방향(bidi)·줄/문단 구분 문자 없음. 그 사이 지워진 파일은 거절하고 작성 내용은 남긴다. 다른 기기의 제출에 붙은 블록은 이미지와 같이 거절한다.
  거절된 항목의 이름은 화면에 그 제어·방향 문자 없이 보인다(`displayAttachmentName`) — RLO를 남기면 나머지 오류 문장이 뒤집혀 보인다.
  ⚠️ **첨부가 있는 초안은 다른 아젠투지로 `@` 전달하지 않는다**(`workroomRouteAttachmentRefusal`). 그 경로는 받는 쪽에서 일반 입력으로 들어가 위의 쓰기 직전 검사를
  거치지 않고, 같은 홈·프로젝트 배치의 다른 Mac에서는 **같은 경로의 다른 파일**을 연다. 확인창 전에 거절하고 초안·칩은 남긴다. 이 Mac의 프로젝트·앱으로의 전달은 그대로다.
- **경로가 없는 바이트**(웹 빌드 드롭, 이미지가 아닌 파일 붙여넣기)는 `save-file` → `<appData>/workroom-files/YYYY-MM-DD/<시각>-<난수>-<정리한 이름>`(0600, ≤15MB, 14일 뒤 정리).
  이름은 마지막 이름만(`../` 제거)·제어/방향 문자 제거·앞 점·대시 제거·80자. 옛 사이드카는 이 연산을 「이미지 요청이 올바르지 않습니다」로 거절하고 화면은
  「이 Mac의 앱이 아직 파일 첨부를 지원하지 않습니다 … 업데이트하세요」로 말한다. 빈·지원하지 않는 붙여넣기도 문구를 띄운다(조용히 넘어가지 않는다).
- **드롭 주인은 하나다**(`decideDropOwner`): Tauri는 한 드롭을 모든 `onDragDropEvent` 리스너에 동시에 준다. VOC 캡처 중 → VOC, 드롭 지점의 **최상단 요소**가 살아 있는
  워크룸 패널(`data-workroom-drop-zone`) 안 → 그 워크룸(`.ai-terminal-surface` 안이면 terminal, 아니면 composer), 그 밖(패널 위 모달 포함) → FolderDropZone 자신의 판정.
  FolderDropZone은 `workroomOwnsDropAt`이 참이면 프로젝트를 추가하지 않는다. 판정 좌표는 CSS 픽셀로 바꾼다(`dropPointToCss`): macOS wry는 **뷰 포인트**, Windows는 물리
  픽셀을 주고, 앱 배율(`setZoom(uiZoom)`)은 창의 논리 폭 ÷ `innerWidth`로 **재서** 나눈다(0.9·1.0·1.25 테스트). FolderDropZone 자기 판정도 같은 변환을 쓴다
  (`isDropPositionInside`, 워크룸이 없어도 `installWorkroomDropGeometry`로 배율을 잰다) — 예전에는 macOS 포인트를 `devicePixelRatio`로 나눠 Retina에서 자기 위의 드롭도
  놓쳤다. ⚠️ VOC 폼(`VocOverlay`)은 아직 그 옛 계산(`isPhysicalPositionInside`)이다 — 바꾸지 않았다.
  **워크룸 안에서 연 모달**(세션 종료 `<dialog>`, `showModal`)은 DOM으로는 패널의 자식이고 배경(backdrop)도 dialog로 잡힌다. 그 안의 지점은 dialog 안에 있는 드롭 영역이
  아니면 워크룸 것이 아니다(`dialog:modal`, 모르는 엔진은 `dialog[open]`).
- **파일을 싣지 않은 드래그는 첨부가 아니다**: Tauri의 드래그 처리기는 웹뷰 위의 모든 드래그를 가져가므로, 페이지 안에서 끈 글·칩 썸네일·링크도 경로 없이 온다.
  오버레이와 전달은 **경로를 실은 드래그만**(메인: enter의 `paths`, 팝아웃: Rust enter 알림의 `count`) 따른다. 이 페이지에서 시작한 드래그(DOM `dragstart` — 페이지에
  닿는 유일한 드래그 이벤트)는 아무 말도 하지 않고, 다른 앱에서 온 경로 없는 드래그는 놓았을 때 「끌어 놓은 항목에 파일 경로가 없어 첨부하지 않았습니다 …」 한 번이다
  (글인지 파일 약속인지 웹뷰는 구분하지 못하므로 「파일로 저장하라」고만 말하지 않는다).
- **워크룸이 주인이면**: 기본은 칩(이미지는 썸네일, 파일·폴더는 이름 칩)과 입력칸 초점, 끄는 동안 「여기에 놓으면 첨부합니다」 오버레이. **「터미널 직접 입력」이 켜져 있을 때
  터미널에 놓으면** 따옴표 친 경로를 공백으로 이어 입력한다(Enter 없음, `type-paths`). CLI가 DECSET 2004를 켰으면 붙여넣기 한 번(`ESC[200~…ESC[201~`)으로, 화면이 질문을
  기다리면(`workroomScreenAwaitsAnswer`) **호스트가 거절**한다 — 경로의 `1`·`y`가 메뉴를 고르지 않게. 한 번에 16개까지이고(`WORKROOM_TYPED_PATHS_TOO_MANY`),
  드롭이 싣지 못한 항목 수는 입력 뒤에 말한다. 웹 빌드의 파일 약속 드롭(`Files`인데 파일이 없음)은 「경로가 없는 항목은 첨부할 수 없습니다 — 파일로 저장한 뒤 끌어 놓으세요」.
- **팝아웃은 권한을 넓히지 않는다**: 팝아웃(`core:window:allow-set-title` 하나)은 Tauri 드래그 이벤트를 들을 수 없다. `open_workroom_window`가 그 창의 `DragDrop` 창 이벤트를
  등록하고, 경로를 **창 라벨별로**(30초·32개) 쥔 채 페이지에 숫자만 든 `CustomEvent('agentstoz-drag'|'agentstoz-drop', {x,y,width,count})`를 `eval`한다(경로는 절대 싣지 않는다).
  드래그 시작은 `type:"enter",count:N`이다 — N이 0이면 페이지는 오버레이를 띄우지 않는다.
  페이지는 `workroom_take_drop`(main·`workroom-*`만, async)을 한 번 불러 **자기 라벨의 것만** 받고 비운다. 창이 닫히면 지운다.
- 이 경로(`/api/agent-runtime/terminals/images`)는 관리 전용 그대로다 — 휴대폰·LAN은 닿지 않는다. 원격 프로토콜·Rust 프록시 크기(21MB)는 바꾸지 않았다.
  호스트 함수는 경로/바이트를 받아 같은 첨부 기록을 돌려주므로 휴대폰 웨이브가 복호화한 바이트를 `saveWorkroomFile`로 넣으면 된다.
- 검증: `tests/workroom-attachments.test.ts`(이름 정리·제어/bidi 거절·15MB 코드·정리·쓰기 직전 거절·import·type-paths 거절·주인 판정 표·배율 0.9/1.0/1.25),
  `tests/workroom-submission-attachments.test.ts`(실제 서비스로 두 블록 1회 쓰기·사라진 파일·원격 거절), Rust `workroom_drop::tests`(TTL·한 번만·라벨·32개·숫자만),
  `node tests/workroom-attachments.e2e.mjs <격리 Vite>`(메인·팝아웃 버튼과 입력 1개, PNG→이미지 칩, PDF→파일 칩, PDF 붙여넣기, 빈 붙여넣기 문구, DOM 드롭과 오버레이,
  두 블록 전송, 옛 사이드카 문구, 휴대폰에 없음), `node tests/workroom-attachments-tauri.e2e.mjs <격리 Vite>`(`__TAURI_INTERNALS__`를 기록용 대역으로 바꿔
  앱 경로를 돈다: 배율 0.9·1.0·1.25의 메인 창 드롭이 실제 `elementFromPoint`로 워크룸에만 가는지, FolderDropZone 상자가 워크룸 아래 겹쳐 있어도 프로젝트를 추가하지
  않는지, 모달·VOC 제외, 직접 입력 중 경로 입력과 질문 화면 거절, Rust 선택 창 명령, 팝아웃 CustomEvent + `workroom_take_drop` 한 번; 리뷰 수정 2026-10-16: Retina(DPR 2)·배율
  1.25의 FolderDropZone, 페이지 안 글 드래그·다른 앱의 경로 없는 드래그(메인·팝아웃), 세션 종료 모달 배경, 16개 넘는 선택, 싣지 못한 항목 수), 웹 e2e에 메뉴 키보드·Esc가
  CLI로 가지 않음·칩 초점·Windows 문구, `tests/workroom-community-mention.e2e.mjs`에 첨부 있는 초안의 다른 기기 `@` 전달 거절. 새 사례는 모두 수정 전 코드에서 실패했다.
  ⚠️ **실제 앱에서 Finder 드롭(메인·팝아웃·배율별)과 네이티브 선택 창은 아직 확인하지 않았다** — 대역은 wry가 주는 좌표 단위(macOS 포인트)를 가정한다.

## 휴대폰 워크룸 첨부 — 사진·파일은 암호문으로 Mac에 간다 (w13, 2026-10-16)

w10의 휴대폰 절반이다. step A는 Mac 쪽 수신·제출 경로와 와이어, step B는 휴대폰 화면(「+」 메뉴·칩·iPad 드롭·LAN 안내)이다.
정본: `src/workroomRemoteAttachmentProtocol.ts`(와이어·한도·문구, 휴대폰과 공유) · `src/workroomRemoteAttachments.server.ts`(Mac 장부) ·
`src/vocAttachments.ts`·`src/vocRemoteReceive.server.ts`(전송 경로) · `src/remoteWorkroomAttachments.ts`(휴대폰 큐) ·
`src/RemoteWorkroomAttachBar.tsx`(휴대폰 화면) · `sealAndUploadTransit`(`src/remoteVoc.ts`, VOC와 같은 암호화→업로드→서명 순서).

- **새 암호화는 없다 — VOC 전송 경로를 그대로 쓴다**: 파일마다 새 AES-256-GCM 키, 비공개 버킷 `portmgr-voc-transit`에는 암호문만,
  키는 E2E 릴레이 봉투 안에만. `encryptTransitBlob`·`decryptTransitBlob`·`fetchTransitBlob`(이 Mac의 Supabase 주소 + token으로 URL을
  다시 만든다, 리다이렉트 거절)이 바이트 공용이고, VOC 이름(`encryptVocImage`…)은 같은 코드·같은 오류 코드의 감싸개다(시드 고정 테스트가
  w13 전 봉투와 바이트 단위로 같음을 지킨다). 버킷 한도 10 MiB는 **저장된 암호문**을 세므로 파일 하나는 10,485,760 − 28 = **10,485,732바이트**.
- **받기는 두 단계다**: `attachments.receive`가 모든 한도를 검사해 **바로 답하고**(항목 `pending`) 내려받기는 뒤에서 돈다 —
  Mac은 휴대폰 요청을 릴레이 폴 안에서 실행하므로, 50MB를 동기로 받으면 그 Mac의 모든 휴대폰(자기 터미널 읽기까지)이 멈춘다.
  휴대폰은 `attachments.status`로 결과를 읽는다. 같은 `receiveId` + 같은 항목은 같은 작업(두 번 받지 않는다), 다른 항목은 거절.
- **한도**(critique 14): 인터넷 연결 소유자만(`device:…:internet:` — LAN은 `WORKROOM_ATTACH_INTERNET_ONLY`), 등록된 프로젝트, 이 Mac의
  host id 아래 경로만, 받기 분당 10회(게이트웨이 별도 예산, 상태 확인·`rebind`·`release`는 읽기 예산), 소유자당 살아 있는 id 32개, 기기 전체 미사용 512 MiB,
  내려받기 2작업 + 대기 8작업, **소유자당 하루(로컬 날짜) 256 MiB를 받을 때 예약하고 돌려주지 않는다**. 전체 거절은 문장 끝에 `(CODE)`.
  ⚠️ **한도는 휴대폰이 선언한 `bytes`로 세므로, 내려받기도 선언한 크기 + 28바이트까지만 읽는다**(`fetchTransitBlob`). 10 MiB 상한으로 읽던 동안
  1바이트라고 선언한 10 MiB 객체를 Mac이 통째로 받아 복호화하고 1바이트만 셌다(리뷰 w13 재현: 3번에 30 MiB, 할당 3바이트). 더 긴 본문은 끊고,
  더 큰 content-length는 본문을 읽기 전에 거절한다(VOC는 같은 오류 코드 그대로).
- **id는 불투명하다**: 준비된 항목은 `wa_` + 32자이고 그 소유자·프로젝트에 묶여 60분 산다. 답에는 id·크기·`lineBytes`(Mac이 붙일 경로
  줄의 바이트 수 — 휴대폰이 24,000바이트를 계산하는 데 쓴다)·`expiresInMs`·`removed`만 있다. ⚠️ **Mac 경로를 휴대폰에 돌려주지 말 것.**
  만료된 **미사용** id는 파일째 지우고(이 앱의 `workroom-images`·`workroom-files` 안만), 사용한 id의 파일은 14일 정리에 맡긴다(AI가 다시 연다).
  장부 `<appData>/workroom-remote-attachments.json`(0600)에는 **token·키를 절대 쓰지 않는다**. 재시작하면 받던 항목은 `INTERRUPTED`.
- **id는 한 번만 쓴다(리뷰 w13)**: written 요청이 사용 처리한 id는 `check`·`lease`에서 없는 id다. 그 요청의 **같은 제출 id 재생**은 저널이 먼저
  답하므로(check·lease에 닿지 않는다) 정확히 한 번은 그대로이고, 같은 id를 실은 **새** 요청 — 잃은 launch 답이 나중에 written으로 정리된 뒤 한 번 더
  누른 시작이 같은 파일로 두 번째 CLI를 띄웠다 — 은 begin에서 거절된다. **동시에 온 두 새 요청도 같다**: 쓰기 전(lease를 쥔) 요청의 id는 다른 요청에
  빌려주지 않는다(`WORKROOM_ATTACH_IN_USE_MESSAGE`). 그 전에는 둘 다 begin·lease를 통과해 같은 파일이 두 세션에 입력됐다(검증 w13 재현).
- **`attachments.rebind`·`attachments.release`(같은 플래그, 호출당 id 5개)**: 보는 세션이 다른 프로젝트로 바뀌면 준비된 id가 **그대로** 따라간다 —
  게이트웨이가 그 기기가 입력할 수 있다고 확인한 프로젝트로 id의 묶임만 옮긴다(새 업로드·내려받기·id·할당 없음, 묶임은 재시작해도 남는다).
  예전에는 전환마다 모든 칩을 다시 올리고 받아 옛 id가 살아남아, 다섯 번 오가면 32개 상한에 걸리고 「빼기」로도 풀리지 않았다(리뷰 w13 재현).
  `release`는 사람이 뺀 id를 파일째 지우고 자리를 돌려준다. 둘 다 사용했거나 고정(쓰는 중)된 id는 건드리지 않는다.
- 항목마다 따로 실패한다(VOC의 한 세트와 다르다): sha256·크기, 사진은 바이트가 이미지여야(`NOT_IMAGE`), **저장 직전에 연결의 동의를
  다시 본다**(철회되면 `REVOKED`, 아무것도 저장하지 않는다). 전송 객체는 service_role이 있으면 Mac이 지우고, 아니면 `removed:false`로 휴대폰이 지운다.
- **제출이 id를 싣는다**(`terminal-submission-v1`의 `begin`/`single`에 `attachments`, 1..16): 그 id가 있으면 글이 Enter 하나여도 된다.
  manifest 해시는 id가 있을 때만 바뀐다(기존 영수증·`submitHostInstruction` 해시는 그대로). ⚠️ **블록은 호스트가 붙인다** —
  begin에서 id를 검사하고(그 id의 영수증이 이미 있으면 재생이 이긴다), 쓰기 직전에 lease(소유자·프로젝트·만료·디스크의 파일)·고정,
  write fence 바로 앞에서 다시 보고 fence 뒤에 사용 처리한다. 휴대폰 글 자체의 블록 모양 꼬리는 예전처럼 거절, 이 Mac·다른 커뮤니티 Mac은
  id를 보낼 수 없다. 새 세션 첫 요청(launch)은 spawn이 fence다.
- 동작 이름이 `workroom.*` 밖인 이유: `workroom.*`는 세션 id를 요구하고 다른 아젠투지가 그 동작을 모두 실행한다. 커뮤니티 경로(게이트웨이의
  다른 기기 전달·커뮤니티 실행기·id를 실은 전달 제출)는 「다른 아젠투지의 세션에는 아직 첨부할 수 없습니다」로 거절한다.
- 기능 `workroom-attach-v1` 하나, **확장 목록 맨 끝**(`remoteControlHostSupportedFeatures`) — 레거시 8개 답에서는 걸러 낸다. LAN은 광고하지 않는다.
- 검증: `tests/transit-blob.test.ts`, `tests/workroom-remote-attachments.test.ts`, `tests/mobile-workspace-attachments.test.ts`,
  `tests/workroom-submission-remote-attachments.test.ts`(실제 `AiTerminalService` + 가짜 PTY), `tests/remote-control-core.test.ts`의 w13 묶음.
  ⚠️ **실제 iPhone·실제 버킷으로는 아직 돌리지 않았다** — 내려받기는 가짜 fetch로만, 사이드카 기동은 격리 HOME·APP_DATA_DIR로만 확인했다.

**휴대폰 화면(step B)** — 이 Mac의 패널에만 켜진다(포털이 `AiTerminalPanel`에 `remoteAttach`를 넘긴다, Mac 앱·팝아웃은 그대로 w10의 줄).
- **입구 둘**: 세션 화면 입력칸 왼쪽 44px 「+」(`workroom-remote-attach`) → 「사진 첨부」(사진 보관함·카메라, `accept="image/*"`) ·
  「파일 첨부」(파일 앱, 모든 형식, 10MB까지). 「새 작업」 시트·넓은 화면의 요청 칸에는 같은 두 버튼이 메뉴 없이 있다. iPad·데스크톱 브라우저는
  패널 위로 끌어 놓는다(「여기에 놓으면 첨부합니다」, 파일을 실은 드래그만). 사진 6·파일 10, 10,485,732바이트를 넘는 파일은 저장소에 닿기 전에 거절한다.
- **고르는 순간 시작한다**: 파일마다 암호화 → 업로드 → 서명 → `attachments.receive` 한 번(최대 5개·10,000바이트 묶음) →
  `attachments.status`(1초×5 뒤 2초, 3분 안). 칩이 상태를 말한다 — 올리는 중(`--info`) · 연결 대기(`--ink-3`) · 휴대폰에 보관 · 실패(이유 + 다시 시도/빼기),
  준비되면 배지 없음. 준비된 id는 만료 30초 전이면 「전달 못 함」(다시 시도)으로 바뀐다. 짧은 가로 화면(높이 ≤500px)에서는 칩 줄이 「첨부 N」 하나로 접힌다.
- ⚠️ **끊김은 기다림이지 실패가 아니다**: 오프라인·`PHONE_OFFLINE`·`UNSENT_AHEAD`는 「연결 대기」로 두고 `online` 이벤트와 3초 간격 kick에서 잇는다.
  `navigator.onLine`이 참인데 업로드가 「Load failed」로 끊기면 그 칩을 다음 kick까지 세워 둔다 — 같은 자리에서 다시 돌지 않는다.
  `REQUEST_UNSENT`(휴대폰에 보관된 receive)는 같은 receiveId로 12분까지 기다리고 다시 보내지 않는다. 읽지 못한 status는 같은 receiveId로 3번까지 다시 묻는다.
  3분 기한은 **새로 받은 status**로만 판정한다 — 그 기한을 넘겨 다시 연결된 휴대폰은 묻기도 전에 Mac이 이미 준비한 항목을 실패로 만들었다(리뷰 w13).
  이제 다시 연결되면 먼저 묻고, 그 답이 여전히 pending인 것만 실패다. status가 오프라인으로 거절되는 동안 칩은 「연결되면 전달」이다.
- **보내기**: 준비된 id는 **전체 요청 제출**(새 세션은 launch 영수증)에만 싣는다 — 제출·launch를 모르는 Mac, 기록을 쓸 수 없는 sessionStorage면
  보내지 않고 이유를 말한다(일반 입력으로 흘리지 않는다). 올라가는 중이면 보내기가 「첨부를 전달하는 중…」으로 꺼진다. 24,000바이트는 Mac이 준
  `lineBytes`로 블록까지 센다. 첨부가 있는 요청은 작성 내용 보관함에 넣지 않는다(id가 1시간 뒤 사라진다 — 보관이 켜져 있으면 한 번 안내).
  첨부가 있으면 「보관함에 넣기」와 `@` 전달(다른 세션·기기)은 확인창 전에 거절한다. written이면 그 요청의 칩만 지우고, Mac이 id를 거절하면(`WORKROOM_ATTACH_*`) 그 칩을 실패로 바꾼다.
  ⚠️ **launch도 같다**: 답을 잃은 시작이 나중에 「새 세션 시작 결과 확인」으로 written이 되면 그 launch가 실은 칩도 지운다(`launchAttachKeys`) —
  남겨 두면 프롬프트만 비고 칩이 켜진 시작 버튼 아래 남아, 한 번 누르면 같은 id로 두 번째 CLI가 떴다(리뷰 w13). Mac이 id를 **준비 전에** 거절한
  문장(`remoteAttachIdsRefused` — begin, 또는 쓰기·spawn fence 전의 lease)은 아무것도 쓰지 않았다는 증거라 그 제출·launch 기록도 지운다 — 남겨 두면
  글을 보낼 길이 「중복될 수 있음」 경고를 거치는 것뿐이었다. 보내기·시작 버튼은 칩이 움직이는 중이면 「첨부를 전달하는 중…」, 연결만 기다리면
  「연결되면 첨부를 전달합니다」다(`remoteAttachMovingLabel` — 오프라인에 전달 중이라고 말하지 않는다).
- **다른 프로젝트로 바꿔도 다시 올리지 않는다**: 준비된 칩은 `rebind`로, 아직 Mac에 넘기지 않은 업로드는 새 프로젝트의 receive로 가고, 받던 중인
  묶음은 끝난 뒤 따라간다. 사람이 뺀 칩(전체 빼기·실패 빼기 포함)은 `release`하고, Mac이 받던 중에 뺀 칩은 준비되는 대로 release한다.
  패널이 사라지면(dispose) 아직 넘기지 않은 업로드는 지우고 준비된 id는 release한다 — 휴대폰이 올린 객체는 어느 경로에서든 Mac에 넘기거나 지운다.
  칩·안내의 이름은 w10의 표시 이름이다(제어·방향 문자 없음 — RLO가 「invoice‮fdp.exe」를 「invoiceexe.pdf」로 보이게 했다).
- **세션 화면의 입력 줄을 첨부가 밀어내지 않는다**: 칩 줄은 높이 상한(`min(22vh,132px)`, 넘치면 그 안에서 스크롤)이 있고, 키보드가 올라오면
  할 일이 없는 줄(준비·전달 중뿐)은 접혀 「+」의 숫자 배지(`workroom-remote-attach-badge`, aria 「첨부 · N개 넣음」)가 대신하며, 실패·안내가 있으면
  「첨부 N · M개 못 함」 한 줄이다. 가로 휴대폰은 요약도 그 버튼 뒤로 접는다. 예전에는 실패 셋과 거절 하나가 320×568에서 터미널을 20px로 만들고,
  키보드가 올라오면 위 줄(「← 워크룸」)이 화면 밖으로 나갔다(리뷰 w13). 거절 안내는 written 요청이나 마지막 칩과 함께 사라지고 자기 닫기(44px)가 있다.
  칩 줄은 safe-area를 더하지 않는다 — 세션 화면·시트가 이미 좌우를 채운다(두 번 더하면 가로에서 칩이 입력칸보다 ~47pt 밀렸다). 데스크톱 브라우저의
  인라인 「+」는 명령 칸의 116px 버튼 규칙을 이겨 44px다. 첨부만 두고 닫은 시트는 「새 작업 · 첨부 N」이다.
- **일부 실패는 보내기를 막지 않는다**: 「첨부 N개 중 M개를 전달하지 못했습니다 — 보내면 글과 나머지 K개만 갑니다」(`workroom-remote-attach-summary`)와
  이유 목록, 「다시 시도」·「빼기」. Mac이 `removed:false`로 답한 객체와 거절·취소된 묶음의 객체는 휴대폰이 지운다.
- **꺼진 곳은 이유를 말한다**(「+」는 사라지지 않고 `aria-disabled`): 확장 기능 답을 기다리는 동안(컨트롤러 `featuresProbing` — 레거시 답이 먼저 와서
  확장 기능이 없어 보인다) 「Mac 기능 확인 중」, 기능이 없으면 「Mac 앱 업데이트 필요」, 커뮤니티 기기 패널은 「다른 아젠투지의 세션에는 아직 첨부할 수
  없습니다」. 컨트롤러도 기능 없는 Mac에 `attachments.*`를 보내지 않는다. LAN QR 페이지는 「첨부」 버튼과, 파일을 터미널 위로 **끌고 있는 동안**
  「첨부는 인터넷 연결에서만 할 수 있습니다」를 말한다. ⚠️ dragover의 `dropEffect='none'`이면 실제 브라우저는 drop을 보내지 않으므로, drop에서만
  쓰던 안내는 한 번도 보이지 않았다(리뷰 w13 — 단위 테스트가 `ondrop`을 직접 불러 몰랐다). 안내는 dragenter·dragover에서 쓴다.
- 검증: `tests/remote-workroom-attachments-client.test.ts`(17건: 암호화→업로드→서명 순서·묶음·한도·끊긴 업로드·보관·만료·거절·일부 실패·예산),
  `tests/remote-control-mobile-page.test.ts`(LAN 안내), 격리 포털 빌드 + `bun tests/remote-workroom-attach.e2e.mjs <dir> [shots]`(WebKit·Chromium,
  가짜 E2EE Mac + 메모리 버킷 — 올린 암호문을 릴레이로 받은 키로 열어 sha·크기 확인, 일부 실패, 옛 Mac, 시트, 오프라인(Chromium만 — WebKit은
  `navigator.onLine`을 바꾸지 않는다), iPad 1180×820 드롭, 커뮤니티 거절, 320/390/428/926×428), `tests/remote-workroom-ios-zoom.e2e.mjs`의 넷째 상태
  (메뉴·긴 이름 칩이 16px 미만 칸·페이지 폭을 더하지 않음). Playwright는 multipart Blob을 요청 본문에 싣지 않아 e2e는 페이지 fetch 계측으로 올린 바이트를 받는다.
  리뷰 w13: `tests/remote-workroom-attachments-ledger.integration.test.ts`(실제 휴대폰 큐 ↔ 실제 장부: 다섯 번 전환해도 같은 id·내려받기 6번·할당 그대로,
  다 뺀 뒤 32개가 다시 들어감), `tests/workroom-remote-attachments.test.ts`의 선언 크기·single use·rebind·release 묶음, `tests/transit-blob.test.ts`의
  VOC 읽기 상한, `tests/workroom-submission-remote-attachments.test.ts`의 single use·동시 두 요청(실제 서비스), `tests/remote-workroom-attachments-client.test.ts`의
  리뷰 묶음(전환·dispose·받던 중 빼기·표시 이름·기한 뒤 새 status — 새 status도 pending이면 실패하는 가드만 수정 전에도 통과), `tests/remote-workroom-attach-css.test.ts`(safe-area·상한 계약 — Playwright는
  `env()`를 0으로 푼다), e2e의 `launch-settled-later`·`ids-refused-at-begin`·`launch-ids-refused`·`dock-*`·`keyboard-ready-*`·`notice-goes-with-the-send`·
  `offline-send-label`·`desktop-inline-plus`·`sheet-marker`(키보드는 visualViewport를 덮어써 흉내 냈다), `bun tests/remote-control-mobile-attach-drop.e2e.mjs`
  (Chromium CDP `Input.dispatchDragEvent`로 실제 드래그 경로). 모두 수정 전 코드에서 실패한다(safe-area는 CSS 계약으로만).
- ⚠️ **실기 iPhone·iPad·실제 버킷·설치된 Mac 앱으로는 아직 돌리지 않았다** — 카메라 촬영·HEIC·iOS 파일 앱 선택·실제 드래그도 확인하지 않았다.
