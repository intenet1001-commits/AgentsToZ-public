/**
 * The one notification policy for Workroom activity (critique item 28). Mac notifications (S2) and phone push
 * (S9) both ask this function; neither re-implements dedupe, rate or wording. Pure and JSON-serialisable so a
 * Rust caller can share the golden table (tests/fixtures/workroom-notify-golden.json), like the tmux golden.
 *
 * Rules:
 * - Announce only `needs-answer`, `turn-finished` and `exited` with cause `exit` (the process ended by itself).
 *   A close, restart or app shutdown was caused by a viewer or the app and is never announced (item 6).
 * - Once per (session, turn, kind); at most one per session every 10 s (a later candidate waits, never dropped
 *   while it still holds).
 * - A screen-heuristic turn end (`exact:false`) is announced only after it held 8 s, so an exact transcript end
 *   arriving meanwhile wins with its own wording. Its text never claims the work is done.
 * - Nothing is ever announced from a reset/snapshot (sidecar restart, sleep/wake, a cursor older than the log —
 *   item 7). After a reset only live events count.
 * - A session that moved on (working, idle, starting) cancels its pending candidate.
 */
import type {WorkroomActivityState, WorkroomExitCause} from './aiTerminalActivity';

export const WORKROOM_NOTIFY_RATE_MS = 10_000;
export const WORKROOM_NOTIFY_HEURISTIC_HOLD_MS = 8_000;
/** Remembered (session, turn, kind) keys; old ones fall off (a turn number never comes back for a session). */
export const WORKROOM_NOTIFY_MEMORY_KEYS = 512;

export type WorkroomNotifyKind = 'needs-answer' | 'turn-finished' | 'exited';
export interface WorkroomNotifyEvent {
  sessionId: string;
  state: WorkroomActivityState;
  since: number;
  turn: number;
  exact: boolean;
  exitCode?: number | null;
  cause?: WorkroomExitCause;
}
export interface WorkroomNotification {sessionId: string; turn: number; kind: WorkroomNotifyKind; exact: boolean; text: string; at: number}
export interface WorkroomNotifyMemory {
  sent: string[];
  lastSentAt: Record<string, number>;
  pending: Record<string, {kind: WorkroomNotifyKind; turn: number; exact: boolean; exitCode: number | null; dueAt: number}>;
}
export type WorkroomNotifyStep =
  | {type: 'event'; now: number; event: WorkroomNotifyEvent}
  | {type: 'tick'; now: number}
  | {type: 'reset'; now: number};

export function initialWorkroomNotifyMemory(): WorkroomNotifyMemory { return {sent: [], lastSentAt: {}, pending: {}}; }

/** What the person reads. Only an exact turn end may say the work finished. */
export function workroomNotifyText(kind: WorkroomNotifyKind, exact: boolean, exitCode: number | null = null): string {
  if (kind === 'needs-answer') return '답이 필요합니다';
  if (kind === 'turn-finished') return exact ? '작업이 끝났습니다' : '응답이 멈췄습니다 · 확인해 보세요';
  return typeof exitCode === 'number' ? `종료됨(코드 ${exitCode})` : '종료됨';
}

const key = (sessionId: string, turn: number, kind: WorkroomNotifyKind) => `${sessionId}|${turn}|${kind}`;

export function stepWorkroomNotify(memory: WorkroomNotifyMemory, step: WorkroomNotifyStep): {memory: WorkroomNotifyMemory; notifications: WorkroomNotification[]} {
  const next: WorkroomNotifyMemory = {sent: [...memory.sent], lastSentAt: {...memory.lastSentAt}, pending: {...memory.pending}};
  if (step.type === 'reset') return {memory: {...next, pending: {}}, notifications: []};
  if (step.type === 'event') {
    const e = step.event;
    let candidate: {kind: WorkroomNotifyKind; due: number} | null = null;
    if (e.state === 'needs-answer') candidate = {kind: 'needs-answer', due: step.now};
    else if (e.state === 'turn-finished') candidate = {kind: 'turn-finished', due: e.exact ? step.now : e.since + WORKROOM_NOTIFY_HEURISTIC_HOLD_MS};
    else if (e.state === 'exited' && (e.cause ?? 'exit') === 'exit') candidate = {kind: 'exited', due: step.now};
    delete next.pending[e.sessionId];
    if (candidate && !next.sent.includes(key(e.sessionId, e.turn, candidate.kind))) {
      const last = next.lastSentAt[e.sessionId];
      next.pending[e.sessionId] = {kind: candidate.kind, turn: e.turn, exact: e.exact, exitCode: e.exitCode ?? null,
        dueAt: Math.max(candidate.due, last === undefined ? candidate.due : last + WORKROOM_NOTIFY_RATE_MS)};
    }
    // An ended session never needs another reminder; drop its rate record once nothing is pending.
    if (e.state === 'exited' && !next.pending[e.sessionId]) delete next.lastSentAt[e.sessionId];
  }
  const notifications: WorkroomNotification[] = [];
  for (const [sessionId, pending] of Object.entries(next.pending).sort(([a], [b]) => a.localeCompare(b))) {
    if (pending.dueAt > step.now) continue;
    delete next.pending[sessionId];
    next.sent.push(key(sessionId, pending.turn, pending.kind));
    if (pending.kind === 'exited') delete next.lastSentAt[sessionId]; else next.lastSentAt[sessionId] = step.now;
    notifications.push({sessionId, turn: pending.turn, kind: pending.kind, exact: pending.exact,
      text: workroomNotifyText(pending.kind, pending.exact, pending.exitCode), at: step.now});
  }
  if (next.sent.length > WORKROOM_NOTIFY_MEMORY_KEYS) next.sent.splice(0, next.sent.length - WORKROOM_NOTIFY_MEMORY_KEYS);
  return {memory: next, notifications};
}
