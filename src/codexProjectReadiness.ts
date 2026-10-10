import type { ContextSessionMetadata } from './contextSessionMetadata';

export const CODEX_PROJECT_READY_TIMEOUT_MS = 20_000;

export type CodexProjectReadiness = {
  projectTaskId: string | null;
  readiness: 'new-task' | 'selected-project';
};

/** Opening a URL only acknowledges OS delivery. Cold desktop startup and
 * project selection can outlast six seconds; keep waiting for exact evidence,
 * never replace that evidence with a delay or a running-process check. */
export async function waitForCodexProjectReadiness(input: {
  existingThreadIds: ReadonlySet<string>;
  readMetadata: () => {
    metadata: ReadonlyMap<string, ContextSessionMetadata>;
    availability: 'fresh' | 'cached' | 'unavailable';
  };
  isSelectedProject: () => boolean;
  matchesPath: (path: string | null) => boolean;
  now: () => number;
  sleep: (milliseconds: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<CodexProjectReadiness | null> {
  const startedAt = input.now();
  const deadline = startedAt + (input.timeoutMs ?? CODEX_PROJECT_READY_TIMEOUT_MS);
  while (input.now() <= deadline) {
    const snapshot = input.readMetadata();
    // A stale cache can contain an assignment which has since been moved.
    if (snapshot.availability === 'fresh') {
      for (const [sessionId, entry] of snapshot.metadata) {
        if (input.existingThreadIds.has(sessionId)) continue;
        if (entry.projectHint?.moveState !== 'applied') continue;
        if (input.matchesPath(entry.projectHint.path)) {
          return { projectTaskId: sessionId, readiness: 'new-task' };
        }
      }
    }
    if (input.now() - startedAt >= 900 && input.isSelectedProject()) {
      return { projectTaskId: null, readiness: 'selected-project' };
    }
    const remaining = deadline - input.now();
    if (remaining <= 0) break;
    await input.sleep(Math.min(200, remaining));
  }
  return null;
}
