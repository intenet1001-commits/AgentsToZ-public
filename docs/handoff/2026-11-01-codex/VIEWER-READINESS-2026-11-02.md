# Viewer 서명 준비와 입력 실측 도구 — 2026-11-02

## 현재 결과

`chunsung` Ego Lite 프로필(`Default`)의 Apple Developer 팀 `DA8QKAQ2C9`에서
`com.intenet.agentstozbycs.viewer` 전용 App ID와 **AgentsToZ Viewer Developer ID** 프로필을 발급했다.
기존 Screen·Control 프로필과 인증서는 변경하지 않았고 새 인증서·개인 키도 만들지 않았다.

전용 프로필의 팀·번들 ID·Developer ID 배포 조건·키체인 그룹·만료·선택 인증서 지문 소속 검사를 통과했다.
정확한 기존 인증서로 Viewer **0.0.0 로컬 QA 앱**을 빌드하고 hardened runtime·secure timestamp·
`codesign --verify --deep --strict` 및 빌더의 고정 requirement·entitlement 검사를 통과했다.
복사해 보존한 앱도 strict 검증을 통과했고, embedded profile은 내려받은 원본 바이트와 같다.
**공증·설치·앱 실행·사람 세션 시작은 하지 않았다.** 출시 산출물이나 Mac↔Mac 실기 성공이 아니다.

포털에서 App Attest 기능을 선택해 App ID를 등록했으나, 실제 내려받은 macOS 프로필에는
App Attest entitlement가 없다. 현재 Viewer의 실제 App Attest 생성 경로도 미완료다.
H1의 프로필 부재는 해소했지만 S-K2 지원·증명 생성·호스트 검증은 미확인으로 남긴다.
프로필 CMS의 만료는 `2044-10-28T00:46:31Z`, 선택 인증서 및 포털 표시 만료는 2031-09-17이다.
이 서로 다른 날짜를 앱 신원 증명이나 장기 운영 보장으로 해석하지 않는다.

## 구현한 S-M3 준비 도구

소스 커밋 `db6bd791`, `d5a0e874`, `37de4d9a`에 별도 SwiftPM 실행 대상 `AgentsToZInputProbe`를 추가했다.
사람이 직접 실행한 자기 창의 전용 시험 영역에서만 입력 출처 메타데이터를 집계한다.

- 저장: 사람이 고른 출처 라벨·입력 종류·source PID·keyboard type·source state·집계 수.
- 저장하지 않음: 글자·키 코드·좌표·화면·이벤트 원문. 외부 입력 관찰·주입·네트워크·Keychain·TCC 요청 없음.
- 상한: 서로 다른 표본 128개, 이벤트 10,000개. 누락·CGEvent 부재·초과를 명시한다.
- hardware와 다른 출처의 pid-0 state/type 충돌은 입력 종류가 달라도 `ambiguous`로 남긴다.
- 표본이 모두 있어도 `needs-human-review`, 항상 `certifiesCalibration:false`다.
- 설정 버튼의 입력을 표본에서 제외하고 기록 중에는 출처 선택을 고정한다.
- 사람이 Save Panel로 정한 로컬 경로에 0600 임시 파일을 만든 뒤 rename한다.

배포 Viewer/Screen 번들에 넣지 않는다. `ScreenInputCalibration.current`와 조작 빌드 관문은 그대로다.
컴파일과 합성 코어 검사만 수행했고 실제 진단 창·AX 조작·물리 입력 실측은 수행하지 않았다.
사람 실행은 [SPIKES.md](../../design/mac-to-mac-2026-11-01/SPIKES.md)의 깨끗한 환경 명령과 출처 구분을 따른다.

## 해당 브랜치 재검증

깨끗한 `codex/remote-completion-20261101`의 소스 **`37de4d9ae6cf66704e92bf8006b4f09c75dd59c0`**에서 실행했다.
전체 검증 중 추적 파일을 편집하지 않았으며, 아래 결과 후에는 문서만 갱신했다.

| 검사 | 실제 결과 |
|---|---|
| `bun run verify` | **exit 0** |
| Python 유지보수 검사 | 138 통과 |
| TypeScript | 통과 |
| Bun | **10,312 pass / 12 skip / 0 fail**, 1,136 파일 |
| Rust | **165 pass / 0 fail / 1 ignored** |
| 공통 runner quick의 `essential-contracts` | 1 통과, `20261102T003002Z-d530853f`, source unchanged true |
| 공통 runner quick의 `native-confirmation-contracts` | 1 통과, `20261102T002700Z-f01a870d`, source unchanged true |
| 원격 사용자·저시력 사용자 persona | 공통 검사 **10 통과 / 0 실패**, `20261102T002709Z-2fcb2b00`, source unchanged true |
| `AgentsToZInputProbe` 최종 컴파일 | 통과, 실행하지 않음 |
| 독립 Viewer QA 서명 빌드 | exit 0, 별도 strict 검증 exit 0 |

페르소나의 `ios-core`가 Screen 코어·폰 v4 호환 검사를 포함했다.
앞선 `db6bd791` 집중 검사에서는 **166/166**, 관련 XCTest **127개 실패 0**, 세션 바 **14상태 오프스크린 렌더**를 확인했다.
전체 quick·전체 페르소나·물리 Mac UI 검사 통과로 확대하지 않는다.
기존 Rust guard의 간헐 실패는 이번에 재현되지 않았으나 원인을 해결한 것으로 표시하지 않는다.

프로젝트 tester ensure는 이 세션에서 이미 한 번 호출했고, 임시 작업 사본은 미등록으로 skipped였다.
기존 공통 runner를 직접 사용했으며 설치 앱의 포트에 합성 테스트를 연결하지 않았다.
새 「Mac 입력 출처 실측 담당자」 여정은 `role-3b28be7cd72d0ede0d94` 후보로 남겼다.
실제 창의 동작 검사가 없어 check ID는 비어 있는 **needs checks** 초안이며 활성화·PASS가 아니다.

## 로컬 증거와 다음 단계

원본 저장소의 gitignored `tests/results/remote-continuation-20261102/next-step/`에 로그·공통 runner 보고서·
포털 발급 목록·공개 프로필 메타데이터·서명 검사 영수증을 보존했다.
`signing/AgentsToZ_Viewer_Developer_ID.provisionprofile`(0600)와 `signing/AgentsToZViewer.app`은 해당 디렉터리 아래다.
원시 프로필·앱은 Git에 추가하지 않았으며 기본 소스 프로필 경로에도 복사하지 않았다.
재현 빌드에는 보존한 프로필을 `--profile`의 절대 경로로 지정한다.

남은 순서:

1. 사람이 S-M3 진단 창에서 실제 키보드·포인터와 원격·합성·가상 HID 출처를 비교한다. iPad 입력은 Screen 주입 항목이다.
2. S-K2의 macOS 지원과 실제 증명 경로를 확인하고, 지원하지 않으면 설계의 미결속 등록·푸시 관문을 유지한다.
3. H10 실제 알림 수신·원격 차단과 S-N2의 두 Mac 경로를 확인한다. `pushEndpointConfigured:true`만으로 통과시키지 않는다.
4. 출시 소스 관문을 지킨 서명·공증·설치 후 사람이 두 Mac의 등록·보기·입력·보류·해제를 실측한다.

현재 iPad→이 Mac의 5G 화면·클릭·스크롤 성공은 [별도 실기 기록](CELLULAR-LIVE-2026-11-02.md)으로 유지한다.
**Mac↔Mac 조작은 기본 꺼짐, AI 커뮤니티 신뢰·영속 사람 보류 통합은 미완료**다.
SR-23에 따라 AI가 사람 Viewer 세션을 시작하거나 생체·SAS 승인을 대신하지 않는다.
