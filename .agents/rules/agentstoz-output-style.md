<!-- AgentsToZ shared-output-style:start -->
<!-- AgentsToZ memory-agent-version:23 -->
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

## Project tester setup on demand

When the user asks to test, verify, or check work in a registered project folder, reconcile the
project tester once before testing — do not send the user to the app. Do this even when tester
files already exist, because a different device may have a newer bundled common layer:
`curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$(git rev-parse --show-toplevel 2>/dev/null || pwd)" http://127.0.0.1:3001/api/project-tester/ensure`
(Windows PowerShell: `curl.exe` with the same flags and the folder path.)
- The AgentsToZ app owns and versions the common runner, shared scenarios and instruction blocks.
  The project's `.agentstoz/maintainer.json`, project scenarios and tests are a separate app-specific
  layer kept in that project's Git. Reconciliation preserves that layer and locally edited files.
- It only installs or updates a project registered in AgentsToZ. It runs no tests and makes no commits.
- `installed`/`updated`/`ready`: follow `.agentstoz/MAINTAINER.md` and run its quick profile.
  `skipped` or not registered: say why in one line and test with the project's existing tools.
- If the local API is unreachable, continue without it. Call it at most once per session, and
  never for requests that are not about testing this project.
<!-- AgentsToZ shared-output-style:end -->
