# 워크룸 실행 옵션 — 기본 Bypass ON

2026-09-23 사용자 추가 요구사항. 상태: **기본 ON/OFF UI·네 CLI 인자·프로젝트 카드 연결 구현, 소스 검증**. 설치 앱 배포와 실제 제공자 실행 검증은 별도다. [실행 기록](EXECUTION.md)을 참조한다.

## 사용자 동작

워크룸에서 프로젝트와 AI를 선택하면 아래처럼 실행 옵션이 보인다.

```text
프로젝트·워크트리 [선택]    AI [Codex CLI]
[실행 옵션 · Bypass ON]    [+ 새 터미널]

실행 옵션을 펼치면:
[✓] 권한 우회(Bypass)
    AI의 도구 실행 승인 요청을 자동 처리합니다.
    Codex는 명령 실행 sandbox도 해제합니다.
```

- 기본 선택은 **ON**. 버튼만 봐도 현재 ON/OFF를 알 수 있다. 펼친 옵션은 checkbox/switch, 버튼은 `aria-expanded`와 옵션 영역 연결을 제공한다.
- OFF 선택 시 이번 앱 세션의 이후 새 터미널에도 유지한다. 화면/프로젝트 전환으로 ON을 다시 강제하지 않는다. 기존 로컬 앱의 세션 단위 설정 정책을 따라 다음 앱 실행에서는 기본 ON이다.
- ‘새 터미널’, ‘선택한 AI로 시작’, 프로젝트/워크트리에서 워크룸으로 진입해 새 세션을 만드는 모든 경로가 같은 선택값을 사용한다. 이미 실행 중인 세션을 여는 경우에는 새 시작 옵션을 재적용하지 않는다.
- 현재 버튼은 **다음 새 터미널의 선택값**을 표시한다. 기존 세션의 실제 권한으로 주장하지 않는다. CLI 정책에 따른 거부/시작 실패는 실제 출력과 오류로 보여 준다. 재연결 후 서버 영수증 기반 권한 표시에는 별도 metadata 협상이 필요하며 후속 범위다.
- OFF의 의미는 **추가 bypass 인자를 전달하지 않고 CLI 자체 설정을 사용함**이다. 사용자가 CLI 전역 설정에서 이미 bypass를 지정했을 수 있으므로 OFF를 ‘모든 작업 승인 필수’라고 표시하지 않는다.
- 앱 자체의 추가 확인 팝업은 도입하지 않는다. CLI가 자체적으로 요구하는 첫 실행 확인이나 조직 정책 거부는 그대로 표시하며 앱이 자동으로 응답하거나 우회 설정을 쓰지 않는다.

## 변경 전과 구현 지점

| 지점 | 현재 | 변경 |
|---|---|---|
| `src/terminalDefaults.ts` | `internal` bypass=false | 내부 워크룸 기본 true; bg/tmux 기본값 유지 |
| `src/App.tsx:15735` | `terminalApp !== 'internal'`에서만 bypass 버튼 표시 | 내부 워크룸에서도 실행 옵션 노출·동일 상태 전달 |
| `src/AiTerminalPanel.tsx` | 별도 실행 옵션 없음 | 옵션 버튼·기본값·사용자 선택, 모든 start 경로에 연결 |
| `AiTerminalEntry` 및 프로젝트 진입 경로 | bypass 선택 전달 계약 없음 | 부모 앱의 명시적 현재 선택을 전달; 없을 때 새 UI 기본 ON |
| `src/aiTerminalProtocol.ts` | start allowlist에 권한 필드 없음 | `bypassPermissions?: boolean` 등 명시적 필드와 strict type 검사 |
| `src/aiTerminalService.ts:260` | session-id/status-line/prompt만 argv에 추가 | CLI별 bypass 인자를 검증된 옵션 builder로 결합 |
| summary/원격 응답 | 실행 권한 옵션 정보 없음 | 현재 응답 계약 유지. 서버 영수증 metadata 협상은 후속 범위 |

주입할 임의 shell 문자열/임의 argv 입력칸은 만들지 않는다. boolean/enum을 서버의 고정 인자에 매핑한다.

## CLI별 매핑

아래는 **이 Mac에 설치된 CLI의 `--help`에서 확인한 옵션**이다. 실제 bypass 모델 실행 시험은 아직 하지 않았다.

| CLI | ON일 때 인자 | 조립 주의 |
|---|---|---|
| Codex CLI | `--dangerously-bypass-approvals-and-sandbox` | 기존 `-c tui.status_line=...` 유지. 옵션은 프롬프트 구분자 `--` 앞에 배치 |
| Claude Code | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions`도 동등한 옵션. 하나만 사용하고 기존 `--session-id` 유지 |
| Hermes | `chat --yolo` | 프롬프트가 있으면 `chat --yolo -q <prompt>`. `chat` 중복 삽입 금지. 빈 프롬프트도 interactive 유지 |
| Antigravity(agy) | `--dangerously-skip-permissions` | 프롬프트가 있으면 기존 `-i <prompt>`와 결합. 확인되지 않은 `--yolo`를 쓰지 않음 |

Claude 매핑은 Context7(`/websites/code_claude`)의 [공식 permission modes](https://code.claude.com/docs/en/permission-modes)와도 대조했다. `--allow-dangerously-skip-permissions`는 사용 가능하게만 하고 기본 선택하지 않는 옵션이므로 이 요구사항의 실행 인자로 대체하지 않는다.

별도 `aiTerminalLaunchArgs` 모듈에서 agent·prompt·permission mode·세션 metadata를 함께 조립하는 방식을 권장한다. `aiTerminalPromptArgs`와 두 군데에서 `chat`/`--`를 추가하지 않도록 정리한다. 옵션 검증은 매 키 입력마다 CLI `--help`를 호출하지 않고 시작 준비/설치 버전 변경 시 수행한다.

## 요청·호환·권한 범위

- 새 UI가 start를 누를 때 `bypassPermissions: true|false`를 **명시적으로** 보낸다. 기존 클라이언트에서 필드가 빠지면 서버는 기존 동작인 ‘CLI 기본 설정’으로 처리한다. 서버의 생략값만 true로 바꿔 구버전 자동화의 의미를 바꾸지 않는다.
- start request fingerprint에 권한 선택도 포함한다. 동일 request ID로 true/false가 바뀌면 재실행하지 않고 기존 다른 payload 오류를 반환한다.
- 현재 새 UI는 권한 필드를 명시하며 구버전 호스트가 이를 거부하면 오류를 표시한다. 필드를 제거해 자동 재시도하거나 ON 적용 성공으로 처리하지 않는다. 배포 시 웹/호스트를 함께 갱신해야 한다. 별도 feature negotiation은 후속 범위다.
- 모바일/원격 워크룸에도 동일한 실행 옵션 UI를 제공하되 해당 controller UI의 명시적 start 선택을 전달한다. 데스크톱의 저장값을 원격에 숨겨서 상속하지 않는다.
- 이 옵션은 **CLI 내부의 실행 승인 모드**다. 기존 원격 pairing/SAS, 프로젝트별 grant, 등록·cwd 신원, 메모리 저장/테스터 별도 권한을 새로 허용하지 않는다. 이미 허용된 워크룸 시작의 옵션으로만 적용한다. managed runtime의 별도 실행 gate와 혼용하지 않는다.
- 실제 CLI가 조직 설정 등으로 옵션을 거부하면 자동으로 전역 설정을 고치거나 성공 모드로 표시하지 않는다. 요청한 launch mode와 실제 프로세스 시작 결과를 분리한다.

## 완료 조건

1. 앱 실행 옵션과 내부 워크룸에 버튼이 보이고, 새 앱 세션의 기본 선택은 ON이다. OFF 선택 후 화면 전환에서도 유지된다.
2. 부모 앱에서 OFF로 설정한 뒤 프로젝트 카드로 진입해도 내부 워크룸에서 ON으로 덮어쓰지 않는다. 독립 패널은 기본 ON을 사용한다.
3. 4종 CLI × ON/OFF × 프롬프트 있음/없음에서 argv가 정확하다. `--`로 시작하는 프롬프트, 한글, 줄바꿈도 옵션으로 해석되지 않는다.
4. 옵션이 생략된 legacy request, 잘못된 boolean, 알 수 없는 필드, 같은 request ID의 다른 권한 선택을 검사한다.
5. 현재 UI는 새 실행의 선택값만 표시하며 기존 세션 적용 성공으로 간주하지 않는다. 서버 영수증 기반 launch mode의 재연결 표시는 후속 범위다.
6. 권한 없는 원격 시작은 ON이어도 거부된다. 허용된 원격 시작만 선택값을 전달하고 권한 철회·세션 교체·저장 권한 회귀가 통과한다.
7. 네 CLI의 실제 interactive 시작과 실행 옵션 표시를 확인한다. 조직 정책/CLI 최초 확인은 지원 여부·사용자 응답 필요 상태로 기록한다.

검증은 기존 `terminal-defaults.test.ts`, `ai-terminal.test.ts`, `ai-terminal-prompt-args.test.ts`, `ai-terminal-remote.test.ts` 및 워크룸 UI 회귀를 확장한다. 구현 후 독립 회귀를 실행했다. 실제 PTY에서 네 CLI의 고정 인자 전달을 가짜 CLI로 확인했으며 제공자 계정/모델 호출 시험으로 간주하지 않는다. 상세 결과는 실행 기록과 로컬 tester 보고서를 따른다.
