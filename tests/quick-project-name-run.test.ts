import { describe, expect, test } from 'bun:test';
import { QuickProjectNameRun, type QuickNameRequest } from '../src/quickProjectNameRun';
import type { QuickLabelInput, QuickLabelJob } from '../src/agentRuntimeQuickLabels';

const items = (count: number): QuickLabelInput[] => Array.from({ length: count }, (_, index) => ({
  id: `project-${String(index).padStart(4, '0')}`, name: `프로젝트 ${index}`, description: `설명 ${index}`,
}));
const completed = (id: string, batch: QuickLabelInput[]): QuickLabelJob => ({ id, state: 'completed', error: null,
  results: [...batch].reverse().map(item => ({ id: item.id, name: `별명 ${item.name}`, category: '검증' })) });
const running = (id: string): QuickLabelJob => ({ id, state: 'running', results: [], error: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(probe: () => boolean) {
  const deadline = performance.now() + 500;
  while (!probe() && performance.now() < deadline) await Bun.sleep(1);
  expect(probe()).toBe(true);
}

describe('sequential project name suggestion controller', () => {
  test.each([1, 30, 31, 61, 184])('%i project IDs are preserved in sequential batches of at most 30', async count => {
    const input = items(count);
    const batches: QuickLabelInput[][] = [];
    let activeJob: string | null = null;
    let concurrentReads = 0;
    let maxReads = 0;
    const request = async (request: QuickNameRequest): Promise<QuickLabelJob> => {
      if (request.operation === 'start') {
        expect(activeJob).toBe(null);
        expect(request.items.length).toBeGreaterThan(0);
        expect(request.items.length).toBeLessThanOrEqual(30);
        batches.push(request.items);
        activeJob = `job-${batches.length}`;
        return running(activeJob);
      }
      expect(request.operation).toBe('read');
      expect(request.id).toBe(activeJob!);
      concurrentReads += 1; maxReads = Math.max(maxReads, concurrentReads);
      await Bun.sleep(2);
      concurrentReads -= 1;
      const result = completed(activeJob!, batches.at(-1)!);
      activeJob = null;
      return result;
    };
    const controller = new QuickProjectNameRun(request, () => {}, 1);
    await controller.start(input);
    const state = controller.snapshot();
    expect(state.phase).toBe('completed');
    expect(state.results.map(result => result.id)).toEqual(input.map(item => item.id));
    expect(batches.flat().map(item => item.id)).toEqual(input.map(item => item.id));
    expect(state.totalBatches).toBe(Math.ceil(count / 30));
    expect(state.completedBatches).toBe(state.totalBatches);
    expect(maxReads).toBe(1);
    await Bun.sleep(10);
    expect(batches).toHaveLength(Math.ceil(count / 30));
    expect(concurrentReads).toBe(0);
    controller.dispose();
  });

  test('a failed second batch preserves the first 30 proposals and never starts the third', async () => {
    const input = items(61);
    let starts = 0;
    const controller = new QuickProjectNameRun(async request => {
      if (request.operation === 'start') return running(`job-${++starts}`);
      return starts === 1 ? completed('job-1', input.slice(0, 30))
        : { id: 'job-2', state: 'failed', results: [], error: 'provider failure' };
    }, () => {}, 1);
    await controller.start(input);
    expect(controller.snapshot().phase).toBe('failed');
    expect(controller.snapshot().results.map(result => result.id)).toEqual(input.slice(0, 30).map(item => item.id));
    expect(controller.snapshot().error).toBe('provider failure');
    expect(starts).toBe(2);
    controller.dispose();
  });

  test('cancellation waits for the real cancel receipt and terminal read, preserving prior proposals', async () => {
    const input = items(61);
    const cancelReceipt = deferred<QuickLabelJob>();
    const terminalReceipt = deferred<QuickLabelJob>();
    const calls: QuickNameRequest[] = [];
    let starts = 0;
    let cancelSent = false;
    const controller = new QuickProjectNameRun(async request => {
      calls.push(request);
      if (request.operation === 'start') return running(`job-${++starts}`);
      if (request.operation === 'cancel') { cancelSent = true; return cancelReceipt.promise; }
      if (starts === 1) return completed('job-1', input.slice(0, 30));
      return terminalReceipt.promise;
    }, () => {}, 2);
    const done = controller.start(input);
    await until(() => starts === 2);
    const cancelling = controller.cancel();
    await until(() => cancelSent);
    expect(controller.snapshot().phase).toBe('cancelling');
    expect(controller.snapshot().results).toHaveLength(30);
    await Bun.sleep(10);
    expect(starts).toBe(2);
    cancelReceipt.resolve(running('job-2'));
    await until(() => calls.filter(call => call.operation === 'read').length === 2);
    expect(controller.snapshot().phase).toBe('cancelling');
    terminalReceipt.resolve({ id: 'job-2', state: 'cancelled', results: [], error: '취소되었습니다.' });
    await Promise.all([done, cancelling]);
    expect(controller.snapshot().phase).toBe('cancelled');
    expect(controller.snapshot().results).toHaveLength(30);
    const settledCalls = calls.length;
    await Bun.sleep(15);
    expect(starts).toBe(2);
    expect(calls).toHaveLength(settledCalls);
    controller.dispose();
  });

  test('cancel during a slow read prevents a late completed receipt from starting the next batch', async () => {
    const input = items(61);
    const read = deferred<QuickLabelJob>();
    let starts = 0; let reads = 0;
    const controller = new QuickProjectNameRun(async request => {
      if (request.operation === 'start') return running(`job-${++starts}`);
      if (request.operation === 'cancel') throw new Error('already completed: should not cancel');
      reads += 1;
      return read.promise;
    }, () => {}, 1);
    const done = controller.start(input);
    await until(() => reads === 1);
    const cancel = controller.cancel();
    await Bun.sleep(10);
    expect(reads).toBe(1);
    expect(controller.snapshot().phase).toBe('cancelling');
    read.resolve(completed('job-1', input.slice(0, 30)));
    await Promise.all([done, cancel]);
    expect(controller.snapshot().phase).toBe('cancelled');
    expect(controller.snapshot().results).toHaveLength(30);
    expect(starts).toBe(1);
    controller.dispose();
  });

  test('an uncertain start is never retried, and cancellation waits for an in-flight start response', async () => {
    const receipt = deferred<QuickLabelJob>();
    let starts = 0; let cancels = 0;
    const controller = new QuickProjectNameRun(async request => {
      if (request.operation === 'start') { starts += 1; return receipt.promise; }
      if (request.operation === 'cancel') { cancels += 1; return { id: 'job-1', state: 'cancelled', results: [], error: null }; }
      throw new Error('unexpected read');
    }, () => {}, 1);
    const done = controller.start(items(31));
    const cancel = controller.cancel();
    expect(cancels).toBe(0);
    receipt.resolve(running('job-1'));
    await Promise.all([done, cancel]);
    expect(cancels).toBe(1);
    expect(starts).toBe(1);
    expect(controller.snapshot().phase).toBe('cancelled');
    controller.dispose();

    let failedStarts = 0;
    const uncertain = new QuickProjectNameRun(async () => { failedStarts += 1; throw new Error('lost start response'); }, () => {}, 1);
    await uncertain.start(items(61));
    expect(uncertain.snapshot().phase).toBe('uncertain');
    await uncertain.refresh();
    await uncertain.start(items(61));
    expect(failedStarts).toBe(1);
    uncertain.dispose();
  });

  test('read failure keeps prior proposals and explicit refresh reads the same job before continuing', async () => {
    const input = items(31); const calls: QuickNameRequest[] = [];
    let starts = 0; let failRead = true;
    const controller = new QuickProjectNameRun(async request => {
      calls.push(request);
      if (request.operation === 'start') return running(`job-${++starts}`);
      if (starts === 1) return completed('job-1', input.slice(0, 30));
      if (failRead) { failRead = false; throw new Error('read unavailable'); }
      return completed('job-2', input.slice(30));
    }, () => {}, 1);
    await controller.start(input);
    expect(controller.snapshot().phase).toBe('uncertain');
    expect(controller.snapshot().results).toHaveLength(30);
    const before = calls.length;
    await Bun.sleep(10);
    expect(calls).toHaveLength(before);
    await controller.refresh();
    expect(calls[before]).toEqual({ operation: 'read', id: 'job-2' });
    expect(controller.snapshot().phase).toBe('completed');
    expect(controller.snapshot().results.map(result => result.id)).toEqual(input.map(item => item.id));
    expect(starts).toBe(2);
    controller.dispose();
  });

  test('a failed cancel stays unconfirmed; refresh uses read without repeating cancel or starting another batch', async () => {
    let starts = 0; let cancels = 0;
    const controller = new QuickProjectNameRun(async request => {
      if (request.operation === 'start') return running(`job-${++starts}`);
      if (request.operation === 'cancel') { cancels += 1; throw new Error('cancel receipt lost'); }
      return { id: 'job-1', state: 'cancelled', results: [], error: null };
    }, () => {}, 10);
    const done = controller.start(items(61));
    await controller.cancel(); await done;
    expect(controller.snapshot().phase).toBe('uncertain');
    expect(starts).toBe(1); expect(cancels).toBe(1);
    await controller.refresh();
    expect(controller.snapshot().phase).toBe('cancelled');
    expect(starts).toBe(1); expect(cancels).toBe(1);
    controller.dispose();
  });

  test('actual owner disposal cancels the known job, stops chunks and removes future notifications', async () => {
    const calls: QuickNameRequest[] = []; let notifications = 0;
    const controller = new QuickProjectNameRun(async request => {
      calls.push(request);
      return request.operation === 'start' ? running('job-1')
        : { id: 'job-1', state: 'cancelled', results: [], error: null };
    }, () => { notifications += 1; }, 10);
    const done = controller.start(items(61));
    await until(() => controller.snapshot().activeJobId === 'job-1');
    controller.dispose();
    const before = notifications;
    await done; await Bun.sleep(15);
    expect(notifications).toBe(before);
    expect(calls.map(call => call.operation)).toEqual(['start', 'cancel']);
  });
});
