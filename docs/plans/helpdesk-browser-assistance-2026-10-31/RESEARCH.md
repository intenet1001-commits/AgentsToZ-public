# 조사 근거와 남은 확인

조사일: 2026-10-31. 구현 계획은 [PLAN.md](PLAN.md).

## 기준 소스와 작업 상태

- 처음 원격 기본 브랜치를 조회했을 때는 `337b8dc7`이었다.
- 사용자가 현재 기준을 **`da76c299` · build 1619**로 알려준 뒤 `git fetch origin main`으로 확인했다.
- 새 워크트리 브랜치를 `da76c2996dca259997f10becb858df107c5e020e`로 fast-forward했다.
- `deriveBuildNumber(readBuildNumberFile(...), gitRunner(...))`의 읽기 전용 계산 결과는
  `{ok:true, buildNumber:1619, head:da76c2996dca259997f10becb858df107c5e020e, derived:true}`였다.
- 다른 작업이 진행 중인 primary checkout의 코드·인덱스·미커밋 변경은 편집하지 않았다.
- 첫 계획 산출물은 이 폴더의 PLAN/CHECKLIST/RESEARCH 세 문서다. 후속 실행 지시는
  [ORCHESTRATION.md](ORCHESTRATION.md)에 추가했다. 최초 계획 작성 시 조정 브랜치의 앱 코드는 변경하지 않았다. 후속 구현 상태는 EXECUTION.md·REVIEW.md를 따른다.
  사용자 정정에 따라 명칭은 헬프데스크다.

## 현재 코드에서 확인한 계약

아래 경로는 모두 저장소 루트 기준이다. 구현 시 해당 영역의 `docs/claude/` 노트를 함께 읽는다.

| 근거 | 확인 내용 | 계획에 반영한 점 |
|---|---|---|
| `src/GoogleWorkspaceSetupHelp.tsx`, `src/GoogleWorkspaceSetupWizard.tsx`, `src/googleWorkspaceOnboardingGuide.ts` | 5단계 Google 준비 화면, 정적인 Codex 인계문, 사람 인증·JSON 직접 첨부 안내가 있음 | 현재 가이드를 실제 지원 run·브라우저·검사에 연결 |
| `src/PlatformGoogleClientSetup.tsx`, `src/platformGoogleOAuthClient.ts` | Desktop JSON 검증·16KB 한도·OS 보안 저장, 기존 gws client 사용, 파일 준비와 로그인 분리 | 새 비밀 저장 경로나 AI JSON 전달 경로를 만들지 않음 |
| `src/platformCliLogin.ts`, `src/platformCliHost.ts` | 격리 로그인, 일시 인증 정보 비저장, 10분 로그인 제한, Drive 읽기 scope와 실제 이메일 검사 | 기존 로그인 작업/검사 결과를 재사용 |
| `src/PlatformCliLoginPanel.tsx`, `src/platformCliSetupGuide.ts`, `src/ServiceAccountOnboarding.tsx` | 브라우저 연결·계정 목적·설치 여부와 인증 결과를 분리 | 공통 도움 버튼이 기존 등록·목적을 유지 |
| `src/HelpdeskPanel.tsx`, `src/helpdeskHost.ts`, `src/helpdeskKnowledge.ts` | 일반 상담·여러 준비 stage·Codex/Claude 선택, 작은 support-history, 안내 중심 프롬프트 | 지원 모드를 기존 헬프데스크에 연결하고 상담 원문 이력과 분리 |
| `src/helpdeskClaude.ts`, `api-server.ts`의 HelpdeskHost 구성 | Claude는 tools/MCP를 끔. Codex는 기존 대화 실행기의 read-only 모드를 사용 | 두 모드를 같은 권한이라고 보지 않고 제한 planner를 먼저 검증 |
| `src/workroomBrowserHost.ts`, `src/workroomBrowserProtocol.ts`, `src/workroomBrowserMcp.ts` | 실제 Workroom 결속, 관찰/epoch/grant, 사람 인수·탐색 시 철회, 제한 동작·영수증 | 코어 재사용과 별도 온보딩 소유자 필요 |
| `src/workroomBrowserHandoff.ts` | grant는 일시적인 작성기 첨부이며 초안·원격 DTO에 저장하지 않음 | 지원 grant도 저장·기억·재시작 복구 대상에서 제외 |
| `src/openPreferredBrowser.ts`, `src/browserPreference.ts` | 브라우저 열기와 조작 권한은 별개. 지정 Chrome 프로필은 일반 선호 브라우저보다 우선 | 지원 run의 브라우저 선택이 전역 기본값이나 계정을 암묵적으로 바꾸지 않도록 설계 |
| `src/onboardingProgress.ts`, `src/onboardingProgressStore.ts` | v1 도구·상태·키가 엄격한 SQLite 체크리스트. gws는 도구 enum에 없음 | 기존 DTO를 임의 확장하지 않고 지원 진행 참조만 별도 저장 |
| `src/PlatformAccountSwitcher.tsx`, `src/platformCliRequest.ts`, `docs/platform-cli-accounts.md` | 1619의 Mac 전체/프로젝트/새 프로젝트 선택, login-add와 첫 준비 구분, native switch | 지원 intent에 원래 적용 범위를 보존 |
| `src/platformCliNativeSwitch.ts`, `src/platformCliWorkroom.ts`, `src/platformCliEverywhere.ts` | 프로젝트 계정·native 로그인·shell/git 적용 경계가 있고 gws native switch는 미지원 | 도움 기능이 전역 전환이나 shell/git 변경을 추가하지 않음 |

구조 탐색에는 codebase-memory의 search → trace → snippet을 사용하고 근거 경로의 coverage를 확인했다.
그래프 생성 시각은 `2026-10-30T04:37:31Z`로 이번 main보다 오래됐다.
특히 1619의 계정 전환 신규 파일은 그래프 freshness가 `missing`이었다.
따라서 그래프는 후보 탐색에 사용하고 새 워크트리의 소스·diff·문서를 직접 확인했다.
coverage의 `no_recorded_issue`를 전체 코드 최신성이나 검사 통과로 해석하지 않았다.

## 기존 계획·기억과의 관계

- `docs/plans/beginner-onboarding-2026-09-11/BROWSER-ASSISTED-ENTRY.md`에는
  Codex·ego 준비 → 공식 브라우저 과정 → 사용자 인증 → 실제 검사 → 영수증 기반 재개 방향이 있다.
  이번 계획은 현재 구현과 두 브라우저, 공통 헬프데스크 입구를 기준으로 구체화한다.
- canonical memory는 primary worktree의 `.agent-memory/config.json`과 `CORE.md` 색인으로 해석했다.
  관련 노트의 첫 사용자 온보딩·공식 계정 연결·실제 검사 구분을 참고했다.
- 정상 bounded recall의 `commonMemory`는 ready였으며 연결된 공통 기억 hit는 없었다.
  correction 검색은 complete였고 해당 결과의 corrections는 없었다.
- 원격 memory Pull은 HTTP 409 conflict로 끝났고 `localSaved=false`였다. 덮어쓰기·충돌 해결을 하지 않았다.
  회상의 후보·과거 journal은 현재 구현의 증거로 승격하지 않았다. 넓은 journal 검색은 truncated였으므로 과거 기록을 전수 조사했다고 주장하지 않는다.
- 관련 과거 항목: memoryId `884575df-63c4-407c-8b43-860d1295e663`,
  entryId `a183e6bdc74051fae802d967`(초보자 온보딩), `09f6c258d7e14a8fb3ac6201`(계정 연결 후속 요청).
  최신 원격 revision과의 정합성은 미확정이다.

## 외부 공식 자료와 실제 도구 문서

공식 페이지는 에고라이트 TaskSpace 44에서 읽은 뒤 `finish({keep:[]})`로 닫았다.
실제 Google 로그인이나 Console 설정은 진행하지 않았다.

1. [Google Workspace CLI — Authentication](https://github.com/googleworkspace/cli#authentication)
   - gcloud 기반 setup 외에 Console에서 Desktop app client를 만들고 JSON을 준비하는 경로가 있다.
   - 테스트 사용자 등록과 scope 선택이 필요하며, 사용 중인 CLI 버전의 명령·동작 확인이 필요하다.
   - 프로젝트는 공식 지원 Google 제품이 아니며 개발 중인 CLI임을 명시한다.
2. [Google OAuth 2.0 Policies — Use secure browsers](https://developers.google.com/identity/protocols/oauth2/policies#secure-browsers)
   - 개발자가 제어하는 embedded user-agent로 OAuth 요청을 보내는 것을 제한한다.
   - 따라서 Console 준비 화면 자동 조작과 OAuth 인증용 브라우저의 적합성은 별도로 검토해야 한다.
   - CEF나 에고라이트가 특정 로그인 화면을 표시한다는 사실만으로 적합성을 증명하지 않는다.
3. 설치된 `ego-browser skill` v2.1.0
   - 한 목표에 TaskSpace 하나, 현재 관찰 기반 동작, handOff/takeOver, 명시적인 완료가 문서화돼 있다.
   - 영수증은 앱의 실제 완료 증거와 별개이며, 사람 인수·중단 뒤 임의 우회하지 않는 계약이다.
   - 현재 CLI가 보고한 Ego Lite는 `0.6.1.13`이고 업데이트 알림이 있었다. 업데이트하지 않았다.
   - 이번에 한 것은 공식 문서 읽기다. 제품 드라이버의 취소·재개·브라우저 인증 실기 통과를 뜻하지 않는다.

## 아직 확인하지 않은 것

- 두 브라우저를 실제 설치 앱의 헬프데스크에 연결한 전체 흐름.
- 워크룸 없는 CEF의 온보딩 소유권과 일반 Workroom 회귀.
- Codex·Claude의 브라우저 planner 제한 실행과 실제 호출 비용/동작 예산.
- 각 브라우저 환경의 Google 인증 적합성 및 외부 공식 인증 경로로의 전환.
- JSON 생성·다운로드 중단, 실제 Google 승인, 실제 gws 계정 검사와 재시작 복구.
- 새 OS 사용자/깨끗한 Mac, Windows/Linux에서의 실제 설치·인증 여정.
- 이 계획에 대한 사용자 검토와 단계별 구현 결과.
