import { expect, test } from 'bun:test';
import { waitForCodexProjectReadiness } from '../src/codexProjectReadiness';
import type { ContextSessionMetadata } from '../src/contextSessionMetadata';

function fixture(selectedAt = Infinity) {
  let clock = 0;
  const metadata = new Map<string, ContextSessionMetadata>();
  const input = {
    existingThreadIds: new Set<string>(),
    readMetadata: () => ({ metadata, availability: 'fresh' as const }),
    isSelectedProject: () => clock >= selectedAt,
    matchesPath: (path: string | null) => path === '/project',
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  };
  return { input, metadata, elapsed: () => clock };
}

test('reproduces the six-second timeout while a cold desktop is still selecting the project', async () => {
  const f = fixture(8_000);
  expect(await waitForCodexProjectReadiness({ ...f.input, timeoutMs: 6_000 })).toBeNull();
  expect(f.elapsed()).toBe(6_000);
});

test('waits past six seconds for the exact selected project without requiring an unsent thread ID', async () => {
  const f = fixture(8_000);
  expect(await waitForCodexProjectReadiness(f.input)).toEqual({
    projectTaskId: null, readiness: 'selected-project',
  });
  expect(f.elapsed()).toBe(8_000);
});

test('never accepts an unconfirmed project, even when the desktop is online', async () => {
  const f = fixture();
  expect(await waitForCodexProjectReadiness(f.input)).toBeNull();
  expect(f.elapsed()).toBe(20_000);
});

const entry = (path = '/project', moveState: 'applied' | 'pending' = 'applied'): ContextSessionMetadata => ({
  threadTitle: null,
  projectHint: { name: null, path, source: 'chatgpt-local-project', moveState, appliedPath: path, pendingPath: null },
});

test('requires a fresh, new, applied assignment to this exact folder', async () => {
  for (const kind of ['existing', 'other-folder', 'pending', 'cached', 'unavailable'] as const) {
    const f = fixture();
    f.metadata.set('thread', entry(kind === 'other-folder' ? '/other' : '/project', kind === 'pending' ? 'pending' : 'applied'));
    if (kind === 'existing') f.input.existingThreadIds.add('thread');
    expect(await waitForCodexProjectReadiness({
      ...f.input, timeoutMs: 1_000,
      readMetadata: () => ({ metadata: f.metadata, availability: kind === 'cached' || kind === 'unavailable' ? kind : 'fresh' }),
    })).toBeNull();
  }
  const f = fixture();
  f.metadata.set('fresh', entry());
  expect(await waitForCodexProjectReadiness(f.input)).toEqual({ projectTaskId: 'fresh', readiness: 'new-task' });
});

test('checks selection at the deadline and keeps already-selected drafts settled before submission', async () => {
  for (const [selectedAt, expectedElapsed] of [[0, 1_000], [20_000, 20_000]] as const) {
    const f = fixture(selectedAt);
    expect(await waitForCodexProjectReadiness(f.input)).not.toBeNull();
    expect(f.elapsed()).toBe(expectedElapsed);
  }
});
