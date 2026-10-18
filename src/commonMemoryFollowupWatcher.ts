import type {CommonMemoryUpdate} from './commonMemoryFollowup';

export const COMMON_MEMORY_FOLLOWUP_POLL_MS = 5 * 60_000;
type Page = {updates: CommonMemoryUpdate[]; nextOffset: number | null; scopeId: string};
/** One request at a time; at most 48 groups per pass, continuing pagination on the next pass. */
export function createCommonMemoryFollowupWatcher(options: {
  read(offset: number): Promise<Page>;
  visible(): boolean;
  result(value: {updates: CommonMemoryUpdate[]; partial: boolean; scopeId: string}): void;
  error(message: string): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let active = true, running = false, offset = 0, scope: string | null = null, lastStarted = -Infinity;
  const known = new Map<string,{value: CommonMemoryUpdate; checkedAt: number}>();
  const check = async () => {
    if (!active || running || !options.visible() || now() - lastStarted < COMMON_MEMORY_FOLLOWUP_POLL_MS) return;
    running = true; lastStarted = now();
    try {
      for (let page = 0; page < 3; page++) {
        const requestedOffset = offset;
        const result = await options.read(requestedOffset);
        if (!active || !options.visible()) return;
        if (scope !== result.scopeId) {
          known.clear(); scope = result.scopeId;
          if (requestedOffset !== 0) { offset = 0; continue; }
        }
        for (const value of result.updates) known.set(value.groupId,{value,checkedAt: now()});
        offset = result.nextOffset ?? 0;
        if (result.nextOffset === null) break;
      }
      // The map is derived display state; it never deletes memory or unfinished work.
      for (const [id,row] of known) if (now() - row.checkedAt > 20 * 60_000) known.delete(id);
      while (known.size > 256) known.delete(known.keys().next().value!);
      options.result({updates: [...known.values()].map(r=>r.value),partial: offset !== 0,scopeId:scope!});
    } catch (e) {
      if (active) { known.clear(); offset = 0; options.error(e instanceof Error ? e.message : '공통기억 변경을 확인하지 못했습니다.'); }
    } finally { running = false; }
  };
  return {check, stop: () => { active = false; known.clear(); }};
}

type FollowupTimers = {set(run: () => void, ms: number): unknown; clear(handle: unknown): void};
/** Runs the watcher on a timer while shown. While hidden (the 공통기억 tab is open, or the page is in the background)
 *  no timer runs and nothing is read; showing it again checks at once (still bounded by the poll interval). */
export function startCommonMemoryFollowupPolling(options: Omit<Parameters<typeof createCommonMemoryFollowupWatcher>[0], 'visible'> & {
  hidden: boolean;
  documentVisible(): boolean;
  timers?: FollowupTimers;
}) {
  let hidden = options.hidden, timer: unknown = null;
  const timers = options.timers ?? {set: (run, ms) => setInterval(run, ms), clear: handle => clearInterval(handle as ReturnType<typeof setInterval>)};
  const watcher = createCommonMemoryFollowupWatcher({...options, visible: () => !hidden && options.documentVisible()});
  const arm = () => { if (timer === null && !hidden) timer = timers.set(() => void watcher.check(), COMMON_MEMORY_FOLLOWUP_POLL_MS); };
  const disarm = () => { if (timer !== null) { timers.clear(timer); timer = null; } };
  arm();
  const first = watcher.check();
  return {
    first,
    check: () => watcher.check(),
    setHidden(next: boolean) { hidden = next; if (next) { disarm(); return Promise.resolve(); } arm(); return watcher.check(); },
    stop() { disarm(); watcher.stop(); },
  };
}
