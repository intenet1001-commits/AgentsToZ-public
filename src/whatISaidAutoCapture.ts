/** One project per tick; no retained project list, overlapping scan, or retry loop. */
export class WhatISaidAutoCapture {
  private running = false;
  private after: string | null = null;
  private readonly requested = new Set<string>();
  private preferRequested = true;

  constructor(private readonly dependencies: {
    enabled(): boolean;
    projects(): Promise<Array<{ id: string; projectRoot: string }>>;
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
      for (const root of this.requested) {
        const project = projects.find(candidate => candidate.projectRoot === root);
        if (!project) { this.requested.delete(root); continue; }
        requested = project; break;
      }
      const useRequested = this.preferRequested && !!requested;
      const next = useRequested ? requested : regular;
      if (!next) { this.after = null; return; }
      // Advance even on failure so one unavailable key/store cannot starve others.
      if (useRequested) this.requested.delete(next.projectRoot);
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
