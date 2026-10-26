# 프로세스 관리 · 런타임 가드 · 터미널·tmux·Orca·AI 실행

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 프로세스 관리 시스템

### 실행 상태 추적
- **HashMap 기반**: 앱에서 직접 실행한 프로세스는 `HashMap<String, u32>` (portId → PID)에 저장
- **lsof 기반**: 앱 재시작 후 기존 프로세스는 `lsof -ti:포트번호`로 PID 검색
- **상태 확인**: "새로고침" 버튼으로 모든 포트의 실제 실행 여부를 확인
- **10초 자동 폴링**: 앱 실행 중 포트 상태를 10초 간격으로 자동 갱신 — 외부에서 켠 서버도 자동 감지
  - `portsRef` 패턴: `useRef<PortInfo[]>`로 최신 ports 참조 → `useEffect` dependency에 `ports` 불필요 (무한 루프 방지)
  - 폴링 `useEffect`의 dependency array는 반드시 `[]` — `ports` 넣으면 interval이 상태 변경마다 재생성됨
  - 구현 위치: `App.tsx` — `portsRef` + `setInterval(10000)`, cleanup on unmount

### 중지 로직 (개선됨)
- **모든 PID 검색**: `lsof -ti :포트`로 포트를 사용하는 모든 프로세스 찾기
- **각 PID마다**:
  1. SIGTERM(-15) 전송
  2. 200ms 대기
  3. `kill -0` 명령으로 프로세스 생존 확인
  4. 살아있으면 SIGKILL(-9)로 강제 종료
- **HashMap 정리**: 내부 추적 맵에서도 제거
- **안전한 에러 처리**: 프로세스가 없어도 정상적으로 처리

### 강제 재실행 로직
- **1단계 - 강제 종료**:
  - HashMap에서 먼저 제거해 그 PID를 종료 대상에 **포함**시킨다 (`stop_targets()` — 중지 경로와 공용)
  - 그 합집합의 모든 PID를 SIGKILL(-9)로 즉시 종료. SIGTERM 유예를 두지 않는 이유는
    500ms 뒤 같은 포트에 새 프로세스를 띄우기 때문이다 (`force_kill_pid`)
  - 500ms 대기 (프로세스 완전 종료 시간)
- **2단계 - 재실행**:
  - .command 파일 존재 확인
  - 새 프로세스 실행 (로그 파일로 리다이렉트)
  - 새 PID를 HashMap에 등록
- **사용 시나리오**:
  - 정지가 안 되는 프로세스 강제 종료
  - 빠른 재시작 (중지 + 실행을 한 번에)
  - 좀비 프로세스 처리

### 로그 시스템
- **로그 파일 위치**: `~/Library/Application Support/com.portmanager.portmanager/logs/{portId}.log`
- **자동 리다이렉트**: 프로세스 실행 시 stdout/stderr를 로그 파일로 자동 저장
- **실시간 보기**: 앱 내 로그 모달에서 1초 폴링으로 실시간 표시 (외부 iTerm 버튼 없음)
  - **파일 재생성 감지**: `newData.size < offset` 시 offset 0 리셋 → 서버 재시작 후 자동 복구
  - **슬라이딩 윈도우**: 최근 500줄만 유지 (`slice(-500)`) — 렌더 성능 보호
- **사용 방법**: "로그" 버튼 클릭 → 앱 내 모달 팝업

### 에이전트 런타임 가드 — 프로젝트 `.env`는 프로바이더에 닿으면 안 된다

가드(`agent-runtime-process-guard.ts`)는 프로바이더(Codex·Claude Remote)를 띄우기 전에
환경을 정한다. 대상 프로젝트 폴더는 **신뢰할 수 없는 입력**이다 — 거기 있는 `.env` 하나로
`CODEX_HOME`(샌드박스 정책·승인 모드·MCP 서버 정의)이나 Claude의 `ANTHROPIC_BASE_URL`을
바꿀 수 있기 때문이다. 실제로 이 저장소 루트에도 텔레그램 토큰이 든 `.env`가 있다.

방어는 **두 겹이고 둘 다 필요하다**:

| 방어 | 어디 | 왜 |
|---|---|---|
| `--env-file=/dev/null` | `resolveAgentRuntimeGuardCommand()` (`src/agentRuntimeGuardLauncher.ts`) | 소스 모드에서 가드 자신의 dotenv 자동 로드를 끈다 |
| 중립 cwd `/` + 워크스페이스를 argv로 | 두 spawn 경로 모두 | **패키징(컴파일) 가드**에는 CLI 플래그를 줄 수 없다 |

- ⚠️ **`--no-env-file`은 Bun에 존재하지 않는 플래그다.** `bun --help`에 없고, 1.3.1은 이걸
  조용히 무시한다 — 즉 **아무 것도 막지 않는다.** 2026-09-05 머지가 동작하던
  `--env-file=/dev/null`을 이 무효 플래그로 되돌려 구멍이 다시 열렸다. 되돌리지 말 것.
- ⚠️ **`--no-compile-autoload-dotenv`가 패키징 빌드를 지켜준다는 말은 틀렸다.** 실측(2026-09-05):
  이 플래그로 컴파일한 바이너리도 실행 시 cwd의 `.env`를 읽었고, `bun build`는 존재하지 않는
  `--no-compile-autoload-*` 플래그도 오류 없이 받아들인다. 컴파일된 가드에는 `--env-file`을
  줄 방법이 없으므로 **중립 cwd가 유일한 방어다.**
- 그래서 가드는 `GUARD_NEUTRAL_CWD`(`/`)에서 돌고 워크스페이스는 argv로 받는다. 프로토콜은
  `agentstoz-provider-argv-v4` / `agentstoz-claude-remote-argv-v3`이며 **argv[1]이 워크스페이스,
  argv[2]부터가 provider argv**다. 프로토콜을 바꾸면 런처·가드·`tests/fixtures/`를 함께 고칠 것.
- `env -i`는 이 구멍을 못 막는다 — 상속 env는 지우지만, 가드가 **이미 흡수한** 값을 그대로
  전달한다. codex 경로는 `PROVIDER_ENV_ALLOWLIST`가 이름을 줄여주지만 `CODEX_HOME`은
  allowlist에 있고, **claude-remote 경로는 allowlist 없이 env 전체를 넘긴다.**
- ⚠️ **두 방어가 서로를 가려서 행위 테스트만으로는 회귀를 못 잡는다** — 하나만 되돌려도
  프로바이더 env는 여전히 깨끗하다. 그래서 `tests/agent-runtime-process-guard.test.ts`에
  ① 플래그 없이 가드를 직접 띄우는 행위 테스트와 ② **두 spawn 경로의 cwd·argv를 직접 보는
  계약 테스트**를 함께 둔다. 새 spawn 경로를 추가하면 계약 테스트에도 넣을 것.
- 중립 cwd 때문에 `Bun.spawn`이 더는 없는 폴더에 ENOENT를 내지 않으므로(`/`는 항상 있다)
  `assertWorkspaceDirectory()`가 **예약 전에** 대신 막는다. 없으면 durable 예약이 `active`로
  커밋된 뒤 `/usr/bin/env`를 가리키는 엉뚱한 메시지로 죽는다.

### 터미널 실행 결과 계약 (iTerm / Terminal.app)

`create window ... command` / `do script` AppleEvent는 터미널 앱의 main run loop가 막히면
수십 초 이상 반환되지 않는다(실측: 같은 앱이 `get version`은 0.05s인데 `count windows`는 25s+ 무응답).
따라서 실행 결과는 **3-상태**로 다룬다.

| 상태 | 조건 | 응답 |
|---|---|---|
| 확인됨 | deadline(4초) 안에 osascript exit 0 | `{success:true, verified:true}` |
| 실패 | deadline 안에 exit≠0 (권한 거부 -1743 등) | `{success:false, error}` |
| **미확인** | deadline 초과 | `{success:true, verified:false, warning}` — 창이 열릴 수도 있으므로 실패로 단정하지 않는다 |

- deadline을 넘겨도 **osascript를 죽이지 않는다.** 전달 중인 AppleEvent가 창을 열 수 있다.
  좀비 누적 방지를 위한 backstop(120초) 이후에만 SIGKILL.
- Tauri 쪽 터미널 커맨드는 반드시 `#[tauri::command(async)]` — sync면 osascript 대기가
  IPC/메인 스레드를 막아 앱 창 전체가 얼어붙는다.
- **같은 규칙이 프로세스를 spawn하는 모든 커맨드에 적용된다.** `git_*`·`list_git_worktrees`가
  sync였던 동안 앱에서만 커밋·머지 후 목록이 수 초간 멈췄고, 그 정지가 "버튼이 안 눌렸다"로
  읽혔다. 새 커맨드가 외부 프로세스를 부르면 async로 둘 것.
- ⚠️ 새 터미널 실행 엔드포인트를 추가할 때 fire-and-forget `spawn(osascript)` + 무조건
  `success:true` 패턴을 다시 쓰지 말 것 (가짜 성공).
- **브라우저 열기도 같은 계약이다 (2026-10-06).** `/api/open-in-chrome`이 바로 그 패턴이었고 —
  spawn 뒤 무조건 `{success:true}` — 휴대폰의 「localhost 열기」가 Chrome 없는 Mac에서도
  「열었습니다」를 돌려줬다. 판정은 `src/browserLaunchVerification.ts`의 `classifyBrowserLaunch`
  한 곳이고 **종류가 둘**이다: `helper`(`open -a`·`rundll32`)는 URL을 넘기고 바로 끝나므로 **종료
  코드가 곧 답**이고 침묵(5초)은 `BROWSER_LAUNCH_NOT_VERIFIED`, `executable`(브라우저 바이너리
  직접 실행 — 배포 프로필 경로)은 **성공하면 계속 떠 있으므로** 마감(1.2초) 뒤 살아 있는 것이
  정상이고 **이른 비정상 종료만** 실패다. 두 종류를 한 규칙으로 덮으면 한쪽이 반드시 거짓말한다.
  프로세스는 죽이지 않는다(살아 있는 그것이 브라우저다). 실패 코드는 `remoteControlActionFailure`가
  **문구째** 통과시킨다 — 일반 「프로젝트 제어를 완료하지 못했습니다」로 떨어지면 정작 사용자가
  할 수 있는 일(그 브라우저가 이 Mac에 없다)이 가려진다.

### tmux 모드 (헤더 `tmux` 토글)

tmux를 쓰는 이유는 하나다: **터미널 창을 닫아도 AI 세션이 죽지 않는다.**
tmux 없이 열면 창을 닫는 순간 Claude/Codex가 작업 중이라도 함께 종료된다.

**토글이 실제로 미치는 범위** — 판정은 `src/terminalDefaults.ts`의 `tmuxReach()` 한 곳만 쓴다.

| 조건 | Claude | Codex / agy |
|---|---|---|
| iterm·terminal·cmux + **bg ON** (기본값) | ❌ `--bg`(Agent View)로 조기 반환 — tmux 경로 미도달 | ✅ tmux |
| iterm·terminal·cmux + **bg OFF** | ✅ tmux | ✅ tmux |
| wsl + **bg ON** (기본값) | ❌ `--bg`로 조기 반환 — tmux 경로 미도달 | ✅ tmux |
| wsl + **bg OFF** | ✅ tmux | ✅ tmux |
| orca / powershell | tmux 경로 없음 (버튼도 숨김) | — |

- 기본값이 `bgMode:true`+`tmuxMode:true`라 **Claude만 쓰는 사용자에게는 토글이 아무 일도 안 한다.**
  이 상태를 헤더에서 점선 테두리 + `tmux (codex·agy)` 라벨로 드러낸다(`data-tmux-reach` 속성으로 검증 가능).
  Claude도 tmux로 띄우려면 `Claude bg`를 꺼야 한다.
- 세션명 = `aiName || name` 을 sanitize 후 30자 컷(`getSessionName`, App.tsx). bypass ⚡ 는
  `<세션명>-bypass` 로 **별도 세션**이 된다.
- **"실행" = 재사용**(`new-session -d` 실패 무시 → `attach-session`), **"새 창" = 파괴 후 재생성**
  (`kill-session` 선행). 복귀 목적으로 "새 창"을 누르면 실행 중이던 세션이 날아간다.
- ⚠️ **세션명 규칙의 정본은 `src/tmuxSessionName.ts` 한 곳이다.** 두 버튼이 같은 세션을 가리켜야
  쌍이 성립한다 — 예전에는 재사용 경로만 워크트리 접미사를, 서버만 `-bypass`를 붙여서 "새 창"이
  아무도 붙어있지 않은 세션을 지웠다. 웹 API·Rust 양쪽 모두 이 규칙을 적용해야 한다.
  **Claude·Codex·agy 모두 같은 규칙을 쓴다** — Codex/agy의 `fresh` 플래그가
  `/api/open-tmux-{codex,agy}`와 Tauri `open_tmux_{codex,agy}` 양쪽에 있어야 앱과 웹이 같게
  동작한다. 한동안 워크트리·bypass 접미사가 Claude 경로에만 있어서 이 문장이 실제로는 거짓이었다.
- ⚠️ **패리티는 소스 grep이 아니라 골든 표로 고정한다.** 구현이 TS와 Rust 두 벌이므로,
  `tests/fixtures/tmux-session-golden.json`을 TS 테스트와 Rust `include_str!` 테스트가 **함께**
  읽어 같은 입력이 같은 세션명을 내는지 검사한다. 새 에이전트나 새 플랫폼 분기를 추가하면
  **그 케이스를 이 골든 표에 함께 추가해야 한다** — 표에 없는 조합은 검사되지 않는다.
  정규식으로 리터럴 개수만 세는 테스트는 두 구현이 서로 어긋나는 것을 잡지 못한다.
- 사용자 조작: `Ctrl-b d`(detach·세션 유지) / `tmux ls` / `tmux attach -t <세션명>`
  (`-d` 추가 시 다른 클라이언트 강제 분리) / `tmux kill-session -t <세션명>`.
- `/api/send-tmux-keys`는 프론트 호출부가 없는 미사용 경로다. 수동으로는
  `tmux send-keys -t <세션> '<text>' Enter`.
## AI 실행 버튼 — 표시는 선택, 설치는 안내

두 가지를 섞지 말 것. **숨김은 사용자의 취향이고, 미설치는 눌렀을 때 알리는 사실이다.**

- **표시 설정**: 헤더 토글 줄의 `AI 표시` 드롭다운에서 claude·codex·agy·hermes를 개별로 끈다.
  판정은 `src/launchAgentVisibility.ts` 한 곳, 저장은 기기별 localStorage
  (`portmanager-hidden-agents`) — 기기마다 설치된 AI가 다르므로 동기화하지 않는다.
  끄면 그 AI의 CLI 버튼과 앱 버튼이 **네 표면 모두**(프로젝트 카드·워크트리 행·상세 패널·헤더)에서 사라진다.
  저장값이 깨졌거나 모르는 이름이면 **조용히 "다 보임"** 으로 떨어진다 — 파싱 실패로 버튼이
  사라지면 사용자는 설정이 아니라 앱이 고장 났다고 읽는다.
- ⚠️ **설치 여부로 버튼을 자동으로 숨기지 말 것.** 말없이 사라지는 버튼은 "이 앱엔 그 기능이
  없다"로 읽힌다. 한 번 그렇게 구현했다가 되돌렸다.
- **Hermes 미설치 판정**: `hermesPresent`는 `~/.hermes` 홈 **과** 실행 파일이 둘 다 있어야 참이다
  (`src/hermesCliPresence.ts`의 `hermesCliPathFromResolved`가 정본 —
  `resolveAgentBin`이 이름 그대로를 돌려주면 미설치). 홈 폴더만 보던 시절, **앱의 어댑터
  설치기가 만든 `~/.hermes`** 때문에 CLI 없는 기기가 "설치됨"으로 판정돼 실행 버튼이 떴고
  누르면 `Executable not found in $PATH`로 끝났다.
- 실행 경로는 spawn 전에 미설치를 판정해 **409 `HERMES_CLI_NOT_FOUND`** 를 돌려주고, 프론트는
  확인된 미설치일 때 요청 없이 바로 안내한다. **이미 떠 있는 Hermes 인스턴스가 있으면 막지
  않는다** — 그 경로는 실행 중인 프로세스의 실행 파일을 재사용하므로 CLI가 필요 없다.
- 앱 버튼과 CLI 버튼이 **같은 판정**을 거쳐야 한다. 앱 버튼만 막으면 터미널 버튼이 대신 죽는다.
- **실행 옵션의 권한 우회는 상세 패널 「Claude 앱에서 열기」에도 적용된다**(VOC 2026-09-11) —
  `/api/open-code-app`의 `bypass` → `claude remote-control --permission-mode bypassPermissions`.
  세션은 프로젝트당 하나라서 **다른 모드로 실행 중인 대화는 재사용하지 않고**
  `CLAUDE_REMOTE_SESSION_PERMISSION_MODE_MISMATCH`(409)로 이유를 말한다. 모드를 지정하지 않는 호출자
  (휴대폰)는 살아 있는 세션을 그대로 재사용한다. Codex·Hermes 앱은 외부에서 권한 모드를 받지 않으므로
  토스트로 「권한 우회는 적용되지 않습니다」라고 밝힌다 — 조용히 무시하지 말 것.

## 데스크톱 앱으로 보내기 — Antigravity 앱 · `@` 앱 받는 곳 · MCP `task` (2026-10-08)

AI 앱은 넷이다: Codex 앱(codex) · Claude 앱(claude — 기존 `claude remote-control` 경로, **`claude://` 폴더 링크를 쓰지 말 것**) ·
Hermes 앱(hermes) · **Antigravity 앱(agy, 새로 추가)**. 경로는 `/api/open-code-app` 하나이고 본체는 `openCodeAppResponse`(api-server.ts)다.

- **Antigravity 앱은 실행·앞으로 가져오기만 한다.** Antigravity.app 2.0(`com.google.antigravity`, `antigravity://`)은 에이전트 허브라
  asar 안에 폴더 인자 처리도, 바깥에서 받는 첫 요청 입력도 **없다**(asar로 확인). 그래서 응답은 언제나 `projectApplied:false`·
  `taskApplied:false`이고 화면은 「Antigravity 앱을 열었습니다 · 프로젝트는 앱에서 선택하세요」(확인 못 했으면 「실행을 요청했지만 확인하지
  못했습니다」)라고 말한다. 응답의 `projectNote`는 「프로젝트는 앱에서 선택하세요」뿐이다 — 열렸는지는 `launchVerified`가 말하고, OPS·MCP 결과는
  이 note를 `warnings`에 다시 넣지 않는다(`message`에 이미 있다). 판정은
  `src/antigravityAppLaunch.ts`: `/Applications`·`~/Applications` → `mdfind`(3초, **비동기** — `spawnSync`는 사이드카 전체를 멈춘다; 못 찾은 결과는
  30초 기억) 순으로 찾고, 없으면 409 `ANTIGRAVITY_APP_NOT_FOUND`
  (**버튼을 자동으로 숨기지 않는다** — 누를 때 알린다), `SSH_*`를 뺀 env로 `/usr/bin/open -b com.google.antigravity`를 10초까지 기다린다 —
  exit 0 = 확인됨, 그 밖 = 502 `ANTIGRAVITY_APP_LAUNCH_FAILED`, 시간 초과 = `launchVerified:false` 경고(죽이지 않는다). macOS 밖은 501
  `ANTIGRAVITY_APP_UNSUPPORTED_PLATFORM`.
- **작업 요청(`task`)은 Codex만 받는다.** `codex://threads/new?path=…&prompt=…`가 입력칸을 **채울 뿐 보내지 않는다** —
  `taskApplied:'prefilled'`·`selectionVerified:false` — **채우도록 요청했다**는 뜻이지 채웠다는 확인이 아니다(화면 문구도 「요청했습니다 · 앱에서
  확인한 뒤 보내기」). ⚠️ **채울지는 인코딩한 링크 길이로 정한다**(`codexTaskFitsDeepLink`): 4,000바이트 **그리고** 링크 8,192자
  (`CODEX_DEEP_LINK_MAX_CHARS`, `buildCodexDesktopDeepLinkCommand`의 한도). 한글 1바이트가 `%XX` 3자라 4,000바이트 한글은 ~12,000자다 —
  바이트만 보던 동안 2,700바이트(한글 900자) 작업이 「채울 수 있음」으로 판정돼 Codex가 아예 열리지 않고 코드 없는 500이 났다. 넘으면 프롬프트
  없이 열고 `taskApplied:false`·`taskReason:'too-large'`. 링크를 만들지 못하면 400 `CODEX_DESKTOP_DEEP_LINK_INVALID`(문구 있음)이다.
  `/api/open-code-app`의 사전 검사는 `checkOpenCodeAppRequest`(순수 함수, 테스트가 그것을 직접 부른다). Claude·Hermes·Antigravity 앱은 `taskApplied:false`·`'unsupported-app'`이고, 데스크톱 화면이
  **열기 전에 클립보드에 복사**하고 그렇게 말한다. 검사는 워크룸 지시와 같은 규칙(`src/codeAppTask.ts` — 제어 문자 거절·앞 `!` 거절).
  권한 우회는 Claude 앱만 받고 나머지는 경고한다.
- **워크룸 `@` 받는 곳에 앱 네 개가 있다(Mac 화면 전용).** 「받는 곳」 선택에 `워크룸 CLI`/`앱` 묶음이 갈리고 앱 값은 `app:<agent>`
  (`src/workroomAppRoute.ts`). 보내면 같은 핸드오프 글을 만들어 **어느 앱이든 먼저 클립보드에 복사**하고(Codex 채우기의 백업), 새 경로
  `POST /api/agent-runtime/app-dispatch`(`{targetId, agent, task?, bypass?}`만)로 넘긴다. `task`는 **링크에 담기는 Codex일 때만** 싣는다 — 받지도
  않는 앱이 크기 검사(24,000바이트)에 걸려 열리지 않던 결함이 있었다. Codex는 작업이 없어도 `mode:'new'`(옛 대화를 다시 열지 않는다).
  화면은 폴더 경로를 모르므로 경로 몫 1,024자를 남겨 두고 판정하고, 서버가 실제 경로로 다시 판정한다. 버튼·확인창 첫 줄은 「보내기」가 아니라
  실제 동작(「Codex 앱 입력칸에 채우기」·「<앱> 열고 작업 복사」)을 말하고, `#` 언급이 앱에 가지 않는다는 것도 **확인 전에** 말한다.
  사이드카가 targetId를 **새로** 해석해 `openCodeAppResponse`를 프로세스 안에서 부르고(자기 HTTP 재호출 없음), 응답에서 로컬 경로를
  지운다. 에이전트 런타임 관리 권한이 있어야 하고 Rust `is_allowed_agent_runtime_route`가 이 경로만 POST 64KiB·응답 75초로 허용한다
  (Bun `idleTimeout` 90초 안쪽). 영수증(`workroom-app-route-receipt`)이 실제로 일어난 일(채우기 요청/복사/복사 실패/실행 미확인)을 말하고,
  초안은 **클립보드에 확실히 담겼을 때만** 비운다(Codex 채우기는 확인되지 않으므로 근거가 아니다). 실패 문구는 클립보드에 복사돼 있다는 사실도
  말한다. 64KiB를 넘는 요청과 Rust 프록시가 **보내기 전에** 거절한 오류(`WORKROOM_APP_DISPATCH_PRE_SEND_ERRORS`, 문장이 lib.rs에 있는지 테스트가
  지킨다)는 「결과를 받지 못했다」가 아니라 실패다 — 보낸 뒤 응답을 못 받은 경우만 「확인하지 못했다」.
- **MCP `agentstoz_use_open_code_app`(계약 1.31.0)**: agy는 앱 표면에서 Antigravity 앱을 띄운다. 선택 `task`(사이드카와 같은 24,000바이트,
  앞 `!` 거절)는 Codex에만 채워지고(링크에 담기에 길면 `taskReason:'too-large'`), Orca 표면·`mode=prepare|reopen`과는 함께 쓸 수 없다.
  ⚠️ **Codex + task는 MCP가 `mode:'new'`를 명시해 보낸다** — 옛 호스트는 `new`를 파싱 단계에서 거절하므로, task를 버리고 옛 대화를 다시 여는
  부작용이 생기기 **전에** 멈춘다(echo 검사만으로는 부작용을 막지 못했다). 다른 MCP 도구에 `task`를 주면 거절한다(조용히 버리면 빈 워크룸이 성공으로 보고된다). **두 경계가 같은
  규칙을 쓴다** — `parseAgentsToZUseLaunchOptions`를 MCP 서버와 호스트 파서가 함께 부른다(`AGENTSTOZ_USE_CODE_APP_TASK_*`).
  호스트 응답은 `taskApplied`(+`taskReason`·`taskNote`)를 되돌려 주고, 받지 못한 task는 `warnings`에도 적는다. ⚠️ **MCP 서버는 task를 보냈는데
  `taskApplied`가 없으면 `AGENTSTOZ_USE_HOST_OUTDATED`로 실패시킨다**(옛 호스트는 task를 버리고 옛 대화를 다시 연다). `mode=new`에 `mode:"new"`가
  돌아오지 않을 때도 같다. 예전에는 prepare가 아닌 모든 Codex 결과를 `reopened`로 보고했다 — 이제 실제 mode를 그대로 넘긴다.
  지시문 첫 2,000자 안에 「‘<프로젝트>를 <CLI>로 워크룸에서 시작’ → start_workroom_session / ‘<프로젝트>를 <앱>에서 열어’ → open_code_app(…, task)」가 있다.
- **이번 범위 밖**: 휴대폰 포털·LAN QR 페이지·커뮤니티 다른 기기 경로에는 앱 받는 곳이 **없다**(패널이 `remote`이거나 기기 `@` 경로면 앱 선택지를
  숨긴다 — 그 앱은 사람이 보고 있는 Mac이 아니라 연결한 Mac에서 뜬다). 음성 도크의 AI 선택·Orca + task도 아직 아니다.
- 검증: `tests/antigravity-app-launch.test.ts`, `tests/workroom-app-route.test.ts`, `tests/agentstoz-use-ops-surface.test.ts`(두 경계가 같은 입력을
  거절), `tests/agentstoz-use-code-app-mode.test.ts`, `tests/control-profile-surface-api.test.ts`(전달 본문·echo), `tests/workroom-orchestration-guards.test.ts`
  (HOST_OUTDATED·2,000자), Rust `workroom_app_dispatch_uses_exact_post_route_with_bounded_size_and_wait`, `tests/workroom-usability.e2e.mjs`의 앱 시나리오.
  ⚠️ 실제 앱(Antigravity·Codex 프리필·WKWebView 클립보드)으로는 아직 확인하지 않았다. `/api/open-code-app`의 앱 실행 분기 자체(spawn)는
  여전히 테스트가 실행하지 않는다 — 실행 전 판정(`checkOpenCodeAppRequest`·`planCodeAppTask` + 실제 `buildCodexDesktopDeepLinkCommand`)과
  공개 본문(`workroomAppDispatchPublicBody`)만 함수로 직접 검사한다.

## 「내 기기와 연결」 — 필요한 것 모두 설치 (2026-10-08)

설정 화면 「내 기기와 연결」의 맨 위가 **「한 번에 설치하기」 카드 하나**다(`src/OnboardingInstallAll.tsx`, 판정은
`src/onboardingInstallAllPlan.ts`). NH 디자인 앱(nhdesign-usher)의 「필요한 것 모두 설치」를 옮긴 것이고, 예전의 단계별
준비 목록·상황 선택·도구 표·동행 프롬프트는 전부 「자세히 보기 · 하나씩 준비하기 · 직접 설치」(`onboarding-step-by-step`)
안으로 접었다(지운 것이 아니다 — 설치 앱이 아닌 웹에서는 펼친 채 열린다). 상태 확인 실패(`loadError`)는 접힌 칸 밖에 둔다.

- **버튼은 새 설치기를 만들지 않는다.** 이미 있는 검증된 설치 도우미 둘 — Codex(`onboardingCodexInstallHost`, Apple Silicon의
  고정 패키지 또는 winget)·GitHub CLI(`onboardingGithubHost`) — 를 같은 `onboarding_management_request` 경로로
  **status → review → install → 읽기**로 차례대로 돌린다. Rust·사이드카는 바꾸지 않았다. 리뷰 신선도(5분)·`expectedRevision`·
  다른 창에서 진행 중인 설치 기다리기·중단된 설치(`interrupted`)는 호스트 규칙 그대로다.
- ⚠️ **진단이 「없음」이라고 증명한 도구만 돌린다**(`installAllRunnable`). 있는 도구를 다시 돌리면, 로그인 확인이 애매한 기기
  (`CODEX_HOME`·`GH_TOKEN` 등)에서 호스트가 `needs-review`로 끝나 누를 때마다 「설치 실패」가 됐다(검토에서 재현). `unknown`은
  없는 것이 아니다.
- ⚠️ **저장된 「installed」 영수증만 보고 건너뛰지 않는다** — 그 뒤 지워졌을 수 있다. 호스트의 probe가 있는 것은 내려받지 않고 넘긴다.
- 한 도구가 실패해도 다음 도구는 돈다. 호스트가 「이 기기 지원 안 함」이라 답한 도구는 다시 제안하지 않고, 아무것도 설치하지
  못했으면 「모두 설치했습니다」라고 **말하지 않는다**(`installAllSummary`).
- 완료 문구는 「Codex·GitHub CLI 설치 완료」다 — 동기화·선택 도구까지 끝났다고 읽히는 「필요한 것 모두」로 쓰지 말 것.
- 로그인은 사람이 한다: 설치 뒤 진단이 **`needs-login`인 도구만** 그 자리에서 로그인 패널을 연다(Codex 로그인 도우미는 Mac 전용).
  「자세히 보기」의 준비 목록은 **펼쳤을 때만** 마운트한다 — 접힌 채 같은 패널이 하나 더 돌면 서로의 revision을 낡게 만든다.
- 이 앱은 StrictMode로 돈다. 비동기 결과를 막는 `alive` 플래그는 **effect 안에서** true로 세울 것 — ref 초깃값으로 두면 StrictMode의
  첫 정리가 false로 만든 채 남아 진행 표시가 「준비 중…」에서 멈춘다(e2e가 실제로 잡았다).
- Claude Code·Antigravity·Hermes·Supabase CLI는 아직 자동 설치하지 않는다(검증된 설치 도우미가 없다). 「자세히 보기」의 명령 복사로 남는다.
- 검증: `tests/onboarding-install-all.test.ts`(실제 두 호스트 + 가짜 효과: 순서·재실행 무중복·지워진 도구 재설치·실패 격리·지원 안 함·
  옛 앱·다른 창 설치 기다리기·시간 초과·화면 구조), `bun tests/onboarding-install-all-ui.mjs`(실제 브라우저 390px: 진행 표시·완료·로그인
  패널·새로고침 무설치. `ONBOARDING_UI_CSS=<vite 빌드 css>`를 주면 두 테마 스크린샷). 실제 앱 설치 화면에서는 아직 눌러 보지 않았다.

## Orca 실행 표면 (플로팅 / 워크트리 내부)

헤더의 선택(`orcaLaunchMode`)은 **AI 실행과 로컬 미리보기 둘 다**에 적용된다.
판정은 `src/orcaFloatingTerminal.ts`의 `shouldUseOrcaFloatingTerminal()` 한 곳만 쓴다.

| 모드 | AI(Claude/Codex/agy) | 로컬 미리보기(Orca 탭) |
|---|---|---|
| 플로팅 | Orca Floating Workspace 터미널 | `tab create --worktree id:global-floating-terminal` |
| 워크트리 내부 | 해당 Orca 프로젝트 안의 터미널 | `tab create --worktree path:<워크트리>` |

- 경로가 없는 전역 바로가기는 모드와 무관하게 항상 플로팅이다.
- 플로팅 탭은 저장소에 매이지 않으므로 `repo add`를 하지 않는다 → git이 아닌 폴더에서도 열린다.
- **`selector_not_found` 폴백**: Orca가 추적하지 않는 경로(등록 안 된 저장소·일반 폴더)는 워크트리
  셀렉터가 없어 `terminal create --worktree path:<경로>`가 실패한다. 이때 실행을 실패로 끝내지 않고
  저장소에 매이지 않는 Floating으로 열고, `fallbackNotice`로 표면이 바뀐 사실과 복구 방법을 알린다.
  폴백 경로도 플로팅 재사용 규칙을 그대로 거치므로 클릭할 때마다 탭이 늘지 않는다
  (`isOrcaWorktreeSelectorMissing`, `src/orcaWorktreeSupport.ts`).
- 숨김 경로(`.claude/worktrees/`) 경고는 **워크트리 내부 모드에서만** 낸다. 플로팅은 경로에
  매이지 않으므로, 워크트리가 Orca 사이드바에 안 보이는 저장소에서도 미리보기가 뜬다.
- ⚠️ **Orca CLI는 `{ok:false}`를 stdout에 내면서 종료 코드 1로도 끝난다(1.4.194 실측).** Rust `orca_run_json`이
  종료 코드만 보고 빈 stderr를 `unknown`으로 뭉개던 동안, 닫힌 플로팅 탭의 `terminal_handle_stale`이 stale로
  분류되지 않아 그 에이전트의 「실행」이 매번 「탭을 확인하지 못했습니다 (unknown)」로 막혔다(2026-09-12).
  이제 `orca_cli_failure_message`가 stdout의 JSON 오류를 먼저 읽고 `code`를 보존한다 — `selector_not_found`
  폴백이 코드에 기대므로 메시지만 남기지 말 것. TS는 macOS에서 osascript `exit 0`으로 같은 JSON을 읽어서
  이 결함이 앱(Rust)에만 있었다.

## AI 사용량 패널 — 세션 표면 판정

스냅샷 신선도(`state`)와 **표면 존재 여부**(`surfacePresence`)는 별개다. 최근 기록이 있다는 사실은
창이 아직 열려 있다는 증거가 아니다. `gone`/`unverified` 행은 목록에서 감춘다
(`src/contextSessionVisibility.ts`).

| 세션 | 판정 근거 | 결과 |
|---|---|---|
| Orca 워크트리/플로팅 Claude | `orca status` + `orca-data.json` 바인딩 + `terminal list` | live / gone / unverified |
| cmux Claude | cmux 트리 조회 후 표면 확인 | live / gone / unverified |
| **Claude 백그라운드 에이전트** | `claude agents --json --all` (working·blocked=live, done·failed=gone) | live / gone |
| **Codex CLI(codex-tui)** | `ps` 목록에 Codex CLI 프로세스가 하나도 없으면 종료된 세션 | gone / unverified |
| ChatGPT 앱 Codex | 스레드는 앱 종료 후에도 남는다 → 표면 판정 안 함 | not-applicable |

- `claude --bg` 세션은 데몬이 실행하므로 statusLine 스냅샷의 `launchContext`가 **전부 null**이다.
  이 공백은 "터미널을 못 찾음"이 아니라 백그라운드 에이전트라는 증거다 — `src/claudeAgentInventory.ts`.
  전용 창이 없으므로 이동 버튼은 헤더에서 고른 터미널에 **Agent View**를 연다(`onOpenAgentView`).
- **Agent View에서 목록을 지우면** 그 세션은 `claude agents --all`에서도 사라진다. 이때 우리 캡처
  파일은 남으므로, 아무 조치가 없으면 "실행 위치 미확인 · 이동 미지원" 행으로 되살아난다.
  → 터미널 흔적이 하나도 없고(`hasTerminalLaunchEvidence` false) 읽을 수 있는 목록에도 없으면 `gone`.
  살아있는 bg 에이전트는 항상 목록에 있으므로 이 규칙에 숨겨지지 않는다.
- ⚠️ **`unverified`는 "판단 불가"가 아니다.** 패널이 숨기는 값이므로, 프로브가 확신 없이 이 값을 쓰면
  살아있는 세션이 사라진다. 근거가 없을 땐 `not-applicable`(=아무 주장 안 함)을 쓴다.
  - **이 규칙을 어기고 있던 곳이 하나 있었고 2026-10-06에 고쳤다.** Codex rollout이 Orca를 호스트로
    지목하지만 Orca의 pane/session 바인딩은 들고 있지 않다 — 그때 `unboundOrcaContextSurfacePresence`가
    `unverified`를 돌려줘서, **Orca가 떠 있는 동안 Orca로 분류된 Codex 행이 항상 숨겨졌다**(세션이
    살아 있을 가능성이 가장 큰 바로 그 상태에서). 지금은 `codexTuiSurfacePresence`와 같은 모양이다:
    Orca 런타임이 **확실히 멈췄을 때만** `gone`, 그 밖에는 `not-applicable`(아무 주장 안 함). 바인딩이
    없으므로 `live`도 주장하지 않는다. 회귀는 `tests/context-session-presence.test.ts`가
    `visibleContextSessions`로 **보이는지 여부까지** 확인한다 — 반환값만 비교하면 숨김 규칙이 바뀌었을 때 못 잡는다.
- Codex는 rollout 메타의 `source`로 실행 편집기를 알려준다(`vscode` → VS Code 계열).
  Orca 터미널은 `TERM_PROGRAM=Orca`이므로 `vscode`는 Orca가 아니다.
## 워크트리 소유권 판정

`src/worktreeSource.ts`의 `classifyWorktreeSource()` **한 곳**만 쓴다 (배지 표시 + 삭제 경로 공용).
- 경로가 Orca 목록보다 **우선**한다. Orca는 등록된 저장소 안의 일반 git 워크트리도 스캔해
  자기 목록에 넣으므로 "Orca 목록에 있음"은 소유권의 증거가 아니다.
- `<repo>/worktrees/` 및 `<repo>/.claude/worktrees/` → 앱 소유(`app`)
- `~/orca/workspaces/` 또는 (앱 소유가 아니면서) Orca 목록에 있음 → `orca`
- Orca 소유로 판정돼도 Orca CLI 삭제가 실패하면 일반 `git worktree remove`로 폴백한다 —
  Orca 미설치/미기동 때문에 사용자의 삭제 자체가 막히면 안 된다.

## 에러 처리
- **중지 실패 시**: 프로세스가 없어도 에러 대신 "already stopped" 메시지 표시
- **Chrome 열기 실패 시**: Toast 알림으로 에러 표시
- **로그 파일 없음**: 자동으로 빈 로그 파일 생성
- **파일 없음**: .command 파일이 없으면 명확한 에러 메시지 표시
- **워크트리 실행 시 의존성 self-heal**: `execute_command` 직전 `ensure_dependencies_sync()`가 node_modules/.venv 없으면 동기 설치 후 서버 기동 (GUI PATH desert 대응 — bare `Command::new("bun")` 금지, `resolve_bin()`+`build_path_env()` 필수)
