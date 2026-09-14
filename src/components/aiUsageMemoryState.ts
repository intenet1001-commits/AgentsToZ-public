import type { ProjectMemoryStatus } from '../ProjectMemoryPanel';
import { isCodexThreadWorkspace } from '../agentWorkspacePath';
import {
  resolveProjectMemorySessionAction,
  resolveProjectMemorySyncDirection,
  type ProjectMemoryRemoteState,
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
  const autoBackup = status.config?.autoBackup !== false;
  const localUpdatedAt = status.modifiedAt || status.config?.lastUpdatedAt || null;
  const syncDirection = resolveProjectMemorySyncDirection({
    localExists: status.exists,
    localUpdatedAt,
    localContentHash: status.contentHash ?? null,
    lastSyncedHash: status.config?.lastSyncedHash ?? null,
    autoBackup,
    remote: memoryState.remote,
  });
  const action = resolveProjectMemorySessionAction({
    localExists: status.exists,
    needsRemember: status.activity.needsRemember,
    autoBackup,
    syncDirection,
  });
  // Offering to initialize memory in a thread's scratch folder would write it
  // where nobody will look again. Say what the folder is instead.
  if (action === 'initialize' && isCodexThreadWorkspace(folderPath)) return 'ephemeral';
  return action === 'initialize' ? 'start' : action === 'current' ? 'saved' : action;
}
