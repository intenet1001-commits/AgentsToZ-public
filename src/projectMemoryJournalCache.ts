/** Only derived journal snapshots live here. Eviction never touches a file or lease. */
export class ProjectMemoryJournalCache<T> {
  readonly #entries = new Map<string, { value: T; bytes: number }>();
  #bytes = 0;

  constructor(
    readonly maxBytes = 8 * 1024 * 1024,
    readonly maxRoots = 32,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
      || !Number.isSafeInteger(maxRoots) || maxRoots < 1) throw new Error('Invalid journal cache budget');
  }

  get(root: string): T | undefined {
    const cached = this.#entries.get(root);
    if (!cached) return undefined;
    this.#entries.delete(root);
    this.#entries.set(root, cached);
    return cached.value;
  }

  set(root: string, value: T, bytes: number): void {
    this.delete(root);
    // A large snapshot is still returned by the caller; retaining it would
    // defeat the process budget even if it were the only cached project.
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) return;
    while (this.#entries.size >= this.maxRoots || this.#bytes + bytes > this.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.#entries.set(root, { value, bytes });
    this.#bytes += bytes;
  }

  delete(root: string): void {
    const cached = this.#entries.get(root);
    if (!cached) return;
    this.#bytes -= cached.bytes;
    this.#entries.delete(root);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  get estimatedBytes(): number { return this.#bytes; }
  get size(): number { return this.#entries.size; }
}
