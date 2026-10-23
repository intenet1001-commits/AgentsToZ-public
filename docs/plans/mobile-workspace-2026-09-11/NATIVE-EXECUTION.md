# 네이티브 작업 공간 실행·인계

2026-09-11. 기준은 웹·Mac v438 소스 `edf7e5d790f56113e0cd2889f1573eef5eb34c84` 이후의 이 변경이다. iOS 앱 자체 버전은 0.1.0 (1)이며 Mac 빌드 번호와 별개다. 실행 기록의 `sources` SHA-256이 실제 컴파일한 WK 컨테이너·fixture·코어·LAN 페이지를 식별한다. 인계 시 이 문서가 포함된 커밋 SHA를 함께 전달한다.

## 반영

- 첫 진입은 개인 작업 공간을 중심으로 안내한다. 포털의 HTTPS 기본 주소, `/portal.html`, `/remote/`를 입력하면 공통 다섯 탭을 연다. 스캔 QR의 엄격한 검증은 유지한다.
- 프로젝트 현황과 공통 북마크를 보기 위한 계정 로그인과 원격 실행 기기 승인을 구분한다. 포털 주소를 소스에 하드코딩하지 않는다.
- 작업 화면 위에 상시 펼쳐지던 연결 설명을 연결 설정 시트로 옮겼다. 시트 완료/닫기는 같은 WKWebView와 연결을 유지한다. 연결 정보 삭제는 별도 확인 후 실행한다.
- 기존 LAN 직접 연결과 영구 origin 저장소, 시스템 Google 인증 브리지, 백그라운드 유지 및 재시작 복원을 재사용한다.
- 온보딩 smoke도 고유한 일회용 simulator를 생성·정리한다. 기존 사용자의 simulator를 선택·종료하거나 앱을 설치하지 않는다.

## 이 Mac에서 확인한 것

Xcode 26.6 (17F113), iOS 26.5 (23F77), iPhone 17 Pro simulator. 설계 당시의 ‘시뮬레이터가 없음’ 조건은 현재와 다르다. 아래는 실제 실행 결과이며 실기기 검증은 아니다.

| 검증 | 근거와 범위 |
|---|---|
| Foundation + 실제 URLSession/Bun | `bun run test:ios`: 11 회귀 그룹, QR·조회·확인된 동작·명시 종료·새 QR 없는 복구·외부 redirect 거부·응답 없는 요청 취소 통과 |
| iOS 앱 빌드 | generic iOS Simulator, Debug, ad-hoc 서명 빌드 성공. 운영 서명·TestFlight 배포가 아님 |
| 최초 실행 | 자체 simulator에 빌드 앱 설치·실행·프로세스 생존 및 온보딩 화면 캡처 |
| 실제 WK + LAN/PTY | 가짜 프로젝트·CLI만 사용하는 실제 Bun/WS/PTY. 중복 시작·입력·종료 방지, 기억 초안 비실행, 입력 보존, 프로젝트/에이전트 선택, opt-in, 기존 터미널 복원, 권한 회수, 외부 탐색 차단 통과 |
| 실제 WK + HTTPS 포털 | 익명 상태의 배포 웹 사용. 5개 탭에서 같은 WK 객체, 네이티브 인증 브리지 준비, 테마 메뉴 바깥 pointerdown 후 닫기와 탭 이동, 북마크에 기기 컨트롤 없음, 가로 넘침 없음, Settings 왕복 및 WK 재생성 후 QR 없는 재진입 통과 |

포털 메뉴 시험은 실제 WK DOM에 합성 pointer/click을 전달한 검사다. 실제 손가락 터치와 VoiceOver 검증을 대신하지 않는다. ‘cold 재진입’은 동일 origin으로 WK 객체를 재생성한 검사이며 OS 강제 종료/메모리 압박의 모든 조건을 재현한 것은 아니다. 로그인 브리지 준비는 실제 사용자 Google 로그인 완료를 의미하지 않는다.

### 전체 검사에서 발견한 별도 HTTP 회귀

두 차례 전체 검사에서 기존 `prompt-guide-http.test.ts`의 1 MiB 경계 시험이 5초에 실패했다. 저장/413 거절 뒤의 `guides/list`가 대기하는 구간이며, 단독 실행은 통과했다. 과대 본문을 읽기 전에 거절한 연결을 재사용하지 않도록 413/408 응답에 `Connection: close`를 지정했다. 기존 경계 시험에 과대 요청 거절 → 저장 revision 조회를 8회 추가했고 단독 9개 시험이 통과했다. 제한 시간을 늘리거나 시험을 제외하지 않았다. 이 변경은 iOS UI와 별개의 로컬 API 수정이다.

최종 `DEVELOPER_DIR=/Library/Developer/CommandLineTools bun run verify`는 TypeScript 오류 0, Bun 4,069 pass / 0 fail, Rust 56 pass / 0 fail로 통과했다. 전체 실행에서도 해당 1 MiB 회귀는 약 62ms에 통과했다. iOS script TypeScript 검사도 통과했다. 이 세션에서는 iOS simulator 빌드를 만들었으며 설치 Mac v438의 재빌드·교체나 웹 재배포는 하지 않았다.

## 재현 명령과 증거

```sh
bun run test:ios
./node_modules/.bin/tsc --noEmit -p mobile/ios/tsconfig.json
xcodebuild -project mobile/ios/AgentsToZMobile.xcodeproj \
  -scheme AgentsToZMobile -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath mobile/ios/build/DerivedData \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES build
python3 mobile/ios/scripts/simulator-smoke.py
bun mobile/ios/scripts/check-workroom.ts
```

마지막 명령은 사설 IPv4가 필요하다. 공인/wildcard 대체는 없다. 실제 포털의 익명 smoke를 추가할 때만 로컬 환경 변수 `AGENTSTOZ_IOS_PORTAL_URL`에 본인 HTTPS origin을 넣어 실행한다. 주소·운영 계정·토큰·대화 원문을 fixture 소스나 공개 문서에 넣지 않는다. 기본 실행은 운영 포털에 접근하지 않는다.

- `mobile/ios/build/evidence/`: 온보딩 캡처·실행 결과. 첫 부팅 시스템 알림이 캡처 위에 잠시 표시될 수 있다.
- `mobile/ios/build/workroom-evidence/`: `result.json`, `run-status.json`, `workroom.png`, `resumed.png`, 선택적 `portal.png`. 결과의 `anonymousPortal`과 `actualIPhone`으로 실행 표면을 구분한다. 폴더는 Git에 넣지 않는다.
- `native-ios.yml`: 이제 아래 XCUITest의 기본 실행을 수행한다. LAN/PTY 및 선택적 HTTPS 시험은 로컬에서 따로 실행한다. CI 완료를 해당 시험의 성공으로 해석하지 않는다.

## 후속: 실제 컨트롤과 앱 프로세스 재실행

Mac v439 소스 `92b4bfb` 이후, 같은 iPhone 17 Pro / iOS 26.5 simulator에서 `check-ui.py`를 추가 실행했다. 개인 포털을 지정한 실행은 **2 pass / 0 fail / 0 skipped**다. 운영 계정 로그인과 호스트 연결은 하지 않았다.

- XCUITest의 한글 문자열 입력과 잘못된 주소 거절. 실제 한글 키보드 조합·받침 편집과는 구분한다.
- 네이티브 연결 설정 열기 → 연결 삭제 확인 → 취소 → 완료 후 기존 작업 화면 유지.
- 다섯 탭을 직접 누르기, 테마 메뉴를 연 뒤 북마크를 한 번 눌러 메뉴 닫힘과 북마크 제목 표시 확인.
- 가로/세로 회전, Home으로 background 전환 후 복귀, 실제 앱 프로세스 terminate/launch 후 QR 없이 같은 개인 포털로 재진입. 이는 익명 포털 origin 복원이며 실제 터미널의 OS 종료 후 복원까지 증명하지 않는다.

첫 시험에서 SwiftUI `confirmationDialog`가 취소 항목 없이 팝오버로 표시되는 것을 확인했다. 명시적 취소가 필요한 연결 정보 삭제에는 `alert`를 사용해 취소/삭제를 함께 표시한다. 이후 시험은 취소로 알림이 닫히고 기존 작업 화면이 계속 조작되는 것까지 통과했다.

검사 구현은 실제 접근성 트리를 따른다. iOS 26의 알림/HTML summary는 같은 이름의 중첩 버튼을 노출할 수 있고, WebKit은 `aria-pressed` 선택지를 Switch로 표시한다. 전체 화면 덮개 아래의 온보딩은 AX 트리에 남으므로 단순 `exists`가 아닌 `isHittable`로 화면 노출을 판정한다.

```sh
python3 mobile/ios/scripts/check-ui.py
# 선택적 익명 포털 시험은 AGENTSTOZ_IOS_PORTAL_URL을 로컬에서 지정한다.
bun mobile/ios/scripts/archive-unsigned.ts
```

기본 UI 실행도 **1 pass / 0 fail / 1 skipped**로 확인했다. 개인 포털 시험의 건너뜀을 통과로 계산하지 않는다. 생성한 xctestrun v1/v2를 사용하며 기존 simulator는 건드리지 않는다. 생성한 simulator와 컴파일 캐시를 제거하고 `mobile/ios/build/ui-evidence/run-*/`에 소스 해시·시험 집계·화면·로그를 남긴다. 선택적 포털 기록에는 개인 주소가 포함될 수 있어 전체 폴더를 공개 업로드하지 않는다.

연결 확인창 수정이 포함된 **iPhone arm64 Release 무서명 archive**도 빌드·검증됐다(`mobile/ios/build/unsigned-archives/rehearsal-DdEJdw/readiness.json`). `archiveValid=true`, `distributable=false`, `testFlightReady=false`이며 실기기 설치본이 아니다. iOS 앱 버전은 여전히 0.1.0 (1), Mac 설치본 439와 웹 438은 이번 네이티브 변경으로 재배포하지 않았다.

실제 iPhone 26.6을 USB에서 감지했으나 확인 당시 페어링이 완료되지 않았고 Xcode 프로젝트의 개발 Team도 미선택이었다. 사용자 계정·팀 및 기기 신뢰 준비가 끝난 뒤 실제 설치, Google 로그인, QR 권한과 네트워크 전환을 이어간다. 기기 이름·식별자·Apple 팀 정보는 공개 실행 기록에 넣지 않는다.

최종 `bun run verify`는 TypeScript 오류 0, **Bun 4,069 pass / 0 fail, Rust 56 pass / 0 fail**로 종료했다. 시뮬레이터 검사와 함께 실행했던 첫 전체 검사에서는 기존 LAN 관리/기억 복구 통합 시험 2개가 기본 5초 제한에 걸렸다. 관련 8개 시험을 따로 실행해 통과를 확인한 뒤 시뮬레이터 없이 전체를 재실행했다(294.63초). 제한 시간·시험 내용·대상 수는 변경하지 않았다. 최종 UI 시험의 소스 해시도 현재 코드와 모두 일치한다.

## 다음 검증 순서와 합격 기준

1. **실제 계정 인증**: 개인 포털에서 Google 로그인 → 앱 복귀 → 같은 문서에서 프로젝트 현황 표시. 취소 후 재시도, 백그라운드 전환, 만료/늦은 callback을 점검한다. 원격 QR 승인은 별도로 진행한다.
2. **실제 iPhone UI**: 한글 키보드·회전·큰 글자·VoiceOver, 연결 설정 열기/닫기/삭제 취소, 테마 메뉴 바깥 터치 후 첫 탭 동작, QR 카메라 허용/거부, 개인 Wi-Fi LAN 권한 허용/거부.
3. **작업 연속성**: Mac에서 시작한 같은 프로젝트·터미널을 이어서 입력한다. 잠금·장시간 background·강제 종료·Wi-Fi↔5G 후 기존 세션을 복원하고 입력·시작·저장을 자동 재전송하지 않는다.
4. **격리 실프로젝트 왕복**: 새 프로젝트/워크트리 → 작업 → 내가 한 말 조회와 초안 가져오기 → 기억 저장(로컬/백업 분리) → Git pull/merge/push → 안전한 워크트리 정리 → Mac에서 동일 결과 확인. 권한이 없는 프로젝트 요청은 거부한다.
5. **대직**: 이미 구성된 방과 공유 자료를 확인하여 켜기/끄기, 새 질문에 실제 답변하는지 검증한다. 운영 대화방 전송 시험에는 사용자가 지정한 방과 범위를 사용한다.

루틴 UI·체크리스트 검증은 medium으로 진행할 수 있다. 인증 복귀·중복 실행·권한 누출처럼 원인이 불명확한 실패가 나오면 그 구간의 reasoning effort를 다시 높여 검토한다. 설정은 사용자가 선택하며 자동 변경하지 않는다.

## 남은 구현·출시 경계

- 기존 LAN 정적 UI 전체의 새 React 홈 통합, 모바일 최초 대직 방/RAG 구성, 기억 영수증 복구 UI, 전체 GitHub PR 심사 UI는 이번 변경으로 완료되지 않는다.
- 운영 Google 로그인·실제 호스트 전체 관리·카카오톡 응답·Windows 호스트 검증은 위 다음 단계에 남아 있다.
- AppIcon·개인정보 처리방침·Apple 팀/프로비저닝·서명 archive·TestFlight는 별도 출시 조건이다. 이번 빌드를 실기기 설치본으로 배포하지 않았다.


## USB 실기기 QR 진단 후속 (2026-09-11)

실제 iPhone의 기존 앱은 다른 개발 팀으로 서명되어 있어 데이터를 보존하고 별도 `AgentsToZ 개발` 번들을 설치했다. 개인 팀·프로비저닝 설정은 로컬 xcconfig에만 둔다. 개발 빌드 0.1.0 (3)의 설치·실행을 확인했다. 이것은 TestFlight 배포가 아니다.

5G에서 QR 스캔 후 실패한 사례는 개발 앱의 저장된 origin이 사설 HTTP LAN 주소였고, Mac에서도 LAN QR 창이 열려 있음을 확인했다. 수정 앱의 실제 iPhone 화면에서 같은 origin 연결이 `NSURLErrorTimedOut (-1001)`로 실패함을 확인했다. 모바일 네트워크가 5G라는 사실만으로 인터넷 QR 사용을 추정하지 않는다.

- LAN QR 확인 단계에서 같은 네트워크 전용임을 알리고, 명시적 취소로 접속 전에 돌아올 수 있다.
- 오류 화면은 실제 origin에 따라 LAN/외부 인터넷 안내와 QR 전환 동작을 표시한다.
- 시간 초과·DNS·접속 실패·보안 연결·페이지 정책·화면 프로세스 종료를 구분한다. QR 비밀이 들어갈 수 있는 NSError 원문·userInfo는 표시하지 않는다.
- 최초 페이지 로딩 실패에는 작업이 전달됐다고 추정하지 않는다. 이미 페이지가 열렸던 연결에서만 작업 재실행 없이 결과를 확인하도록 안내한다.

`bun run test:ios`의 11개 네이티브 회귀 그룹과 실제 Bun 통신 검사가 통과했다. 기본 XCUITest는 1 pass / 0 fail / 1 skipped이며, LAN QR 경고에서 취소할 때 WebView 접속 없이 온보딩을 유지함을 검증했다. 익명 HTTPS 포털 시험은 이번 실행에서 생략했다. 기존 외부 relay 설정으로 새 QR을 표시했으며, 실제 5G Google 로그인·SAS 승인·원격 작업 성공은 별도 확인이 필요하다.


### 실제 Google callback 후속 진단

개발 빌드 4에서 실기기의 로그인 결과가 `callback-rejected;fragment=true;code=true;state=true;error=false`임을 확인했다. 시스템 취소와 callback 거부를 구분하고, 오류의 원문 URL·인증 코드·state 값 없이 고정 분류만 남긴다. Google 로그인 성공 및 PKCE 교환 성공으로 간주하지 않는다.

빌드 5는 값이 없는 trailing `#`만 허용한다. code/state 2개 필드와 원래 state 일치, 고정 callback scheme/host/path는 유지하며 비어 있지 않은 fragment는 계속 거부한다. 원래 실기기 진단은 fragment 존재 여부만 기록했으므로 빈 fragment가 실제 원인이었는지는 재로그인으로 확인해야 한다. 실패가 이어지면 `empty/nonempty/absent` 진단으로 구분한다. 빈 fragment 허용과 bearer token/다른 state/인코딩된 공백 등의 거부 회귀 및 네이티브 통신 검사를 통과했다. 실제 계정 재로그인 결과는 대기 중이다.


### 다른 Mac에서 이어가기

현재 개발 앱 설치본은 0.1.0 (5)다. 공유 프로젝트의 기본 빌드 번호와 개인 설치 시의 override는 별개다. 다른 Mac에서는 최신 main을 Pull하고 Xcode 개발 팀·프로비저닝을 그 Mac에서 설정한다. 개인 xcconfig·인증서·기기 캡처·빌드 결과물은 Git에 포함하지 않는다. 기존 앱과 서명 팀이 다르면 덮어쓰기 위해 기존 앱을 삭제하지 말고 별도 개발 번들을 사용한다.

다음 확인은 빌드 5의 실제 Google 재로그인이다. 성공 시 동일 WK 저장소에서 Supabase 세션 교환, Mac/iPhone SAS 일치 확인 및 연결 승인, 5G 원격 프로젝트 조회 순서로 검증한다. 실패 시 원문 URL을 수집하지 않고 `agentstoz.auth.lastFailure`의 고정 분류와 fragment 종류를 확인한다. 마지막 실패 기록은 과거 기록일 수 있으므로 현재 화면/재시도와 대조한다. 빈 fragment가 아닌 응답을 임의로 허용하거나 state 검증을 제거하지 않는다. 이 단계가 끝나기 전에는 네이티브 외부 원격 작업 완료로 표시하지 않는다.
