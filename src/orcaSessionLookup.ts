export interface OrcaSessionBinding {
  paneKey: string;
  tabId: string;
  worktreeId: string;
}

export interface OrcaLiveTerminal {
  handle: string;
  tabId: string;
  worktreeId: string;
}

/** A presence poll needs more detail than a focus action: no matching handle
 * proves a surface is gone, while multiple matching handles only prove the
 * persisted identity is ambiguous. */
export type OrcaLookup<T> =
  | { kind: 'none' }
  | { kind: 'one'; value: T }
  | { kind: 'ambiguous' };

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const asNonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

function walkObjects(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach(entry => walkObjects(entry, visit));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  visit(record);
  Object.values(record).forEach(entry => walkObjects(entry, visit));
}

/**
 * Orca persists provider-session → pane/tab/worktree relations in its local
 * workspace session state. A session ID alone is never enough: when a snapshot
 * has a pane key we require it to agree, and duplicate matches fail closed.
 */
export function inspectOrcaSessionBinding(
  state: unknown,
  sessionId: string,
  expectedPaneKey: string | null | undefined,
): OrcaLookup<OrcaSessionBinding> {
  const matches = new Map<string, OrcaSessionBinding>();
  walkObjects(state, (record) => {
    const provider = asRecord(record.providerSession);
    if (provider?.id !== sessionId) return;
    const paneKey = asNonEmptyString(record.paneKey);
    const tabId = asNonEmptyString(record.tabId);
    const worktreeId = asNonEmptyString(record.worktreeId);
    if (!paneKey || !tabId || !worktreeId) return;
    if (expectedPaneKey && paneKey !== expectedPaneKey) return;
    const binding = { paneKey, tabId, worktreeId };
    matches.set(`${paneKey}\u0000${tabId}\u0000${worktreeId}`, binding);
  });
  if (matches.size === 0) return { kind: 'none' };
  if (matches.size !== 1) return { kind: 'ambiguous' };
  return { kind: 'one', value: [...matches.values()][0]! };
}

export function findOrcaSessionBinding(
  state: unknown,
  sessionId: string,
  expectedPaneKey: string | null | undefined,
): OrcaSessionBinding | null {
  const inspected = inspectOrcaSessionBinding(state, sessionId, expectedPaneKey);
  return inspected.kind === 'one' ? inspected.value : null;
}

/**
 * `orca terminal list --json` is the source of runtime-issued terminal
 * handles. Require the exact persisted tab and worktree relation before any
 * focus action; stale/ambiguous live records intentionally yield null.
 */
export function inspectLiveOrcaTerminal(
  runtime: unknown,
  binding: OrcaSessionBinding,
): OrcaLookup<OrcaLiveTerminal> {
  const matches = new Map<string, OrcaLiveTerminal>();
  walkObjects(runtime, (record) => {
    const handle = asNonEmptyString(record.handle);
    const tabId = asNonEmptyString(record.tabId);
    const worktreeId = asNonEmptyString(record.worktreeId);
    if (!handle || tabId !== binding.tabId || worktreeId !== binding.worktreeId) return;
    if (record.orphaned === true || record.connected === false) return;
    matches.set(handle, { handle, tabId, worktreeId });
  });
  if (matches.size === 0) return { kind: 'none' };
  if (matches.size !== 1) return { kind: 'ambiguous' };
  return { kind: 'one', value: [...matches.values()][0]! };
}

export function findLiveOrcaTerminal(
  runtime: unknown,
  binding: OrcaSessionBinding,
): OrcaLiveTerminal | null {
  const inspected = inspectLiveOrcaTerminal(runtime, binding);
  return inspected.kind === 'one' ? inspected.value : null;
}
