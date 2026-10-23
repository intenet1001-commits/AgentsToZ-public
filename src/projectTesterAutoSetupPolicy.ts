/**
 * Natural-language tester setup, shared through every agent's global instructions
 * (Claude, Codex, Antigravity, Hermes). A project's tester used to start only when someone
 * pressed setup in the app; asking an agent to "test this" in a project could otherwise
 * use a missing or stale common layer. The agent now asks the local API to reconcile it —
 * the API decides what is safe (registered projects only, locally edited files preserved).
 */
export const PROJECT_TESTER_AUTO_SETUP_POLICY = `## Project test sets used by every agent

When verifying a meaningful implementation change or when the user asks to test, verify,
or check work in a registered project folder, reconcile the project tester once before testing — do not send the user to the app. Do this even when tester
files already exist, because a different device may have a newer bundled common layer:
\`curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$(git rev-parse --show-toplevel 2>/dev/null || pwd)" http://127.0.0.1:3001/api/project-tester/ensure\`
(Windows PowerShell: \`curl.exe\` with the same flags and the folder path.)
- The AgentsToZ app owns and versions the common runner, shared scenarios and instruction blocks.
  The project's \`.agentstoz/maintainer.json\`, project scenarios and tests are a separate app-specific
  layer kept in that project's Git. Reconciliation preserves that layer and locally edited files.
- It only installs or updates a project registered in AgentsToZ. It runs no tests and makes no commits.
- \`installed\`/\`updated\`/\`ready\`: follow \`.agentstoz/MAINTAINER.md\` and run the relevant normal profile (quick by default), then the configured persona set
  with \`python3 scripts/agentstoz-maintainer.py personas run --root .\`. Do not duplicate a persona
  run already included in that profile. No catalog means unconfigured, never a pass.
  \`skipped\` or not registered: say why in one line and test with the project's existing tools.
- If the local API is unreachable, continue without it. Call it at most once per session, and
  never merely for browsing the project page or unrelated conversation.
- Use the same project configuration from Codex, Claude, Hermes and Antigravity. No separate
  request to use personas is needed when verifying implementation work. Read README, relevant
  code/docs and canonical project memory to identify real users and stakeholders. Common
  first-time/regular/returning perspectives are lenses, not an exhaustive list of actors.
- After relevant domain or journey changes, compare the existing catalog and draft missing
  roles/scenarios with \`personas propose\` (see \`.agentstoz/MAINTAINER.md\`). Include the actor,
  why it matters, starting situation, ordered journey, observable success criteria and source
  files. Leave check IDs empty when evidence is missing; label that draft "needs checks".
  Use the already-active agent's context; do not call another model or start a background AI.
  Proposing is not activation. Keep the app's existing review step and actual-test verdicts.
  This tester workflow alone does not authorize external messages, live financial actions,
  production writes or deployment.`;
