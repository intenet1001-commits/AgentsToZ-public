# 원격 제어 — 카드 · 두 표면 · 여러 대 · 폰 연결 링크 · 프로토콜 버전

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 원격 제어 카드의 이름 — 데스크톱과 같은 제목을 써야 한다

모바일 원격 목록은 Supabase가 아니라 이 Mac의 `ports.json`을 릴레이로 **실시간** 조회한다
(`listRemoteControlRegisteredProjects`, api-server.ts). 원격 전용 저장소가 없으므로 "로컬에 없는
행"은 원리적으로 올 수 없다 — 그렇게 보였다면 **같은 프로젝트를 다른 이름으로 부르고 있는 것**이다.

- ⚠️ **제목은 `name`, 별명은 `aiName`이다.** 데스크톱 카드가 `name`을 제목으로 쓰고 `aiName`은
  작은 `별명 · …` 줄로만 보여주므로(App.tsx), 모바일도 같아야 한다. 한동안 모바일만
  `aiName ?? name` 순서였고(`registeredRemoteControlTarget`), 실측 138개 중 **117개(85%)** 가
  `aiName ≠ name` 이라 목록 전체가 처음 보는 영어 프로젝트로 읽혔다
  (`헤르메스` → `Claude Agent Config`, `CS볼트V6` → `AI Knowledge Vault`).
- DTO는 `name`과 `alias` 둘 다 싣는다. `alias`는 **`name`과 다를 때만** 값이 있고 같으면 `null`이다 —
  같은 문자열을 두 줄로 보여주면 별명이 아니라 중복이다. 검색은 두 값을 모두 매칭한다(영어 별명으로
  찾는 경우가 많다).
- 자동 발견된 워크트리 자식 카드도 같은 규칙이다: 제목은 `<부모 name> · <브랜치>`, 별명은
  `<부모 aiName> · <브랜치>`.
- ⚠️ **휴대폰 쪽 정규화기는 모르는 키를 통째로 거부한다**(`PROJECT_CARD_ALLOWED_KEYS`,
  `normalizeQrRemoteControlProjectCards`). 그래서 DTO에 필드를 하나 더하는 것도 **호환 파괴**이고,
  `REMOTE_CONTROL_PROTOCOL_VERSION`을 함께 올려야 한다(이 변경에서 v4 → v5). 안 올리면 낡은
  번들을 물고 있는 휴대폰이 목록만 조용히 비게 되고, 올리면 페어링 단계에서 "지원하지 않는
  원격 제어 버전"으로 시끄럽게 실패한다. Mac(DMG)과 Vercel 포털이 따로 배포되므로 이 어긋남은
  상시 가능하다.

## 원격 제어 — 두 표면은 같은 것을 제공해야 한다

- **문구 판정은 한 모듈이다(2026-10-07): `src/remoteControlScreenText.ts`** — 동작 라벨(`remoteControlActionLabel`)·
  프로젝트 상태 줄·거절 코드별 다음 할 일(`remoteActionErrorHint`)·워크룸 세션 상태(실행 중/종료 N)·OPS 운영기억 줄.
  포털은 import하고 LAN QR 페이지는 `${fn.toString()}`으로 **같은 함수를 심는다** — 그래서 각 함수는 자기 본문 밖을
  참조하면 안 된다(`tests/remote-control-screen-text.test.ts`가 `new Function`으로 단독 실행해 본다). 두 벌일 때 실제로
  어긋나 있었다: Orca 버튼이 한쪽은 「Orca 탭」 다른 쪽은 「Orca localhost」, 작업트리 더러움 거절에 LAN만 「Commit 먼저」를
  말함, LAN 세션 목록이 「codex · running」 원문, 포털 OPS 줄이 모르는 상태에서 「undefined」.
  ⚠️ 심은 함수의 한글은 `\uXXXX`로 이스케이프돼 나간다 — 생성된 JS에서 한글 문자열을 grep하는 테스트는 실패한다.
  함수 자체를 부르거나 `const 이름=${fn.toString()}`이 들어 있는지를 확인할 것.
- **확인창·결과 문구도 동작마다 한 문장이다(2026-10-16 감사)**: `remoteControlActionConfirm`·`remoteControlActionDone`(QR 페이지도 `actionConfirm`·`actionDone`으로 심는다 —
  「<라벨> 완료」를 만들지 말 것). 버튼 라벨에 말을 붙이면
  「Finder 기능을 실행할까요?」·「Pull 요청을 완료했습니다.」(GitHub PR로 읽힌다)·「…요청 요청은」이 됐다. 새 동작을 추가하면 라벨과 함께 이 둘에도 넣을 것
  (`tests/remote-control-screen-text.test.ts`가 `REGISTERED_PROJECT_ACTIONS` 전부를 본다). 앱에 열기를 **요청**만 하는 동작은 「열었습니다」라고 하지 않는다.
- **휴대폰 날짜는 한 형식이다**: `phoneDateTime`(`src/phoneTime.ts`, 「10월 16일 14:04」, 올해가 아니면 연도) — 포털, 워크룸 하단(`WorkroomSessionFooter` —
  휴대폰 원격 패널에도 그려진다: 「마지막 기억 저장」·statusline 측정 시각), QR 페이지(`const phoneDate=`로 심는다: 세션 만료 「최대 …까지」·오류 기록 시각·
  테스터 실행 시각 — `mountLanTester`의 넷째 인자로 넘긴다). `toLocaleString()`은 기기 지역을 따라 영어 지역 iPhone에서 「마지막 저장 10/16/2026, 2:04:05 PM」이 됐다.
  `opsStatusText`는 QR 페이지가 단독으로 심으므로 같은 계산을 안에 적고 테스트가 둘을 맞춘다. 예외 하나: 워크룸 세션 탭 툴팁의 「HH:mm 시작」
  (`workroomSessionStartedAt`, Mac과 공유하는 24시간제 — 지역을 따르지 않는다).

호스트가 동작을 제안해도 **그 표면이 라벨을 갖고 있지 않으면 버튼은 그려지지 않는다.**
Git·워크트리 동작이 추가될 때 인터넷 포털 카드(`RemoteControlProjectCard.tsx`)에만 들어가고
LAN QR 페이지(`remoteControlMobilePage.ts`의 `ACTION_LABELS`)에는 안 들어가서, 같은 Wi‑Fi로 붙은
휴대폰에서는 Merge·Commit·Pull·Push와 워크트리 버튼이 **에러 하나 없이 통째로 없었다.**
`tests/remote-control-mobile-page.test.ts`가 `REGISTERED_PROJECT_ACTIONS`와 대조해 이 누락을 잡는다 —
**새 동작을 추가하면 두 표면 모두에 라벨을 넣을 것.**

- **워크트리 카드는 부모 바로 뒤에 온다**(`groupWorktreesUnderParents`). 발견된 자식을 목록 끝에
  덧붙이면, 등록 프로젝트가 ~100개인 기기에서 워크트리는 전부 20개씩 넘기는 목록의 4~5페이지로
  밀린다. 실측 102장 중 워크트리가 92~101번이었고, 사용자는 "워크트리가 안 보인다"고 읽었다.
  이 함수는 **입력의 순열을 보장**한다 — 부모가 순환 참조여도 카드를 잃지 않는다(테스트가 잡는다).
- `worktree.add`는 **새 카드가 있는 페이지**를 돌려준다. page 0을 돌려주면 컨트롤러가 누적 목록을
  통째로 갈아치워(`page === 0`이면 replace) 방금 만든 워크트리가 사라지고 실패로 보인다.
- 포털 검색창은 **불러온 페이지만** 거른다. 검색 중 남은 페이지가 있으면 그 사실을 말하고
  「전체 불러와서 검색」을 준다 — 조용히 1/5만 검색하면 있는 워크트리가 "검색 결과 없음"이 된다.
- **아무 응답 없는 요청을 성공으로 보고하지 말 것.** `sendAction`은 자기 `actionId`의 `action.result`가
  오지 않으면 거절한다. `{type:'error'}` 응답도 `#pendingActionId`를 반드시 푼다 — 안 그러면 120자
  넘는 커밋 메시지 한 번에 모든 버튼이 영구히 잠겼다. 릴레이 봉투가 만료되면(10분) 타임아웃으로 푼다.
- **페어링 단계의 거절은 종결(terminal)이다.** `refresh()`가 매 폴링마다 `#error`를 비우므로, 그냥
  두면 "지원하지 않는 버전"이 1초 뒤 사라지고 "Mac이 승인했습니다" 스피너만 영원히 남는다.
- Merge가 할 일이 없으면 `GIT_MERGE_NOTHING_TO_DO`로 **정직하게** 답한다. `git merge`는 이미 반영된
  브랜치에도 exit 0("Already up to date.")을 내므로 무조건 성공 보고는 거짓이 된다.
## 여러 대 동시 원격제어 — 두 축은 서로 독립이다

Codex 앱처럼 상단 탭으로 Mac을 갈아타며 쓰려면 **서로 다른 두 가지**가 필요하고, 둘은
프로토콜을 공유하지 않으므로 따로 고칠 수 있다.

| 축 | 어디를 고치나 | 예전 제약 |
|---|---|---|
| Mac 1대 ← 폰 여러 대 | `RemoteControlCore.#sessions`(Map) · `RemoteControlLanServer.#activeSessions` | `pair()`가 두 번째 컨트롤러에 `SESSION_ACTIVE` 409 |
| 폰 1대 → Mac 여러 대 | 폰의 두 IndexedDB vault를 hostId로 키잉 + 포털 탭 바 | vault가 고정 키 1개라 두 번째 QR이 첫 번째를 **덮어씀** |

- **세션은 이미 격리돼 있었다.** control-ID 네임스페이스·rate window·in-flight 잠금이 전부
  `SessionState` 안에 있으므로, 여러 개를 드는 것은 보안 경계 완화가 아니라 장부 변경이다.
  한 세션이 다른 세션의 control-ID를 부를 수 없다는 성질은 테스트가 지킨다.
- ⚠️ **QR 회전이 기존 연결을 끊으면 안 된다.** 기기를 늘리는 절차가 바로 "회전 → 다른 폰으로
  스캔"이라서, `#newPairing`이 세션을 비우던 예전 동작으로는 다중 기기 자체가 불가능했다.
  명시적 해제(`closeSession`·`disable`)만 끊는다. 대신 진행 중이던 페어링은 이제 회전 뒤에도
  완료된다 — 그 토큰은 회전 전에 이미 소비된 정당한 토큰이다.
- `sweep()`은 **닫힌 세션 목록**을 돌려준다(`closed[]`). 예전처럼 토큰 하나만 보면 나머지 폰이
  끊긴 줄 모르고 계속 연결됐다고 믿는다.
- 만료와 잘못된 토큰을 **같은 오류로 답하지 말 것.** 그냥 조회 실패로 떨어뜨리면 세션이 늙어
  끊긴 폰에 "자격 증명이 잘못됐다"고 말하게 된다 — `SESSION_EXPIRED`를 따로 유지한다.
- 동시 연결 상한은 `REMOTE_CONTROL_MAX_SESSIONS`(8). 상한이 없으면 페어링을 반복하는 것만으로
  메모리가 자란다.
- ⚠️ **인터넷 경로에서는 core의 일회용 토큰이 두 번째 기기를 막는다.** QR이 나르는 것은 core의
  pairing token 하나이고, 모든 컨트롤러가 **같은 비밀**을 제시한다 — LAN(QR 1개=소켓 1개)에서는
  맞지만 릴레이에서는 첫 기기만 페어링되고 끝난다. 릴레이의 기기별 관문은 토큰이 아니라 **Mac에서
  누른 SAS 승인**(세션마다 따로 받는다)이므로, 공유 비밀을 timing-safe 비교로 확인한 뒤
  **그 세션 몫의 core pairing을 새로 발급해 소비**한다(`sameOpaqueSecret` → `rotatePairing` → `pair`).
  core 세션 수 상한과 SAS 승인이 남아 있으므로 관문이 사라진 것은 아니다.
- 폰 하나만 해제하는 것은 `coreSessionToken` 매핑(relay sessionId ↔ core sessionToken)에 달려 있다.
  이 매핑이 끊기면 해제해도 core 세션이 남는데, 상한 8을 다 쓸 때까지 드러나지 않는다 —
  두 대를 붙였다가 하나만 끊고 **남은 쪽이 계속 동작하는지** 보는 테스트가 이것을 지킨다.
- 폰이 호스트를 여러 개 들 때 **1초 폴링을 N배로 늘리지 말 것.** 선택된 호스트만 빠르게 돌고
  나머지는 느리게 돈다.

## 폰 연결 링크 — ① 데이터 연결과 ② 제어 승인은 다른 단계다

휴대폰 온보딩은 두 단계다. **① 데이터 연결**은 Mac 앞이 아니어도 된다: 「외부 인터넷 원격제어 → 앱으로 원격제어」의
「폰 연결 링크 복사」(`phone-connect-link-copy`)가 `agentstoz://connect#<base64url JSON>` 링크를 만들고, iPhone 앱은
링크를 누르거나 첫 화면 「연결 링크 붙여넣기」로 받아 **페어링 없이** `BundledPortalConfig`만 저장해 내장 포털을 연다
(이메일 코드 로그인 → 현황·북마크·기록). **② 제어**는 지금과 똑같이 Mac QR + 6자리 SAS 승인이다.

- ⚠️ **링크는 절대 제어 권한을 주지 않는다.** 실리는 것은 `{v, portal, supabaseUrl, anonKey, hostName}`뿐이다 —
  페어링 비밀·호스트 키·세션을 여기에 추가하지 말 것. 형식의 정본은 `src/phoneConnectLink.ts`, Swift 파서는
  `AgentsToZCore/PhoneConnectLink.swift`이고 둘 다 `tests/fixtures/phone-connect-link-golden.json`을 읽는다.
  형식을 바꾸면 골든 표부터 고칠 것.
- 링크 값은 **다이얼로그에 이미 있는 QR 부트스트랩**(`bootstrap.supabase` — sidecar의 `pairingSupabaseConfig`가 거른 값)에서
  만든다. 새 관리 엔드포인트·Rust 프록시 허용 목록을 늘리지 않았다. 그래서 링크는 그 다이얼로그에서 QR을 발급한 뒤에 보인다.
  `buildPhoneConnectLink`가 service_role·`sb_secret_`를 한 번 더 거절한다.
- `portal`(QR이 가리키는 포털 origin)을 싣는 이유: 내장 포털이 `portalOrigin`으로 QR을 대조하고, 앱의 WK 저장소 키가
  `bundled:<portalOrigin>`이다. 같은 포털이면 나중에 QR로 페어링해도 **로그인이 그대로 이어진다.**
- 앱은 적용 전에 **Supabase 호스트·Mac 이름·포털**을 보여 주고 확인받는다(남의 링크는 남의 프로젝트로 로그인·저장시킨다).
  Mac 이름은 표시용이며 제어·bidi 문자를 거절한다.
- QR의 Supabase가 링크의 것과 다르면 **QR이 이긴다** — 앱(네이티브) 스캔은 확인 문구로 알리고 바꾼다. 내장 포털의
  페이지 스캐너는 프로젝트를 바꿀 수 없으므로 `bundledQrSupabaseMismatch`로 거절하고 워크룸 툴바 「연결 설정」의
  **「다른 연결 QR 스캔」**(`workroomScanOtherQR`)으로 안내한다(2026-10-16). ⚠️ 「앱 첫 화면」으로 안내하지 말 것 — 워크룸이
  첫 화면을 덮고 다시 실행하면 저장된 작업 공간이 복원되므로, 그 버튼 전에는 로그인을 지우는 길(「이 앱의 연결 정보 지우기」)밖에
  없었다. 그 버튼은 `session.end(.disconnected)`만 하므로 저장된 설정·WK 저장소(로그인·페어링)를 지우지 않고 네이티브
  스캐너를 연다. 스캔·확인을 취소하면 저장된 작업 공간으로 돌아간다(`resumeIfIdle`). 앱이 쓸 수 없는 값을 찍으면(Wi‑Fi·메뉴 QR, 잘린 링크)
  예전에는 아무것도 열리지 않은 채 첫 화면에 남았다(내장 포털 사용자는 주소 칸에 넣을 주소가 없다 — 다시 실행해야 돌아갔다). 지금은 그 스캔이
  워크룸에서 열린 것이면 「이 QR로는 연결할 수 없습니다」 창이 이유를 보이고 「작업 공간으로 돌아가기」·「다시 스캔」 중 고르게 한다(`rejectedScan`,
  통합 리뷰 w4, 4b). ⚠️ 저절로 돌아가지 않는 것은 의도다 — 돌아간 작업 공간이 첫 화면을 덮어 이유가 안 보인다. 창이 떠 있는 동안에는 앱 복귀
  (`scenePhase` active)도 작업 공간을 다시 열지 않는다. 검증: `tests/phone-connect-link.test.ts`의 「iPhone app: a scan from the workroom that
  cannot be used」(소스 계약) + 무서명 시뮬레이터 빌드. 실기에서는 아직 눌러 보지 않았다.
- **페이지 스캐너는 큰 화면을 요청하고 침묵하지 않는다**(`src/portalQrCameraScan.ts`, 2026-10-16). `facingMode`만 요청하던 동안
  iPhone 17 Pro WKWebView가 480×640 트랙을 줬고, ~862자 페어링 QR(밀도 높은 QR)은 모듈이 1~2px라 zxing이 끝내 읽지 못했으며
  화면은 아무 말도 하지 않았다. 지금은 `width/height: {ideal: 1920/1080}`(ideal만 — exact/min은 못 맞추는 카메라를 OverconstrainedError로
  막는다) + zxing 힌트 QR 전용·TRY_HARDER이고, 스트림이 뜬 뒤 8초 동안 아무것도 읽지 못하면 사각형 아래에 「더 가까이 · QR 사진 선택」
  안내를 띄운다(스캐너는 닫지 않는다). 검증: `tests/portal-qr-camera-scan.test.ts`, `bun tests/portal-qr-scanner-camera.e2e.mjs`
  (WebKit·스텁 카메라: 요청 크기·8초 안내·실제 밀도의 QR 디코드·다른 Supabase 안내 문구). 실기 해상도는 아직 확인하지 않았다.
- **거절된 QR·읽지 못한 사진 뒤에도 카메라는 계속 읽는다**(감사 2026-10-16). 예전엔 받은 QR을 수락하기 **전에** 카메라를 끄고 수락이 실패해도
  (다른 Supabase QR, 보관함 준비 전) 다시 켜지 않아, 안내선만 그려진 검은 미리보기가 「아직 읽는 중」처럼 보였다(사진 실패도 같았다). 지금은 수락하는 동안
  카메라를 켜 둔 채 그 사이 디코드를 버리고 **성공할 때만** 끄며, 사진이 수락되지 않으면 카메라를 다시 켠다. 거절된 같은 값은 화면에 남아 있어도 다시
  시도하지 않는다(QR 자체의 거절은 창이 닫힐 때까지, 그 밖의 실패는 그 QR이 화면에 있는 동안 2.5초에 한 번씩 — 앱이 준비되면 저절로 붙는다). QR이 아니라
  앱 쪽 이유(「연결 준비 중…」·저장 실패)는 「새 QR을 받으라」고 말하지 않는다(`portalQrAcceptFailureMessage`). 검증: 같은 e2e의 4·5단계(수정 전 빌드에서 실패),
  `tests/portal-qr-scanner-accept.test.ts`, `bun tests/portal-qr-scanner-retry.e2e.mjs`(시도 횟수를 센다 — 억제를 빼면 실패).
- **웹 포털 없이 켜기(「앱으로만 원격제어」)**: `/api/remote-control/internet/enable`의 `controllerOrigin`은 **선택**이다.
  없으면 설정된 웹 포털(`suggestedInternetControllerOrigin`) → 공개 기본값 `DEFAULT_REMOTE_CONTROLLER_ORIGIN`
  (`src/defaultRemoteControllerOrigin.ts`, 리터럴은 이 파일 한 곳만 — 테스트가 지킨다). 잘못된 값을 **보냈으면** 기본값으로
  바꾸지 않고 `INVALID_CONTROLLER_ORIGIN`이다. 기본값은 「이 Mac의 웹 포털」이 아니므로 `lastInternetControllerOrigin`에
  기억하지 않고 제안값으로도 돌려주지 않는다(대화상자가 앱 전용으로 남는다). 대화상자의 주소 칸은 「웹앱으로도 쓰기 (선택)」
  접힘 안에 있다. 앱은 origin이 아니라 QR/링크의 `supabase`로 연결하므로 여러 사람의 Mac이 같은 기본값을 써도 각자의 DB로 간다.
- ⚠️ **웹 포털은 다른 Supabase용 QR을 받지 않는다**(`src/portalForeignPairing.ts`). 번들이 아닌 `/remote/`가 QR의
  `supabase.url` ≠ 빌드된 `VITE_SUPABASE_URL`인 조각을 받으면 앱 대신 `remote-foreign-pairing` 안내만 그리고 자기 Supabase·릴레이에
  **아무 요청도 하지 않는다**(`tests/portal-foreign-pairing.e2e.mjs`가 만료 세션을 심어 대조군과 함께 확인). `supabase` 없는 옛 QR은 예전대로.
- 페어링 없는 내장 포털의 「원격 작업」은 오류가 아니라 `remote-view-only`(「보기 전용 · Mac 제어는 Mac 앞에서 QR 승인 후」 +
  페어링 3단계)다. 검증: `tests/phone-connect-link.test.ts`, `bun run test:ios`, `tests/phone-connect-link-dialog.e2e.mjs`,
  `tests/bundled-portal-linked.e2e.mjs`(빌드: `bun mobile/ios/scripts/build-portal-web.ts`).
- **앱 껍데기(2026-10-16 감사, w5-ios)** — 판정은 `AgentsToZCore/WorkroomShell.swift`(`bun run test:ios`), 배선은 `tests/ios-shell-contract.test.ts`.
  - ⚠️ **「이 앱의 연결 정보 지우기」는 정말 지운다.** 웹뷰가 살아 있는 동안 `WKWebsiteDataStore.remove(forIdentifier:)`는 「Data store is in use」로
    거절되고 그 오류를 버리고 있어서, 로그인(localStorage)·페어링 볼트(IndexedDB)가 남은 채 「지웠습니다」라고 했다(macOS WebKit 실측). 순서는
    페이지에 묻기(10초 상한) → 페이지 종료 → **살아 있는 저장소의 기록 삭제**(웹뷰가 있어도 된다) → 웹뷰를 놓은 뒤 저장소 제거(재시도 ~6초, 실측 0.1초에
    성공) → 실제로 일어난 일을 첫 화면에 말한다(`WorkroomWipeReport`). 둘 다 실패하면 다음 실행 때 지우고 그때까지 그 저장소를 되살리지 않는다
    (`WorkroomStoreWipe` pending). 포털 브리지(`window.agentstozDisconnect`)는 **연결된 모든 Mac**을 해지한다(`revokeEveryRemoteHost`, 8초 상한) —
    화면의 Mac만 해지하던 동안 나머지 Mac은 이 휴대폰을 계속 승인된 기기로 들고 있었다.
  - **새 창으로 여는 외부 링크는 시스템 브라우저로 간다**(북마크·배포/GitHub 링크·음성 키 발급 페이지). 웹뷰는 여전히 잠겨 있다: `target=_blank` 링크는
    `.linkActivated`이고 대상 프레임이 없을 때, 팝업은 `createWebViewWith`에서 `UIApplication.shared.open`(`WorkroomExternalLink.Request`). 둘 다 WebKit의
    팝업 문(`javaScriptCanOpenWindowsAutomatically=false`)을 지나야 오므로 탭에서만 온다 — 스크립트의 `_blank` 클릭·`window.open`은 어느 델리게이트에도 닿지 않는다.
    ⚠️ **메인 프레임 링크는 열지 않는다**: WebKit은 제스처 없는 스크립트 `a.click()`도 `.linkActivated`로 보고해서, 그것만 보던 동안 페이지 스크립트가 탭 없이
    Safari·유니버설 링크 앱을 띄울 수 있었다(리뷰 2026-10-16, macOS WebKit 프로브). 포털의 외부 링크는 전부 `_blank`·`window.open`이다.
    한 탭에 WebKit은 둘 중 하나만 부른다(실측). LAN 페이지는 봉인 그대로다. 포털은 `agentstozNativeExternalLinks`를 받고, 그것이 없는 앱 셸에서는
    `openPreferredBrowser`가 거절해 북마크 방문 수가 늘지 않는다.
  - **저장된 작업 공간은 페이지가 뜬 뒤에만 저장한다**(`didFinish` → `WorkroomSavedWorkspaces.commit`). 인터넷 작업 공간(내장·웹) 하나와 **그 옆에** LAN
    작업 공간 하나를 둔다 — 같은 Wi‑Fi QR이 인터넷 작업 공간을 영영 지우던 것을 막는다. 다시 열기는 마지막에 저장한 것, 첫 화면 「저장된 작업 공간」,
    LAN 실패 화면의 「내 작업 공간(인터넷) 열기」, 그리고 **열려 있는 작업 공간의 「연결 설정 → 다른 작업 공간 열기」**(`workroomOpenOtherSavedWorkspace`)로
    다른 것을 연다. ⚠️ 마지막 것이 없던 동안 같은 Wi‑Fi에서는 LAN 페이지가 늘 다시 열려(재실행·복귀·스캔 취소 모두) 저장된 인터넷 작업 공간에 닿을 길이
    없었다(리뷰 2026-10-16). 같은 포털 주소를 입력하면 저장된 내장 포털 설정을 다시 쓴다. 옛 키(`agentstoz.workroom.origin`)는 그대로 읽는다.
  - WebContent 프로세스가 회수되면(앱 전환 뒤) 1분에 한 번까지 스스로 다시 연다. 그 전에 죽은 문서에 묶인 것 — 떠 있던 확인창, 진행 중이던 로그인
    (취소하고 다시 시도하라고 말한다), VOC 넘김 — 을 `end()`와 같은 `releaseDocumentBoundState`로 놓는다(리뷰 2026-10-16: 남은 확인창이 새 페이지의
    대화상자를 막았다). 그래도 죽으면 네트워크 조언 없이 그 사실을 말한다 — 첫 로드 전에 죽은 페이지는 「반복」이 아니라 「열리기 전에 종료」이고,
    「다시 연결」이 QR의 일회용 조각을 싣지 않으므로 QR로 연결하던 중이었다면 다시 스캔하라고 말한다(`WorkroomContentRecovery.failureMessage(loaded:)`).
  - 자체 호스팅 Supabase(`*.supabase.co` 아님): 내장 페이지의 meta CSP에도 그 호스트를 더하고(`servedHTML`), 네이티브 Google 로그인은 그 프로젝트 호스트를
    받으며, 거절한 로그인 요청에는 즉시 답한다(5분 대기 없음). 연결 설정은 내부 origin 대신 포털·Supabase 호스트를 보여 준다.
  - 실기기(iPhone)에서는 아직 눌러 보지 않았다 — 검증은 macOS WebKit 프로브·Core 검사·무서명 시뮬레이터 빌드·포털 e2e다.

## `REMOTE_CONTROL_PROTOCOL_VERSION` — DTO 필드 추가는 곧 호환 파괴

휴대폰 정규화기(`PROJECT_CARD_ALLOWED_KEYS`)가 모르는 키를 통째로 거부하므로, 카드 DTO에 필드를
하나 더하는 것도 버전 상승을 요구한다. **Mac 앱(DMG)과 Vercel 포털은 따로 배포되므로 스큐가 상시
가능하다** — `main`에 push하면 포털만 먼저 새 버전이 된다. 배포 순서는 **커밋 → DMG 빌드·설치 →
push** 다.
