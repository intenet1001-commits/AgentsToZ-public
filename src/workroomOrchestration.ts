/**
 * Pure rules for one AI driving another AI's Workroom through agentstoz_use.
 * The shared action contract (also bundled for the browser) imports this file,
 * so it must stay free of Node modules.
 */

/**
 * Keys an orchestrator may press to answer a trust, approval, selection or login prompt.
 * Shift+Tab is deliberately absent: in Claude Code it cycles permission modes (auto-accept edits,
 * plan), so an allowed key could raise a worker's autonomy that only the user may raise.
 */
export const WORKROOM_KEY_NAMES = [
  'enter', 'esc', 'tab', 'up', 'down', 'left', 'right', 'space', 'backspace', 'ctrl-c',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n',
] as const;
export type WorkroomKey = typeof WORKROOM_KEY_NAMES[number];
export const WORKROOM_KEYS_MAX = 16;
/** A TUI must read each key as its own event: a lone Esc must not merge into the next arrow. */
export const WORKROOM_KEY_INTERVAL_MS = 80;

/**
 * The option a key would choose on a question screen when that option ends the CLI (「No, exit」), else null.
 * Enter picks the highlighted row (❯ › > ▶), a digit picks the row it numbers. VOC 2026-09-30: Claude's
 * trust screen highlights 「No, exit」, a voice pressed Enter to "trust" and the workroom ended.
 */
export function workroomKeyChoosesExit(rows: readonly string[] | null | undefined, key: WorkroomKey): string | null {
  if (!rows || (key !== 'enter' && !/^[1-9]$/.test(key))) return null;
  const lines = rows.map(row => String(row ?? '').replace(/[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▌▐]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-14);
  const pattern = key === 'enter' ? /^[❯›>▶➤]\s*(.+)$/ : new RegExp(`^(?:[❯›>▶➤]\\s*)?${key}[.)]\\s*(.+)$`);
  const option = lines.map(line => pattern.exec(line)?.[1]).filter((text): text is string => !!text).pop();
  if (!option) return null;
  const text = option.replace(/^\d+[.)]\s*/, '');
  return /\b(exit|quit|abort)\b|종료|나가기/i.test(text) ? text : null;
}

export function isWorkroomKey(value: unknown): value is WorkroomKey {
  return typeof value === 'string' && (WORKROOM_KEY_NAMES as readonly string[]).includes(value);
}

/** Validates the whole list before anything is typed; there is no partial acceptance. */
export function normalizeWorkroomKeys(value: unknown): WorkroomKey[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > WORKROOM_KEYS_MAX || !value.every(isWorkroomKey)) {
    throw new Error(`keys는 허용된 키 이름 1~${WORKROOM_KEYS_MAX}개의 배열이어야 합니다: ${WORKROOM_KEY_NAMES.join(', ')}`);
  }
  return [...value];
}

/** The bytes a terminal sends for the key. Arrows follow the driven CLI's cursor keys mode (DECCKM). */
export function workroomKeySequence(key: WorkroomKey, modes: {applicationCursorKeys?: boolean} = {}): string {
  const arrow = (final: string) => modes.applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
  switch (key) {
    case 'enter': return '\r';
    case 'esc': return '\x1b';
    case 'tab': return '\t';
    case 'up': return arrow('A');
    case 'down': return arrow('B');
    case 'right': return arrow('C');
    case 'left': return arrow('D');
    case 'space': return ' ';
    case 'backspace': return '\x7f';
    case 'ctrl-c': return '\x03';
    default: return key;
  }
}

/**
 * Claude Code (and Gemini-style CLIs) run a prompt that starts with `!` as a shell command without
 * the worker's own permission prompt. agentstoz_use instructions are natural language, so a leading
 * `!` (after any whitespace) is refused. A leading `/` stays allowed: it runs that CLI's slash command.
 */
export function startsWithShellEscape(text: string): boolean {
  return /^\s*!/.test(text);
}

export const WORKROOM_READ_VIEWS = ['tail', 'screen', 'stream'] as const;
export type WorkroomReadView = typeof WORKROOM_READ_VIEWS[number];

export const WORKROOM_WAIT_LIMITS = {
  idleMs: {default: 4_000, min: 1_000, max: 20_000},
  timeoutMs: {default: 30_000, min: 1_000, max: 50_000},
} as const;
const WORKROOM_WAIT_POLL_MS = 200;
/** Host time kept back from a wait for rendering its tail (at most a quarter of a short wait). */
export const WORKROOM_WAIT_RENDER_ALLOWANCE_MS = 1_000;
/** The MCP client waits timeoutMs plus this margin, which must exceed the render allowance. */
export const WORKROOM_WAIT_CLIENT_MARGIN_MS = 5_000;

/**
 * How long the host may still wait for a session to settle. The deadline is counted from the
 * request's arrival, not from the end of the profile, memory and inventory checks before it, and
 * keeps a render allowance, so the reply reaches the MCP client before its own timeout.
 */
export function workroomWaitBudgetMs(timeoutMs: number, receivedAt: number, now: number = Date.now()): number {
  const allowance = Math.min(WORKROOM_WAIT_RENDER_ALLOWANCE_MS, Math.floor(timeoutMs / 4));
  return Math.max(0, timeoutMs - allowance - Math.max(0, now - receivedAt));
}

export type WorkroomWaitReason = 'idle' | 'exited' | 'timeout';

/**
 * Resolves when the session has printed nothing for idleMs, has exited, or timeoutMs has passed.
 * Quiet is counted from the later of the last output and the start of the wait, so a wait issued
 * right after an instruction cannot return before the CLI has had idleMs to react.
 */
export async function waitForWorkroomSettle(input: {
  probe: () => {state: 'running' | 'exited'; lastOutputAt: number | null};
  idleMs: number;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<{reason: WorkroomWaitReason; waitedMs: number}> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const started = now(), deadline = started + input.timeoutMs;
  for (;;) {
    const probe = input.probe();
    const at = now();
    if (probe.state !== 'running') return {reason: 'exited', waitedMs: at - started};
    const quietFor = at - Math.max(started, probe.lastOutputAt ?? started);
    if (quietFor >= input.idleMs) return {reason: 'idle', waitedMs: at - started};
    if (at >= deadline) return {reason: 'timeout', waitedMs: at - started};
    await sleep(Math.max(1, Math.min(input.pollMs ?? WORKROOM_WAIT_POLL_MS, input.idleMs - quietFor, deadline - at)));
  }
}
