import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CodexAutoRememberCoordinator,
  type CodexAutoRememberCheckpointResult,
  type CodexAutoRememberMemoryState,
  type CodexAutoRememberProject,
} from '../src/codexAutoRememberCoordinator';
import type { CodexAutoRememberObservation } from '../src/codexAutoRememberContract';

const observation = (overrides: Partial<CodexAutoRememberObservation> = {}): CodexAutoRememberObservation => ({
  sessionId: 'session-1',
  cwd: '/work/project',
  usedPercent: 51,
  capturedAt: '2026-09-05T01:00:00.000Z',
  turnState: 'complete',
  turnId: 'turn-1',
  turnCompletedAt: '2026-09-05T01:00:01.000Z',
  ...overrides,
});

const project: CodexAutoRememberProject = {
  projectId: 'project-1',
  projectName: 'Project One',
  projectRoot: '/work/project',
};

async function withCoordinator(
  run: (fixture: {
    coordinator: CodexAutoRememberCoordinator;
    observations: CodexAutoRememberObservation[];
    memory: CodexAutoRememberMemoryState;
    checkpoints: number[];
    setResult(result: CodexAutoRememberCheckpointResult): void;
    stateFile: string;
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-auto-remember-'));
  const stateFile = join(root, 'state.json');
  const observations: CodexAutoRememberObservation[] = [];
  const memory: CodexAutoRememberMemoryState = { exists: true, needsRemember: true, autoBackup: true };
  const checkpoints: number[] = [];
  let result: CodexAutoRememberCheckpointResult = { localSaved: true, remoteBackedUp: true };
  let now = new Date('2026-09-05T00:00:00.000Z');
  const make = () => new CodexAutoRememberCoordinator({
    stateFile,
    listObservations: () => observations,
    resolveProject: () => project,
    inspectMemory: () => memory,
    checkpoint: async ({ threshold }) => {
      checkpoints.push(threshold);
      return result;
    },
    now: () => now,
  });
  const coordinator = make();
  try {
    await run({
      coordinator,
      observations,
      memory,
      checkpoints,
      setResult(next) { result = next; },
      stateFile,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Codex automatic remember coordinator', () => {
  test('is opt-in and ignores completed rollouts from before it was enabled', async () => {
    await withCoordinator(async ({ coordinator, observations, checkpoints }) => {
      observations.push(observation({
        capturedAt: '2026-09-04T23:00:00.000Z',
        turnCompletedAt: '2026-09-04T23:00:01.000Z',
      }));
      await coordinator.tick();
      expect(checkpoints).toEqual([]);

      coordinator.setEnabled(true);
      await coordinator.tick();
      expect(checkpoints).toEqual([]);
      expect(coordinator.status().sessions[0]).toMatchObject({
        phase: 'observing',
        nextThreshold: 50,
      });
    });
  });

  test('waits for a real task_complete after opt-in before saving once', async () => {
    await withCoordinator(async ({ coordinator, observations, checkpoints }) => {
      coordinator.setEnabled(true);
      observations.push(observation({
        turnState: 'running',
        turnId: 'turn-2',
        turnCompletedAt: null,
      }));
      await coordinator.tick();
      expect(checkpoints).toEqual([]);
      expect(coordinator.status().sessions[0]?.phase).toBe('waiting-for-turn');

      observations[0] = observation({
        turnId: 'turn-2',
        turnCompletedAt: '2026-09-05T01:00:01.000Z',
      });
      await coordinator.tick();
      await coordinator.tick();
      expect(checkpoints).toEqual([50]);
      expect(coordinator.status().sessions[0]).toMatchObject({
        phase: 'saved',
        lastCheckpointThreshold: 50,
      });
    });
  });

  test('requires exact project binding, initialized memory, and actual project changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-auto-remember-gates-'));
    const stateFile = join(root, 'state.json');
    const rows = [observation()];
    let resolved: CodexAutoRememberProject | null = null;
    let memory: CodexAutoRememberMemoryState = { exists: true, needsRemember: true, autoBackup: true };
    let calls = 0;
    const coordinator = new CodexAutoRememberCoordinator({
      stateFile,
      listObservations: () => rows,
      resolveProject: () => resolved,
      inspectMemory: () => memory,
      checkpoint: async () => {
        calls += 1;
        return { localSaved: true, remoteBackedUp: true };
      },
      now: () => new Date('2026-09-05T00:00:00.000Z'),
    });
    try {
      coordinator.setEnabled(true);
      await coordinator.tick();
      expect(coordinator.status().sessions[0]?.phase).toBe('waiting-for-project');

      resolved = project;
      memory = { exists: false, needsRemember: false, autoBackup: true };
      await coordinator.tick();
      expect(coordinator.status().sessions[0]?.message).toContain('초기화되지 않아');

      memory = { exists: true, needsRemember: false, autoBackup: true };
      await coordinator.tick();
      expect(coordinator.status().sessions[0]?.phase).toBe('waiting-for-changes');
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses 50, 75, and 90 percent receipts and persists duplicate fences', async () => {
    await withCoordinator(async ({ coordinator, observations, memory, checkpoints, stateFile }) => {
      coordinator.setEnabled(true);
      observations.push(observation());
      await coordinator.tick();
      expect(checkpoints).toEqual([50]);

      memory.needsRemember = true;
      observations[0] = observation({
        usedPercent: 76,
        capturedAt: '2026-09-05T02:00:00.000Z',
        turnId: 'turn-2',
        turnCompletedAt: '2026-09-05T02:00:01.000Z',
      });
      await coordinator.tick();
      expect(checkpoints).toEqual([50, 75]);

      const restarted = new CodexAutoRememberCoordinator({
        stateFile,
        listObservations: () => observations,
        resolveProject: () => project,
        inspectMemory: () => memory,
        checkpoint: async ({ threshold }) => {
          checkpoints.push(threshold);
          return { localSaved: true, remoteBackedUp: true };
        },
        now: () => new Date('2026-09-05T03:00:00.000Z'),
      });
      await restarted.tick();
      expect(checkpoints).toEqual([50, 75]);

      observations[0] = observation({
        usedPercent: 91,
        capturedAt: '2026-09-05T04:00:00.000Z',
        turnId: 'turn-3',
        turnCompletedAt: '2026-09-05T04:00:01.000Z',
      });
      await restarted.tick();
      expect(checkpoints).toEqual([50, 75, 90]);

      observations[0] = observation({
        usedPercent: 30,
        capturedAt: '2026-09-05T05:00:00.000Z',
        turnId: 'turn-4',
        turnCompletedAt: '2026-09-05T05:00:01.000Z',
      });
      await restarted.tick();
      observations[0] = observation({
        usedPercent: 51,
        capturedAt: '2026-09-05T06:00:00.000Z',
        turnId: 'turn-5',
        turnCompletedAt: '2026-09-05T06:00:01.000Z',
      });
      await restarted.tick();
      expect(checkpoints).toEqual([50, 75, 90, 50]);
    });
  });

  test('treats an authoritative local save as complete while surfacing backup failure', async () => {
    await withCoordinator(async ({ coordinator, observations, checkpoints, setResult }) => {
      coordinator.setEnabled(true);
      setResult({ localSaved: true, remoteBackedUp: false, backupError: 'offline' });
      observations.push(observation());
      await coordinator.tick();
      expect(checkpoints).toEqual([50]);
      expect(coordinator.status().sessions[0]).toMatchObject({
        phase: 'saved',
        backupWarning: 'offline',
      });
    });
  });

  test('coalesces skipped thresholds and keeps a hard-failure fence across sidecar restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-auto-remember-coalesce-'));
    const stateFile = join(root, 'state.json');
    const rows = [observation({ usedPercent: 91 })];
    const calls: number[] = [];
    let fail = true;
    const coordinator = new CodexAutoRememberCoordinator({
      stateFile,
      listObservations: () => rows,
      resolveProject: () => project,
      inspectMemory: () => ({ exists: true, needsRemember: true, autoBackup: true }),
      checkpoint: async ({ threshold }) => {
        calls.push(threshold);
        if (fail) throw Object.assign(new Error('CLI unavailable'), { autoRememberNotStarted: true });
        return { localSaved: true, remoteBackedUp: true };
      },
      now: () => new Date('2026-09-05T00:00:00.000Z'),
    });
    try {
      coordinator.setEnabled(true);
      await coordinator.tick();
      await coordinator.tick();
      expect(calls).toEqual([90]);
      expect(coordinator.status().sessions[0]?.phase).toBe('failed');

      const restarted = new CodexAutoRememberCoordinator({
        stateFile,
        listObservations: () => rows,
        resolveProject: () => project,
        inspectMemory: () => ({ exists: true, needsRemember: true, autoBackup: true }),
        checkpoint: async ({ threshold }) => {
          calls.push(threshold);
          if (fail) throw Object.assign(new Error('CLI unavailable'), { autoRememberNotStarted: true });
          return { localSaved: true, remoteBackedUp: true };
        },
        now: () => new Date('2026-09-05T01:00:00.000Z'),
      });
      await restarted.tick();
      expect(calls).toEqual([90]);
      expect(restarted.status().sessions[0]?.phase).toBe('failed');

      fail = false;
      rows[0] = observation({
        usedPercent: 91,
        turnId: 'turn-2',
        turnCompletedAt: '2026-09-05T02:00:01.000Z',
        capturedAt: '2026-09-05T02:00:00.000Z',
      });
      await restarted.tick();
      await restarted.tick();
      expect(calls).toEqual([90, 90]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('V2 ownership pauses a legacy checkpoint without consuming its turn or reporting a save',async()=>{
 await withCoordinator(async({coordinator,observations,memory,checkpoints})=>{
  coordinator.setEnabled(true);observations.push(observation());memory.managedExternally=true;
  await coordinator.tick();expect(checkpoints).toEqual([]);expect(coordinator.settings().enabled).toBe(true);
  expect(coordinator.status().sessions[0]).toMatchObject({phase:'observing',lastCheckpointAt:null,nextThreshold:50});
  memory.managedExternally=false;await coordinator.tick();expect(checkpoints).toEqual([50]);
 });
});
