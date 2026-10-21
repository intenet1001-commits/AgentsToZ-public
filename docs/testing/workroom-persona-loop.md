# 워크룸 실기 페르소나 개선 루프

프로젝트의 **테스터 에이전트 → 개선 시나리오 · 관측과 재확인**에서 관측, 수정 내용,
재확인 결과를 같은 사용자 관점·상황에 이어 남긴다. 기존 프로젝트 테스트 화면에 붙으며
화면을 여는 것만으로 AI 호출이나 테스트·기기 제어를 실행하지 않는다.

- 한 기록에는 사용자 관점, 상황, 기대 동작, 기기, 검증 환경, 확인한 버전, 핵심 내용만 남긴다.
- 설치 앱, 격리 실기 앱, 격리 브라우저를 구분한다. 관측의 “동작이 명확함”은 자동 검사 PASS가 아니다.
- 같은 상황은 최초 시각과 누적 횟수를 보존하고 최근 6개 이벤트를 보여 준다. 다시 문제를 관측하면
  재확인 결과를 해제하고 관측 단계로 돌아간다. 요청 영수증·revision으로 유실 응답의 중복을 막는다.
- `.agentstoz/maintainer/improvements.json`에 프로젝트별 로컬 저장한다. Git·장기기억·클라우드 백업에는
  자동 포함하지 않는다. 최대 256개 상황·1 MiB이며, 한도에서는 새 기록을 거절하고 기존 데이터를 보존한다.
- 모바일의 기존 테스트 실행 권한으로 기록 쓰기 권한을 늘리지 않는다. 휴대폰의 실기 관측은 연결한
  Mac의 이 화면에서 정리한다. 원본 스크린샷·긴 로그·개인정보·인증 정보 대신 간결한 근거를 남긴다.

## 반복 절차

1. 빈 목록의 첫 업무, 재방문 대화, 권한 미허용, 연결 교체·응답 유실을 실제 사용자 여정으로 고른다.
2. 문제를 관측하고 기기·환경·소스 지문을 남긴다. 화면 검증과 실제 AI·relay 검증을 구분한다.
3. 결함을 재현하는 회귀 검사를 추가하고 수정한다.
4. 같은 기기에서 재확인한 뒤 간결한 결과를 이어 기록한다. 확인 불가·혼동이 남음도 그대로 남긴다.
5. `python3 scripts/agentstoz-maintainer.py run --root . --profile workroom-improvement`와
   `python3 scripts/agentstoz-maintainer.py personas run --root .`을 실행한다.
6. 역할·여정의 빈 곳은 `personas propose`로 제안한다. 기존 검토 단계를 거친 뒤 활성화하며,
   초안과 실기 관측을 자동 테스트의 통과로 계산하지 않는다.

## 설치 앱을 건드리지 않는 실기 환경

`bun mobile/ios/scripts/workroom-persona-host.ts <state.json>`은 사설 LAN과 loopback의 임시 포트에서
실제 React 컴포넌트·thread service·tester host를 격리 저장소로 실행한다. 실제 CLI·개인 프로젝트·
기존 연결은 쓰지 않는다. state에는 번들·관련 소스의 SHA-256, 빌드 시각이 들어간다.
서버를 종료하면 임시 저장소도 제거되므로 증거와 간결한 관측을 먼저 보존한다.

- Mac: `bun scripts/prepare-workroom-persona-mac.ts <state.json>`이 반환한 전용 `.app`을 열어
  실제 클릭·입력·재개·기록 재조회 후 “증거 저장”으로 JSON·PNG를 보존한다.
- iPhone: `prepare-workroom-persona-device.ts <CoreDevice ID> <격리 서명 template.app> <서명 identity> <state.json>`은
  **com.intenet.agentstoz.workspacetest**만 설치한다. 기존 배포 앱이나 TestFlight를 교체하지 않는다.
  WKWebView 시나리오가 task-created, permission-required, resumed, record-reloaded 근거를 Documents에 쓴다.
  `nativeTouch:false`는 실제 기기의 렌더링·WebView 실행이고 손가락·네이티브 키보드 자동화는 미검증이다.
  `PERSONA_NATIVE_INTERACTIVE=1`이면 자동 클릭 없이 실제 입력을 최대 10분 관측한다.
  사용자가 새 업무를 작성·전송한 뒤 trusted pointer·키보드 입력 이벤트와 생성된 업무를 함께 확인해야
  `manual-task-created`, `nativeTouch:true`를 기록한다. 입력 내용 대신 이벤트 횟수만 관측한다.
- 선택형 Appium: `PERSONA_DEVICE_UDID`, `PERSONA_WDA_DERIVED_DATA`를 명시하고
  `workroom-persona-device-ui.py create|inspect|journey|close`를 쓴다. 자신이 만든 세션만 종료한다.
  WDA 초기화 실패는 환경 차단으로 남기고 기능 통과로 계산하지 않는다.

증거는 무시되는 `mobile/ios/build/workroom-persona-device/`에 보존한다. 종료 후 자신이 만든
서버·창·테스트 번들만 정리한다. 정식 설치·배포 검증은 이 결과와 별도의 단계다.
