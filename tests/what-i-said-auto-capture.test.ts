import { expect, test } from 'bun:test';
import { WhatISaidAutoCapture } from '../src/whatISaidAutoCapture';

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
