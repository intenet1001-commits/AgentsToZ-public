# 실행 기록 — 헬프데스크 도움받기

구현 담당: Claude Code(cmux CLI). 관찰·검토: Codex. 작업 폴더
`/Users/cs-work/.codex/worktrees/claude-helpdesk-implementation/AgentsToZ_byCS`,
브랜치 `claude/helpdesk-browser-assistance-20261031`, 기준 `da76c299`(build 1619).

## 2026-10-31 · 시작

- `CLAUDE_HELPDESK_STARTED` 출력, 폴더·브랜치·HEAD 확인(`da76c2996dca259997f10becb858df107c5e020e`).
- 프로젝트 테스터 ensure 1회: `{"outcome":"ready","installation":"ready","root":"/Users/cs-work/forcs/AgentsToZ_byCS"}`.
  (등록 프로젝트 루트로 해석됐다. 검사는 이 워크트리에서 실행한다.)
- 에포트 설정 파일(`workroom-effort-auto.json`, `desktop-effort-advice.json`)은 없었다 → 권고만 한다.

## P0 확인 결과

| 대상 | 실제로 한 것 | 결과 | 제품 결정 |
|---|---|---|---|
| 에고라이트 0.6.1.13(SDK 가이드 v2.1.0) | `ego-browser nodejs`로 data: 고정 페이지에서 TaskSpace 45 생성 → snapshot → click → `handOff()` → 다음 명령 → `takeOverTaskSpace(45)` → `finish({keep:[]})` | 생성·관찰·클릭 성공. snapshot에 비밀번호 값(sentinel) 없음. `handOff` 뒤 페이지 명령은 **하드 스톱**되고 그 실행의 앞선 출력까지 사라졌다. ownership `agentDelegatedToUser`. takeOver 후 재개·finish(`closedSpace:true`) 확인 | 한 실행에 변경 동작 1개, `handOff`는 마지막. 하드 스톱 문구는 `사람 제어`로 판정하고 재시도·재개하지 않는다. 결과가 사라진 변경 동작은 `unknown` 영수증 |
| 에고라이트 업데이트 알림 | `[ego-browser:notice]` 출력 | 업그레이드하지 않음 | 사용자 승인 없이 `ego-browser upgrade` 금지 |
| 아젠투지브라우저(CEF) | 소스 확인: 네이티브 뷰 키는 임의 safe id(8–160자)이고 호스트 `connect-owned`가 `runningSession`으로 워크룸 생존을 검사 | 워크룸 없이 결속하려면 소유자 검사가 필요 | 워크룸 호스트 인스턴스는 그대로 두고, 같은 코어의 **별도 인스턴스**를 헬프데스크 run 생존 검사로 만든다(세션 `helpdesk-assist-browser`) |
| Codex 제한 planner | `codex-cli 0.166.0`의 `exec --help`, `features list` | `--sandbox read-only`는 셸 실행 정책일 뿐, `shell_tool`·`browser_use`·`computer_use`·`apps`·`plugins`·MCP 설정이 켜져 있다. 무도구 실행을 증명할 플래그가 없다 | Codex 선택 시 **AI 선택 단계는 자동 조작하지 않고** 고정 동작 + 사람 안내로 진행(fail closed) |
| Claude 제한 planner | 기존 헬프데스크 인자 `--tools '' --strict-mcp-config --safe-mode --restricted …`와 `--help` 검사 | 무도구 실행 플래그가 있고 기존 검사 함수가 확인한다 | Claude만 AI 선택 단계 사용. 실제 1회 호출 결과는 바로 아래 |

### Claude 제한 planner 실제 1회 smoke (2026-10-31 15:50 KST, Codex 요청)

- 경로: 기존 `createHelpdeskClaude().answer`(인자 `HELPDESK_CLAUDE_ARGS` 그대로 — `--print --output-format json --safe-mode --restricted
  --tools '' --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --no-session-persistence --settings {"disableAllHooks":true}`),
  프롬프트는 `plannerPrompt`, 해석은 `parsePlannerReply`. 새 도구·모델 설정 변경 없음. Claude CLI `~/.local/bin/claude` → 2.1.316.
- 실행: 앱과 같은 최소 환경(`env -i HOME USER LOGNAME TMPDIR PATH=/usr/bin:/bin:~/.bun/bin`)에서 스크래치 스크립트 1회
  (`…/scratchpad/planner-smoke.ts`, 결과 `…/scratchpad/planner-smoke.json`). 저장소에 넣지 않았다.
- 입력: 비밀 없는 합성 후보 2개만 — `1. button "새 프로젝트"`, `2. link "도움말 보기"`, 단계 「Google Cloud 프로젝트 만들기」,
  목표 「새 프로젝트 만들기 화면 열기」. DOM·이메일·계정·주소 없음.
- 결과: `check()` = `ready`, 원문 `{"choice":1,"reason":"'새 프로젝트' button opens the new project creation screen"}`,
  `parsePlannerReply` → `{choice:0}`(기대값 0 일치), 10.9초.
- 범위: 이것은 **planner 경로(무도구 인자·응답 형식·해석기)의 근거**다. 실제 CEF/에고 화면에서 후보를 고른 것도, Google OAuth를 진행한 것도 아니다.

## 진행

- 공통 기반: protocol·recipes(gws v2, CLI 3종, AI 2종, entry 4종)·store(generation·미완료 8개 상한)·planner(Claude 무도구, Codex 미지원)·
  에고 driver(고정 스크립트, 자기 프로세스 그룹)·내장 브라우저 driver(관찰 결속)·host·verifier·API(`/api/agent-runtime/helpdesk-assist`, 응답 150초).
- UI: `src/HelpdeskBrowserAssist.tsx`·`src/helpdeskAssistClient.ts` 작성, 입구 연결 진행 중.

## Codex 검토 반영

| 회차 | 결함 | 반영 |
|---|---|---|
| R1 | 한글 이름 뒤 `\b` 정규식, 에고 출력 상한이 실제 메모리 상한이 아님, stopBefore 의미, gws 단계 수동 전가 | lookahead 레이블·스트림 바이트 예산·stopBefore는 클릭 제외만·값 출처 고정 입력 |
| R2 | 내장 브라우저 이전 관찰 ref가 새 화면에서 실행, 대기 중 탐색 | act를 관찰(workspace·epoch·observationId·ref)에 결속, `navigateTrusted` 큐 안 재검사 |
| R2 재검증 | 반복 attach가 사람 입력 기준 초기화 | 같은 run·workspace면 멱등, 기준 이동은 takeBack만 |
| R3 | 취소 뒤 늦은 결과가 run 되살림, 미완료 기록 정리 | generation 결속·늦은 결과는 영수증/검사 근거만, 완료 기록만 정리 |
| R3b | cleanup 대기 중 취소 race | Codex가 `helpdeskAssistHost.ts`·`tests/helpdesk-assist-control-races.test.ts` 직접 수정(6 pass), 소유권 반환됨 |
| R5 | Supabase identity null 실패 | 서비스별 check 계약, Supabase는 프로젝트 목록 접근만 주장 |
| R6 | Codex 런타임 호환성 성공을 로그인으로 판정 | 기존 `codex login status` probe(`createCodexLoginEffects().probe`)·`claude auth status`만 사용, AI는 실제 응답 미시험으로 표기 |
| R8 | UI 제어가 긴 advance 뒤에 막힘, 로그인 뒤 불필요한 human-done | advance 별도 경로·신선한 revision 제어·늦은 응답 revision 필터, human-done은 같은 app 단계 대기 중일 때만 |
| R9 | 새 프로젝트 뒤 human-done이 takeBack 전에 주소를 읽어 에고 하드 스톱 | takeBack → 결속 확인 → 주소만 읽기, 실패·비허용 주소는 다시 handOff(회귀 2개) |
| R10 | 외부 진입의 「원래 화면으로」가 헬프데스크 채팅으로 감, 호출 화면 unmount | 외부 진입은 헬프데스크를 닫아 호출 화면을 드러냄, 첫 설정 마법사·빠른 로그인은 열린 채 유지(헬프데스크 안의 따라하기만 닫음) |
| R7 | 에고 runner가 직접 자식만 종료, 파이프 물려받은 자손 대기 | `detached` 프로세스 그룹 소유, TERM→KILL·스트림 닫기, 종료 뒤 남은 자손도 정리(재현 2347ms→506ms) |

## 실기 사전 확인 (2026-10-31, read-only status만)

- 이 Claude Code 세션의 AgentsToZ MCP 연결: label `claude-code`, id `mcp_5350dbf7-df5b-401e-9c66-8ee2b008e098`, scope `mcp-connection`.
- `agentstoz_use_computer_session status`: available=true, restartRequired=false, **access.enabled=false**(컴퓨터 유즈 꺼짐), grants·pending 없음,
  native accessibility=true·screenRecording=true·secureInput=false, scopeProtocolVersion 2.
- `agentstoz_use_computer status`: available=true, native.state=unknown, grants·pending 없음.
- 결론: 도구는 연결돼 있으나 사람이 컴퓨터 유즈를 켜고 Control에서 승인하기 전에는 조작 불가. request-access·승인·입력은 하지 않았다.
  Codex 연결의 이전 status는 이 연결의 승인 근거로 쓰지 않는다.

## 정규 검사 중 실패 2건 — 기준 커밋에서도 같은 실패(이번 변경과 무관)

- mac-onboarding run `20261031T062927Z-e30e5af3`(source-changed): `voice-popout-screen`(WebKit 「마이크 켜고 시작」 클릭 30초 timeout),
  `first-project-app-screen`(`control-center-project-shortcut` summary 비가시 30초 timeout). 나머지 helpdesk·CLI·온보딩 등은 통과.
- 단독 재실행(작업 트리): 두 검사 모두 같은 위치에서 다시 실패.
- A/B: 깨끗한 `da76c299`(1619) 별도 워크트리 + 실제 `bun install --frozen-lockfile`에서 두 검사를 단독 실행 → **같은 위치·같은 오류로 실패**.
  따라서 이번 도움받기 변경의 회귀가 아니다. 원인(브라우저 환경·기존 결함)은 이 작업 범위 밖이며 고치지 않았다. assertion은 약화하지 않았다.

## 설치본 관찰 (Codex CUA, 2026-10-31)

- 설치 앱이 우리 개입 없이 1621.0.0(source bb804634, 빌드 14:42:32 KST)으로 바뀌어 있었다. 개발 기준은 da76c299/1619 유지.
  컴퓨터 유즈 실기 증거는 그때의 실행 버전 1621과 Claude 연결 id `mcp_5350dbf7-df5b-401e-9c66-8ee2b008e098`에 묶어 기록한다.
  설치본·primary 작업 트리는 건드리지 않았다.

## 화면 검사 연결·페르소나 후보 (2026-10-31)

- 새 화면 명령 `tests/helpdesk-assist-ui.mjs`(Codex 작성, 최종 8개 통과 — `/tmp/helpdesk-assist-ui-final-20261031.log`,
  `output/playwright/helpdesk-assist/results.json` state completed·results 8)는 `helpdesk-screen` check(`bun tests/helpdesk-ui.mjs`,
  mac-onboarding 프로필)의 끝에서 `Bun.spawnSync`로 실행되고, 실패하면 그 check가 실패한다. 매니페스트가 96개 상한이라 별도 check는 만들지 않았다.
- `personas propose`로 후보 3개(활성화 아님, evidence `helpdesk-contracts`·`helpdesk-screen`):
  `role-72c76e3c9d2bda0f0b25` Google Workspace 첫 연결 사용자, `role-b6f0830a89a5d87a03ef` 계정 추가·프로젝트 연결 사용자,
  `role-01390bf76d40956551ce` 진행 중 직접 하기·멈추는 사용자. 「원래 화면으로 뒤 호출 화면·입력 보존」은 App 수준 회귀가 없어 성공 기준에서 뺐다.

## 실기(컴퓨터 유즈) 시험 계획 — 사람 승인 전, 아직 입력하지 않음

- 목적: 헬프데스크 도움받기 **렌더된 화면**이 실제 OS 입력(아젠투지 컴퓨터 유즈)으로 끝까지 조작되는지 확인. 외부 경계(브라우저 SDK·CLI·OAuth)는
  Codex의 격리 fixture가 결정적으로 흉내 낸다 → **실제 Google OAuth·실제 CEF·실제 에고라이트 성공이 아니다.**
- 대상: 격리 fixture `tests/fixtures/helpdesk-assist-server.ts`(실제 `HelpdeskAssistHost`·Store·verifier, 127.0.0.1 임의 포트, 3001·설치 앱·자격 증명 미사용)를
  스크래치 런처 `…/scratchpad/cu-fixture-launch.ts`가 띄우고, **별도 창** Playwright `Google Chrome for Testing` 151.0.7922.34
  (`com.google.chrome.for.testing`, 1120×900)으로 `<fixture url>/?service=google-workspace`를 연다. 런처는 클릭·입력·페이지 읽기를 하지 않는다.
- 시작 화면: 「Google Workspace」 도움받기 시작 화면, 「이 범위로 함께 진행」 비활성, 범위 문구 「계정만 추가합니다…」.
- 순서(입력은 전부 컴퓨터 유즈, 키보드 입력 없음):
  1. 라디오 「새 프로젝트」 클릭 2. 체크박스 「이 범위에서 허용된 화면 이동…」 클릭 3. 「이 범위로 함께 진행」 클릭
  4. 단계 「프로젝트」에서 사람 대기 표시 확인 5. fixture 버튼 「새 프로젝트 생성 완료 (시험 응답)」 클릭(사람이 Console에서 만든 것을 흉내)
  6. 「직접 마쳤어요 · 이어서 진행」 클릭 7. 다음 단계로 넘어감 확인(`/fixture/state`의 `links.projectId` = `fixture-project-123`)
  8. 「도움 끝내기」 클릭 → 「원래 화면으로」 표시 확인. 여기서 멈춘다.
- 사람 승인 범위 — **처음 제안과 실제가 다르다(정정)**: 처음에는 앱 범위 `Google Chrome for Testing` 하나를 제안했지만, 사람이 켜 둔 설정은
  **전체 Mac(`desktop`)**이었다. request-access의 범위는 사람이 켠 설정을 따르므로, 사용자에게 알린 뒤 Codex 지시로 그 설정 그대로 요청했다
  (AI가 설정을 바꾸지 않는다). 입력은 범위와 무관하게 준비된 Chrome for Testing 창에만 한다. protected/own-host 해제는 요청하지 않는다.
- 증거 결속: 실제 입력 시점의 설치 앱 버전과 그때의 연결 id(아래 기록처럼 바뀐다), 컴퓨터 유즈 영수증·화면, fixture `/fixture/state`.
  shell·Playwright로 대신 누른 결과는 성공으로 세지 않는다.
- 준비 완료(15:55 KST): 런처 pid 74951, 시작 URL `http://127.0.0.1:59248/?service=google-workspace`, 상태 `http://127.0.0.1:59248/fixture/state`.
  입력 전 상태: operations `assist-status`·`assist-prepare`, actions 0, run `prepared`(revision 1, google-workspace). CU 입력은 Codex 동기화·사람 승인 뒤에만.
- Codex 관찰 동기화(CUA로 시작 화면 독립 확인). 이 연결의 status 재확인(16:01 KST): `access.enabled=false`, grants·pending 없음 → 입력 없음.
  Codex 메모: 승인 뒤 첫 조작에서 Chrome 번역 팝업을 실제 관찰로 처리, 하단 폼은 scroll 필요. fixture HTML `<title>`만 mojibake(본문 정상) —
  fixture HTML에 `<meta charset="utf-8">`가 없다. 소스 동결 중이라 고치지 않고 기록만 한다.
- 승인 시도 기록(원시 grant·capability 값은 적지 않는다):

  | 시각(KST) | 설치 앱 | 연결 | status | 이 세션의 동작 | 결과 |
  |---|---|---|---|---|---|
  | 16:09 | 1621 | `5350dbf7…` | enabled, scope desktop, grant·pending 없음 | 앱 범위가 아니라 요청 보류 | — |
  | 16:11 | 1621 | `5350dbf7…` | 같음 | request-access 1회 | pending, 만료 16:21:16. 사람은 「승인 검토 열기」가 패널 아래 fold에 가려 못 찾음(Codex가 스크롤만 함) |
  | 16:25 | — | **`3f7dc729…`(재등록)** | **enabled=false**, grant·pending 없음 | 없음 | 이전 요청 만료, grant 없음 |
  | 16:34 | 1624.0.0(bb48c3ee, 16:18 빌드 — 우리가 설치하지 않음) | `3f7dc729…` | enabled(Codex가 사용자 지시 「니가 컴퓨터유즈로좀해 테스트니까」로 스위치를 켬), scope desktop | request-access 1회 | pending, 만료 16:44:19. Codex가 「승인 검토 열기」를 누르자 UI가 「승인 검토 창이 현재 화면에 보이는지 확인하지 못했습니다」 표시 |

  자동 완성 문장·pending 소실은 승인 증거가 아니다. grant는 status의 실제 grant로만 인정한다. 승인 CTA 가시성은 Codex가 coordinator에서 고친다(이 브랜치 아님).

## 동결 트리 최종 검사 (2026-10-31)

- `bun run verify` exit 0: 매니페스트 자체 검사 131, `tsc --noEmit` 0 에러, `bun test` **9658 pass / 12 skip / 0 fail**(1093 파일, 1072초),
  `cargo test` 143 passed / 0 failed / 1 ignored. `bun run build` exit 0(기존 큰 청크 경고만).
- mac-onboarding `20261031T070754Z-cf688d7e`(source unchanged: True): **26/27 통과**. `helpdesk-contracts` 7.5초, `helpdesk-screen` 163.7초(도움받기 화면 8개 포함).
  실패 1: `first-project-app-screen` — `control-center-project-shortcut` summary 비가시 timeout, 기준 커밋 A/B와 같은 위치·오류(기존 결함).
  `voice-popout-screen`은 이번엔 통과(7.8초) — 앞선 실행·A/B에서는 실패했으므로 「고쳐졌다」가 아니라 간헐·환경 의존으로 기록한다.
- 구성된 페르소나 16개 `20261031T071955Z-7b5091c6`(source unchanged: True): **15 PASS / 1 FAIL**, 검사 73 통과·1 실패.
  FAIL은 `first-time-user` 하나이고 원인은 같은 `first-project-app-screen` 기존 실패뿐이다. `multi-account-maker`·`low-vision-user`·`cautious-sync-user` PASS.
- 공유 브라우저 경로 집중 검사 `workroom-browser-contracts` `20261031T074043Z-24524a64`: 통과(3.6초).
- 전체 quick은 Codex 합의로 생략(관련 정상 프로필 mac-onboarding + verify/build + personas + 집중 검사).


## Codex 통합 및 최종 결과 (2026-10-31)

- 통합 브랜치 `codex/onboarding-browser-help-20261031`, 기준 `da76c299`/1619. Claude 구현 커밋 `0006d40f`를 병합했다.
  Codex가 승인 대기 고정 헤더·명시적 Control 앱 열기·만료 인증 취소를 추가했다. 상세 재현은 REVIEW.md.
- 통합 필수 verify exit0: Python131, TypeScript오류0, Bun9658pass/12skip/0fail, Rust143pass/1ignored/0fail.
  frontend build exit0. Native Core44/44, Swift70/70, Control 제품 컴파일 성공.
- 정규 `workroom-improvement` run `20261031T081004Z-2484e6c4`: sourceUnchanged=true,29pass/1fail.
  실패는 기존 desktop-effort 화면 검사의 메뉴가 닫힌다는 포커스 가정이었다. 열린 메뉴의 원래 버튼과 닫힌 메뉴의 summary 복귀를
  각각 검사하도록 바로잡은 뒤 같은 프로필의 `native-workflow-foundations`만 재실행한
  `20261031T082625Z-f2239b3c`는 sourceUnchanged=true,1pass/0fail이다. 첫 실행을 전체 통과라고 바꾸지 않는다.
- 최종 구성된 personas run `20261031T083134Z-18e5defc`: sourceUnchanged=true,74검사 중73pass/1fail,
  16역할 중15PASS/1FAIL(first-time-user). 실패는 `first-project-app-screen`이며 clean1619에서도 같은 위치에서 재현됐다.
- 실기는 **미완료**다.17:35 Claude의 실제 status는 grant0/pending0이며17:25:36 요청도 만료됐다. 실제 fixture에 대한 아젠투지 입력은0회다.
  Codex의 Control UI 조작·도우미 재시작·승인 버튼 활성 복구 관찰을 아젠투지 입력 성공으로 바꾸지 않는다.
- Codex CUA는 활성 허용·대기 없음을 확인하고 Control만 정상 재시작했다(PID60143→94947, 최종 정리94947→45059).
  Main 앱·sidecar·권한·다른 테스트 앱을 변경하지 않았다. Claude 소유 fixture 서버59248·소유 Chrome 창은 정상 종료했고 포트 닫힘을 확인했다.
- 설치 앱은 다른 작업으로1621/bb804634, 뒤1624/bb48c3ee가 된 것을 관찰했다. 이 브랜치의 앱이나 Control을 설치하지 않았다.
  실제 Touch ID 후속 시험·공식 Google OAuth·설치 CEF 연동, P3/P4의 미구현 어댑터와 App 전체 복귀 회귀는 남아 있다.
- 실기 준비 중 보인 fixture 제목 깨짐도 UTF-8 meta·HTTP charset으로 수정했다. 마지막 격리 headless 확인에서
  제목 `헬프데스크 브라우저 지원 · 격리 시험`과 `text/html; charset=utf-8`을 확인했다. 이는 실제 OS 입력 시험이 아니다.
