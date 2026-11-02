# emulator-stage1 · build:wp0-1

(agent final report, verbatim)

English translation: WP0+WP1 of the emulator end-to-end harness (preflight, allowlisted environment, concurrency guards, mandatory sandbox, isolated sidecar launcher) were requested. These are the results.

WP0+WP1 구현을 마쳤고 커밋 1개로 남겼습니다. 이 워크트리에서 돌린 preflight는 `blocked`(exit 3)입니다. 원인은 코드가 아니라 위치입니다. 워크트리가 등록 루트 /Users/cs-work/forcs 안에 있고, 설계 §2.1대로 거절했습니다. 같은 커밋을 등록 루트 밖으로 옮겨 돌리면 `pass`(exit 0)입니다.

**브랜치·커밋**
- 브랜치: `emu/wp0-1` (main d093fa88에서 분기). push·merge는 하지 않았습니다.
- 커밋: `cd89a7dd308f5d9960cdbde40bd0733f58669dbe`. 요구한 두 줄(Co-Authored-By, Claude-Session)로 끝납니다.

**바뀐 파일** (10개, +3122 / −116)
- 오케스트레이터와 도우미:
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/scripts/emulator-e2e.ts
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/scripts/emulator-e2e/environment.ts
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/scripts/emulator-e2e/evidence.ts
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/scripts/emulator-e2e/preflight.ts
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/scripts/emulator-e2e/sandbox.ts
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/scripts/emulator-e2e/isolatedSidecar.ts
- 고친 파일: /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/scripts/perf/sidecar.ts. 이제 공용 런처를 명시적 `unsandboxed-perf-measurement` 모드로 씁니다.
- 테스트와 픽스처:
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/tests/fixtures/side-effect-guard-entry.ts (하네스 전용이고 사이드카 빌드 진입점이 아닙니다)
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/tests/emulator-e2e-guards.test.ts
  - /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/tests/emulator-sandbox.test.ts
- 다른 패키지 소유 파일은 건드리지 않았습니다.

**레인 등록 API** (뒤 패키지용)
- 레인 표 `LANE_CATALOG`/`LANE_IDS`에 10개 레인과 `all`이 있습니다.
- 등록 방법은 둘입니다: `registerLane(def)`, 또는 `LANE_MODULES['<id>'] = () => import('./emulator-e2e/<module>')`. 모듈은 `export const lane: LaneDefinition {id, preconditions?, run(ctx)}`을 내보냅니다.
- `LaneContext`가 레인에 주는 것: 샌드박스 프로필 생성기, 허용 목록 환경, toolchainEnv, 시뮬레이터 부팅 잠금, `ownSimulator`, 증거 기록기.
- 등록되지 않은 레인은 "skipped: not implemented yet"이고, preflight가 pass가 아니면 레인은 blocked입니다.
- 종료 코드: 통과 0 · 실패 1 · 사용법 2 · 막힘 3 · 건너뜀 4.

**검증** (모두 실제 실행 결과)

이 워크트리에서:
1. `bun test ./tests/emulator-e2e-guards.test.ts` → 24 pass, 0 fail, 174 expect() calls.
2. `bun test ./tests/emulator-sandbox.test.ts ./tests/emulator-e2e-guards.test.ts` → 32 pass, 0 fail, 248 expect() calls.
   - 샌드박스 테스트가 실제로 확인한 것:
     - 카나리 5개 모두 차단됐고 대조군은 모두 통과했습니다.
     - 샌드박스 안 사이드카의 /api/health가 200이었고, 포트는 예약 포트가 아니고 3001도 아닙니다.
     - 사이드카 안의 `/usr/bin/security` 실행이 거부됐고, 그 기록(spawn-error EPERM)이 남았습니다.
     - build-sidecar 진입점에 `tests/` 경로가 없습니다.
3. `bun scripts/emulator-e2e.ts preflight` → exit 3 `blocked`. 사유: "worktree … is inside the registered workspace root /Users/cs-work/forcs".
   - index.json은 기록됐습니다.
   - 카나리: exec-open, denied-port(hits=0, 대조군 hits=1), worktree-write, real-app-data-read, signal-orchestrator 모두 차단됐습니다. 3001/52741/4723 deny와 exec deny를 확인하는 정적 검사도 모두 통과했습니다.
4. `bun run typecheck` → exit 0. 다만 tsconfig의 include에 `scripts/`가 없어서, 하네스 파일 전부와 perf/sidecar.ts를 명시한 임시 tsconfig로 `tsc --noEmit -p`를 따로 돌렸고 exit 0이었습니다.
5. perf 경로 스모크(비샌드박스 측정 모드, 소스 사이드카만):
   - 준비까지 1029ms였습니다.
   - /api/ports 200, `/api/remote-control/interfaces`(POST, 관리 Origin) 200이었습니다.
   - 실제 사용자 파일을 연 기록(leaks)은 없었고, 종료 뒤 프로세스는 남지 않았습니다.
   - 설치본 사이드카는 띄우지 않았습니다.

등록 루트 밖에서 (`git archive HEAD` → /Users/cs-work/agentstoz-emulator/wp0-1-verify/wt에 풀고 실제 `bun install`, 확인 뒤 삭제):
1. `bun scripts/emulator-e2e.ts preflight` → exit 0. "preflight pass", summary: pass (pass 1 · fail 0 · blocked 0 · skipped 0).
2. `bun scripts/emulator-e2e.ts all` → exit 4. 레인 9개가 모두 "skipped — not implemented yet"이었고, 건너뜀은 통과로 세지 않았습니다.
   - 시뮬레이터 비교: unchanged (16대 → 16대, Simulator.app pid 606 그대로, 새로 만든 시뮬레이터 없음).
   - 허용 목록 환경 위반: 없음.
3. `bun test ./tests/emulator-sandbox.test.ts ./tests/emulator-e2e-guards.test.ts` → 32 pass, 0 fail.

**막혔거나 남은 것**
- **이 워크트리의 preflight는 blocked입니다.** 등록 루트 안에 있기 때문이고, 의도한 동작입니다. 레인을 돌리려면 워크트리를 /Users/cs-work/agentstoz-emulator/<runId>/wt 아래에 두어야 합니다.
- **j1-relay-sim 조건이 충족되지 않습니다.** 127.0.0.1:443은 샌드박스 안과 밖 모두 EACCES입니다(특권 포트이고 sudo를 쓰지 않음). 그래서 이 레인은 등록되면 blocked가 됩니다.
- **Secure Enclave와 App Attest는 측정하지 않았습니다.** WP9의 시뮬레이터 probe로 넘겼습니다.
- **sandbox-exec 거부는 `log show`에 남지 않습니다.** 그래서 거부 증거는 관측 래퍼의 JSONL 기록과 카나리 결과로 남깁니다.
- **증거 폴더가 이 워크트리에 남아 있습니다.** /Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_d5beb4e7-552-1/mobile/ios/build/emulator-evidence/ (gitignore 대상).
