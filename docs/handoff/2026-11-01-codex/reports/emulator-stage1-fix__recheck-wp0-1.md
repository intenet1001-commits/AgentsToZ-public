# emulator-stage1-fix · recheck:wp0-1

(agent final report, verbatim)

English translation: Isn't the point that once it's connected, you can keep using it comfortably?

이 브랜치는 그 연결 경험을 바꾸지 않습니다. 시험 하네스의 안전장치만 다룹니다. 재점검 결과는 "all fixed"가 아닙니다. 원래 지적 9건 중 8건은 코드상 고쳐졌지만 #9는 일부만 고쳐졌고, #6을 고치면서 새 결함이 하나 생겼습니다.

**아직 열려 있는 것**

1. **새 결함 (#6 수정이 만든 것): 실패한 레인이 「조건 미충족」으로 바뀌어 종료 코드에서 빠짐**: `scripts/emulator-e2e.ts:328`
   - 원인: `'reasons' in result`로 조건 미충족 레인과 실제 레인 결과를 구분합니다. 그런데 `done()`(`:252`)은 `normalizeOutcome`의 결과를 그대로 펼칩니다. `normalizeOutcome`(`scripts/emulator-e2e/evidence.ts:46-53`)은 레인이 돌려준 객체의 다른 키를 지우지 않습니다. 그래서 결과에 `reasons` 배열을 실어 보낸 레인은 실패해도 조건 미충족으로 분류됩니다. 조건부가 아닌 일반(무인) 레인도 마찬가지입니다.
   - 재현(등록 루트 밖 복사본, preflight 통과): j1-lan은 통과, j2는 `{status:'fail', reason, reasons:[…]}`를 돌려주게 했습니다. 결과는 "lane j2: condition unmet", summary fail 0이었습니다. 레인이 모두 구현된 뒤라면 j2가 실패해도 exit 0이 나옵니다.
   - 고칠 방법: `runOneLane`이 `kind`가 붙은 결과를 돌려주게 합니다. 아니면 `normalizeOutcome`이 `LaneOutcome`에 있는 키만 남기게 합니다. 이 경우를 잡는 회귀 테스트도 더합니다.

2. **#9 일부만 고침: LAN 호스트가 en0에만 바인딩하는지 하네스가 강제하지 않음**: `scripts/emulator-e2e/sandbox.ts:192-196`, `:312`
   - 이제 포트 하나로 좁혀졌지만, 그 포트는 여전히 모든 인터페이스(`*:<port>`, utun·브리지 포함)에서 열립니다.
   - SBPL로 주소를 좁힐 수 없다는 것은 직접 확인했습니다. 특정 IP를 넣으면 `host must be * or localhost`, exit 65입니다.
   - 대신 쓰려던 관측 검사 `lanListenerViolations`와 `listeningSockets`는 `scripts/` 안에서 부르는 곳이 없습니다. 지금은 앞으로 만들 각 레인이 알아서 부르기로 문서에만 적혀 있습니다.
   - 고칠 방법: `lanInbound` 프로필로 호스트를 띄우면 하네스가 직접 검사하게 합니다. 예를 들어 `startSidecar`가 health 확인 뒤 `listeningSockets(child.pid)`를 `preflight.capabilities.en0PrivateIpv4`와 비교하고, 어긋나면 멈추고 실패로 처리합니다.

**고쳐진 것으로 확인한 지적**

| # | 확인한 내용 |
|---|---|
| 1 | `ownProcessTree`가 이제 「조상 사슬 + 자기 자손」만 자기 것으로 봅니다. 형제·사촌 프로세스를 다룬 회귀 테스트가 있습니다. |
| 2 | loopback outbound가 `*:*` 거부로 시작하고, 이 실행이 가진 포트만 마지막 규칙으로 엽니다. 거부 포트는 허용 목록에 넣으려 하면 생성 단계에서 거절됩니다. `foreign-listener` 카나리가 막혔습니다. |
| 3 | 잠금이 lockf 커널 flock으로 바뀌었고, 옛 「죽은 보유자 회수」 코드는 남아 있지 않습니다. 4-프로세스 동시 실행과 SIGKILL 테스트가 통과했습니다. |
| 4 | 프로필은 쓰기 허용 루트 밖인 `runBase/sandbox`에 쓰입니다. `sandboxedArgv`가 띄우기 직전에 해시를 다시 재고, `profile-write` 카나리가 막혔습니다. |
| 5 | 하네스가 도는 동안 perf 모드는 거절됩니다. `LaneContext.startSidecar`는 샌드박스에 묶여 있고, 정적 테스트가 있습니다. |
| 6 | `all`이 조건이 안 된 조건부 레인을 종료 코드에서 뺍니다. 다만 위 1번 결함이 남아 있습니다. |
| 7 | 사이드카 테스트가 같은 실행의 카나리, `static-exec-deny`, 같은 프로필 해시가 통과해야만 돕니다. |
| 8 | `buildPerfMeasurementEnv`의 키와 값이 옛 `isolatedEnv`와 같습니다. |

**실행한 검사**
- 임시 워크트리(`/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rc-wp0-1`, HEAD 5c8d645d)
  - `bun test ./tests/emulator-sandbox.test.ts ./tests/emulator-e2e-guards.test.ts` → 49 pass, 0 fail
  - `bun run typecheck` → exit 0
- 복사본(`/Users/cs-work/agentstoz-emulator/rc-wp01-1793509244/wt`, git archive + 실제 bun install)
  - preflight: pass
  - 카나리 7종 모두 막힘, 대조군 정상
  - 정적 검사 5개 통과
  - 시뮬레이터 비교: unchanged

워크트리, 복사본, 드라이버 스크립트, 실행 스크래치는 모두 지웠습니다. 3001·52741·4723, 설치된 앱, 운영 Supabase에는 연결하지 않았고, 키체인·TCC도 건드리지 않았습니다.
