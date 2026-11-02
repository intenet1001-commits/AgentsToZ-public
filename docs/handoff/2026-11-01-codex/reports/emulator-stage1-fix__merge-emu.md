# emulator-stage1-fix · merge:emu

(agent final report, verbatim)

English translation: "That's the setup where once it's connected you can just keep using it, right?"

이 작업은 그 연결 경험을 바꾸지 않습니다. 에뮬레이터 시험 하네스의 기반 브랜치들을 `emu/integration`에 합쳤습니다. 이제 `emu/integration`은 **3c06fc81**이고, 요청하신 검사와 복사본 실행 세 가지가 모두 통과했습니다. main에는 합치지 않았고 push도 하지 않았습니다.

**병합 순서 (`emu/integration`)**
1. **`main` 병합:** fast-forward로 `aee852d0`까지 올라갔습니다. 그사이 main이 앞서 나가서, 요청하신 `f3e96658` 다음의 설계 문서 커밋 `aee852d0`(floating session bar)도 함께 들어왔습니다.
2. **`emu/wp0-1` (3aedb14a):** 충돌 없이 합쳤습니다(`bf97e5fd`).
3. **`emu/wp2` (36cc5466):** 충돌 없이 합쳤습니다(`61ff185c`).
4. **`emu/wp3` (beb1530e):** `scripts/emulator-e2e/sandbox.ts`에서 충돌이 났습니다(`dae881e8`).
   - **양쪽 다 유지:** wp0-1의 LAN 바인딩 가드와 `requireListening`, wp3의 `LanInbound.extraPorts`를 모두 살렸습니다.
   - **함께 고친 결함:** `sandboxedArgv`는 프로필이 여는 LAN 포트마다 가드가 있어야 띄웁니다. 그런데 `LaneHosts.sandboxProfile`은 주 포트에만 가드를 켰습니다. 그대로였다면 j1-pty의 나머지 두 포트 때문에 실행이 거절됐을 겁니다. 이제 선언한 포트마다 가드를 켭니다.
   - **사이드카 제한:** 사이드카는 LAN 포트를 하나만 쓰므로, `extraPorts`가 있는 프로필로는 띄우지 않게 했습니다.
5. **`emu/wp7` (b47b8855):** `LANE_MODULES`에서 충돌이 났고, 두 레인을 모두 등록해 해결했습니다(`71e4dc2c`).

**연결한 것 (3c06fc81)**
- **레인 표:** `screen-host-selfcheck`는 `screenFixtureHost.ts`의 selfcheck를 부릅니다. `j1-pty`는 `workroomPty.ts`가 sandbox 안에서 `check-workroom.ts`를 `--lan-address`, `--lan-ports`와 함께 돌립니다. `list` 명령에서 둘 다 registered로 나옵니다.
- **Supabase shim 시작·정지:** 새 파일 `scripts/emulator-e2e/supabaseShimHost.ts`와 `ctx.startSupabaseShim(options)`를 추가했습니다.
  - shim은 별도 프로세스로 sandbox 안에서 뜹니다. 환경 변수는 허용 목록만 쓰고, 실행용 스크래치를 쓰며, 증거는 `supabase-shim/<label>/`에 남습니다.
  - https 포트는 기본으로 임시 포트입니다. 443은 그것이 필요한 레인만 요청합니다.
  - 레인이 끝날 때 `LaneHosts.settle`이 남은 shim을 멈춥니다. 깨끗이 끝나지 않았거나(종료 코드 3·4, 강제 종료) sandbox 밖에서 돌았으면, 레인이 무엇을 돌려주든 실패로 처리합니다.
  - 오케스트레이터는 shim의 타입만 가져오고, PGlite나 `src/`는 불러오지 않습니다.
  - 아직 shim을 쓰는 레인은 없습니다. 실제 sandbox 안 실행은 단위 테스트로만 확인했습니다.
- **증거 기록:** `HARNESS_SOURCE_FILES`에 shim, shim 호스트, fixtureCa, 두 레인 모듈을 더해 증거의 소스 해시에 포함되게 했습니다.
- **테스트 추가:** sandbox 안 shim 실제 실행, 지저분한 종료가 레인을 실패로 바꾸는지, 포트 세 개짜리 프로필의 포트별 가드와 사이드카 거절을 확인하는 테스트입니다.

**검사 결과**

| 검사 | 결과 |
|---|---|
| `bun run typecheck` | 오류 0 |
| emulator-e2e-guards · emulator-sandbox · emulator-supabase-shim 테스트 3개 | 94 통과 · 0 실패 |
| 레인 관련 테스트 4개 (check-workroom-support, ios-workroom-fixture-compile, emulator-screen-fixture-host, ios-shell-contract) | 96 통과 · 0 실패 |
| `bun run test:screen-control` | 종료 코드 0: 검사 102/102, XCTest 13건 통과, status 파일 계약 일치 |

**등록 루트 밖 복사본에서 실행**
복사본은 `/Users/cs-work/agentstoz-emulator/integ-20261101-3c06fc81/wt`에 `git archive` 후 실제 `bun install`로 만들었고, 끝난 뒤 지웠습니다.
- **`preflight`:** pass, 종료 코드 0.
  - en0 주소는 192.168.219.138이고 canary는 모두 통과했으며 시뮬레이터 목록은 그대로였습니다.
  - 127.0.0.1:443은 EACCES로 열 수 없었습니다. 그래서 j1-relay-sim의 조건은 아직 충족되지 않습니다.
- **`screen-host-selfcheck`:** pass, 45/45, 16.6초, 종료 코드 0.
  - 이 복사본에는 git 정보가 없어서 「production sources vs main」 비교는 측정하지 않았다는 note가 남았습니다.
- **`j1-pty`:** pass, 105.7초, 종료 코드 0.
  - 3포트 프로필이 포트마다 가드를 켠 상태로 떴고, 가드 위반은 0건이었습니다.
  - 리스너 104회 샘플에서 en0의 선언한 세 포트(53324~53326)만 보였습니다.
  - probe 검사 39건이 통과했고, 외부 요청 0건, 프로젝트 변경 시도 0건, pair token 유출 0건이었습니다.
  - 소유 시뮬레이터는 만들고 지웠습니다. Simulator.app은 원래 있던 pid 606 그대로였고, 시뮬레이터 스냅샷도 unchanged였습니다.

**남은 점**
- LAN 가드는 선언한 포트만 봅니다. 선언하지 않은 en0 포트는 j1-pty 레인이 자기 프로세스 트리를 lsof로 따로 확인합니다. wp3가 잰 대로, 이 Mac의 SBPL로는 막을 수 없습니다.

**안전 조건**
- 3001, 52741, 4723이나 설치된 앱에는 접속하지 않았습니다.
- production Supabase, sudo, 키체인, TCC는 건드리지 않았고, OS 알림창도 보지 못했습니다.
- 남은 프로세스와 스크래치는 없습니다.

새 shim 호스트 코드는 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-13/scripts/emulator-e2e/supabaseShimHost.ts`, 레인 표와 ctx 연결은 `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/wf_35f16659-79d-13/scripts/emulator-e2e.ts`에 있습니다.
