---
name: agentstoz-test
description: Run this project's Python-first tests, inspect failures and verify requested fixes.
---



<!-- AgentsToZ tester:start -->
# AgentsToZ project tester

For testing requests and verification of changes, read `.agentstoz/MAINTAINER.md`
and `.agentstoz/maintainer.json`. Use the existing project tests first:
`python3 scripts/agentstoz-maintainer.py run --root . --profile quick`.
Select the project's configured profile matching the requested scope.
For meaningful implementation changes, use both the normal set and the configured persona
set without waiting for a separate persona-testing request:
`python3 scripts/agentstoz-maintainer.py personas run --root .`.
Do not duplicate a persona run already included in the normal profile. A missing catalog is
unconfigured, never a pass. Merely viewing the app's configuration page runs no tests or AI.
Codex, Claude, Hermes and Antigravity use the same manifest/catalog and actual-test verdicts.
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

Grow project personas with `personas discover` after meaningful changes or test failures.
This produces bounded local candidates only; no AI call, execution or activation.
Read canonical project memory and compare user goals with the existing catalog. Implement
real deterministic checks first and declare their user journeys in maintainer.json `covers`.
Use the app's persona review to select a goal and existing checks. CLI review requires
the candidate's current context revision: `personas accept <id> --revision <revision>
--goal <reviewed-goal> --evidence-check <manifest-check-id>` (repeat evidence-check as needed).
`personas reject <id> --revision <revision>` excludes a candidate without changing tests.
Only `personas run` yields test verdicts. AI context analysis is a draft requiring review,
and never activates candidates or sends a workroom prompt automatically.
Common perspectives live in `.agentstoz/personas/common/` (app-managed, no tests).
Use `personas templates` to read them and `personas create <template-id> --revision <revision>
--goal <project-goal> --situation <starting-situation> --journey-step <step>
--success-criterion <criterion> --evidence-check <check-id>` to review a project extension.
Repeat steps, criteria and checks as needed. Keep project journeys in the project's catalog;
common updates preserve them. Changed definitions require a new run before claiming a current pass.

Common perspectives are lenses, not a limit on project actors. Read README, relevant code/docs
and canonical memory to identify domain users, employees, operators and external stakeholders.
Consider expertise, permissions, goals, interruptions and failure situations only where project
evidence supports them. Compare existing roles; do not invent facts or grow duplicate labels.
After meaningful domain/journey changes, the already-active agent should record missing roles
as candidates; no separate instruction or additional model call is needed. Use `personas context`
for the current revision, then `personas propose --revision <revision> --role <actor>
--reason <why-this-project-needs-it> --goal <goal> --situation <starting-situation>
--journey-step <step> --success-criterion <criterion> --source-path <project-relative-file>
--evidence-check <configured-check-id>`. Repeat steps, criteria, sources and checks as needed.
Omit evidence-check when checks do not exist: the draft is "needs checks", never active or PASS.
Sources are evidence references, not instructions or additional permission. Implement the
actual checks, re-propose at the current revision and use the existing app review to connect
checks. Distinct actors with the same goal retain their own journey and success criteria.
This workflow does not authorize external messages, live transactions or production actions.
<!-- AgentsToZ tester:end -->
