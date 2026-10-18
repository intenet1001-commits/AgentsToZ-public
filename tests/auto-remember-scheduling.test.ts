import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAutoRememberCoordinator } from '../src/codexAutoRememberCoordinator';
import { MemorySaveDispatcher } from '../src/memorySaveDispatcher';

test('checkpoint deferred by a manual save resumes after restart without an ambiguous-attempt fence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-dispatch-restart-'));
  let now = Date.parse('2026-09-07T00:00:00Z'); let calls = 0; let release!: () => void;
  const dispatcher = new MemorySaveDispatcher();
  const manual = dispatcher.schedule({ root: '/work/project', trigger: 'manual', run: () => new Promise<void>(resolve => { release = resolve; }) });
  await Promise.resolve();
  const make = () => new CodexAutoRememberCoordinator({
    stateFile: join(root, 'state.json'), now: () => new Date(now),
    listObservations: () => [{ sessionId: 's', cwd: '/work/project', usedPercent: 55,
      capturedAt: '2026-09-07T01:00:00Z', turnState: 'complete', turnId: 't', turnCompletedAt: '2026-09-07T01:00:00Z' }],
    resolveProject: () => ({ projectId: 'p', projectName: 'P', projectRoot: '/work/project' }),
    inspectMemory: () => ({ exists: true, needsRemember: true, autoBackup: false }),
    checkpoint: () => dispatcher.schedule({ root: '/work/project', trigger: 'checkpoint', run: async () => {
      calls++; return { localSaved: true, remoteBackedUp: false, backupSkipped: true };
    } }),
  });
  try {
    const first = make(); first.setEnabled(true); await first.tick();
    expect(first.status().sessions[0]?.phase).toBe('retrying'); expect(calls).toBe(0);
    release(); await manual;
    const restarted = make(); await restarted.tick(); expect(calls).toBe(0);
    now += 30_000; await restarted.tick(); await restarted.tick(); expect(calls).toBe(1);
    await make().tick(); expect(calls).toBe(1);
  } finally { release(); await manual; rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ['busy', 'dispatch', 'inspection'] as const) {
  test(`a project with ${failure} failure cannot starve another completed session`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-save-fairness-'));
    let now = Date.parse('2026-09-07T00:00:00Z');
    const saved: string[] = [];
    const coordinator = new CodexAutoRememberCoordinator({
      stateFile: join(root, 'state.json'), now: () => new Date(now),
      listObservations: () => ['blocked', 'ready'].map((sessionId, index) => ({
        sessionId, cwd: `/work/${sessionId}`, usedPercent: 55,
        capturedAt: `2026-09-07T01:00:0${2 - index}Z`,
        turnState: 'complete', turnId: 'turn-1', turnCompletedAt: '2026-09-07T01:00:00Z',
      })),
      resolveProject: row => ({ projectId: row.sessionId, projectName: row.sessionId, projectRoot: row.cwd }),
      inspectMemory: project => {
        if (failure === 'inspection' && project.projectId === 'blocked') throw new Error('unreadable memory');
        return { exists: true, needsRemember: true, autoBackup: false };
      },
      checkpoint: async ({ project }) => {
        if (project.projectId === 'blocked') throw Object.assign(new Error('busy'), { code: failure === 'dispatch' ? 'MEMORY_SAVE_BUSY' : 'WORKSPACE_LEASE_BUSY' });
        saved.push(project.projectId);
        return { localSaved: true, remoteBackedUp: true };
      },
    });
    try {
      coordinator.setEnabled(true);
      for (let tick = 0; tick < 3; tick++) { await coordinator.tick(); now += 30_000; }
      expect(saved).toEqual(['ready']);
      expect(coordinator.status().sessions.find(row => row.sessionId === 'blocked')?.message)
        .toContain(failure === 'inspection' ? 'unreadable memory' : '작업공간');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('more than 256 failed sessions retain their fences across restart without a growing JSON cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-save-fences-'));
  const stateFile = join(root, 'state.json');
  let sessionId = 'session-0';
  let calls = 0;
  const make = () => new CodexAutoRememberCoordinator({
    stateFile, now: () => new Date('2026-09-07T00:00:00Z'),
    listObservations: () => [{ sessionId, cwd: '/work/project', usedPercent: 55,
      capturedAt: '2026-09-07T01:00:00Z', turnState: 'complete',
      turnId: 'turn-1', turnCompletedAt: '2026-09-07T01:00:00Z' }],
    resolveProject: () => ({ projectId: 'project', projectName: 'Project', projectRoot: '/work/project' }),
    inspectMemory: () => ({ exists: true, needsRemember: true, autoBackup: false }),
    checkpoint: async () => { calls++; throw Object.assign(new Error('CLI failed'), { autoRememberNotStarted: true }); },
  });
  try {
    const coordinator = make(); coordinator.setEnabled(true);
    for (let index = 0; index < 300; index++) { sessionId = `session-${index}`; await coordinator.tick(); }
    expect(calls).toBe(300);
    expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).attempts)).toHaveLength(0);
    sessionId = 'session-0';
    const restarted = make(); await restarted.tick();
    expect(calls).toBe(300);
    expect(restarted.status().sessions[0]?.phase).toBe('failed');
    restarted.setEnabled(false); restarted.setEnabled(true); await restarted.tick();
    expect(calls).toBe(301);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
