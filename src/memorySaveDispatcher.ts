/** Sidecar-local scheduling only. Durable completion/recovery remains owned by
 * the caller's session/terminal/checkpoint stores. Never replays a callback. */
export type MemorySaveTrigger = 'manual' | 'workroom' | 'checkpoint';
export class MemorySaveDispatchError extends Error {
  readonly autoRememberNotStarted = true;
  constructor(readonly code: 'MEMORY_SAVE_BUSY' | 'MEMORY_SAVE_CANCELLED' | 'MEMORY_SAVE_STOPPED') {
    super(code === 'MEMORY_SAVE_BUSY'
      ? '다른 기억 저장이 실행 또는 대기 중입니다. 완료 후 다시 시도해 주세요.'
      : code === 'MEMORY_SAVE_CANCELLED' ? '대기 중인 기억 저장이 취소되었습니다.' : '앱 종료로 기억 저장을 시작하지 않았습니다.');
  }
}
export function memorySaveDispatchRetryable(error: unknown): boolean {
  return ['MEMORY_SAVE_BUSY', 'MEMORY_SAVE_STOPPED'].includes(String((error as { code?: unknown } | null)?.code));
}
type Job = {
  root: string; trigger: MemorySaveTrigger;
  run(signal: AbortSignal): Promise<unknown>;
  resolve(value: any): void;
  reject(error: unknown): void;
  cleanup(): void;
};

export class MemorySaveDispatcher {
  #queue: Job[] = [];
  #roots = new Set<string>();
  #active: { controller: AbortController; done: Promise<void> } | null = null;
  #stopped = false;
  #manualBurst = 0;
  constructor(private readonly options: { maxPending?: number; waitMs?: number } = {}) {
    if (!Number.isInteger(options.maxPending ?? 16) || (options.maxPending ?? 16) < 1 || (options.maxPending ?? 16) > 16
      || !Number.isFinite(options.waitMs ?? 30_000) || (options.waitMs ?? 30_000) < 1 || (options.waitMs ?? 30_000) > 30_000) {
      throw new Error('Invalid memory dispatcher bounds');
    }
  }
  status() { return { active: !!this.#active, pending: this.#queue.length, stopped: this.#stopped }; }

  schedule<T>(request: {
    /** Host-resolved canonical memory root; never a caller-supplied alias. */
    root: string; trigger: MemorySaveTrigger;
    /** Cancels waiting only. A disconnected UI must not interrupt a started save. */
    waitingSignal?: AbortSignal;
    run(signal: AbortSignal): Promise<T>;
  }): Promise<T> {
    if (this.#stopped) return Promise.reject(new MemorySaveDispatchError('MEMORY_SAVE_STOPPED'));
    if (request.waitingSignal?.aborted) return Promise.reject(new MemorySaveDispatchError('MEMORY_SAVE_CANCELLED'));
    if (this.#roots.has(request.root) || this.#queue.length >= (this.options.maxPending ?? 16)) {
      return Promise.reject(new MemorySaveDispatchError('MEMORY_SAVE_BUSY'));
    }
    return new Promise<T>((resolve, reject) => {
      const remove = (code: 'MEMORY_SAVE_BUSY' | 'MEMORY_SAVE_CANCELLED') => {
        const index = this.#queue.indexOf(job);
        if (index < 0) return;
        this.#queue.splice(index, 1); this.#roots.delete(job.root); job.cleanup();
        reject(new MemorySaveDispatchError(code));
      };
      const abort = () => remove('MEMORY_SAVE_CANCELLED');
      const timer = setTimeout(() => remove('MEMORY_SAVE_BUSY'), this.options.waitMs ?? 30_000);
      const job: Job = {
        root: request.root, trigger: request.trigger, reject, resolve,
        cleanup: () => { clearTimeout(timer); request.waitingSignal?.removeEventListener('abort', abort); },
        run: request.run,
      };
      this.#roots.add(job.root); this.#queue.push(job);
      request.waitingSignal?.addEventListener('abort', abort, { once: true });
      this.#pump();
    });
  }

  #pump() {
    if (this.#active || this.#stopped || !this.#queue.length) return;
    const background = this.#queue.findIndex(job => job.trigger !== 'manual');
    const manual = this.#queue.findIndex(job => job.trigger === 'manual');
    const index = background >= 0 && this.#manualBurst >= 3 ? background : manual >= 0 ? manual : 0;
    const job = this.#queue.splice(index, 1)[0]!;
    this.#manualBurst = job.trigger === 'manual' ? Math.min(3, this.#manualBurst + 1) : 0;
    job.cleanup();
    const controller = new AbortController();
    // Install ownership before invoking user code, including synchronous throws.
    const finish = () => { this.#roots.delete(job.root); this.#active = null; this.#pump(); };
    const done = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new MemorySaveDispatchError('MEMORY_SAVE_STOPPED');
      return job.run(controller.signal);
    }).then(value => { finish(); job.resolve(value); }, error => { finish(); job.reject(error); });
    this.#active = { controller, done };
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    for (const job of this.#queue.splice(0)) {
      job.cleanup(); this.#roots.delete(job.root); job.reject(new MemorySaveDispatchError('MEMORY_SAVE_STOPPED'));
    }
    this.#active?.controller.abort();
    await this.#active?.done;
  }
}
