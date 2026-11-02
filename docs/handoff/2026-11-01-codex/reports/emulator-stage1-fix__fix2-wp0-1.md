# emulator-stage1-fix · fix2:wp0-1

(agent final report, verbatim)

English translation: Isn't the point that once it's connected, you can keep using it comfortably?

이 브랜치는 그 연결 경험을 바꾸지 않습니다. 시험 하네스의 안전장치만 고칩니다. 남아 있던 지적 2건을 고쳐 `emu/wp0-1`에 커밋했고(**3aedb14a**), 테스트와 등록 루트 밖 복사본에서 실제 하네스 실행으로 둘 다 확인했습니다.

**1. 실패한 레인이 「조건 미충족」으로 바뀌던 결함 (#6 수정이 만든 것)**
- **원인:** `runHarness`가 `'reasons' in result`로 결과를 갈랐고, `normalizeOutcome`이 레인이 돌려준 키를 그대로 남겼습니다. 그래서 `reasons` 키를 실은 실패 레인이 조건 미충족으로 분류됐습니다.
- **수정:**
  - `runOneLane`이 이제 태그가 붙은 `LaneRun`(`ran` 또는 `condition-unmet`)을 돌려주고, 새 `runLanes`가 그 태그로만 가릅니다(`scripts/emulator-e2e.ts`).
  - `normalizeOutcome`은 이제 `LaneOutcome`의 키만 남기고, 모양이 틀린 선택 키는 버립니다(`scripts/emulator-e2e/evidence.ts`). 그래서 레인이 `id`나 `title`을 바꾸거나 조건 미충족인 척할 수도 없습니다.

**2. LAN 호스트의 en0 바인딩을 하네스가 강제하지 않던 결함 (#9 일부만 고쳐졌던 것)**
- **바뀐 점:** 이제 레인이 따로 부르지 않아도 하네스가 직접 막습니다. `scripts/emulator-e2e/sandbox.ts`, `isolatedSidecar.ts`, `emulator-e2e.ts`를 고쳤습니다.
  - **가드를 켜는 시점:** `ctx.sandboxProfile({lanInbound})`나 `ctx.startSidecar`를 부르면 레인마다 새로 여는 `LaneHosts`가 그 포트의 LAN 바인딩 가드를 켭니다. 기준 주소는 preflight가 잰 `capabilities.en0PrivateIpv4`이고, 이 값이 없으면 거절합니다.
  - **감시:** 가드는 그 포트의 TCP 리스너를 이 Mac 전체에서 500ms마다 lsof로 봅니다. loopback이나 `<en0>:<포트>`가 아닌 리스너를 보면 위반으로 기록하고, 그 리스너가 하네스의 자손 프로세스면 SIGKILL로 멈춥니다. 그 포트의 LAN 사이드카도 함께 멈춥니다. lsof로 관측하지 못해도 위반으로 칩니다.
  - **시작 시점 확인:** `startSidecar`가 health 확인 직후에 한 번 더 보고, 띄우는 동안 생긴 위반까지 있으면 사이드카를 멈추고 시작을 거절합니다.
  - **가드 없는 실행 차단:** `sandboxedArgv`는 LAN inbound를 여는 프로필을 가드가 그 포트를 지켜볼 때만 띄웁니다. 모든 포트를 여는 inbound 프로필은 아예 띄우지 않습니다.
  - **레인 판정:** 레인이 끝나면 하네스가 마지막으로 한 번 보고, 남은 사이드카와 가드를 정리합니다. 위반이 하나라도 있으면 레인이 무엇을 돌려줬든 실패입니다.
- **남는 한계:**
  - 감시 간격(약 0.5초) 동안은 en0 밖 리스너가 열려 있을 수 있습니다. 대신 lsof 비용은 감시 한 번에 CPU 약 40ms입니다.
  - TCP LISTEN 소켓만 봅니다. UDP는 보지 않습니다.
  - 하네스의 자손이 아닌 위반 리스너는 기록만 하고 신호를 보내지 않습니다.
  - 실제 en0에서 원격 제어를 켜는 경로는 돌려 보지 않았습니다. 그건 j1-lan 레인 몫입니다.

**실행한 검사**
- 이 워크트리에서 `bun install --frozen-lockfile`(검사 뒤 node_modules는 지웠습니다):
  - `bun run typecheck` → exit 0
  - `bun test ./tests/emulator-sandbox.test.ts ./tests/emulator-e2e-guards.test.ts` → 61 pass, 0 fail (전에는 49개)
  - `bun test ./tests/perf-baseline.test.ts` → 10 pass
- 새로 더한 회귀 테스트 12건:
  - 레인 분류 4건: `reasons`를 실은 실패가 `all`에서 exit 1, 키 걸러내기, 이름 바꾸기 시도, 가드 위반이 레인 판정을 덮어쓰는지
  - 가드 단위 4건
  - 실제 sandbox-exec와 lsof로 4건:
    - 하네스의 자손 프로세스에만 신호를 보낸다
    - LAN 포트를 `fe80::1%lo0`(이 Mac 밖에서는 닿지 않음)에 연 리스너는 SIGKILL되고, 127.0.0.1에 연 리스너는 위반이 아니다
    - 실제 사이드카도 시작 시점 확인에서 거절된다
    - 통과를 주장한 레인도 사이드카가 멈추고 실패가 된다
- 복사본 `/Users/cs-work/agentstoz-emulator/fix-wp01-3aedb14a/wt`(git archive 3aedb14a와 실제 bun install)에서 하네스를 그대로 돌렸습니다. 세 번 모두 preflight pass, 시뮬레이터 비교 unchanged였습니다.

| 실행 | 내용 | 결과 |
|---|---|---|
| `all` | 재점검 재현 그대로: j1-lan 통과, j2가 `{status:'fail', reason, reasons:[…]}`를 돌려줌 | j2 fail, summary fail 1, exit 1, 조건 미충족 0건 |
| `j1-lan` (위반) | LAN 사이드카를 띄운 뒤 그 포트를 en0 밖에 열고, 레인은 pass를 주장 | 레인 fail("lane reported pass"), exit 1. 위반 리스너를 연 뒤 633ms 안에 사이드카와 위반 프로세스가 모두 SIGKILL됨 |
| `j1-lan` (정상) | 같은 LAN 사이드카, 위반 없음 | pass, exit 0. 가드가 2초 이상 지켜보는 동안 위반 0건 |

실행이 끝난 뒤 남은 프로세스, 리스너, 스크래치는 없었습니다. 복사본과 드라이버 스크립트는 지웠습니다. 3001·52741·4723, 설치된 앱, 운영 Supabase에는 연결하지 않았고, 키체인·TCC도 건드리지 않았습니다. 시험은 en0이나 `*`에 바인딩한 적이 없습니다.

**알아 둘 점:** `emu/wp0-1`이 다른 워크트리 두 곳(`.claude/worktrees/wf_35f16659-79d-1`, `.claude/worktrees/wf_d5beb4e7-552-1`)에 이미 체크아웃돼 있어서 `git checkout --ignore-other-worktrees`로 받았습니다. 브랜치가 3aedb14a로 움직였으니 그 두 워크트리에서는 작업 트리가 낡아 보입니다.
