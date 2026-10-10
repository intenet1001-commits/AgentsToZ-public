# Windows 앱 기능 패리티 — 실행 기록

> `PLAN.md`의 전수 조사 결과를 받아 실제로 구현한 것과, 구현 중 **측정으로 뒤집힌 가정**을 남긴다.
> 작업 분할(사용자 결정 2026-10-03): **이 세션은 Windows 전용 구현 + 플랫폼 공용 UI**만 담당한다.
> macOS 전용 effects는 Mac에서 작업하는 다른 세션이 맡는다 — 같은 파일을 양쪽에서 고치면 충돌한다.
> 기준: `9095cf3d` v572 · 브랜치 `feat/windows-app-parity` · 기기 Windows 11 26100 / Bun 1.3.12

---

## 1. 구현한 것

| # | 항목 | 상태 | 신규/수정 파일 |
|---|---|---|---|
| A6 | **온보딩 원클릭 설치 (GitHub CLI · Codex CLI) + GitHub 계정 연결** | 완료 | `src/onboardingWindowsInstall.ts`, `src/onboardingGithubWindowsEffects.ts`, `src/onboardingCodexWindowsEffects.ts`, `src/githubDeviceCode.ts`, `src/onboardingGithubHost.ts`, `src/OnboardingGithubSetup.tsx`, `src/OnboardingCodexInstaller.tsx`, `api-server.ts` |
| A1 | **음성 API 키 Windows 보관** | 완료 | `src/voiceSecretStore.ts`, `src/voiceCredentials.ts` |
| A2·A3 | **QR 원격제어 Windows 노출** | 완료 | `src/App.tsx`, `api-server.ts` |
| A4 | **ChatGPT 데스크톱 앱 열기 + 데스크톱 앱 존재 판정** | 완료 | `src/windowsUrlProtocol.ts`, `api-server.ts` |
| B4 | **Codex CLI 세션 종료 판정** | 완료(축소 형태) | `src/windowsTasklist.ts`, `api-server.ts` |
| B5 | **채널 헬스 프로세스 목록** | 완료(축소 형태) | `api-server.ts` |
| — | **음성 키 발급 페이지 연결** (플랫폼 공용) | 완료 | `src/voiceApiKeyIssuance.ts`, `src/clientPlatform.ts`, `src/VoiceSessionPanel.tsx`, `src/GeminiVoiceSettingsPanel.tsx` |

---

## 2. 측정으로 뒤집힌 가정 (중요 — 추측으로 갔으면 틀렸을 것들)

### 2.1 Codex 서명자는 winget 게시자와 다르다

winget `OpenAI.Codex`의 게시자 메타데이터는 `OpenAI, Inc.` 인데, 실제 `codex.exe` 0.146.0의
Authenticode 주체는 **`CN="OpenAI OpCo, LLC"`** 였다. 처음에 게시자 메타데이터를 핀했고
그 상태로는 **정품 바이너리를 거부**한다(실측: probe `unknown` → 수정 후 `configured`).
→ 서명자 핀은 반드시 실제 서명을 읽어서 넣는다. `onboardingWindowsInstall.ts`에 경고로 남겼다.

### 2.2 `powershell -Command <script> <path>` 는 `$args`를 채우지 않는다

PowerShell은 `-Command` 뒤 인자를 **명령 문자열에 이어 붙인다.** 실측:

```
+ "ARG0=[$($args[0])]" C:Windows
+                      ~~~~~~~~~
Unexpected token 'C:Windows' in expression or statement.
```

경로가 스크립트 본문으로 들어가므로 **고장이자 스크립트 주입 표면**이다.
→ 경로는 환경변수(`AGENTSTOZ_AUTHENTICODE_PATH`)로, 스크립트는 `-EncodedCommand`(base64 UTF-16LE)로
넘긴다. 실측: 34자 경로가 `LEN=34` / `EXISTS=True` 로 정확히 도달.

### 2.3 Bun은 Windows에서 PTY를 지원하지 않는다 (B1 차단 확정)

```
$ Bun.spawn(["cmd.exe","/c","echo x"],{terminal:{...}})
FAIL: terminal option is not supported on this platform
```
→ 워크룸 AI 터미널은 네이티브 PTY 호스트가 필요하다. `PLAN.md` §4.1.

### 2.4 `codexDesktopAppAvailable()` 가 non-macOS에서 무조건 `true` 였다

`process.platform !== 'darwin'` → `return true`. Codex 데스크톱 앱이 없는 Windows에서도
"앱 있음"으로 주장한 뒤 나중에 무관한 딥링크 에러로 터진다.
→ AppX 앱은 `WindowsApps` 경로를 탐색할 수 없으므로 **등록된 URL 프로토콜**로 판정한다.
실측: `reg query HKCU\Software\Classes\codex /v "URL Protocol"` → 등록 시 exit 0(115ms), 부재 시 exit 1.
이 기기에는 `OpenAI.ChatGPT-Desktop` / `OpenAI.Codex` AppX가 설치돼 있고 두 스킴 모두 등록돼 있다.

### 2.5 winget 종료 코드로 설치 성공을 판정하면 안 된다

처음에 `WINGET_EXIT_ALREADY_INSTALLED = -1978335189` 를 **측정 없이** 넣었다. 틀린 값이면
실패한 설치를 성공으로 읽는다. → 상수를 삭제하고 **성공 판정은 Authenticode 검증 한 곳**으로 옮겼다.
측정한 코드는 `0`(존재)과 `-1978335212`(= `0x8A150014` NO_APPLICATIONS_FOUND) 둘뿐이고,
나머지는 사람이 읽을 detail로만 쓴다(`wingetExitDetail`).

### 2.6 `tasklist` 메시지는 파싱할 수 없다

부재 시에도 **exit 0** 이고 `INFO: No tasks are running...` 한 줄만 낸다(지역화 가능).
→ 종료 코드도 메시지도 판정에 못 쓴다. **인용된 CSV 행의 첫 필드가 이미지명과 같은 행만 센다.**

### 2.7 node-pty는 Bun/Windows에서 **동작한다** — PLAN의 미검증 항목이 뒤집혔다

`PLAN.md` §4.1은 ① node-pty 안을 "Bun에서 N-API 애드온 동작 여부 미확인 **[I]**"으로 적었다.
저장소 밖 임시 디렉터리에서 실측한 결과 **동작한다**:

```
load: OK                     # node-pty@1.1.0 네이티브 바인딩이 Bun에서 로드됨
spawn: OK pid=42448
exit: {"exitCode":0}
data contains echo: true
data sample: "[?9001h[?1004h[?25l[2J[m[Hhello-conpty\r\n..."
resize: OK
write+exit: OK
```

ANSI 이스케이프가 그대로 오므로 **진짜 ConPTY**다. 즉 B1의 차단 사유는 "Windows에 PTY가 없다"가
아니라 "**Bun 내장 `terminal` 옵션에 Windows 구현이 없다**"로 정확히 좁혀진다.

⚠️ 다만 수명주기에 두 가지 함정을 함께 봤다 — 통합 시 반드시 다뤄야 한다:
- **종료와 경합하는 write가 `ERR_SOCKET_CLOSED`를 던진다.** node-pty의 지연 write 큐가
  (`windowsTerminal.js:147`) 닫힌 소켓에 쓰면서 올라오고, **핸들러가 없으면 사이드카가 죽을 수 있다.**
- **`kill()`/`onExit` 대기가 deadline 없이는 멈출 수 있다.** 후속 프로브가 바로 이 지점에서
  무응답으로 끝났다(bun CPU 0, 새 cmd 프로세스 없음 = 스핀이 아니라 블록).

이 둘은 macOS 워크룸이 이미 쓰는 규율과 같은 종류다 — CLAUDE.md의 **3-상태 실행 결과 계약**
(확인됨/실패/**미확인**)과 deadline 원칙. 그래서 설계를 새로 만들 필요는 없고 그 계약을 Windows
PTY 경로에 그대로 적용하면 된다. ⚠️ **네이티브 의존성이 새로 생긴다**는 점은 별개 판단이 필요하다
(`bun build --compile` 사이드카에 `.node` 바이너리를 동봉하는 전략).

### 2.8 영수증이 macOS 레시피 ID를 기록하고 있었다 (HTTP 왕복 실측으로 발견)

Windows에서 `review`를 호출했는데 응답이 이랬다:

```
"recipe":"github-macos-arm64-2.100.0-v2"   # ← Windows인데 macOS 레시피
```

`OnboardingGithubStore.review()`와 `CodexInstallHost`가 레시피 ID를 **상수로 박아** 두고 있었다.
레시피 ID는 "사용자가 무엇을 검토하고 동의했는가"의 식별자이고 호스트가 행동 전에 비교하는 값이다.
그래서 이 상태에서는:
- 패널은 winget 문구를 보여 주는데 **영수증은 macOS 레시피를 동의한 것으로 기록**한다.
- macOS 레시피 버전을 올리면 **Windows 영수증이 무관한 이유로 무효화**된다.
- 반대로 Windows 레시피를 올리면 **아무것도 무효화되지 않는다.**

→ `recipeId`를 effects가 제공하도록 바꿨다(`GithubHostEffects.recipeId`, `CodexInstallEffects.recipeId`,
없으면 macOS 레시피로 폴백). 수정 후 실측: `"recipe":"github-windows-winget-GitHub.cli-v1"`.
⚠️ **단위 테스트로는 안 잡혔다** — 가짜 effects가 레시피를 안 보기 때문이다. HTTP 왕복을 돌려봐야
드러나는 종류의 결함이다.

### 2.9 백슬래시 손상은 Bun이 아니라 heredoc이었다

조사 중 `C:\Windows\notepad.exe` 가 `C:Windows` + 개행으로 보여 Bun argv를 의심했는데,
원인은 셸 heredoc이 `\\` 를 `\` 로 접은 것이었다(그 결과 TS에서 `\n`이 개행이 됐다).
Bun argv/환경변수는 정상이다(`LEN=34` 일치). → 검증 스크립트는 `String.raw` 또는 파일 쓰기로 만든다.

---

## 3. 이 기기에서의 동작 측정

| 대상 | 결과 |
|---|---|
| GitHub CLI probe | `ready` — 기존 `C:\Program Files\GitHub CLI\gh.exe` 를 찾아 서명·버전·로그인까지 확인 (3.6s, 캐시 30s) |
| Codex CLI probe | `configured` — `CODEX_HOME` 미설정 시. Orca가 `CODEX_HOME`을 설정해 두면 설계대로 `unknown`(기존 프로필을 조용히 바꾸지 않음) |
| QR 원격제어 LAN | `enable` → 리스너 `192.168.219.120:58214` 바인딩 + 페어링 토큰 발급, `status` 정상, `disable` 정상 |
| 원격 인터페이스 열거 | `Wi-Fi 192.168.219.120`, `vEthernet (WSL) 172.24.112.1` — `node:os` 이므로 플랫폼 중립 |
| 음성 키 저장소 | `Bun.secrets` set→get→delete 왕복 일치 |
| 온보딩 HTTP 왕복 | `supported:true`(github·codex 둘 다) → `review` → `check` → **`state:"ready"`**, `recipe:"github-windows-winget-GitHub.cli-v1"`. 실제 Windows probe(후보 경로 → Authenticode → `gh --version` → `gh auth status`)를 통과한 결과다 |
| 프론트엔드 번들 | `bun run build` 성공 (20.04s) — typecheck가 커버하지 않는 번들 단계 확인 |
| Authenticode | `gh.exe` → `CN="GitHub, Inc."` Valid / `codex.exe` → `CN="OpenAI OpCo, LLC"` Valid |
| 프로세스 열거 비용 | `tasklist` 필터 428ms / 전체 1320ms(421행) / `Get-CimInstance` 1527ms(CommandLine 상위 3개 전부 `null`) |

---

## 4. 설계 결정과 이유

### 4.1 Windows 설치의 신뢰 근거는 winget + Authenticode

| | macOS | Windows |
|---|---|---|
| 설치원 | 고정 URL + SHA256 | `winget` 고정 패키지 ID (`--source winget --exact`) |
| 서명 검증 | `codesign` TeamIdentifier | Authenticode 주체 CN |
| 설치 위치 | `~/.local/bin` 하드링크(no-replace) | winget 소유 — **앱이 실행 파일을 쓰지 않는다** |

macOS 방식을 그대로 옮길 수 없는 이유: 두 벤더가 Windows에 **추출 가능한 고정 payload를 배포하지
않는다**(설치 프로그램이다). 손으로 URL+해시를 핀하면 버전마다 레시피가 썩고, 그 레시피가 낡은
순간 사용자는 설치 자체를 못 한다.

### 4.2 POSIX 권한 검사를 Windows로 옮기지 않았다

macOS effects의 `info.mode & 0o022`, `info.uid !== process.getuid?.()` 는 NTFS에서 의미가 없다.
그대로 옮기면 **아무것도 증명하지 않는 검사**가 보안 검사처럼 남는다. 그 자리를 Authenticode가 대신한다.

### 4.3 GitHub 로그인의 소유자는 Job Object supervisor다

macOS는 디바이스 코드 로그인을 패키지된 guard(`agentstoz-onboarding-github-auth-v1`) 안에서 돌려
POSIX 프로세스 그룹으로 소유한다. 그 guard는 **Windows에서 실행을 거부한다**
(`agent-runtime-process-guard.ts` 선두 `Windows execution is disabled until Job Object
containment is available.`) — 그 거부가 모드 분기보다 먼저 와서 온보딩 로그인 모드까지 함께 막는다.

**guard를 고치는 대신 이미 출하된 Windows Job Object supervisor를 소유자로 썼다.** 선례가
저장소 안에 있다 — `spawnContainedClaudeRemoteControl`이 Windows에서 정확히 이 방식이다.
`resolveAgentRuntimeGuardCommand()`나 containment 경계를 전혀 건드리지 않는다.

측정으로 확인한 두 성질(무해한 자식으로 대체해 `gh` 인증 상태를 건드리지 않고 검사):

```
supervisor pid     = 40532        parentPid env = <사이드카 pid>
relayed device code = ABCD-1234   # 자식 stdout이 supervisor를 통해 그대로 중계됨
supervisor exit     = 143
powershell count    = before 4 -> after 2   # kill() 시 supervisor+자식이 함께 사라짐
```

- **중계**: supervisor가 `STARTF_USESTDHANDLES`로 자기 표준 핸들을 자식에게 넘기므로, 사이드카가
  supervisor의 stdout을 읽으면 `gh`의 출력을 읽는 것이 된다 → 일회용 코드 추출 가능.
- **소유**: `parentPid`에 사이드카 pid를 주면 사이드카가 죽을 때 Job 핸들이 닫히고
  `KILL_ON_JOB_CLOSE`가 트리를 거둔다. 취소는 supervisor를 `kill()` → 같은 경로로 `gh`까지 종료.
- ⚠️ **supervisor 스크립트를 못 찾으면 로그인을 거부한다.** 소유자 없이 `gh auth login`을 띄우면
  앱을 닫은 뒤에도 디바이스 코드를 쥔 프로세스가 남고, 아무것도 그것을 멈추지 않는다.
- cwd는 `SystemRoot`다 — 프로젝트 폴더를 주면 Bun이 그 폴더의 `.env`를 자동 로드한다.

**디바이스 코드 정규식은 `src/githubDeviceCode.ts` 한 곳**에 둔다. 소유자가 플랫폼마다 다른데
정규식 사본을 각 소유자에 두면, 한쪽만 갈려서 **코드가 영원히 안 뜨는 로그인**이 된다.
테스트가 macOS guard에 같은 리터럴이 남아 있는지 함께 검사해 드리프트를 잡는다.

### 4.4 QR 원격제어는 숨기지 않고 한계를 말한다

원격 동작 8개 중 6개가 Windows에서 이미 동작한다(§3). 두 개(`codex.thread.start`, `workroom.*`)만
PTY·Agent Runtime에 묶여 있고, 그 둘은 호스트가 이미 구체적인 한국어 사유를 돌려준다.
CLAUDE.md의 AI 실행 버튼 규칙과 같다 — **말없이 사라지는 버튼이 가장 나쁘다.**

### 4.5 Codex 세션 판정은 "없을 때만" 단언한다

Windows는 타 프로세스 명령줄을 싸게 읽을 수 없어 TUI와 헬퍼(app-server·code-mode-host·mcp-server)가
모두 `codex.exe`로 구분되지 않는다. 그래서 주장할 수 있는 방향은 하나뿐이다:
**`codex.exe`가 하나도 없으면 모든 CLI 세션은 확실히 끝났다** → `stopped` → 죽은 행이 정리된다.
하나라도 있으면 `unverified` → `codexTuiSurfacePresence`가 `not-applicable`로 바꿔 **행을 그대로 둔다**
(숨기지 않는다). `running`을 주장하면 헬퍼를 TUI라고 단언하는 것이 된다.

---

## 5. 검증

```
bun run typecheck                 → 0 에러
bun test (신규 7파일)             → 50 pass / 0 fail / 321 expect
```

신규 테스트: `onboarding-windows-install`, `onboarding-windows-host-gate`,
`voice-secret-store-windows`, `voice-api-key-issuance`, `windows-url-protocol`, `windows-tasklist`
(+ 기존 `codex-process-presence` 동시 통과).

### 전체 스위트의 실패 — 원인별 분류와, 그 안에 숨어 있던 제품 결함

전수 실행에서 실패가 대량 발생한다. 내 변경을 `git stash`로 빼도 재현되므로 내가 만든 회귀는
아니다. 그런데 **"전부 환경 문제"로 넘기면 안 됐다** — 그 노이즈 안에 Windows에서 기능이 통째로
죽어 있는 제품 결함이 둘 있었다(§6).

| 원인 | 근거 | 조치 |
|---|---|---|
| **CRLF 체크아웃** | `.gitattributes`의 `* text=auto`가 Windows에서 텍스트를 CRLF로 재작성 | **해결** — `.sql`·`.rs`·`.yml`/`.yaml`을 `eol=lf`로 고정 |
| `symlinkSync` 권한 | `symlink` 176건 · `EPERM` 86건. **개발자 모드 꺼짐** (`AllowDevelopmentWithoutDevLicense` 미설정, 비관리자, `SeCreateSymbolicLinkPrivilege` 없음) | 미해결 — OS 설정이라 코드로 못 고친다 |
| 워크룸 PTY 게이트 | `voice-dock` 30건, `voice-runtime` 13건 등이 모두 `aiTerminalService`의 win32 throw | B1을 하면 함께 사라진다 |
| 본질적 macOS 대상 | `macos-base-app` 22 · `apple-container-canary` 17 등 18개 파일 70건. `codesign`·공증·Apple Container는 Windows에서 "고칠" 대상이 아니다 | `test.skipIf` 필요 (미착수) |

⚠️ **CRLF 규모를 내가 두 번 틀리게 추정했다.** 먼저 "소스를 읽는 테스트 362개 파일"이라는 정적
추정을 냈는데, 그 대부분은 순수 함수의 기대값에 `\n`을 쓴 것이라 무관했다. 그 다음엔 실패 로그에서
`Received: ""`(슬라이스가 빈 문자열)만 세어 **"2건뿐"**이라고 보고했는데, 그 지표가
**byte-for-byte 비교 실패를 통째로 놓쳤다** — 그쪽은 `+ Received + 0` 형태의 diff로 나온다.

실제 해법은 테스트 수술이 아니라 **파일을 LF로 고정하는 `.gitattributes` 세 줄**이었다:

| 고정 | 왜 필요한가 | 측정된 효과 |
|---|---|---|
| `*.sql` | 마이그레이션이 TS 상수(정본)와 byte 비교된다. 실측: 파일과 상수가 **CR 173바이트만** 차이, 정규화하면 동일 | `remote-device-enrollment` 9 fail → **15 pass / 0 fail**, SQL 계약 23건 추가 통과 |
| `*.rs` | 계약 테스트가 `indexOf('...\n...')`로 Rust 함수 구간을 잘라 가드 유무를 본다. CRLF면 마커가 어긋나 슬라이스가 빈 문자열이 되고 **있는 가드를 없다고 보고**한다 | Rust 읽는 5개 파일 36/2 → **38 pass / 0 fail** |
| `*.yml`/`*.yaml` | `/^on:\n[\s\S]*?(?=^jobs:)/m` 로 매칭한다. GitHub는 Linux에서 돌린다 | **`windows-*` 전체 89 pass / 0 fail** (이전 88/1) |

아이러니하게도 **Windows 실행 경로를 지키려고 쓴 계약 테스트가 Windows에서만 깨져 있었다**
(`windows-agent-launch-contract`의 Job Object supervisor 검사가 그것이다).

- **실패 증거가 있는 확장자만 고정했다.** `.json`은 파싱되므로 개행에 무관하고, `.ps1`은 네이티브
  Windows 셸이 직접 실행하므로 **의도적으로 CRLF를 유지**한다(기존 규칙).
- 커밋된 blob은 원래 LF였다(`git add --renormalize`가 아무것도 스테이지하지 않았다) — Windows
  **워킹트리만** 재작성되고 있었다. 그래서 macOS/Linux에는 아무 변화가 없다.
- `cd src-tauri && cargo check` **exit 0** 으로 `.rs` 재정규화의 컴파일 영향 없음을 확인했다.

---

## 6. 테스트 실패를 지도로 삼아 찾은 제품 결함

전수 실패를 "환경 문제"로 묶지 않고 하나씩 원인을 본 덕에, **Windows에서 기능이 통째로 죽어 있던
곳**을 둘 찾았다. 둘 다 단위 테스트가 통과하는 상태였고, 실행해 봐야 드러났다.

### 6.1 메모리 저장 provider — 항상 실패 (`memorySaveProvider.ts`)

```
dir  mode octal = 666 | & 0o077 = 66   → workdir()   항상 STORAGE_UNAVAILABLE
exe  mode octal = 666 | & 0o111 = 0    → executable() 항상 POLICY_CHANGED
```

Windows는 요청한 `0o700`과 무관하게 `666`을 보고하고, `.exe`에도 실행 비트가 없다. 같은 계열
7곳(`memorySaveInputStore`·`memorySaveKeyLifecycle`·`memorySaveDiskAdmission`·
`memoryEmergencyReserve`)은 모두 `platform!=='win32'` 가드가 있는데 **이 파일만 빠져 있었다.**
→ 가드 추가 + 실행 가능 판정을 Windows에서는 확장자로. ⚠️ `PATHEXT`는 쓰지 않는다 — 사용자가
쓸 수 있는 값이라 임의 확장자가 provider로 통과하게 된다.
`memory-save-provider.test.ts` **1 pass/12 fail → 13 pass/0 fail**, 이웃 transition 테스트는
변경 전후 동일(9/11)로 회귀 없음.

### 6.2 프로젝트 테스터 — 어떤 프로젝트도 검사 불가

독립적인 두 원인이 겹쳐 있었다.

**① Python 탐지.** `Bun.which('python3') ?? Bun.which('python')`가 이 기기에서 **null**이었다 —
Python 3.13.7이 `py` 런처 뒤에 있는데 "Python 없음"으로 판정했다. 그리고 찾아지는 기기에서는 더
위험하다: `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe`는 Python 설치 여부와 무관하게
Windows가 깔아 두는 **0바이트 app-execution-alias 스텁**이다. PATH에서 발견되고, 버전 없이
`Python ` 만 출력하고, **exit 9009**로 끝난다.
→ 후보는 **출력된 버전을 읽고 3.9 이상인지 확인한 뒤에만** 채택한다. 스텁 형태를 배제하고
Windows에서는 `py`를 먼저 본다 (`src/pythonExecutable.ts`).

**② 러너 인코딩.** `scripts/agentstoz-maintainer.py`의 `Path(__file__).read_text()`가 인코딩을
지정하지 않아, Windows Python이 이 UTF-8 파일을 로케일 코드페이지(cp949)로 디코드하다
`'charmap' codec can't decode byte 0x9d`로 죽었다. **자기 버전을 해시하려고 자기 소스를 읽는
코드라, 프로젝트를 보기도 전에 실패한다.** POSIX는 이미 UTF-8 기본이라 거기서 나오는 해시는 그대로다.
→ 인코딩 명시 + 양쪽 spawn에 UTF-8 모드(재발 방지, 한글 출력 인코딩).

수정 후 실측: `py -B scripts/agentstoz-maintainer.py inspect --root . --json` →
`"installation": "ready"` + 전체 프로필 목록.

⚠️ **테스트가 제품과 같은 naive 조회를 복제하고 있었다** — `python:()=>Bun.which('python3')`.
그래서 그 테스트는 자기가 잡아야 할 버그를 재현하고 있었다. 이제 production resolver를 공유한다.

**남은 12건은 `start` 경로이고, 그것은 의도적 게이트다** —
`TESTER_PLATFORM_UNSUPPORTED: 'Windows 앱 실행은 준비 중입니다. 프로젝트 CLI에서 검사를 실행할
수 있습니다.'` 취소와 2시간 타임아웃이 모두 `child.kill('SIGINT')`로 러너에게 부분 리포트를 쓸
기회를 주는 구조인데 Windows에는 SIGINT가 없다(즉시 종료로 매핑된다). 여는 데는 취소 플래그 같은
별도 메커니즘 + 자손 정리가 필요하므로 **닫아 두었다.**

### 6.3 여기서 얻은 교훈

**단위 테스트가 통과하는 것으로 플랫폼 동작을 보증할 수 없다.** 세 결함 모두 가짜 의존성 뒤에
숨어 있었다 — 레시피 ID는 가짜 effects가 보지 않았고(§2.8), Python은 테스트가 같은 틀린 조회를
썼고, 권한 비트는 테스트가 POSIX 모양 fixture를 만들었다. 셋 다 **실제로 돌려봐야** 드러났다.

---

## 7. Mac에서 이어받기

```bash
git fetch origin && git switch feat/windows-app-parity   # tip 4cc8bbf7, main(9095cf3d v572)에서 11커밋
bun install                                              # 이 브랜치는 의존성을 추가하지 않았다. 맥이 v572보다 뒤처져 있을 때만 필요
```

### ⚠️ 먼저 해야 할 것 — 내가 할 수 없었던 macOS 검증

공유 파일을 고쳤고 **이 기기에서는 macOS 경로를 실행할 수 없다.** 아래 네 곳은 POSIX 동작을
의도적으로 그대로 두었지만, 그 사실을 확인한 것은 코드 독해뿐이다. 맥에서 `bun test` + `cargo test`를
한 번 돌려 회귀가 없음을 확인해 주기 바란다.

| 고친 파일 | macOS에 둔 것 | 확인할 것 |
|---|---|---|
| `src/portalFileLock.ts` | 락을 여는 모드가 `win32`에서만 `'r+'`, POSIX는 `'r'` 유지 | 리스 갱신이 예전과 동일한지 |
| `src/memorySaveProvider.ts` | 권한 비트·실행 비트 검사를 POSIX에서 그대로 적용 | 메모리 저장 provider 경로 |
| `src/memoryEmergencyReserve.ts`, `memorySaveInputStore.ts`, `memorySaveKeyLifecycle.ts` | 디렉터리 fsync를 POSIX에서 그대로 수행 | 내구성 보장이 유지되는지 |
| `scripts/agentstoz-maintainer.py` | `read_text(encoding="utf-8")` — POSIX 기본값과 동일하므로 해시 불변 | 테스터 `inspect` 해시가 바뀌지 않았는지 |

`.gitattributes`의 `*.sql`/`*.rs`/`*.yml` LF 고정은 **맥에서 아무것도 바꾸지 않는다** —
그 파일들은 이미 LF였고 커밋된 blob도 LF였다(`git add --renormalize`가 아무것도 스테이지하지 않음).

### 결정이 필요해 멈춘 것

1. **워크룸 PTY에 `node-pty` 네이티브 의존성을 넣을지** — 실현 가능성은 측정으로 확인됐다(§2.7).
   막는 것은 기술이 아니라 출하 정책이다: win32-x64 기준 ~2MB(`pty.node`·`conpty.node`·
   `conpty_console_list.node`·`conpty.dll`·`OpenConsole.exe`)를 Tauri 리소스로 동봉해야 하고,
   그중 `OpenConsole.exe`는 **마이크로소프트 서드파티 실행 파일**이라 macOS 공증·Authenticode
   서명 목록(`macOSBaseAppSigning.ts`)에 새 항목이 생긴다. 선례는 `build-sidecar.ts`의
   darwin `nativeCommands`(Swift `kmsg`)다.
2. **Windows 개발자 모드** — `symlinkSync` 실패(실패 로그 `symlink` 176 · `EPERM` 86)의 유일한
   해소책이고 관리자 권한이 필요해 에이전트가 켤 수 없다.
3. **macOS 전용 테스트에 `skipIf`** — `codesign`·공증·Apple Container를 대상으로 하는 18개 파일
   70건은 Windows에서 "고칠" 대상이 아니다. `0 fail` 기준을 세우려면 skip이 필요하다.

### 고치지 않고 관찰로만 남긴 것

- **리스의 git probe(5초)가 실행 중 사이드카 안에서 간헐적으로 `ETIMEDOUT`한다.** 단독 8/8 정상
  (50~110ms), 별도 테스트 서버 핸들러 안에서 4/4 정상, 실행 파일 경로 4종 모두 정상이었는데,
  같은 요청이 한 번은 503 다음엔 200이 된다. 원인을 분리하지 못했으므로 손대지 않았다.
  Windows에서 5초가 빡빡할 수 있다는 관찰로만 남긴다(`src/workspaceLease.ts:19`).
- **세션 저장 시 `curl --data-urlencode`로 보낸 한글 narrative가 `?`로 저장된다.** 같은 문장을
  Bun `fetch`로 보내면 정상이다(journal 2026-10의 두 항목이 나란히 있어 비교 가능). 서버 인코딩은
  정상이고 셸 argv 전사가 원인이다. 스킬이 Windows 사용자에게 안내하는 경로가 바로 이것이라
  한국어 제품에서 조용히 깨진다 — Git Bash인지 `curl.exe` 자체인지는 분리하지 못했다.
- 테스터 `start` 경로는 **의도적 게이트**다(§6.2). 취소·타임아웃이 SIGINT에 의존한다.

---

## 8. 남은 것

| 항목 | 상태 |
|---|---|
| B1 워크룸 PTY | 미착수 — **그러나 실현 가능성은 측정으로 확인됐다(§2.7)**. node-pty가 Bun/Windows에서 동작하므로 다음 단계는 PoC가 아니라 ① 네이티브 의존성 동봉 전략 결정 ② `aiTerminalService`의 spawn/종료 경로를 PTY 드라이버로 추상화 ③ `ERR_SOCKET_CLOSED`·deadline 처리 |
| B2 Agent Runtime Windows | 미착수 — `docs/agent-runtime-containment.md:142-159`가 Rust 네이티브 helper를 요구 |
| B3 워크트리 포트 자동 탐지 | 미착수 — Windows는 타 프로세스 cwd를 읽을 공개 API가 없어 축소 구현만 가능 |
| A5 드롭 경로 확인 | **고칠 것 없음(확인됨)** — `resolvePathlessLocalDrop`은 `isLocalWeb()`일 때만 쓰인다. 앱에서는 Tauri 드롭 리스너가 절대경로를 주므로 정상 동작하고, 501은 브라우저 모드 전용이다. macOS는 osascript로 Finder 선택을 되묻는 우회가 있지만 Windows에는 대응물이 없고, 현재 문구가 「오른쪽 선택 버튼을 사용해주세요」로 정확하다 |
| GitHub 디바이스 코드 로그인 | **완료** — Job Object supervisor가 소유, §4.3. ⚠️ 실제 `gh auth login` 왕복은 사용자 GitHub 인증 상태를 바꾸므로 돌리지 않았다 — 메커니즘(중계·소유·취소)만 무해한 자식으로 측정했다 |
| 테스트 Windows 이식성 | 미착수 — §5 |
| macOS 전용 effects 개선 | **이 세션 범위 밖** (Mac 세션 담당) |
