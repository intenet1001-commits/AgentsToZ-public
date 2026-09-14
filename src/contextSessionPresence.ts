import { inspectLiveOrcaTerminal, inspectOrcaSessionBinding } from './orcaSessionLookup';
import type { ClaudeLaunchContext } from './sessionOrigin';

/**
 * Snapshot freshness and host-surface existence are deliberately separate:
 * a recent status-line write can outlive the terminal window that produced it.
 */
export type ContextSurfacePresence = 'live' | 'gone' | 'unverified' | 'not-applicable';

/** What the passive Orca runtime probe was able to establish for this poll.
 * `running` is intentionally not enough to call an unbound session `live`:
 * only a snapshot with a pane/session identity can make that stronger claim. */
export type OrcaContextRuntimeState = 'stopped' | 'running' | 'unverified';

/** Codex rollout metadata can sometimes identify Orca as its host but does
 * not contain Orca's persisted pane/session binding.  We can still remove it
 * when the entire Orca runtime is conclusively stopped; otherwise leave the
 * row visibly unverified rather than guessing that a particular terminal is
 * open. */
export function unboundOrcaContextSurfacePresence(
  runtimeState: OrcaContextRuntimeState,
): ContextSurfacePresence {
  return runtimeState === 'stopped' ? 'gone' : 'unverified';
}

export interface OrcaContextSessionTarget {
  sessionId: string;
  launchContext: ClaudeLaunchContext | null | undefined;
}

export type OrcaContextRuntimeProbe =
  | { kind: 'stopped' }
  | { kind: 'unverified' }
  | { kind: 'running'; sessionState: unknown; terminals: unknown; terminalListMayBeTruncated?: boolean };

/**
 * Match every Orca snapshot against the current runtime in one pass.  This
 * works for both a worktree-owned terminal and the global Floating Workspace:
 * the persisted provider session and the runtime terminal must agree on both
 * tab and worktree. Missing/disconnected terminals are closed; ambiguous
 * bindings and truncated terminal lists remain explicitly unverified.
 */
export function inspectOrcaContextSessionPresence(
  targets: readonly OrcaContextSessionTarget[],
  probe: OrcaContextRuntimeProbe,
): Map<string, ContextSurfacePresence> {
  const result = new Map<string, ContextSurfacePresence>();
  for (const target of targets) {
    if (probe.kind === 'stopped') {
      result.set(target.sessionId, 'gone');
      continue;
    }
    if (probe.kind === 'unverified') {
      result.set(target.sessionId, 'unverified');
      continue;
    }

    const context = target.launchContext;
    const paneKey = context?.orcaPaneKey;
    const worktreeId = context?.orcaWorktreeId;
    if (!paneKey || !worktreeId) {
      result.set(target.sessionId, 'unverified');
      continue;
    }
    const binding = inspectOrcaSessionBinding(probe.sessionState, target.sessionId, paneKey);
    if (binding.kind === 'ambiguous') {
      result.set(target.sessionId, 'unverified');
      continue;
    }
    if (binding.kind === 'none' || binding.value.worktreeId !== worktreeId) {
      result.set(target.sessionId, 'gone');
      continue;
    }
    const terminal = inspectLiveOrcaTerminal(probe.terminals, binding.value);
    if (terminal.kind === 'one') {
      result.set(target.sessionId, 'live');
    } else if (terminal.kind === 'ambiguous' || probe.terminalListMayBeTruncated) {
      result.set(target.sessionId, 'unverified');
    } else {
      result.set(target.sessionId, 'gone');
    }
  }
  return result;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/** `terminal list --limit N` can only prove absence when fewer than N distinct
 * runtime handles were returned. At the cap, a missing target may be on the
 * next page and must remain unverified. */
export function hasAtLeastOrcaTerminalCount(runtime: unknown, limit: number): boolean {
  const handles = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (handles.size >= limit) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = asRecord(value);
    if (!record || seen.has(record)) return;
    seen.add(record);
    if (typeof record.handle === 'string' && record.handle.trim()) handles.add(record.handle);
    Object.values(record).forEach(visit);
  };
  visit(runtime);
  return handles.size >= limit;
}

const CMUX_TREE_CONTAINER_KEYS = ['windows', 'workspaces', 'panes', 'surfaces'] as const;
const CMUX_SURFACE_COLLECTION_KEYS = ['surfaces', 'panels', 'tabs'] as const;

export type CmuxTreeSurfacePresence = 'live' | 'gone' | 'unverified';

/**
 * cmux's `tree --all` response has changed shape between releases.  Walk it
 * structurally and require the surface UUID to appear in a surface collection
 * below the requested workspace. Matching the two generic `id` values anywhere
 * in the document is not enough: they could belong to unrelated metadata.
 */
export function inspectCmuxSurfaceInWorkspace(
  tree: unknown,
  workspaceId: string,
  surfaceId: string,
): CmuxTreeSurfacePresence {
  const seen = new WeakSet<object>();
  let foundWorkspace = false;
  const root = asRecord(tree);
  let sawCompleteTopology = Array.isArray(tree) || (root?.ok === true && Array.isArray(root.result));
  let sawSurfaceStructure = false;
  const visit = (
    value: unknown,
    insideWorkspace: boolean,
    inWorkspaceCollection: boolean,
    inSurfaceCollection: boolean,
  ): boolean => {
    if (Array.isArray(value)) {
      return value.some((item) => visit(item, insideWorkspace, inWorkspaceCollection, inSurfaceCollection));
    }
    const record = asRecord(value);
    if (!record || seen.has(record)) return false;
    seen.add(record);

    const kind = typeof record.kind === 'string' ? record.kind.toLowerCase()
      : typeof record.type === 'string' ? record.type.toLowerCase()
        : '';
    const matchesWorkspace = record.workspaceId === workspaceId
      || record.workspace_id === workspaceId
      || (inWorkspaceCollection && record.id === workspaceId)
      || (kind === 'workspace' && record.id === workspaceId);
    const inTargetWorkspace = insideWorkspace || matchesWorkspace;
    if (matchesWorkspace) foundWorkspace = true;
    const matchesSurface = inTargetWorkspace && (
      record.surfaceId === surfaceId
      || record.surface_id === surfaceId
      || record.panelId === surfaceId
      || record.panel_id === surfaceId
      || (inSurfaceCollection && record.id === surfaceId)
      || ((kind === 'surface' || kind === 'panel') && record.id === surfaceId)
    );
    if (matchesSurface) return true;

    return Object.entries(record).some(([key, child]) => {
      const childInWorkspaceCollection = key === 'workspaces';
      const childInSurfaceCollection = (CMUX_SURFACE_COLLECTION_KEYS as readonly string[]).includes(key);
      if (key === 'windows' || childInWorkspaceCollection) sawCompleteTopology = true;
      if (inTargetWorkspace && (key === 'panes' || childInSurfaceCollection)) sawSurfaceStructure = true;
      return visit(child, inTargetWorkspace, childInWorkspaceCollection, childInSurfaceCollection);
    });
  };
  if (visit(tree, false, false, false)) return 'live';
  if ((!foundWorkspace && sawCompleteTopology) || (foundWorkspace && sawSurfaceStructure)) return 'gone';
  return 'unverified';
}

export function hasCmuxSurfaceInWorkspace(
  tree: unknown,
  workspaceId: string,
  surfaceId: string,
): boolean {
  return inspectCmuxSurfaceInWorkspace(tree, workspaceId, surfaceId) === 'live';
}

/**
 * A parsed JSON document is not automatically a cmux tree: newer/failed CLI
 * responses can be valid JSON error envelopes.  Before treating a missing
 * pair as a closed surface, require at least one recognized tree collection
 * or typed tree node.  Unknown future schemas remain `unverified` instead of
 * hiding a possibly-live session.
 */
export function isRecognizedCmuxTree(tree: unknown): boolean {
  // Some cmux releases return a bare array (or an `{ok,result}` envelope)
  // when there are no windows. That is a valid empty tree, not a schema error.
  if (Array.isArray(tree)) return true;
  const root = asRecord(tree);
  if (root?.ok === true && Array.isArray(root.result)) return true;
  const seen = new WeakSet<object>();
  let recognized = false;
  const visit = (value: unknown): void => {
    if (recognized || Array.isArray(value)) {
      if (Array.isArray(value)) value.forEach(visit);
      return;
    }
    const record = asRecord(value);
    if (!record || seen.has(record)) return;
    seen.add(record);
    if (CMUX_TREE_CONTAINER_KEYS.some((key) => {
      const child = record[key];
      return Array.isArray(child) || !!asRecord(child);
    })) {
      recognized = true;
      return;
    }
    const kind = typeof record.kind === 'string' ? record.kind : record.type;
    if (
      typeof kind === 'string'
      && /^(window|workspace|pane|surface|terminal)$/i.test(kind)
      && typeof record.id === 'string'
    ) {
      recognized = true;
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(tree);
  return recognized;
}

/** Runtime/socket failures that conclusively mean cmux has no reachable UI.
 * Permission and policy errors remain `unverified`: they do not prove a window
 * was closed and should never be silently treated as one. */
export function isDefinitivelyClosedCmuxRuntimeError(error: string): boolean {
  const message = error.toLowerCase();
  if (/operation not permitted|permission denied|access denied|socket control/.test(message)) return false;
  return /connection refused|no such file or directory|failed to connect to socket|socket.*not found|daemon.*not running|runtime[_ -]?unavailable/.test(message);
}

/** A successful runtime probe can still reject a particular stale target. This
 * is distinct from a socket policy error: only explicit missing-target errors
 * are proof that this workspace/surface pair no longer exists. */
export function isDefinitivelyMissingCmuxTargetError(error: string): boolean {
  const message = error.toLowerCase();
  if (/operation not permitted|permission denied|access denied|socket control/.test(message)) return false;
  return /(?:workspace|surface|panel|target).*(?:not found|does not exist|missing)|(?:unknown|invalid).*(?:workspace|surface|panel)|no such (?:workspace|surface|panel)/.test(message);
}
