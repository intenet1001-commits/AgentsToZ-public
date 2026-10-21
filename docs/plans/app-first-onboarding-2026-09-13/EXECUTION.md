# 앱 온보딩 구현 기록

2026-09-13 · 시작 소스 `7955986` / 설치 Mac v463. 사용자의 “진행시켜”에 따라 구현.
P0~P6 전체 완료나 Mac TestFlight 출시 준비 완료를 뜻하지 않는다.

최신 실행 우선순위는 [TEST-PLAN.md](TEST-PLAN.md)에 갱신했다. 사용자가 실행을 요청해
추가 기능 회귀→새 앱 빌드→실제 기능 검사를 진행 중이다. 이번 결과는 [TEST-RESULTS.md](TEST-RESULTS.md)에 기록한다.
아래 서명·TestFlight 기록은 이 변경 전의 이력으로 보존한다.

## 구현한 흐름

- 앱 헤더의 설정 버튼은 `내 기기와 연결`을 바로 연다. 최초 실행은 기존 시작 도우미를 유지한다.
  연결 센터에서 단말·동기화 설정과 휴대폰·개인 포털 안내로 이동한다. 기존 신원 보호 정책을 그대로 사용한다.
  첫 프로젝트 모달을 열기 전에 Git·기억·백업·자동 실행 옵션을 확정해 첫 화면에서 기존 기본값이 노출되는 시차를 제거했다.
- CLI 설치, 저장된 인증 정보, 확인된 로그인과 첫 실제 작업을 구분한다.
  `--version` 또는 Codex cached 인증만으로 준비 완료를 표시하지 않는다.
- 단말/도구 조회와 JSON 해석을 각각 처리한다. 한 조회가 실패해도 다른 성공 결과는 남기며,
  실패한 조회의 이전 녹색 상태는 지운다. 마지막 검사 시각과 재검사 상태를 표시한다.
- 동기화 표시는 현재 Supabase 응답과 과거 Push 기록을 분리한다. 과거 기록이 현재 장애를 덮지 않는다.
  이것을 Google 로그인·원격 작업 검증으로 확대하지 않는다.
- ChatGPT/Codex, Claude Desktop/Code, 다른 AI 선택과 공식 앱 안내, 현재 단계 인계문 복사·수동 복사 대안을 추가했다.
  기존 SQLite 준비 기록의 runId/revision/recipe/단계/검사 시각만 전달한다. 새 온보딩 저장 엔진을 만들지 않았다.
  복사로 상태를 변경하지 않으며 `AI 작업 후 다시 확인`이 기존 호스트 진단을 호출한다.
  MCP handshake, AI 앱 설치 감지, 첫 작업 영수증을 새로 구현한 것은 아니다.
- legacy `/api/supabase-cli/status`의 프로젝트 조회에 10초 deadline·출력 상한·stdin 종료를 적용했다.
  진행 중인 동일 CLI 조회만 합치며 다음 조회는 새로 실행한다. JSON 목록을 검증하고 필요한 필드만 반환한다.
  네트워크/권한/출력 형식 오류는 `unknown`/`loggedIn:null`이고 명백한 미인증만 로그인 필요로 처리한다.
  CLI 경로 탐색의 로그인 셸에도 2초 제한을 적용하고 기존 Windows 경로를 보존했다.
- 설치 sidecar의 CLI 포털 배포는 소스 부재를 외부 변경 전에 알린다.
  현재 공개 템플릿의 `Deploy with Vercel` 안내로 연결한다. 설치본 단독 자동 배포 패키지는 아직 없다.
- Claude/Codex 온보딩 스킬을 설치 앱 우선으로 고쳤다. 소스 실행 사용자에게만 Bun/clone 절차를 적용한다.

## P0에서 확인한 배포·환경 제약

| 항목 | 확인 근거 | 판정 |
|---|---|---|
| 현재 설치본 서명 | `codesign -dv /Applications/AgentsToZ_byCS.app`: `Signature=adhoc`, `TeamIdentifier=not set` | 현재 파일을 배포용 Mac TestFlight 빌드로 간주할 수 없음 |
| 현재 sandbox | Tauri macOS 설정에 App Sandbox entitlement 없음. native client/broker entitlement에도 app-sandbox 없음. 설치본 entitlement 조회에도 sandbox 없음 | sandbox 안의 CLI/PTY/폴더/메모리/업데이트 실증 필요 |
| 다중 OS 사용자 | per-user 앱 데이터지만 Tauri `LOCAL_API_ADDR`와 MCP endpoint는 고정 3001 | 실제 OS 계정 동시 실행 미검증; HOME 분리 시험으로 대체하지 않음 |
| 소스 없는 개인 배포 | `runPortalVercelCommand`의 cwd는 `import.meta.dir`; `runPortalDeployment`는 link/env/deploy를 순서대로 실행 | Bun standalone의 가상 module 경로를 배포 소스로 사용 불가. guarded fallback만 반영 |
| Google OAuth | Cloud project, OAuth client, Supabase provider, 개인 포털 redirect는 서로 다른 단계 | 신규 사용자 전체 OAuth 및 secret 전달 자동화 미실증 |

Apple의 TestFlight 규정(2.2)과 Mac 배포 규정(2.4.5)을 읽었다.
이는 현재 앱의 심사 승인/거절 결과가 아니다. 전체 호스트의 TestFlight 적합성은 미확정이고,
이후 사용자가 Mac도 TestFlight에서 다운로드한 앱으로 직접 검사하는 방향을 지정했다.
Developer ID 우선 선택 질문은 이 지시로 해소됐으며 다시 묻지 않는다. 2026-09-13 재조회에서 로컬 codesigning identity는 Apple Development와 Developer ID Application만 확인됐다. 이는 Xcode가 관리하는 배포 인증서를 생성할 수 없다는 뜻은 아니다.
Mac App Store/TestFlight 패키징·프로비저닝·서명 경로 준비 → 업로드 처리 → 실제 TestFlight 설치를 다음 실행 순서로 고정한다.
[Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

## 검증

- 도구/단말 부분 실패, cached 인증, 과거 Push·현재 장애, 인계 비밀 필드 거부 및 동일 run 유지 회귀 테스트 추가.
- Supabase 프로세스 정지/timeout, 알려지지 않은 응답, 중복 프로젝트, 비밀 필드 제외, 동시 조회 합치기·다음 조회 갱신 테스트 추가.
- 집중 테스트 30 pass / 0 fail (전체 검사 및 후속 수정 결과는 아래에 갱신).
- 기존 `onboarding-preparation-ui.mjs`: StrictMode, 선택 저장, 증거 구분, 재실행, 보류/재개 통과.
  현재 단계 복사와 clipboard 실패 후 수동 복사에서도 준비 기록의 revision이 바뀌지 않는 검증을 추가했다.
- 실제 Vite App 번들의 `onboarding-first-project-app-ui.mjs`: 초기 옵션, 기존 폴더 등록, 재실행 후 동일 프로젝트,
  헤더에서 연결 센터 바로 열기, 첫 AI 작업 화면 이동, Control 생성 콜백 통과. 네트워크·저장은 fixture로 격리했다.
- 임시 SQLite와 고정 가짜 진단을 사용하는 fixture를 Ego Browser로 조작했다:
  목록 저장 → AI 작업 후 확인 → 인계문 복사 → 페이지 재시작 시 같은 run/revision 유지 →
  조회 실패 때 현재 연결/준비됨 제거 → Claude 선택 및 복사 → 정상 응답 복구 통과.
  실패 문구의 exact selector 한 차례 timeout은 DOM의 접두 문구 차이였고 현재 DOM으로 실제 실패 상태를 확인했다.
- 현재 사용자 Supabase CLI의 읽기 전용 조회: 설치·인증·JSON 프로젝트 목록 파싱 성공, 5개 항목, 약 891ms.
  기록에는 계정/프로젝트 이름·토큰을 출력하지 않았다. 이 결과는 신규 사용자의 클라우드 전체 여정 시험이 아니다.
- 전체 `bun run verify`: exit 0. Bun 4,231 pass / 0 fail. Rust 58 pass / 0 fail.
  첫 전체 실행의 1건 실패는 이전 API 내부 문자열에 결속된 Windows 경로 테스트였다. 공통 resolver의 실제 반환 경로를 검사하도록 바꾸고 전체 재실행했다.
- 마지막 CLI 탐색/첫 프로젝트 모달 수정 뒤 typecheck, 관련 집중 25건, 실제 App UI 및 오프라인 SetupWizard UI를 추가 확인했다.
- 프런트 production build 통과. 기존 번들 크기 경고는 남아 있다. 이 빌드는 공개 출하용 서명 Mac 앱이 아니다.
- 검사 로그: `/tmp/agentstoz-app-first-verify-final.log`, `/tmp/agentstoz-app-first-build-final.log`.
  테스트 UI 서버와 브라우저 작업 공간은 종료했다. Git 커밋·Push, 공개 snapshot 갱신, 설치 앱 업데이트, TestFlight 업로드는 하지 않았다.

## 아직 남은 작업

1. P0: **Mac TestFlight 우선으로 결정됨.** Store 배포 서명·패키징을 준비하고 실제 새 OS 사용자/설치본을 테스트한다. Mac TestFlight용 빌드는 생성·업로드하지 않았다.
2. P1: 사용자별 endpoint·capability 발견/갱신, provider/account 세대 결속, 전체 probe 동시성 예산.
3. P3: 실제 AI 앱/MCP 연결 확인과 첫 작업 결과 영수증. 현재 인계는 복사와 기존 상태 재검사까지다.
4. P4: 선택 계정/리소스에 결속된 Supabase→Google OAuth→Vercel recipe 및 중단 복구,
   설치본용 배포 패키지, secret 보안 입력. “클릭과 AI 복사만으로 전체 설정 완료”는 아직 충족하지 않았다.
5. P5/P6: 새 계정 iPhone 외부망 작업·저장·앱 업데이트 뒤 30일 승인 유지 실기, 공개 snapshot 배포 검증.

사용자의 기존 Supabase/Google/Vercel 자원, 원격 승인, 프로젝트·장기기억 데이터를 변경하지 않았다.

## Mac 배포 인증서 실제 준비 (2026-09-13 후속)

- App Store Connect 로그인 확인. AgentsToZ 앱(6811520132)에 현재 iOS만 표시됨. iOS 462 업로드 Complete, 빌드 Ready to Submit, 개인 테스트 그룹·초대 1건 표시. Mac 빌드는 확인되지 않음.
- Xcode에 등록된 소유자 개발자 팀에서 Apple Distribution 및 Mac Installer Distribution 인증서를 실제 생성. security find-identity에서 두 인증서와 개인키를 유효한 identity로 확인. 기존 Developer ID 인증서는 보존.
- 설치 v463은 codesign strict 검증을 통과하지만 adhoc, TeamIdentifier 없음, sandbox·embedded profile·앱 category 없음. 새 온보딩 변경을 포함하지 않음.
- 설치 앱을 임시 폴더로 복사해 Apple Distribution 서명 실증 시작. 첫 codesign은 45초 응답 없이 timeout. 재시도는 OS 승인 대기를 위해 최대 600초로 실행. SecurityAgent UI는 컴퓨터 도구 정책상 접근 불가라 자동 승인하지 않음. 서명 성공·패키지 생성·TestFlight 업로드는 아직 미확인.
- 이 복사본은 서명 실증 전용이며 설치/업로드 대상이 아님. 실제 TestFlight는 sandbox 동작 검증, Mac App ID/배포 profile, 최신 공개 소스 빌드 및 signed pkg가 추가로 필요.

### 키체인 승인창 비활성화 조사

- Apple Distribution identity는 현재 유효함. Security framework의 SecKeychainGetStatus로 기본 키체인이 unlocked/readable/writable임을 확인. 암호·키 본문은 조회하지 않음.
- codesign 샘플에서 SecKeyCreateSignature → SecurityServer generateSignature IPC 대기 확인. 네트워크 timestamp 단계가 아닌 개인키 서명 응답 대기다. 다만 버튼 비활성화 원인(원격 입력/보안 UI 상태 등)은 미확정.
- 반복 timeout 뒤 남아 대기하던 이번 작업의 codesign PID 95632만 SIGTERM으로 종료. 다른 보안 프로세스·인증서·키체인 ACL은 변경하지 않음.
- 컴퓨터 도구가 SecurityAgent뿐 아니라 Terminal 접근도 safety 이유로 거부함. 다른 자동화 경로로 우회하지 않음. Mac 본체에서 사용자가 직접 실행할 서명 확인용 Mac-signing.command를 격리 복사본 옆에 생성. 아직 실제 서명 완료/PKG/TestFlight 성공 없음.
