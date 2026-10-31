# 헬프데스크 도움받기 (with 에고라이트 또는 아젠투지브라우저)

2026-10-31 구현. 계정 연결·가입 화면을 브라우저에서 함께 진행하는 헬프데스크의 명시적 모드다. 일반 상담(`helpdeskHost`)과
별개이며, 브라우저의 원문(DOM·캡처·주소 query)을 기록·AI·기억으로 보내지 않는다. 계획·검토 기록은
`docs/plans/helpdesk-browser-assistance-2026-10-31/`(EXECUTION.md에 Codex 검토 R1–R10 반영표).

## 구조

| 파일 | 역할 |
|---|---|
| `helpdeskAssistProtocol.ts` | DTO·요청 파서·화면 문구(`assistOutcomeText`, `assistScopeText`). UI가 import하므로 Node 코드 없음 |
| `helpdeskAssistRecipes.ts` | 검토된 레시피: 주소(`allow`)·요소 패턴(`targets`)·`stopBefore`·결정 지점. 모델이 만들지 않는다 |
| `helpdeskAssistStore.ts` | bun:sqlite. `generation`·revision CAS, 미완료 8개 상한, **끝난 기록만** 정리 |
| `helpdeskAssistHost.ts` | 실행 엔진. advance 1회 = 브라우저 동작 최대 1개. 예산 40동작·12회 선택·30분, 60초 무응답 → paused, 재시작 → interrupted |
| `helpdeskAssistEgo.ts` | 에고라이트 driver. 고정 스크립트 + JSON 데이터, `ATZ_RESULT` 표식. 실행 래퍼는 자기 프로세스 그룹만 소유 |
| `helpdeskAssistOwnedBrowser.ts` | 아젠투지브라우저 driver. 워크룸 없는 전용 `WorkroomBrowserHost` 인스턴스(세션 `helpdesk-assist-browser`, target = run id) |
| `helpdeskAssistPlanner.ts` | Claude 무도구 실행으로 **후보 번호만** 고름. 이메일 가림. Codex는 미지원 |
| `helpdeskAssistVerifiers.ts` | 기존 platform CLI 호스트에 묻기만 한다. 서비스별 check 계약·적용 범위 결속 |
| `HelpdeskBrowserAssist.tsx`·`helpdeskAssistClient.ts` | 시작 화면(브라우저·AI·값·범위 확인)과 진행 카드. `transport` 주입 계약 유지(화면 fixture가 쓴다) |

API: `POST /api/agent-runtime/helpdesk-assist`(Tauri 허용 목록·응답 150초 — 기본 20초로는 에고 호출·선택·CLI 검사를 못 담는다).

## 절대 규칙

- **read-only ≠ 무도구.** Codex CLI의 read-only 샌드박스는 셸만 막고 브라우저·MCP 도구는 켜져 있다 → 플래너로 쓰지 않는다.
- **완료 판정은 실제 검사뿐.** 클라이언트 저장 ≠ 사용자 인증 ≠ 실제 CLI 사용 가능. entry 레시피와 AI CLI는 「실제 연결 확인됨」을 띄우지 않는다.
- AI CLI 로그인 근거는 공식 상태 확인만(`claude auth status`, `codex login status` = `createCodexLoginEffects().probe`).
  `resolveReadOnlyVerifiedAgentRuntime`(initialize→model catalog→thread/start)는 **로그인이 아니다**. 모델 응답은 시험하지 않는다.
- Supabase check는 프로젝트 목록 접근만 증명한다(identity null). 사용자 신원을 확인했다고 쓰지 않는다.
- 적용 범위(1619): account-add·first-setup은 기본값을 바꾸지 않는다, project는 `bindings[provider].accountId`, mac-wide는 `deviceDefaults`.
- **늦은 결과는 상태를 되살리지 않는다.** 모든 await 뒤 `bind()`(generation·cursor·state). 늦은 결과는 영수증·검사 근거만 병합.
  cleanup 전에 상태·generation을 먼저 저장하고 cleanup은 run별 직렬화(R3b, `tests/helpdesk-assist-control-races.test.ts`).
- 내장 브라우저 동작은 **마지막 관찰**(workspace·epoch·observationId·ref)에 묶는다. act 안에서 resume·새 grant 금지.
  `navigateTrusted`는 큐 진입 전과 `Page.navigate` 직전에 epoch·입력 수·target을 다시 본다. 반복 attach는 입력 기준을 바꾸지 않는다.
- 에고는 사람이 공간을 쥔 동안 **주소 읽기도 하드 스톱**이다. 「이어서 진행」은 takeBack → 결속 확인 → 주소만 읽기(R9). 실패·비허용 주소는 다시 handOff.
- 에고 실행 래퍼: `detached`로 새 프로세스 그룹, timeout·출력 초과·취소·종료 뒤 남은 자손은 그룹 TERM→KILL. 다른 프로세스 탐색·종료 금지.
- UI 제어(멈춤·직접 하기·끝내기)는 진행 중인 advance를 기다리지 않는다. 제어는 신선한 revision으로 보내고, 늦은 응답은 revision으로 거른다.
- 다른 화면에서 연 도움의 「원래 화면으로」는 헬프데스크를 닫아 그 화면을 드러낸다. 호출 화면(첫 설정 마법사·빠른 로그인)은 unmount하지 않는다.

## 검증

- `tests/helpdesk-assist.test.ts`·`tests/helpdesk-assist-control-races.test.ts` → `helpdesk-contracts`.
- 화면: `tests/helpdesk-assist-ui.mjs`(Codex 작성, Chromium/WebKit × 390/1120) — 매니페스트 상한(96) 때문에 `tests/helpdesk-ui.mjs` 끝에서 이어 실행.
- 실기(컴퓨터 유즈)는 사람이 컴퓨터 유즈를 켜고 Control에서 승인한 뒤에만. shell·Playwright·에고 API로 대신 누른 결과를 컴퓨터 유즈 성공으로 보고하지 않는다.
