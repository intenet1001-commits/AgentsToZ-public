# Codex 자동 설치와 신규 로그인 사전 검증

2026-09-11 소스 구현. 설치 앱·웹·TestFlight 배포는 아직 하지 않았다.

## 사용자 흐름

시작 도우미 → Codex 준비 → 자동 설치 준비 → 설치 내용 확인 → 확인하고 설치 →
다음 단계 확인 → 필요한 경우 로그인 명령 한 번 복사 → OS 터미널과 공식 로그인 화면 →
상태 확인 → 기존 읽기 전용 대화에서 첫 응답 확인.

Apple Silicon Mac의 설치 앱에서 자동 설치를 제공한다. 그 외 환경은 공식 안내를 유지한다.
자동 설치와 수동 설치 버튼을 동등하게 나열하지 않는다. 로그인 자동 대행은 이번 구현에 포함하지 않는다.
현재 설치되지 않은 CLI라도 열린 터미널의 PATH를 갱신할 필요 없이 로그인 명령의 사용자 로컬 경로
fallback으로 실행할 수 있다. 기존 PATH 설치가 있으면 그 설치를 사용하며 셸 설정을 편집하지 않는다.

## 실행과 복구 계약

- 기존 Tauri 설치 capability·같은 TCP peer의 HMAC 증명을 재사용한다. 네이티브 요청은
  고정 `github | codex` 도구 선택만 받는다. Codex HTTP 표면은 `/api/onboarding/codex`의
  `status/review/install/check/cancel`뿐이며 Origin, 임의 경로·명령, 로그인 실행 요청을 거부한다.
- 준비 기록과 같은 개인 SQLite에 별도 Codex 설치 영수증을 저장한다. recipe/revision, 검토 유효시간,
  프로세스 소유, 설치 전 intent, 취소 후 늦은 결과 거부를 적용한다. 화면 열기·새로고침은 영수증만 읽는다.
  중단/이전 recipe는 결과 조회를 먼저 할 수 있지만 자동으로 설치를 재생하지 않는다.
- OpenAI 공식 0.154.0 arm64 전체 패키지를 고정 해시로 검증한다. 약 112MB 다운로드이며
  `bin/codex`, code-mode host, rg, zsh, package manifest의 정확한 5개 entry만 스트리밍으로 추출한다.
  개별 크기/해시와 두 OpenAI 실행 파일의 Developer ID 서명(`2DC432GLL2`)을 확인한다.
  다운로드 180초, 개별 추출 30초, 고정 크기 상한을 적용한다. 앱 Gatekeeper/공증 검증을 대신하지 않는다.
- `~/.local/share/agentstoz/tools/<recipe>/`의 검증된 패키지를 `~/.local/bin`에 no-replace 심볼릭 링크로
  공개한다. 기존 실행 파일·깨진 링크·다른 helper를 덮어쓰지 않는다. helper를 먼저, codex를 마지막에
  연결한다. 공개 도중 중단돼도 같은 검증 패키지를 읽어 재개한다. CODEX_HOME, config, auth, 셸 파일을
  설치 과정에서 변경하지 않는다. 명시적 custom 설치/프로필은 unknown으로 보존한다.
- 다운로드/추출은 고정된 recipe 전용 `.part`만 사용하며, 재시도 때 소유권·형식·크기를 확인한
  중단된 임시 파일만 정리한다. 손상된 설치본/캐시를 자동으로 정상 판정하거나 사용자 파일을 삭제하지 않는다.
- 파일이 존재한다는 것, 설치 확인, cached 로그인, 첫 AI 응답은 각각 다른 결과다. 로그인 검사에
  알 수 없는 경고/오류가 있으면 unknown을 유지한다. 원문과 인증값은 영수증·API 응답에 넣지 않는다.

## 검증 증거

- 최종 TypeScript 검사와 Vite 빌드 통과. 전체 Bun 4,103 pass / 0 fail. Rust 테스트의
  helper 참조 범위를 수정한 후 전체 Rust 재실행 57 pass / 0 fail. 기존 chunk 크기/미사용 코드 경고는 유지된다.
- 실제 공식 패키지를 별도 HOME에 설치: 전체 entry·해시·서명, `--version`, 신규 `login status`,
  중단된 링크 게시 재개, 기존 링크 보호, auth/config 미생성 통과.
  `bun tests/onboarding-codex-artifact-check.mjs <공식 패키지 파일>`.
  `--download` 실행도 통과해 앱의 실제 스트리밍 다운로드 경로부터 설치까지 확인했다.
- macOS의 per-user OS temporary directory 안에 CODEX_HOME을 두면 CLI가 helper 생성 경고를
  출력한다. 이를 무시하도록 제품 parser를 느슨하게 만들지 않았다. 실증은 그 디렉터리와 별개인
  `/tmp` 아래의 일회용 HOME을 사용한다. 이 시험은 새 OS 계정/Keychain 격리 시험이 아니다.
- 실제 CLI의 `login --device-auth`를 별도 CODEX_HOME·명시적 file backend에서 시작했다.
  공식 URL과 일회용 코드 발급을 확인한 즉시 승인 전에 프로세스 그룹을 종료했다. auth/config 파일이
  생성되지 않았음을 검증했다. ANSI 색상 escape를 제거한 뒤 고정 코드 형식을 판별하며 코드를 출력·보관하지 않는다.
  `bun tests/onboarding-codex-login-preflight.mjs <검증된 CLI 절대경로>`는 명시 실행용이며 일반 테스트에서 호출하지 않는다.
- Bun 행동 검사: 설치 전 intent, 재로드/재검사에서 미실행, 기존 설치 재사용, unknown 보존,
  동시 창/오래된 검토/취소, 이전 recipe readback, native HTTP 제한, 잘린 다운로드 정리,
  로그인 PATH fallback 및 공백 포함 HOME. 기존 GitHub 회귀도 유지한다.
- 실제 Chromium + SQLite/host fixture: 명시적 설치, 설치 중 새로고침, 완료 후 재로드,
  다음 단계 클릭, unknown 보존, 390px 밝은/어두운 화면. 실제 App의 첫 응답 진입 회귀도 통과.
- 전체 검증 중 기존 프롬프트 보관함의 1MiB 초과 요청 직후 조회가 정지하는 문제가 단독으로도
  재현됐다. 조기 413에서 `Connection: close`만 설정하면 Bun의 읽지 않은 업로드가 남을 수 있어,
  잠기지 않은 본문을 취소하되 취소 완료를 기다리지 않도록 수정했다. 기존 8회 반복 거절/조회와
  끝나지 않는 cancel promise 검증을 유지한다. 사용자 기억/프롬프트 데이터는 변경하지 않았다.

## 남은 출시 조건

신규 OS 계정에서 로그인 완료·Keychain 허용/거부·인증 취소와 첫 응답을 실제로 검증해야 한다.
자동 로그인 guard는 이후 [로그인 후속 기록](CODEX-LOGIN-EXECUTION.md)에서 구현했다. 기존 credential 저장 설정을 보존하며 새로운 저장 방식을 강제하지 않는다. device-code 발급은 로그인 완료가 아니며,
사용자 계정/워크스페이스에서 device-code 사용 허용이 필요할 수 있으므로 기본 사용자 안내는 `codex login`을 유지한다.
네이티브 패키지의 전체 왕복, Intel 지원, 서명된 최종 앱의 clean 설치와 공개 배포도 남아 있다.

공식 근거: [CLI 설치](https://learn.chatgpt.com/docs/codex/cli),
[인증과 device-code 조건](https://learn.chatgpt.com/docs/auth).
