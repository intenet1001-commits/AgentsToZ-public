# iPhone USB 실기기 화면별 체크리스트

기준: 제품 빌드 **514** (`build-number.json`, pbxproj `MARKETING_VERSION = 514.0.0`). 체크 결과는
**그 실행의 `result.json`/`run-status.json`의 `sources` 해시가 현재 HEAD의 파일과 같을 때만** 현재
검증으로 인정합니다. 예전 PASS를 지금 결과로 옮겨 적지 마세요 — 실제로 v512 증거가 v514의
워크룸·음성 변경 뒤에도 남아 있었습니다.

범례: **자동** = 아래 스크립트가 실제로 누르고 판정합니다. **사람** = 실기기에서 직접 눌러야 합니다.
**조건** = 외부 조건(개인 포털 주소·Supabase·Mac 쪽 허용)이 있어야 실행됩니다.

## 0. 준비 (한 번)

| 항목 | 방법 |
|---|---|
| 서명 팀 | 이 Mac에는 Apple Development 팀이 둘 있습니다. 스크립트는 `--team`이 없으면 **TestFlight 팀 `DA8QKAQ2C9`** 를 고릅니다(`signingTeam.ts`의 `DEFAULT_IOS_DEVELOPMENT_TEAM`, 그 팀 인증서가 설치돼 있을 때만). 다른 팀은 `--team <id>`. 확인만 하려면 `bun mobile/ios/scripts/signingTeam.ts` (읽기 전용) |
| 기기 ID | `xcrun devicectl list devices` — **USB(wired)** 로 연결되고 Developer Mode가 켜진 기기 |
| 잠금 | XCUITest 동안 iPhone 잠금을 풀어 두고 화면을 켜 둡니다 |

## 1. 실행 명령

```sh
# 자동: 네이티브 코어 + 실제 Bun LAN 서버 왕복 (기기 불필요)
bun run test:ios
swift test --package-path mobile/ios/AgentsToZCore

# 자동: 온보딩 XCUITest — 시뮬레이터(기본) / USB iPhone
python3 mobile/ios/scripts/check-ui.py
python3 mobile/ios/scripts/check-ui.py --device '<device-id>'          # 팀 기본값 사용
python3 mobile/ios/scripts/check-ui.py --device '<device-id>' --plan   # 명령만 출력, 아무것도 실행 안 함
# 조건: 개인 포털 탭 시험까지 — 본인 HTTPS origin을 로컬에서만 지정
AGENTSTOZ_IOS_PORTAL_URL='https://<개인 포털>' python3 mobile/ios/scripts/check-ui.py --device '<device-id>'

# 자동: LAN 워크룸(가짜 프로젝트·CLI) — 시뮬레이터 / 격리 번들 실기기
bun mobile/ios/scripts/check-workroom.ts
bun mobile/ios/scripts/check-workroom.ts --device '<device-id>' '<signed-isolated-app-path>' '<Apple Development signing identity>'

# 사람: 실제 앱으로 손 검증할 개발 빌드 설치 (com.intenet.agentstoz.mobile.dev 덮어쓰기)
bun run install:ios:development -- --device '<device-id>'
```

`check-ui.py --device`는 앱을 **`com.intenet.agentstoz.mobile.uitest`** ("AgentsToZ UI 시험")로 서명해
설치하고, 끝나면 그 앱과 러너(`com.intenet.agentstoz.mobile.uitests.xctrunner`)만 지웁니다. 실제 앱
(`…mobile`, `…mobile.dev`, `…mobile.testflight`)과 그 연결 정보는 건드리지 않습니다. 새 App ID가
처음 쓰일 때 Xcode 자동 서명(`-allowProvisioningUpdates`)이 개발 팀에 등록합니다. 결과는
`mobile/ios/build/ui-device-evidence/run-*/`(`actualIPhone: true`, `gitHead`, `sources`)에 남습니다.
개인 포털을 지정한 실행의 화면·로그에는 주소가 들어가므로 폴더째 공유하지 마세요.

## 2. 화면별

### 첫 화면 — 내 작업 공간 (`RemoteHomeView`)

| 확인 | 판정 |
|---|---|
| 주소 칸(`connectionAddress`)에 한글 문자열 입력, 지원하지 않는 주소 → `connectionNotice` 거절 문구, 버튼 비활성 | **자동** (check-ui test00) |
| 사설 IP LAN 주소 → 「같은 네트워크용 QR입니다」 경고 → 취소 시 WebView 접속 없이 첫 화면 유지 | **자동** (test00) |
| 한글 **키보드 조합·받침 수정** (문자열 주입은 이를 대신하지 않음) | **사람** |
| 「앱 정보」의 `버전 514.0.0 (<UTC build>)`·`빌드 usb-development · <commit 8자리>`가 설치한 빌드와 일치 | **사람** (install:ios:development의 마지막 JSON 출력과 대조) |
| 큰 글자(Dynamic Type)·VoiceOver 읽기 순서 | **사람** |

### QR 스캔 시트 (`QRScannerSheet`)

| 확인 | 판정 |
|---|---|
| 첫 카메라 권한 **허용** → 실제 Mac QR 인식 | **사람** |
| 권한 **거부** → 「카메라를 사용할 수 없습니다」와 주소 직접 입력 안내 | **사람** (설정에서 권한 초기화 후) |
| 이미 쓴 QR·만료된 QR → 새 QR 안내, 기존 연결 유지 | **사람** |

### 개인 포털 작업 공간 (`LANWorkroomView`, HTTPS)

| 확인 | 판정 |
|---|---|
| 「이 개인 포털에 연결할까요?」 → 열기, 홈·프로젝트·원격 작업·북마크·기록 5개 탭 직접 탭 | **자동·조건** (test10, `AGENTSTOZ_IOS_PORTAL_URL`) |
| 연결 설정 시트 열기 → 연결 정보 지우기 → **취소** → 완료 후 같은 화면 유지 | **자동·조건** (test10) |
| 테마 메뉴를 연 채 바깥(북마크) 한 번 탭 → 메뉴 닫힘 + 탭 이동 | **자동·조건** (test10) |
| 가로/세로 회전, Home → 복귀, 앱 프로세스 종료 → 재실행 시 QR 없이 같은 포털 | **자동·조건** (test10) |
| Google 로그인 → 앱 복귀 → 같은 문서에서 프로젝트 현황 표시, 취소 후 재시도 | **사람·조건** (Supabase 정상 + Redirect URL `agentstoz-mobile://auth/callback?state=*`) |
| Mac과 iPhone의 SAS 일치 확인 → 기기 승인 → 5G에서 원격 프로젝트 조회 | **사람·조건** |
| 음성: HTTPS 연결에서 마이크 권한 허용/거부, 화면 잠금 중 오디오 유지 | **사람·조건** (v514의 오디오 세션 변경은 아직 실기기 미검증) |

### 같은 Wi-Fi 워크룸 (`LANWorkroomView`, HTTP)

| 확인 | 판정 |
|---|---|
| 프로젝트·AI 선택, 터미널 허용 전 거부/후 허용, 중복 시작·전송·종료 방지, 실제 출력 | **자동** (check-workroom, 가짜 CLI) |
| 기억 초안 채우기(자동 전송 안 함), 외부 탐색·팝업 차단 | **자동** (check-workroom) |
| background 복귀 후 같은 WKWebView·연결 소유자 유지, 새 연결의 권한 격리 | **자동** (check-workroom) |
| 첫 **로컬 네트워크 권한** 허용/거부 | **사람** |
| 음성 버튼 → HTTPS가 아니라서 거절 문구가 나오는지(LAN에서는 음성 불가가 정상) | **사람** |
| 실제 Mac 프로젝트로 한글 입력·Enter/Esc/Ctrl+C·세션 종료 | **사람** |
| 화면 잠금·장시간 background·Wi-Fi↔5G 전환 후 새 QR 없이 복구, 자동 재전송 없음 | **사람** |
| Mac 종료·네트워크 단절 시 오류 화면의 LAN/인터넷 안내와 「다시 연결」 | **사람** |
| 「연결 해제」 후 Mac 목록에서 이 기기가 사라짐(`session.end`) | **자동** (test:ios·check-workroom) + **사람** (실제 Mac) |

### 사진 공유 → VOC (`ShareExtension` "AgentsToZ VOC", App Group)

처음 한 번: 이 기능은 App Group `group.<앱 번들 ID>`(개발 앱은 `group.com.intenet.agentstoz.mobile.dev`)를 씁니다.
`xcodebuild -allowProvisioningUpdates`는 App ID에 App Groups 기능만 켜고 **그룹 ID 자체는 등록하지 않습니다**
(실측: 「Provisioning profile … doesn't match the entitlements file's value for the com.apple.security.application-groups
entitlement」). Xcode의 Signing & Capabilities → App Groups에서 그 그룹을 한 번 추가하거나 developer.apple.com에서 등록해
앱과 `.share` App ID 둘 다에 지정한 뒤 설치하세요.

| 확인 | 판정 |
|---|---|
| 사진 앱 → 1~5장 선택 → 공유 → 「AgentsToZ VOC」가 보임. 6장 이상·동영상만 선택하면 안 보임 | **사람** |
| 썸네일·「고칠 내용」 입력 → 저장 → 「AgentsToZ 앱을 열면 VOC 작성 화면에 사진이 담겨 있습니다」 후 닫힘. 취소는 아무것도 남기지 않음 | **사람** |
| 연결 전 앱을 열면 첫 화면에 「공유한 사진 N건이 대기 중입니다」 | **사람** (시뮬레이터에서 outbox 항목 1건으로 확인됨) |
| 포털 작업 공간을 열면 VOC 작성 화면에 사진·내용이 담기고, 담긴 뒤 대기 건수가 0 | **사람** — 포털의 `agentstozVocShare` ready/ack 구현이 필요 |
| HEIC·스크린샷(PNG)·큰 사진 5장: 12MB를 넘으면 줄이거나 제외한다는 안내 | **사람** |

## 3. 자동으로 아직 못 하는 것

- XCUITest는 2개뿐입니다(test00 온보딩, test10 포털 — 포털 주소가 없으면 skip). 개인 포털 없이
  돌리면 **1 pass / 1 skipped** 가 정상이며, skip을 통과로 세지 않습니다.
- 카메라 QR 스캔, OS 권한 대화상자, Google 로그인, SAS 승인, 음성, 키보드 조합, VoiceOver는
  XCUITest가 없습니다. 위 **사람** 항목은 매 빌드마다 직접 눌러야 합니다.
- 이 체크리스트의 명령은 어느 것도 TestFlight 업로드나 실제 앱 교체를 하지 않습니다
  (`install:ios:development`는 개발 번들만 덮어씁니다).
