/**
 * Shared, side-effect-free project-memory state.  Both the project detail and
 * the AI-usage modal use this so a green “complete” message always means the
 * same thing in both places.
 */

export interface RemoteProjectMemoryStatus {
  exists: boolean;
  createdAt: string | null;
  contentHash: string | null;
  inSync: boolean;
}

export type ProjectMemoryRemoteState =
  | { kind: 'checking' }
  | { kind: 'ready'; status: RemoteProjectMemoryStatus }
  | { kind: 'error'; message: string }
  | { kind: 'not-required' };

export type ProjectMemorySyncDirection =
  | 'not-required'
  | 'checking'
  | 'synced'
  | 'push'
  | 'pull'
  | 'conflict'
  | 'error'
  | 'unknown';

/**
 * What the single 싱크 button does when pressed. The panel used to carry a
 * separate Push and Pull button, which asked the user to decide a direction the
 * panel had already worked out — and offered the wrong one as an equally easy
 * click. One button resolves the direction here instead.
 */
export type ProjectMemorySyncButtonAction =
  /** Local memory is ahead, or backup is off and this is a one-off manual backup. */
  | 'push'
  /** The Supabase revision is ahead of local. */
  | 'pull'
  /** Both sides moved: open the review screen instead of picking a winner. */
  | 'conflict'
  /** Direction is unknown — re-read the remote rather than guessing. */
  | 'recheck'
  | 'disabled';

export type ProjectMemorySessionAction =
  | 'initialize'
  | 'checking'
  | 'retry'
  | 'remember'
  | 'current'
  | 'push'
  | 'pull'
  | 'conflict';

const timestamp = (value?: string | null) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

export function resolveProjectMemorySyncDirection(input: {
  localExists: boolean;
  localUpdatedAt?: string | null;
  /** Hash of the memory file as it is on disk right now. */
  localContentHash?: string | null;
  /** Hash both sides agreed on at the last successful Push/Pull. */
  lastSyncedHash?: string | null;
  autoBackup: boolean;
  remote: ProjectMemoryRemoteState;
}): ProjectMemorySyncDirection {
  if (!input.localExists) return 'unknown';
  if (!input.autoBackup || input.remote.kind === 'not-required') return 'not-required';
  if (input.remote.kind === 'checking') return 'checking';
  if (input.remote.kind === 'error') return 'error';

  const remote = input.remote.status;
  if (remote.inSync) return 'synced';
  if (!remote.exists) return 'push';

  // Hashes answer "who changed since the last agreement", which is the actual
  // question. Timestamps cannot: a Push always stamps the remote revision
  // *after* the local edit that produced it, so a file whose mtime predates the
  // last revision — restored from backup, copied with `cp -p`, or written on a
  // machine whose clock trails — reads as "remote is newer" and the panel tells
  // the user to Pull, discarding local memory that was never backed up.
  const baseline = input.lastSyncedHash;
  if (baseline && input.localContentHash && remote.contentHash) {
    const localChanged = input.localContentHash !== baseline;
    const remoteChanged = remote.contentHash !== baseline;
    if (localChanged && remoteChanged) return 'conflict';
    if (localChanged) return 'push';
    if (remoteChanged) return 'pull';
    // Neither side moved from the baseline, yet `inSync` was false: the two
    // hashes cannot both equal the baseline and still differ. Report it rather
    // than guessing a direction.
    return 'conflict';
  }

  // No baseline yet (first backup, adopted memory) — fall back to timestamps,
  // which is weaker but all that is available.
  const localTime = timestamp(input.localUpdatedAt);
  const remoteTime = timestamp(remote.createdAt);
  if (localTime !== null && remoteTime !== null) {
    if (localTime > remoteTime) return 'push';
    if (remoteTime > localTime) return 'pull';
  }
  return 'conflict';
}

/**
 * The save button's action on a surface that ALSO shows the 싱크 button.
 *
 * `resolveProjectMemorySessionAction` folds both questions — "does this session
 * need saving?" and "is Supabase behind?" — into one verb, which is right for the
 * AI-usage panel where the save button is the only control. Next to a 싱크 button
 * it produces two controls carrying the same verb: 「동기화 상태 다시 확인」 and
 * 「싱크 다시 확인」 were literally the same re-check. Here the save button answers
 * only its own question and leaves every sync verb to 싱크.
 */
export type ProjectMemorySaveButtonAction =
  | 'remember'
  /** A conflict must be reviewed before any further write; saving is blocked. */
  | 'blocked'
  | 'checking'
  | 'current';

export function resolveProjectMemorySaveButtonAction(input: {
  needsRemember: boolean;
  hasConflict: boolean;
  sessionAction: ProjectMemorySessionAction;
}): ProjectMemorySaveButtonAction {
  if (input.hasConflict) return 'blocked';
  // Remote state is still unknown, so a save that ends in a Push cannot be
  // aimed yet. This mirrors the previous behaviour of the combined action.
  if (input.sessionAction === 'checking') return 'checking';
  return input.needsRemember ? 'remember' : 'current';
}

export function resolveProjectMemorySyncButtonAction(input: {
  localExists: boolean;
  syncDirection: ProjectMemorySyncDirection;
  /** A real API 409 already surfaced; it outranks any inferred direction. */
  hasConflict: boolean;
}): ProjectMemorySyncButtonAction {
  if (!input.localExists) return 'disabled';
  if (input.hasConflict) return 'conflict';
  switch (input.syncDirection) {
    case 'checking':
      return 'disabled';
    case 'conflict':
      return 'conflict';
    case 'pull':
      return 'pull';
    case 'push':
      return 'push';
    // Auto-backup is off, so nothing pushes on its own. The button stays the
    // manual escape hatch the old Push button was — otherwise turning backup
    // off would remove every way to reach Supabase.
    case 'not-required':
      return 'push';
    // Already equal: Push is idempotent and answers "is my memory really
    // backed up?" with the server's own verdict instead of a local guess.
    case 'synced':
      return 'push';
    // The remote state failed to load, so neither direction is known to be
    // safe. Never write blind — read first.
    case 'error':
    case 'unknown':
    default:
      return 'recheck';
  }
}

export function resolveProjectMemorySessionAction(input: {
  localExists: boolean;
  needsRemember: boolean;
  autoBackup: boolean;
  syncDirection: ProjectMemorySyncDirection;
}): ProjectMemorySessionAction {
  if (!input.localExists) return 'initialize';
  if (!input.autoBackup || input.syncDirection === 'not-required') {
    return input.needsRemember ? 'remember' : 'current';
  }
  if (input.syncDirection === 'conflict') return 'conflict';
  if (input.syncDirection === 'checking') return 'checking';
  if (input.syncDirection === 'error') return input.needsRemember ? 'remember' : 'retry';
  if (input.needsRemember) return 'remember';
  if (input.syncDirection === 'push') return 'push';
  if (input.syncDirection === 'pull') return 'pull';
  return input.syncDirection === 'synced' ? 'current' : 'retry';
}
