# 모바일 테스터와 Control 현황

2026-09-14 · MCP 1.15.0 · Python runner 1.1.1 재사용

## 사용하는 순서

1. Mac에서 등록 프로젝트의 **테스터 에이전트**를 열어 검사 설정과 Python을 준비한다.
2. 워크룸의 기기 권한에서 해당 프로젝트와 **테스트 결과 조회**, 필요한 경우 **테스트 실행**을 허용한다. 기존 기기의 권한은 자동으로 확대하지 않는다.
3. 모바일 인터넷 원격 작업의 프로젝트 관리 화면 또는 LAN 프로젝트 화면에서 **프로젝트 테스터 → 검사 범위 → 테스트 실행**을 선택한다.
4. 같은 실행 ID의 결과를 확인한다. 상세 로그·설정 변경·AI 개선은 Mac의 프로젝트 테스터에서 이어간다.
5. Mac의 AgentsToZ 프로필/Control 패널에서 **프로젝트 테스트 현황 · 이 Mac**을 열면 등록 프로젝트의 최근 기록과 프로젝트 테스터 열기 버튼을 사용할 수 있다.

## 실행과 연결

`tester-v1` 지원을 기존 `protocol.capabilities`로 확인한다. 구형 Mac은 업데이트 안내를 표시한다. 새 원격 HTTP 경로나 임의 명령 실행 기능은 만들지 않는다. LAN/인터넷 모두 기존 terminal envelope 안의 `workspace` 메시지를 사용한다.

`tester.status/start/read/cancel`만 허용한다. 프로젝트별 durable grant에 `tester.read`와 `tester.run`을 구분하며 실행은 두 권한이 모두 필요하다. Python 설정, 경로, 명령, 원문 로그, 기억 내용, AI 인계문은 모바일 요청/응답으로 전달하지 않는다. 결과는 고정 상태·검사 ID·시간·실행 ID·설정 revision·제한된 프로필 목록만 포함한다.

시작 요청의 `testRequestId`는 네트워크 envelope의 `requestId`와 별개다. stable 기기 소유자와 프로젝트에 결속한 요청 영수증을 재사용한다. 미확정 응답은 같은 요청 확인으로 복구하며 재연결 자체가 새 검사를 시작하지 않는다. 다른 프로젝트/연결의 늦은 응답은 폐기한다.

통신 단절이나 화면 닫기는 접수한 검사를 중단하지 않는다. durable grant 변경·만료·명시 연결 해제는 대기열과 실행 중인 작업에서 다시 확인한다. 실행 중에는 1초 간격으로 권한을 검사하고 소유 Python에 SIGINT를 보낸다. 모바일은 자신이 시작한 검사만 취소한다. Mac에서는 기존 앱 검사 취소 권한을 유지한다. 앱 프로세스 재시작의 미확정 영수증은 기존 recovery-required 규칙을 따른다.

화면은 진행 중인 검사만 3초마다 조회하고 숨김/오프라인에서 멈춘다. 일반 모바일 요청 예산을 공유한다. 실제 작업은 기존 최대 2개 실행·대기/미확정 16개 예산을 따른다.

## Control 조회

`POST /api/control-profile/tester-results`와 MCP `agentstoz_use_list_tester_results`는 같은 조회를 사용한다. MCP는 기존 USE 프로필 인증을 요구한다. 이 Mac의 등록된 main 프로젝트만 20개씩, 파일 읽기 동시 2개로 조회한다. 다음 페이지는 등록 목록 revision을 검증한다. 프로젝트당 보고서 항목 64개/읽기 5MB를 넘거나 링크·깨진 결과를 만나면 확인 필요로 표시한다.

조회는 Python·Git·AI를 실행하지 않고 다른 Mac의 결과를 합산하지 않는다. 최근 기록은 과거 근거이며 현재 코드의 통과를 뜻하지 않는다. 현재 지문 확인은 프로젝트 테스터 상세에서 수행한다. 결과 기록을 운영 기억으로 자동 저장하지 않는다.

## 반복 검증과 한계

`python3 scripts/agentstoz-maintainer.py run --root . --profile tester`는 실제 Python, 격리 API/WebSocket, Chromium/WebKit 모바일 터치와 Control 페이지 회귀를 실행한다. 실제 iPhone 검사는 기존 `device` 프로필의 격리 앱에서 추가로 실행한다. 해당 fixture는 배포 LAN 문서와 production WKWebView를 사용하며 임시 Python 프로젝트의 동일 run ID를 Mac과 대조한다. 실제 AI/개인 데이터는 사용하지 않는다.

개인 인터넷 relay의 셀룰러 전환, TestFlight 다운로드, 다른 Mac, 30일 실제 경과와 모든 AI 제공자의 응답은 별도 검증 범위다. LAN/iPhone fixture 통과를 이러한 항목의 완료로 표시하지 않는다.

### 확인한 실행 근거

- Python `tester` 프로필: `20260914T041145Z-2604583b` 통과. 실제 호스트/격리 API·LAN WebSocket과 모바일 Chromium/WebKit 검사를 포함한다.
- USB iPhone 13 Pro Max: 33개 native/WKWebView 확인 항목 통과. 휴대폰에서 검사 실행 후 Mac Python과 같은 `20260914T042019Z-4b193355` 통과 결과를 대조했다. 기존 워크룸 입력·종료·앱 복귀·QR 없는 재연결·명시 해제도 포함한다. 별도 테스트 앱은 종료 후 제거했다.
- iOS core: native 회귀 11개 그룹, 실제 Swift↔Bun pairing/조회/재연결/취소 계약 통과.
- 인터넷 포털 production 번들 생성 통과. 이는 실제 개인 relay나 TestFlight 배포 완료와 별개다.
- 최종 `bun run verify`: Python 34개, Bun 4,284개, Rust 58개, TypeScript/sidecar 컴파일 통과. 기존 터미널 fake DOM이 테스터 UI까지 초기화하던 결합은 초기화 영역을 분리해 해결했고, 입력·세션 전환 18개 회귀를 유지했다.
- 인터넷 암호화 envelope의 tester 지원 확인·동일 요청 ID 보존, 기존 모바일 로그인 복구·기록·저장·프로젝트 생성 browser suite 통과. 소스 없는 compiled sidecar+번들 템플릿의 실제 Python 실행도 통과했다.
- 설치 Mac 확인에서 runtime의 AI 추천 이름과 실제 프로젝트 상세 이름이 달라 혼동되는 문제를 발견했다. Control은 등록된 프로젝트 이름을 사용한다. 프로젝트 테스터 열기는 펼침과 해당 위치로 이동을 함께 수행하며, 같은 프로젝트를 다시 열어도 적용한다. 실제 API의 서로 다른 name/aiName 및 Chromium/WebKit의 반복 열기·스크롤 회귀를 추가했다(프로젝트 화면 총 18개 시나리오).
