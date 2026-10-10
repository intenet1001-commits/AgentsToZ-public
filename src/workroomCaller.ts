/**
 * Which Workroom session an agentstoz_use call comes from, when an AI inside a Workroom drives
 * other Workrooms. It is only a hint: the host uses it to leave the caller out of `reuse`, to mark
 * it `self:true` in lists and to refuse instructions, keys and close aimed at the caller itself.
 * It never grants anything, so a missing or forged hint can at most make a refusal happen or not.
 *
 * Two sources, both sent by the MCP server as headers:
 * - its process ancestry (pid and process group of itself and up to six parents, from `ps`). The
 *   host matches them against each running session's CLI pid, which leads its own process group.
 *   This works for every AI, including Codex, which gives MCP servers a filtered environment.
 * - AGENTSTOZ_WORKROOM_SESSION_ID / AGENTSTOZ_WORKROOM_TARGET_ID, set in the CLI's environment when
 *   the Workroom starts, when an AI passes its environment through to MCP servers.
 */
export const AGENTSTOZ_CALLER_PROCESSES_HEADER = 'X-AgentsToZ-Caller-Processes';
export const AGENTSTOZ_CALLER_SESSION_HEADER = 'X-AgentsToZ-Caller-Session';
export const AGENTSTOZ_CALLER_TARGET_HEADER = 'X-AgentsToZ-Caller-Target';
export const WORKROOM_SESSION_ENV = 'AGENTSTOZ_WORKROOM_SESSION_ID';
export const WORKROOM_TARGET_ENV = 'AGENTSTOZ_WORKROOM_TARGET_ID';
export const WORKROOM_CALLER_ANCESTRY_HOPS = 6;
const MAX_CALLER_PROCESSES = 16;
/** The terminal protocol's own ID shape (src/aiTerminalProtocol.ts). */
const WORKROOM_ID = /^[A-Za-z0-9_-]{8,160}$/;

export type WorkroomProcessTable = Map<number, {ppid: number; pgid: number}>;
export type WorkroomCallerHint = {processes: number[]; sessionId: string | null; targetId: string | null};

/** `ps -A -o pid=,ppid=,pgid=` output; unparsable lines are skipped. */
export function parseProcessTable(output: string): WorkroomProcessTable {
  const table: WorkroomProcessTable = new Map();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) table.set(Number(match[1]), {ppid: Number(match[2]), pgid: Number(match[3])});
  }
  return table;
}

/** The pid and process group of `pid` and of up to `hops` parents; launchd/init (≤ 1) is never included. */
export function processAncestry(pid: number, table: WorkroomProcessTable, hops = WORKROOM_CALLER_ANCESTRY_HOPS): number[] {
  const found = new Set<number>();
  let current = pid;
  for (let hop = 0; hop <= hops && current > 1; hop++) {
    found.add(current);
    const row = table.get(current);
    if (!row) break;
    if (row.pgid > 1) found.add(row.pgid);
    current = row.ppid;
  }
  return [...found].slice(0, MAX_CALLER_PROCESSES);
}

/** Headers an MCP server sends so the host can recognize the Workroom it runs in. */
export function workroomCallerHeaders(env: Record<string, string | undefined>, processes: readonly number[]): Record<string, string> {
  const headers: Record<string, string> = {};
  const valid = processes.filter(value => Number.isSafeInteger(value) && value > 1).slice(0, MAX_CALLER_PROCESSES);
  if (valid.length) headers[AGENTSTOZ_CALLER_PROCESSES_HEADER] = valid.join(',');
  const sessionId = env[WORKROOM_SESSION_ENV]?.trim() ?? '';
  const targetId = env[WORKROOM_TARGET_ENV]?.trim() ?? '';
  if (WORKROOM_ID.test(sessionId)) {
    headers[AGENTSTOZ_CALLER_SESSION_HEADER] = sessionId;
    if (WORKROOM_ID.test(targetId)) headers[AGENTSTOZ_CALLER_TARGET_HEADER] = targetId;
  }
  return headers;
}

/** Strict: any malformed part is dropped as a whole, never half-trusted. */
export function parseWorkroomCallerHint(headers: {get(name: string): string | null}): WorkroomCallerHint {
  const rawProcesses = headers.get(AGENTSTOZ_CALLER_PROCESSES_HEADER)?.trim() ?? '';
  let processes: number[] = [];
  if (/^\d{1,10}(,\d{1,10}){0,15}$/.test(rawProcesses)) {
    const values = rawProcesses.split(',').map(Number);
    if (values.every(value => Number.isSafeInteger(value) && value > 1)) processes = [...new Set(values)];
  }
  const sessionId = headers.get(AGENTSTOZ_CALLER_SESSION_HEADER)?.trim() ?? '';
  const targetId = headers.get(AGENTSTOZ_CALLER_TARGET_HEADER)?.trim() ?? '';
  return {
    processes,
    sessionId: WORKROOM_ID.test(sessionId) ? sessionId : null,
    targetId: WORKROOM_ID.test(targetId) ? targetId : null,
  };
}
