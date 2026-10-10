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
<!-- AgentsToZ tester:end -->
