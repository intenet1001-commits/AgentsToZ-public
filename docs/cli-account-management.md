# CLI 계정 관리

워크룸에서 Codex CLI·Claude Code의 복수 로그인 프로필과 프로젝트·CLI별 기본 계정을 관리한다. Codex 앱·Claude Desktop 로그인은 별도이며 이번 범위에 포함되지 않는다.

## 사용

1. 워크룸에서 프로젝트와 Codex 또는 Claude를 선택한다.
2. **계정 관리 → 계정 추가**에서 이름을 입력한다.
3. **공식 로그인**을 눌러 호스트 PC의 제공자 화면에서 인증한다. 최초 로그인과 만료 후 재인증은 사용자가 완료한다.
4. **새 작업의 계정**을 선택한다. 새 작업부터 적용되고 기존 작업과 **다시 시작**은 원래 계정을 유지한다.
5. 원격 선택은 호스트의 **이 기기의 워크룸 작업 허용**에서 해당 프로젝트와 **CLI 계정 선택**을 별도로 허용한다.

**현재 CLI 계정**은 기존 환경을 사용하는 호환 선택지다. 기존 계정을 로그아웃시키거나 인증 파일을 옮기지 않는다. 추가 프로필의 설정·MCP 연결·대화 기록은 독립적이다. **목록에서 제외**는 새 실행과 기본 선택을 해제하며 로그인 파일·기록은 보존한다. 제공자 세션 폐기는 제공자의 공식 관리 화면에서 수행한다.

## MCP

- `agentstoz_use_list_workroom_accounts(portId, agent)` 또는 `target=ops`: 등록 이름·캐시된 인증 상태·프로젝트 기본 선택 조회.
- `agentstoz_use_select_workroom_account(portId, agent, accountId, requestId)`: 인증 확인 후 이후 작업의 기본 선택 변경.
- `agentstoz_use_start_workroom_session(..., accountId?)`: 등록 계정으로 실행. 생략 시 프로젝트 기본 선택. `reuse=true`는 같은 계정의 실행 중인 세션만 재사용.

새 변경에는 새 요청 ID를 쓰고 같은 의도의 재시도만 같은 ID를 재사용한다. 이전 선택 재전송이 이후 선택을 되돌리지 않는다. 등록·로그인·이름 변경·목록 제외는 로컬 관리 경로에만 있다.

## 인증과 권한

앱 데이터의 `cli-accounts-v1/registry.json`에는 메타데이터만 저장한다. 계정 경로는 서버가 생성한 UUID로 만든다. POSIX 루트·계정 폴더는 `0700`, 레지스트리는 `0600`이다. 심볼릭 링크, 계정 폴더 inode 변경, 노출된 인증 파일과 잘못된 레지스트리는 거부하고 자동 덮어쓰지 않는다. Windows는 사용자 프로필 접근 제어를 따른다.

추가 Codex는 전용 `CODEX_HOME`과 공식 `file` 저장 방식을 쓴다. 이는 암호화된 OS vault가 아니며 사용자 전용 파일 권한으로 보호한다. Claude는 전용 `CLAUDE_CONFIG_DIR`와 `auth login --claudeai`를 쓴다. macOS에서 CLI가 디렉터리별 Keychain 항목을 관리하며 공식 파일 fallback도 해당 프로필에 남는다. Console/API 인증은 추가 프로필 범위에서 제외한다. 알 수 없는 인증 방식은 로그인 성공으로 표시하지 않는다.

명시적 프로필은 상속된 OpenAI/Anthropic 토큰·대체 제공자 설정·sidecar capability를 제거한다. 로그인 출력·이메일·토큰·경로는 HTTP/MCP/원격 DTO에 포함하지 않는다. 공식 로그인은 한 번에 하나이며 취소, 10분 제한, 출력 상한, 정상 호스트 종료에서 소유 프로세스 트리를 정리한다. 새 실행은 인증 검사 뒤 실행 직전에 로그인·프로필·프로젝트·원격 권한을 재검증한다.

로컬 API는 기존 Agent Runtime capability 뒤의 정확한 `POST /api/agent-runtime/terminals/accounts`다. 원격 목록·선택은 기존 암호화 terminal envelope 안에서 등록 프로젝트를 다시 해석하고 `account.select`를 검사한다. 원격 등록·로그인·임의 경로·환경·credential 입력은 없다. 대직의 제한 실행은 기존 호스트 계정을 유지한다.

## 기록과 자원

기존 ‘내가 한 말’ 동의와 장기기억 관찰은 확인된 추가 프로필의 기록 폴더도 찾는다. 계정들은 기존 수집 바이트 예산, 최신 Codex 96개 후보, 장기기억 2 MiB 헤더 읽기·후보 제한을 공유한다. 계정별 타이머·AI 호출을 추가하지 않는다. CLI 선택은 기억 정리 제공자의 별도 동의·정책을 변경하지 않는다.

최대 24개 프로필, 2,048개 프로젝트·CLI 선택, 24시간의 최대 512개 변경 영수증으로 제한한다. 보관된 계정·원본 기록을 용량 때문에 삭제하지 않는다. 로그인 조회는 진행 중이고 관리 화면이 보일 때만 실행한다. 화면을 닫아도 로그인·실제 작업은 유지된다.

## 검증 범위

`tests/cli-accounts.test.ts`, `tests/cli-accounts-api.test.ts`, `tests/cli-account-observers.test.ts`는 저장·재시도, 인증 격리, 원격 권한 회수, 로그인/실행 경합, 세션·재시작, MCP 재사용과 기록 수집을 검증한다. API는 실제 sidecar·MCP 어댑터·PTY에 가짜 인증을 연결한다. UI fixture: `bun tests/fixtures/cli-accounts-ui-server.ts`.

현재 Mac의 Codex CLI 0.160.0·Claude Code 2.1.296는 빈 전용 프로필의 읽기 전용 검사에서 모두 `signed-out`을 반환했다. 기존 사용자 로그인과 모델 요청은 실행하지 않았다. 실제 두 계정 로그인·token refresh, 설치 앱·개인 인터넷 원격 연결, Windows/Linux 인증은 별도 실기 검증 대상이다.

공식 근거: [Codex 인증](https://learn.chatgpt.com/docs/auth), [Codex 상태 위치](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations), [Claude Code 복수 계정·인증 저장](https://code.claude.com/docs/en/authentication).
