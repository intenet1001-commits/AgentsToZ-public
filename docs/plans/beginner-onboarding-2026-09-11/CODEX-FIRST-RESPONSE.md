# Codex 준비와 첫 응답 연결

2026-09-11. O2 후속 소스 구현. 자동 설치·OAuth 대행이나 신규 Mac 출하 검증 완료를 뜻하지 않는다.

후속: Apple Silicon Mac 자동 설치는 [설치 실행 기록](CODEX-INSTALL-EXECUTION.md)에 구현했다.
아래 수동 설치 설명은 첫 응답 연결을 먼저 만든 시점의 기록이다. 로그인 자동 대행은 여전히 별도 단계다.

## 현재 사용자 흐름

시작 도우미 → AI 연결 준비 → Codex 선택 → 상태 확인 → 필요한 경우 공식 설치/로그인 명령 복사 →
별도 OS 터미널과 공식 로그인 화면에서 진행 → 상태 재확인 → 첫 AI 작업 열기 → 등록 프로젝트를
선택해 읽기 전용 Codex 대화에서 첫 질문 → 실제 응답 확인. 명령 복사·패널 열기·저장된 로그인
정보 발견은 성공으로 승격하지 않는다. 대화와 결과 기록은 기존 대화 실행 경로를 사용한다.

- 설치 유무, 저장된 로그인 정보(`configured`), 실제 응답을 구분한다. CLI `login status`의
  ChatGPT/API key 로그인 표시를 고정 범주로만 변환하고 계정·키·원문은 DTO/기억에 넣지 않는다.
- 명시적인 `Not logged in` 실패만 재로그인 안내다. 시간 초과·Keychain/구성 오류·알 수 없는 출력은
  기존 credentials를 유지하고 확인 필요로 둔다. 상태 검사는 중립 작업 디렉터리에서 제한 시간 안에 실행한다.
- Codex 공식 설치 명령은 기존 카탈로그의 공식 installer 주소를 재사용한다. 아직 앱이 검증한 고정
  배포본을 자동 설치하는 mutation recipe는 아니다. 복사 성공은 설치 완료가 아니며 실제 재검사가 필요하다.
- 로그인 명령은 일반 AI 워크룸이 아닌 별도 OS 터미널에 사용자가 붙여 넣는다. 앱에 비밀을 입력하거나
  기존 계정을 로그아웃시키지 않는다. 기존 CODEX_HOME/credential 구성을 변경하지 않는다.
- 구조화된 workspace-write 작업은 `AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED=false`로 계속 닫혀 있다.
  첫 응답 버튼은 사용 가능한 기존 read-only conversation 표면으로만 이동한다. 이 제한을 새 온보딩으로
  우회하지 않는다. 기존 초안을 덮어쓰거나 자동 프롬프트/작업을 제출하지 않는다.
- 이후 파일 수정은 별도 워크룸에서 사용자가 시작한다. 터미널 실행 성공이나 연결 상태를 의미상 작업
  완료로 처리하는 새로운 상태 머신은 만들지 않는다.

## 증거와 한계

- 전체 `bun run verify`: TypeScript 통과, Bun 4,097 pass / 0 fail, Rust 57 pass.
  Vite 웹 빌드 통과. 실제 App의 시작 도우미에서 첫 응답 버튼을 누르면 읽기 전용 대화 탭으로
  이동하고 AI 요청을 자동 제출하지 않는 브라우저 통합 시험도 통과했다.
- parser/준비 상태 테스트: 로그인 정보 있음이 준비 완료가 되지 않음, API 키 형태 문자열 비노출,
  실패/시간 초과 분리. 실제 Chromium: 미설치→로그인 필요→configured→재로드→명시적 첫 작업 이동,
  unknown에서 자동 재로그인 버튼 없음 확인.
- 실제 설치된 codex-cli 0.154.0으로 기존 계정의 read-only·ephemeral 실행 1회를 시험했다.
  격리 임시 폴더에서 짧은 프로젝트 시작 체크리스트를 요청해 exit 0/비어 있지 않은 응답을 받았다.
  사용자 프로젝트 파일을 제공하지 않았고 임시 폴더는 정리했다. 이 CLI 실증은 새 네이티브 UI에서
  OAuth를 완료했거나 같은 UI 대화 영수증을 검증했다는 뜻이 아니다.
- 신규 계정 로그인·OS Keychain 권한과 저장 실패 실증, pinned installer 자동 실행, 서명된 앱에서
  전체 단계 왕복 및 신규 사용자 첫 결과 시험은 아직 남아 있다. 설치 앱/웹/TestFlight 배포 없음.

공식 근거: [인증·credential storage](https://learn.chatgpt.com/docs/auth),
[CLI 설치](https://learn.chatgpt.com/docs/codex/cli). `keyring`은 저장소 불가 시 실패하고 `auto`는
파일 fallback이 있다. 신규 로그인 도우미에 strict keyring을 적용하려면 기존 실행과 같은 저장 설정을
보존하는 별도 설계가 필요하며 임시 CLI 옵션만 바꾸고 전체 앱 인증이 완료됐다고 보고하지 않는다.
