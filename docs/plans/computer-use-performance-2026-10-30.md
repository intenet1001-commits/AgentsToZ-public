# 컴퓨터 유즈 성능 개선 계획과 검증

목표는 3호 설치 앱의 반응을 직접 확인하고 사용하지 않는 조회 비용을 줄이는 것이다. 승인·TCC·동작 직전 검증·미확정 결과의 사람 검토는 유지한다.

## 순서

1. Codex 컴퓨터 제어로 현재 버전과 대기 상태를 확인하고 실행 중인 팀을 보존한다.
2. 패널의 초기 조회·새로고침·범위 전환을 실제 React 화면으로 재현하고 네이티브 목록 호출 수를 기록한다.
3. 전체 Mac은 목록을 조회하지 않고 앱과 한 창은 해당 목록만 조회한다.
4. 느린 응답 중 범위 전환·닫기·재열기와 승인·회수 흐름을 Chromium/WebKit 격리 화면에서 검사한다.
5. 정상 프로필·설정 페르소나와 관련 회귀를 실행하고 설치본 결과와 구분한다.

## 기준선

ComputerUsePanel.refresh(true)는 상태 확인 뒤 catalog와 scope-catalog를 순서대로 요청한다. v2 기본 전체 Mac 화면은 두 목록을 사용하지 않는다. 개선 전 설치 앱의 scope-click 미확정 항목은 사람의 직접 검토가 필요했다. 1577 설치 후 실기 결과는 아래에 기록한다.

## 출하와 후속

1577(3c567c2a)의 본 앱과 Control을 Developer ID 서명·공증·staple 후 설치했다. 실행 중인 Control·본 앱 소유 sidecar의 코드 해시도 설치 파일과 대조했다. 사람이 승인한 시험 세션 bca06f3b-189f-4297-b1d8-69bef946066b만 종료했고, 나머지 50개 프로젝트에서 실행 중인 Workroom이 없음을 확인했다. 팀 team_8d47fbd8e423의 보고·워크트리·.claude는 보존했다.

## 적용한 개선과 근거

| 사용자 여정 | 기존 목록 RPC | 수정 후 목록 RPC |
|---|---:|---:|
| 전체 Mac 패널 열기·수동 새로고침 | 창 1 + 앱 1 | 0 |
| 앱 범위 목록 준비 | 창 1 + 앱 1 | 앱 1 |
| 한 창 범위 목록 준비(v2) | 창 1 + 앱 1 | 창 1 |

이는 격리 React 화면에서 관측한 호출 수다. 실제 OS 조회 시간, CPU 사용률, 클릭 지연의 향상률은 측정하지 않았다. 느린 목록 응답 중 바뀐 범위는 마지막 요청 1개만 이어 처리하며 패널을 닫으면 대기를 폐기한다. 새 권한 요청·동작 직전 검사와 기존 미확정 작업은 이 최적화에서 변경하지 않는다.

수정 전 전체 Mac의 불필요한 2개 목록 호출로 화면 회귀가 실패했고 수정 후 통과했다. Chromium/WebKit 각각 1100px·390px에서 범위 선택, 네이티브 검토, 회수, 복구, IME·포커스, 느린 응답 중 범위 전환·닫기를 검사했다. 타입 검사와 정상 검사 native-workflow-foundations(20261030T060141Z-1db2b292, 125.854초)도 통과했다.

## 1577 설치본 실기

사람이 이전 복구 항목을 검토하고 Control에서 현재 Codex 연결에 전체 Mac을 승인했다. 새 observe·capture는 성공했고 Calculator를 focus-app으로 활성화한 뒤 전면 앱을 새 관찰로 확인했다.

왼쪽 클릭 1회(requestId: 1577-click-calculator-eight-2d249e5d)로 Calculator 표시가 7에서 78로 변했다. 독립된 Codex 컴퓨터 유즈의 읽기 전용 AX 관찰로 결과를 확인했다. 하지만 즉시 반환된 영수증은 human-takeover / human-active이고 owner는 human이었다. 실제 입력 효과는 관측됐지만 정상 완료는 실패했다. 이후 같은 requestId의 영수증 조회는 grant 부재로 거절됐고 상태의 grant 목록은 비어 있었다. 실제 클릭을 재전송하거나 다른 ID로 반복하지 않았다. 상세 설치·실기 근거는 /private/tmp/agentstoz-cu-performance-install-1577.json에 있고 권한 토큰은 넣지 않았다.

.cgSessionEventTap 변경으로 HID 자기 오인이 해결됐다는 결론은 내릴 수 없다. 사람의 실제 개입과 합성 입력의 OS 활동 반영을 현재 human-active 코드만으로 구분할 수 없다. 관찰 시점에 HID 유휴 60.494초를 병렬 측정한 observe는 성공했으므로, 별도 시점의 유휴 값으로 지속적인 거짓 거절을 단정하지 않는다.

## 진단 보강과 다음 검사

- 최근 입력 시간 검사는 human-active-idle, 관찰 이후 물리 카운터 변화 검사는 human-active-events로 구분한다. 1.5초 기준·비유한 값 거절·정확한 카운터 비교·중단·직접 복구 검토는 그대로다. 이 코드도 이벤트의 실제 출처를 증명하지 않는다.
- fake sink 검사는 선택한 전송 지점과 down/up 균형만 증명한다고 명시했다. 실제 HID 오염이 없다고 가정하는 모델은 제거했다. 실제 동시 입력에 대한 중단·버튼 해제 회귀는 유지한다.
- 정상 검사 native-workflow-foundations는 20261030T070031Z-4a5822e1, 105.042초로 통과했다. 유휴 경계·NaN·무한대·변경 카운터 거절과 제한된 진단 코드의 영수증 전달을 검사한다.
- 진단 변경의 서명 설치본에서 사람이 새 범위를 직접 승인한 뒤, 이전 클릭과 별개의 시험 1회를 관찰·영수증과 대조해야 원인을 더 좁힐 수 있다. 기존 클릭은 반복하지 않는다.
- 관찰·캡처의 p50·p95, 1호 Orca 전체 여정과 외부 리더 입력 권한은 완료 근거가 더 필요하다. 권한 검사를 캐시하거나 사람 입력 감지를 완화해 통과시키지 않는다.

## 최종 검증 결과

- 전체 검사: Python 사전 검사 131개, 타입 검사, Bun 9,507 pass / 12 skip / 0 fail, Rust 143 pass / 1 ignored / 0 fail. 로그는 /private/tmp/agentstoz-cu-performance-verify.log다.
- 기기 간 대화 탐색 페르소나: 20261030T060420Z-82edb497, 계약 2개·화면 1개 통과.
- 컴퓨터 유즈 운영자 역할 후보: role-35aec8e2ddb45b4a1a88, native-workflow-foundations에 연결할 후보로 저장했으며 활성화하지 않았다.
- 시험 세션 종료는 사용자의 해당 세션 명시 승인 후 완료했다. 팀·워크트리·미추적 .claude 파일은 삭제하지 않았다.

## 진단 보강본 출하 전 검사

- 전체 필수 검사 재실행: Python 131, 타입 검사, Bun 9,507 pass / 12 skip / 0 fail, Rust 143 pass / 1 ignored / 0 fail. 로그: /private/tmp/agentstoz-cu-diagnostic-verify.log.
- Swift 전송 회귀 10개 통과. fake sink로 이벤트를 수집하며 실제 입력을 보내지 않는다. 로그: /private/tmp/agentstoz-cu-diagnostic-dispatcher.log.
- 관련 community-session-explorer 재검사: 20261030T072043Z-0c62a71c, 계약 2개·화면 1개 통과. 이는 설치본 입력 실기와 별개다.
- 제품 코드 변경은 Control의 안전 검사 진단이다. 본 앱 1577과 같은 v2 계약을 사용하므로 본 앱을 다시 교체하지 않고 Control 업데이트로 반영할 수 있다.

## 1578 실기와 가드 표본 진단 (브랜치 codex-cu-idle-diagnostic, 기준 8d2b6be3)

- 실기 사실: 본 앱 1577·Control 1578에서 계산기 9 왼쪽 클릭 1회(1578-click-calculator-nine-1793346935277)로 78→789가 한 번 반영됐다. 즉시 영수증과 같은 ID 재조회 모두 human-takeover / human-active-idle이었고 호스트가 halt(epoch 2)했다. 입력 전 새 관찰·캡처를 받았고 앞선 stale-observation 요청은 performed:false로 전송 전 거절됐다. 확정은 최근 입력 유휴 검사의 거절뿐이다.
- 코드로 좁힌 것: down 전 가드가 거절하면 아무것도 보내지 않으므로, 효과와 takeover가 함께 있다는 것은 down 전 가드 통과 → down 전송 → down·up 사이 가드의 유휴 검사 거절 → 해제용 up 전송이다. 그 가드는 유휴를 카운터보다 먼저 보므로 카운터 결과는 모른다. 그 구간의 알려진 사건은 우리 down 하나라 자기 합성 입력 귀속과 맞지만, 사람·다른 자동화 입력이나 커서 이동 부작용을 배제할 근거가 없다. 원인은 미확정이며 판정 코드는 고치지 않았다.
- 진단: Control이 동작마다 표본을 최대 3개 영수증 선택 필드 guardSamples에 싣는다 — before(첫 이벤트 직전), after(이벤트 뒤 마지막 가드 시작), refusal(첫 거절 순간). 읽기는 이벤트 뒤 가드마다 일어나 마지막 값만 after로 남으므로 키 조합·드래그는 3번보다 많이 읽는다(드래그 최대 13번의 after 읽기). 해석은 조건부 관찰이며 출처를 확정하지 않는다. 값은 idleMs(상한 600000, 비정상 -1), sincePostMs(이벤트를 넘기기 직전부터, 상한 60000), counters(관찰 대비 바뀐 종류만, 1~99 또는 감소 -1, 읽지 못하면 null)뿐이다. 좌표·키·문자·화면·토큰은 없다. 판정·1.5초 기준·카운터 정확 비교·halt·복구 행·같은 ID 재전송 금지는 그대로이고, 본 앱 호스트는 정해진 모양이 아니면 필드를 통째로 버린다.
- 배포 범위: 실기에서 에이전트 영수증으로 보려면 본 앱과 Control을 모두 이 변경으로 바꿔야 한다. 표본은 Control이 만들지만 1577 본 앱 사이드카의 computerUseScopeHost.ts는 영수증을 requestId·state·reason으로 새로 만들어 이 필드를 버린다. Rust 브리지(computer_use_bridge.rs)는 응답 객체를 그대로 넘긴다. Control만 교체하면 새 진단은 전달되지 않는다. 서명·공증·설치는 수행하지 않았다.
- 한계: 진단을 더한 것이지 원인 해결이나 성능 개선이 아니다. fake sink·모델 OS 회귀는 표본이 판정과 전송 순서를 바꾸지 않음을 증명할 뿐 실제 HID 동작을 증명하지 않는다. 표본 읽기는 가드 전에 OS 값을 한 번 더 읽으므로 down·up 사이 시간이 그만큼 늘 수 있다. 어떤 값도 사람과 합성 입력의 출처를 증명하지 않는다.
- MCP 계약: 새 외부 영수증 필드이므로 AGENTSTOZ_USE_MCP_CONTRACT_VERSION을 1.70.0에서 1.71.0으로 올렸다. 파라미터·권한·입력 의미는 바꾸지 않았다. 올리기 전 로컬·원격 브랜치와 등록 워크트리에서 1.71.0 이상 사용이 없음을 확인했다.
- 검사(로그는 세션 scratchpad logs 폴더 /private/tmp/claude-501/-Users-cs-work-orca-workspaces-AgentsToZ-byCS-codex-cu-idle-diagnostic/366514ea-60c1-4185-90ae-9bb1ec8a891d/scratchpad/logs/):
  - Swift 전체 69/69(신규 5개 포함), 최종 Swift 소스 기준 18:32 실행, swift-final.log. Control 코어 검사 36/36, core-final.log.
  - 정상 quick 20261030T090634Z-57d523b0: 58개 중 55 통과·1 실패·2 차단. native-workflow-foundations 통과(125.286초), common-memory-personas(공통기억 4관점) 통과. 실패한 workroom-number-keys-screen은 하위 remote-phone-layout의 chromium 390×844 alert 단계 15초 대기 초과였다. 이 검사의 경로와 이번 변경은 겹치지 않고(바꾼 호스트는 서버 쪽 모듈) 단독 재실행 20261030T093020Z-e6486100은 통과했으므로 재현되지 않은 일시 실패로 기록한다. 차단 2개는 미리 빌드한 output/workroom-browser-native*/app.app 번들이 이 워크트리에 없기 때문이다.
  - 페르소나: quick에서 돈 4관점을 빼고 나머지 12관점만 20261030T093311Z-f30b6367로 실행해 67개 검사 모두 통과. 합쳐서 설정된 16관점 전부 통과. 새 후보는 만들거나 활성화하지 않았다.
  - bun run verify(버전 올리기 전, 18:50–19:09): Python 131, 타입 검사, Bun 9,508 pass / 12 skip / 0 fail, Rust 143 pass / 1 ignored / 0 fail. verify.log.
  - 버전을 올린 뒤 2차(19:10–19:27, verify2.log): Bun 9,507 pass / 1 fail에서 멈춰 Rust 단계는 돌지 않았다. 실패한 것은 What-I-said transcript collector의 "new files do not reset the rotating start…" 5초 제한 초과(5026ms)였다. 그 테스트 번들의 입력 7개는 기준 커밋과 바이트가 같고 바뀐 모듈을 포함하지 않는다. 단독으로 3번 돌려도 5068~5144ms로 실패했으며(부하 평균 6.5~8), 이번 변경과 무관한 시간 경계 실패로 분리한다. Rust만 따로 돌려 143 pass / 1 ignored / 0 fail(rust-after-bump.log).
  - 같은 최종 트리로 3차(19:29–19:48, verify3.log): Python 131 OK, 타입 검사, Bun 9,508 pass / 12 skip / 0 fail, Rust 143 pass / 1 ignored / 0 fail.
- 남은 실기(사람이 해야 하는 단계, 이 작업에서는 하지 않았다):
  1. 이 커밋으로 본 앱과 Control을 모두 Developer ID 서명·공증·설치한다. Control만 바꾸면 guardSamples가 에이전트에게 오지 않는다.
  2. 사람이 1578 복구 항목을 직접 검토해 닫는다.
  3. 강제 종료 창 등 보호 창을 닫고, 시험 동안 입력 장치에서 손을 떼며 Codex 자체 컴퓨터 유즈 등 다른 자동화를 동시에 돌리지 않는다.
  4. 사람이 Control에서 Touch ID로 새 범위를 승인한다.
  5. 아젠투지 컴퓨터 유즈(Codex 자체 컴퓨터 유즈가 아니다)로 observe → capture → 새 requestId로 단일 클릭 1회 → 즉시 영수증과 같은 ID 영수증을 읽는다. 재시도·재전송하지 않는다.
  6. guardSamples를 docs/claude/computer-use.md의 조건부 관찰 ①~④로 읽는다. 한 번의 결과로 원인을 정하지 않고, 같은 조건의 반복이 필요하면 각 시도를 새로 승인받는다.
  7. 그 뒤에 수정 방향을 정한다. 예로 자기 이벤트를 구별하는 listen-only HID 탭은 입력 모니터링 TCC 권한과 별도 승인이 필요하다.
  8. 마지막으로 1호 Orca 전체 업무와 관찰·캡처 p50·p95 성능을 비교한다.
