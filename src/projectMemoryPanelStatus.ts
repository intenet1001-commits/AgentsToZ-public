import type { SnapshotRead } from "./staleWhileRevalidate";

/**
 * One request for everything the project 장기기억 panel shows.
 *
 * The panel used to call detect, then private-github-archive/status (another
 * detect), then remote-status (two more detects) — four synchronous detects,
 * each running git and hashing the whole document, on every open and focus.
 * This runs at most one detect and hands that same status to the archive and
 * remote reads.
 *
 * - `full`  (open, after an action): a fresh detect plus archive and remote status.
 * - `local` (the 30 s poll, focus): the local status only, served from the
 *   stale-while-revalidate snapshot so bursts share one detect.
 */
export type ProjectMemoryPanelScope = "full" | "local";

export interface PanelDetectedStatus {
  exists: boolean;
  projectRoot: string;
  config: unknown | null;
  documentRecovery?: { state?: string } | null;
}

export interface ProjectMemoryPanelStatusDeps<S extends PanelDetectedStatus> {
  snapshots: { read(key: string, options?: { force?: boolean }): SnapshotRead<S> };
  sessionRecovery(status: S): unknown;
  archiveStatus(status: S): Record<string, unknown>;
  remoteStatus(status: S): Promise<Record<string, unknown>>;
  /** The remote read may re-identify the memory (alias canonicalization). */
  onRemoteChangedIdentity?(key: string): void;
}

export type ProjectMemoryPanelRemote =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string };

export interface ProjectMemoryPanelStatus<S> {
  scope: ProjectMemoryPanelScope;
  status: S & { sessionRecovery: unknown };
  privateGitHubArchive: Record<string, unknown> | null;
  remote: ProjectMemoryPanelRemote | null;
  computedAt: number;
  stale: boolean;
}

export function parseProjectMemoryPanelScope(value: unknown): ProjectMemoryPanelScope {
  return value === "local" ? "local" : "full";
}

export async function projectMemoryPanelStatus<S extends PanelDetectedStatus>(
  input: { folderPath: string; scope: ProjectMemoryPanelScope },
  deps: ProjectMemoryPanelStatusDeps<S>,
): Promise<ProjectMemoryPanelStatus<S>> {
  const snapshot = deps.snapshots.read(input.folderPath, { force: input.scope === "full" });
  const status = snapshot.value;
  const sessionRecovery = deps.sessionRecovery(status) ?? null;
  const base = {
    scope: input.scope,
    status: { ...status, sessionRecovery },
    computedAt: snapshot.computedAt,
    stale: snapshot.stale,
  };
  // A pending recovery must be resolved before anything is compared with the
  // remote copy; the panel shows only the recovery controls in that state.
  const recovering = !!sessionRecovery
    || (!!status.documentRecovery && status.documentRecovery.state !== "none");
  if (input.scope === "local" || recovering) {
    return { ...base, privateGitHubArchive: null, remote: null };
  }

  let privateGitHubArchive: Record<string, unknown> | null = null;
  if (status.exists && status.config) {
    try {
      privateGitHubArchive = deps.archiveStatus(status);
    } catch {
      // Optional cold storage never changes whether local/Supabase memory is healthy.
      privateGitHubArchive = null;
    }
  }
  let remote: ProjectMemoryPanelRemote;
  try {
    const result = await deps.remoteStatus(status);
    remote = { ok: true, ...result };
    if (result.canonicalizedFrom) deps.onRemoteChangedIdentity?.(input.folderPath);
  } catch (error: any) {
    remote = { ok: false, error: error?.message || String(error) };
  }
  return { ...base, privateGitHubArchive, remote };
}

/**
 * The remote half may rewrite `.agent-memory/config.json` (identity claim /
 * memoryId canonicalization saves the whole config object). That is why
 * `/api/project-memory/remote-status` holds the workspace lease. panel-status is
 * not a lease route — its local half must stay readable while a writer runs —
 * so the remote half takes the lease itself, and inside it swaps in a config
 * read under the lease. Reusing the unleased detect's config would let a claim
 * save write back fields another writer (push, mark-remembered) changed in the
 * meantime. A busy lease fails only the remote half (`remote: {ok:false}`).
 */
export async function remoteStatusUnderWorkspaceLease<S extends PanelDetectedStatus, R>(
  status: S,
  deps: {
    withLease<T>(operation: () => Promise<T>): Promise<T>;
    assertReady(status: S): void;
    freshIdentity(projectRoot: string): { projectRoot: string; config: S["config"] };
    /** `undefined` = the identity moved; let the remote read detect again under the lease. */
    remote(local: S | undefined): Promise<R>;
  },
): Promise<R> {
  return deps.withLease(async () => {
    deps.assertReady(status);
    const fresh = deps.freshIdentity(status.projectRoot);
    const memoryIdOf = (config: unknown) => (config as { memoryId?: string } | null)?.memoryId;
    const sameIdentity = !!fresh.config && fresh.projectRoot === status.projectRoot
      && memoryIdOf(fresh.config) === memoryIdOf(status.config);
    return deps.remote(sameIdentity ? { ...status, config: fresh.config } : undefined);
  });
}
