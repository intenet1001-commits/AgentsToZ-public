import type { ProjectMemoryStatus } from '../ProjectMemoryPanel';
import { isCodexThreadWorkspace } from '../agentWorkspacePath';
import {
  resolveProjectMemorySessionAction,
  resolveProjectMemorySyncDirection,
  type ProjectMemoryRemoteState,
  type ProjectMemorySyncDirection,
} from '../projectMemorySyncState';

/**
 * The context window and project-memory activity describe different things:
 * a saved memory does not make an already-open model context shorter.  Keep
 * their states separate so a high-context session cannot keep advertising a
 * memory save that has already completed.
 */
export type SessionMemoryStatusState =
  | { kind: 'checking' }
  | { kind: 'ready'; status: ProjectMemoryStatus; remote: ProjectMemoryRemoteState; checkedAt: number }
  | { kind: 'error'; message: string; code?: string; checkedAt: number };

/** Server code for a project folder that no longer exists on disk. */
export const PROJECT_ROOT_MISSING = 'PROJECT_ROOT_MISSING';

export type SessionMemoryAction =
  | 'unavailable'
  | 'checking'
  | 'missing'
  | 'retry'
  /** A per-conversation scratch folder, where long-term memory does not belong. */
  | 'ephemeral'
  | 'start'
  | 'remember'
  | 'saved'
  | 'push'
  | 'pull'
  | 'conflict';

/**
 * Local ↔ Supabase alone. Unsaved activity is a separate question (「지금 저장」), so a row that still has something to
 * remember can be fully synced: then 「동기화」 has nothing to do. Null until the memory has been read.
 */
export function sessionMemorySyncDirection(memoryState?: SessionMemoryStatusState): ProjectMemorySyncDirection | null {
  if (memoryState?.kind !== 'ready') return null;
  const status = memoryState.status;
  return resolveProjectMemorySyncDirection({
    localExists: status.exists,
    localUpdatedAt: status.modifiedAt || status.config?.lastUpdatedAt || null,
    localContentHash: status.contentHash ?? null,
    lastSyncedHash: status.config?.lastSyncedHash ?? null,
    autoBackup: status.config?.autoBackup !== false,
    remote: memoryState.remote,
  });
}

/**
 * The dock row's 「동기화」. Both sides already the same (`synced`): nothing to do, so it reads 「동기화됨」 and stays off
 * until either side changes — a save, the 30-second recheck or a manual refresh reads it again. Unknown (backup off, a
 * failed comparison) stays on: the server compares again and moves only in a safe direction.
 */
export function dockSyncButtonState(canSync: boolean, memoryState?: SessionMemoryStatusState): { enabled: boolean; synced: boolean } {
  const direction = sessionMemorySyncDirection(memoryState);
  const synced = canSync && direction === 'synced';
  return { enabled: canSync && !synced && direction !== 'checking', synced };
}

export function sessionMemoryAction(
  folderPath: string | null,
  memoryState?: SessionMemoryStatusState,
): SessionMemoryAction {
  if (!folderPath) return 'unavailable';
  if (!memoryState || memoryState.kind === 'checking') return 'checking';
  if (memoryState.kind === 'error') {
    // The folder is gone; re-checking it can only fail again.
    return memoryState.code === PROJECT_ROOT_MISSING ? 'missing' : 'retry';
  }
  const status = memoryState.status;
  const action = resolveProjectMemorySessionAction({
    localExists: status.exists,
    needsRemember: status.activity.needsRemember,
    autoBackup: status.config?.autoBackup !== false,
    syncDirection: sessionMemorySyncDirection(memoryState)!,
  });
  // Offering to initialize memory in a thread's scratch folder would write it
  // where nobody will look again. Say what the folder is instead.
  if (action === 'initialize' && isCodexThreadWorkspace(folderPath)) return 'ephemeral';
  return action === 'initialize' ? 'start' : action === 'current' ? 'saved' : action;
}
