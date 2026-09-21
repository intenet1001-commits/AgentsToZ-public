interface CaptureMemoryIdentity { id: string; projectRoot: string }

/** A linked checkout must still be a registered runtime target, and its memory
 * identity must survive a fresh checkout proof before it can affect ordering. */
export async function resolveWhatISaidCaptureHint(projectRoot: string, dependencies: {
  targets(): Promise<Array<{ targetId: string; cwd: string }>>;
  resolveTarget(targetId: string): Promise<{ cwd: string; revalidate?: () => Promise<{ cwd: string }> }>;
  identity(cwd: string): Promise<{ exists: boolean; projectRoot: string; config: { memoryId: string } | null }>;
  pathKey(path: string): string;
}): Promise<CaptureMemoryIdentity | null> {
  const targets = (await dependencies.targets())
    .filter(target => dependencies.pathKey(target.cwd) === dependencies.pathKey(projectRoot));
  if (targets.length !== 1) return null;
  const target = await dependencies.resolveTarget(targets[0]!.targetId);
  if (dependencies.pathKey(target.cwd) !== dependencies.pathKey(projectRoot) || !target.revalidate) return null;
  const memory = await dependencies.identity(target.cwd);
  if (!memory.exists || !memory.config?.memoryId) return null;
  const current = await target.revalidate();
  const fresh = await dependencies.identity(current.cwd);
  if (current.cwd !== target.cwd || !fresh.exists || fresh.config?.memoryId !== memory.config.memoryId
    || fresh.projectRoot !== memory.projectRoot) return null;
  return { id: fresh.config.memoryId, projectRoot: fresh.projectRoot };
}

/** One project per tick; no retained project list, overlapping scan, or retry loop. */
export class WhatISaidAutoCapture {
  private running = false;
  private after: string | null = null;
  private readonly requested = new Set<string>();
  private preferRequested = true;

  constructor(private readonly dependencies: {
    enabled(): boolean;
    projects(): Promise<Array<{ id: string; projectRoot: string }>>;
    /** Resolve one queued checkout hint to a freshly verified memory identity.
     * This is only a scheduling hint; capture rechecks registration and consent. */
    resolveHint?(projectRoot: string): Promise<{ id: string; projectRoot: string } | null>;
    capture(projectRoot: string): Promise<unknown>;
    failed(): void;
  }) {}

  /** Content-free, bounded hints from successful Workroom activity. Registration
   * and consent are rechecked at dispatch; regular rotation remains authoritative. */
  request(projectRoot: string): void {
    if (!this.dependencies.enabled() || this.requested.has(projectRoot)) return;
    if (this.requested.size >= 64) this.requested.delete(this.requested.values().next().value!);
    this.requested.add(projectRoot);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    if (!this.dependencies.enabled()) { this.requested.clear(); return; }
    this.running = true;
    try {
      const projects = (await this.dependencies.projects()).sort((a, b) => a.id.localeCompare(b.id));
      if (!this.dependencies.enabled()) return;
      const regular = projects.find(project => this.after === null || project.id.localeCompare(this.after) > 0)
        ?? projects[0];
      let requested: typeof regular;
      let requestedRoot: string | undefined;
      let resolvedHint = false;
      for (const root of this.preferRequested ? this.requested : []) {
        let project = projects.find(candidate => candidate.projectRoot === root);
        if (!project && this.dependencies.resolveHint) {
          // Keystrokes enqueue only strings. At most one unmatched checkout is
          // resolved per tick, so many stale hints cannot stall all PTYs.
          if (resolvedHint) continue;
          resolvedHint = true;
          try {
            const identity = await this.dependencies.resolveHint(root);
            if (!this.dependencies.enabled()) return;
            project = identity ? projects.find(candidate => candidate.id === identity.id
              && candidate.projectRoot === identity.projectRoot) : undefined;
          } catch { this.dependencies.failed(); }
        }
        if (!project) { this.requested.delete(root); continue; }
        requested = project; requestedRoot = root; break;
      }
      if (!this.dependencies.enabled()) return;
      const useRequested = this.preferRequested && !!requested;
      const next = useRequested ? requested : regular;
      if (!next) { this.after = null; return; }
      // Advance even on failure so one unavailable key/store cannot starve others.
      if (useRequested) this.requested.delete(requestedRoot!);
      else this.after = next.id;
      this.preferRequested = !useRequested;
      const result = await this.dependencies.capture(next.projectRoot);
      if (useRequested && result && typeof result === 'object' && 'hasMore' in result && result.hasMore === true) {
        this.request(next.projectRoot);
      }
    } catch {
      this.dependencies.failed();
    } finally {
      this.running = false;
    }
  }
}
