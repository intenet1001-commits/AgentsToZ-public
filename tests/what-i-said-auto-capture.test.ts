import { expect, test } from 'bun:test';
import { WhatISaidAutoCapture, resolveWhatISaidCaptureHint } from '../src/whatISaidAutoCapture';

function hintDependencies() {
  const calls: string[] = [];
  return {
    calls,
    targets: async () => [{ targetId: 'linked-target', cwd: '/repository-worktree' }],
    resolveTarget: async (id: string) => {
      calls.push(`resolve:${id}`);
      return { cwd: '/repository-worktree', revalidate: async () => {
        calls.push('revalidate'); return { cwd: '/repository-worktree' };
      } };
    },
    identity: async (cwd: string) => {
      calls.push(`identity:${cwd}`);
      return { exists: true, projectRoot: '/repository', config: { memoryId: 'z' } };
    },
    pathKey: (path: string) => path,
  };
}

test('an active linked Workroom gets canonical capture priority and partial continuation without starving rotation', async () => {
  const dependencies = hintDependencies();
  const captured: string[] = [];
  const runner = new WhatISaidAutoCapture({ enabled: () => true,
    projects: async () => [{ id: 'a', projectRoot: '/unrelated' }, { id: 'z', projectRoot: '/repository' }],
    resolveHint: root => resolveWhatISaidCaptureHint(root, dependencies),
    capture: async root => { captured.push(root); return { hasMore: root === '/repository' }; }, failed() {} });
  for (let i = 0; i < 500; i++) runner.request('/repository-worktree');
  expect(dependencies.calls).toEqual([]); // No discovery on keystrokes.
  await runner.tick(); await runner.tick(); await runner.tick();
  expect(captured).toEqual(['/repository', '/unrelated', '/repository']);
  expect(dependencies.calls).toEqual(['resolve:linked-target', 'identity:/repository-worktree',
    'revalidate', 'identity:/repository-worktree']);
});

for (const mode of ['unregistered', 'ambiguous'] as const) {
  test(`does not use an ${mode} checkout even if it contains copied memory metadata`, async () => {
    const dependencies = hintDependencies();
    dependencies.targets = async () => mode === 'unregistered' ? [] : [
      { targetId: 'one', cwd: '/repository-worktree' }, { targetId: 'two', cwd: '/repository-worktree' },
    ];
    expect(await resolveWhatISaidCaptureHint('/repository-worktree', dependencies)).toBeNull();
    expect(dependencies.calls).toEqual([]);
  });
}

for (const mode of ['moved-before-proof', 'moved-after-proof', 'memory-rebound', 'memory-removed', 'root-rebound'] as const) {
  test(`rejects a queued checkout hint after ${mode}`, async () => {
    const dependencies = hintDependencies();
    if (mode.startsWith('moved')) dependencies.resolveTarget = async () => ({
      cwd: mode === 'moved-before-proof' ? '/replacement' : '/repository-worktree',
      revalidate: async () => ({ cwd: '/replacement' }),
    });
    let reads = 0;
    dependencies.identity = async () => ({
      exists: ++reads === 1 || mode !== 'memory-removed',
      projectRoot: reads > 1 && mode === 'root-rebound' ? '/other' : '/repository',
      config: { memoryId: reads > 1 && mode === 'memory-rebound' ? 'other' : 'z' },
    });
    expect(await resolveWhatISaidCaptureHint('/repository-worktree', dependencies)).toBeNull();
  });
}

test('revoked checkout proof cannot choose a memory, and a stale canonical snapshot is rejected', async () => {
  const captured: string[] = [];
  const dependencies = hintDependencies();
  dependencies.resolveTarget = async () => { throw Error('registration revoked'); };
  let failures = 0;
  const runner = new WhatISaidAutoCapture({ enabled: () => true,
    projects: async () => [{ id: 'a', projectRoot: '/unrelated' }, { id: 'b', projectRoot: '/second' },
      { id: 'changed', projectRoot: '/repository' }],
    resolveHint: root => root === '/revoked' ? resolveWhatISaidCaptureHint(root, {
      ...dependencies, targets: async () => [{ targetId: 'revoked', cwd: '/revoked' }],
    }) : Promise.resolve({ id: 'z', projectRoot: '/repository' }),
    capture: async root => { captured.push(root); }, failed() { failures++; } });
  runner.request('/revoked'); runner.request('/repository-worktree');
  await runner.tick(); await runner.tick();
  expect(failures).toBe(1);
  expect(captured).toEqual(['/unrelated', '/second']); // Ordinary fair rotation only.
});

test('a stale hint backlog resolves at most one checkout per tick while canonical hints still progress', async () => {
  let resolutions = 0;
  const captured: string[] = [];
  const runner = new WhatISaidAutoCapture({ enabled: () => true,
    projects: async () => [{ id: 'a', projectRoot: '/unrelated' }, { id: 'z', projectRoot: '/repository' }],
    resolveHint: async () => { resolutions++; return null; },
    capture: async root => { captured.push(root); }, failed() {} });
  for (let i = 0; i < 30; i++) runner.request(`/stale-${i}`);
  runner.request('/repository');
  await runner.tick();
  expect(resolutions).toBe(1); expect(captured).toEqual(['/repository']);
  await runner.tick();
  expect(resolutions).toBe(1); expect(captured).toEqual(['/repository', '/unrelated']);
  await runner.tick(); expect(resolutions).toBe(2);
});

test('opt-out during linked checkout proof cancels capture and overlapping ticks do not duplicate the proof', async () => {
  let enabled = true, resolutions = 0, captures = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const runner = new WhatISaidAutoCapture({ enabled: () => enabled,
    projects: async () => [{ id: 'z', projectRoot: '/repository' }],
    resolveHint: async () => { resolutions++; await waiting; return { id: 'z', projectRoot: '/repository' }; },
    capture: async () => { captures++; }, failed() {} });
  runner.request('/repository-worktree'); const first = runner.tick();
  await Promise.resolve(); await runner.tick();
  expect(resolutions).toBe(1);
  enabled = false; release(); await first;
  expect(captures).toBe(0);
});

test('Workroom activity gets priority without starving rotation, duplicating hints or retaining removed projects', async () => {
  const captured: string[] = [];
  const runner = new WhatISaidAutoCapture({ enabled: () => true,
    projects: async () => [{ id: 'a', projectRoot: '/a' }, { id: 'b', projectRoot: '/b' }, { id: 'z', projectRoot: '/z' }],
    capture: async root => { captured.push(root); return { hasMore: root === '/z' }; }, failed() {} });
  runner.request('/removed');
  for (let index = 0; index < 1000; index++) runner.request('/z');
  for (let index = 0; index < 4; index++) await runner.tick();
  expect(captured).toEqual(['/z', '/a', '/z', '/b']);
});

test('capture hints are bounded and cleared by opt-out', async () => {
  let enabled = true;
  const captured: string[] = [];
  const runner = new WhatISaidAutoCapture({ enabled: () => enabled,
    projects: async () => Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(3, '0'), projectRoot: '/' + i })),
    capture: async root => { captured.push(root); }, failed() {} });
  for (let index = 0; index < 100; index++) runner.request('/' + index);
  await runner.tick(); expect(captured).toEqual(['/36']);
  enabled = false; await runner.tick(); runner.request('/90'); enabled = true;
  await runner.tick(); await runner.tick();
  expect(captured).toEqual(['/36', '/0', '/1']);
});

test('collects without a remember action, rotates fairly, and re-reads registration', async () => {
  let projects = [{ id: 'b', projectRoot: '/b' }, { id: 'a', projectRoot: '/a' }];
  const captured: string[] = [];
  const runner = new WhatISaidAutoCapture({ enabled: () => true,
    projects: async () => projects, capture: async root => { captured.push(root); }, failed() {} });
  await runner.tick(); await runner.tick();
  projects = [{ id: 'c', projectRoot: '/c' }];
  await runner.tick(); await runner.tick();
  expect(captured).toEqual(['/a', '/b', '/c', '/c']);
});

test('disabled capture performs no discovery and opt-out during discovery cancels work', async () => {
  let enabled = false;
  let reads = 0;
  let captures = 0;
  const runner = new WhatISaidAutoCapture({ enabled: () => enabled,
    projects: async () => { reads++; enabled = false; return [{ id: 'a', projectRoot: '/a' }]; },
    capture: async () => { captures++; }, failed() {} });
  await runner.tick(); expect(reads).toBe(0);
  enabled = true; await runner.tick();
  expect(reads).toBe(1); expect(captures).toBe(0);
});

test('slow or failed captures do not overlap or starve another project', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const captured: string[] = [];
  let failures = 0;
  const runner = new WhatISaidAutoCapture({ enabled: () => true,
    projects: async () => [{ id: 'a', projectRoot: '/a' }, { id: 'b', projectRoot: '/b' }],
    capture: async root => { captured.push(root); if (root === '/a') { await waiting; throw Error('unavailable'); } },
    failed() { failures++; } });
  const first = runner.tick();
  await Promise.resolve();
  await runner.tick();
  expect(captured).toEqual(['/a']);
  release(); await first; await runner.tick();
  expect(captured).toEqual(['/a', '/b']); expect(failures).toBe(1);
});
