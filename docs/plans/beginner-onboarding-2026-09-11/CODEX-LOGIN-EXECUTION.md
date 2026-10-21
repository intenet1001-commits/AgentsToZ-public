# Mac Codex 로그인 도우미 — 2026-09-11

상태: 소스 구현. iPhone 없이 Mac에서 가능한 자동화·회귀 검증을 수행했다. 설치 앱 교체나 공개 배포는 하지 않았다.

## 사용 흐름

Mac 준비 목록에서 Codex 설치를 확인한 뒤 `ChatGPT 계정 연결`을 제공한다.
`로그인 상태 확인 → ChatGPT 계정으로 로그인 → 로그인 화면 열기 → 공식 계정 선택·인증 → 첫 AI 작업` 순서다.
기존 로그인 정보가 있으면 다시 로그인하지 않는다. 캐시 확인과 실제 첫 응답 성공은 별도로 표시한다.
웹/다른 플랫폼은 기존 공식 안내와 명령 복사를 유지한다.

패널을 숨기거나 새로고침해도 같은 호스트의 진행 상태를 읽는다. 로그인 시작을 자동 재실행하지 않는다.
취소·앱 종료·부모 프로세스 소실·10분 만료에는 도우미가 소유한 로그인 프로세스 그룹을 종료한다.
앱 재실행 후에는 중단 상태를 표시하고 실제 결과부터 다시 확인한다. 취소 뒤 늦은 성공은 완료로 승격하지 않는다.

## 구현 경계

- `onboardingCodexLoginHost/Store`의 별도 SQLite 영수증과 revision CAS로 실행을 예약한다.
  guard는 정확한 recipe/id/revision/부모 PID를 선점한 뒤에만 OAuth를 시작한다.
- `/api/onboarding/codex-login`은 설치 앱의 기존 onboarding capability와 peer proof를 사용한다.
  상태·검토·확인·로그인·취소·화면 열기의 고정 동작만 받으며 URL/명령/파일 경로는 받지 않는다.
  Origin 있는 웹 요청과 capability 없는 요청은 거부한다.
- 공식 CLI `codex login`의 browser PKCE/callback 검증을 사용한다. 로그인 화면을 열기 전 정확한
  OpenAI origin/path, public client ID, localhost callback, scope, S256 challenge/state를 확인한다.
  URL은 guard→host의 private pipe와 호스트 메모리에만 존재한다. UI에는 browserReady만 전달한다.
  계정명·인증 코드·원문 출력·URL은 영수증/대화/장기기억으로 보내지 않는다.
- CLI가 별도 `codex-login.log`를 생성하므로 소유자 전용 디렉터리 안의 고정 파일을 `/dev/null`로
  연결하고 `RUST_LOG=off`를 사용한다. 기존 로그를 덮어쓰거나 삭제하지 않는다.
- 실행 파일의 소유자·쓰기 권한·SHA-256 동일성을 로그인 직전에 다시 검사한다. 중립 cwd와 최소 환경을
  사용하며 custom CODEX_HOME/API 키/proxy 같은 별도 실행 환경에서는 자동 계정 전환 없이 검토를 요청한다.
- 공식 Codex의 기존 credential-store 설정을 그대로 사용한다. config/auth 파일을 읽어 토큰을 옮기거나
  설정을 다시 쓰지 않는다. 기존 auth.json의 링크·소유자·권한이 안전하지 않으면 storage-review로 남긴다.
  이 메타데이터 검사는 Keychain 쓰기 성공의 증거가 아니다.
- provider의 `close`는 하위 프로세스가 pipe를 잡고 있으면 늦어질 수 있다. `exit`부터 소유 그룹을
  종료하고 guard 종료를 기다린 후 로그인 상태를 다시 확인한다.
- 기존 워크룸 구조화 실행의 containment 제한은 유지한다. 첫 요청은 기존 읽기 전용 대화를 사용한다.

## 검증

- Bun 행동 검사: URL 변조·중복 파라미터·잘못된 scope/callback, 기존 계정/unknown 보존, 오래된 영수증,
  취소 후 늦은 응답, 중복 호스트, 성공 후 readback, 비밀 없는 DTO/영수증, HTTP capability 제한.
- 실제 프로세스 fixture: 분할/ANSI 출력, raw output와 환경 토큰 차단, 부모 강제 종료,
  예약 전 취소, 정상 종료 뒤 잔존 하위 프로세스 제거.
- Chromium + 실제 SQLite/host fixture: 390px 밝은/어두운 화면, 로그인/화면 열기, 재로드 시 미재실행,
  취소·재검사·첫 작업 진입. 인증 URL은 응답 DTO에 포함되지 않는다.
- 공식 Codex 0.154.0으로 browser 시작 URL을 비공개 검증하고 계정 승인 전에 취소했다.
  auth/config 파일 미생성, 로그인 로그의 `/dev/null` 유지까지 확인했다.
  OS temporary HOME은 공식 CLI의 helper 경고를 유발하므로, 이번 시험은 홈 아래에 새로 만든
  소유자 전용 일회용 디렉터리를 사용하고 삭제했다. parser를 느슨하게 하지 않았다.
  별도 HOME은 OS Keychain을 격리하지 않으므로 계정 승인까지 진행하지 않는다.

재현 명령:

```sh
bun test ./tests/onboarding-codex-auth.test.ts
bun tests/onboarding-codex-auth-ui.mjs
bun tests/onboarding-codex-browser-preflight.mjs <검증된 공식 Codex 절대경로>
bun run verify
```

## 남은 출시 검증

별도 OS 계정/새 Mac의 실제 계정 선택·인증 완료, Keychain 허용/거부, 첫 AI 응답,
서명된 최종 앱의 native proxy 왕복은 후속 검증이다. 이번 browser 준비 성공을 신규 사용자 로그인 완료로 간주하지 않는다.
iPhone Google OAuth/QR/5G 경로와도 별도다.

공식 근거: [Codex 인증·credential store·로그인 로그·device-code 조건](https://learn.chatgpt.com/docs/auth).

검증 결과: `verify`의 TypeScript, Bun 4,112개/실패 0, sidecar/guard 빌드, Rust 57개/실패 0 통과.
중복 호스트·정상 성공 readback 사례를 추가한 뒤 로그인 집중 검사 10개/실패 0 통과.
Vite frontend 빌드와 Chromium 로그인 UI 검사도 통과했다. 최종 앱 설치/계정 승인 완료는 위 후속 범위다.
