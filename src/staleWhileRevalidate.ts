/**
 * A tiny per-key stale-while-revalidate snapshot for status reads that several
 * surfaces poll at once (the 장기기억 panel's 30 s poll, its focus/visibility
 * re-checks). Within `freshMs` every reader shares one computation; up to
 * `maxStaleMs` a reader gets the previous answer immediately, marked `stale`,
 * while one background recomputation runs; beyond that the read computes inline.
 *
 * `force` is for the moments a fresh answer is owed (panel open, after an action).
 * Failures are never cached — the next read computes again.
 */
export interface SnapshotRead<T> {
  value: T;
  computedAt: number;
  stale: boolean;
}

export interface StaleWhileRevalidateOptions<T> {
  compute: (key: string) => T;
  freshMs: number;
  maxStaleMs: number;
  maxEntries?: number;
  now?: () => number;
  schedule?: (run: () => void) => void;
}

export function createStaleWhileRevalidateCache<T>(options: StaleWhileRevalidateOptions<T>) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? (run => { setTimeout(run, 0); });
  const maxEntries = options.maxEntries ?? 256;
  const entries = new Map<string, { value: T; computedAt: number }>();
  const revalidating = new Set<string>();
  let generation = 0;

  const store = (key: string, value: T, computedAt: number) => {
    entries.delete(key);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    entries.set(key, { value, computedAt });
  };

  const computeNow = (key: string): SnapshotRead<T> => {
    const value = options.compute(key);
    const computedAt = now();
    store(key, value, computedAt);
    return { value, computedAt, stale: false };
  };

  return {
    read(key: string, readOptions: { force?: boolean } = {}): SnapshotRead<T> {
      const entry = entries.get(key);
      const age = entry ? now() - entry.computedAt : Number.POSITIVE_INFINITY;
      if (readOptions.force || !entry || age > options.maxStaleMs) return computeNow(key);
      if (age <= options.freshMs) return { ...entry, stale: false };
      if (!revalidating.has(key)) {
        revalidating.add(key);
        const startedIn = generation;
        schedule(() => {
          revalidating.delete(key);
          if (startedIn !== generation) return;
          try {
            computeNow(key);
          } catch {
            // A folder that disappeared must not keep serving its old answer.
            entries.delete(key);
          }
        });
      }
      return { ...entry, stale: true };
    },
    invalidate(key?: string): void {
      if (key === undefined) {
        generation += 1;
        entries.clear();
        revalidating.clear();
        return;
      }
      entries.delete(key);
    },
    size(): number {
      return entries.size;
    },
  };
}
