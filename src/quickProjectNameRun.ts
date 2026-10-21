import type { QuickLabel, QuickLabelInput, QuickLabelJob } from './agentRuntimeQuickLabels';

export type QuickNameRequest = { operation: 'start'; items: QuickLabelInput[] }
  | { operation: 'read' | 'cancel'; id: string };
export type QuickNamePhase = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface QuickNameProgress {
  phase: QuickNamePhase;
  items: QuickLabelInput[];
  results: QuickLabel[];
  totalBatches: number;
  completedBatches: number;
  activeJobId: string | null;
  error: string;
}

/** One user request, split only at the existing API's 30-item boundary.
 * No provider/model overrides, persistence, or automatic mutation retries.
 */
export class QuickProjectNameRun {
  private progress: QuickNameProgress = {
    phase: 'idle', items: [], results: [], totalBatches: 0, completedBatches: 0, activeJobId: null, error: '',
  };
  private batches: QuickLabelInput[][] = [];
  private job: QuickLabelJob | null = null;
  private active: Promise<void> | null = null;
  private cancelRequested = false;
  private cancelSent = false;
  private wake: (() => void) | null = null;
  private disposed = false;

  constructor(private request: (request: QuickNameRequest) => Promise<QuickLabelJob>,
    private changed: (progress: QuickNameProgress) => void, private pollIntervalMs = 1_000) {}

  snapshot(): QuickNameProgress { return structuredClone(this.progress); }
  private publish(patch: Partial<QuickNameProgress>) {
    this.progress = { ...this.progress, ...patch };
    if (!this.disposed) this.changed(this.snapshot());
  }

  start(items: QuickLabelInput[]): Promise<void> {
    if (this.disposed || this.active || this.progress.phase !== 'idle') return Promise.resolve();
    if (!items.length || new Set(items.map(item => item.id)).size !== items.length) {
      this.publish({ phase: 'failed', error: '추천할 프로젝트와 중복 ID를 확인해 주세요.' });
      return Promise.resolve();
    }
    const frozenItems = items.map(item => ({ ...item }));
    this.batches = [];
    for (let offset = 0; offset < frozenItems.length; offset += 30) this.batches.push(frozenItems.slice(offset, offset + 30));
    this.publish({ phase: 'running', items: frozenItems, totalBatches: this.batches.length, error: '' });
    return this.launch();
  }

  /** Resume by reading the same job. Never repeat an uncertain start. */
  refresh(): Promise<void> {
    if (this.disposed || this.active || this.progress.phase !== 'uncertain' || !this.job) return Promise.resolve();
    this.publish({ phase: this.cancelRequested ? 'cancelling' : 'running', error: '' });
    return this.launch(true);
  }

  cancel(): Promise<void> {
    if (this.disposed || ['idle', 'completed', 'failed', 'cancelled'].includes(this.progress.phase)) return Promise.resolve();
    // Set before any await: a late completed/read/start response cannot launch
    // the following batch after the user has requested cancellation.
    this.cancelRequested = true;
    this.publish({ phase: 'cancelling', error: '' });
    this.wake?.();
    if (this.active) return this.active;
    if (!this.job) {
      this.publish({ phase: 'uncertain', error: '시작 응답을 받지 못해 작업 ID를 확인할 수 없습니다. 새 추천은 보내지 않았습니다.' });
      return Promise.resolve();
    }
    // Only an explicit second click retries a failed cancel request.
    this.cancelSent = false;
    return this.launch();
  }

  private launch(readFirst = false): Promise<void> {
    const pending = this.drive(readFirst);
    this.active = pending.finally(() => { this.active = null; });
    return this.active;
  }

  private async drive(readFirst: boolean) {
    try {
      if (readFirst && this.job) this.accept(await this.request({ operation: 'read', id: this.job.id }), this.job.id);
      while (this.progress.completedBatches < this.batches.length) {
        if (!this.job) {
          if (this.cancelRequested) { this.publish({ phase: 'cancelled' }); return; }
          const batch = this.batches[this.progress.completedBatches]!;
          this.accept(await this.request({ operation: 'start', items: batch }));
        }
        while (this.job!.state === 'running') {
          if (this.cancelRequested && !this.cancelSent) {
            this.cancelSent = true;
            this.accept(await this.request({ operation: 'cancel', id: this.job!.id }), this.job!.id);
            if (this.job!.state !== 'running') break;
          }
          // Await each read before scheduling another; slow responses never
          // overlap. cancel() wakes this one owned timer immediately.
          await this.pause();
          if (this.cancelRequested && !this.cancelSent) continue;
          this.accept(await this.request({ operation: 'read', id: this.job!.id }), this.job!.id);
        }
        if (this.job!.state === 'completed') {
          const batch = this.batches[this.progress.completedBatches]!;
          const expected = new Set(batch.map(item => item.id));
          const results = this.job!.results;
          if (results.length !== batch.length || new Set(results.map(item => item.id)).size !== batch.length
            || results.some(item => !expected.has(item.id))) throw new Error('추천 결과의 프로젝트 ID가 일치하지 않습니다.');
          const byId = new Map(results.map(item => [item.id, item]));
          this.publish({ results: [...this.progress.results, ...batch.map(item => byId.get(item.id)!)],
            completedBatches: this.progress.completedBatches + 1 });
        } else {
          this.publish({ phase: this.job!.state === 'cancelled' ? 'cancelled' : 'failed',
            error: this.job!.error || '이 묶음의 추천을 완료하지 못했습니다. 앞서 얻은 제안은 보존했습니다.' });
          return;
        }
        this.job = null;
        this.cancelSent = false;
        this.publish({ activeJobId: null });
        if (this.cancelRequested) { this.publish({ phase: 'cancelled' }); return; }
      }
      this.publish({ phase: 'completed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ phase: 'uncertain', error: this.job
        ? `${message} · 작업 종료를 확인하지 못했습니다. 같은 작업의 상태를 다시 확인해 주세요.`
        : `${message} · 시작 결과를 확인하지 못해 다음 요청을 보내지 않았습니다.` });
    }
  }

  private accept(value: QuickLabelJob, expectedId?: string) {
    if (!value || typeof value.id !== 'string' || !value.id || (expectedId && value.id !== expectedId)
      || !['running', 'completed', 'failed', 'cancelled'].includes(value.state) || !Array.isArray(value.results)
      || value.results.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.category !== 'string')) {
      throw new Error('AI 이름 추천 응답 형식이 올바르지 않습니다.');
    }
    this.job = structuredClone(value);
    this.publish({ activeJobId: value.id });
  }

  private pause(): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.wake = null; resolve(); };
      const timer = setTimeout(finish, this.pollIntervalMs);
      this.wake = finish;
    });
  }

  /** Actual unmount only. Tab changes should keep this owner mounted. */
  dispose() {
    if (this.disposed) return;
    this.changed = () => {};
    // Finish cancellation of a known active job using the same drive loop;
    // no subsequent chunk can start after its owner disappears.
    void this.cancel();
    this.disposed = true;
    this.wake?.();
  }
}
