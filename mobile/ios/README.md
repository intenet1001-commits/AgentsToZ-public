# AgentsToZ iOS companion

SwiftUI 연결 화면, Foundation 프로젝트 통신 코어와 **같은 Wi-Fi AI 워크룸**을 제공합니다. 워크룸은 선택한 Mac이 제공하는 `/remote/` 화면을 앱 내부 WKWebView에서 실행합니다. LAN 연결에는 Vercel 가입이나 웹 배포가 필요 없습니다. 인터넷 연결도 개인 포털의 워크룸을 같은 앱 내부 컨테이너에서 엽니다. Google 인증은 시스템 ASWebAuthenticationSession에서 처리한 뒤 PKCE code만 원래 웹 소유자에게 돌려줍니다. 기존 웹의 Supabase·E2EE 구현을 재사용하며 별도 네이티브 E2EE 클라이언트를 만들지 않습니다.

## 연결과 워크룸

1. Mac의 `원격제어 → 같은 Wi-Fi 연결`을 켜고 **새 QR**을 만듭니다.
2. iPhone 앱에서 `QR 스캔`을 사용하거나 본인 개인 포털의 HTTPS 주소를 입력합니다. 표시된 Mac 주소를 확인하고 연결합니다. 프로젝트와 워크룸은 같은 웹 화면·연결을 사용하며 탭 전환으로 QR을 다시 소비하지 않습니다.
3. Mac에서 **이번 연결의 AI 터미널 허용**을 켭니다. QR 연결만으로 터미널 권한을 얻지 않습니다.
4. 워크룸에서 등록 프로젝트와 설치된 AI 종류를 선택해 새 터미널을 열거나 현재 연결의 세션을 선택합니다. 명령 입력·출력 확인·Enter/Esc/Ctrl+C·명시적 세션 종료는 기존 Mac 모바일 워크룸과 동일합니다.
5. `세션 기억하기…`는 선택한 세션의 입력란에 요청 초안만 채웁니다. 작성 중인 내용은 보존하며 자동 전송·저장 성공을 주장하지 않습니다. 내용을 확인해 직접 전송하고 터미널 결과로 저장 여부를 확인합니다. 미확정 저장을 강제로 재시도하거나 잠금을 푸는 권한은 추가하지 않습니다.

QR은 한 번만 사용할 수 있습니다. 새 연결은 프로젝트·워크룸이 하나의 연결을 공유합니다. 과거 버전의 프로젝트 전용 연결은 별도 Keychain 소유자이므로 자동으로 워크룸에 복사하지 않습니다. 이 기존 연결을 전환할 때는 현재 새 QR 연결이 필요하며, 서버 검증 handoff는 아직 제공하지 않습니다.

워크룸 기능은 **연결 대상 Mac이 제공하는 버전**을 따릅니다. v413 Mac의 LAN 웹 워크룸과 같은 범위이며, 설치되지 않은 AI의 실행이나 아직 준비되지 않은 구조화 managed 실행을 활성화하지 않습니다. Mac이 꺼져 있거나 LAN 연결이 없으면 워크룸을 오프라인으로 실행할 수 없습니다. 프로젝트 장기기억·북마크·내가 한 말 전체를 iOS에 동기화하는 기능은 이 변경 범위에 포함되지 않습니다.

## 연결 종료와 재연결

- **백그라운드는 연결 종료가 아닙니다.** 앱을 숨기거나 화면이 잠겨도 워크룸의 동일 WKWebView·선택 탭을 유지합니다. iOS가 네트워크를 중단하면 웹 전송 계층이 저장된 세션으로 **새 QR 없이** 재연결합니다. 앱 재실행은 검증된 마지막 Mac origin과 전용 웹 저장소를 다시 열며 일회용 QR을 재전송하지 않습니다. Mac은 페어링된 세션을 30일간 유지하며, v425부터 Mac을 재시작해도 리스너·포트·세션을 복구합니다.
- `연결 해제`는 다릅니다. Mac에 `session.end`를 보내 세션을 실제로 끝내고, 이 iPhone에 저장된 토큰과 워크룸 저장소를 지웁니다. 그 뒤에는 새 QR이 필요합니다.
- 과거 프로젝트 전용 연결의 세션 토큰은 Keychain에 Mac origin별로 저장합니다(`kSecAttrAccessibleAfterFirstUnlock`, iCloud 동기화 없음). QR의 페어링 토큰은 여전히 저장하지 않습니다 — 그건 일회용입니다.
- 워크룸 WKWebView는 Mac origin에서 유도한 **전용 영구 저장소**를 씁니다(iOS 17 `WKWebsiteDataStore(forIdentifier:)`). 다른 Mac·Safari·앱의 다른 화면과 공유하지 않으며 `연결 해제` 시 삭제합니다.
- 호스트가 세션을 끝냈다고 답하면(만료·해지·QR 무효) 저장된 토큰을 버리고 새 QR을 안내합니다. Mac이 꺼져 있거나 다른 네트워크에 있는 경우는 **버리지 않습니다** — 나중에 다시 됩니다.
- Mac이 재시작 등으로 연결을 정리할 때 보내는 1012는 «다시 오라»는 뜻으로 처리하고, 1000/1001/1008과 구분합니다. **Mac의 실행 중인 AI는 계속 실행됩니다.** 입력·Ctrl+C·세션 종료 요청을 자동으로 보내지 않습니다.
- 결과가 불확실한 시작·입력 요청을 자동 재전송하지 않습니다. Mac이 거절한 요청(RATE_LIMITED 등)은 **연결을 끊지 않고** 그 이유를 보여줍니다.
- 새로운 QR은 **새 연결**입니다. 터미널 권한도 다시 허용해야 하며 이전 연결 소유의 터미널을 자동 인계받지 않습니다.
- 전송 전 입력과 화면 버퍼는 디스크에 보존하지 않으므로 앱 프로세스 종료 시 사라집니다. 일반 background에서는 같은 문서를 유지합니다. 장시간 Mac 작업은 유지되지만 iOS 앱을 숨긴 동안의 실시간 터미널 표시와 푸시 알림은 제공하지 않습니다.
- 명시적인 `세션 종료`만 선택한 AI 터미널을 중지합니다. 연결 해제와 서로 다른 동작입니다.

## 인터넷 QR

Mac의 인터넷 원격제어 QR 또는 본인 개인 포털의 `https://<개인 포털>/remote/` 주소를 스캔·입력하면, 표시된 HTTPS origin을 확인한 뒤 앱 내부 워크룸을 엽니다. 동일 origin의 전용 WK 저장소에서 기존 controller·E2EE를 유지합니다.

Google 로그인은 **ASWebAuthenticationSession**에서 진행합니다. 웹의 PKCE verifier는 WK 저장소에 남고 네이티브는 검증된 callback의 `code`만 같은 대기 요청으로 전달합니다. main frame·선택 포털 origin·Supabase authorize endpoint·Google provider·S256 challenge·일회성 state·정확한 `agentstoz-mobile://auth/callback`를 검증합니다. callback의 bearer token·fragment·중복/미지원 필드·다른 state는 거부합니다. 네이티브 인증 창은 295초에 취소되어 웹의 300초 응답 대기보다 먼저 정리됩니다. 만료·취소된 시도의 늦은 callback은 다음 시도를 완료할 수 없습니다. 취소·실패로 기존 E2EE 자격을 지우지 않습니다. 세션 쿠키나 refresh token을 Safari와 복사하지 않습니다.

**필수 외부 설정:** 개인 Supabase 프로젝트의 Auth Redirect URLs에 `agentstoz-mobile://auth/callback?state=*`를 허용해야 합니다. 새 웹 bridge가 배포되어 있어야 하며 기본 `<project>.supabase.co` 인증 endpoint만 지원합니다. custom auth domain은 아직 지원하지 않습니다. 이 설정을 코드가 자동 변경하지 않습니다. 실제 Google 로그인→Mac SAS→같은 iPhone 앱 복귀는 외부 설정과 실기기 설치 조건을 충족한 뒤 확인해야 하며, 정책 단위 테스트나 Safari 열기를 완료 증거로 간주하지 않습니다.

공식 근거: [Apple 시스템 인증 세션](https://developer.apple.com/documentation/authenticationservices/authenticating-a-user-through-a-web-service), [Supabase 네이티브 deep link 설정](https://supabase.com/docs/guides/auth/native-mobile-deep-linking), [PKCE 코드 교환](https://supabase.com/docs/reference/javascript/auth-exchangecodeforsession).

## 폰 연결 링크 — ① 데이터 연결과 ② 제어 승인은 두 단계

Mac 앞이 아니어도 휴대폰을 먼저 **데이터에** 연결할 수 있습니다. Mac 제어는 여전히 Mac 앞에서만 엽니다.

1. **① 데이터 연결 (어디서든):** Mac의 「외부 인터넷 원격제어 → 원격제어 채널 → 앱으로 원격제어」에서 **「폰 연결 링크 복사」**를 누르고, 카카오톡 「나와의 채팅」·메시지 등으로 iPhone에 보냅니다. iPhone에서 링크를 누르면(`agentstoz://connect#…`, Info.plist `CFBundleURLTypes`에 `agentstoz` 등록) 앱이 열립니다. 채팅 앱이 링크로 인식하지 않으면 복사해서 첫 화면의 **「연결 링크 붙여넣기」**(또는 주소 칸)에 붙여 넣습니다.
2. 앱은 적용 전에 **Supabase 호스트(예: `abcd.supabase.co`)·Mac 이름·포털 주소**를 보여 주고 확인을 받습니다. 남이 보낸 링크는 그 사람의 프로젝트를 가리킬 수 있기 때문입니다.
3. 적용하면 페어링 없이 `BundledPortalConfig`만 저장하고 내장 포털을 엽니다. 이메일 코드로 로그인하면 프로젝트 현황·북마크·기록(장기기억)을 볼 수 있고, 「원격 작업」은 **「보기 전용 · Mac 제어는 Mac 앞에서 QR 승인 후」** 안내를 보여 줍니다(오류 아님).
4. **② 제어 승인 (Mac 앞에서):** 나중에 Mac QR을 스캔하고 6자리 코드를 승인하면 제어가 열립니다. 링크와 QR의 포털 주소가 같으면 WK 저장소 키(`bundled:<portalOrigin>`)가 같아 **로그인을 다시 하지 않습니다.** 내장 포털 안의 「작업 기기 연결 · QR 스캔」도 같은 페이지·같은 세션으로 이어집니다.
5. QR의 Supabase가 링크로 연결한 것과 다르면 **QR이 이깁니다.** 앱 첫 화면의 QR 스캔은 연결 전에 그 사실을 알리고 QR 설정으로 바꿉니다. 내장 포털 안의 스캐너는 프로젝트를 바꿀 수 없으므로 거절하고 앱 첫 화면에서 다시 찍으라고 안내합니다.

링크에는 `{v, portal, supabaseUrl, anonKey, hostName}`만 들어 있습니다 — 페어링 비밀·호스트 키·세션이 없으므로 **링크로는 어떤 Mac도 제어할 수 없습니다.** Mac은 QR과 같은 가드(`pairingSupabaseConfig`: 공개 anon/publishable 키만, service_role이면 거절)를 거친 값으로만 링크를 만들고, `buildPhoneConnectLink`가 한 번 더 거절합니다. 앱도 service_role JWT·`sb_secret_` 키·잘못된 주소를 거절합니다. 형식의 정본은 `src/phoneConnectLink.ts`, Swift 파서는 `AgentsToZCore/PhoneConnectLink.swift`이고, 둘 다 `tests/fixtures/phone-connect-link-golden.json`을 읽습니다(`bun test tests/phone-connect-link.test.ts`, `bun run test:ios`). 포털 쪽 상태는 `tests/bundled-portal-linked.e2e.mjs`가 검사합니다.

**웹 포털 없는 Mac(「앱으로만 원격제어」).** 자기 Supabase를 쓰고 웹 포털을 배포하지 않은 Mac은 주소 없이 외부 원격제어를 켤 수 있습니다. 그 QR의 포털 주소는 공개 기본값 `DEFAULT_REMOTE_CONTROLLER_ORIGIN`(`src/defaultRemoteControllerOrigin.ts`)이며 **식별값일 뿐**입니다 — 앱은 그 주소를 열지 않고 QR의 `supabase`로 내장 포털을 엽니다. 그래서 서로 다른 사람의 Mac이 같은 기본 주소를 써도 각자 자기 Supabase에 연결됩니다(WK 저장소 키 `bundled:<기본 주소>`는 같으므로, 한 휴대폰으로 서로 다른 Supabase의 Mac을 번갈아 쓰면 앱 첫 화면의 QR 스캔이 설정을 바꾸고 다시 로그인하게 됩니다). 휴대폰 **카메라**로 찍으면 공개 웹 포털이 열리는데, 웹 포털은 QR의 Supabase가 자기 것과 다르면 로그인·릴레이 요청 없이 「이 QR은 다른 사용자의 AgentsToZ(자기 Supabase)용입니다. iPhone의 AgentsToZ 앱으로 스캔하세요.」만 보여 줍니다(`src/portalForeignPairing.ts`, `tests/portal-foreign-pairing.e2e.mjs`).

## 보호 범위

- LAN QR은 정규화하지 않은 RFC1918 IPv4·1024~65535 포트·정확한 `/remote/#pair=...`만 받습니다. 토큰은 메모리에만 두고 설명·로그에 출력하지 않습니다. Mac 페이지는 첫 실행 시 URL fragment를 제거합니다.
- WKWebView는 Mac origin별 전용 영구 저장소를 사용하며 인증 전용의 제한된 native bridge만 제공하며 임의 경로·셸 API나 공유 로그인 세션은 제공하지 않습니다. 예전에는 매 연결 `.nonPersistent()`였는데, 그 때문에 Mac이 30일간 유지하는 세션의 폰 쪽 절반이 매번 사라져 화면을 잠글 때마다 Mac까지 걸어가야 했습니다(소비한 QR은 재사용할 수 없습니다).
- 문서 탐색은 확인한 Mac origin의 `/remote/`와 `/remote/index.html`만 허용합니다. 다른 origin, query, iframe, 팝업, 다운로드를 차단하고 새로고침으로 QR을 재전송하지 않습니다. 정적 자산과 WebSocket은 기존 LAN 서버의 정확한 경로 제한과 CSP를 사용합니다.
- LAN HTTP는 신뢰하는 개인 Wi-Fi 전용입니다. ATS 전체 해제 없이 기존 `NSAllowsLocalNetworking`만 사용합니다. [Apple의 로컬 ATS 설명](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)을 참고하세요. 카메라·LAN 권한은 OS의 기존 동의 흐름을 유지합니다.
- 큐·출력 예산, 연결별 opt-in, 요청 중복 방지는 Mac의 `remoteControlMobilePage.ts`/`remoteControlLanServer.ts`/`AiTerminalService`가 정본입니다. iOS에서 별도 터미널 프로토콜이나 무제한 원문 캐시를 만들지 않습니다. xterm scrollback 1,500줄, 입력 대기 128건, 사용자 입력 32KiB 및 기존 전송 제한을 그대로 사용합니다.

## 개인 작업 공간 진입

첫 화면에서 사용 중인 개인 포털의 HTTPS 주소를 입력하면 공통 홈·프로젝트 현황·원격 작업·북마크·기록을 같은 WKWebView에서 연다. 주소 입력은 origin, `/`, `/portal.html`, `/remote/`를 지원하며 실제 문서는 엄격한 `/remote/`로 연다. QR의 기존 검증과 탐색 허용 경로를 넓히지 않는다. 개인 배포 주소는 소스에 기본값으로 넣지 않는다.

프로젝트 현황과 공통 북마크의 계정 로그인은 원격 호스트 QR 승인과 별개다. 같은 Wi-Fi QR은 기존 LAN 직접 연결 경로를 유지한다. LAN 정적 UI 전체를 새 React 포털과 통합한 것은 아니다.

상단 연결 설정은 같은 문서 위에 열리고 완료/닫기로 연결을 해제하지 않는다. 연결 정보 삭제는 별도 확인 후 실행한다. 기기 추가와 전환은 공통 작업 공간 안에서 한다.

## 검증

현재 변경의 실행 근거와 실기기 인계: [네이티브 실행 기록](../../docs/plans/mobile-workspace-2026-09-11/NATIVE-EXECUTION.md).

저장소 루트에서:

```sh
bun run test:ios
bun run preflight:ios
# 전체 Xcode와 사용 가능한 iOS simulator runtime 필요
bun mobile/ios/scripts/check-workroom.ts
python3 mobile/ios/scripts/check-ui.py
# USB iPhone (격리 UI 시험 번들, 팀 기본값 사용). 실행 전 --plan으로 명령만 확인 가능
python3 mobile/ios/scripts/check-ui.py --device '<device-id>'
```

`test:ios`는 동일 Swift 코어를 컴파일해 주소·탐색 경계 회귀를 실행하고, 임시 Bun LAN 서버와 실제 URLSessionWebSocketTask의 QR·목록·확인된 동작·명시적 종료(`session.end`)·**새 QR 없는 세션 복구**·리다이렉트 거부·요청 취소를 검증합니다. `swift test --package-path mobile/ios/AgentsToZCore`로 같은 회귀를 XCTest에서도 실행할 수 있습니다.

⚠️ **`bun run verify`는 이 앱을 건드리지 않습니다.** 실측(2026-09-10): Mac 쪽에서 「소켓 종료 ≠ 세션 종료」로 계약을 바꾼 뒤 `test:ios`가 깨져 있었는데 verify는 4,011건 전부 통과했습니다. 원격제어 계약(`remoteControlCore.ts`·`remoteControlLanServer.ts`·`remoteControlMobilePage.ts`)을 건드렸다면 `bun run test:ios`를 따로 돌리세요. CI에서는 `verify.yml`의 `native-ios` job이 push마다 `swift test`와 무서명 iPhone 빌드를 강제합니다. `native-ios.yml` 수동 workflow는 XCUITest로 빌드·온보딩 입력/주소 거절을 검사하며 개인 포털 시험은 명시적으로 skipped로 남깁니다. 실제 LAN/PTY가 필요한 `check-workroom.ts`와 `check-native.ts`는 사설 IPv4가 있는 단말에서 위 명령으로 별도 실행해야 합니다.

`check-ui.py`는 기본값으로 별도의 빈 simulator에서 프로덕션 앱을 XCUITest로 조작합니다. 기본 실행은 한글 문자열 입력·잘못된 주소 거절 1개 시험을 실행하고 개인 포털 시험 1개를 건너뜁니다. 선택적으로 `AGENTSTOZ_IOS_PORTAL_URL`에 본인 HTTPS origin을 로컬에서만 지정하면 익명 포털의 탭, 연결 설정 열기/완료/삭제 취소, 테마 메뉴 바깥 탭, 회전, background 복귀와 실제 앱 프로세스 종료/재실행을 추가 검사합니다. Google 로그인이나 실제 호스트 연결·작업은 실행하지 않습니다. 한글 문자열 주입은 한글 키보드 조합·받침 편집 검증을 대신하지 않습니다.

`--device <device-id> [--team <team-id>]`는 같은 XCUITest를 USB iPhone에서 실행합니다. 앱은 격리 번들 `com.intenet.agentstoz.mobile.uitest`("AgentsToZ UI 시험")로 서명·설치되고 실행 전후에 그 앱과 러너만 지웁니다 — 실제 앱(main·dev·TestFlight)과 저장된 연결은 건드리지 않습니다. `--plan`은 명령만 JSON으로 출력하고 빌드·기기 접근을 하지 않습니다. 결과는 `mobile/ios/build/ui-device-evidence/run-*/`(`actualIPhone: true`, `gitHead`)에 남습니다. 화면별로 무엇이 자동이고 무엇을 사람이 눌러야 하는지는 [실기기 체크리스트](DEVICE-CHECKLIST.md)를 따릅니다.

러너는 Xcode가 생성한 xctestrun v1/v2를 읽고 통과·실패·건너뜀 수를 각각 판정합니다. 만든 simulator와 컴파일 캐시는 정리하며 결과·화면·로그는 `mobile/ios/build/ui-evidence/run-*/`에 남깁니다. 선택적 포털 실행의 화면/로그에는 개인 주소가 포함될 수 있으므로 해당 폴더 전체를 공개 업로드하지 마세요. CI에는 개인 주소나 계정을 넣지 않습니다.

`check-workroom.ts`는 **고유한 일회용 iPhone 시뮬레이터**와 테스트 앱을 만듭니다. 프로덕션 `LANWorkroomView.swift`와 실제 Mac LAN HTML·JS·CSP·WebSocket·PTY를 사용하고, 임시 등록 프로젝트와 네트워크를 쓰지 않는 가짜 CLI만 실행합니다. 프로젝트·AI 선택, opt-in 전 거부/후 허용, 중복 시작·전송·종료, 실제 출력, 기억 초안 보존/비실행, 외부 탐색·팝업 차단, background 복귀 후 동일 WKWebView·연결 소유자·Mac 작업 유지, 새 연결의 권한 격리를 확인합니다. 일회용 시뮬레이터에서 Settings를 전면에 열고 복귀해 실제 SwiftUI background hook도 검사합니다. 실제 iPhone의 카메라·LAN 권한 동작은 아래 실기기 항목으로 구분합니다.

테스트 서버는 운영 중인 포트 3001과 실제 앱 데이터를 사용하지 않습니다. 사설 IPv4 인터페이스가 없으면 실패하며 공인 IP나 wildcard로 대체하지 않습니다. 테스트 QR은 임시 파일/stdin으로만 전달합니다. own listener·가짜 PTY·시뮬레이터·임시 토큰은 finally에서 제거하고, 비밀이 없는 결과·화면은 `mobile/ios/build/workroom-evidence/`에 남깁니다. 다른 시뮬레이터는 종료하거나 앱을 설치하지 않습니다.

실기기 격리 fixture도 같은 runner로 실행할 수 있습니다. 서명된 템플릿의 bundle ID는 반드시 `com.intenet.agentstoz.workspacetest`여야 합니다. 다른 앱으로 재서명하거나 기존 앱을 삭제하지 않습니다.

```sh
bun mobile/ios/scripts/check-workroom.ts --device '<device-id>' '<signed-isolated-app-path>' '<Apple Development signing identity>'
```

템플릿은 프로덕션 앱을 격리 bundle로 빌드한 것이다. 팀 profile에 App Group이 없으므로 `CODE_SIGN_ENTITLEMENTS=`로 App Group 요청을 뺀다(App Group을 만드는 것은 Apple 계정 변경이고, 이 fixture는 공유 확장 VOC 보관함을 쓰지 않는다):

```sh
xcodebuild -project mobile/ios/AgentsToZMobile.xcodeproj -scheme AgentsToZMobile -configuration Debug \
  -destination generic/platform=iOS -derivedDataPath <dir> -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<team> AGENTSTOZ_APP_BUNDLE_ID=com.intenet.agentstoz.workspacetest \
  "AGENTSTOZ_DISPLAY_NAME=AgentsToZ Test" AGENTSTOZ_RELEASE_CHANNEL=ui-test CODE_SIGN_ENTITLEMENTS= build
# 템플릿: <dir>/Build/Products/Debug-iphoneos/AgentsToZMobile.app
```

`check-ui.py --device`도 같은 이유로 `CODE_SIGN_ENTITLEMENTS=`를 넘긴다. 실기기 XCUITest는 iOS 시스템 경고(계정 암호 요청 등)가 떠 있으면 키보드 초점을 잃어 실패한다 — 그 경고는 사람이 닫는다.

실기기 모드는 임시 QR·가짜 프로젝트/CLI를 사용하고, 자체 테스트 bundle만 설치·종료·제거합니다. 카메라 스캔을 가정한 주소 입력 이후 경로이며 실제 카메라 권한 검증을 대신하지 않습니다. 무료 개발 프로필의 설치 앱 한도 때문에 격리 bundle이 거부되면 기존 앱을 지우지 않고 실패합니다.

## iPhone 빌드와 남은 검증

`AgentsToZMobile.xcodeproj`의 `AgentsToZMobile` scheme을 엽니다. 앱 번들 ID는 build setting `AGENTSTOZ_APP_BUNDLE_ID`(기본 `com.intenet.agentstoz.mobile`)에서 옵니다 — 앱 target만 바꾸므로 UI 시험 러너(`…mobile.uitests`)와 겹치지 않습니다. Signing & Capabilities에서 배포자의 팀·번들 ID 등록·provisioning을 확인해야 합니다. Xcode 프로젝트에는 팀·인증서를 강제하지 않았고, USB 스크립트만 아래 기본 팀을 **선호**합니다.

```sh
xcodebuild -project mobile/ios/AgentsToZMobile.xcodeproj \
  -scheme AgentsToZMobile -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath mobile/ios/build/WorkroomDerivedData \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES build
```

실기기에서 카메라 허용/거부, LAN 접근 허용/거부, QR 만료·소비·취소, Mac 종료·네트워크 단절, 터미널 키보드·회전, OS background/복귀, 새 QR 재연결, 인터넷 QR의 실제 브라우저 로그인/SAS 승인을 확인해야 합니다. 시뮬레이터 성공은 이 권한·인터넷 로그인 검증을 대신하지 않습니다.

앱은 기존 AgentsToZ 로고의 1024×1024 RGB AppIcon, 앱 전용 UserDefaults 사용 사유만 선언한 개인정보 매니페스트와 비면제 암호화를 사용하지 않는다는 번들 선언을 포함합니다. 데이터 수집 항목은 아직 빈 배열로 확정하지 않았습니다. TestFlight 전에 실제 웹 포털·Supabase·relay 흐름을 포함한 개인정보 처리방침과 App Store Connect 개인정보 답변, App Store Connect 레코드와 배포용 서명 archive를 확인해야 합니다. Mac Developer ID 서명은 iOS provisioning이나 배포 가능한 IPA를 대신하지 않습니다.

연결된 본인 iPhone의 기존 개발 앱을 데이터 보존형으로 업데이트할 때는 기기 ID를 명시합니다. 이 명령은 Git에 커밋된 iOS 소스만 허용합니다. 서명 팀은 `--team <team-id>` → 설치된 Apple Development 팀이 하나면 그 팀 → 여러 개면 **TestFlight 팀 `DA8QKAQ2C9`**(`signingTeam.ts`의 `DEFAULT_IOS_DEVELOPMENT_TEAM`, 그 팀 인증서가 설치돼 있을 때만) 순으로 정하고, 셋 다 아니면 설치된 팀 목록과 함께 실패합니다. 이 Mac에는 팀이 둘 있어 예전에는 `--team` 없이 바로 실패했습니다. 판정만 보려면 `bun mobile/ios/scripts/signingTeam.ts`(읽기 전용). 공통 제품 버전과 UTC 시각 기반 고유 build ID·소스 commit을 앱 정보 화면에 기록한 뒤 `com.intenet.agentstoz.mobile.dev`만 덮어쓰고 실행합니다.

```sh
bun run install:ios:development -- --device '<connected-device-id>'
```

## 사진 공유 → VOC (Share Extension)

앱에는 Share Extension `AgentsToZShare.appex`(표시 이름 「AgentsToZ VOC」, 번들 `$(AGENTSTOZ_APP_BUNDLE_ID).share`)가 들어 있습니다. 사진 앱에서 이미지 1~5장을 공유하면 긴 변 2400px·JPEG 0.85로 다시 인코딩해(메타데이터 제거, 합계 12MB 이하) App Group `group.$(AGENTSTOZ_APP_BUNDLE_ID)`의 `voc-outbox/<uuid>/`에 원자적으로 저장만 합니다. 확장은 **아무것도 전송하지 않고 앱을 열지도 않습니다** — relay 키와 포털 로그인은 앱의 WKWebView 저장소에만 있습니다. 앱이 앞으로 오고 포털 페이지(번들 포털 또는 HTTPS 포털)가 `agentstozVocShare`로 `ready`를 보내면 `agentstoz-voc-share` 이벤트로 한 건씩 넘기고, `ack`를 받은 항목만 지웁니다. 포털 페이지는 항목을 「보내지 않은 캡처」(페이지 origin의 IndexedDB)에 먼저 담은 뒤에만 ack하므로, 작성 화면을 보내지 않고 닫아도 사진은 휴대폰에 남고 「VOC」 화면에서 이어서 보내거나 삭제할 수 있습니다. 30초 안에 ack가 없으면 다음 foreground까지 보존합니다. 최대 10건, 7일이 지나면 만료됩니다. 형식의 정본은 `AgentsToZCore/VocShareOutbox.swift`입니다.

**처음 서명할 때:** App Group ID는 `-allowProvisioningUpdates`로 자동 등록되지 않습니다. Xcode Signing & Capabilities에서 `group.<앱 번들 ID>`를 한 번 추가하거나 개발자 계정에서 등록해 앱·`.share` App ID에 지정해야 기기 빌드가 됩니다. USB 설치 스크립트는 이제 `PRODUCT_BUNDLE_IDENTIFIER`가 아니라 `AGENTSTOZ_APP_BUNDLE_ID`를 넘깁니다 — 전역 번들 ID는 확장까지 앱과 같은 ID로 바꿔 embed가 실패합니다. 구조 검사: `bun test --cwd mobile/ios/scripts/tests --max-concurrency=1`.

## 계정 없이 archive 준비하기

```sh
bun test --cwd mobile/ios/scripts/tests --max-concurrency=1 release-readiness.test.ts
./node_modules/.bin/tsc --noEmit -p mobile/ios/tsconfig.json
bun mobile/ios/scripts/archive-unsigned.ts
bun mobile/ios/scripts/verify-archive.ts <출력된-UNSIGNED.xcarchive>
```

새 `build/unsigned-archives/rehearsal-*/` 폴더에 실제 iPhone용 Release archive·로그·준비 상태 JSON을 만듭니다. 서명·프로비저닝 갱신·설치·업로드는 실행하지 않습니다. `archiveValid=true`는 기기용 arm64/IOS 바이너리와 archive 형식이 맞는다는 뜻이며 **무서명 archive는 설치하거나 TestFlight로 배포할 수 없습니다.** `testFlightReady`와 `distributable`은 항상 false입니다.

현재 개인정보처리방침의 실제 URL·앱내 접근, App Store Connect 개인정보 답변, Apple 팀·배포 provisioning·App Store Connect, 실기기 검증은 별도 gate입니다. 정책 URL을 임의로 만들지 않습니다. `scripts/ExportOptions.app-store-connect.plist.template`은 실제 팀이 미설정인 검토용 템플릿이며 자동 실행하지 않습니다. 서명된 archive가 준비된 뒤 허가된 계정으로만 별도 적용합니다.

iOS의 기본 marketing/build version은 `build-number.json`의 AgentsToZ 제품 버전과 함께 갱신됩니다. USB 개발 빌드는 배포 build와 구분되는 UTC 시각 기반 build ID를 사용합니다. App Store Connect 업로드 전에는 서버에 이미 올라간 build ID와 중복되지 않는지 다시 확인해야 합니다. 자세한 준비 범위와 계정·실물 단계는 [배포 준비 설계](../../docs/design/native-mobile-testflight.md)를 따릅니다.
