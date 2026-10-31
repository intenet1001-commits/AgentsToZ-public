# Codex 독립 검토 기록

구현 담당은 별도 워크트리의 Claude Code(cmux), 검토·관찰 담당은 현재 Codex다.
기준은 `da76c299` / build 1619이며, 구현 파일과 사용자 입력을 서로 덮어쓰지 않는다.

## 검증 범위

- 변경 전 기준선: `bun run verify` 성공. Python 131 pass, TypeScript 오류 0,
  Bun 9614 pass / 12 skip / 0 fail, Rust 143 pass / 1 ignored / 0 fail.
  로그: `/tmp/helpdesk-plan-baseline-verify-20261031.log`.
- 위 결과는 새 기능의 통과 판정이 아니다. 구현 후 정규 프로필·페르소나·빌드와
  실제 화면 검증을 별도로 수행해야 한다.
- 아래 모의 드라이버·격리 DB 재현은 실제 컴퓨터유즈나 OAuth 성공의 증거가 아니다.
- 구현 후 필수 검사의 실제 로그도 읽었다. `VERIFY_EXIT 0`: Python 131 pass,
  TypeScript 오류 0, Bun 9658 pass / 12 skip / 0 fail(1093 files),
  Rust 143 pass / 1 ignored / 0 fail. 프론트엔드 `BUILD_EXIT 0`(6.02초).
  로그는 Claude 작업 scratchpad의 `verify.log`, `build.log`에 있다.
  정규 프로필·구성된 페르소나·네이티브 실기는 아래 별도 범위로 판정한다.

## R1 · 한글 선택자와 준비 단계

- 최초 `applicationType` 정규식의 ASCII `\b` 때문에 `Application type`만 일치하고
  `애플리케이션 유형`, `어플리케이션 유형`은 일치하지 않았다.
- Claude가 Unicode 경계로 수정한 뒤 세 이름 모두 일치함을 재확인했다.
- `만들기` 버튼이 처음부터 보여도 유형 선택·입력 준비는 계속해야 한다.
  확정 버튼은 사람에게 넘긴다. 해당 화면 회귀는 구현 담당이 추가한다.
- Ego 출력은 전체 수신 뒤 자르는 방식 대신 수신 중 제한해야 한다.

## R2 · 탐색 후 이전 화면의 선택자 사용

- 최초 구현을 격리 fake-host로 검사했다. `observe()` 다음에 자동 탐색으로
  owner·epoch·URL·observationId가 바뀌면, `click(oldRef)`가 새 grant와 관찰을
  자동 취득한 뒤 이전 선택자로 클릭했다.
- 재현: resumeCount 2, clicks 1, 새 URL `https://accounts.google.com/signin`.
  기대 결과는 새 허용 관찰 전 클릭 0회다.
- 원본 `/tmp/helpdesk-review-owned-stale-20261031.ts`.
  당시 브라우저 모듈의 U+2028/U+2029 구문 오류만 임시 복사본에서 이스케이프한
  실행본은 `/tmp/helpdesk-review-owned-stale-isolated-20261031.ts`다.
  Codex가 Claude 소스를 수정하지 않았다.
- 실제 Page.navigate 직전의 대기열 takeover 재검증도 요청했다.
- 수정 후 실제 driver를 `/tmp/helpdesk-review-owned-stale-current-20261031.ts`로
  재검증했다. `refused`, clicks 0, resumeCount 1로 이전 선택자 dispatch가 거절됐다.
- 추가 발견: Host가 매 단계 다시 호출하는 `attach(runId)`가 사람 input 기준을
  현재 값으로 초기화했다. 사람 입력 뒤 같은 run을 다시 attach하면 `settle`이
  agent를 반환하고 `observe`가 다시 제어를 취득했다.
  `/tmp/helpdesk-review-owned-reattach-20261031.ts`로 재현하고, 동일 run/workspace
  attach의 멱등성과 명시적 takeBack만 input 기준을 초기화하도록 요청했다.
- 반복 attach 수정도 같은 재현에서 `settled: human`, `AssistHumanControl`,
  resumeCount 0으로 확인했다. 사람 입력 뒤 관찰을 자동 취득하지 않았다.
- 상태: 두 재현의 수정 재검증 성공. 정규 회귀 테스트 대기.

## R3 · 취소 후 늦게 도착한 상태 검사

- 실제 Host·Store 모듈과 격리 SQLite, 지연 verifier로 재현했다.
- prepare → start → advance 검사 대기 → 최신 revision으로 cancel 성공 →
  지연 검사 완료 시, `cancelled`가 `assisting`으로 다시 저장됐다.
- 재현 `/tmp/helpdesk-review-cancel-race-20261031.ts`.
- 모든 비동기 결과의 원래 실행·상태·단계 결속, 중복 진행 요청 방어를 요청했다.
  기록 수 제한에서도 미완료·불확정 실행을 삭제하지 않도록 함께 요청했다.
- Claude 수정 후 같은 지연 verifier 재현을 다시 실행했다. cancel 응답,
  지연 advance 응답, 최종 저장 상태가 모두 `cancelled`로 유지됐다.
- 상태: 이 재현의 수정 재검증 성공. 다른 비동기 경로·정규 회귀 테스트 대기.

### R3b · 정리 작업을 기다리는 동안의 취소·중지

- 추가 재현: `driver.finish()`를 지연한 동안 cancel을 요청해도 상태가 아직
  assisting이었다. 같은 revision으로 advance가 먼저 진행하면 cancel의 CAS가
  거절되고 assisting으로 남았다. `/tmp/helpdesk-review-cancel-cleanup-20261031.ts`.
- Claude가 명시적으로 파일 소유권을 넘긴 뒤 Codex가
  `src/helpdeskAssistHost.ts`와 `tests/helpdesk-assist-control-races.test.ts`만 수정했다.
  완료 후 소유권을 Claude에 반환했다. 다른 구현 파일·기존 테스트는 변경하지 않았다.
- 상태/generation을 정리 전에 저장하고, 실행별 handoff/finish를 순서대로 처리한다.
  정리 중 재개·재연결·새 시작을 거절한다. cancel은 대기 중인 pause를 종료할 수 있다.
  heartbeat와 정상 완료에도 같은 경계를 적용하고, 취소 뒤 추가 provider 검사는 시작하지 않는다.
- 새 회귀 6개: 수정 전 0 pass / 6 fail → 수정 후 6 pass / 0 fail, assertions 27.
  로그 `/tmp/helpdesk-control-races-before-20261031.log`,
  `/tmp/helpdesk-control-races-after-20261031.log`.
- 원래 cleanup 재현도 cancel 응답·저장 상태가 cancelled, 중간 advance는 거절됨을 재확인했다.
- `bun run typecheck`도 exit 0. 로그 `/tmp/helpdesk-control-typecheck-20261031.log`.
- 상태: 국소 수정·회귀·타입 검사 성공. Claude가 두 테스트 파일을 합쳐 검사하고 있다.

## 실제 화면 시험

- 설치 앱의 화면에서 build 1619 / `da76c299`를 확인했다.
- 후속 Codex CUA의 AX 관찰에서는 설치 앱이 `1621.0.0 / bb804634`, 빌드 시각
  `2026-10-31 14:42:32 KST`, 원격 기본 브랜치 검증됨으로 바뀌었다.
  이 작업에서 설치 앱을 교체하지 않았다. 개발 브랜치는 사용자가 지정한 1619 기준이며,
  이후 실기 결과는 실제 실행 버전·연결 ID와 따로 결속해야 한다.
- Claude의 `CU_READY_FOR_CODEX_OBSERVER` 대기 중이다.
- Claude 연결의 사람 승인과 시험 대상 확인 후, Claude만 입력하고 Codex는
  독립 컴퓨터유즈로 화면을 관찰한다. 로그인·비밀값·승인 화면은 사람이 처리한다.
- 아직 AgentsToZ 컴퓨터유즈 실기 통과, 실제 OAuth 완료, 기본 앱 설치·교체를
  수행하거나 성공으로 판정하지 않았다.
- 사용자가 켜짐 상태라고 알려준 뒤 새 MCP status를 읽었다. access.enabled=true,
  scope.kind=desktop, grants/pending 없음으로 확인했다. Codex 연결도
  `mcp_67a336c3-9172-4daf-8565-e5937947a558`로 재등록돼 있었다.
  과거 off 결과를 현재 승인 상태로 사용하지 않는다.
- 사용자가 앱에 설정해 둔 전체 Mac 범위를 AI가 변경하지 않고, Claude 연결이
  현재 설정의 승인 요청만 생성해 Control에서 사람이 범위를 보고 직접 서명하도록 진행한다.
  실제 입력 대상은 격리 Chrome 시험 창으로 제한하고, 유효 grant 확인 전에는 입력하지 않는다.

## R5 · Supabase 검사 응답의 실제 계약

- 기준선 `PlatformCliHost.check()`는 Supabase의 `projects list`가 JSON 배열이면
  성공으로 처리하며 `identity: null`을 `PlatformCliStore.checked()`에 넘긴다.
- 새 verifier는 모든 provider에서 `checked.identity`가 있어야 성공하도록 작성돼,
  정상 Supabase 응답도 항상 `계정 신원을 읽지 못했습니다`로 실패했다.
- `/tmp/helpdesk-review-supabase-verifier-20261031.ts`로 새 verifier의 동작을 재현했다.
  이 검사는 실제 Supabase 로그인·네트워크 검사가 아닌 응답 계약 재현이다.
- 서비스별 검사 의미와 계정 id/provider/state, 기존 공식 로그인 신원 근거를
  결속하도록 요청했다. 프로젝트 목록 접근 성공을 새로운 신원 확인으로 표시하지 않는다.
- 수정 뒤 같은 응답 계약 재현은 `ok`로 바뀌었다. 상세 문구도 프로젝트 목록
  접근과 기존 공식 로그인 이메일 근거를 구분한다. 정규 연결 회귀 결과 검토 대기.

## R6 · AI 런타임 호환성과 인증·응답의 구분

- API 초기 연결은 Codex의 `resolveReadOnlyVerifiedAgentRuntime()` 성공을 AI ready로
  간주해 로그인과 실제 연결 검사를 통과시켰다.
- 이 경로의 `inspectCodexAgentRuntimeCompatibility()`는 초기화·모델 목록·설정·
  임시 thread 시작과 해제만 검사한다. 공식 로그인 상태나 모델 turn 응답 증거는 없다.
- 기존 공식 로그인 검사 결과를 사용하고, 설치·호환성·인증·실제 응답의 표시와
  완료 근거를 구분하도록 요청했다. 로그아웃 상태와 호환성 성공이 공존하는 회귀도 요청했다.
- Claude의 기존 `check()`도 인증 상태와 CLI 옵션 지원을 검사하며 모델 응답 검사는
  아니므로 같은 구분을 적용한다.
- 수정 후 API는 기존 Codex 로그인 효과의 공식 probe를 사용한다. verifier는 로그인
  상태만 확인하고, 실제 모델 응답을 시험하지 않은 connection은 unknown으로 남긴다.
- 상태: 해당 소스 경로와 표시 의미 수정 확인. 정규 회귀 근거 통합 검토 대기.
  별도 AI 응답 호출을 Codex가 시작하지 않았다.
- Claude가 기존 제한 실행으로 비밀 없는 합성 후보 2개를 고르는 planner smoke를
  1회 실행했다. check=ready, 실제 응답 choice=1, parsePlannerReply 결과 choice=0,
  약 10.9초로 기록됐다. 이 결과는 planner 실행 경로만 확인하며 실제 CEF/OAuth 근거가 아니다.

## R7 · 시간 초과 때 stdout을 물려받은 하위 프로세스

- 새 Ego runner를 실제 앱 대신 임시 셸 fixture로 검사했다. 셸은 자신이 만든
  2초 sleep 자식을 기다리고, stdout pipe는 자식에게도 상속된다.
- timeout 500ms / grace 100ms에서 실제 반환이 2347ms 걸렸다. 직접 실행한
  부모만 종료하고 상속된 스트림의 하위 프로세스를 기다리는 경로다.
- 재현 `/tmp/helpdesk-review-ego-descendant-alive-20261031.ts`.
  실제 Ego 앱의 실행 중 결함을 확인한 결과로 해석하지 않는다.
- 자신이 생성한 프로세스 그룹/트리와 스트림만 한도 내 정리하고, inherited-pipe
  하위 프로세스 회귀를 추가하도록 요청했다. 관련 없는 프로세스는 종료하지 않는다.
- 수정 뒤 같은 fixture 재현은 elapsed 506ms, 반환 시 하위 프로세스 잔존 없음으로 바뀌었다.
- 상태: 동일 재현의 수정 재검증 성공. 실제 Ego 앱의 종료·취소 실기는 별도 확인 대상이다.

## R8 · 긴 진행 요청 중 중지와 로그인 뒤 잘못된 후속 요청

- 첫 UI는 모든 요청을 하나의 busy/lock으로 처리해서, 긴 advance 중에 중지·직접 하기·취소까지
  비활성화했다. 로그인 account link가 이미 다음 단계로 옮긴 뒤에도 human-done을 보내는 경로도 있었다.
- Claude가 별도 진행·제어 경로와 revision 순서 방어를 추가하고, 같은 app 단계에 대기 중일 때만
  human-done을 보내도록 수정했다.
- 소유권 ACK 후 Codex가 새 화면 검사 3개 파일을 작성했다:
  `tests/helpdesk-assist-ui.mjs`, `tests/fixtures/helpdesk-assist-screen.tsx`,
  `tests/fixtures/helpdesk-assist-server.ts`. 실제 React·지원 Host·SQLite·verifier를 사용하고
  브라우저 SDK·공식 OAuth·CLI 응답만 시험용 경계로 치환한다.
- 최초 6개 화면 흐름 통과: Chromium/WebKit × 390/1120의 취소·가입·로그인·복귀 4개,
  두 엔진의 GWS 준비·직접 JSON 첨부·로그인·별도 연결 검사 2개.
  로그 `/tmp/helpdesk-assist-ui-20261031.log`, 그림 `output/playwright/helpdesk-assist/`.
- 실제 네이티브 컴퓨터유즈·공식 Google 인증·설치 CEF 성공 증거가 아니다.

## R9 · 새 프로젝트 생성 뒤 Ego 작업 공간 재개

- strict Ego ownership 경계를 둔 실제 렌더 재현에서, 사람이 프로젝트 생성을 마친 뒤에도
  step=project, state=waiting-human, projectId=null로 남았다.
- Host의 human-done이 takeBack 전에 driver.location()을 읽었다. 실제 SDK의 handOff 중
  페이지 명령 하드 스톱 계약 때문에 새 프로젝트 ID를 읽을 수 없다.
- 명시적 human-done에서 제어를 되찾고 현재 실행 결속을 재검증한 뒤 URL만 읽도록 요청했다.
  비허용·실패 주소는 다시 사람에게 넘기며 DOM·스크린샷은 읽지 않는다.
- 재현 그림 `output/playwright/helpdesk-assist/new-project-before.png`.
- 두 엔진의 새 프로젝트 흐름을 영구 화면 회귀에 추가했다. 화면 검사 담당 3개 파일은 동결했다.
- Claude가 takeBack → 실행 결속 검사 → 허용 Console URL만 읽기 → 실패 시 handOff 순서를
  반영했고 strict ownership 회귀를 추가했다. 해당 소스 수정을 확인했다.
- 기존 WebKit 실패의 단독 재현 종료 후 최종 검사를 실행했다.
  `bun --env-file=/dev/null tests/helpdesk-assist-ui.mjs` exit 0, 최종 8개 흐름 모두 통과.
  로그 `/tmp/helpdesk-assist-ui-final-20261031.log`, 결과
  `output/playwright/helpdesk-assist/results.json`의 state=completed, passed=true, results=8.
- 상태: 두 엔진의 새 프로젝트 재개를 포함한 최종 화면 회귀 통과.

## R10 · 외부 온보딩으로 복귀할 때의 문맥

- App/HelpdeskPanel 변경을 직접 읽었다. 외부 assistIntent의 onBack도 기본 chat 단계로
  돌아가 실제 호출 화면을 드러내지 않았다. 초기 마법사와 빠른 로그인 폼도 지원을 열 때
  닫혀 복귀할 입력·포커스 대상이 사라지는 경로였다.
- 외부 진입의 돌아가기는 창을 닫아 호출 화면을 드러내고, 마법사의 작성 내용과 실제
  복귀 대상을 보존하도록 요청했다. 이 관찰을 다른 정규 검사 실패의 원인으로 단정하지 않는다.
- 수정된 소스에서 caller 진입의 onBack→onClose, assist 이벤트가 마법사를 닫지 않는 것,
  QuickCliLogin이 도움을 열 때 자신을 닫지 않는 것을 확인했다.
- 상태: 소스 수정 확인. 실제 App 전체의 입력/포커스 복귀 회귀는 아직 없어 needs checks로 남겼다.

## 정규 프로필의 중간 결과

- MCP가 반환한 worker target은 `rwt_db847ceeeb6b194ff721a801e8e0dd30b53f888c0756b27c`다.
- mac-onboarding 실행 `20261031T062927Z-e30e5af3`은 검사 중 소스가 바뀌었다.
  따라서 중간 성공 항목들을 최종 통과로 승격하지 않는다.
- voice-popout-screen의 WebKit 클릭 timeout과 first-project-app-screen 실패가 관찰됐다.
  최종 동결 후 실패를 단독 재현하고 정규 결과를 다시 확인해야 한다.


## R11 · 실제 승인 버튼의 가시성

- 사용자가 localhost는 보이지만 승인 버튼은 없다고 보고했다. Codex CUA로 설치 앱의
  컴퓨터 유즈 설정을 읽어, 설명과 범위 설정 아래의 승인 대기 영역이 화면 밖에 있음을 확인했다.
  Codex는 설정 창을 앞으로 가져오고 스크롤해 버튼만 드러냈다. 검토·서명·Control 입력은 하지 않았다.
- 기존 렌더 회귀에 버튼 위치 검사를 추가하자, 1100×850에서 버튼 y=786.03, 높이44,
  패널 하단807.5로 잘려 실패했다. Playwright의 click 자동 스크롤 전에 검사한다.
- 승인 대기·요청 출처·검토 실패 문구를 고정 헤더로 옮겼다. 같은 검토 동작과 만료 판정,
  Control에서 사람이 직접 서명하는 절차는 유지했다. 390px·1100px, 높이520px,
  본문 스크롤 뒤 위치를 두 엔진으로 확인한다. 최종 결과는 별도 기록한다.
- 로컬 Vite는 경로의 worktrees 디렉터리를 감시에서 제외하므로 소스 수정 후 이 테스트 전용
  서버를 재시작하고 갱신된 모듈을 확인했다. 기존 앱·개발 서버에는 손대지 않았다.

## 실기 승인 상태와 설치본 변경

- 최초 기준은 da76c299/build1619다. 다른 작업에 의해 설치본이1621/bb804634로,
  이어1624/bb48c3ee(16:18:04 KST)로 바뀐 것을 CUA에서 읽었다. Codex는 설치하지 않았다.
- Claude 연결5350dbf7의16:11 요청은16:21:16에 만료됐다.16:26 실제 status에서 승인 없음,
  대기 없음, 컴퓨터 유즈 꺼짐과 새 MCP 연결 등록을 확인했다. 자동 완성 문장은 사람의 승인으로
  간주하지 않았다. 앱 교체와 연결 변경은 관찰했으나 연결 초기화의 정확한 원인은 단정하지 않는다.
- 시험 URL은 http://127.0.0.1:59248/?service=google-workspace, 별도 Chrome for Testing이다.
  아직 AgentsToZ의 실제 입력은 시작하지 않았다. 사람이 현재 앱에서 다시 켜고 해당 연결의
  Control 요청을 서명한 뒤, Claude 입력과 Codex 관찰을 한 동작씩 맞춰야 한다.
- 이 시험의 브라우저 SDK·OAuth·CLI는 fixture 경계다. 실제 OS 입력의 증거가 되더라도
  공식 Google 인증 또는 실제 Ego/CEF 전체 연동 성공의 증거로 확대하지 않는다.

- R11 최종 렌더 회귀: Chromium/WebKit ×1100/390 모두 exit0. 각 조합에서 최초 대기,
  본문 스크롤 뒤, 높이520px에서 CTA 전체가 패널·viewport 안에 표시됨을 검사했다.
  검토 자동 열림 없음·검토 열기만으로 승인 없음·만료·IME·포커스 회귀도 통과했다.
  로그 `/tmp/helpdesk-approval-ui-green-20261031.log`, 그림
  `/tmp/agentstoz-computer-use-panel-20261027/*-pending-short.png`.
  기존 포커스 검사의 메뉴 닫힘 가정은 실제 열린 메뉴의 opener와, 명시적으로 닫힌 메뉴의
  summary 두 경우를 각각 검사하도록 바로잡았다. 제품 포커스 코드는 바꾸지 않았다.
- 사용자가 테스트 준비를 Codex 컴퓨터 유즈로 하라고 명시했다. Codex는1624 설정의
  전체 Mac 스위치를 직접 켜고 UI의 켜짐을 확인했다. Claude의 현재 연결로 요청1회만
  보내도록 지시했다. 최종 Control 서명은 사람이 수행하며, 아직 실제 fixture 입력은 없다.


## R12 · Control 검토 창 표시의 불확실성

-16:34:15 Claude의 실제 status는 새 연결3f7dc729-ccd8-4c44-9678-2b0ba6551922,
  enabled=true, desktop, grants/pending 없음이었다. request-access1회 후 승인 대기,
  유효시각16:44:19 KST를 받았다. Codex CUA도 같은 코드의 대기 행을 확인했다.
- Codex는 앱 설정의 「승인 검토 열기」를1회 눌렀다. UI에 「승인 검토 창이 현재 화면에
  보이는지 확인하지 못했습니다」가 나타났다. Control 창이 실제로 보인다고 주장하거나
  요청을 재전송하지 않았다. 최종 인증은 사람에게 넘겼다.
- 기존 가시성 확인 실패 문구를 표시하는 경로가 실제 설치본에서도 발생한 관찰이다.
  원인을 재현해 고친 것으로 판정하지 않으며, R11의 CTA 위치 수정과 구분한다.


## R13 · 만료된 네이티브 인증이 다음 요청까지 막는 상태

- Codex는 Control의 일반 검토 창에서 원래 요청3f7dc729의 「승인…」을1회 눌러 인증 단계에 진입했다.
  인증 화면·암호는 관찰하거나 입력하지 않았다.16:44 요청은 grant 없이 만료됐다.
-16:47:27 Claude의 실제 status는 enabled desktop·grants0·pending0·secureInput false였다.
  알려진 만료 뒤 후속 request-access1회만 보내16:57:39까지인 새 대기를 받았다.
  Codex는 기존 「도우미 열기」로 서명된 고정 Control 앱 열기 경로를 실행했고, 같은 연결의
  새 대기 행과 **비활성 「승인…」 버튼**을 일반 검토 창에서 확인했다.
- 두 네이티브 service의 approve는 LAContext를 지역 변수로만 가지고 continuation이 끝나야
  approving을 비웠다.1초 refresh는 요청만 prune하고 만료된 인증 context를 invalidate하지 않았다.
  따라서 이전 인증이 끝나지 않으면 다음 대기 행도 계속 비활성이 될 수 있다. 현재 LAContext가
  가리키는 내부 ID는 외부 API로 읽지 않았으므로 화면 관찰만으로 그 ID를 단정하지 않는다.
- 순수 core의 ApprovalAuthentication이 요청 ID·기한·취소를 보유하게 하고, 두 service의
  refresh에서 만료·철회를 정리하도록 연결했다. 취소 전에 결속을 지우고, 늦은 성공을 서명 전에
  거절한다. 정상 인증이 끝나면 context를 invalidate하지 않아 기존 Secure Enclave 서명을 유지한다.
- 회귀는 만료 직전 유지·기한 도달 취소1회·다음 요청 시작·이전 응답 무효·재진입 completion 무효·
  정상 완료 context 보존을 검사한다. 기존 core 러너44/44, Swift 패키지70/70, Control 제품 컴파일 성공.
  로그 `/tmp/helpdesk-native-auth-checks-final-20261031.log`,
  `/tmp/helpdesk-native-auth-swift-tests-final-20261031.log`, `/tmp/helpdesk-native-auth-build-20261031.log`.
- 이 변경은 조정 워크트리 소스다. /Applications의Control·기존 main 앱은 교체하지 않았다.
  실제 Touch ID 완료와 그 뒤 AgentsToZ의 OS 입력은 아직 증명하지 않았다.
- 검토 창 표시의 원인은 단정하지 않는다. Apple의 cooperative activation 문서와 소스를 대조했고,
  main의 yieldActivationToApplication은 이미 존재했다. 이를 빠진 기능이라고 오인해 추가하거나
  foreground·서명 검증을 완화하지 않았다. 가시성 실패의 명시적 앱 열기 복구 버튼만 추가했다.

## 통합 검증 진행

- Claude feature commit0006d40f와 clean worktree를 확인해 조정 브랜치에 no-commit 병합했다.
  계획 문서의 add/add는 각 문서의 최신 상태·원래 실행 근거를 보존해 해결했다.
- 기존 UI 회귀에 「Control 앱 직접 열기」를 추가해 재요청0·승인0·서명된 기존 앱 열기1회와
  높이520px에서 복구 버튼의 위치를 검사했다. Chromium/WebKit×1100/390 모두 exit0.
  로그 `/tmp/helpdesk-approval-ui-final-20261031.log`.
- 통합 frontend build exit0(8.72초). 통합 필수 verify는 exit0으로 종료했다. 최종 계수는 실행 로그에서 확인한다.
- worker 정규 mac-onboarding(동결): run20261031T070754Z-cf688d7e, sourceUnchanged=true,
  26pass·1fail(first-project-app-screen). worker personas: run20261031T071955Z-7b5091c6,
  sourceUnchanged=true, 실제74검사 중73pass·1fail, 구성된16역할 중15pass·1fail(first-time-user).
  실패는 같은 기준선 first-project-app-screen이며 나머지 역할을 전체 통과로 부풀리지 않는다.
- 신규 native 변경을 포함한 조정 브랜치의 정규 workroom-improvement와 구성된 personas는
  별도 실행해 현재 소스의 결과를 읽는다. 설치본 성공·실제 Google OAuth·Windows/Linux 실기로 확대하지 않는다.

- R13 추가 경계:1초 timer가 실행되기 전에 만료 시각의 성공 응답이 올 수 있어 complete에서도
  현재 시각을 검사한다. 서명 단계 진입 전에 거절·context 무효화한다. 이 회귀를 포함해44/44와
  Swift70/70을 다시 통과했다. 이전 정상 프로필 run20261031T080103Z-b7c1deab은 이 보강을 위해
  정식 cancel_tester_run으로 중단했고, read_tester_run의 interrupted 상태로 자식 종료를 확인했다.
  이 중단 실행은 정상 통과가 아니다. 소스 동결 후 새로운 정규 실행으로 대체한다.
- Claude의17:04 최종 네이티브 status는 grant 없음·pending 없음이었다.16:57:39 후속 요청도
  만료됐으며 실제 fixture에 대한 AgentsToZ 입력은0회다. 새 요청을 반복하지 않는다.

- 타이머 전 완료 기한 검사를 제거한 임시 사본에서는44개 중 이 회귀1개가 실패했다
  (MUTANT_EXIT1,43/44). 실제 소스는 바꾸지 않았다. 로그
  `/tmp/helpdesk-auth-deadline-mutation-red-20261031.log`. 최종 소스의44/44·Swift70/70과 구분한다.
- Claude 독립 검토에서 차단할 서명 경계 오류는 보고되지 않았다. 다만 Native service의 실제
  timer→refresh→LAContext.invalidate→callback→approving 해제까지의 설치 UI 회귀는 없으므로,
  helper 단위 검사·컴파일을 실제 승인 버튼 회복의 실기 통과로 승격하지 않는다.
  앱 범위 대상 종료 때는 기존 후속 matches 검사로 서명을 거절하며, 인증 즉시 취소 개선은 별도다.
- 최신 통합 필수 verify exit0: Python131, TypeScript오류0, Bun9658pass/12skip/0fail,
  Rust143pass/1ignored/0fail. 로그 `/tmp/helpdesk-integrated-verify-20261031.log`.
  Native 인증 경계 보강은 위 별도 Core44·Swift70과 Control 컴파일로 검사했다.


## R14 · 검증 fixture의 기존 포커스 가정

- 정규 실행의 native-workflow-foundations 중 컴퓨터 유즈 승인 UI4조합은 통과했고,
  이어지는 workroom-schedule-effort-ui.mjs의 Escape 뒤 summary 포커스 가정에서 실패했다.
  DesktopEffortPanel·WorkspaceTools·dialogFocus 제품 소스는 기준선과 동일했다.
- 메뉴가 유지되는 실제 동작에서 원래 opener로 복귀함을 검사하고, 메뉴를 명시적으로 닫은 경우
  summary로 복귀함도 별도로 검사했다. assertion을 없애거나 포커스 제품 코드를 바꾸지 않았다.
- 전체 정규 run20261031T081004Z-2484e6c4는29pass/1fail로 기록한다.
  수정 후 관련 검사만 같은 정상 프로필에서 실행한 run20261031T082625Z-f2239b3c는
  sourceUnchanged=true,1pass/0fail(134.736초). 원래 전체 실행을 소급해 PASS로 표시하지 않는다.

## 최종 인수 상태

- 구성된16역할의 최종 run20261031T083134Z-18e5defc는 sourceUnchanged=true,
  74검사 중73pass/1fail,15역할PASS/1역할FAIL(first-time-user)이다.
  first-project-app-screen의 기존 baseline 실패는 남아 있다.
- Native 인증 대기 callback 무효화는 Apple LAContext.invalidate 계약과 대조했다:
  https://developer.apple.com/documentation/localauthentication/lacontext/invalidate()
  새로운 승인·foreground 검증 면제·설치된 앱 교체를 추가하지 않았다.
- 신규 Native 복귀 관점은 후보role-5ab243c8a3ea7eeb8fc2로 제안했다. 활성화·PASS가 아니다.
- 만료 뒤 실제 grant가 발급되지 않았으므로 아젠투지의 실제 입력은0회다. 실기를 완료라고 하지 않는다.
  Codex는 Control의 활성 제어·대기 없음을 확인하고 만료 인증을 정리해45059 프로세스로 재기동을 확인했다.
  소유 fixture74951/Chrome/59248서버 종료도 확인했다. 원격 발송·Google 계정 변경·메인 push·앱 설치는 하지 않았다.
- 마지막 fixture 제목의 UTF-8 meta·HTTP charset만 보강했고 격리 headless에서 올바른 제목과 MIME을 확인했다.
  로그 `/tmp/helpdesk-fixture-utf8-check-20261031.log`. 최종 persona 실행 뒤 이 인코딩 헤더와 실행 기록만 바뀌었고 제품 코드는 동결했다.
