/**
 * Serializes remote upload with remote-first/local-second deletion for one
 * memory. Capture may run from several HTTP/session-end paths at once; without
 * this lock a push can re-upsert an id after the remote DELETE but before the
 * local purge removes its source row.
 */
export class WhatISaidRemoteMutationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(memoryId: string, operation: () => Promise<T> | T): Promise<T> {
    const key = memoryId.trim();
    if (!key) throw new Error('WHAT_I_SAID_MEMORY_ID_INVALID');
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
