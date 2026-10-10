<!-- AgentsToZ tester:start -->
# AgentsToZ project tester

For testing requests and verification of changes, read `.agentstoz/MAINTAINER.md`
and `.agentstoz/maintainer.json`. Use the existing project tests first:
`python3 scripts/agentstoz-maintainer.py run --root . --profile quick`.
Select the project's configured profile matching the requested scope.
In a linked worktree, execute against that worktree; memory recall alone uses the primary root.
If connected AgentsToZ MCP tester tools are available, start and read the same run ID there.
Do not run the CLI again while that request is pending. If a parent runtime holds the
workspace lease, execute the CLI inside that task, not another independent lease.
Never clear another process's lock. Missing tests/tools, skipped checks and failures differ.
Report the actual current run and verified scope; an earlier pass is not current verification.
Testing alone does not authorize unrelated changes. When asked to fix a failure,
reproduce it, add a regression, fix it, and re-run the relevant checks.
Do not remove tests or weaken assertions simply to pass.
Read relevant canonical project memory. Save verified reusable lessons through the existing
remember-session workflow, not raw logs or credentials. Reports remain local under
`.agentstoz/maintainer/`. Commit the runner, manifest, tests and instructions to this project's
Git when authorized. Never push or create a repository without authorization.

Inspect without running: `python3 scripts/agentstoz-maintainer.py plan`.
Read results: `python3 scripts/agentstoz-maintainer.py status`.
Use the generated handoff.md for failures, verify fixes and remember durable lessons.

Scenarios live in `.agentstoz/scenarios/common/` (managed, shared by every project) and
`.agentstoz/scenarios/project/` (this project's, committed). Run the most valuable safe ones within a
time budget with `run --auto --budget 300` (preview: `plan --auto`), or one with `run --scenario <id>`.
Grow them with `scenarios discover` (writes proposals only, runs nothing), review
`.agentstoz/maintainer/proposals/` and the gaps file, then `scenarios accept <id>` or `scenarios reject <id>`.
`scenarios lint` rejects destructive, networked or state-changing steps. Budget-skipped and
not-applicable scenarios are reported as skipped, never as passed. `stats` shows per-check history.

Personas (optional) live in `.agentstoz/personas.json` (this project's, committed): each user goal lists
real evidence — `{"check": "<manifest check id>"}` or `{"argv": [...], "kind": "contract|screen"}` — and a
label alone never passes. `personas list`, `personas run` (the verdict is only the tests' exit code) and
`personas brief <id>` (a draft for exploratory testing; its findings are `exploratory/observed`, never
PASS/FAIL — turn each confirmed defect into a deterministic test in that persona's `tests`).
<!-- AgentsToZ tester:end -->

## AgentsToZ scenarios

Project scenarios in `.agentstoz/scenarios/project/` were seeded from this repository's real checks:
`typecheck`, the unit groups (`tester-unit`, `workroom-unit`, `remote-control-unit`, `memory-save-unit`,
`onboarding-unit`), the browser flows (`workroom-e2e`, `onboarding-ui`, `voice-media`). Browser flows are
`writes-temp` and start their own servers on ephemeral ports; none touches the installed app, port 3001 or
Supabase. A quick pre-commit pass is `python3 scripts/agentstoz-maintainer.py run --auto --budget 120`;
`--profile verify` remains the full gate. When a scenario's paths or cost drift, edit its JSON in review.
Runner changes ship under a new `VERSION`; `RELEASED_RUNNERS` keeps every shipped hash as an upgrade source.

## 사용자 페르소나 검사

`python3 scripts/agentstoz-maintainer.py run --root . --profile persona`는 Python 실행기에서
`tests/personas/catalog.json`의 사용자 목표와 실제 테스트를 연결해 검사한다.
러너 1.5.0부터 이 규칙은 **공통 러너의 `personas` 명령**에 있고(모든 프로젝트가 자기 `.agentstoz/personas.json`으로 쓴다),
`scripts/persona-tests.py`는 그것을 인라인으로 부르는 얇은 래퍼다(바깥 `persona` 프로필 실행이 잠금·보고서를 가진다).
`python3 scripts/agentstoz-maintainer.py personas list`로 현재 8개 관점을, `personas run`으로 별도 보고서(프로필 `personas`)를,
`personas brief <id>`로 AI 탐색 **초안**을 본다. 탐색 결과는 `exploratory/observed`이고 판정·이력·통계에 들어가지 않는다. 동일 테스트는
한 번만 실행하고 각 관점에 결과를 귀속한다. 이름만 추가해서 검사 인원을 부풀리지 않는다 —
**`tests`가 빈 페르소나는 러너가 거절한다**(예전에는 `all([])`이 True라 서브프로세스 0회로 통과했다).

근거는 두 종류이고 보고서가 어느 쪽인지 말한다:
- `contract` — `*.test.ts` 단위·계약 검사(`bun test ./tests/<파일>`).
- `screen` — **화면을 실제로 그려 조작하는** `*.mjs`(`bun tests/<파일> [인자]`). 카탈로그 항목을
  `{"file":"...","args":[],"env":{}}` 로 적으면 이 종류가 된다.

`screen` 근거가 하나도 없는 페르소나의 판정에는 「source contracts only, no rendered screen」이 붙는다 —
처음 쓰는 사람이 **화면을 보고 이해했는가**는 소스 계약만으로는 증명되지 않는다. 지표는 관점 수가 아니라
**잡은 결함 수**로 둔다.
실제 사용자 여정과 재현 가능한 실패가 생길 때 해당 검사를 먼저 만든 뒤 페르소나를 늘린다.
100개 이상의 관점도 이 형식으로 수용할 수 있지만, 실행 시간과 중복 커버리지는 프로필에서 제한한다.
