/**
 * What an agentstoz_use requestId already did, kept by the host beside the terminal service.
 *
 * The terminal service fences each input request ID only while its session runs, and a derived
 * input ID depends on which session was chosen. A retry of `reuse=true` or of `send_workroom_keys`
 * must repeat the first attempt's choice (the session, the key bytes) instead of choosing again
 * against a session set or a cursor-key mode that has changed in between. Entries outlive the
 * session's own exit bookkeeping, but the map is bounded and expires so it cannot grow for ever.
 */
export class WorkroomRequestLedger<T> {
  readonly #entries = new Map<string, {value: T; expiresAt: number}>();
  constructor(
    private readonly limits: {maxEntries: number; ttlMs: number},
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.#entries.delete(key); return undefined; }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    const now = this.now();
    // Oldest first (insertion order): drop expired entries, then enough to stay under the bound.
    for (const [oldest, entry] of this.#entries) {
      if (entry.expiresAt > now && this.#entries.size < this.limits.maxEntries) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, {value, expiresAt: now + this.limits.ttlMs});
  }

  delete(key: string): void { this.#entries.delete(key); }

  get size(): number { return this.#entries.size; }
}
