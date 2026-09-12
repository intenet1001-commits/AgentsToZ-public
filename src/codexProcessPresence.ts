import type { ContextSurfacePresence } from './contextSessionPresence';

/**
 * A Codex CLI (`codex-tui`) session exists only while its process does — the
 * rollout JSONL it leaves behind is history, not a window. Without this check a
 * finished CLI session stays in the panel forever as a row the user cannot
 * reach, which reads as "AgentsToZ can't find my session".
 *
 * The ChatGPT app ships its own `codex` binary for the desktop app-server and
 * several helper processes. Those are not TUI sessions, and mistaking one for a
 * session would keep dead rows alive; mistaking a real TUI for a helper would
 * hide a live one. Both directions matter, so the match is deliberately narrow.
 */
const CODEX_EXECUTABLE_RE = /(^|\/)codex(\s|$)/;

const NON_TUI_MARKERS = [
  'app-server',
  'code-mode-host',
  'crashpad',
  'mcp-server',
  '--type=',
  'Helpers/',
  'Frameworks/',
  'codex exec',
  'codex-exec',
];

/** True only for a command line that runs the Codex CLI as an interactive session. */
export function isCodexTuiProcessLine(command: string): boolean {
  const line = command.trim();
  if (!line) return false;
  const executable = line.split(/\s+/)[0] ?? '';
  if (!CODEX_EXECUTABLE_RE.test(`${executable} `)) return false;
  return !NON_TUI_MARKERS.some((marker) => line.includes(marker));
}

export type CodexTuiRuntimeState = 'running' | 'stopped' | 'unverified';

/**
 * `null` means the process list could not be read (a denial, not an absence),
 * which must never be reported as a closed session.
 */
export function codexTuiRuntimeState(processLines: readonly string[] | null | undefined): CodexTuiRuntimeState {
  if (!processLines) return 'unverified';
  return processLines.some(isCodexTuiProcessLine) ? 'running' : 'stopped';
}

/**
 * With no Codex CLI process anywhere, every CLI session is conclusively over.
 *
 * Any other answer must leave the row exactly as it was. While a Codex CLI is
 * running we cannot tell which session owns it, and `unverified` is not a way
 * to say that: the panel hides unverified rows, so it would take the one
 * genuinely live CLI session off the list the moment a CLI is open.
 */
export function codexTuiSurfacePresence(state: CodexTuiRuntimeState): ContextSurfacePresence {
  return state === 'stopped' ? 'gone' : 'not-applicable';
}
