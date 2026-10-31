# 구현 체크리스트와 인수 조건

기준: `da76c299` · build 1619. 상태: 아래 체크박스는 계획 당시 그대로 두고, 구현 상태는 바로 아래 표에만 적는다(근거는 [EXECUTION.md](EXECUTION.md)).

## 구현 상태 (2026-10-31, 브랜치 `codex/onboarding-browser-help-20261031`)

| 묶음 | 상태 | 근거 / 남은 것 |
|---|---|---|
| P0 | 대부분 확인 | 에고라이트 TaskSpace 생성·관찰·클릭·handOff 하드 스톱·takeOver·finish 실측. Codex CLI는 무도구 보장 불가로 fail closed, Claude 무도구 planner 실제 1회 smoke 통과(합성 후보). 아젠투지브라우저는 워크룸 없는 별도 호스트 인스턴스로 결속(소스·단위 검사) — **설치 앱 CEF 실기는 아직**. 상한(40동작·12회 선택·30분)은 대표 Console 실측이 아니라 초기값 |
| P1 공통 기반 | 구현·단위/화면 검사 통과 | protocol·recipes·store·host·planner·두 driver·verifier·API·UI. `helpdesk-contracts`(단위 2파일)·`helpdesk-screen`(Codex 화면 8개 이어 실행) |
| P2 gws | 격리 fixture에서 여정 통과 | 첫 설정 도움말·마법사·`PlatformGoogleClientSetup`·헬프데스크 gws·빠른 로그인 입구 연결. 기존 프로젝트·새 프로젝트(사람 완료→takeBack→주소만 읽기)·직접 첨부·공식 로그인·실제 연결 검사 분리. **실제 Google OAuth·실제 Console·조직 정책/CAPTCHA 분기 실기는 아직** |
| P3/P4 | 입구·검사기 일부 | GitHub·Supabase·Vercel 서비스 입구, `PlatformAccountSwitcher` 세 입구(계정 추가·프로젝트·새 프로젝트), AI CLI 로그인 상태 확인. agy·Hermes·API 키·모바일 Google·추가 기기·Windows/Linux는 **미구현**(entry/안내 수준을 완료로 주장하지 않는다) |
| 실기 컴퓨터 유즈 | 미완료 | 유효 grant가 발급되지 않아 실제 아젠투지 입력0회. Codex가 승인 버튼 활성 복구와 만료 정리를 관찰했다. 설치 반영·사람 인증 후 실기는 남음 |
| 페르소나 | 후보 3개 제안(활성화 아님) | `role-72c76e3c9d2bda0f0b25`·`role-b6f0830a89a5d87a03ef`·`role-01390bf76d40956551ce` — 리뷰에서 기존 `first-time-user`·`multi-account-maker` 확장으로 합칠 수 있다 |
제품 경험과 실행 계약은 [PLAN.md](PLAN.md), 조사 근거는 [RESEARCH.md](RESEARCH.md)를 따른다.

## P0. 구현 전에 대표 동작으로 확인할 사항

- [ ] 에고라이트: 현재 SDK에서 TaskSpace 생성·동일 공간 재개·허용 관찰·클릭·사람 인수·취소·종료를 확인한다.
- [ ] 아젠투지브라우저: 프로젝트·실행 중 워크룸이 없는 설치 앱에서 온보딩 소유자와 CEF를 결속한다.
- [ ] 두 브라우저의 제어권 인수 후 이미 대기 중인 클릭까지 멈추는지 확인한다.
- [ ] Google Console 준비와 공식 OAuth 인증 경로를 분리한다. CEF 인증창을 기본 경로로 정하지 않는다.
- [ ] 도움 AI의 제한 실행을 실제 CLI에서 확인한다. read-only를 무도구 실행의 증거로 사용하지 않는다.
- [ ] 동작 수·시간·관찰 크기·AI 제안 횟수의 초기 상한을 대표 Console 여정 실측으로 정하고 기록한다.
- [ ] 온보딩에서 승인한 준비 단계의 예상 탐색은 추가 승인 없이 이어지고, 예상하지 못한 이동은 관찰 전에 멈추는지 확인한다. 기존 Workroom의 탐색 철회 계약은 유지한다.

통과 조건: 실제 가능한 드라이버/AI 조합과 제한을 표로 남기고, 지원하지 않는 조합이 실행되거나 성공으로 표시되지 않는다.

## P1. 공통 헬프데스크 기반

예상 신규 파일 묶음(최종 이름은 구현 시 조정 가능):

| 책임 | 파일 제안 | 유지할 기존 경계 |
|---|---|---|
| 순수 intent·DTO·레시피·허용 동작 | `helpdeskAssistProtocol.ts`, `helpdeskAssistRecipes.ts` | UI 모듈에서 Node/Bun 서버 코드를 import하지 않음 |
| 진행·CAS·영수증·제한된 다음 동작 | `helpdeskAssistHost.ts`, `helpdeskAssistStore.ts`, `helpdeskAssistPlanner.ts` | CLI 로그인·설치·계정 상태는 기존 호스트가 정본 |
| 동일 화면의 지원 모드·복귀 | `HelpdeskBrowserAssist.tsx`, `helpdeskAssistClient.ts` | 기존 `HelpdeskPanel`의 일반 질문 모드와 기록을 유지 |
| 드라이버 공통 계약과 실제 연결 | `helpdeskAssistBrowser.ts`, `helpdeskAssistEgo.ts`, `helpdeskAssistOwnedBrowser.ts` | AI에게 임의 JS·CDP·셸 실행 인터페이스를 주지 않음 |
| 기존 브라우저 제어 코어 재사용 | 필요한 부분만 `workroomBrowserHost.ts`에서 분리 | 기존 Workroom의 소유권·탐색·grant 회귀를 유지 |
| 로컬 관리 연결 | `api-server.ts`, `src-tauri/src/lib.rs`의 정확한 allowlist | 기존 onboarding capability, 원격 권한과 분리 |

- [ ] 모든 입구에서 같은 intent를 만들고 현재 단계·계정 목적·적용 범위를 보존한다.
- [ ] `prepare`는 실제 실행을 하지 않고, `start`는 검토한 범위와 최신 revision을 확인한다.
- [ ] AI 제안은 구조화된 허용 동작만 받는다. 페이지 데이터로 실행 범위가 넓어지지 않는다.
- [ ] 동작 예약 뒤 실행하고, 결과 미확정일 때 같은 영수증으로 조회한다.
- [ ] 사람 단계에서는 DOM·화면 관찰과 AI 호출을 중지한다. 늦은 응답을 폐기한다.
- [ ] 새로고침·앱 재시작은 작업 결과부터 읽는다. 예전 browser grant를 복원하지 않는다.
- [ ] 지원을 닫으면 조작 루프·AI·관찰 타이머가 끝나며, 이미 시작한 CLI 작업은 원래 수명과 영수증으로 확인한다.
- [ ] 일반 질문 기록, 내가 한 말, 장기기억, 진단 내보내기에 브라우저 원문·인증 정보를 넣지 않는다.
- [ ] 기존 support-history와 onboarding/progress v1의 포맷을 브라우저 세션 저장에 재사용하지 않는다.

통과 조건: 비밀 없는 fixture에서 두 드라이버가 같은 지원 상태·영수증·취소 계약을 따르고 일반 상담/Workroom 회귀가 없다.

## P2. gws 첫 여정

- [ ] `GoogleWorkspaceSetupHelp`와 `GoogleWorkspaceSetupWizard`에 공통 도움 버튼을 연결한다.
- [ ] `PlatformGoogleClientSetup`, 헬프데스크 gws, `QuickCliLogin`에서 같은 지원을 재사용한다.
- [ ] JSON 보유자는 첨부·공식 로그인·실제 검사로 바로 진행한다.
- [ ] JSON 미보유자는 기존 프로젝트 → 필요한 API·동의 화면 → Desktop client 준비로 진행한다.
- [ ] client 생성 결과가 비밀값을 표시하기 전에 사람에게 넘긴다. 파일은 기존 앱 첨부만 사용한다.
- [ ] Web client·service account·OAuth export와 Desktop client를 잘못 연결하지 않는다.
- [ ] 현재 Drive 읽기 scope와 실제 이메일 일치 검사를 유지한다.
- [ ] gws는 이메일 지정 로그인과 계정 추가 목적을 유지한다. 이메일 자동 발견용 `login-add-start`를 그대로 호출하지 않는다.
- [ ] 승인한 계정이 다르면 연결 실패 이유를 알리고 다른 계정으로 대체하지 않는다.
- [ ] Google 조직 정책·인증 브라우저 제한·CAPTCHA·callback 실패에 각각 다음 행동을 제공한다.
- [ ] API 준비 완료, client 저장, 사용자 인증, 실제 CLI 사용 가능을 따로 표시한다.
- [ ] 생성·다운로드·로그인 중단 뒤 새 client나 로그인 요청을 무조건 만들지 않는다.

통과 조건: 두 브라우저의 준비 화면 지원에서 시작하여 사용자 인증과 gws 실제 검사까지 이어지고,
기존 계정·기본값·프로젝트 연결·모바일 Google 설정은 의도한 범위 밖에서 바뀌지 않는다.

## P3/P4. 모든 온보딩의 입구와 어댑터

- [ ] GitHub·Supabase·Vercel의 서비스 준비, 설치, 공식 가입/인증에 공통 도움 버튼을 붙인다.
- [ ] `PlatformAccountSwitcher`의 Mac 전체·프로젝트별·새 프로젝트 입구에서 원래 범위를 유지한다.
- [ ] 계정 추가는 기존 `login-add-start`, 첫 준비는 기존 onboarding 로그인과 연결한다.
- [ ] 특정 프로젝트에서 추가한 계정이 다른 프로젝트나 Mac 전체 로그인을 바꾸지 않는지 확인한다.
- [ ] Mac 전체 전환 요청은 기존 native switch로 이어지고 gws의 미지원 범위를 정확히 표시한다.
- [ ] Codex·Claude·agy·Hermes의 설치/인증 목표를 같은 레시피 계약에 연결한다. 도움 AI 미연결 시 고정 안내로 진행한다.
- [ ] API 키 발급은 공식 화면 안내 → 사용자 앱 입력 → 기존 저장/연결 확인으로 구성한다.
- [ ] 모바일 Google Web client·Provider·본인 폰 로그인은 gws Desktop client와 다른 레시피로 둔다.
- [ ] 추가 기기·개인 포털·기타 온보딩의 지원 수준과 실제 검증기를 표시한다.
- [ ] Mac에서 확인한 구현을 Windows/Linux 실기 지원으로 확대 표시하지 않는다.

공통화 검증: gws 다음에 다른 제공자 한 곳을 붙일 때 진행기·지원 UI를 복제하지 않고 레시피와 검사기만 추가할 수 있어야 한다.

## 행동 기반 회귀

| 시나리오 | 관찰 가능한 기대 결과 |
|---|---|
| 도움 버튼 두 번 누름 / 응답 유실 | 지원·CLI·생성 작업이 하나이고 같은 결과를 조회 |
| prepare만 실행 | 브라우저 조작·AI 실행·계정 변경 없음 |
| 오래된 화면 요소·revision·다른 계정의 영수증 | 조작 거절, 현재 상태 확인 안내 |
| 사람이 인수한 직후 AI 제안 도착 | 화면 변경 없음, 사람 제어 유지 |
| 로그인·비밀값 화면 진입 | 관찰·AI 요청 중단, 비밀이 기록에 남지 않음 |
| 악성 페이지가 다른 계정·URL·셸을 지시 | 허용 레시피 밖의 동작 실행 안 됨 |
| OAuth 승인 성공 후 실제 API 검사 실패 | 부분 성공과 검사 실패 구분, 완료 아님 |
| 계정 불일치 / 조직 차단 / 인증 만료 | 원래 계정 유지, 실패 이유와 다음 행동 표시 |
| 앱 재시작·취소·시간 초과 중 늦은 성공 | 동일 작업 결과 조회, 새 생성·자동 재로그인 없음 |
| 지원 화면 닫음 / 숨김 | 조작·AI·DOM 폴링 중단, 진행 ID 유지 |
| 1619의 프로젝트 계정 추가 | 해당 binding만 변경, Mac native 계정·다른 프로젝트 유지 |
| gws 지원 완료 | 앱 DB·모바일 Google Provider·shell/git 설정을 별도 변경하지 않음 |

신규 테스트 이름 제안: `helpdesk-assist.test.ts`, `helpdesk-assist-api.test.ts`,
`helpdesk-assist-drivers.test.ts`, `helpdesk-assist-ui.mjs`.
문구 존재만 검사하지 말고 실행 횟수·거절 시 무변경·실제 검사 결과·복귀 상태를 검증한다.
관찰·로그 유출 테스트는 실제 비밀 대신 sentinel 값을 사용한다.

## 페르소나 여정 초안 — needs checks

아래는 계획용 초안이다. 현재 카탈로그 `tests/personas/catalog.json`의 기존 역할과 비교했으며
활성화하거나 PASS로 판정하지 않았다. 실제 구현 뒤 check ID와 `covers`를 연결하고 기존 리뷰 절차를 따른다.

| 배우/필요성 | 시작 상황과 순서 | 관찰 가능한 성공 | 관련 소스 |
|---|---|---|---|
| 기존 `first-time-user` 확장: Google Console 경험이 없는 사용자 | JSON 없음 → 도움 → 브라우저 선택 → Console 준비 → 직접 다운로드/첨부 → 공식 인증 → 실제 검사 | 프롬프트 복사 없이 진행, 완료 구분, 원래 입력 유지 | `GoogleWorkspaceSetupHelp.tsx`, `PlatformGoogleClientSetup.tsx`, `PlatformCliLoginPanel.tsx` |
| 기존 `first-time-user` 확장: AI가 아직 없는 첫 사용자 | AI CLI 없음 → 도움 → 고정 안내/설치 → 직접 공식 인증 → 준비 결과 재확인 | 다른 AI 설치를 선행 조건으로 반복 요구하지 않음 | `HelpdeskPanel.tsx`, `MacSetupPanel.tsx`, `OnboardingPreparation.tsx` |
| 기존 `multi-account-maker` 확장: 다른 Google/서비스 계정을 추가하는 사용자 | 프로젝트 A에서 추가 → 브라우저 B계정 인증 → 실제 이메일 확인 → A에 적용 | Mac 전체와 프로젝트 C는 유지, 다른 계정으로 fallback 없음 | `PlatformAccountSwitcher.tsx`, `platformCliLogin.ts`, `platformCliRequest.ts` |
| 신규 후보: 조직 정책으로 인증이 막힌 업무 사용자 | 기존 조직 프로젝트 선택 → 정책 제한 확인 → 지원 정지 → 관리자 확인 후 이어가기 | 우회/전체 권한 확대/중복 client 생성 없음, 다음 행동 표시 | Google 가이드·지원 레시피·드라이버 |
| 기존 `cautious-sync-user` 관점 확장: 중단 뒤 돌아오는 사용자 | client 생성/로그인 중 중단 → 앱 재시작 → 이전 결과 확인 → 같은 run 재개 | 원본 설정 유지, 자동 재전송 없음, 불명 결과를 완료로 표시하지 않음 | `helpdeskAssistStore.ts`(신규 예정), 기존 로그인/영수증 코드 |
| 기존 `low-vision-user` 관점 확장: 진행과 제어권을 확인하는 사용자 | 키보드로 도움 열기 → 브라우저 선택 → 진행 알림 → 직접 조작 → 복귀 | 포커스 복귀, 현재 제어권·오류 읽기, 작은 화면에서 버튼 사용 | 공통 지원 UI, `HelpdeskPanel.css` |

각 여정의 검사 ID는 **미정**이다. 구현 뒤 `personas context` → `personas propose`로 현재 revision의
후보를 기록한다. 기존 `first-time-user`를 확장할 때 중복 카탈로그를 만들지 않는다.

## 구현 후 검증 순서

1. 세션당 한 번 프로젝트 테스터 ensure를 호출한다. linked worktree 경로로 실행하고 기억만 primary root를 사용한다.
2. `.agentstoz/MAINTAINER.md`와 당시 manifest의 관련 기존 검사를 읽는다. 현재 연관 check는
   `platform-cli-contracts`, `platform-cli-screen`, `platform-cli-onboarding-screen`,
   `cli-account-contracts`, `cli-account-screen`, `mac-onboarding-contracts`, `mac-onboarding-screen`,
   `helpdesk-contracts`, `helpdesk-screen`, `web-workroom`이다. 변경한 경계에 맞춰 집중 검사한다.
3. 변경 범위에 맞는 정상 프로필(이번 구현은 mac-onboarding, 범위 미지정 시 quick)과 구성된 persona set을 실행한다. 프로필에 포함된 persona 실행을 중복하지 않는다.
4. 커밋 전 저장소 필수 `bun run verify`, UI import 경계용 `bun run build`를 통과한다.
5. 서명된 설치 앱에서 두 브라우저·실제 Google 승인·실제 gws 검사·재시작을 확인한다.
   실제 가입/권한 승인/설정 변경은 그 시험에서 구체적으로 선택한 대상만 실행한다.
6. Windows/Linux 지원을 표시하기 전 해당 OS에서 설치본·브라우저·CLI 인증을 확인한다.

실제 구현·검사 결과는 [EXECUTION.md](EXECUTION.md), Codex의 독립 재현과 실기 준비 문제는 [REVIEW.md](REVIEW.md)에 기록한다. 위 체크박스는 최초 인수 조건이며, 전부 완료를 뜻하지 않는다.


최종 검증: 필수verify·frontend build·Core44·Swift70 통과. 정상30검사 중29통과 후 실패한 fixture를 보정해
해당 검사 재실행 통과. 구성된16역할은15PASS/1FAIL(기준1619에서도 실패한 첫 프로젝트 화면)이다.
최종 소스와 미검증 범위는 EXECUTION.md·REVIEW.md를 따른다. 전체 계획의 모든 인수 항목을 완료한 것은 아니다.
