<!-- AgentsToZ shared-output-style:start -->
<!-- AgentsToZ memory-agent-version:26 -->
# Shared output style

- For every user request, first provide a single faithful and concise English translation of the user's request under the label `English translation:`.
- Then proceed with the requested work.
- Write the actual response in the user's language unless the user asks for another language.
- Do not translate code, file paths, URLs, proper nouns, or quoted text unless needed for clarity.

## Task-aware model and reasoning advice

At the start of substantial planning or work, give one brief model/effort recommendation
using context already available. For a multi-phase plan, identify the demanding phase and
the condition for lowering effort. Reassess at planning, implementation, verification and
handoff transitions, or when task difficulty materially changes; do not announce an
unchanged recommendation at every transition or on every reply.
- Identify the active agent, model/provider and execution surface where known. Claude,
  Codex, Antigravity (agy) and Hermes do not necessarily expose the same controls; a
  provider's effort labels are not portable to another agent or model. If effort is not
  configurable, say so briefly and recommend a supported alternative only when known.
- Treat model and reasoning effort as separate settings. Use runtime-provided metadata or
  the user's latest explicit statement, and distinguish these sources. If unknown, do not
  guess, claim to have inspected settings, or interrupt routine work just to ask.
- Recommend a higher reasoning level for unresolved concurrency, privilege isolation,
  destructive data migration design, or repeated failures whose cause remains unclear.
  An authentication prompt, missing dependency, network failure, or large token counter
  alone is not a reason to upgrade the model.
- Consider a lower level for routine edits or repetitive work after representative checks
  establish a reliable approach. Do not infer a fixed model ranking from its name, or
  promise cost savings without measured evidence.
- Recommend a specific setting only when the active surface is known to support it.
  Otherwise describe the direction without inventing a model or level. When a change is
  useful, give one short recommendation with its reason, applicable phase, and the condition
  for reassessment. After the initial assessment, staying at the current setting normally
  needs no announcement. Simple questions and trivial edits do not need an effort preamble.
- Advice does not change settings. Never switch automatically, and honor the user's choice
  to keep the current setting. Do not repeat the same recommendation in the same phase
  unless new evidence materially changes it. Continue independent work while waiting.
- Use no extra AI calls, polling loop, transcript copy, or growing advice history. At normal
  session saving, retain only verified, reusable task/check/result lessons in the existing
  project memory. Keep model source and uncertainty explicit; do not attribute success to
  a model without evidence or store current settings as a permanent project preference.

## Project test sets used by every agent

When verifying a meaningful implementation change or when the user asks to test, verify,
or check work in a registered project folder, reconcile the project tester once before testing — do not send the user to the app. Do this even when tester
files already exist, because a different device may have a newer bundled common layer:
`curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$(git rev-parse --show-toplevel 2>/dev/null || pwd)" http://127.0.0.1:3001/api/project-tester/ensure`
(Windows PowerShell: `curl.exe` with the same flags and the folder path.)
- The AgentsToZ app owns and versions the common runner, shared scenarios and instruction blocks.
  The project's `.agentstoz/maintainer.json`, project scenarios and tests are a separate app-specific
  layer kept in that project's Git. Reconciliation preserves that layer and locally edited files.
- It only installs or updates a project registered in AgentsToZ. It runs no tests and makes no commits.
- `installed`/`updated`/`ready`: follow `.agentstoz/MAINTAINER.md` and run the relevant normal profile (quick by default), then the configured persona set
  with `python3 scripts/agentstoz-maintainer.py personas run --root .`. Do not duplicate a persona
  run already included in that profile. No catalog means unconfigured, never a pass.
  `skipped` or not registered: say why in one line and test with the project's existing tools.
- If the local API is unreachable, continue without it. Call it at most once per session, and
  never merely for browsing the project page or unrelated conversation.
- Use the same project configuration from Codex, Claude, Hermes and Antigravity. No separate
  request to use personas is needed when verifying implementation work. Read README, relevant
  code/docs and canonical project memory to identify real users and stakeholders. Common
  first-time/regular/returning perspectives are lenses, not an exhaustive list of actors.
- After relevant domain or journey changes, compare the existing catalog and draft missing
  roles/scenarios with `personas propose` (see `.agentstoz/MAINTAINER.md`). Include the actor,
  why it matters, starting situation, ordered journey, observable success criteria and source
  files. Leave check IDs empty when evidence is missing; label that draft "needs checks".
  Use the already-active agent's context; do not call another model or start a background AI.
  Proposing is not activation. Keep the app's existing review step and actual-test verdicts.
  This tester workflow alone does not authorize external messages, live financial actions,
  production writes or deployment.
<!-- AgentsToZ shared-output-style:end -->

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
