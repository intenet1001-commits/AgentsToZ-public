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
```

`test:ios`는 동일 Swift 코어를 컴파일해 주소·탐색 경계 회귀를 실행하고, 임시 Bun LAN 서버와 실제 URLSessionWebSocketTask의 QR·목록·확인된 동작·명시적 종료(`session.end`)·**새 QR 없는 세션 복구**·리다이렉트 거부·요청 취소를 검증합니다. `swift test --package-path mobile/ios/AgentsToZCore`로 같은 회귀를 XCTest에서도 실행할 수 있습니다.

⚠️ **`bun run verify`는 이 앱을 건드리지 않습니다.** 실측(2026-09-10): Mac 쪽에서 「소켓 종료 ≠ 세션 종료」로 계약을 바꾼 뒤 `test:ios`가 깨져 있었는데 verify는 4,011건 전부 통과했습니다. 원격제어 계약(`remoteControlCore.ts`·`remoteControlLanServer.ts`·`remoteControlMobilePage.ts`)을 건드렸다면 `bun run test:ios`를 따로 돌리세요. CI에서는 `verify.yml`의 `native-ios` job이 push마다 `swift test`와 무서명 iPhone 빌드를 강제합니다. `native-ios.yml` 수동 workflow는 XCUITest로 빌드·온보딩 입력/주소 거절을 검사하며 개인 포털 시험은 명시적으로 skipped로 남깁니다. 실제 LAN/PTY가 필요한 `check-workroom.ts`와 `check-native.ts`는 사설 IPv4가 있는 단말에서 위 명령으로 별도 실행해야 합니다.

`check-ui.py`는 별도의 빈 simulator에서 프로덕션 앱을 XCUITest로 조작합니다. 기본 실행은 한글 문자열 입력·잘못된 주소 거절 1개 시험을 실행하고 개인 포털 시험 1개를 건너뜁니다. 선택적으로 `AGENTSTOZ_IOS_PORTAL_URL`에 본인 HTTPS origin을 로컬에서만 지정하면 익명 포털의 탭, 연결 설정 열기/완료/삭제 취소, 테마 메뉴 바깥 탭, 회전, background 복귀와 실제 앱 프로세스 종료/재실행을 추가 검사합니다. Google 로그인이나 실제 호스트 연결·작업은 실행하지 않습니다. 한글 문자열 주입은 한글 키보드 조합·받침 편집 검증을 대신하지 않습니다.

러너는 Xcode가 생성한 xctestrun v1/v2를 읽고 통과·실패·건너뜀 수를 각각 판정합니다. 만든 simulator와 컴파일 캐시는 정리하며 결과·화면·로그는 `mobile/ios/build/ui-evidence/run-*/`에 남깁니다. 선택적 포털 실행의 화면/로그에는 개인 주소가 포함될 수 있으므로 해당 폴더 전체를 공개 업로드하지 마세요. CI에는 개인 주소나 계정을 넣지 않습니다.

`check-workroom.ts`는 **고유한 일회용 iPhone 시뮬레이터**와 테스트 앱을 만듭니다. 프로덕션 `LANWorkroomView.swift`와 실제 Mac LAN HTML·JS·CSP·WebSocket·PTY를 사용하고, 임시 등록 프로젝트와 네트워크를 쓰지 않는 가짜 CLI만 실행합니다. 프로젝트·AI 선택, opt-in 전 거부/후 허용, 중복 시작·전송·종료, 실제 출력, 기억 초안 보존/비실행, 외부 탐색·팝업 차단, background 복귀 후 동일 WKWebView·연결 소유자·Mac 작업 유지, 새 연결의 권한 격리를 확인합니다. 일회용 시뮬레이터에서 Settings를 전면에 열고 복귀해 실제 SwiftUI background hook도 검사합니다. 실제 iPhone의 카메라·LAN 권한 동작은 아래 실기기 항목으로 구분합니다.

테스트 서버는 운영 중인 포트 3001과 실제 앱 데이터를 사용하지 않습니다. 사설 IPv4 인터페이스가 없으면 실패하며 공인 IP나 wildcard로 대체하지 않습니다. 테스트 QR은 임시 파일/stdin으로만 전달합니다. own listener·가짜 PTY·시뮬레이터·임시 토큰은 finally에서 제거하고, 비밀이 없는 결과·화면은 `mobile/ios/build/workroom-evidence/`에 남깁니다. 다른 시뮬레이터는 종료하거나 앱을 설치하지 않습니다.

실기기 격리 fixture도 같은 runner로 실행할 수 있습니다. 서명된 템플릿의 bundle ID는 반드시 `com.intenet.agentstoz.workspacetest`여야 합니다. 다른 앱으로 재서명하거나 기존 앱을 삭제하지 않습니다.

```sh
bun mobile/ios/scripts/check-workroom.ts --device '<device-id>' '<signed-isolated-app-path>' '<Apple Development signing identity>'
```

실기기 모드는 임시 QR·가짜 프로젝트/CLI를 사용하고, 자체 테스트 bundle만 설치·종료·제거합니다. 카메라 스캔을 가정한 주소 입력 이후 경로이며 실제 카메라 권한 검증을 대신하지 않습니다. 무료 개발 프로필의 설치 앱 한도 때문에 격리 bundle이 거부되면 기존 앱을 지우지 않고 실패합니다.

## iPhone 빌드와 남은 검증

`AgentsToZMobile.xcodeproj`의 `AgentsToZMobile` scheme을 엽니다. 번들 ID 기본값은 `com.intenet.agentstoz.mobile`입니다. Signing & Capabilities에서 배포자의 팀·번들 ID 등록·provisioning을 확인해야 합니다. 팀·인증서를 소스에 강제하지 않았습니다.

```sh
xcodebuild -project mobile/ios/AgentsToZMobile.xcodeproj \
  -scheme AgentsToZMobile -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath mobile/ios/build/WorkroomDerivedData \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES build
```

실기기에서 카메라 허용/거부, LAN 접근 허용/거부, QR 만료·소비·취소, Mac 종료·네트워크 단절, 터미널 키보드·회전, OS background/복귀, 새 QR 재연결, 인터넷 QR의 실제 브라우저 로그인/SAS 승인을 확인해야 합니다. 시뮬레이터 성공은 이 권한·인터넷 로그인 검증을 대신하지 않습니다.

앱은 기존 AgentsToZ 로고의 1024×1024 RGB AppIcon, 앱 전용 UserDefaults 사용 사유만 선언한 개인정보 매니페스트와 비면제 암호화를 사용하지 않는다는 번들 선언을 포함합니다. 데이터 수집 항목은 아직 빈 배열로 확정하지 않았습니다. TestFlight 전에 실제 웹 포털·Supabase·relay 흐름을 포함한 개인정보 처리방침과 App Store Connect 개인정보 답변, App Store Connect 레코드와 배포용 서명 archive를 확인해야 합니다. Mac Developer ID 서명은 iOS provisioning이나 배포 가능한 IPA를 대신하지 않습니다.

연결된 본인 iPhone의 기존 개발 앱을 데이터 보존형으로 업데이트할 때는 기기 ID를 명시합니다. 이 명령은 Git에 커밋된 iOS 소스만 허용하고, 설치된 Apple Development 서명 신원이 한 팀이면 Team ID를 자동 판별합니다. 공통 제품 버전과 UTC 시각 기반 고유 build ID·소스 commit을 앱 정보 화면에 기록한 뒤 `com.intenet.agentstoz.mobile.dev`만 덮어쓰고 실행합니다. 개발 팀이 여러 개면 `--team <team-id>`를 함께 지정합니다.

```sh
bun run install:ios:development -- --device '<connected-device-id>'
```

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
