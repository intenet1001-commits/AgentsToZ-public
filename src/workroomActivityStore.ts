/**
 * One activity long-poll per window (critique item 8). The App (and each pop-out window) owns the loop through
 * `useWorkroomActivity`; the session directory, the sidebar badge and the window title only read the snapshot.
 *
 * - At most one request in flight; the next starts only after the previous answered.
 * - Pauses while the document is hidden and resumes when it is shown again.
 * - Backs off on errors (2 s doubling to 60 s). A sidecar that predates the operation answers «허용되지 않은 터미널
 *   요청» — that is not an error to show: the store marks itself unsupported and asks again after 5 minutes.
 * - A reset page (sidecar restart, a cursor older than the log) only replaces the snapshot.
 * - Only the app holds a long-poll (its Rust proxy opens its own connection per request). The local web build asks
 *   without holding every few seconds instead: a browser allows six HTTP/1.1 connections per host, and one 25 s hold per
 *   window (the App plus its window.open pop-outs) starved every other request of the page at six windows (review 2026-10-16).
 */
import {WORKROOM_ACTIVITY_WAIT_MS, normalizeWorkroomActivityResponse, type WorkroomActivityResponse, type WorkroomActivityView} from './workroomActivityProtocol';

export const WORKROOM_ACTIVITY_RETRY_MIN_MS = 2_000;
export const WORKROOM_ACTIVITY_RETRY_MAX_MS = 60_000;
export const WORKROOM_ACTIVITY_UNSUPPORTED_RETRY_MS = 5 * 60_000;
/** A floor between two answered requests, so a host that answers at once can never spin the loop. */
export const WORKROOM_ACTIVITY_MIN_GAP_MS = 250;
/** The local web build's poll period (no long-poll there). */
export const WORKROOM_ACTIVITY_WEB_POLL_MS = 2_000;
/** How long the host may hold a request, and the floor between two answered requests. */
export function workroomActivityTransport(app: boolean): {holdMs: number; gapMs: number} {
  return app ? {holdMs: WORKROOM_ACTIVITY_WAIT_MS, gapMs: WORKROOM_ACTIVITY_MIN_GAP_MS} : {holdMs: 0, gapMs: WORKROOM_ACTIVITY_WEB_POLL_MS};
}

export interface WorkroomActivitySnapshot {
  status: 'idle' | 'live' | 'unsupported' | 'retrying';
  bootId: string | null;
  sessions: ReadonlyMap<string, WorkroomActivityView>;
  updatedAt: number | null;
}
export interface WorkroomActivityStoreDependencies {
  request: (body: Record<string, unknown>) => Promise<unknown>;
  visible?: () => boolean;
  onVisibility?: (listener: () => void) => () => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
  onPage?: (page: WorkroomActivityResponse) => void;
  /** Host hold per request (default 25 s) and the floor between answers (default 250 ms): `workroomActivityTransport`. */
  holdMs?: number;
  gapMs?: number;
}

const UNSUPPORTED = ['허용되지 않은 터미널 요청입니다.', '터미널 요청 형식이 올바르지 않습니다.'];
export const workroomActivityUnsupported = (error: unknown) =>
  UNSUPPORTED.includes(String((error as {message?: unknown} | null)?.message ?? ''));

export function createWorkroomActivityStore(deps: WorkroomActivityStoreDependencies) {
  const visible = deps.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const holdMs = deps.holdMs ?? WORKROOM_ACTIVITY_WAIT_MS, gapMs = deps.gapMs ?? WORKROOM_ACTIVITY_MIN_GAP_MS;
  let snapshot: WorkroomActivitySnapshot = {status: 'idle', bootId: null, sessions: new Map(), updatedAt: null};
  const listeners = new Set<() => void>();
  let owners = 0, inFlight = 0, running = false, timer: unknown = null, failures = 0, cursor: {bootId: string; seq: number} | undefined;
  let stopVisibility: (() => void) | null = null;
  const publish = (next: Partial<WorkroomActivitySnapshot>) => { snapshot = {...snapshot, ...next}; for (const listener of [...listeners]) listener(); };
  const schedule = (ms: number) => { if (timer !== null) clearTimer(timer); timer = setTimer(() => { timer = null; void loop(); }, ms); };
  async function loop() {
    if (running || owners === 0) return;
    if (!visible()) return; // resumed by the visibility listener
    running = true;
    const started = now();
    try {
      inFlight++;
      const page = normalizeWorkroomActivityResponse(await deps.request({operation: 'activity', ...(cursor ? {after: cursor} : {}), waitMs: holdMs}));
      failures = 0;
      cursor = {bootId: page.bootId, seq: page.cursor};
      publish({status: 'live', bootId: page.bootId, sessions: new Map(page.sessions.map(entry => [entry.sessionId, entry])), updatedAt: now()});
      deps.onPage?.(page);
      if (owners > 0) schedule(Math.max(0, gapMs - (now() - started)));
    } catch (error) {
      if (workroomActivityUnsupported(error)) {
        publish({status: 'unsupported'});
        if (owners > 0) schedule(WORKROOM_ACTIVITY_UNSUPPORTED_RETRY_MS);
      } else {
        failures++;
        publish({status: 'retrying'});
        if (owners > 0) schedule(Math.min(WORKROOM_ACTIVITY_RETRY_MAX_MS, WORKROOM_ACTIVITY_RETRY_MIN_MS * 2 ** (failures - 1)));
      }
    } finally {
      inFlight--; running = false;
    }
  }
  return {
    getSnapshot: () => snapshot,
    /** Read-only: hears changes without starting a request. */
    watch(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Owner: the first one starts the loop, the last one stops it. */
    own() {
      owners++;
      if (owners === 1) {
        stopVisibility = deps.onVisibility?.(() => { if (visible() && timer === null) void loop(); }) ?? null;
        void loop();
      }
      let released = false;
      return () => {
        if (released) return; released = true;
        owners--;
        if (owners === 0) { if (timer !== null) { clearTimer(timer); timer = null; } stopVisibility?.(); stopVisibility = null; }
      };
    },
    /** A visible, focused view shows this session. Best effort: the next long-poll answer carries the change. */
    async markSeen(sessionId: string) {
      try { await deps.request({operation: 'seen', sessionId}); } catch { /* an old sidecar or a closed session: nothing to clear */ }
    },
    get inFlight() { return inFlight; },
  };
}
export type WorkroomActivityStore = ReturnType<typeof createWorkroomActivityStore>;
