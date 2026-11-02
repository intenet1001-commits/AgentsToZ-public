# 2026-11-02 이어받기 — 실제 상태와 재검증

이 문서는 원래 HANDOFF의 3절 이후 진행을 기록한다. **전체 완성·운영 출시로 판정하지 않는다.** 08:29 KST 이후 iPad mini의 5G 화면 보기·클릭·스크롤은 별도 실기로 확인했다([증거와 한계](CELLULAR-LIVE-2026-11-02.md)).
09:47 KST 이후 전용 Viewer 프로필 발급·로컬 QA 서명 및 입력 실측 도구 준비와 최신 검증은
[VIEWER-READINESS-2026-11-02.md](VIEWER-READINESS-2026-11-02.md)를 따른다.
그 뒤 버튼 미노출의 포장 결함 수정, 1호 진단, App Attest 미지원 근거와 **최신 verify 실패 1개**는
[VIEWER-BUTTON-2026-11-02.md](VIEWER-BUTTON-2026-11-02.md)를 먼저 확인한다.
작업 브랜치는 `codex/remote-completion-20261101`, 검증한 소스는
`121873a9a6ac99517922baf841065622a40c9677`이다. 원본 저장소에도 같은 브랜치로 보존했으며 main에는 병합하지 않았다.

## 이번에 완료한 소스

| 항목 | 변경 | 상태 |
|---|---|---|
| iPad 등록 진행 | 근거리/중계 발견, 실제 등록 요청, 사람 승인 단계를 구분 | `2704b241`, 이전 검증 포함 |
| 생체 승인 뒤 연결 실패 | 승인 → 실제 경로 열기 → Mac 인증 → 첫 화면 → 표시 중을 구분. 5G 사설망 실패에 같은 Wi-Fi를 요구하지 않음 | `7bccc738`, iOS 컴파일·회귀 통과 |
| 잠김 상태 혼동 | Mac 인증 전/실패 후에는 잠김 상태 불명 배너를 표시하지 않음 | 같은 변경, 설치본 미반영 |
| 연결 취소 | Mac Viewer 취소 후 경로 대체·인증 메시지 전송을 차단하고 취소 오류를 보존. 모바일도 폐기된 시도의 키 교환 전 중단 | `5305ba81`, 가짜/loopback 회귀 통과 |
| 검사 러너 | XCTest 전용 overflow 파일을 단독 swiftc 대상에서 제외하고 SwiftPM 검사에는 포함 | `410398a6` |
| Mac Viewer 포장 | 독립 App ID·정확한 키체인 권한·프로필 인증서 소속·secure timestamp 확인. `--developer-id --with-viewer` 포장과 독립 서명 보존·티켓 스테이플 경로 | `a5a4ed5c` 후 전용 프로필로 QA 0.0.0 실제 서명·strict 검증 통과. 공증·설치 없음 |
| 입력 실측 준비 | 사람 실행용 `AgentsToZInputProbe`·제한된 메타데이터 집계·누락/충돌 판정 | `37de4d9a`까지 컴파일·합성 검사 통과. 실측·보정 승인 없음 |
| REA/전송 분석 | 사용자 ZIP 정적 분석의 영수증·한계와 Jump/Cloudflare/Supabase 역할을 문서화 | [연구 기록](../../research/jump-desktop-rea-and-remote-transport-2026-11-02.md) |

## 최신 재검증과 실기

`121873a9`의 전체 `verify`는 **exit 1**: 기존 터미널 간격 검사에서 100ms 이상 기대에 94ms가 관측됐다.
Bun **10,312 pass / 12 skip / 1 fail**, 유지보수 138개와 타입 검사는 통과했다.
실패 파일은 분리 실행 **17 pass / 0 fail**, 별도 Rust는 **165 pass / 0 fail / 1 ignored**지만 원인을 확정하지 못했다.
Viewer 집중 검사 30개, fixture UI 두 엔진, 해당 persona 10개와 실제 서명 payload 포장은 통과했다.
전체 성공으로 보고하지 않으며 설치·배포하지 않았다. [최신 상세 기록](VIEWER-BUTTON-2026-11-02.md)을 따른다.

이전 성공 기록:

`37de4d9ae6cf66704e92bf8006b4f09c75dd59c0`의 깨끗한 작업 브랜치에서 `bun run verify` **exit 0**을 확인했다.
유지보수 138개·타입 검사·Bun **10,312 pass / 12 skip / 0 fail**·Rust **165 pass / 0 fail / 1 ignored**다.
원격 사용자/접근성 페르소나는 공통 runner의 **10개 검사 실패 0개**, source unchanged true다.
이전 Rust guard 실패는 재현되지 않았으며, 그 원인 해결로 표시하지 않는다.

현재 Mac 전용 Cloudflare 경로를 복구한 뒤 iPad의 5G 화면·클릭·스크롤을 실기로 확인했다.
[실기 증거와 한계](CELLULAR-LIVE-2026-11-02.md), [오픈소스 비교와 다음 설계](../../research/jump-desktop-rea-and-remote-transport-2026-11-02.md)를 따른다.
이후 갱신은 문서뿐이다. 전용 Viewer QA 서명은 확인했으나 main 병합·공개 배포·Viewer 설치는 하지 않았다.

## 이전 재검증 이력

검증 중에는 추적 소스를 고치지 않았다. 수정 전 실행은 중단해 최종 증거에서 제외했다.

- `bun run verify`: Python 유지보수 138개 통과, 타입 검사 통과, Bun **10,312 pass / 12 skip / 0 fail**(1,136 파일).
  마지막 Rust 단계에서 덮개 guard 검사 1개가 실패해 **명령 전체 exit 101**이다.
- 실패한 `guard_restores_only_for_a_dead_or_silent_owner` 분리 재현: 1 pass.
  이어서 같은 소스에서 `cargo test` 전체 재실행: **165 pass / 0 fail / 1 ignored**. 최초 실패 원인은 확정하지 못했다.
  이후 재실행을 합쳐 단일 `verify` 실행이 통과했다고 표현하지 않는다.
- `test:screen-control`: **161/161**, 관련 XCTest **127개 실패 0**, 세션 바 **14상태 오프스크린 렌더** 통과.
- Viewer 포장·Developer ID·Control 프로필·iOS shell 관련 4파일: **51 pass / 0 fail**.
- `swift build --product AgentsToZViewer`: 통과. 실행·설치하지 않음.
- iOS Simulator Debug 앱 컴파일: `BUILD SUCCEEDED`, 서명·설치 없음.
- 공통 러너 `native`의 `ios-core`(전제 `ios-preflight` 포함): 통과.
- 접근성 페르소나: **contract 1 + headless screen 3** 통과. 전체 페르소나·전체 quick 통과라는 뜻은 아님.
  실제 창을 띄우는 quick 항목은 HANDOFF 2절 때문에 실행하지 않았다.
- J3B: 최종 커밋 archive 사본에서 사전 점검 + 합성 Viewer/Screen 레인 통과.
  Git clone 사본에서 실행한 첫 시도는 과거 main과 소스 비교 때문에 실패했으며 성공 증거로 쓰지 않았다.
- J3A-process: 지정된 `~/agentstoz-emulator/<run>/wt`의 archive 사본에서 사전 점검 + 두 프로세스/대역 우편함/가짜 Control 레인 통과.
  `/private/tmp` 사본은 이 레인의 전용 경로 가드에 거절됐으며 가드를 완화하지 않고 지정 경로에서 다시 실행했다.
- 테스터 ensure는 임시 작업 사본이 등록 프로젝트가 아니라고 응답했다. 원본 프로젝트나 설치 앱 구성을 바꾸지 않았다.

로컬 로그와 선택한 영수증은 원본 저장소의 gitignored
`tests/results/remote-continuation-20261102/`에 보존했다. 에뮬레이터의 일회용 소스 사본은 검증 후 정리한다.
추가한 Mac Viewer 사용자 여정은 `personas propose` 후보이며 활성화·사람 실기 통과가 아니다.

## 다음에 반드시 이어갈 항목

1. **현재 Mac의 iPad 5G 연결은 실기로 해결 확인.** 현재 Mac의 새 주소에 맞춘 전용 connector·`/32`·소유자 TCP 52741 정책·iPad 저장 경로를 구성했다.
   사용자 시작·생체 승인 뒤 실제 iPad 영상, 호스트 `viewing:true`, 전용 터널 TCP 활성 1을 대조했고 사용자가 클릭·스크롤 모두 정상이라고 확인했다.
   이는 이전 실패 판정을 새 실기로 갱신한 것이며 Mac↔Mac·새 기기의 5G 최초 등록·IP 변경 후 자동 복구까지 증명한 것은 아니다.
2. **H1 전용 Viewer 프로필 확보·로컬 QA 서명 통과.** 원본 저장소의 gitignored 증거에 보존했다. 기본 프로필 경로는 비어 있으므로 `--profile` 절대 경로가 필요하다.
   실제 발급 프로필에는 App Attest entitlement가 없다. Apple 문서는 Mac의 App Attest를 미지원으로 명시한다.
   S-K2 PASS가 아니며 미결속 등록의 푸시 관문을 유지한다. 공증·설치와 두 Mac 등록/보기/조작은 미완료다.
3. **S-M3 보정/H10 pushLive 미완료.** Mac 컨트롤러 조작 기본 꺼짐을 풀지 않았다.
   실제 하드웨어 입력·잠금 화면·사람 인계 실측 없이 완료 또는 원격 조작 가능으로 보고하지 않는다.
4. **AI 커뮤니티 신뢰/미확정 실행 처리 미완료.** 기존 v1의 DB 키 교체 MITM과 사람 보류 보존 문제는 해결되지 않았다.
   credential/handshake/key-confirmation 모듈은 독립 신뢰 발급자·online lease·영속 replay 방지 및 native 권한 경로와 아직 통합되지 않았다.
   fixture 통과는 이 보안 문제의 해결 증거가 아니다. 출시 전 해결해야 한다.
5. Rust guard의 최초 간헐 실패를 재현/분석한다. 후속 전체 통과만으로 안정성 문제가 없다고 단정하지 않는다.
6. 최신 전체 실행에서 나온 기존 터미널 입력 간격 실패를 분석한다. 분리 통과만으로 전체 verify나 출시 관문을 통과시키지 않는다.

사용자는 이번 세션의 작업을 일괄 승인했고 추가 승인 질문과 밤중 지문인식을 원하지 않는다.
이를 기존 일회용 생체 승인 재사용이나 AI의 사람 Viewer 세션 시작 권한으로 해석하지 않는다(SR-23).
야간 heartbeat 등록은 도구가 `approval policy is never`로 거절하여 생성되지 않았다. 예약이 존재한다고 말하지 않는다.
