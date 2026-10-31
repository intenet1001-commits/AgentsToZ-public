# 원격 제어 — LAN(같은 Wi‑Fi) 재바인딩 · 소켓 · 세션 복구

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 네이티브 Screen: 근거리 기본과 선택형 인터넷 연결 (2026-10-26)

사용자가 같은 공유기 없이 근거리 연결을 기본으로 하고 LTE 원격도 구현하도록 승인했다.
기존 Screen 단계 1의 승인 공유기 전용 제약은 이 네이티브 화면 경로에서 대체된다.
웹 워크룸 LAN의 bind/복원 정책은 별도이며 아래 설명 그대로다.
설계와 검증 경계는 `docs/design/screen-control-2026-10-24/NEARBY-INTERNET.md`를 따른다.
Mac이 Mac을 보는 **Mac 컨트롤러**(AgentsToZ Viewer, 폰 중개 등록·대상 Mac 승인, 1단계 근거리만)는
`docs/design/mac-to-mac-2026-10-29/DESIGN.md`를 따른다 — 등록 QR v3·별도 키체인 항목 `controllers`·캡처의 Viewer 제외가 거기서 정해졌다.

- `ScreenNearby`는 `_atzscreen._tcp` 서비스 endpoint + `includePeerToPeer`를 사용하며 특정 Wi-Fi/IP에 묶지 않는다.
- QR v2는 근거리 서비스와 선택적 WSS 경로를 담는다. 기존 v1 QR·저장 Mac은 읽으며, 새 경로를 쓰려면 새 QR로 등록한다.
- 인터넷은 Mac의 별도 Touch ID 활성화 + wss/443 + 정상 TLS 검증이다. relay 입장은 화면 인증이 아니다.
- **화면에서는 WSS 중계를 접어 둔다(2026-11-01).** 배포된 중계 서버가 없고 밖에서는 Cloudflare 사설망이 같은 52741
  리스너로 닿으므로, Mac 상태 창의 칸 제목은 「연결 — 근거리·인터넷(Cloudflare)」이고 중계 주소 칸·켜기 버튼은 기본으로 접힌
  「고급 · 자체 중계 서버」 안에 있다. 중계를 저장한 Mac은 자동으로 펼쳐지고 접어도 제목에 「설정됨」이 붙는다. 메뉴 막대의
  중계 상태 줄(「자체 중계: …」)도 중계가 저장된 때만 보인다. 휴대폰 경로 선택지는 「자체 중계 서버」로 이름만 바꿨다.
  중계 코드·프로토콜·QR v2 필드는 그대로다 — 지우지 말 것.
- 모든 경로에서 App Attest/QR/SAS 등록, 고정 Mac 키, 매 연결 생체 서명, AES-GCM을 유지한다.
  경로를 열 때만 fallback하고 인증을 보낸 뒤에는 재전송하지 않는다.
- iPad 캡처에서 실제 상태는 Wi-Fi **켜짐 / 연결 안 됨**, LTE였다. 초기 사용자 설명만으로 같은 Wi-Fi라고 단정하지 않는다.
- `URLSessionWebSocketTask.maximumMessageSize`를 처음 16 KiB로 주고 나중에 올리자 macOS 26 실제 소켓 검사에서
  128 KiB 영상이 EMSGSIZE로 실패했다. 초기 버퍼는 고정 8 MiB+25로 제한하고, `receive`는 인증 전 1 KiB/
  등록 16 KiB/인증 뒤 레코드 한도를 별도로 검사한다. 서버에도 별도 인증 전·방·IP·쓰기 예산을 둔다.
- 내장 포털 누락은 앱 설치 산출물로 허용하지 않는다. `copy-bundled-portal.sh`가 필수 문서와 자산을 확인해 실패하고,
  공식 로컬 빌드/무서명 리허설/UI 러너가 먼저 실제 포털을 빌드한다. 기존 불완전 빌드에는 복구 안내를 보인다.

## iPad 작업 홈과 Touch ID 연결을 따로 확인한다 (2026-10-26)

1517.0.4의 USB iPad Air 5 캡처에서는 앱이 충돌한 것이 아니라 개인 작업 공간 미설정 상태의
네이티브 첫 화면이었다. Mac의 **공개** Supabase 설정만 든 `agentstoz://connect#…` 링크를
전달하고 사용자가 적용하자 내장 작업 홈과 탭이 열렸다. 사용자가 홈 진입을 확인했으며,
1517.0.5 업데이트 뒤에도 저장된 작업 홈이 복원되는 것을 캡처했다. 이것이 로그인·모든 데이터
조회나 Mac 제어 성공을 증명하는 것은 아니다.

- Mac 화면 등록 QR은 화면 제어 기기를 등록할 뿐 작업 공간 설정을 넣지 않는다. 첫 실행의
  주 동작은 「프로젝트·워크룸 연결 QR 스캔」, 데이터 전용 폰 연결 링크는 접지 않고 표시한다.
  작업 공간 스캐너는 화면 등록 QR을 설명과 함께 거절한다. 화면 등록은 별도 「Mac 화면」에서 한다.
  저장된 작업 공간이 있으면 처음 시작 안내 대신 저장본·다른 연결 동작을 표시한다.
- 일반 폰 등록은 목적을 검증한 `deviceRegistrationText`로 v1/v2만 받고 Mac 컨트롤러용 v3 QR은
  스캐너·전달 경로에서 거절한다. 등록 버튼도 키 생성·App Attest·연결 직전에 다시 검사한다.
  범용 파서와 별도 중개 경로의 v3 지원은 유지하며 실제 카메라와 Mac 간 연결은 별도 검사다.
- 새 Mac 호스트 1517.0.4를 실제 설치·실행한 뒤, 같은 공유기에 연결되지 않은 iPad에서
  QR v2의 SAS와 Mac의 iPad 등록 완료(1대)를 확인했다. 등록 성공과 화면 스트리밍 성공은 별개다.
- 그 다음 iPad에서 Touch ID 후 모든 `LAError`를 Face ID 실패로 표시하는 문제가 관찰됐다.
  Face ID 종류만 허용하는 분기는 없었다. 원래 오류의 정확한 코드는 포착하지 못했으므로
  키 재개설·승인 수명 중 어느 것이 실기 원인인지 단정하지 않는다.
- 1517.0.5는 일반 LA 정책 승인 대신 `.privateKeyUsage + .biometryCurrentSet`으로 보호된
  실제 SE 키에 새 LAContext를 결속하고, 독립 도메인과 자체 생성 32-byte 난수의 로컬 probe를
  서명해 그 키 사용을 승인한다. probe 결과는 폐기하며 네트워크·저장소에 내보내지 않는다.
  동일한 불변 키 참조와 context를 보관하고 이후 interaction을 금지한다. `Once`는 handshake의
  transcript 서명 1회를 제한한다(로컬 probe는 별도). 사용 후·폐기 시 context를 무효화한다.
  암호 대체 금지는 키의 `.biometryCurrentSet` ACL이 유지하며, 기기 잠금 해제 인증의 재사용 창을 늘리지 않는다.
- UI는 실제 Touch ID/Face ID 호칭을 사용하고 lockout·미등록·비대화형/무효 context 오류를
  구분한다. ACL 없는 SE 키의 자동 검사는 참조 수명과 1회성만 검증한다. 생체 ACL의 실제
  승인 지속성과 영상·입력은 물리 iPad의 후속 검사이며 자동 검사 통과로 대체하지 않는다.
- 1517.0.5의 실제 USB 디버깅에서 `com.apple.LocalAuthentication`, code **-8**
  (`biometryLockout`)을 두 번 확인했다. 따라서 이 시도의 확정 원인은 OS 생체 잠김이며,
  키 참조 수정으로 해결됐다고 주장하지 않는다. 사용자가 기기 암호로 iPad 잠금을 해제한
  뒤 앱 연결에서 다시 생체 인증해야 한다. 앱 연결을 passcode 인증으로 대체하지 않는다.
  Mac은 별도로 화면 기록·손쉬운 사용 권한이 필요하며 당시 시스템 설정의 잠금 해제 창에서
  사람이 Mac 암호를 입력해야 하는 상태였다.
- 사용자는 기기 잠금 해제 뒤에도 -8이라고 보고했다. 1517.0.6은 오류 화면에 명시적
  「Touch ID/Face ID 잠김 해제」 동작을 제공한다. Apple의 lockout 복구 권고에 따라
  별도 LAContext에서 `.deviceOwnerAuthentication`을 평가하고 반드시 폐기한다. 이 함수는
  **Void**이며 키·승인·서명자를 접근하거나 반환하지 않는다. 복구 성공도 `ended` 상태와
  실패한 연결의 무효화된 gate를 그대로 두고 `lastApproval = .failed`를 유지한다.
  사용자가 닫고 Mac을 다시 선택해야 새 생체 ACL 승인·handshake가 시작된다.
  물리 iPad에서 사용자가 복구 완료 안내를 확인했으며, 새 지문 연결·영상/입력 결과는 별도다.
  `testLockoutRecoveryDoesNotReviveAFailedConnection`은 OS 복구 프롬프트의 inactive 전이와
  복구 뒤에도 이전 연결을 재개하지 않는 실제 lifecycle/gate 상태 전이를 검증한다.
  Mac의 화면 기록·손쉬운 사용 설정은 사용자 승인 뒤 호스트 재시작을 거쳐 둘 다 true,
  power on인 상태까지 확인했다.

- 1517.0.6의 복구 완료 안내 뒤에도 새 `LAContext.canEvaluatePolicy`가 **키 접근 없이**
  false / Touch ID / `com.apple.LocalAuthentication -8`을 반환했고, 사용자는 기기 잠금 화면도
  지문으로 열리지 않는다고 확인했다. 사용자가 지문을 다시 등록하자 같은 비대화형 검사가 true로
  바뀌었다. 새 QR로 등록한 뒤 실제 protected-key 승인과 Mac handshake 완료를 디버거에서 확인했고,
  사용자가 Mac 영상 표시를 확인했다. 이 결과를 이전 버전의 미포착 원인이나 원격 입력 성공과 섞지 않는다.
- 1517.0.7은 owner 인증 성공 뒤 별도 새 context에서 생체 사용 가능 여부도 확인해야 복구 성공을
  표시한다. 취소·실패·여전한 -8은 성공이 아니며, 복구 context를 Mac 승인에 쓰지 않는다.
  `testLockoutRecoveryRequiresAvailableBiometry`는 owner 성공 + 생체 -8, owner 실패, 취소와 정상
  사용 가능을 구분한다. 지문 변경 뒤 키의 `.biometryCurrentSet` 결속 때문에 새 QR 등록이 필요하다.
- 1517.0.7은 첫 영상 연결 때 조작법을 열고 다시 여는 버튼, 이름이 있는 텍스트 입력 버튼과
  입력 순서 안내, 별도의 네 방향 스크롤 버튼을 제공한다. 기존 터치/트랙패드·두 손가락 제스처도 유지한다.
- 직접 실기 검사는 `UITests/PhysicalScreenControls.swift`를 별도 시험 프로젝트에 넣어 실행한다.
  기본 onboarding 시험 대상에는 넣지 않는다. `scripts/ScreenControlFixture.swift`는 프로젝트·계정·
  클립보드·네트워크 없이 Mac의 클릭/글자/스크롤을 독립 기록하는 전용 창이다. 실제 사람이 Touch ID를
  승인하고, Mac fixture 영상과 활성 연결을 먼저 확인한 뒤 그 창에만 시험 입력을 보낸다.
  **XCTest 탭 성공은 전달 성공이 아니다.** Mac receipt의 클릭 증가·정확한 한글 문자열·양축 좌표 변화가
  함께 있어야 입력이 통과한다. 테스트 준비 중 실제 10분 유휴 종료도 관찰했으며 이를 늘려 피하지 않는다.
- 손가락 탭과 마우스 우클릭 recognizer를 함께 둘 때 `buttonMaskRequired = .secondary`만으로
  손가락을 제외할 수 없다. Apple SDK `UITapGestureRecognizer.h`는 이 속성을 **간접 입력에서만**
  평가한다고 명시한다. 수정 전 실제 UIKit 시험에서 한 손가락 탭이 `left=0 right=1`을 만들었다.
  1517.0.9는 우클릭 recognizer의 `allowedTouchTypes`를 `.indirectPointer`로 제한한다.
  `check-ui.py --screen-gestures`는 별도 진입점의 빈 simulator에서 실제 production SurfaceView의
  한 손가락 좌클릭·두 손가락 우클릭 이벤트를 검사한다. UI 문자열 grep으로 제스처 성공을 주장하지 않는다.
- 실기 fixture의 앱 단독 캡처·CGWindow 좌표만으로 iPad 영상에서의 가시성을 확정할 수 없었다.
  실제 영상에 버튼·입력칸이 모두 보이는 연결 캡처 후에만 입력 단계를 실행한다. fixture는 하나의
  화면 기준으로 매 기록마다 목표 좌표를 재계산하고, 임의 창 이동을 반복해 강제하지 않는다.
  1517.0.7의 input6에서는 네 방향 스크롤 receipt만 통과했고 클릭/문자열은 미도달이었다.
- 1517.0.9의 수정 후 실제 UIKit 한 손가락/두 손가락 회귀 2건, 정규 native 프로필 3건과
  기존 remote-controller 페르소나 검사는 통과했다. 서명·36개 내장 작업 홈 자산 일치를 확인해
  USB iPad에 업데이트했다. 이 빌드의 실기 연결 시도는 실제 Touch ID 창을 기다리다 준비 시간 초과가
  되었으며 아직 시험 클릭/문자열을 보내지 않았다. 이를 실기 입력 통과나 생체 인증 실패로 기록하지 않는다.

## Mac 화면 등록 QR은 iPhone 카메라로도 연다 (2026-11-01)

사용자가 「Mac 화면 기기 등록」 QR을 iPhone 카메라로 찍자 「사용 가능한 데이터가 없음」이 떴다. QR 글자
(`agentstoz-screen:` + base64url, `RegistrationInvite.text`)는 형식상 URL인데 그 스킴을 등록한 앱이 없었다.
Mac 창의 안내 한 줄은 「…」로 잘려 앱 안 스캐너를 쓰라는 말이 보이지 않았다.

- 앱이 `agentstoz-screen` 스킴을 `CFBundleURLTypes`에 등록한다. QR 글자는 **바꾸지 않았다** — 이미 설치된 Mac의 QR도
  새 iPhone 앱에서 카메라로 열리고, 옛 iPhone 앱의 앱 안 스캐너도 새 Mac QR을 그대로 읽는다.
- **https 유니버설 링크로 바꾸지 않는다.** QR에는 일회용 코드 비밀이 들어 있어, 앱이 없을 때 웹 서버에 넘어간다.
  사용자 지정 스킴은 같은 폰의 다른 앱이 가로챌 수 있지만, 그 위협은 「QR을 찍은 사람」과 같고 App Attest·Mac 앞 SAS·Touch ID 승인이 막는다.
- 열린 URL은 `RegistrationInvite.text(openedURL:)` → 앱 안 스캔과 같은 `deviceRegistrationText`로 읽는다(v3 컨트롤러 QR 거절 포함).
  등록 화면을 띄울 뿐이고, Mac에는 사람이 「이 기기 등록」을 누른 뒤에만 닿는다.
- 작업 공간이 열려 있으면 **닫지 않는다**(`end(.disconnected)`는 페이지와 입력 중인 글을 버린다). 작업 공간의 「Mac 화면」 시트가
  그 자리에서 등록으로 바뀐다. 홈에서는 「Mac 화면」 행으로 스크롤한 뒤 넘긴다 — List는 화면 밖 행의 onChange·sheet가 살아 있지 않다
  (`onChange(..., initial: true)`로 행이 생길 때도 읽는다). 등록 시트가 떠 있는 동안 앱 복귀(`.active`)가 저장된 작업 공간으로 덮지 않는다.
- 진행 중인(키 생성 뒤·Mac 응답 전) 등록은 다른 QR로 바꾸거나 닫지 않는다 — 결과를 모르는 요청이다. 끝났거나 실패한 등록 시트에
  새 QR이 오면 `.id(invite.code.id)`로 새 상태에서 시작한다(예전에는 실패 화면이 새 QR 밑에 남았다).
- Mac 창 안내는 `fixedSize(horizontal: false, vertical: true)`로 줄바꿈하고, 카메라와 앱 안 「Mac 화면 등록 · QR 스캔」 두 길을 모두 적는다.
- 검증 경계: 스킴·파싱·라우팅은 Swift 검사(「registration QR is a URL the app opens」)와 소스 계약(`tests/phone-connect-link.test.ts`)이다.
  **실제 iPhone 카메라가 이 스킴으로 「AgentsToZ에서 열기」를 띄우는지는 실기에서 확인하지 않았다** — 「사용 가능한 데이터가 없음」은
  카메라가 글자를 URL로 읽었지만 열 앱이 없을 때의 문구라서 등록하면 열린다고 추론했다.

## 기존 LAN 전용 Screen의 iPad 연결은 waiting을 실패로 읽지 않는다 (2026-10-26)

USB iPad Air 5세대(iPadOS 26.2.1, 앱 1514)에서 로컬 네트워크 허용·같은 Wi-Fi·새 QR 즉시 등록도
「Mac에 연결하지 못했습니다」로 끝났다. iPad Console의 등록 포트 연결 C2는 13:08:51.806에 생성,
`.807612 waiting` → `.807859 preparing` → `.809714 cancelled`였다. 경로는
`unsatisfied (Interface type 'cellular' is prohibited by parameters), interface: pdp_ip0[lte]`였다.
Mac의 등록 요청 처리 전, 클라이언트의 `NWConnection.open`이 `.waiting`을 즉시 실패로 처리해 취소했다.

- `ScreenClient.parameters()`는 iOS에서 `requiredInterfaceType = .wifi`를 지정한다. 셀룰러 금지만으로
  현재 기본 LTE 경로 대신 Wi-Fi를 선택한다고 가정하지 않는다. 등록과 뷰어가 같은 파라미터를 쓴다.
- `.waiting`은 경로 복구 대기다. `.failed`와 구분하고 기존 호출자의 마감(등록 10초, 뷰어 5초,
  Mac 인증 전 gate 5초)과 취소가 종료한다. 새 인증 시도를 자동 생성하거나 보안 마감을 연장하지 않는다.
- 이 절은 1517.0.1 LAN 전용 수정의 기록이다. 그 버전은 셀룰러·P2P 금지와 승인 네트워크를 유지했다. Mac의 이더넷·loopback 검사는
  iOS 전용 Wi-Fi 제한을 받지 않는다.
- `testConnectionWaitsForAUsablePathUntilCancelled`는 Mac에서 존재하지 않는 cellular 경로를 요구해 실제
  Network.framework의 waiting을 발생시킨다. 수정 전 즉시 취소로 실패, 수정 후 대기·명시 취소로 통과한다.
  이 검사는 실제 iPad의 LTE/Wi-Fi 전환과 등록 성공을 대신하지 않으므로 수정 앱 설치 뒤 실기 확인이 필요하다.

## LAN 원격은 주소가 바뀌면 다시 바인딩하되, 버릴 것이 있으면 사람에게 묻는다 (2026-10-06)

저장된 bind 주소는 믿지 않는다 — DHCP 리스가 바뀌거나 네트워크를 옮기면 이 Mac은 그 주소를 더는 갖고
있지 않고, 거기로 되살린 리스너는 아무도 닿을 수 없는 QR을 내준다. **거절은 맞았고, 조용히 거절한 것이
결함이었다**: 실측(2026-10-06) 저장값 `192.168.219.131` vs 현재 `192.168.219.115`로 **최근 127번의
사이드카 시작에서 연속으로** 복구되지 않았는데, 흔적은 사이드카 로그 한 줄뿐이고 앱 상태는 그냥
`enabled:false`였다 — 「한 번도 켠 적 없음」과 구분되지 않는다.

- **판정은 `src/remoteControlLanRestorePlan.ts`의 `planRemoteControlLanRestore` 한 곳이다**(순수 함수).
  네 가지: `idle`(레코드 없음·로컬 비활성) / `resume`(저장 주소를 아직 갖고 있음 → 기기까지 그대로) /
  `rebind`(주소가 바뀌었고 **버릴 세션이 0개** → 지금 주소 + 저장 포트로 자동 재시작) / `stalled`(사람의 판단 필요).
- ⚠️ **재바인딩이 안전한 조건은 「잃을 것이 없을 때」 하나다.** LAN 세션 토큰은 폰의 web storage에
  `http://<주소>:<포트>` origin으로 저장되므로 **주소가 바뀌면 새 origin**이고 폰은 그 토큰을 제시할 수 없다.
  세션이 0개면 고아가 될 토큰이 없으니 그냥 되살리고, 세션이 있으면 **자동으로 옮기지 않는다** — 그 기기들이
  QR을 다시 스캔하는 데 동의하는 것이 바로 운영자의 클릭이다(`stalled` reason `sessions`).
- ⚠️ **사설 주소가 2개 이상이면 고르지 않는다**(reason `ambiguous`). VPN 레그나 두 번째 Wi-Fi에 바인딩하면
  정작 폰이 있는 네트워크에서 닿을 수 없는 QR을 내준다. 주소가 하나도 없으면 `no-interface`(보통 Wi-Fi가
  아직 안 올라옴)이고 다음 시작에 다시 본다.
- **정체 사유는 화면에 나간다**: 관리 상태(`/api/remote-control/status`, 앱 전용)에 `stalled`가 실리고
  대화상자가 `qr-remote-control-stalled`로 그린다. 문구는 사이드카 로그와 **같은 함수**
  (`remoteControlLanStallMessage`)를 쓴다 — 화면과 로그가 다른 이유를 말하면 안 된다. 상태는 폴링마다
  계획을 **다시 계산**한다(Wi-Fi가 돌아온 뒤에도 네트워크 변경을 탓하면 없는 버그를 찾게 된다).
- 옛 Mac이 `stalled`를 안 보내거나 형식이 깨지면 **null**이다(`normalizeStall`) — 받지 않은 이유를
  주장하지 않는다. 이 필드는 Mac 관리 표면 전용이라 `REMOTE_CONTROL_PROTOCOL_VERSION`과 무관하다
  (`normalizeQrRemoteControlStatus`는 `qrRemoteControlClient.ts`만 쓴다).
- `start()`가 성공 시 레코드를 다시 쓰므로 재바인딩한 주소는 그 자리에서 영구화된다. 저장 포트만 쓰는
  규칙은 그대로다(임시 포트 폴백 금지 — 위 주석의 두 이유).
- **헤더에도 알린다**(`remote-control-stall-badge`, `src/components/RemoteControlStallBadge.tsx`). QR 항목
  자체가 「도구 및 설정」 팝오버 2단 안에 있어서 대화상자 안의 안내는 **이미 의심한 사람에게만** 보인다 —
  정작 이 결함의 본질이 「조용함」이다. 칩은 정체일 때만 그려지고(없음 = 「막힌 것이 없음」이지 「켜짐」이
  아니다) 누르면 그 대화상자를 연다. 읽기는 마운트·focus·visibility + 60초이고 **배포 웹에서는 아예 묻지
  않는다**(관리 origin이 없어 403만 쌓인다). 읽기 실패는 마지막 답을 유지한다 — 실패는 정체의 증거가 아니다.
- 검증: `tests/remote-control-lan-restore-plan.test.ts`(8건, 실측 주소쌍 포함),
  `tests/qr-remote-control-contract.test.ts`(정체 필드 정규화·옛 Mac 폴백),
  `tests/remote-control-stall-badge.test.ts`(정체 전에는 아무것도 그리지 않음·문구 일원화·헤더 위치).

## 끊긴 소켓은 해지가 아니다 — 목록에 있음 ≠ 연결됨

아이폰은 **화면이 잠길 때마다** WebSocket을 놓는다. LAN 호스트는 그때마다 세션을 파기했고
QR은 일회용이라, 잠금 한 번이 곧 «맥으로 돌아가 새 QR을 받아라»였다. 정작 core에는
`restore()`가 있고 주석까지 그 목적을 적어 두었지만 **파서가 `session.restore`를
`ACTION_NOT_ALLOWED`로 먼저 거절해서 핸들러가 도달 불가**였다(2026-09-09 실측).

- 평범한 종료(1000/1001, 폰이 그냥 사라짐)는 세션을 **살려 둔다.** `#handleClose`는 소켓만
  떼고 `socket=null`로 둔다. **정책 종료(1008 — 파싱 실패·rate/queue overflow·연결 수 초과)는
  세션을 끝낸다.** 남용하는 클라이언트에게 재개를 주지 않는다. 이 구분이 `#closeSocket`에 있다.
- ⚠️ **`status().sessions`에 있다는 것이 «연결됨»이 아니다.** `connected` 필드로 갈린다.
  AI 터미널 권한(`aiTerminalConnections()`)은 **반드시 `connected`로 걸러야 한다** — 목록 존재만
  보면 끊긴 폰의 터미널 권한이 살아남는다. 이 회귀를 `tests/remote-control-lan-resource.test.ts`와
  `tests/ai-terminal-remote.test.ts`가 실제로 잡았다. 테스트의 `active` 콜백은 프로덕션과 같은
  식이어야 한다.
- **재접속은 새 관리 세션 id를 발급한다.** 터미널 권한이 `lan:<id>`로 매여 있어서, id를 재사용하면
  끝난 연결에 준 권한이 되살아난다. 폰의 프로젝트 버튼은 복구되지만 터미널은 다시 허용해야 한다.
  `pairedAt`은 유지한다 — 같은 기기를 새 기기로 보이게 하면 운영자가 알아볼 수 없다.
- 떠나 있는 세션도 목록에 남기는 이유는 **운영자가 보고 해지할 수 있어야 하기 때문**이다.
  라벨이 「모바일 브라우저 · 연결 대기」로 갈린다. 해지는 여전히 진짜 종료다.
- 옛 Mac이 `connected`를 아예 안 보내면 **연결됨으로 읽는다**(`raw.connected !== false`).
  없는 필드를 «떠남»으로 읽으면 멀쩡한 기기가 조용히 목록에서 사라진다.
- ⚠️ **세션을 살려 두면, 소켓을 닫는 행위가 하던 «진행 중 작업 취소»가 함께 사라진다.**
  `#assertSessionStillActive`는 core 세션만 봤으므로, 프로젝트 권한을 다시 읽는 await 동안 폰이
  끊겨도 그 뒤 `executeRegisteredProjectAction`이 그대로 실행됐다(코덱스 리뷰가 재현). 이제
  `SessionState.isDeliverable`을 전송 계층이 `bindSessionDelivery()`로 심고, 같은 지점에서 함께
  본다. **새 await를 `#execute`에 추가하면 그 뒤에도 이 검사를 거칠 것.**
- ⚠️ **«누가 붙어 있나»가 아니라 «이 요청을 낸 연결이 아직 그 연결인가»를 물어야 한다.** 술어를
  세션에 두면, B가 재접속하며 술어를 갈아끼운 순간 A가 버려두고 간 작업이 «B가 붙어 있다»를 보고
  실행된다. 그래서 `deliveryGeneration`을 `perform()` 진입 시점에 **요청마다 캡처**하고, 세대가
  다르면 술어를 묻지도 않고 취소한다. `bindSessionDelivery()`가 세대를 올린다.
- ⚠️ **재접속은 이전 소켓을 반드시 쫓아내야 한다.** `session.restore`는 관리 항목만 갈아치웠고
  옛 소켓은 `#sockets`에 남아 토큰 검사를 통과했다 — 목록에는 하나인데 **인가된 연결이 둘**이었다.
  restore 분기가 같은 토큰을 든 다른 소켓을 1000으로 닫는다(1008이면 세션까지 끝나므로 안 된다).
- **터미널 소유자 판정은 `src/remoteTerminalOwners.ts` 한 곳이다.** 예전에는 api-server 안에
  인라인이라, LAN 테스트 픽스처가 같은 식을 **복사해서** 갖고 있었고 프로덕션 필터만 되돌리면
  아무 테스트도 깨지지 않았다. 규칙을 픽스처가 대신 주장하게 두지 말 것.
- ⚠️ 이 계약은 **문자열 grep 테스트로 지킬 수 없다.** 기존 재접속 스위트가 클라이언트 번들을
  grep만 해서 «복구 불가» 상태를 통과시켰다. `tests/remote-control-lan-reconnect.integration.test.ts`가
  실제 리스너와 실제 WebSocket으로 페어링 → 소켓 종료 → 복구 → 해지를 돌린다. RFC1918 주소가
  없는 기기에서는 skip한다.

## 네이티브 iOS 앱은 «소켓 = 세션»으로 모델링돼 있었다

`mobile/ios/`의 SwiftUI 앱은 Mac 쪽 세션 복구를 **원리적으로 쓸 수 없었다.** `session.restore`를
보내지 않았고(문자열 자체가 소스에 없었다), 토큰을 어디에도 저장하지 않았으며, 백그라운드 전환마다
세션을 파기했다. 소비한 QR은 재사용할 수 없으므로 결과는 **화면을 잠글 때마다 Mac까지 걸어가기**였다.

- 이제 세션 토큰을 **Keychain에 Mac origin별**로 둔다(`kSecAttrAccessibleAfterFirstUnlock`, iCloud 동기화
  없음). QR의 페어링 토큰은 여전히 저장하지 않는다 — 그건 일회용이고 `LANPairing`의 주석이 그대로 유효하다.
- 백그라운드는 `suspend()`(소켓만 끊고 복귀 권리 유지), 사용자의 「연결 해제」는 `disconnect()`다.
- ⚠️ **거절은 답변이지 연결 끊김이 아니다.** `ok:false`마다 세션을 파기해서, 재시도 가능한
  `RATE_LIMITED` 하나가 새 QR을 요구했다. `RemoteFailure.hostRefused`가 코드를 들고 오고
  `keepsSession`이 유지 여부를 정한다.
- ⚠️ **와이어 타입 목록을 Mac에서 확인하지 않고 적으면 안 된다.** 옛 목록에는 호스트에 존재하지 않는
  `session.ended`가 있었고 실제로 오는 `session.closed`·`session.restored`·`terminal.result`는 거부했다.
- 종료 코드를 봐야 한다. 1012(Service Restart)는 Foundation enum에 없으므로 rawValue로 비교하고
  «다시 오라»로 처리한다 — 1000/1001/1008과 뭉치면 보존 종료가 재페어링이 된다.
- ⚠️ **`bun run verify`는 이 앱을 건드리지 않는다.** Mac 계약을 바꾼 뒤 `test:ios`가 깨져 있었는데
  verify는 4,011건 전부 통과했다. `verify.yml`의 `native-ios` job이 push마다 `swift test`와 무서명
  iPhone 빌드를 돌리지만, 시뮬레이터·사설 IPv4가 필요한 스크립트는 수동이다.

## 폰이 자기 세션을 끝낼 방법이 있어야 한다 (`session.end`)

소켓 종료가 «잠깐 떠남»이 된 순간, 폰에는 «이제 끝»이라고 말할 방법이 사라졌다. 사용자가 「연결
해제」를 눌러도 Mac은 그 기기를 30일 만료까지 계속 목록에 들고 있었다.

- `session.end`는 client→host 메시지이고 다른 클라이언트 메시지와 **같은 엄격함**(정확한 키·프로토콜
  버전·토큰 모양)을 받는다. 그 소켓이 그 세션을 소유해야만 받아들인다 — 남의 토큰을 인용해 끊을 수 없다.
- 끝내면 core 세션·관리 행·저장 레코드에서 함께 사라진다. 하나라도 남으면 다음 재시작이 떠난 폰을
  되살린다.
- 클라이언트는 best-effort로 보낸다. 이 프레임을 모르는 옛 Mac은 거절하고, 소켓은 어차피 닫힌다.

## 떠난 세션이 슬롯을 잡으면 페어링이 막힌다

세션이 소켓보다 오래 살면 «떠난» 세션이 자리를 차지한다. 실측: 페어링 1~8회 성공, **9회째
`SESSION_LIMIT`**. 매번 새 QR로 붙는 클라이언트(네이티브 앱이 그랬다)는 8번이면 잠긴다.

- `pair()`는 자리가 없을 때 **가장 오래 유휴인 «떠난» 세션을 은퇴**시킨다. 방금 스캔한 QR은 운영자의
  명시적 행위이고, 소켓 없는 세션이 그 방에서 가장 값싸다.
- 전송이 술어를 심지 않은 세션(인터넷 릴레이)은 «있음»으로 세고 절대 은퇴시키지 않는다. **여덟 대가
  실제로 붙어 있으면 아홉 번째는 여전히 거절**된다 — LAN에서는 `MAX_OPEN_SOCKETS`가 한 겹 먼저 막는다.
- core가 스스로 세션을 지울 수 있으므로 전송 계층은 관리 행을 **대조**해야 한다(`#reconcileSessions`).
  안 그러면 없는 세션에 해지 버튼이 뜨고 그 행이 레코드에 복구 대상으로 적힌다.

## 재시작은 재페어링이 아니다 — LAN도 복구된다

LAN 리스너는 모듈 변수 하나에 임시 포트로 떠 있어서, 앱을 업데이트할 때마다 리스너가 닫히고
페어링된 폰이 전부 끊기고 **QR이 가리키는 URL까지 바뀌었다.** 인터넷 전송 경로는 이미
`remoteControlHostVault`로 살아남고 있었다 — 더 노출이 큰 쪽만 되고 LAN은 안 됐던 것이다.

- 정본은 `src/remoteControlLanVault.ts` (0600 레코드 + `remote-control-lan.disabled` 마커).
  읽기는 호스트 볼트의 `readPrivateFileStrict`를 **재사용한다** — 경로 기반 `lstat`+`read` 쌍은
  그 사이에 심링크를 끼워 넣을 수 있고, group-readable 복사본도 그냥 받아들인다.
- ⚠️ **«목록에 있음»과 마찬가지로, 저장된 것과 살아 있는 것은 다르다.** 복구된 세션은 소켓이
  없는 상태(`connected:false`)로 돌아오고, 폰이 다음에 페이지를 열 때 스스로 재연결한다.
- ⚠️ **`stop({keepRecord:true})`와 그냥 `stop()`은 반대의 뜻이다.** 운영자가 끈 것은 폰을 잊어야
  하고, 네트워크가 바뀌거나 죽은 것은 잊으면 안 된다. 후자에서 `session.closed`를 보내거나
  1000/1001/1008로 닫으면 **폰이 자기 토큰을 지운다** — 그래서 보존 종료는 **1012**로 닫고
  아무 메시지도 보내지 않는다. 이 구분이 없으면 크래시 한 번이 영구 재페어링이 된다.
- ⚠️ **1008 정책 종료는 세션을 끝내므로 반드시 기록해야 한다.** 안 그러면 스스로 정책 종료를
  유발한 클라이언트가 토큰을 든 채로 다음 부팅에 되살아난다.
- **해지 기록 실패는 삼키지 않는다.** 「연결 해제됨」이라고 답해 놓고 토큰이 복구 가능한 상태로
  남는 것이 이 기능에서 유일하게 위험한 거짓말이다. 반대로 enable·만료·정책 종료의 기록 실패는
  로그로 남기고 진행한다 — 타이머·소켓 콜백에서 던지면 API 프로세스가 죽는다.
- **저장된 포트로만 복구한다.** 임시 포트 폴백은 ① 포트가 잡혀 있다는 건 보통 다른 프로세스가
  같은 레코드를 이미 소유했다는 뜻이고(양쪽이 같은 토큰을 인가하면 서로 해지가 안 된다),
  ② 새 포트는 새 origin이라 폰이 가진 토큰이 통째로 고아가 되기 때문에 제거했다.
- 부팅 시 바인드 주소를 **실제 인터페이스 목록과 대조**한다. Wi-Fi가 올라오기 전에 앱이 뜨면
  복구가 건너뛰어지는데, 그때는 운영자가 「켜기」를 누르면 **저장된 세션을 그대로 이어서** 켠다.

## 「QR 원격제어 · 이 Mac」에서 꺼진 같은 Wi‑Fi 웹 원격은 접혀 있다 (2026-11-01)

사용자 검토(「상단 Screen이 원격제어인데 하단 LAN은 필요 없는 것 아닌가」): 이 대화상자의 위쪽 「아이폰·아이패드로 이 Mac 보기」(AgentsToZ Screen)와
「외부 인터넷 QR 원격제어」가 같은 일을 더 넓게 하므로, **꺼져 있는** 같은 Wi‑Fi 웹 원격은 한 줄(`qr-remote-control-lan-folded`)로 접고
「같은 Wi‑Fi로 켜기…」(`qr-remote-control-lan-expand`)를 눌러야 예전 켜기 화면·주의문·하단 「이 Mac에서 켜고 QR 발급」이 나온다.
켜져 있거나 멈춤(`status.stalled`)이면 쓰는 사람이므로 처음부터 펼친다(헤더 멈춤 배지가 이 대화상자를 연다).
**기능은 지우지 않았다** — 인터넷 원격이 안 될 때·인터넷 없이 같은 공유기에서 쓰는 유일한 길이다. 인터넷 원격이 안정된 뒤 완전히 지울지는 사용자가 정한다.
스모크(`tests/smoke.mjs`)와 `tests/work-mode-ui.mjs`는 펼친 뒤 켜기 버튼을 찾는다.
