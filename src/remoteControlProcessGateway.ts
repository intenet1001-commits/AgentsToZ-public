import { normalizeLocalOnlyDeletedPortIds } from './portLocalDeletion';

export type RemoteControlProcessAction = 'start' | 'stop' | 'restart';
export type RemoteControlProjectOpenAction =
  | 'folder.open'
  | 'localhost.open'
  | 'orca.open'
  | 'agent.claude'
  | 'agent.codex'
  | 'agent.agy'
  | 'agent.hermes'
  | 'app.claude'
  | 'app.codex'
  | 'app.hermes'
  | 'claude.thread.start'
  | 'codex.thread.start'
  | 'git.commit'
  | 'git.pull'
  | 'git.push'
  | 'git.merge'
  | 'worktree.add'
  | 'worktree.add.orca';
export type RemoteControlProjectAction = RemoteControlProcessAction | RemoteControlProjectOpenAction;
export type RemoteControlObservedStatus = 'running' | 'stopped' | 'unknown';

export interface RemoteControlRegistrationMetadata {
  deviceId?: unknown;
  /**
   * Previous installation IDs that the authenticated device-identity ledger
   * explicitly resolves to deviceId. Callers must never populate this from
   * the port rows themselves.
   */
  deviceIdentityAliases?: unknown;
  localOnlyDeletedPortIds?: unknown;
  remoteDeletedPortIds?: unknown;
  verifiedLegacyGeneratedWorktreeIds?: unknown;
}

export interface RemoteControlDetectedStart {
  command: string | null;
  framework: 'next' | 'vite' | 'other';
}

export interface RemoteControlRegisteredTarget {
  /** Server-only identifier. It must never be serialized to the LAN client. */
  internalId: string;
  name: string;
  /**
   * Secondary AI-generated alias. The desktop project card titles rows by their
   * saved `name` and shows `aiName` only as a smaller "별명" line; the phone must
   * label the same project the same way or the whole list reads as unknown
   * projects. Present only when it differs from `name`.
   */
  alias?: string;
  /**
   * Display-only name of the local workspace root that owns this project.
   * The absolute root path and registry id stay server-only; the phone uses
   * this bounded label solely for filtering.
   */
  workspaceRoot?: string;
  /**
   * Checked-out branch of this card's working tree — the main tree for a
   * project card, the linked tree for a worktree card. Already known from the
   * discovery sweep, so it costs no extra git call. A branch NAME is not a
   * path; null for a detached HEAD or when discovery could not read it.
   */
  branch?: string | null;
  port: number | null;
  kind: 'main' | 'worktree';
  folderPath?: string;
  worktreePath?: string;
  command: string | null;
  status: RemoteControlObservedStatus;
  actions: RemoteControlProjectAction[];
}

type PortLike = Record<string, unknown> & { id?: unknown };

/**
 * Git discovery is an authority check for persisted worktree rows. A transient
 * discovery exception may keep ordinary project cards available, but it must
 * never fall back to trusting a saved worktreePath.
 */
export async function loadRemoteControlWorktreeDiscoveryFailClosed<
  TTarget extends { worktreePath?: string },
  TDiscovery,
>(
  targets: readonly TTarget[],
  discover: () => Promise<TDiscovery>,
): Promise<{ targets: TTarget[]; discovery: TDiscovery | null }> {
  try {
    return { targets: [...targets], discovery: await discover() };
  } catch {
    return {
      targets: targets.filter(target => !target.worktreePath),
      discovery: null,
    };
  }
}

const validPort = (value: unknown): value is number => (
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535
);

const nonEmptyString = (value: unknown, maxLength = 8_192): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
};

/**
 * Filter before allocating any session-scoped control ID. Deletion fences and
 * cross-device rows are authority boundaries, not cosmetic UI filters.
 */
export function eligibleRemoteControlRows(
  rows: readonly PortLike[],
  metadata: RemoteControlRegistrationMetadata,
): PortLike[] {
  const excluded = new Set([
    ...normalizeLocalOnlyDeletedPortIds(metadata.localOnlyDeletedPortIds),
    ...normalizeLocalOnlyDeletedPortIds(metadata.remoteDeletedPortIds),
    ...normalizeLocalOnlyDeletedPortIds(metadata.verifiedLegacyGeneratedWorktreeIds),
  ]);
  const deviceId = nonEmptyString(metadata.deviceId, 512);
  const ownedDeviceIds = new Set<string>();
  if (deviceId) ownedDeviceIds.add(deviceId);
  if (Array.isArray(metadata.deviceIdentityAliases)) {
    for (const candidate of metadata.deviceIdentityAliases) {
      const alias = nonEmptyString(candidate, 512);
      if (alias) ownedDeviceIds.add(alias);
    }
  }
  const seen = new Set<string>();
  return rows.filter(row => {
    const id = nonEmptyString(row.id, 128);
    if (!id || seen.has(id) || excluded.has(id)) return false;
    const folderPath = nonEmptyString(row.folderPath);
    const worktreePath = nonEmptyString(row.worktreePath);
    // A registered folder is a real remote-control target even when it has no
    // localhost listener. Rows without either a folder or a port have no safe,
    // bounded project action and stay out of the controller.
    if (!folderPath && !worktreePath && !validPort(row.port)) return false;
    const sourceDeviceId = nonEmptyString(row.sourceDeviceId, 512);
    // A provenance-marked row is controllable only when this installation can
    // prove that it owns the row. Legacy local rows without provenance remain
    // available, but a missing device identity must not turn another Mac's
    // synced row into local process authority.
    if (sourceDeviceId && !ownedDeviceIds.has(sourceDeviceId)) return false;
    seen.add(id);
    return true;
  });
}

export async function registeredRemoteControlTarget(input: {
  row: PortLike;
  observedRunning: boolean | null;
  detectStart: (folderPath: string) => Promise<RemoteControlDetectedStart>;
  workspaceRootName?: string | null;
}): Promise<RemoteControlRegisteredTarget | null> {
  const internalId = nonEmptyString(input.row.id, 128);
  const port = validPort(input.row.port) ? input.row.port : null;
  if (!internalId) return null;

  const name = nonEmptyString(input.row.name, 120)
    ?? nonEmptyString(input.row.aiName, 120)
    ?? (port ? `프로젝트 :${port}` : '등록 프로젝트');
  const aiName = nonEmptyString(input.row.aiName, 120);
  const alias = aiName && aiName !== name ? aiName : undefined;
  const workspaceRoot = nonEmptyString(input.workspaceRootName, 120);
  const folderPath = nonEmptyString(input.row.folderPath);
  const worktreePath = nonEmptyString(input.row.worktreePath);
  const workingPath = worktreePath ?? folderPath;
  const isWorktree = !!worktreePath;
  const autoDetect = port !== null && (isWorktree
    || (!nonEmptyString(input.row.terminalCommand) && !nonEmptyString(input.row.commandPath)));
  let command = port === null
    ? null
    : autoDetect
    ? null
    : nonEmptyString(input.row.terminalCommand) ?? nonEmptyString(input.row.commandPath) ?? null;

  if (port !== null && !command && workingPath) {
    const detected = await input.detectStart(workingPath);
    command = nonEmptyString(detected.command) ?? null;
    if (command && isWorktree && detected.framework === 'vite') {
      command = `bunx vite --port ${port}`;
    } else if (command && isWorktree && detected.framework === 'next') {
      command = `bunx next dev -p ${port}`;
    }
  }

  // Opening a local HTML document is not process control. It remains available
  // through the explicit folder action, but must never become a start command.
  if (command?.toLowerCase().endsWith('.html')) command = null;

  const status: RemoteControlObservedStatus = port === null || input.observedRunning === null
    ? 'unknown'
    : input.observedRunning
      ? 'running'
      : 'stopped';
  const processActions: RemoteControlProcessAction[] = status === 'running' && port !== null
    ? command ? ['stop', 'restart'] : ['stop']
    : status === 'stopped' && port !== null && command
      ? ['start']
      : [];
  const openActions: RemoteControlProjectOpenAction[] = workingPath
    ? [
        'folder.open',
        'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
        // Claude Code is a CLI and registers `claude-cli:`, not `claude:`.
        // An `app.claude` deep link was handed to Claude Desktop, which
        // discarded the folder while `open` still reported success — the
        // worktree card looked like it opened the main project. Claude Code
        // is reached through `agent.claude` (Orca CLI) instead.
        'app.codex', 'app.hermes',
        'codex.thread.start',
        ...(port !== null ? ['localhost.open', 'orca.open'] as const : []),
      ]
    : [];

  return {
    internalId,
    name,
    ...(alias ? { alias } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    port,
    kind: isWorktree ? 'worktree' : 'main',
    ...(folderPath ? { folderPath } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    command,
    status,
    actions: [...processActions, ...openActions],
  };
}

export function publicRemoteControlProject(
  target: RemoteControlRegisteredTarget,
  controlId: string,
): {
  controlId: string;
  name: string;
  alias: string | null;
  workspaceRoot: string | null;
  branch: string | null;
  port: number | null;
  kind: 'main' | 'worktree';
  status: RemoteControlObservedStatus;
  actions: RemoteControlProjectAction[];
} {
  return {
    controlId,
    name: target.name,
    alias: target.alias ?? null,
    workspaceRoot: target.workspaceRoot ?? null,
    branch: target.branch ?? null,
    port: target.port,
    kind: target.kind,
    status: target.status,
    actions: [...target.actions],
  };
}

/**
 * Sort before grouping and pagination so every controller receives the same
 * name order while each worktree still follows its parent. NFKC makes Korean
 * names saved in macOS decomposed form compare with their composed form, and
 * the original index keeps exact ties stable.
 */
export function sortRemoteControlTargetsByName<
  T extends { internalId: string; name: string },
>(targets: readonly T[]): T[] {
  return targets
    .map((target, index) => ({ target, index }))
    .sort((left, right) => (
      left.target.name.normalize('NFKC').localeCompare(
        right.target.name.normalize('NFKC'),
        'ko-KR',
        { numeric: true, sensitivity: 'base' },
      ) || left.index - right.index
    ))
    .map(({ target }) => target);
}

/**
 * Order every worktree card immediately after the project it belongs to.
 *
 * Discovered worktree children are built after every main row, so without this
 * they all land at the very end of the list. On a Mac with ~100 registered
 * projects that pushed all of them past page 4 of the phone's 20-per-page,
 * tap-to-advance list: the user saw zero worktrees and concluded the feature
 * was broken. Persisted worktree rows are regrouped the same way, since their
 * position otherwise depends only on where they happen to sit in ports.json.
 *
 * Stable by construction: top-level entries keep their incoming order, a
 * parent's children keep theirs, and a child whose parent is not in the list
 * is kept at the end rather than dropped.
 */
export function groupWorktreesUnderParents<T extends { internalId: string }>(
  targets: readonly T[],
  parentByInternalId: ReadonlyMap<string, string>,
): T[] {
  const present = new Set(targets.map(target => target.internalId));
  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];
  const orphans: T[] = [];
  for (const target of targets) {
    const parentId = parentByInternalId.get(target.internalId);
    if (!parentId || parentId === target.internalId) {
      roots.push(target);
      continue;
    }
    if (!present.has(parentId)) {
      orphans.push(target);
      continue;
    }
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(target);
    else childrenByParent.set(parentId, [target]);
  }
  const ordered: T[] = [];
  const emitted = new Set<string>();
  const emit = (target: T): void => {
    if (emitted.has(target.internalId)) return;
    emitted.add(target.internalId);
    ordered.push(target);
    for (const child of childrenByParent.get(target.internalId) ?? []) emit(child);
  };
  for (const root of roots) emit(root);
  // A child whose parent was filtered out still belongs in the list; it simply
  // has no anchor to sit under.
  for (const orphan of orphans) if (!emitted.has(orphan.internalId)) emit(orphan);
  // Backstop: the output must be a permutation of the input. Without this a
  // cyclic parent link (a === parent of b, b === parent of a) leaves both
  // unreachable from any root and the cards vanish — the exact silent loss
  // this reordering exists to prevent.
  for (const target of targets) if (!emitted.has(target.internalId)) emit(target);
  return ordered;
}
