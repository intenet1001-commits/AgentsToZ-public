/**
 * The token-free activity hook AgentsToZ writes into a project's Claude/Codex hook files (it records only
 * when an agent was last used). Kept here, apart from project-memory-server.ts, so the check that decides
 * whether a Codex hook file holds nothing but this hook (codexHookTrust.ts) builds the very same string.
 */
export const ACTIVITY_HOOK_COMMAND_MARKER = 'AGENTSTOZ_PROJECT_MEMORY_ACTIVITY';
export const ACTIVITY_HOOK_REL = '.agent-memory/activity-hook.sh';

export const shellLiteral = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** The POSIX hook command for one agent; `projectSubpath` is the project's path inside its repository. */
export function unixActivityHookCommand(agent: string, projectSubpath: string): string {
  return `${ACTIVITY_HOOK_COMMAND_MARKER}=${agent}; WORKING_ROOT="$(pwd -P)"; PROJECT_TOP="$(git -C "$WORKING_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"; MEMORY_SUBPATH=${shellLiteral(projectSubpath)}; MEMORY_ROOT="$WORKING_ROOT"; if [ -n "$PROJECT_TOP" ]; then MAIN_TOP="$(git -C "$PROJECT_TOP" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)"; [ -n "$MAIN_TOP" ] || { cat >/dev/null 2>&1 || :; exit 0; }; MEMORY_ROOT="$MAIN_TOP"; [ -z "$MEMORY_SUBPATH" ] || MEMORY_ROOT="$MAIN_TOP/$MEMORY_SUBPATH"; fi; if [ ! -f "$MEMORY_ROOT/.agent-memory/config.json" ]; then cat >/dev/null 2>&1 || :; exit 0; fi; hook="$MEMORY_ROOT/${ACTIVITY_HOOK_REL}"; if [ -f "$hook" ]; then /bin/sh "$hook" ${agent}; else cat >/dev/null 2>&1 || :; fi`;
}

/** True only for a command this module would have generated, byte for byte (any subpath). */
export function isAgentsToZActivityHookCommand(command: string, agent: string): boolean {
  const match = /MEMORY_SUBPATH=('(?:[^']|'"'"')*'); MEMORY_ROOT=/.exec(command);
  if (!match) return false;
  const subpath = match[1]!.slice(1, -1).replaceAll(`'"'"'`, "'");
  return command === unixActivityHookCommand(agent, subpath);
}
