import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {mergePortSnapshots} from '../src/ports-merge';
import {applyPortAiLabelPatches, type PortAiLabelPatch, type PortAiLabelPatchResult} from '../src/portAiLabelPatch';
import {mergePortAiLabelReceipt, portAiLabelExpected, readPortAiLabelReceipt, rebasePortAiLabelReceipt} from '../src/portAiLabelView';

// Execute the real App queue methods with an entirely in-memory transport.
// This deliberately uses the production merge and patch implementations too:
// a forgiving mock that never recreates changed rows would hide this regression.
// No App render, .env, sidecar, project file, model or Supabase is involved.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const queueStart = appSource.indexOf('let portsSaveBaseline:');
const queueEnd = appSource.indexOf('  async createGitHubRepository(');
if (queueStart < 0 || queueEnd <= queueStart) throw new Error('App persistence API extraction boundary changed');
const queueFactory = new Function(
  'fetch', 'invoke', 'isTauri', 'portsWriterId', 'readPortAiLabelReceipt',
  'mergePortAiLabelReceipt', 'rebasePortAiLabelReceipt',
  new Bun.Transpiler({loader: 'ts'}).transformSync(
    appSource.slice(queueStart, queueEnd) + `};
      return {API, snapshot: () => ({baseline: clonePorts(portsSaveBaseline ?? []), pending: pendingPortSaves.size}),
        settled: () => portsSaveQueue};`,
  ),
);

type Row = {
  id: string; name: string; folderPath?: string; aiName?: string; category?: string;
  description?: string; favorite?: boolean; memo?: string; future?: unknown;
};
type QueueApi = {
  loadPorts(): Promise<Row[]>;
  savePorts(rows: Row[]): Promise<void>;
  applyAiLabels(patches: PortAiLabelPatch[], onReceipt: (result: PortAiLabelPatchResult) => void): Promise<PortAiLabelPatchResult>;
};
type Operation = 'load' | 'save' | 'labels';
type Gate = {entered: Promise<void>; enter(): void; wait: Promise<void>; release(): void};
function gate(): Gate {
  let enter!: () => void, release!: () => void;
  return {entered: new Promise<void>(resolve => {enter = resolve;}), enter: () => enter(),
    wait: new Promise<void>(resolve => {release = resolve;}), release: () => release()};
}
const original: Row = {id: 'queue-project', name: 'Project', folderPath: '/fixture/project',
  aiName: 'Old alias', category: 'Old category', description: 'Original description', favorite: false};
const proposal = (row = original): PortAiLabelPatch => ({id: row.id, expected: portAiLabelExpected(row),
  desired: {aiName: 'AI alias', category: 'AI category'}});
const clone = <T>(value: T): T => structuredClone(value);

async function fixture(initial: Row[] = [original], native = false) {
  let disk = clone(initial);
  const gates: Record<Operation, Gate[]> = {load: [], save: [], labels: []};
  const failures = new Map<Operation, 'before' | 'malformed-after-commit'>();
  const calls: Array<{operation: Operation; body?: any}> = [];
  const order: string[] = [];
  const transports: Array<{kind: string; name: string}> = [];
  const perform = async (operation: Operation, body?: any): Promise<unknown> => {
    calls.push({operation, body: clone(body)}); order.push(operation + ':start');
    const hold = gates[operation].shift();
    const failure = failures.get(operation); failures.delete(operation);
    if (failure === 'before') {order.push(operation + ':failure'); throw new Error('fixture transport failure');}
    // Capture a read/commit before delaying delivery, as a slow response can do.
    let result: unknown;
    if (operation === 'load') result = clone(disk);
    else if (operation === 'labels') {
      const receipt = applyPortAiLabelPatches(disk, body);
      disk = receipt.ports;
      result = failure === 'malformed-after-commit' ? {success: true} : {success: true, ...clone(receipt)};
    }
    if (hold) {hold.enter(); await hold.wait;}
    if (operation === 'save') {
      disk = mergePortSnapshots(body.basePorts, body.ports, disk);
      result = {success: true};
    }
    order.push(operation + ':done');
    return result;
  };
  const fetch = async (url: string, options?: RequestInit) => {
    const path = new URL(url, 'http://fixture.invalid').pathname;
    transports.push({kind: 'fetch', name: path});
    if (path === '/api/ports' && !options) return Response.json(await perform('load'));
    const body = JSON.parse(String(options?.body));
    if (path === '/api/ports/merge') return Response.json(await perform('save', body));
    if (path === '/api/ports/ai-labels') return Response.json(await perform('labels', body));
    throw new Error('Unexpected fixture route: ' + path);
  };
  const invoke = async (command: string, body?: unknown) => {
    transports.push({kind: 'invoke', name: command});
    if (command === 'load_ports') return perform('load');
    if (command === 'save_ports_merged') {await perform('save', body); return;}
    throw new Error('Unexpected fixture command: ' + command);
  };
  const implementation = queueFactory(fetch, invoke, () => native, 'fixture-writer',
    readPortAiLabelReceipt, mergePortAiLabelReceipt, rebasePortAiLabelReceipt) as {
      API: QueueApi; snapshot(): {baseline: Row[]; pending: number}; settled(): Promise<void>;
    };
  const ui = await implementation.API.loadPorts();
  calls.length = 0; order.length = 0; transports.length = 0;
  return {...implementation, ui, calls, order, transports,
    disk: () => clone(disk), replace: (rows: Row[]) => {disk = clone(rows);},
    hold: (operation: Operation) => {const hold = gate(); gates[operation].push(hold); return hold;},
    fail: (operation: Operation, mode: 'before' | 'malformed-after-commit' = 'before') => failures.set(operation, mode)};
}

describe('App AI label receipt and ordinary persistence queue', () => {
  test.each([false, true])('queued old snapshots retain acknowledged labels and never replay them as new edits (native=%s)', async native => {
    const f = await fixture([original], native);
    const patch = proposal(); let ui = f.ui;
    const receiptGate = f.hold('labels'); const saveGate = f.hold('save');
    const applying = f.API.applyAiLabels([patch], result => {ui = rebasePortAiLabelReceipt(ui, [patch], result);});
    await receiptGate.entered;
    const ordinary = f.API.savePorts(ui);
    receiptGate.release(); await saveGate.entered; await applying;
    const submitted = f.calls.find(call => call.operation === 'save')!.body;
    expect(submitted.basePorts[0].category).toBe('AI category');
    expect(submitted.ports[0].category).toBe('AI category');
    saveGate.release(); await ordinary;
    expect(f.snapshot()).toEqual({baseline: ui, pending: 0});
    // An unrelated later save must not treat the receipt as a fresh user edit.
    f.replace([{...f.disk()[0]!, category: 'Other window choice'}]);
    await f.API.savePorts([{...ui[0]!, favorite: true}]);
    expect(f.disk()[0]).toMatchObject({category: 'Other window choice', favorite: true});
    // The real merge resurrects a deleted row if its baseline falsely says the
    // acknowledged labels are unsaved edits. No other field changes here.
    const desired = f.snapshot().baseline;
    f.replace([]);
    await f.API.savePorts(desired);
    expect(f.disk()).toEqual([]);
    expect(f.transports.some(call => call.name === (native ? 'save_ports_merged' : '/api/ports/merge'))).toBe(true);
  });

  test('receipt rebases only untouched individual labels while preserving queued user edits and other fields', async () => {
    const f = await fixture(); const patch = proposal(); const hold = f.hold('labels');
    const applying = f.API.applyAiLabels([patch], () => {}); await hold.entered;
    const desired = [{...f.ui[0]!, category: 'User choice', memo: 'Unrelated memo', favorite: true}];
    const saving = f.API.savePorts(desired); hold.release(); await applying; await saving;
    expect(f.disk()[0]).toMatchObject({aiName: 'AI alias', category: 'User choice', memo: 'Unrelated memo', favorite: true});
    expect(desired[0]!.aiName).toBe('Old alias'); // The caller's snapshot is not mutated.
    expect(f.snapshot().pending).toBe(0);
  });

  test('a slow load owns its queue slot so its old reply cannot replace a newer receipt baseline', async () => {
    const f = await fixture(); const hold = f.hold('load');
    const loading = f.API.loadPorts(); await hold.entered;
    const applying = f.API.applyAiLabels([proposal()], () => {});
    await Promise.resolve(); await Promise.resolve();
    expect(f.calls.map(call => call.operation)).toEqual(['load']);
    hold.release(); await loading; await applying;
    expect(f.order).toEqual(['load:start', 'load:done', 'labels:start', 'labels:done']);
    expect(f.snapshot().baseline[0]!.category).toBe('AI category');
  });

  test('flushSync may enqueue an old effect snapshot without losing the queue tail or undoing the receipt', async () => {
    const f = await fixture(); let callbackSave: Promise<void> | undefined;
    const order = f.order;
    await f.API.applyAiLabels([proposal()], () => {
      order.push('callback:enter');
      // The App callback synchronously flushes React; an effect it enqueues can
      // still hold the pre-receipt snapshot. A new user event cannot run inside
      // this synchronous callback, so these old label values must be rebased.
      callbackSave = f.API.savePorts([{...original, memo: 'After receipt'}]);
      order.push('callback:exit');
    });
    const loaded = f.API.loadPorts();
    await callbackSave; const rows = await loaded;
    expect(order).toEqual(['labels:start', 'labels:done', 'callback:enter', 'callback:exit', 'save:start', 'save:done', 'load:start', 'load:done']);
    expect(rows[0]).toMatchObject({aiName: 'AI alias', category: 'AI category', memo: 'After receipt'});
    expect(f.snapshot().pending).toBe(0);
  });

  test('an explicit user revert after receipt completion keeps the original labels', async () => {
    const f = await fixture();
    await f.API.applyAiLabels([proposal()], () => {});
    expect(f.disk()[0]!.category).toBe('AI category');
    // The callback and its pending-effect reconciliation have returned before
    // the user can act on the newly committed view.
    await f.API.savePorts([{...original, memo: 'User reverted after receipt'}]);
    expect(f.disk()[0]).toMatchObject({aiName: 'Old alias', category: 'Old category', memo: 'User reverted after receipt'});
    expect(f.snapshot()).toEqual({baseline: f.disk(), pending: 0});
  });

  test('partial receipts preserve skipped edits, queued row deletion, concurrent additions and other-platform rows', async () => {
    const changed = {...original, id: 'changed-project'};
    const removed = {...original, id: 'removed-project'};
    const windows = {...original, id: 'windows-project', folderPath: 'C:\\fixture', future: {keep: true}};
    const f = await fixture([original, changed, removed, windows]);
    f.replace([original, {...changed, category: 'Other window edit'}, windows]);
    const patches = [proposal(original), proposal(changed), proposal(removed)];
    const hold = f.hold('labels');
    const applying = f.API.applyAiLabels(patches, () => {}); await hold.entered;
    // The first row is deleted locally while its successful receipt is held.
    const newRow = {id: 'new-project', name: 'Created during request'};
    const queued = f.API.savePorts([changed, removed, windows, newRow]);
    hold.release(); const receipt = await applying; await queued;
    expect(receipt.appliedIds).toEqual([original.id]);
    expect(receipt.skipped).toEqual([{id: changed.id, reason: 'changed', fields: ['category']}, {id: removed.id, reason: 'missing', fields: []}]);
    expect(f.disk().map(row => row.id).sort()).toEqual([changed.id, windows.id, newRow.id].sort());
    expect(f.disk().find(row => row.id === changed.id)?.category).toBe('Other window edit');
    expect(f.disk().find(row => row.id === windows.id)).toEqual(windows);
    expect(f.snapshot().pending).toBe(0);
  });

  test('a malformed reply after commit never acknowledges or falls back, and an explicit replay repairs the baseline', async () => {
    const f = await fixture(); const patch = proposal(); let callbacks = 0;
    f.fail('labels', 'malformed-after-commit');
    await expect(f.API.applyAiLabels([patch], () => {callbacks++;})).rejects.toThrow('적용 결과를 확인하지 못했습니다');
    expect(callbacks).toBe(0);
    expect(f.calls.map(call => call.operation)).toEqual(['labels']);
    expect(f.disk()[0]!.category).toBe('AI category');
    expect(f.snapshot().baseline[0]!.category).toBe('Old category');
    await f.API.savePorts([{...original, memo: 'Preserve receipt on disk'}]);
    expect(f.disk()[0]).toMatchObject({category: 'AI category', memo: 'Preserve receipt on disk'});
    const receipt = await f.API.applyAiLabels([patch], () => {callbacks++;});
    expect(receipt.unchangedIds).toEqual([original.id]);
    expect(callbacks).toBe(1);
    expect(f.snapshot().baseline[0]).toMatchObject({category: 'AI category', memo: 'Preserve receipt on disk'});
  });

  test('failed ordinary writes release their pending snapshot and do not block later guarded writes', async () => {
    const f = await fixture(); f.fail('save');
    await expect(f.API.savePorts([{...original, category: 'Failed user edit'}])).rejects.toThrow('fixture transport failure');
    expect(f.snapshot()).toEqual({baseline: [original], pending: 0});
    await f.API.applyAiLabels([proposal()], () => {});
    expect(f.disk()[0]!.category).toBe('AI category');
    expect(f.snapshot().pending).toBe(0);
  });

  test('only the exact receipt state skips persistence; a subsequent batched UI edit is saved', async () => {
    const f = await fixture(); const patch = proposal(); let ui = f.ui;
    const skip = {current: null as Row[] | null};
    await f.API.applyAiLabels([patch], result => {
      ui = rebasePortAiLabelReceipt(ui, [patch], result); skip.current = ui;
    });
    // Execute the real save-effect guards, not a copy with more forgiving rules.
    const start = appSource.indexOf('      const receiptState = skipAiLabelSave.current;');
    const end = appSource.indexOf("      if (import.meta.env.DEV) console.log('[App] Saving ports", start);
    if (start < 0 || end < start) throw new Error('App receipt effect guard extraction boundary changed');
    const shouldPersist = new Function('ports', 'skipAiLabelSave', 'skipNextSave', appSource.slice(start, end) + 'return true;');
    expect(shouldPersist(ui, {current: ui}, {current: false})).toBeUndefined();
    const changed = [{...ui[0]!, favorite: true}];
    expect(shouldPersist(changed, skip, {current: false})).toBe(true);
    expect(skip.current).toBeNull();
    await f.API.savePorts(changed);
    expect(f.disk()[0]).toMatchObject({aiName: 'AI alias', category: 'AI category', favorite: true});
  });
});
