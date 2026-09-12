# GitHub 설치·로그인 대표 경로 구현

2026-09-11. [전체 계획](PLAN.md)의 O1/O2 대표 경로다. 전체 도구/신규 고객 클라우드
온보딩이나 배포 완료를 뜻하지 않는다. 첫 단계 준비 기록은 [EXECUTION.md](EXECUTION.md)를 따른다.

## 사용 흐름

설치 앱의 설치·연결 현황판 → GitHub 선택 → 설치 준비 → 영향 확인 → 설치 시작 →
서명·체크섬·실제 실행 확인 → GitHub 계정 연결 → 일회용 코드 복사 및 공식 화면 열기 → 연결 확인.
이미 있는 실행 가능한 CLI/로그인은 재사용한다. 네트워크나 사용자 지정 credential 환경이
불확실하면 새 로그인/설치를 시작하지 않는다. 설치는 현재 검증된 Apple Silicon Mac만 제공한다.

Mac 앱이 설치된 상태에서 Bun/Homebrew/Xcode부터 설치하라는 경로를 만들지 않는다.
GitHub CLI는 사용자 계정의 `~/.local/bin/gh`에 설치하며 앱 API와 Tauri 실행 경로에서 찾는다.
기존 gh, SSH 키, 셸 설정을 덮어쓰지 않는다. CLI 설치 완료와 계정 연결 완료는 별도다.

## 실제 배포본 검사로 수정한 결정

공식 v2.100.0 universal PKG는 SHA-256이 공식 릴리스와 같지만 `pkgutil`에서 서명이 없었고
`spctl --type install`에서 거부됐다. 이 PKG를 신규 사용자 경로에서 사용하지 않는다.

공식 arm64 ZIP과 그 안의 `bin/gh`를 각각 고정 SHA-256으로 검증한다. ZIP 전체를 풀지 않고
정확한 항목 하나만 크기·시간 제한 안에서 읽는다. binary의 `codesign --verify --strict`,
GitHub Team ID `VEKTX9H2N7`, identifier `gh`를 검사한다. raw CLI의 `spctl` 결과는
“code is valid but does not seem to be an app”이므로 앱용 Gatekeeper 심사 통과라고 보고하지 않는다.
실제 격리 설치본의 `gh --version` 실행을 확인했다. quarantine 제거/보안 검사 해제는 하지 않는다.

공식 근거: [v2.100.0 릴리스](https://github.com/cli/cli/releases/tag/v2.100.0),
[Mac 설치 안내](https://github.com/cli/cli/blob/v2.100.0/docs/install_macos.md),
[공식 서명 스크립트](https://github.com/cli/cli/blob/v2.100.0/script/sign),
[로그인 계약](https://cli.github.com/manual/gh_auth_login).

## 권한·재개 계약

- Tauri `onboarding_management_request`만 호출하는 고정 `/api/onboarding/github` POST.
  별도 0600 capability와 별도 domain HMAC proof를 사용한다. 같은 TCP 연결에서 상대를 확인한 뒤
  capability를 보내며, 원격/Agent Runtime/발언 feed 권한으로 대체할 수 없다. 웹 Origin은 거부한다.
- recipe ID, 실행 ID, revision, 상태, 소유 프로세스만 SQLite에 기록한다. UI가 실행 명령·경로·완료
  증거를 제공하지 않는다. 준비 검토는 5분 유효하며 recipe 변경 뒤에는 새 검토가 필요하다.
- 설치 파일 변경 전에 durable intent를 저장한다. `link`의 no-replace 동작으로 기존 파일을
  덮어쓰지 않는다. 전원 종료 뒤에는 결과 확인만 제공하고 설치/로그인을 자동 재실행하지 않는다.
- 손상된 고정 recipe의 전용 다운로드 캐시는 재검증 후 복구할 수 있다. 사용자 설치본은 제거하지 않는다.
- 로그인 guard가 같은 실행·revision의 예약을 먼저 활성화한 뒤에만 CLI를 시작한다. 부모의 종료,
  취소 또는 변경된 예약은 늦은 실행을 막는다. 부모 파이프 EOF/종료 감시와 소유 process group으로 정리한다.
- 로그인은 프로젝트/일반 AI 터미널을 거치지 않는다. CLI 원문은 저장하거나 전달하지 않고, 고정 형식
  일회용 코드만 최대 10분인 해당 활성 세션의 메모리에 둔다. 종료/취소 시 제거한다.
- GitHub 공식 로그인은 GitHub.com·HTTPS·SSH 키 업로드 건너뛰기로 고정한다. 사용자의 명시적 클릭으로
  코드를 복사하고 고정 공식 URL을 연다. 비밀번호/토큰 입력 API는 없다. 사용자 지정 GH_TOKEN,
  GH_CONFIG_DIR 등 환경이 있으면 기본 계정으로 몰래 전환하지 않고 확인 필요로 남긴다.

## 확인한 증거와 남은 검증

- 실제 공식 ZIP → 정확한 binary 추출 → 서명 확인 → 격리 HOME 설치 → 실행 버전 확인 → 기존 파일
  덮어쓰기 거부 통과: `bun tests/onboarding-github-artifact-check.mjs <공식 ZIP 경로>`.
- 상태/HTTP 시험: 검토 전 실행 금지, 중복 실행 금지, 취소 뒤 늦은 결과 거부, 준비 부작용 없는 조회,
  설치 재사용, 불확정 로그인 판정, 코드 비저장, 독립 capability/Origin 제한.
- 실제 guard 프로세스 시험: 로그인 원문/상속 토큰 전달 없음, 부모 SIGKILL 뒤 로그인 프로세스 종료.
- Chromium 시험: 검토→설치 한 번→로그인→새로고침 후 같은 작업→코드 전달→성공 후 코드 제거.
  `bun tests/onboarding-github-ui.mjs`는 격리 실행 효과를 쓰며 실제 외부 계정 인증을 대신하지 않는다.
- 최종 `bun run verify` 통과: TypeScript, Bun 4,089 pass/0 fail, Rust 57 pass/0 fail. Vite 빌드와 390px 밝은/어두운 Chromium 확인 통과.
- 첫 전체 검사에서는 기존 프롬프트 보관함 1 MiB 경계 시험이 한 번 시간 초과됐다. 해당 파일 단독 9 pass 및 전체 재검사 통과를 확인했으며 테스트를 느슨하게 바꾸지 않았다.

새 Mac의 실제 신규 계정 로그인·Keychain 권한/잠김/저장 실패, Git 미설치와 CLI 실제 첫 Git 작업,
공식 서명 앱에서의 설치/재시작, Intel 지원, 외부 배포는 아직 별도 검증이 필요하다. GitHub CLI는
공식 문서상 Keychain 실패 시 평문 저장 fallback이 있으므로, 새 계정으로 해당 경계를 검증하기 전
이 경로의 credential 보관을 무조건 안전하다고 광고하지 않는다. `--insecure-storage`를 사용하지 않는다.

Supabase/Claude/Codex/agy/Hermes/ego 설치 어댑터와 Supabase broker·모바일 고객 gateway,
기존 마법사 이관은 이 대표 경로가 검증된 후 진행한다.

## 후속: 실제 인증 상태와 Keychain 판정

2026-09-11 후속 소스 변경. `gh auth status --active --hostname github.com --json hosts`의
JSON을 검사한다. 공식 CLI는 JSON 모드에서 인증 실패도 exit 0으로 반환하므로 종료 코드만으로
완료 처리하지 않는다. active GitHub.com 계정 하나의 success와 tokenSource=keyring을 모두 확인한다.
명시적 빈 hosts만 로그인 전으로 판정하며, 잠긴 Keychain·시간 초과·잘못된 토큰·모호한 응답은
확인 필요로 유지한다. `--show-token`은 요청하지 않는다.

일반 hosts.yml에 저장된 유효한 로그인은 `storage-review`로 남긴다. 재시작/재조회/설치 재검토가
이 결과를 성공이나 자동 재로그인으로 바꾸지 않는다. 네이티브 설치 카드와 Mac 준비 목록에
같은 기준을 적용한다. GH_CONFIG_DIR뿐 아니라 XDG_CONFIG_HOME이 지정된 환경도 기본 계정으로
전환하지 않는다. 기존 credentials를 지우거나 자동 이전하지 않는다. 이것은 CLI의 평문
fallback을 예방하는 구현이 아니며, 발생한 결과를 발견하고 완료 판정을 막는 구현이다.

- 현재 Mac의 기존 활성 계정: 실제 인증+Keychain 저장 읽기 확인 통과. 계정명·토큰은 출력하지 않음.
- `bun tests/onboarding-github-device-code-check.mjs <공식 gh binary>`: 실제 공식 CLI가 GitHub
  서버에서 코드를 발급하고, 코드를 사용자나 로그에 노출하지 않은 채 승인 전 취소. 소유 프로세스
  그룹 종료 및 격리 HOME에 hosts.yml 미생성 확인. 임시 HOME도 OS Keychain을 분리하지 않으므로
  이 시험에서 계정 승인은 하지 않음. 신규 계정 로그인 성공을 증명하는 시험이 아님.
- 실 프로세스 시험: 취소가 guard의 영수증 획득보다 먼저 발생하면 CLI가 전혀 실행되지 않음.
- JSON 오류/저장 위치 및 호스트 영수증 회귀, Chromium의 저장 확인 경고/새로고침/재로그인 미실행 통과.
- 실제 새 OS 사용자 계정에서의 로그인 승인과 Keychain 잠김/쓰기 실패 시험은 별도 환경이 필요.

공식 판정 근거: [auth status 구현](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/auth/status/status.go),
[Keychain 저장 및 fallback](https://github.com/cli/cli/blob/v2.100.0/internal/config/config.go).

다음 O2 연결 지점은 `SetupWizard.tsx`의 첫 실행과 `App.tsx`의 같은 설정 진입이다.
기존 `onComplete`는 Supabase 단말 등록 전용이므로 로컬 첫 프로젝트 성공에 재사용하지 않는다.
`setup-main.tsx`의 독립 설정 페이지에는 프로젝트 관리 콜백이 없으므로 먼저 앱으로 돌아오는 경로가
필요하다. AI 버전 조회를 첫 작업 성공으로 승격하지 않고 기존 Workroom의 실제 작업 결과와
선택한 등록 프로젝트 ID를 연결해야 한다. 기존 wizard 삭제는 이 경로의 재실행 검증 이후다.

후속 검증 결과: 전체 `bun run verify` 성공(TypeScript, Bun 4,094 pass/0 fail,
Rust 57 pass/0 fail). 마지막 XDG 설정 보호 추가 후 관련 최종 3개 파일 12 pass/0 fail.
Chromium 실제 UI 흐름과 새로고침 후 storage-review 유지 통과. 신규 Mac 로그인 승인,
Keychain 쓰기 실패의 실제 재현, 공식 앱 빌드·설치·배포는 이 결과에 포함하지 않는다.
