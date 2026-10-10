import type {AiTerminalAgent} from './aiTerminalProtocol';

/** DECSET 2004 paste markers (what a real terminal sends around a paste). */
export const TERMINAL_PASTE_START = '\x1b[200~';
export const TERMINAL_PASTE_END = '\x1b[201~';

/** One step of writing a Workroom input into a CLI's PTY. */
export type AiTerminalWriteStep = {write: string} | {waitMs: number};

/**
 * Prompt toolkits can swallow Enter while processing a paste burst, and Codex then leaves the
 * submitted instruction in its composer. These are measured compatibility waits between a body
 * and its Enter — never remove them (docs/plans/workroom-performance-2026-09-23 P1).
 */
export const CODEX_LONG_SUBMISSION_BYTES = 512;
export function aiTerminalEnterDelayMs(agent: AiTerminalAgent, body = ''): number {
  if (agent !== 'codex') return 40;
  // Installed Codex 0.157.1 left a 1 KiB orchestration request in the composer when Enter followed
  // after 150 ms (v544 live E2E, 2026-09-29). Keep the measured fast path for ordinary prompts,
  // but give a long composer update time to settle before its one and only Enter.
  return new TextEncoder().encode(body).length > CODEX_LONG_SUBMISSION_BYTES ? 750 : 150;
}

/**
 * The bytes xterm.js itself sends for a paste: line breaks become CR inside the brackets. Paste
 * markers inside the text are dropped so it cannot end the paste early and have the rest — and its
 * line breaks — read as keystrokes and Enter. Removal repeats until none is left: one pass can be
 * defeated by nesting (`ESC[20` + `ESC[201~` + `1~` is a new end marker once the inner one is gone).
 */
export function aiTerminalBracketedPaste(text: string): string {
  let body = text, previous: string;
  do {
    previous = body;
    body = body.split(TERMINAL_PASTE_START).join('').split(TERMINAL_PASTE_END).join('');
  } while (body !== previous);
  return TERMINAL_PASTE_START + body.replace(/\r?\n/g, '\r') + TERMINAL_PASTE_END;
}

/**
 * How one Workroom `input` request is written into the PTY. Shared by every path that types into a
 * session: the Workroom composer, `@` routing, and MCP `send_workroom_instruction`.
 *
 * - A body ending in Enter is written, then Enter follows after the measured delay above.
 * - Text with a line feed is a paste, not typing: a raw LF reaches Ink/Bubble Tea/prompt_toolkit
 *   CLIs as Ctrl+J or Enter and can submit the first line alone. When the CLI has turned bracketed
 *   paste on (`bracketedPaste` — read from the session's screen), the text goes as one bracketed
 *   paste. Without that evidence the bytes stay exactly as before.
 * - Keystrokes are never pasted: single keys, CR-only text (Enters typed in raw mode) and any text
 *   that carries its own escape sequences (e.g. xterm already bracketed it) pass through, so "1" +
 *   Enter still selects a menu option.
 */
export function aiTerminalSubmitSteps(agent: AiTerminalAgent, data: string, screen: {bracketedPaste?: boolean} = {}): AiTerminalWriteStep[] {
  const submit = data.length > 1 && data.endsWith('\r');
  const body = submit ? data.slice(0, -1) : data;
  // Text that already carries its own control sequences (e.g. xterm's own bracketed paste from raw
  // input) passes through untouched; only plain multi-line text is wrapped.
  const paste = screen.bracketedPaste === true && body.length > 1 && body.includes('\n') && !body.includes('\x1b');
  const text = paste ? aiTerminalBracketedPaste(body) : body;
  return submit ? [{write: text}, {waitMs: aiTerminalEnterDelayMs(agent, body)}, {write: '\r'}] : [{write: text}];
}
