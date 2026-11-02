# emulator-stage1-fix · fix:wp0-1

(agent final report, verbatim)

English translation: Isn't the idea that once it's connected, you can keep using it comfortably without reconnecting?

WP0+WP1 리뷰 결과 보고 (브랜치 emu/wp0-1, 워크트리 /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-1)

질문하신 "한 번 연결하면 계속 편하게 쓰는 것"에 대해: 이 브랜치는 그 부분을 바꾸지 않습니다. 시험 하네스의 안전장치만 다룹니다. 지적 9건 가운데 8건을 고쳤고 #9는 일부만 고쳤습니다. 거절한 지적은 없습니다. 검증 중에 새 결함을 하나 더 찾아 고쳤습니다. 커밋 전 모든 검사가 통과했습니다.

**커밋**
- `daeca98e` fix(emulator-e2e): address the WP0+WP1 review findings
- `5c8d645d` fix(emulator-e2e): keep the loopback allowlist as the last outbound rule

emu/wp0-1이 이미 빌더 워크트리(wf_d5beb4e7-552-1)에 체크아웃돼 있어서 `git checkout --ignore-other-worktrees emu/wp0-1`로 가져왔습니다. 그래서 그 워크트리의 HEAD도 이 두 커밋으로 함께 옮겨졌습니다.

**지적별 처리** (회귀 테스트는 모두 `tests/emulator-e2e-guards.test.ts` 또는 `tests/emulator-sandbox.test.ts`에 있습니다)

1. **고침.** 동시 실행 검사(`ownProcessTree`)가 이제 「조상 사슬 + 이 프로세스의 자손」만 자기 것으로 봅니다. 같은 Orca·tmux·워크룸 아래의 형제·사촌 프로세스는 다른 실행으로 잡힙니다. 회귀 테스트: 형제·사촌 프로세스 트리.
2. **고침.** loopback 바깥 연결을 허용 목록 방식으로 바꿨습니다. `*:*`를 먼저 막고, 이 실행이 가진 포트만 엽니다(사이드카는 자기 포트를 더함). 카나리에 `foreign-listener`(남의 loopback 리스너)를 추가했습니다. 회귀 테스트: 생성기 테스트와 실제 curl 테스트(허용 포트 1회 도달, 거부·남의 포트 0회).
3. **고침.** 시뮬레이터 잠금을 커널 flock으로 바꿨습니다(`/usr/bin/lockf`가 잠금을 쥔 채 오케스트레이터의 stdin을 읽음). 오케스트레이터가 죽으면 커널이 잠금을 풀기 때문에, 죽은 보유자를 회수하는 경쟁이 생기지 않습니다. 회귀 테스트: 직렬화, 남은 파일은 잠금이 아님, SIGKILL된 보유자, 자식 프로세스 4개 동시 실행.
4. **고침.** 프로필을 쓰기 허용 루트 밖인 `runBase/sandbox`에 둡니다. `writeSandboxProfile`은 쓰기 루트 안에 쓰려 하면 거절하고, `sandboxedArgv`는 실행 직전에 해시를 다시 잽니다. 카나리에 `profile-write`를 추가했습니다. 회귀 테스트: 변조된 프로필 거절.
5. **고침.** 하네스가 도는 동안 `'unsandboxed-perf-measurement'` 모드는 거절됩니다. 레인은 `LaneContext`에서 샌드박스에 묶인 런처만 받습니다. 회귀 테스트: 실행 중 거절 + 소스 정적 검사.
6. **고침.** `all`은 조건이 충족된 조건부 레인만 돌립니다. 충족되지 않은 레인은 종료 코드에 넣지 않고 `conditionUnmet`에 기록합니다. 조건부 레인은 `preconditions()`를 반드시 선언해야 합니다. 회귀 테스트: 레인 계획 테스트.
7. **고침.** 사이드카 테스트는 같은 실행에서 카나리와 `static-exec-deny`가 같은 프로필 해시로 통과했을 때만 돕니다.
8. **고침.** perf 전용 환경 빌더 `buildPerfMeasurementEnv`를 만들었습니다. 상속 PATH를 쓰고 NODE_ENV·PORT는 넣지 않으며, 관리 origin은 `http://localhost:9000`입니다. 회귀 테스트: 환경 키와 origin. 실측(perf smoke): readyMs 422, health 200, 환경 키 14개, 누출 0.
9. **일부만 고침.** LAN 바인딩을 선언한 포트 하나로 좁혔습니다. 다만 en0 주소 하나로 좁히는 것은 SBPL로 할 수 없습니다. 실측상 주소에는 `*`나 `localhost`만 쓸 수 있고, 특정 IP를 넣으면 exit 65로 거절됩니다. 그래서 en0에만 바인딩됐는지는 lsof 기반 `lanListenerViolations`로 레인이 직접 확인해야 합니다.

**검증 중 찾은 결함 (`5c8d645d`)**
- 증상: 등록 루트 밖 복사본에서 preflight를 9번 돌렸더니 2번 실패했습니다. 한 번은 CA 측정이 ConnectionRefused였고, 한 번은 카나리 대조 포트에 닿지 못했습니다.
- 원인(실측): 특정 포트 허용 규칙 뒤에 다른 network-outbound 규칙이 하나라도 오면 일부 포트 번호의 허용이 사라집니다. 매번 같은 포트(53243, 53262, 60252 등)이고, curl과 Bun 모두 같았습니다. 옛 순서에서는 허용 연결 300개 중 16개가 끊겼습니다.
- 수정: 허용 목록을 마지막 outbound 규칙으로 옮겼습니다. 같은 측정(포트 400개, 허용 연결 600개)에서 끊김 0, 거부·남의 포트로 새는 것 0이었고, 샌드박스 안 bind/accept 400개도 정상이었습니다. 거부 포트는 생성할 때부터 허용 목록에 들어갈 수 없어서 순서를 바꿔도 막힘이 풀리지 않습니다.
- 회귀 테스트: 정적 순서 검사 1개와 실제 샌드박스 테스트 1개(문제 포트 + 무작위 48개). 두 테스트 모두 옛 생성기에서는 실패하는 것을 확인했습니다.

**실행한 명령과 실제 결과**
- 워크트리:
  - `bun test ./tests/emulator-sandbox.test.ts ./tests/emulator-e2e-guards.test.ts` → 49 pass, 0 fail, expect() 372개
  - `bun run typecheck` → exit 0
- 복사본 `/Users/cs-work/agentstoz-emulator/wp01-verify-20261101c/wt` (HEAD를 `git archive`로 풀고 `bun install --frozen-lockfile`로 587개 패키지 설치, 끝난 뒤 삭제):
  - 같은 테스트 → 49 pass, 0 fail
  - `bun run typecheck` → exit 0
  - `bun scripts/emulator-e2e.ts preflight` 12번 → 12번 모두 exit 0 (pass)
    - 카나리 7종 모두 막힘, 대조군 정상, 정적 검사 5개 통과
    - Bun의 CA 신뢰 측정: 12번 모두 trusted
    - 443 바인딩: 샌드박스 안팎 모두 EACCES (sudo 없이는 불가)
    - 시뮬레이터: 기기 16대, Simulator.app pid 606 그대로
  - `bun scripts/emulator-e2e.ts all` → exit 4 (skipped). 구현된 레인이 없어 9개 모두 "not implemented yet"이고, `conditionUnmet`은 비어 있습니다.
  - `bun scripts/emulator-e2e.ts j2-model` → exit 4
  - `bun scripts/emulator-e2e.ts list` → exit 0
- 워크트리 안에서 직접 돌린 preflight는 exit 3(blocked)입니다. 등록 루트 `/Users/cs-work/forcs` 안이라서 막힌 것이고, 의도된 동작입니다.

**막힌 것 / 안전**
- 127.0.0.1:443이 EACCES라서 조건부 레인 j1-relay-sim과 j4-sim은 이 Mac에서 조건이 충족되지 않습니다. sudo나 pf는 쓰지 않았습니다.
- 3001·52741·4723이나 설치 앱 포트에는 연결하지 않았습니다. 시험한 연결 상대는 모두 시험 코드가 직접 띄운 리스너입니다.
- 설치 앱, 키체인, TCC는 건드리지 않았고 perf:baseline도 돌리지 않았습니다.
- 임시 폴더와 복사본은 모두 지웠습니다.
