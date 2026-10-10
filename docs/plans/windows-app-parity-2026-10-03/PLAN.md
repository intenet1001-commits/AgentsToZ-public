# Windows 앱 기능 패리티 — 전수 조사와 계획 (v572 기준)

> 이 문서는 조사 결과와 계획만 담는다. 저장소 코드는 한 줄도 고치지 않았다.
> **[V]** 는 코드나 실행으로 확인한 사실이고 `file:line` 또는 실측 출력이 근거다.
> **[I]** 는 추론이라서 구현 전에 기기 실측이나 외부 문서 확인이 필요하다.
> 기준 커밋: `9095cf3d` (`src-tauri/tauri.conf.json` = `572.0.0`) · 조사 기기: Windows 11 Home 10.0.26100 / Bun 1.3.12 [V]
> 브랜치: `feat/windows-app-parity`

---

## 0. 조사 기준선 (이 기기에서 실측)

| 항목 | 결과 |
|---|---|
| `git pull origin main` | `9095cf3d` v572, 로컬이 844커밋 뒤처져 있었음 [V] |
| `bun install` | 13개 패키지 신규 설치 — `@xterm/headless`, `@electric-sql/pglite` 등이 없어서 typecheck가 15개 에러였음 [V] |
| `bun run typecheck` | 설치 후 **0 에러** [V] |
| `bun test --cwd tests` | 별도 기록 (§7) |

⚠️ **844커밋을 당긴 직후에는 `bun install`이 선행 조건이다.** 하지 않으면 `tsc`가 모듈 부재
에러 15개를 내고, 그것이 "Windows라서 깨진 것"으로 오독된다. 실제로 이번 조사에서 그 순서로
한 번 잘못 읽혔다.

---

## 1. 결론 — 세 종류를 섞어 말하지 말 것

Windows에서 못 쓰는 기능은 성격이 셋이고, **같은 "미지원"으로 묶으면 계획이 틀린다.**

| 종류 | 뜻 | 대응 |
|---|---|---|
| **A. 게이트만 닫혀 있음** | 호스트 구현이 이미 Windows를 지원하는데 UI/판정이 막고 있다 | 게이트를 능력별로 열고 못 하는 부분만 정직하게 표시 |
| **B. 런타임 부재** | 플랫폼 원시 기능(PTY, Job Object 소유)이 없어 네이티브 작업이 필요 | 네이티브 호스트를 새로 만들어야 하므로 별도 과제 |
| **C. 본질적 macOS 전용** | 대상 자체가 macOS 앱이거나 Apple 프레임워크다 | **고치지 않는다.** 대안 문구만 정확히 |

이번 브랜치의 권고 순서는 **A → 측정 가능한 B의 일부 → C 문구 정리**이고, 가장 큰 B
(워크룸 PTY · Agent Runtime)는 **이 브랜치에서 착수하지 말 것**을 권한다. 근거는 §4.

---

## 2. 이미 Windows에서 동작하는 것 (다시 만들지 말 것)

조사 중 가장 중요한 발견은 **Windows 프로세스 소유 기반이 이미 출하돼 있다**는 것이다.

- `src-tauri/resources/windows-process-supervisor.ps1` — `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  Job Object를 만들고 `CREATE_SUSPENDED` + `AssignProcessToJobObject` + `ResumeThread` 순서로
  자식을 넣는다. `STARTF_USESTDHANDLES`로 stdio 핸들도 넘긴다. [V]
- 쓰는 곳: 서버 실행 `api-server.ts:19167`, 강제 재실행 `api-server.ts:19450`,
  Claude 원격 제어 `api-server.ts:13281`. [V]
- 가드 바이너리 `agentstoz-agent-runtime-guard.exe`는 **이미 빌드·번들링된다** (`build-win.ts:84`). [V]
- Windows 전용 모듈이 이미 있다: `src/windowsNetstat.ts`, `src/windowsCommandLaunch.ts`,
  `src/windowsAgentExecutable.ts`, `src/windowsUpdateWorkflow.ts`. [V]
- Rust 쪽 `#[cfg(target_os = "windows")]` 분기가 40곳 이상으로 이미 촘촘하다. [V]
- Windows E2E 러너가 셋 있다: `scripts/run-windows-e2e.ps1`,
  `run-windows-packaged-e2e.ps1`, `run-windows-detached-sidecar-e2e.ps1`,
  그리고 `bun run test:windows:e2e`. [V]

⚠️ **그런데 이 supervisor를 Agent Runtime 보안 경계로 재사용하는 것은 명시적으로 금지돼 있다.**
`docs/agent-runtime-containment.md:144-146`: "기존 PowerShell Job wrapper는 일반 프로세스용으로
유지하되 Agent Runtime 보안 경계로 재사용하지 않는다. Rust native helper가 provider를 생성
순간부터 non-inheritable Job Object에 넣고 제한된 stdio handle만 전달해야 한다." [V]
→ "supervisor가 있으니 Agent Runtime도 금방 켜진다"는 결론은 **틀렸다.** §4.2를 볼 것.

---

## 3. 전수 조사 결과

### 3.1 종류 A — 게이트만 닫혀 있음

| # | 기능 | 현재 Windows 동작 | 근거 | 난이도 |
|---|---|---|---|---|
| A1 | **음성 OpenAI API 키 보관** | `AGENTSTOZ_VOICE_API_KEY` 환경변수만 가능. 앱에서 키 연결 불가 | `src/voiceCredentials.ts:40` `if(this.platform!=='darwin'...)throw`, `:52` 설정 거부 [V] | **S** |
| A2 | **QR 원격제어 · 이 PC** | 도구 메뉴에서 **버튼 자체가 숨김** | `src/App.tsx:14121` `!isDeployedWeb() && !isWindows()` [V] | **M** |
| A3 | **외부 인터넷 QR 원격제어** | 같은 조건으로 숨김 | `src/App.tsx:14121`(동일 블록, `:14140` testid) [V] | **M** |
| A4 | **ChatGPT 데스크톱 앱 열기** | 409 `현재 운영체제에서는 ChatGPT 데스크톱 앱을 직접 열 수 없습니다.` | `api-server.ts:20602` [V] | **S** |
| A5 | **드롭한 항목의 실제 경로 확인** | 501 — 오른쪽 선택 버튼으로 유도 | `api-server.ts:19944` [V] | **M** |

**A1 은 실측으로 길이 열렸다.** `Bun.secrets`가 이 기기에서 왕복 성공했다 (set → get → delete,
반환값 일치) [V, 실측]. Windows 자격 증명 관리자를 쓰므로 macOS Keychain과 같은 역할이다.
게다가 `VoiceCredentials`는 이미 `command:VoiceSecretRunner`와 `platform`을 **주입받는 구조**라
(`src/voiceCredentials.ts:23`) 플랫폼별 백엔드를 끼우는 자리가 이미 있다. [V]

**A2·A3 이 이 브랜치의 핵심 후보다.** 원격 제어 호스트에 Windows 하드 블로커가 없다:
- LAN 주소 열거는 `node:os`의 `networkInterfaces()` — 플랫폼 중립 (`api-server.ts:12817`) [V]
- `src/remoteControlHostVault.ts`의 win32 분기는 **POSIX 권한 검사를 건너뛰는 것**뿐이고
  거부가 아니다 (`:282,315,344,393`) [V]
- Claude 원격 대화는 **Windows 전용 경로가 이미 구현돼 있다** —
  `spawnContainedClaudeRemoteControl`이 `IS_WIN`일 때 supervisor로 Job Object를 쥔다
  (`api-server.ts:13268-13291`) [V]

원격 제어가 제공하는 동작과 Windows 가용성:

| 원격 동작 | Windows | 근거 |
|---|---|---|
| `start` / `stop` / `restart` (서버 실행·중지) | ✅ | supervisor 경로 `api-server.ts:19167,19450` [V] |
| `git.commit` / `git.pull` / `git.push` / `git.merge` | ✅ | 플랫폼 분기 없음 `api-server.ts:13461-13500` [V] |
| `worktree.add` / `worktree.add.orca` | ✅ [I] | Rust·웹 양쪽에 Windows 분기 존재, 실측 필요 |
| `folder.open` | ✅ | `api-server.ts:3558` `openPath` Windows 분기 [V] |
| `claude.thread.start` | ✅ | `api-server.ts:13574` → Windows supervisor 경로 [V] |
| `localhost.open` / `orca.open` | ✅ [I] | Orca는 Windows 터미널 선택지에 포함 (`src/terminalDefaults.ts:11`) [V] |
| `codex.thread.start` | ❌ | Agent Runtime이 Windows에서 null (§3.2 B2) [V] |
| `workroom.save` / `workroom.status` | ❌ | 워크룸 PTY 부재 (§3.2 B1) [V] |

→ **8개 중 6개가 이미 Windows에서 동작한다.** 지금은 그 6개까지 버튼을 숨겨서 못 쓰게 하고 있다.

### 3.2 종류 B — 런타임 부재 (네이티브 작업 필요)

| # | 기능 | 현재 Windows 동작 | 근거 | 난이도 |
|---|---|---|---|---|
| B1 | **워크룸 AI 터미널 (앱 내부 PTY)** | `start`에서 throw. 헤더 터미널 선택지에서 `internal` 제외 | `src/aiTerminalService.ts:394`, `src/terminalDefaults.ts:11` [V] | **XL** |
| B2 | **Agent Runtime (관리형 Codex 실행)** | `null` 반환 = Windows 실행을 광고하지 않음 | `api-server.ts:7705-7709`, `src/agentRuntimeGuardLauncher.ts:84` [V] | **XL** |
| B3 | **워크트리 포트 자동 탐지** | 항상 `{success:true, port:null}` | `api-server.ts:19593` [V] | **M** |
| B4 | **Codex CLI(codex-tui) 세션 생존 판정** | `'unverified'` → AI 사용량 패널이 그 행을 **숨긴다** | `api-server.ts:6899` + `src/contextSessionVisibility.ts` [V] | **M** |
| B5 | **채널 헬스 프로세스 목록** | `null` (정보성 전용, 신호로 쓰이지 않음) | `api-server.ts:4447` [V] | **S** |

**B1 의 차단 원인은 측정됐다.** Bun 1.3.12는 Windows에서 PTY를 아예 지원하지 않는다:

```
$ bun /tmp/pty-probe.ts        # Bun.spawn(..., {terminal:{...}})
FAIL: terminal option is not supported on this platform
```
[V, 실측] 코드 주석이 말하는 그대로다 — `src/aiTerminalService.ts:15` "Windows has no
ConPTY/Job Object owner for the Workroom yet". 세션 스폰은 `Bun.spawn`의 `terminal` 옵션
하나에 묶여 있고 (`src/aiTerminalService.ts:448,451`), 종료 경로는 `SIGTERM`/`SIGKILL`을 쓴다
(`:506-508`). 즉 **PTY 호스트와 프로세스 종료 모델을 둘 다 교체해야 한다.**

**B4 의 비용도 측정했다.** Windows에서 프로세스를 열거하는 비용:

| 방법 | 실측 |
|---|---|
| `tasklist /FO CSV /NH` (전체 421행) | **1320 ms** |
| `tasklist /FI "IMAGENAME eq codex.exe"` | **428 ms** |
| `Get-CimInstance Win32_Process` (CommandLine 포함) | **1527 ms** |
| `Get-Process` (PowerShell 기동 포함) | 107 ms |
[V, 실측]

`/bin/ps` 한 번이 끝인 macOS와 달리 비싸지만, 이 경로에는 **이미 캐시가 있다**
(`codexTuiProbeCache` + `CODEX_TUI_PROBE_CACHE_MS`, `api-server.ts:6900-6902`) [V] 므로
필터형 `tasklist`로 충분하다. ⚠️ `Get-CimInstance`를 쓰면 CommandLine까지 얻지만 1.5초이고,
비권한 프로세스의 `CommandLine`은 `null`로 나온다 (실측 상위 3개가 전부 null) [V] — 그래서
**명령줄 매칭에 의존하는 설계로 가면 안 된다.**

**B3 은 난이도가 보이는 것보다 높다.** macOS 구현은 `lsof`로 리스너 PID를 얻고 그 프로세스의
cwd를 워크트리 경로와 맞춘다 (`src/worktreePortDiscovery.ts`) [V]. Windows는
`netstat -ano`로 리스너 PID는 얻지만 (이미 `src/windowsNetstat.ts`가 한다 [V])
**다른 프로세스의 cwd를 읽는 공개 API가 없다** — PEB를 읽어야 한다 [I].
→ 대안은 cwd 역추적을 포기하고 **앱 자신의 실행 기록(supervisor로 띄운 PID↔워크트리 매핑)만
신뢰하는 것**이다. 외부에서 띄운 워크트리 서버는 탐지되지 않으므로 **기능이 축소된 형태**이고,
그 사실을 UI에 적어야 한다.

### 3.3 종류 C — 본질적 macOS 전용 (고치지 않음)

| # | 기능 | 근거 | 판단 |
|---|---|---|---|
| C1 | **cmux 전체(8개 엔드포인트 + 8개 Tauri 커맨드)** | `api-server.ts:20817,20847,20868,20889,21378,21408,21442,21467`; `src-tauri/src/lib.rs:7405,7444,7499,7565,7598,7652,7672,7783` [V] | cmux는 Swift+AppKit 전용, Linux/WSL 빌드가 존재하지 않음. CLAUDE.md에 이미 명시 |
| C2 | **`run_claude_with_prompt` Tauri 커맨드** | `src-tauri/src/lib.rs:5089` `Err("macOS 전용 기능입니다")` [V] | iTerm AppleScript 기반. Windows는 PowerShell/WSL 경로가 이미 따로 있다 |
| C3 | **ChatGPT 음성 자동화** | `api-server.ts:6358` darwin 분기 + AppleScript 접근성 | Accessibility API 기반. Windows UIA로 재작성은 별개 제품 작업 [I] |
| C4 | **Hermes 데스크톱 앱 열기** | `api-server.ts:24220` [V] | Hermes.app이 macOS 번들 |
| C5 | **Ego Lite 브라우저 연결** | `src/browserProfilesServer.ts:149` [V] | 이미 정직한 안내 문구가 있음 |
| C6 | **Apple Container 런타임** | `src/appleContainerRuntime.ts:554` darwin+arm64 [V] | Apple 프레임워크 |
| C7 | **macOS native broker (Tauri 커맨드 6개)** | `src-tauri/src/lib.rs:9360-9371` [V] | Agent Runtime의 macOS 전용 신뢰 경계. Windows는 B2의 Rust helper가 대응물 |
| C8 | **Dock 아이콘 클릭 복원** | `src-tauri/src/lib.rs:9464` `RunEvent::Reopen`은 macOS만 존재 [V] | 플랫폼에 그 이벤트가 없음 |
| C9 | **카카오톡 대직** | `vendor/kmsg/` Swift 패키지 | macOS Accessibility 기반 |

→ **C 는 9건이고 전부 "안 고친다"가 결론이다.** 계획의 가치는 이것을 A·B와 분리해 둔 것 자체에 있다.

---

## 4. 큰 두 건(B1·B2)을 이 브랜치에서 하지 말 것을 권하는 이유

### 4.1 B1 워크룸 PTY — 선택지가 셋이고 전부 새 의존성이다

| 안 | 내용 | 문제 |
|---|---|---|
| ① `node-pty` | ConPTY를 감싼 네이티브 N-API 애드온 | Bun에서 N-API 애드온 동작 여부 미확인. 사이드카가 `bun build --compile`로 단일 exe라 `.node` 바이너리 동봉 전략이 필요 [I] |
| ② Rust PTY 사이드카 | `conpty`/`windows-sys`로 PTY 호스트를 Rust에 두고 사이드카와 파이프 통신 | 작업량 최대. 다만 신뢰 경계가 B2와 **같은 방향**이라 한 번에 설계하는 값은 있다 |
| ③ WSL 안에서 PTY | 호스트가 아니라 WSL 안에서 세션을 띄움 | 경로·환경·AI CLI 설치 위치가 전부 WSL 기준이 되어 **다른 기능과 어긋난다**. 헤더에 `wsl` 선택지가 이미 있으므로 중복 |

세 안 모두 **구현 전에 실측 1건(PoC)이 필요**하고, 그 PoC가 이 계획의 다음 작업이어야 한다.
⚠️ PTY를 켜는 것만으로 끝나지 않는다 — `aiTerminalService`의 종료 경로가 POSIX 시그널이고
(`:506-508`), 워크룸은 원격 제어·음성·모바일이 함께 쓰는 중심 표면이므로
(`api-server.ts:8728`, `src/voiceRuntimeBinding.ts`) 반쯤 동작하는 상태로 열면 피해 범위가 넓다.

### 4.2 B2 Agent Runtime — 아키텍처 문서가 지름길을 금지한다

가드 exe도 있고(`build-win.ts:84`), Job Object supervisor도 있다. 그래서 "게이트 두 줄만 열면
된다"로 보인다. **그런데 `docs/agent-runtime-containment.md:142-159`가 요구하는 것은 그게 아니다:** [V]

- `PROC_THREAD_ATTRIBUTE_JOB_LIST`로 spawn race 제거 — supervisor는 `CREATE_SUSPENDED` 후
  할당하는 방식이라 이 요구를 만족하지 않는다 [V, 스크립트 확인]
- `KILL_ON_JOB_CLOSE` 설정 **readback**과 `IsProcessInJob` 확인
- 모든 종료 경로에서 `TerminateJobObject` 뒤 `ActiveProcesses == 0` 확인
- registry에 guard PID와 **process creation time**을 함께 저장해 PID 재사용 거부
- Windows Codex PE/package/hash/version + 가능하면 Authenticode identity 검증
- 그리고 "기존 PowerShell Job wrapper를 Agent Runtime 보안 경계로 재사용하지 않는다"

즉 B2는 **Rust 네이티브 helper 신규 작성**이 전제다. 게이트만 여는 변경은 문서가 금지한 상태를
만든다. 이 브랜치에서 손대면 안 된다.

---

## 5. 권고 실행 계획

### 5단계 1 — 이 브랜치에서 끝낼 범위 (A 중심)

| 순서 | 작업 | 성공 기준(검증 가능) |
|---|---|---|
| 1 | **A1 음성 키 Windows 보관** — `VoiceCredentials`에 `Bun.secrets` 백엔드 추가. 주입 seam(`command`,`platform`) 유지, macOS 경로 무변경 | `platform='win32'`로 `configure({apiKey})` → `status().keySource==='keychain'` → `key()`가 그 값 반환 → `removeKey` 후 `'none'`. 단위 테스트로 고정 |
| 2 | **A2·A3 QR 원격제어 Windows 노출** — `App.tsx:14121`의 `!isWindows()` 제거. 대신 **동작별 가용성**을 호스트가 알려주고 Codex 작업·워크룸만 비활성 + 이유 표시 | Windows에서 도구 메뉴에 `open-qr-remote-control` / `open-internet-qr-remote-control` 존재(E2E). 6개 동작은 실행, 2개는 명시적 미지원 응답 |
| 3 | **A4 ChatGPT 앱 Windows 열기** — 409 대신 `rundll32 url.dll,FileProtocolHandler` 계열 경로 (Claude 딥링크가 이미 쓰는 방식, `api-server.ts:6248-6252`) | Windows에서 앱이 열리거나, 미설치일 때 **설치 안내**로 끝남(가짜 성공 금지) |
| 4 | **B5 채널 헬스 프로세스 목록** — 필터 없는 `tasklist` 1회(캐시) | 보고서에 목록이 들어가고 `null`이 아님 |
| 5 | **C군 문구 점검** — C1~C9가 각각 "왜 안 되는지 + 무엇을 쓰라"를 말하는지 확인 | 각 표면에 대안이 적혀 있음. 말없이 사라지는 버튼 0건 |

⚠️ 2번에서 **"Windows니까 전부 켠다"로 가면 안 된다.** CLAUDE.md의 AI 실행 버튼 규칙과 같은
원칙이다 — 눌렀을 때 실패하는 버튼보다, 눌리지만 이유를 말하는 버튼이 낫고, 말없이 사라지는
버튼이 가장 나쁘다. 그래서 동작별 가용성을 **호스트가 응답으로 알려주는** 형태로 만든다.

### 5단계 2 — 별도 브랜치 (B 중간 난이도)

| 작업 | 전제 |
|---|---|
| **B4 Codex TUI 판정** | 필터형 `tasklist`(428ms 실측) + 기존 캐시 재사용. ⚠️ 근거가 없을 때는 `unverified`가 아니라 `not-applicable`을 써야 한다 — CLAUDE.md가 명시하듯 `unverified`는 패널이 **숨기는** 값이다 |
| **B3 워크트리 포트 탐지** | 앱 자신의 실행 기록 기반 축소 구현. 외부 기동 서버는 탐지 못 한다는 사실을 UI에 적는다 |

### 5단계 3 — 별도 계획서가 필요 (B 대형)

| 작업 | 다음 행동 |
|---|---|
| **B1 워크룸 PTY** | PoC 1건: Bun 사이드카에서 ConPTY를 쓸 수 있는지(①/②) 실측. 그 결과로 별도 PLAN 작성 |
| **B2 Agent Runtime** | `docs/agent-runtime-containment.md:142-159`의 6개 요구를 만족하는 Rust helper 설계서 선행 |

---

## 6. 하지 않기로 한 것과 이유

- **cmux를 Windows로 옮기지 않는다** — 대상 앱 자체가 macOS 전용이다. CLAUDE.md도 같은 말을 한다.
- **supervisor를 Agent Runtime 경계로 재사용하지 않는다** — §4.2. 문서가 금지한다.
- **설치 여부로 버튼을 자동 숨기지 않는다** — CLAUDE.md의 AI 실행 버튼 규칙과 동일.
  이번 QR 원격제어 건이 정확히 그 실패 사례다(숨겨져서 "이 앱엔 그 기능이 없다"로 읽힘).
- **`Get-CimInstance Win32_Process`를 상시 경로에 쓰지 않는다** — 1527ms이고 `CommandLine`이
  권한에 따라 `null`이다 [V, 실측].
- **WSL로 워크룸을 우회하지 않는다** — 헤더에 `wsl` 선택지가 이미 있어 중복이고, 경로 기준이
  갈라져 다른 기능과 어긋난다.

---

## 7. 검증 명령 (이 기기 기준)

```bash
bun install                       # 844커밋 pull 후 필수
bun run typecheck                 # 기준선: 0 에러 [V]
bun test --cwd tests --max-concurrency=1
cd src-tauri && cargo test
bun run test:windows:e2e          # Windows 전용 E2E
# 패키지 검증
powershell -File scripts/run-windows-packaged-e2e.ps1
```

⚠️ `bun run tauri:build:win`은 비용이 크고, CLAUDE.md에 따라 **GitHub Windows 가상머신 빌드는
명시적 지시가 있을 때만** 돌린다. 로컬 NSIS 빌드는
`%USERPROFILE%\cargo-targets\portmanager\release\bundle\nsis\*.exe`로 나온다.

---

## 8. 결정이 필요한 항목

| # | 질문 | 선택지 |
|---|---|---|
| Q1 | 5단계 1의 2번(QR 원격제어)에서 **Codex 작업·워크룸 2개 동작**을 어떻게 보일까 | (a) 버튼은 보이고 누르면 이유 표시 (권고) / (b) 비활성 + 툴팁 / (c) 목록에서 제외 |
| Q2 | B1 워크룸 PTY의 안 선택 | ① node-pty / ② Rust 사이드카 (권고, B2와 경계 공유) / ③ WSL (비권고) |
| Q3 | A5 드롭 경로 확인을 Tauri 파일 드롭으로 대체할지 | Tauri 웹뷰 드롭 핸들러가 이미 있고 절대경로를 준다. 단 CLAUDE.md가 경고하듯 그 핸들러는 HTML5 드래그를 가로채므로 영향 범위 확인 필요 [I] |

---

## 9. 조사에 쓴 실측 기록

```
# Bun PTY (B1 차단 원인)
$ bun -e 'Bun.spawn(["cmd.exe","/c","echo x"],{terminal:{cols:80,rows:24,...}})'
FAIL: terminal option is not supported on this platform

# Bun.secrets (A1 해결 근거)
Bun.secrets OK roundtrip = v1

# Windows 프로세스 열거 비용 (B4·B5 설계 근거)
tasklist_all_ms=1320 rows=421
tasklist_filtered_ms=428
getprocess_ms=107
Get-CimInstance Win32_Process = 1527ms, 상위 3개 CommandLine 전부 null
```
