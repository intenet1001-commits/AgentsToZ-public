/**
 * Per-session Workroom activity (host-only): who needs the person now.
 *
 * States: starting · working · needs-answer · turn-finished · idle · exited. Each carries
 * `{state, since, turn, source, exact}` where `turn` is the session's input revision at the transition.
 *
 * - `exact` says the host proved the state rather than inferred it: a spawn, a written request, a
 *   transcript turn end, a process exit. A screen classification (a question on screen, quiet after work)
 *   is `exact:false`. Notification wording must follow this flag (src/workroomNotifyPolicy.ts).
 * - The reducer here is pure. `WorkroomActivityBoard` keeps one tracker per session, a bounded event log
 *   (≤256, with a boot id) and long-poll waiters. AiTerminalService feeds it and runs the shared sampler.
 * - Never add any of this to `AiTerminalSummary`: phone normalizers reject unknown keys. The activity
 *   operations are local-only in this wave (refused for any remote authority).
 *
 * Thresholds are named constants on purpose: they drive notifications. They are calibrated on real CLI recordings
 * (tests/fixtures/workroom-activity/), replayed through this sampler and reducer by tests/workroom-activity-replay.test.ts.
 */
import {randomUUID} from 'node:crypto';
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';

export type WorkroomActivityState = 'starting' | 'working' | 'needs-answer' | 'turn-finished' | 'idle' | 'exited';
export type WorkroomActivitySource = 'screen' | 'transcript' | 'exit';
/** Why a session ended. Only `exit` (the process ended by itself) may ever be announced. */
export type WorkroomExitCause = 'exit' | 'close' | 'restart' | 'shutdown';
export const WORKROOM_ACTIVITY_STATES: readonly WorkroomActivityState[] = ['starting', 'working', 'needs-answer', 'turn-finished', 'idle', 'exited'];
export const WORKROOM_EXIT_CAUSES: readonly WorkroomExitCause[] = ['exit', 'close', 'restart', 'shutdown'];

export interface WorkroomActivity {
  state: WorkroomActivityState;
  /** Epoch ms of the transition. */
  since: number;
  /** The session's input revision at the transition. */
  turn: number;
  source: WorkroomActivitySource;
  exact: boolean;
  exitCode?: number | null;
  cause?: WorkroomExitCause;
}

/**
 * One shared sweep: rows are read at most once per sample per running session, and only after new output.
 * Calibrated on real CLIs (tests/fixtures/workroom-activity): Codex writes ~30×/s while working, so evaluating per
 * write would cost far more than a 1 s sweep and see nothing extra.
 */
export const WORKROOM_ACTIVITY_SAMPLE_MS = 1_000;
/**
 * A question on screen is waiting for the person once it has stayed on every sample for this long. There is no
 * output-quiet requirement: real approval prompts keep writing while they wait (Claude blinks a row every ~0.6 s,
 * Codex rewrites its window title every ~1.0 s), so a quiet rule never saw them. 1.5 s is 2.4× Claude's blink and
 * 1.5× Codex's toggle and covers a half-drawn dialog; with the 1 s sweep it fires 2–3 s after the prompt appears.
 */
export const WORKROOM_NEEDS_ANSWER_STABLE_MS = 1_500;
/** Quiet that ends a burst of screen changes (an idle or finished session's lone repaint is not work). */
export const WORKROOM_CHANGE_BURST_QUIET_MS = 1_500;
/** A starting CLI with no question that has been quiet this long is idle (MCP loading can pause a few seconds). */
export const WORKROOM_STARTING_IDLE_QUIET_MS = 5_000;
/**
 * Heuristic turn end: working, then no PTY write at all (window-title writes count — they are the CLI's heartbeat)
 * for this long with no question on screen. Measured: the longest silence while working was 0.8 s (Claude streaming;
 * Codex 0.12 s), so 3 s is 3.75× that; the transcript stays the exact signal.
 */
export const WORKROOM_TURN_FINISHED_QUIET_MS = 3_000;
/** An idle or finished session counts as working again only after screen changes kept coming this long. */
export const WORKROOM_WORKING_SUSTAIN_MS = 3_000;
/**
 * A transcript turn end belongs to the oldest request not yet ended, and only if it was written after that request.
 * The host records a request right after its Enter was written, so the CLI's own timestamp of a turn end can only
 * trail it by this much clock granularity; an end any earlier belongs to an earlier turn.
 */
export const WORKROOM_TRANSCRIPT_SUBMIT_SLACK_MS = 250;
/** Requests remembered while the CLI works (a person can queue several); older ones fall off. */
export const WORKROOM_PENDING_REQUEST_LIMIT = 16;
export const WORKROOM_ACTIVITY_LOG_LIMIT = 256;
/** The host never holds a long-poll longer than this (the app proxy allows 30 s for the operation). */
export const WORKROOM_ACTIVITY_MAX_WAIT_MS = 25_000;
export const WORKROOM_ACTIVITY_MAX_WAITERS = 32;

export type WorkroomActivityInput =
  | {type: 'start'; at: number; turn: number}
  /**
   * A written request: input ending in CR, a whole-request submission, or a first request at launch. While the last
   * sample showed a question it is an answer (a keystroke), not a new turn: a trust or approval Enter must not
   * become «working» and then a heuristic «turn finished» seconds later.
   */
  | {type: 'submit'; at: number; turn: number}
  /** Any other written input (a keystroke such as «1» answering a menu). */
  | {type: 'keys'; at: number; turn: number}
  | {type: 'seen'; at: number; turn: number}
  /** A sample after output: whether the visible rows changed and whether they ask a question (the first sample of a
   *  question starts its stability clock). */
  | {type: 'screen'; at: number; turn: number; changed: boolean; awaitsAnswer: boolean}
  /** Every sweep: how long since the last output (or the spawn), and whether the last sampled rows ask a question. */
  | {type: 'quiet'; at: number; turn: number; quietFor: number; awaitsAnswer: boolean}
  /** An exact turn end read from the CLI's own transcript. */
  | {type: 'transcript'; at: number; turn: number; key: string; completedAt: number}
  | {type: 'exit'; at: number; turn: number; code: number | null; cause: WorkroomExitCause};

/** Reducer memory beyond the public activity. */
export interface WorkroomActivityTracker {
  activity: WorkroomActivity;
  /** First screen change after the last quiet period (idle/finished → working needs sustained change). */
  changeSince: number | null;
  lastSubmitAt: number | null;
  /**
   * Requests written while the CLI had not finished the earlier ones, oldest first (review 2026-10-16). Codex and Claude
   * queue an Enter sent while they work, so one transcript turn end finishes only the oldest; the session is exactly
   * finished when none is left. A request to a session that was not working starts the list over.
   */
  pendingSubmits: readonly number[];
  /** Transcript turn ends already consumed, newest key. */
  transcriptKey: string | null;
  /** When the current question was first sampled on screen (null: the last sample asked nothing). */
  awaitSince: number | null;
  /** The state a question interrupted; the session goes back to it when the question leaves the screen. */
  resumeState: WorkroomActivityState | null;
}

export function initialWorkroomActivityTracker(at: number, turn = 0): WorkroomActivityTracker {
  return {activity: {state: 'starting', since: at, turn, source: 'screen', exact: true}, changeSince: null, lastSubmitAt: null, pendingSubmits: [],
    transcriptKey: null, awaitSince: null, resumeState: null};
}

const activity = (state: WorkroomActivityState, at: number, turn: number, source: WorkroomActivitySource, exact: boolean): WorkroomActivity =>
  ({state, since: at, turn, source, exact});
const running = (state: WorkroomActivityState) => state !== 'exited';

/**
 * Pure transition. Returns the next tracker and whether the public activity changed (a log event).
 * An exited session never changes again.
 */
export function reduceWorkroomActivity(tracker: WorkroomActivityTracker, input: WorkroomActivityInput): {tracker: WorkroomActivityTracker; changed: boolean} {
  const current = tracker.activity;
  if (current.state === 'exited') return {tracker, changed: false};
  const next = (value: WorkroomActivity, extra: Partial<WorkroomActivityTracker> = {}) =>
    ({tracker: {...tracker, ...extra, activity: value}, changed: true});
  const keep = (extra: Partial<WorkroomActivityTracker> = {}) =>
    ({tracker: Object.keys(extra).length ? {...tracker, ...extra} : tracker, changed: false});
  // Where a question sends the session back once it leaves the screen: a trust screen answered during start-up is
  // still starting (never «working», which would end in a heuristic «turn finished» with no request run).
  const resume = (at: number, turn: number) => {
    const back = tracker.resumeState === 'starting' ? 'starting' : tracker.resumeState === 'working' || tracker.resumeState === null ? 'working' : 'idle';
    return next(activity(back, at, turn, 'screen', false), {awaitSince: null, resumeState: null, changeSince: null});
  };
  /** A sample that shows a question: needs-answer once it has stayed on screen long enough, from any running state. */
  const asking = (at: number, turn: number, extra: Partial<WorkroomActivityTracker>) => {
    const awaitSince = tracker.awaitSince ?? at;
    if (current.state === 'needs-answer') return keep({...extra, awaitSince});
    if (at - awaitSince >= WORKROOM_NEEDS_ANSWER_STABLE_MS)
      return next(activity('needs-answer', at, turn, 'screen', false), {awaitSince, resumeState: current.state, changeSince: null});
    return keep({...extra, awaitSince});
  };
  const answered = () =>
    // New input after a finished turn means the person is back (spec: turn-finished → idle on new input).
    current.state === 'turn-finished' ? next(activity('idle', input.at, input.turn, 'screen', true)) : keep();
  switch (input.type) {
    case 'start':
      return next(activity('starting', input.at, input.turn, 'screen', true), {changeSince: null, awaitSince: null, resumeState: null});
    case 'submit': {
      if (tracker.awaitSince !== null) return answered();
      const pendingSubmits = current.state === 'working' ? [...tracker.pendingSubmits, input.at].slice(-WORKROOM_PENDING_REQUEST_LIMIT) : [input.at];
      return next(activity('working', input.at, input.turn, 'screen', true), {lastSubmitAt: input.at, pendingSubmits, changeSince: null});
    }
    case 'keys':
      return answered();
    case 'seen':
      return current.state === 'turn-finished' ? next(activity('idle', input.at, input.turn, 'screen', true)) : keep();
    case 'screen': {
      if (input.awaitsAnswer) return asking(input.at, input.turn, {});
      if (current.state === 'needs-answer') return resume(input.at, input.turn);
      const cleared = tracker.awaitSince !== null ? {awaitSince: null} : {};
      if (!input.changed) return keep(cleared);
      if (current.state === 'idle' || current.state === 'turn-finished') {
        const since = tracker.changeSince ?? input.at;
        if (input.at - since >= WORKROOM_WORKING_SUSTAIN_MS) return next(activity('working', input.at, input.turn, 'screen', false), {changeSince: null, awaitSince: null});
        return keep({...cleared, changeSince: since});
      }
      return keep(cleared);
    }
    case 'quiet': {
      // Quiet counts from the last request as well as the last output: a CLI that has not answered a request yet is
      // not finished with it (the sampler only knows when it last wrote).
      const quietFor = tracker.lastSubmitAt === null ? input.quietFor : Math.min(input.quietFor, Math.max(0, input.at - tracker.lastSubmitAt));
      const reset = input.quietFor >= WORKROOM_CHANGE_BURST_QUIET_MS && tracker.changeSince !== null ? {changeSince: null} : {};
      if (input.awaitsAnswer) return asking(input.at, input.turn, reset);
      // The question went away without a screen sample saying so (a redraw parsed late): back where it interrupted.
      if (current.state === 'needs-answer') return resume(input.at, input.turn);
      if (current.state === 'starting' && input.quietFor >= WORKROOM_STARTING_IDLE_QUIET_MS)
        return next(activity('idle', input.at, input.turn, 'screen', false), {changeSince: null});
      if (current.state === 'working' && quietFor >= WORKROOM_TURN_FINISHED_QUIET_MS)
        return next(activity('turn-finished', input.at, input.turn, 'screen', false), {changeSince: null});
      return keep(reset);
    }
    case 'transcript': {
      if (input.key === tracker.transcriptKey) return keep();
      const consumed = {transcriptKey: input.key};
      const finishes = current.state === 'working' || (current.state === 'turn-finished' && !current.exact);
      const pending = tracker.pendingSubmits;
      if (pending.length === 0) {
        // No request of ours is open. Only work the screen saw starting on its own (a request typed key by key) can end,
        // and only with an end written after that work began.
        if (current.state === 'working' && !current.exact && input.completedAt >= current.since - WORKROOM_WORKING_SUSTAIN_MS - WORKROOM_TRANSCRIPT_SUBMIT_SLACK_MS)
          return next(activity('turn-finished', input.at, input.turn, 'transcript', true), {...consumed, changeSince: null});
        return keep(consumed);
      }
      // An end written before the oldest open request belongs to an earlier turn (history, or read late).
      if (input.completedAt < pending[0]! - WORKROOM_TRANSCRIPT_SUBMIT_SLACK_MS) return keep(consumed);
      const rest = pending.slice(1);
      // A request is still queued behind the one that ended: the CLI goes on with it.
      if (rest.length) return keep({...consumed, pendingSubmits: rest});
      // A question on screen beats a transcript turn end; an idle session has nothing to finish.
      if (finishes) return next(activity('turn-finished', input.at, input.turn, 'transcript', true), {...consumed, pendingSubmits: [], changeSince: null});
      return keep({...consumed, pendingSubmits: []});
    }
    case 'exit':
      return next({state: 'exited', since: input.at, turn: input.turn, source: 'exit', exact: true, exitCode: input.code, cause: input.cause}, {changeSince: null, awaitSince: null});
  }
}

/**
 * Whether a raw input is a request (review 2026-10-16): it ends in Enter and carries text of its own. A lone Enter — the
 * empty composer's pass-through, the Enter key button, agentstoz_use «enter», confirming a popup — or Enter after only
 * cursor keys does no work by itself; it stays a keystroke, and sustained screen change still shows real work.
 * Whole-request and launch submissions are requests regardless (the service passes them as such).
 */
export function workroomInputIsRequest(input: string): boolean {
  if (!/[\r\n]$/.test(input)) return false;
  const text = input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (cursor keys, paste markers)
    .replace(/\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g, '') // OSC / DCS / PM / APC
    .replace(/\x1b[\s\S]?/g, '') // other escapes
    .replace(/[\x00-\x1f\x7f]/g, '');
  return /\S/.test(text);
}

/** Visible rows → a cheap change key. Trailing blanks are trimmed by the screen already. */
export function workroomRowsKey(rows: readonly string[]): string {
  let hash = 2166136261;
  for (const row of rows) {
    for (let index = 0; index < row.length; index++) { hash ^= row.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    hash ^= 10; hash = Math.imul(hash, 16777619);
  }
  return `${rows.length}:${(hash >>> 0).toString(36)}`;
}
export const workroomRowsAwaitAnswer = (rows: readonly string[] | null) => !!rows && workroomScreenAwaitsAnswer(rows);

/** Per-session sampler memory (host-only). */
export interface WorkroomSampleMemory {
  /** The spawn: quiet is counted from here until the first output. */
  startedAt: number;
  /** The output time already sampled: rows are read again only after newer output. */
  sampledOutputAt?: number;
  rowsKey?: string;
  awaits?: boolean;
}
/** Whether this sweep must read the visible rows (only after output newer than the last read). */
export const workroomSampleWantsRows = (memory: WorkroomSampleMemory, lastOutputAt: number | null) =>
  lastOutputAt !== null && (memory.sampledOutputAt === undefined || lastOutputAt > memory.sampledOutputAt);
/**
 * One session's part of a sweep → the reducer inputs, in order. The service and the fixture replay
 * (tests/workroom-activity-replay.test.ts) both run this, so the replay measures the shipped sampler.
 * `rows`: what was read when `workroomSampleWantsRows` said so (null: no headless screen); undefined when not read.
 */
export function workroomSampleInputs(memory: WorkroomSampleMemory, sample: {at: number; turn: number; lastOutputAt: number | null; rows?: readonly string[] | null}): WorkroomActivityInput[] {
  const inputs: WorkroomActivityInput[] = [];
  if (sample.rows !== undefined && sample.lastOutputAt !== null) {
    memory.sampledOutputAt = sample.lastOutputAt;
    // Without a headless screen any output counts as a change.
    const key = sample.rows ? workroomRowsKey(sample.rows) : `output:${sample.lastOutputAt}`;
    const changed = key !== memory.rowsKey;
    memory.rowsKey = key; memory.awaits = workroomRowsAwaitAnswer(sample.rows);
    inputs.push({type: 'screen', at: sample.at, turn: sample.turn, changed, awaitsAnswer: memory.awaits});
  }
  const since = sample.lastOutputAt ?? memory.startedAt;
  inputs.push({type: 'quiet', at: sample.at, turn: sample.turn, quietFor: Math.max(0, sample.at - since), awaitsAnswer: !!memory.awaits});
  return inputs;
}

/** One transcript turn end: Claude `stop_reason:"end_turn"` (not `tool_use`), Codex `task_complete`. */
export interface WorkroomTurnCompletion {key: string; completedAt: number; resultText?: string}

/** Only the final public assistant text, never thinking/tool blocks or terminal rows. */
export function workroomTurnResultText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let text = '', bytes = 0; const encoder = new TextEncoder();
  for (const c of value.trim()) {
    bytes += encoder.encode(c).length;
    if (bytes > 12_000) return text + '\n\n[긴 응답의 나머지는 연결 워크룸에서 확인하세요.]';
    text += c;
  }
  return text;
}

/**
 * Standalone turn-end parser over complete JSONL lines (no statusline, no auto-remember opt-in).
 * Unparseable lines are skipped: a partial line is not evidence.
 */
export function parseWorkroomTurnCompletions(agent: 'claude' | 'codex', text: string): WorkroomTurnCompletion[] {
  const out: WorkroomTurnCompletion[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    if (agent === 'claude') {
      if (row.type !== 'assistant' || row.isSidechain === true || row.message?.stop_reason !== 'end_turn') continue;
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at)) continue;
      const resultText = workroomTurnResultText(Array.isArray(row.message.content) ? row.message.content.filter((v: any) => v?.type === 'text' && typeof v.text === 'string').map((v: any) => v.text).join('\n') : undefined);
      out.push({key: typeof row.uuid === 'string' && row.uuid.length <= 128 ? `claude:${row.uuid}` : `claude:${row.timestamp}`, completedAt: at, ...(resultText ? {resultText} : {})});
    } else {
      if (row.type !== 'event_msg' || row.payload?.type !== 'task_complete') continue;
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at)) continue;
      const turnId = typeof row.payload.turn_id === 'string' && row.payload.turn_id.length <= 128 ? row.payload.turn_id : row.timestamp;
      const resultText = workroomTurnResultText(row.payload.last_agent_message);
      out.push({key: `codex:${turnId}`, completedAt: at, ...(resultText ? {resultText} : {})});
    }
  }
  return out;
}

export interface WorkroomActivityEntry extends WorkroomActivity {
  sessionId: string;
  targetId: string;
  agent: string;
  /** Epoch ms of the last PTY output, or null before any. Host-only. */
  lastOutputAt: number | null;
}
export interface WorkroomActivityEvent extends WorkroomActivity {seq: number; sessionId: string; targetId: string; agent: string}
export interface WorkroomActivityCursor {bootId: string; seq: number}
export interface WorkroomActivityPage {
  bootId: string;
  /** The newest event's seq (0 before any). Pass `{bootId, seq: cursor}` as the next `after`. */
  cursor: number;
  /**
   * True when `after` was missing, from another boot, or older than the log: `events` is empty and only
   * the snapshot is current. A notifier must never announce anything from a reset (critique item 7).
   */
  reset: boolean;
  sessions: WorkroomActivityEntry[];
  events: WorkroomActivityEvent[];
}

interface BoardSession {targetId: string; agent: string; tracker: WorkroomActivityTracker; lastOutputAt: () => number | null}

/** The host's activity: trackers, a bounded transition log and long-poll waiters. */
export class WorkroomActivityBoard {
  readonly bootId = randomUUID();
  #sessions = new Map<string, BoardSession>();
  #log: WorkroomActivityEvent[] = [];
  #seq = 0;
  #waiters = new Set<() => void>();
  constructor(private readonly now: () => number = Date.now) {}

  track(sessionId: string, meta: {targetId: string; agent: string; turn?: number; lastOutputAt: () => number | null}) {
    const tracker = initialWorkroomActivityTracker(this.now(), meta.turn ?? 0);
    this.#sessions.set(sessionId, {targetId: meta.targetId, agent: meta.agent, tracker, lastOutputAt: meta.lastOutputAt});
    this.#append(sessionId);
  }
  forget(sessionId: string) { this.#sessions.delete(sessionId); }
  has(sessionId: string) { return this.#sessions.has(sessionId); }
  get(sessionId: string): WorkroomActivity | null { return this.#sessions.get(sessionId)?.tracker.activity ?? null; }
  tracker(sessionId: string): WorkroomActivityTracker | null { return this.#sessions.get(sessionId)?.tracker ?? null; }
  /** Applies one input; returns true when the public activity changed (and was logged). */
  apply(sessionId: string, input: WorkroomActivityInput): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    const {tracker, changed} = reduceWorkroomActivity(session.tracker, input);
    session.tracker = tracker;
    if (changed) this.#append(sessionId);
    return changed;
  }
  #append(sessionId: string) {
    const session = this.#sessions.get(sessionId)!;
    this.#log.push({seq: ++this.#seq, sessionId, targetId: session.targetId, agent: session.agent, ...session.tracker.activity});
    if (this.#log.length > WORKROOM_ACTIVITY_LOG_LIMIT) this.#log.splice(0, this.#log.length - WORKROOM_ACTIVITY_LOG_LIMIT);
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }
  snapshot(): WorkroomActivityEntry[] {
    return [...this.#sessions].map(([sessionId, session]) => ({sessionId, targetId: session.targetId, agent: session.agent,
      ...session.tracker.activity, lastOutputAt: session.lastOutputAt()}));
  }
  get cursor() { return this.#seq; }
  /** Events after a cursor, or a reset with the snapshot only. */
  events(after?: WorkroomActivityCursor): WorkroomActivityPage {
    const first = this.#log[0]?.seq ?? this.#seq + 1;
    const reset = !after || after.bootId !== this.bootId || after.seq > this.#seq || after.seq < first - 1;
    return {bootId: this.bootId, cursor: this.#seq, reset, sessions: this.snapshot(),
      events: reset ? [] : this.#log.filter(event => event.seq > after!.seq).map(event => ({...event}))};
  }
  /** Resolves on the next transition, or with an empty page after `timeoutMs`. */
  async wait(after: WorkroomActivityCursor | undefined, timeoutMs: number): Promise<WorkroomActivityPage> {
    const ready = this.events(after);
    const wait = Math.max(0, Math.min(WORKROOM_ACTIVITY_MAX_WAIT_MS, Math.floor(timeoutMs)));
    if (ready.reset || ready.events.length || wait === 0) return ready;
    if (this.#waiters.size >= WORKROOM_ACTIVITY_MAX_WAITERS) {
      // Release the oldest long-poll instead of growing; its caller simply asks again.
      const oldest = this.#waiters.values().next().value!;
      this.#waiters.delete(oldest); oldest();
    }
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => { clearTimeout(timer); this.#waiters.delete(wake); resolve(); };
      timer = setTimeout(wake, wait);
      (timer as any)?.unref?.();
      this.#waiters.add(wake);
    });
    return this.events(after);
  }
  /** Wakes every long-poll (shutdown). */
  release() { const waiters = [...this.#waiters]; this.#waiters.clear(); for (const wake of waiters) wake(); }
}

/** Strict local request shapes for the two activity operations. */
export interface WorkroomActivityRequest {operation: 'activity'; after?: WorkroomActivityCursor; waitMs: number}
export interface WorkroomSeenRequest {operation: 'seen'; sessionId: string}
export const isWorkroomActivityOperation = (value: unknown) =>
  !!value && typeof value === 'object' && !Array.isArray(value) && ['activity', 'seen'].includes((value as {operation?: unknown}).operation as string);

export function normalizeWorkroomActivityRequest(value: unknown): WorkroomActivityRequest | WorkroomSeenRequest {
  const fail = (): never => { throw new Error('워크룸 상태 요청이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  const allowed = r.operation === 'activity' ? ['operation', 'requestId', 'after', 'waitMs'] : r.operation === 'seen' ? ['operation', 'requestId', 'sessionId'] : null;
  if (!allowed || Object.keys(r).some(key => !allowed.includes(key))) return fail();
  if (r.requestId !== undefined && (typeof r.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(r.requestId))) return fail();
  if (r.operation === 'seen') {
    if (typeof r.sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(r.sessionId)) return fail();
    return {operation: 'seen', sessionId: r.sessionId};
  }
  let after: WorkroomActivityCursor | undefined;
  if (r.after !== undefined) {
    const a = r.after as Record<string, unknown>;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(key => key !== 'bootId' && key !== 'seq')
      || typeof a.bootId !== 'string' || !/^[0-9a-f-]{36}$/.test(a.bootId)
      || typeof a.seq !== 'number' || !Number.isSafeInteger(a.seq) || a.seq < 0) return fail();
    after = {bootId: a.bootId, seq: a.seq};
  }
  const waitMs = r.waitMs === undefined ? 0 : r.waitMs;
  if (typeof waitMs !== 'number' || !Number.isSafeInteger(waitMs) || waitMs < 0) return fail();
  return {operation: 'activity', ...(after ? {after} : {}), waitMs: Math.min(WORKROOM_ACTIVITY_MAX_WAIT_MS, waitMs)};
}
