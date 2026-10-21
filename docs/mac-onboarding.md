# Mac 프로그램 준비와 계정 연결

앱을 아직 설치하지 않았다면 [v1134 공증 DMG 설치 안내](user-guide/MAC-INSTALL.md)부터 따릅니다. 앱 설치에는 Git·Bun·소스 clone이나 외부 서비스 계정이 필요 없습니다. 아래 내용은 설치한 앱 안에서 필요한 도구·계정을 준비하는 과정입니다.

‘내 기기와 연결’은 설치 앱 자체에서 시작한다. AI 앱·Node·Git이 없는 Mac에서도
‘이 Mac의 프로그램 준비’가 먼저 상태를 검사하고 선택한 도구를 순서대로 준비한다.
앱 설정에서도 **프로젝트 작업용 CLI**와 **아젠투지 앱 데이터 저장·기기 동기화**를
독립된 영역으로 표시한다.

## 무엇에 적용되는 설정인가

| 영역 | 적용 대상 | 완료 증거 |
| --- | --- | --- |
| Mac 프로그램 준비 | 이 OS 사용자의 앱과 실행 파일 | CLI 실제 버전 명령, 앱의 실제 프로세스 |
| 프로젝트 작업용 서비스 계정 | 이 Mac에서 개발 작업에 사용할 계정 | 계정 이메일 확인과 실제 서비스 API 응답 |
| 고급 직접 등록 | 선택한 서비스의 프로젝트 작업 계정 | 등록 뒤 별도의 연결 확인, 기본값 또는 프로젝트 선택 |
| 프로젝트 연결 | 특정 개발 프로젝트의 계정·대상 선택 | 선택 저장과 실제 대상 접근 권한 검증은 별개 |
| 앱 데이터 저장·기기 동기화 | AgentsToZ 자체 프로젝트 목록·설정·장기기억 | 명시적으로 선택한 전용 Supabase 프로젝트, 기존 보안·연결 검사 |
| iPhone·웹 허용 이메일 | 포털 로그인 가능한 사람 | 동기화 설정의 별도 허용 목록 |

고급 등록은 브라우저 로그인 대신 기존 토큰/사용자 인증 JSON을 사용하는 선택 경로다.
등록만으로 앱 데이터 저장소나 프로젝트를 변경하지 않는다. Google Console Desktop
클라이언트 JSON의 파일 선택·네이티브 드래그와 여러 사용자 계정 연결을 유지한다.
JSON·비밀번호·키·토큰은 AI 인계문·대화·진단 기록에 넣지 않는다.

## 카탈로그와 공식 설치 경로

AI CLI 네 종류는 **Codex·Claude Code·Hermes·agy**다. 서비스 CLI 네 종류는
**GitHub·Vercel·Supabase·Google Workspace**다. Git은 기반 도구이며 중복 CLI로 세지 않는다.

| 항목 | 설치 경로 | 검증 |
| --- | --- | --- |
| Codex / Claude 앱 | Homebrew 공식 cask 메타데이터의 공급사 ZIP/DMG | SHA-256, 고정 bundle ID·Developer ID, Gatekeeper, 실제 실행 |
| Hermes 앱 | Nous 공식 Desktop 페이지의 서명된 Hermes-Setup DMG | bootstrap bundle과 실제 Hermes 앱을 구분; 사용자가 첫 설치를 마친 뒤 실제 앱 실행 검사 |
| Ego Lite | 공식 배포 CDN의 CPU별 DMG | 고정 bundle ID·Developer ID, Gatekeeper, 실제 실행 |
| Git | Apple `xcode-select --install` | 설치 화면을 여는 것과 `git --version` 성공을 구분 |
| Node.js · npm | nodejs.org의 LTS PKG | 공식 SHA-256·Installer 서명·Gatekeeper; macOS Installer에서 사람이 승인 |
| Codex / Claude Code / Vercel / Google Workspace CLI | 공식 npm 패키지를 사용자 전용 prefix에 설치 | 기존 실행 파일을 덮지 않는 링크, 실제 `--version` |
| GitHub / Supabase CLI | 각 공급사의 GitHub release asset | release의 SHA-256 digest, 정확한 실행 파일, 독점 복사, 실제 `--version` |
| Hermes CLI | Nous 공식 source installer, non-interactive | 기존 설치 건너뛰기, 실제 `--version`; 계정 설정은 별도 |
| agy CLI | 공식 bootstrap의 release manifest | 공식 SHA-512, 정확한 바이너리, 실제 `--version`; quarantine·셸 별칭 제거 없음 |

Node/npm이 필요한 선택에는 기반 Node 검사를, Hermes CLI에는 Git 검사를 추가한다.
기존 설치·인증·프로젝트별 계정 선택을 보존한다. Homebrew 설치는 필요하지 않다.
외부 프로그램의 설치 스크립트가 정상 설치 과정에서 사용자 PATH를 추가할 수 있지만,
기존 계정 재로그인·셸 초기화·강제 재설치는 하지 않는다.

## 대기·실패·재시작

`MacSetupHost`는 버전이 결속된 하나의 기기별 작업 기록을 보유한다. 네이티브 전용
onboarding capability, 같은 TCP peer의 HMAC proof, 고정 작업/도구 ID만 허용한다.
중복 클릭은 같은 요청을 읽고, 다른 요청은 현재 작업이 끝날 때까지 거절한다.
설치 결과가 불확실하면 먼저 다시 검사해야 하며 자동 재실행하지 않는다.
CLI 작업 프로세스는 부모 수명 감시·시간·출력 한도를 둔다. 별도 OS Installer의 취소와
OS 보안 승인 자체는 사람이 처리한다. 실행 파일이나 설정을 되돌리며 삭제하지 않는다.

계정의 ‘연결 확인’과 ‘기존 로그인 확인·연결’은 짧은 admission 응답과 durable receipt로
처리한다. 키체인을 기다리며 WebView 요청을 붙잡지 않는다. 화면에는 확인 대기와
‘같은 계정 확인 결과 보기’를 표시하고 ID만 로컬에 보존한다. 재시작 후 미확정 확인은
중단 상태로 표시하며, 승인 여부를 성공으로 추정하지 않는다. 브라우저 로그인도 같은 ID의
결과를 재조회한다. 서비스가 달라도 인증은 하나씩 진행한다. Chrome 계정 프로필을 직접
선택하면 그 프로필에서 승인 링크를 열고, 선택하지 않으면 앱의 브라우저 설정을 따른다.

Codex/Claude 앱이 준비되면 현재 기록의 상태만 담은 안내를 복사하고 그 앱을 실제로 연다.
복사·링크 열기·AI의 완료 문구로 설치나 인증을 완료 처리하지 않는다.

## 참고 대상과 검증

사용자 원문 **“nhcs usher”**의 로컬 참고 대상은 `work/nhdesign-usher`이며 README의
제품명은 **nhdesign usher**다. `setup_actions.rs`와 `desktop_apps.rs`의 실제 누락 설치·
서명 확인·OS 승인 경계를 참고했다. 별개 제품의 지식 DB·플러그인·개인 배포 URL은
가져오지 않았다.

정상 검사: `python3 scripts/agentstoz-maintainer.py run --root . --profile mac-onboarding`.
설정된 관점: `python3 scripts/agentstoz-maintainer.py personas run --root .`.
외부 설치 실증은 명시적 `bun scripts/verify-mac-installers.ts --isolated-network-check`로
별도 실행한다. 임시 HOME·prefix에서 공식 CLI를 실제로 설치·버전 실행하고 삭제하며,
계정 로그인·시스템 앱 설치·데이터베이스 쓰기는 하지 않는다. 격리된 화면 검사와
실제 새 Mac의 관리자 승인·개별 AI 앱 첫 로그인은 서로 다른 증거다.

공식 근거(2026-10-18 확인): [Codex](https://developers.openai.com/codex/app/),
[Claude](https://claude.com/download), [Hermes Desktop](https://hermes-agent.nousresearch.com/desktop),
[Hermes 설치](https://hermes-agent.nousresearch.com/docs/getting-started/installation),
[Ego Lite](https://lite.ego.app/), [Node.js](https://nodejs.org/en/download),
[GitHub CLI](https://cli.github.com/manual/gh_auth_login),
[Supabase](https://supabase.com/docs/guides/local-development/cli/getting-started),
[Vercel](https://vercel.com/docs/cli), [Google Workspace](https://github.com/googleworkspace/cli),
[agy](https://antigravity.google/docs/cli/install/).
