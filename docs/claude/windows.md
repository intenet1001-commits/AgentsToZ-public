# Windows — 에이전트 런타임 봉쇄 · ConPTY · Codex 다시 시작

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## Windows 에이전트 런타임 봉쇄 — Job Object 헬퍼는 있고, 기능은 아직 닫혀 있다

`src-tauri/src/windows_job.rs`가 `docs/agent-runtime-containment.md`의 「Windows 기준선」을 구현한다.
⚠️ **이것은 전제조건이고 기능이 아니다.** 같은 문서가 staging 격리·Codex sandbox 호환·broker escape
E2E를 **별도로** 요구한다 — Job을 상속하지 않는 WMI·서비스·작업 스케줄러로 나갈 수 있기 때문이다.
그래서 모듈은 **검증됐지만 아무 실행 경로에도 연결되어 있지 않다**(`#![allow(dead_code)]`가 그 표시이고,
연결할 때 함께 지운다). 기존 PowerShell Job 래퍼는 일반 프로세스용으로 남고 보안 경계로 재사용하지 않는다.

- **생성 순간부터 Job 안이다** — `PROC_THREAD_ATTRIBUTE_JOB_LIST`. `AssignProcessToJobObject`를
  `CreateProcess` **뒤에** 부르면 그 사이에 자식을 띄워 빠져나갈 창이 생긴다.
- **`KILL_ON_JOB_CLOSE`를 되읽어 확인한다.** 조용히 적용되지 않은 한도는 소유자가 사라진 뒤에도
  provider를 살려 두는데, 그것이 바로 이 봉쇄가 막으려는 단 하나의 성질이다. `IsProcessInJob`으로
  소속도 가정하지 않고 확인하며, 아니면 **실행을 실패시킨다**(갇히지 않은 채 진행하지 않는다).
- ⚠️ **종료 증거는 `ActiveProcesses == 0`이다.** `TerminateJobObject`의 성공 반환은 요청이 전달됐다는
  뜻일 뿐이다. 그리고 **`TotalTerminatedProcesses`를 증거로 쓰지 말 것** — 커널이 **한도 위반**으로 죽인
  수만 세므로 정상 종료 뒤에도 0이다(실측: 그걸로 단정했다가 올바른 종료가 실패했다). 대신
  `TotalProcesses`로 Job이 비어 있지 않았음을 본다.
- ⚠️ **제한된 stdio를 반드시 준다.** 표준 핸들이 없는 콘솔 프로그램은 **즉시 종료한다**(실측:
  `ping`·`cmd` 둘 다 바로 죽어 Job이 정당하게 `active_processes: 0`을 보고했다 — 구현 결함으로 오해하기
  쉽다). `NUL` 세 개를 주고, `STARTF_USESTDHANDLES`가 동작하려면 `bInheritHandles`가 TRUE여야 하므로
  **`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`로 그 세 개만** 상속시킨다 — Job 핸들이 자식에게 가면 갇힌
  프로세스가 자기 컨테이너를 종료·재설정할 수 있다. (가드 프로토콜용 파이프 stdio는 다음 단계다.)
- ⚠️ **Windows 8+는 중첩 Job을 허용한다.** 갇힌 프로세스를 **다른 Job에 추가하는 것은 성공한다**(실측).
  성립하는 성질은 "다른 Job에 못 들어간다"가 아니라 **"그래도 우리 Job을 벗어나지 못한다"** 다 —
  한도가 합집합이 되어 우리 종료가 여전히 닿는다. 테스트가 그 성질을 지킨다.
- **stdio는 `Null`과 `Piped` 둘이다.** 인자만으로 돌고 출력을 아무도 읽지 않는 provider는 `Null`,
  가드 프로토콜처럼 **요청을 stdin으로 넣고 답을 stdout으로 받는** provider는 `Piped`다.
  ⚠️ **파이프는 소유자 쪽 끝의 상속을 반드시 끈다**(`SetHandleInformation(…, HANDLE_FLAG_INHERIT, 0)`).
  `CreatePipe`는 상속 속성을 주면 **양쪽 끝을 다 상속 가능하게** 만들고, 소유자 끝을 그대로 두면
  자식이 쓰기 끝 사본을 물고 있어 **자식이 끝나도 EOF가 오지 않는다**. 같은 이유로 spawn 직후
  자식 쪽 끝 사본을 닫는다(`release_child_ends`).
- **읽기는 `PeekNamedPipe`로 먼저 본다.** 빈 파이프에 `ReadFile`을 걸면 writer를 기다리므로,
  할 말이 없는 provider가 소유자를 멈춰 세운다. `ERROR_BROKEN_PIPE`(109)는 provider가 끝난 **정상
  종료**이고 오류가 아니다. `close_stdin()`은 「요청은 여기까지」를 EOF로 말하는 방법이다.
- **PID 하나는 신원이 아니다 — 레지스트리가 생성 시각을 함께 저장한다.**
  `src-tauri/src/windows_job_registry.rs`가 `{launchId, pid, createdAt}`를 임시 파일 + rename으로
  남긴다(반쯤 쓰인 레지스트리는 살아 있는 provider를 잃는다). 판정은 **세 값**이다 —
  `Ours`(같은 생성 시각) / `Gone`(pid가 없거나 생성 시각이 다름 → 버려도 안전) /
  **`Unknown`(존재하지만 신원 확인 불가 → 아무것도 하지 않는다)**. `Unknown`은 판단 실패가 아니라
  판단이다: 남의 프로세스를 죽이거나 살아 있는 provider의 staging을 회수하는 쪽이 더 나쁘다.
  `OpenProcess` 실패는 **87(없음)만** 부재로 읽고 **5(접근 거부)는 존재**로 읽는다.
  `createdAt`이 0인 행, pid ≤ 4(커널), 모르는 schemaVersion, 중복 launchId는 **행으로 인정하지 않는다** —
  고정할 수 없는 행은 다음에 그 pid를 가진 무엇에 대한 권한으로 읽히기 때문이다.
- ⚠️ **Job Object는 수명 경계이지 보안 경계가 아니다 — 실측으로 확인했다.** kill-on-close Job 안의
  일반 무결성 프로세스가 WMI `Win32_Process.Create`를 불렀더니 `RC=0`으로 **성공**했고 그 pid의
  `IsProcessInJob`이 **false**였다(= Job 밖, 그래서 Job을 종료해도 닿지 않는다). 어떤 job limit도
  이것을 막지 못한다 — 프로세스를 만드는 주체가 우리가 아니라 `WmiPrvSE.exe`다.
- **막는 것은 `ContainedIntegrity::Low`다.** 같은 시도를 낮은 무결성(S-1-16-4096)으로 하면
  `REFUSED=CimException`으로 거절된다 — 그 프로세스는 **돌았고** verdict를 냈으므로 "실행조차 못 해서
  통과"가 아니다. 토큰은 **이 프로세스 토큰의 낮춘 사본**이라 `CreateProcessAsUserW`에
  `SeAssignPrimaryTokenPrivilege`가 필요 없다.
- ⚠️ **낮은 무결성과 staging 격리는 한 묶음이다.** 낮은 무결성 프로세스는 `(OI)(CI)Low` 라벨이 붙은
  디렉터리에는 쓰고(실측 성공) 라벨 없는 형제에는 **못 쓴다**(실측 거절). 둘 중 하나만 하면 각각
  「탈출 가능」 또는 「동작 불가」가 된다. 출하 코드는 `icacls` spawn이 아니라
  `SetNamedSecurityInfoW`로 라벨을 붙일 것(지금 테스트는 메커니즘 확인용으로 `icacls`를 쓴다).
- Job이 **닫을 수 있는** 탈출은 breakaway뿐이다 — `BREAKAWAY_OK`·`SILENT_BREAKAWAY_OK`를 설정하지
  않으면 `CREATE_BREAKAWAY_FROM_JOB`이 거절된다. 의도가 아니라 **readback**으로 검사한다.
- **작업 스케줄러도 탈출이고, 낮은 무결성이 그것도 막는다**(실측). `schtasks /create` + `/run`으로
  만든 프로세스는 Schedule 서비스의 자식이라 Job 밖이고, 낮은 무결성에서는 Job 밖에 아무것도 생기지 않았다.
- **`Shell.Application.ShellExecute`는 탈출이 아니었다 — 예상과 반대다**(실측: `IsProcessInJob` **true**).
  그 verb는 explorer에 넘기지 않고 호출 프로세스 안의 `ShellExecuteEx`가 처리하므로 자식이 Job을 물려받는다.
  ⚠️ shell 전반을 면죄하는 것은 아니다 — 권한 상승·프로토콜 핸들러처럼 **실제로 explorer를 거치는 verb**와
  DCOM 활성화는 아직 측정하지 않았다. 서비스(`sc create`)는 비관리자에게 도달 불가라 이 provider의 표면이 아니다.
- **라벨은 `label_low_integrity`가 붙인다** — `SetNamedSecurityInfoW` + `S:(ML;OICI;NW;;;LW)`,
  `icacls` spawn이 아니다. `LABEL_SECURITY_INFORMATION`만 쓰므로 소유자·그룹·DACL은 건드리지 않고,
  테스트가 **DACL 불변**과 라벨 존재를 함께 확인한다. 없는 경로는 조용히 성공하지 않고 오류다.
- ⚠️ **탈출 측정기 자체가 fail-open이면 안 된다.** 첫 판정기는 `OpenProcess`·`IsProcessInJob` 실패를
  조용히 「Job 안」으로 셌고 **프로세스를 분명히 만든 시도에 탈출 0을 보고했다.** 지금은
  escaped / contained / **unknown** 세 값이고 unknown이면 테스트가 실패한다. 마커는 **실행된 프로세스의
  명령줄에만** 있어야 한다 — 파일 이름(→ `schtasks`의 명령줄)이나 열거 쿼리 인자(→ 그 PowerShell의 명령줄)에
  넣으면 즉시 끝나는 쪽이 잡혀 `error 87`이 된다(세 번 그렇게 틀렸다). 그래서 마커는 숫자이고
  `ping -w <marker>`로 들어가며, 열거는 마커를 **환경변수로** 받는다.
- ⚠️ **완화 테스트에는 대조군이 있어야 한다.** 일반 무결성에서 탈출이 재현되지 않으면 「낮은 무결성이
  막았다」는 반증 불가능하다. WMI·작업 스케줄러 쌍에는 대조군이 있고, shell은 대조군이 「탈출 아님」으로
  나왔기 때문에 그 사실을 단정하는 테스트로 바꿨다.
- **explorer 브로커도 탈출이고, 낮은 무결성이 막는다**(실측). `ShellWindows` DCOM(`9BA05972-…`)으로
  **실행 중인 explorer**에게 실행을 시키면 explorer의 자식이 되어 Job 밖이다 — 앞의 in-process verb와
  다른 경로다. 낮은 무결성에서는 Job 밖에 아무것도 생기지 않았다. explorer 창이 없으면 `Item()`이
  null이라 측정 불가이고, 그때는 **「측정 안 됨」으로 보고**하고 봉쇄로 주장하지 않는다.
- **Codex는 낮은 무결성에서 동작한다**(실측: 실제 `codex.exe --version` → `codex-cli 0.146.0`).
  `CODEX_HOME`은 **staging으로 돌린다 — `~/.codex`를 relabel하지 않는다.** 그러면 낮은 무결성
  provider가 사용자의 `auth.json`과 「내가 한 말」이 읽는 rollout 기록에 **쓰기** 권한을 갖는다.
  대신 state machine 그대로 per-launch staging에 쓰고 끝난 뒤 소유자(일반 무결성, 읽기 가능)가 거둔다.
- ⚠️ **staging을 `%TEMP%` 아래 두지 말 것.** Codex가 그 아래에서는 PATH alias helper 생성을 거절한다
  (실측 경고: `Refusing to create helper binaries under temporary dir …`). 앱 로컬 데이터 아래로 두면
  `stderr`가 빈다. `TEMP`·`TMP`도 staging 안을 가리켜 provider의 scratch가 라벨 안에 남게 한다.
  환경은 `spawn_with`의 목록이 **provider의 전체 환경**이므로 필요한 것은 전부 넘겨야 한다
  (`SystemRoot`·`PATH`가 없으면 콘솔 프로그램이 제대로 돌지 않아 봉쇄 측정 자체가 무의미해진다).
- **staging과 거두기는 `src-tauri/src/windows_staging.rs`다.** 한 실행당 `<LOCALAPPDATA>/agent-runtime-staging/<launchId>/`
  아래 `codex-home`·`scratch`를 만들고 라벨을 붙인다(라벨은 provider가 그 안에 만드는 것에 상속된다).
  이미 있는 launchId는 **조용히 재사용하지 않고 거절한다** — 남아 있는 서브트리는 다른 실행의 것이다.
- ⚠️ **거두는 것은 rollout뿐이고, staging 내용은 신뢰할 수 없는 입력이다.** 낮은 무결성 provider가 쓴
  파일이므로 이름을 **믿지 않고 맞춘다**: `sessions/YYYY/MM/DD/rollout-*.jsonl` 모양만, 경로는
  평범한 이름만(`..`·루트·드라이브·`\\?\\`는 **정규화하지 않고 거절** — 고쳐야 했던 경로는 출처를
  모르는 경로다), 심링크는 **따라가지 않고 거절**(provider가 심은 링크로 아무 곳이나 읽거나 쓰게 만들 수 있다),
  크기 상한, 그리고 **이미 있는 파일은 절대 덮지 않는다**(목적지는 사용자의 실제 기록이다).
- **`auth.json`은 거부 목록에도 안 나온다 — 아예 열거되지 않는다.** 순회가 `sessions`에서 시작하므로
  그 밖은 열지도, 나열하지도, 보고하지도 않는다. 거부보다 강하다: provider가 통제하는 비밀을 **읽지 않는다.**
- rollout만 거두는 이유는 그것만 살아남아야 하기 때문이다 — 「내가 한 말」과 Codex 「다시 시작」이 둘 다
  `sessions/…/rollout-*.jsonl`을 읽고, Windows에는 살아 있는 스레드를 알려 줄 lsof가 없어 **그것 말고 근거가 없다.**
- **배선은 끝났고, 기본은 꺼져 있다.** 켜는 것은 마커 파일 하나다:
  `%APPDATA%\com.portmanager.portmanager\agent-runtime\agent-runtime-windows.enabled`
  (판정은 `src/windowsAgentRuntimeGate.ts`의 `windowsAgentRuntimeEnabled` 한 곳).
  ⚠️ **없으면 `resolveAgentRuntimeGuardCommand`가 예전과 똑같이 `null`이다** — 업그레이드만으로는
  아무것도 바뀌지 않는다. 봉쇄는 측정됐지만 provider를 사용자 기기에 풀어 놓는 것은 사용자의 결정이다.
  마커를 **환경변수로 두지 말 것**: 부모 프로세스나 셸 프로필이 아무도 결정하지 않은 채 켤 수 있다.
  바이너리가 깔려 있는 것과 기능이 켜진 것은 **의도적으로 별개**다.
- **가드는 다시 쓰지 않았다 — 네 지점만 치환했다.** `agent-runtime-process-guard.ts`가 프로토콜·예약 활성화·
  Codex 신원 검증·env allowlist·중립 cwd·부모 감시를 그대로 하고, 빠진 **봉쇄만** 런처
  `agentstoz-windows-contain`이 맡는다(`src-tauri/src/bin/`).

  | POSIX | Windows |
  |---|---|
  | 무조건 `win32 → fail` | **런처가 없을 때만** 거부 — 바이너리가 없다고 갇히지 않은 provider를 돌리지 않는다 |
  | `workspaceCwd.startsWith('/')` | `isAbsoluteProviderCwd`. UNC는 인정, `C:work`는 거부(드라이브별 현재 디렉터리에 의존) |
  | `process.kill(-pid, 0)` 그룹 증명 | 런처의 `IsProcessInJob` — 실패하면 **실행을 실패시킨다** |
  | `/usr/bin/env -i` | 런처가 환경 블록을 **명시적으로 구성**(상속 후 필터가 아니다) |
  | `process.kill(-pid, SIG)` | 런처 종료 → kill-on-close가 트리를 내림. `taskkill /T`가 양쪽에서 닿는다 |

- ⚠️ **런처는 자기 소유자(가드)의 pid를 감시한다.** Windows는 부모가 죽어도 자식을 죽이지 않으므로,
  강제 종료된 가드는 job을 쥔 런처를 고아로 남기고 **provider가 봉쇄가 막으려는 바로 그 사건을 살아남는다.**
  실측: 소유자 종료 → 런처 사라짐 → provider 0개 → exit **204**.
- ⚠️ **레지스트리가 Windows에서 기록을 영구히 못 풀고 있었다.** `processGroupDefinitelyAbsent`의
  `process.kill(-pgid, 0)`이 ESRCH가 아닌 오류를 던져 모든 행이 「확실히 부재 아님」으로 읽혔고,
  stale-lease 복구가 영원히 막혔다. Windows에서는 **가드의 부재가 곧 그룹의 부재**다 — 런처가
  kill-on-close job을 쥐고 가드를 지켜보다 함께 죽기 때문이다.
- ⚠️ **빌드 순환이 하나 있다.** `tauri.conf.json`이 런처를 번들 리소스로 올리는데 Tauri 빌드 스크립트는
  리소스 glob이 **비면 실패**하고, 그 바이너리는 그 스크립트를 돌리는 cargo가 만든다. 빈 자리표시자로
  끊고 실제 바이너리로 덮되 **실패하면 지운다** — 0바이트 「런처」가 번들에 들어가 spawn되면 안 된다.
  런처는 **release**로 빌드한다(측정한 것이 release다).
- ⚠️ **런처를 찾는 판정은 두 프로세스가 묻는다 — 사이드카와 가드.** 사이드카는 가드 명령이 해석되는지를
  정할 때, 가드는 **자기 프로세스에서** provider를 무엇을 통해 띄울지 정할 때 묻는다. 그래서
  `PACKAGED_NEIGHBOUR_NAME_RE`가 사이드카와 가드 **둘 다**를 받는다. 사이드카 이름만 받던 동안
  가드(`agentstoz-agent-runtime-guard.exe`)는 런처를 **절대 못 찾고**, 마커와 런처가 다 있어도 모든
  Windows 실행을 거부했다. 셋이 같은 resources 폴더에 함께 깔리므로 어느 이웃이든 같은 증거다.
- **전 경로를 실제 바이너리로 돌려 확인했다**(설치본 없이, 실제 가드 + 실제 프로토콜 + 실제 예약):
  provider가 **등록된 workspace**를 cwd로 받고, `CODEX_HOME`이 그 실행의 staging을 가리키고,
  가드의 stdin이 provider에 닿아 되돌아왔다. 끝난 뒤 staging·런처·가드 프로세스 모두 남지 않았다.
- ⚠️ **Codex 경로는 봉쇄와 별개로 아직 닫혀 있다 — 실행 파일 신원 때문이다.**
  `isCodexRuntimeExecutableIdentityForPlatform`이 darwin·linux 외에는 **무조건 `false`** 였고,
  사이드카와 가드 **양쪽**이 그 판정을 쓰므로 봉쇄가 완벽해도 Codex는 거부됐다. 문서의 Windows 기준선
  마지막 항목(「Windows Codex PE/package/hash/version과 가능한 Authenticode identity 검증」)이 바로 이것이다.
  **Claude Remote 경로는 신원을 요구하지 않으므로** 지금 봉쇄만으로 동작한다 — 둘을 같이 말하지 말 것.
- **정책은 들어갔다**(`src/codexRuntimeExecutable.ts`): win32 신원은 `{platform:'win32', publisher}`를
  갖고 `CODEX_RUNTIME_WINDOWS_PUBLISHER = 'OpenAI OpCo, LLC'`에 고정된다(실측: `codex-cli 0.146.0`,
  `Get-AuthenticodeSignature` **Valid**, CN이 그 값). ⚠️ **Authenticode는 선택이 아니라 필수다** —
  Windows에는 실행 비트도 공증도 없어서 서명자만이 진짜 바이너리를 같은 이름의 다른 파일과 구분한다.
  Linux의 「해시·버전이 곧 신원」은 **이식되지 않는다**(거기선 적어도 실행 가능해야 했다).
  지문(thumbprint)이 아니라 **CN**에 고정한다(인증서는 교체된다). ⚠️ `OpenAI, Inc.`는 winget 메타데이터의
  값이고 그걸로 고정했다가 진짜 바이너리를 거부한 적이 있다.
- ⚠️ **`stat.mode & 0o111` 검사가 Windows 파일을 전부 거부했다**(실측 모드 **666** — 이 세션에서
  `memorySaveProvider`에서 이미 만난 결함과 같은 부류다). 면제는 **win32 서명 여부에 묶는다** —
  이 검증기는 플랫폼 인자를 받지 않는 **이식 가능** 검증기이고, 모드 666인데 서명이 없다고 주장하는
  신원은 여전히 거부된다. 실행 가능성 대신 서는 것이 Authenticode다.
- ⚠️ **revision 공식은 darwin·linux에서 바이트 단위로 그대로다.** revision은 캐시·프로필 키라
  공식이 바뀌면 macOS 항목이 전부 churn한다. publisher는 **win32일 때만** 덧붙는다. 테스트가 옛 공식을
  재구현해 동일함을 단정한다.
- 남은 것은 **리졸버**다: Authenticode 서명자를 읽고 Windows 설치 레이아웃을 걷는 부분. 그때까지
  `resolveCodexRuntimeExecutable`은 win32에서 `CODEX_RUNTIME_EXECUTABLE_UNSUPPORTED_PLATFORM`을 던지므로
  **어떤 win32 신원도 생산될 수 없다** — 정책을 먼저 올바르게 두고 생산을 나중에 여는 안전한 순서이고,
  테스트가 그 상태를 단정해 「동작하는 경로」로 오해되지 않게 한다. 그 뒤에 설치본에서 실제 Codex 세션
  한 번이 남는다(지금까지의 전 경로 확인은 가짜 provider `.cmd`로 했다).
- ⚠️ `tests/codex-runtime-executable.test.ts`의 4건은 Windows에서 POSIX 전제로 실패한다(npm 레이아웃·셸
  shim·프로세스 그룹·해석 안 되는 픽스처 경로). **제 변경 전후가 동일함을 확인하고** 이유를 적어 skip으로
  바꿨다 — Windows Codex 설치본에는 npm 레이아웃이 없다(실측: 358MB standalone native 하나).
- 검증: `cargo test windows_job`·`windows_staging` 34건 + `tests/windows-agent-runtime-gate.test.ts` 7건 — 생성 시점 소속·증명된 종료, 자손 봉쇄, Job 닫기로 트리 종료,
  실패한 spawn이 Job을 남기지 않음, 중첩 Job 탈출 불가, 재사용된 pid 거부, 파이프로 대화·EOF,
  `Null`은 빈 응답, **WMI 탈출 실증**·**낮은 무결성이 막음**, **작업 스케줄러 탈출 실증**·**낮은 무결성이 막음**,
  **shell(in-process)은 Job 안에 머묾**, **explorer 브로커 탈출 실증**·**낮은 무결성이 막음**,
  **실제 Codex가 낮은 무결성 + staged home에서 동작**, **라벨 디렉터리만 쓰기 가능**, 라벨이 DACL을 바꾸지 않음·없는 경로 거부,
  breakaway 불허 readback, 레지스트리 왕복·고정 불가 행 거부·살아 있는 행 인식·끝난 행 폐기 가능·
  생성 시각 없는 행 fail-closed·커널 pid 거부, **상속된 표준 핸들로 실행**,
  staging 라벨·재사용 거절·잘못된 id 거절, rollout만 거두기·덮어쓰기 거절·크기 초과 거절·
  rollout 모양 판정·트리를 벗어나는 경로 거절, **생성 시각은 생존이 아님**(종료된 pid가 같은 생성 시각을
  계속 보고하는 함정을 재현한다), 마커 없이는 꺼짐·마커와 같은 이름의 **디렉터리는 동의가 아님**·
  런처는 패키징된 사이드카 옆에서만·staging launch id는 받지 않고 **만든다**·플랫폼별 절대경로 판정.

## Codex 「다시 시작」 — Windows는 rollout으로만 잇는다

Mac은 **실행 중인 프로세스 그룹이 잡은 `thread-writer-locks/<id>.lock`** 으로 대화를 정확히 안다
(`lsof -Fn -g <pgid>`). Windows에는 프로세스 그룹도 lsof도 없어서 `processGroupOpenFiles`가
**win32에서 빈 배열을 돌려주고**, 해석은 **rollout(cwd + 시간 창) 일치**로 떨어진다 — Mac이 이미
끝난 세션에 쓰는 바로 그 증거이고, 「후보가 정확히 하나일 때만 잇는다」는 규칙도 그대로다.

- ⚠️ **잠금 파일로 알아내려 하지 말 것 — 재봤고 얻을 게 없다.** 실행 중인 Codex가 composer까지
  떠 있어도 `thread-writer-locks/`에 **새 파일이 생기지 않는다**(2026-10-04 실측: 시작·hooks 프롬프트·
  composer 세 시점 모두 변화 없음). 잠금은 **첫 메시지를 보낸 뒤에** 생기고, 그때는 rollout도 이미
  있다. 게다가 Rust의 파일 잠금은 `LockFileEx`(바이트 범위)라 파일이 **열리기는 한다** — 감지하려면
  FFI로 진짜 HANDLE이 필요한데 Bun의 fd는 CRT fd가 아니다(`_get_osfhandle`이 INVALID_HANDLE_VALUE를
  돌려준다, 실측). 잠금 파일은 **0바이트**라 PID도 없고, `session_index.jsonl`에도 cwd·pid가 없다.
- **갈리는 것은 정밀도 하나뿐이다.** 같은 폴더에서 같은 시간 창에 Codex 세션이 **둘 이상**이면
  Windows는 모호하다고 보고 **새 대화로 시작한다**(Mac은 lsof로 정확히 고른다). 추측보다 새로
  시작하는 쪽이 낫다는 기존 규칙과 같다.
- ⚠️ **`codexThreadFromOpenFiles`는 구분자·대소문자를 정규화한다.** `lsof`는 POSIX 경로를 주고
  `join(codexHome, …)`은 Windows에서 백슬래시를 주므로, 예전의 `join(...) + '/'` 접두사는 그쪽에서
  **절대 일치할 수 없었다.** id는 원본 문자열에서 잘라 내므로 소문자 UUID 검사는 그대로 유효하다.
  (이 결함 때문에 그 테스트 2건이 Windows에서 실패했고, 고친 뒤 **건너뛰지 않고 실제로 돈다.**)
- Claude 쪽은 자기 전사 파일을 읽으므로 양 플랫폼에서 같다. Hermes·agy는 늘 새 대화다.
- 검증: `tests/ai-terminal-resume.test.ts`(Windows rollout 경로·구분자/대소문자 행렬),
  `tests/windows-workroom-session.test.ts`(실제 서비스로 restart = start + `resumeFrom`).

## 워크룸 PTY — Windows는 node-pty(ConPTY)를 디스크에서 읽는다

Windows 워크룸은 **동작한다.** 예전에 `AI_TERMINAL_WINDOWS_UNSUPPORTED`로 거부했던 자리는 이제
**런타임이 설치에서 빠졌을 때만** 거부한다. 판정은 `aiTerminalWindowsStartBlocked` 한 곳이고
(platform·주입된 spawn·런타임 유무), **주입된 spawn이 이긴다** — 안 그러면 가짜 자식으로 도는
기존 테스트가 Windows에서 전부 거부로 바뀐다.

- ⚠️ **Bun에는 Windows PTY가 없다.** `Bun.spawn({terminal})`이 `terminal option is not supported
  on this platform`으로 던진다(1.3.12 실측). 그래서 win32만 `spawnWindowsPty`(`src/windowsPty.ts`)를
  쓰고 macOS·Linux는 예전 그대로 `Bun.spawn`이다. 두 경로가 같은 `Child` 모양
  (`{pid, terminal:{write,resize,close}, exited, kill}`)을 낸다.
- ⚠️ **`bun:ffi`로 ConPTY를 직접 몰려고 하지 말 것 — 이미 해봤고 막혔다.** HPCON 생성·
  `ResizePseudoConsole`·속성 리스트 소비(잘못된 HANDLE_LIST에 `CreateProcessW`가
  ERROR_INVALID_PARAMETER로 실패)까지 다 되는데 **자식이 pseudoconsole에 붙지 않는다.** 7가지
  변형(핸들 상속 on/off, JS 메모리 vs VirtualAlloc, FreeConsole 선행, 우리 핸들 사본 닫기/유지,
  HPCON 값/포인터)이 전부 같은 결과였고 원인은 **미해결**이다. 파이프로는 conhost의 초기 시퀀스
  16바이트(`ESC[?9001h ESC[?1004h`)만 오고 EOF도 아니다.
- ⚠️ **node-pty의 입력 소켓은 Bun에서 죽어 있다.** `fs.openSync(conin)`은 **성공**하고(다른
  프로세스에는 EBUSY로 보여 살아 있는 핸들임이 증명된다) 그 fd를 `net.Socket({fd})`로 감싸는
  부분이 깨진다 — `writable: true`라고 보고하면서 쓰면 `ERR_SOCKET_CLOSED`. 출력·resize·종료는
  정상이다. 그래서 입력은 소켓을 우회해 **그 fd에 `fs.writeSync`** 로 쓰고, 그러려면 spawn 중의
  `openSync` 한 번을 관찰해야 한다(`isConinPipePath`). 파이프 이름은 `conpty-<고해상도 id>-in`으로
  node-pty가 노출하는 어떤 값으로도 **재구성할 수 없다**(`agent._pty`는 1이었다) — 그래서 매칭한다.
  관찰은 spawn 호출 직전/직후로 좁히고 `finally`에서 되돌린다.
- ⚠️ **패치 대상은 node-pty 자신의 `require('fs')` 객체다.** ESM `node:fs` 네임스페이스는 Bun에서
  읽기 전용이라 대입이 던지고, 다른 루트의 `createRequire`로 얻은 `fs`를 패치하면 무효다(둘 다 실측).
- ⚠️ **컴파일 단일 파일에 `.node`는 들어가지 않는다.** `bun build --compile`은 node-pty의 JS는
  번들하고 런타임에 `Cannot find module './prebuilds/win32-x64//conpty.node'`로 죽는다 — 애드온을
  자기 모듈 기준 상대경로로 찾는데 컴파일된 모듈은 가상 경로에 있다. 그래서 node-pty는 **사이드카
  옆 `pty-runtime/`에서 디스크로 읽는다**(`build-sidecar.ts`의 `stageWindowsPtyRuntime`,
  `tauri.conf.json`의 `resources/pty-runtime/`). 소스 실행은 `node_modules`로 폴백한다.
- **배포에 Microsoft 재배포 파일은 없다.** 실측 세션이 `_useConptyDll: false`였다 — **OS의 ConPTY**를
  쓴다. 애드온 3개(`conpty.node`·`conpty_console_list.node`·`pty.node`) + node-pty `lib`만 깔아도
  전체 왕복이 통과했다(**985KB**. `conpty/OpenConsole.exe`·`conpty.dll`·winpty를 넣으면 2.5MB이고
  서명 대상에 써드파티 실행 파일이 하나 늘어난다). `.pdb`는 패키지 30MB 중 28MB이고 **절대 안 싣는다.**
- **종료는 `taskkill /T`다.** POSIX 경로의 `process.kill(-pid)`은 Windows에 없는 개념이라 던지고
  CLI의 자식들이 살아남는다. `stopGroup`이 win32에서 `windowsSignalTree`로 갈라지고,
  SIGTERM→`/T`, SIGKILL→`/F /T`로 호출자의 단계적 escalation을 보존한다.
- **실행 파일 해석은 `resolveAgentBin`을 쓴다.** `where claude`는 **확장자 없는 npm 셸 스크립트를
  먼저** 돌려주고 PTY는 그것을 실행할 수 없다(error 193). `resolveAgentBin`은 패키지 안의 실제
  `.exe`를 알고 `.cmd`/확장자 없는 셰임을 풀어 준다. 못 찾으면 **이름 그대로**를 돌려주는데,
  서비스의 `!isAbsolute(executable)` 가드가 그걸 「CLI가 설치되어 있지 않습니다」로 바꾼다.
- 정상 종료 뒤에는 node-pty의 `kill()`을 **부르지 않는다** — 이미 죽은 프로세스에 대해 콘솔 프로세스
  목록을 조회하며 stderr에 `AttachConsole failed`를 남기고, 그것이 세션을 닫을 때마다 사이드카
  로그에 쌓인다. 강제 종료 경로에서는 정리 정확성을 위해 여전히 부른다(그때 한 줄 남는다).
- ⚠️ **POSIX 셸 가짜 CLI를 쓰는 워크룸 테스트는 Windows에서 skip이다**(`ptyTest`/`ptyDescribe`,
  `tests/ai-terminal*.test.ts`). `#!/bin/sh` + `stty`·`read`·`/dev/zero`는 Windows가 실행조차 못 해
  (error 193) 48건이 전부 빨간 실패로 남아 진짜 회귀를 가렸다. Windows 쪽 실증은
  `tests/windows-pty.test.ts`(실제 ConPTY: 출력·입력 에코·resize·종료 코드·트리 종료)와
  `tests/windows-workroom-session.test.ts`(`.cmd` 가짜 CLI로 **서비스 전체**: 등록된 cwd에서 시작·
  입력·resize 반영·종료·close)가 맡는다. 새 워크룸 테스트를 만들면 어느 쪽인지 정할 것.
