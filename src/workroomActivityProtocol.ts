/**
 * The local `activity` / `seen` operations on `/api/agent-runtime/terminals` (this Mac's screens only).
 * Browser-safe: no node imports. The host side lives in src/aiTerminalActivity.ts.
 */
export const WORKROOM_ACTIVITY_STATE_NAMES = ['starting', 'working', 'needs-answer', 'turn-finished', 'idle', 'exited'] as const;
export type WorkroomActivityStateName = typeof WORKROOM_ACTIVITY_STATE_NAMES[number];
export const WORKROOM_EXIT_CAUSE_NAMES = ['exit', 'close', 'restart', 'shutdown'] as const;
export type WorkroomExitCauseName = typeof WORKROOM_EXIT_CAUSE_NAMES[number];
/** The long-poll the client asks for; the host caps it at 25 s and the app proxy allows 30 s. */
export const WORKROOM_ACTIVITY_WAIT_MS = 25_000;

export interface WorkroomActivityView {
  sessionId: string;
  targetId: string;
  agent: string;
  state: WorkroomActivityStateName;
  since: number;
  turn: number;
  source: 'screen' | 'transcript' | 'exit';
  exact: boolean;
  exitCode?: number | null;
  cause?: WorkroomExitCauseName;
  lastOutputAt: number | null;
}
export interface WorkroomActivityEventView extends Omit<WorkroomActivityView, 'lastOutputAt'> {seq: number}
export interface WorkroomActivityResponse {
  bootId: string;
  cursor: number;
  reset: boolean;
  sessions: WorkroomActivityView[];
  events: WorkroomActivityEventView[];
}

const ID = /^[A-Za-z0-9_-]{8,160}$/;
const integer = (value: unknown, min = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
function entry(value: unknown, event: boolean): WorkroomActivityView | WorkroomActivityEventView {
  const fail = (): never => { throw new Error('워크룸 상태 응답 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  const allowed = ['sessionId', 'targetId', 'agent', 'state', 'since', 'turn', 'source', 'exact', 'exitCode', 'cause', event ? 'seq' : 'lastOutputAt'];
  if (Object.keys(r).some(key => !allowed.includes(key))) return fail();
  if (typeof r.sessionId !== 'string' || !ID.test(r.sessionId) || typeof r.targetId !== 'string' || !ID.test(r.targetId)
    || typeof r.agent !== 'string' || !/^[a-z]{2,16}$/.test(r.agent)
    || !(WORKROOM_ACTIVITY_STATE_NAMES as readonly unknown[]).includes(r.state) || !integer(r.since) || !integer(r.turn)
    || !['screen', 'transcript', 'exit'].includes(r.source as string) || typeof r.exact !== 'boolean'
    || (r.exitCode !== undefined && r.exitCode !== null && !(typeof r.exitCode === 'number' && Number.isInteger(r.exitCode)))
    || (r.cause !== undefined && !(WORKROOM_EXIT_CAUSE_NAMES as readonly unknown[]).includes(r.cause))) return fail();
  if (event ? !integer(r.seq, 1) : !(r.lastOutputAt === null || integer(r.lastOutputAt))) return fail();
  return r as unknown as WorkroomActivityView;
}
export function normalizeWorkroomActivityResponse(value: unknown): WorkroomActivityResponse {
  const fail = (): never => { throw new Error('워크룸 상태 응답 형식이 올바르지 않습니다.'); };
  const outer = value as {activity?: unknown} | null;
  if (!outer || typeof outer !== 'object' || Array.isArray(outer) || Object.keys(outer).length !== 1 || !outer.activity) return fail();
  const r = outer.activity as Record<string, unknown>;
  if (typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(key => !['bootId', 'cursor', 'reset', 'sessions', 'events'].includes(key))) return fail();
  if (typeof r.bootId !== 'string' || !/^[0-9a-f-]{36}$/.test(r.bootId) || !integer(r.cursor) || typeof r.reset !== 'boolean'
    || !Array.isArray(r.sessions) || r.sessions.length > 64 || !Array.isArray(r.events) || r.events.length > 256) return fail();
  return {bootId: r.bootId, cursor: r.cursor as number, reset: r.reset,
    sessions: r.sessions.map(item => entry(item, false) as WorkroomActivityView),
    events: r.events.map(item => entry(item, true) as WorkroomActivityEventView)};
}
