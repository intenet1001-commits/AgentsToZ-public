# 사용자 스크린샷 후 등록 안내 개선 — 2026-11-02

사용자 이미지에서 1호의 Viewer에 커뮤니티 목록과 선택한 3호의 등록 안내가 표시되는 것을 확인했다.
이는 실제 등록·연결·조작 성공의 증거는 아니다. 원래 안내는 상대를 B라고 부르고 근거리 검색을 무기한 표시했다.

## 구현

- 선택한 기기 이름을 제목에 표시하고 제품 문구의 B를 상대 Mac으로 바꿨다. 실제 등록 단계는 선택한 등록 창의 이름·코드로 확인한다.
- 상대 Screen 준비 세 단계, Screen 업데이트가 필요한 경우, 각 Mac에서 직접 하는 선택·인증을 먼저 설명한다.
- 처음 등록은 근거리 방식이고 인터넷 최초 등록은 아직 미지원임을 표시한다. 안내를 여는 것만으로 검색하지 않는다.
- 명시적인 「등록 창 찾기」 뒤 최대12초 검색한다. 종료·닫기 때 브라우저와 마감 작업을 취소하고 이전 검색의 늦은 결과를 버린다.
- 결과가 없으면 로컬 네트워크 접근·근거리·상대 등록 창을 확인하도록 안내하고 다시 찾기를 제공한다.
- 많은 검색 결과는 높이180pt의 스크롤 안에 표시한다. 닫기·취소는 Esc도 지원한다.
- OPS 접미사는 표시용으로만 줄이고 원래 이름은 보존한다. 응답 시각은 한국어 연월일·시분을 사용한다.
  갱신하지 않는 창에서 상대 나이(예: 2분 전)가 낡지 않도록 실제 응답 시각을 표시한다.
- 계정·등록 키·권한·휴대폰 프로토콜4·Mac 조작 출시 관문은 바꾸지 않았다.

## 검증과 QA

- 제품 소스 `4c5c4ea4`, 브랜치 `codex/remote-completion-20261101`.
- 최신 소스의 전체 Swift **150 pass / 0 fail**, 관련 Bun **17 pass / 0 fail**.
- 네이티브 공통 실행 경로에 ViewerCommunityChecks와 ViewerUITests를 추가했다. 실제 네트워크·키체인·입력 없이 가짜 스트림과 오프스크린 뷰만 쓴다.
- native 프로필(ios-preflight·ios-core) PASS: `20261102T041926Z-1e44efe2`, source `74b6e7b7`, source unchanged.
- 관련 remote-controller·low-vision-user 페르소나 PASS: `20261102T042137Z-f9e0e484`, source `74b6e7b7`, source unchanged.
- 이후 변경은 응답 시각 표시와 해당 Swift 검사뿐이며 전체 Swift·관련 Bun을 다시 통과했다.
  이번 UI 변경 후 저장소 전체 verify는 다시 실행하지 않았다. 이전 전체 verify의 근거와 범위는 COMMUNITY-VIEWER 기록을 따른다.
- QA **0.0.4**, Apple 공증 Accepted `1868889a-1834-4730-83cd-e238e7fe67e6`. 양쪽 strict codesign·스테이플·Gatekeeper 확인.
- ZIP SHA-256 양쪽 일치: `3e249eb4765e4fac0f7bb06c3e39d2fd74c46b9ee157b402b62e849a4000e14e`.
- 3호: `/private/tmp/agentstoz-viewer-guidance-final-20261102.QgoxCZ/AgentsToZViewer.app`, PID17064.
- 1호: `/private/tmp/agentstoz-viewer-guidance-final-20261102.ZiWNdd/AgentsToZViewer.app`, PID46591.
- 기존 설치 앱은 교체하지 않았다. 목록에는 실제 회원 조회의 일회성 발견 파일을 전달했다. 기존 설치 사이드카의 자동 갱신 검증은 아니다.
- CUA의 기존 Viewer 접근 거절을 우회하지 않았다. 새 실제 버튼을 대신 누르거나 사람의 화면 세션을 시작하지 않았다.

로컬 증거·검증 로그·격리 렌더 PNG:
`/Users/cs-work/forcs/AgentsToZ_byCS/tests/results/remote-continuation-20261102/viewer-guidance/`.

## 실제 기능의 남은 부분

커뮤니티 참여와 화면 등록을 연결하는 인터넷 최초 등록은 구현되지 않았다. 현재 안내 개선이 그 기능을 대체하지 않는다.
상대 Screen 업데이트·신원 결속·필요한 경로·사람 승인·S-M3와 푸시 관문도 COMMUNITY-VIEWER 기록대로 남아 있다.
향후 인터넷 등록은 커뮤니티를 발견 통로로 사용하되, 상대 Screen 신원과 등록 의도를 확인하고 기존 SAS·생체 승인·핀 키·해제 경계를 유지해야 한다.
이름 일치나 DB의 회원 행만으로 화면 권한을 발급하지 않는다. 미확정 등록은 자동 재전송하지 않고 원래 시도의 상태를 확인해야 한다.
