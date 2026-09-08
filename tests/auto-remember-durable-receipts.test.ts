import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAutoRememberCoordinator } from '../src/codexAutoRememberCoordinator';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'auto-save-receipt-'));
  const stateFile = join(root, 'state.json');
  const data = { sessionId: 'session-0', calls: 0 };
  const make = (checkpoint?: () => Promise<{ localSaved: boolean; remoteBackedUp: boolean }>) =>
    new CodexAutoRememberCoordinator({
      stateFile, now: () => new Date('2026-09-07T00:00:00Z'),
      listObservations: () => [{ sessionId: data.sessionId, cwd: '/work/project', usedPercent: 55,
        capturedAt: '2026-09-07T01:00:00Z', turnState: 'complete',
        turnId: 'turn-1', turnCompletedAt: '2026-09-07T01:00:00Z' }],
      resolveProject: () => ({ projectId: 'project', projectName: 'Project', projectRoot: '/work/project' }),
      inspectMemory: () => ({ exists: true, needsRemember: true, autoBackup: false }),
      checkpoint: async () => {
        data.calls++;
        return checkpoint ? checkpoint() : { localSaved: true, remoteBackedUp: true };
      },
    });
  return { data, make, stateFile, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('300 successful sessions retain receipts after restart without growing the JSON cache', async () => {
  const f = fixture();
  try {
    const c = f.make(); c.setEnabled(true);
    for (let i = 0; i < 300; i++) { f.data.sessionId = `session-${i}`; await c.tick(); }
    f.data.sessionId = 'session-0';
    const restarted = f.make(); await restarted.tick();
    expect(f.data.calls).toBe(300);
    expect(restarted.status().sessions[0]?.phase).toBe('saved');
    expect(Object.keys(JSON.parse(readFileSync(f.stateFile, 'utf8')).receipts)).toHaveLength(0);
    // A fresh explicit policy activation must work even within the same millisecond.
    restarted.setEnabled(false); restarted.setEnabled(true); await restarted.tick();
    expect(f.data.calls).toBe(301);
  } finally { f.clean(); }
});

test('a durable intent blocks restart and opt-in cycling until its original execution returns', async () => {
  const f = fixture();
  let finish!: (value: { localSaved: boolean; remoteBackedUp: boolean }) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const c = f.make(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  try {
    c.setEnabled(true); const active = c.tick(); await ready;
    const restarted = f.make(); await restarted.tick();
    expect(restarted.status().sessions[0]?.phase).toBe('recovery-required');
    restarted.setEnabled(false); restarted.setEnabled(true); await restarted.tick();
    expect(restarted.status().sessions[0]?.phase).toBe('recovery-required');
    expect(f.data.calls).toBe(1);
    finish({ localSaved: true, remoteBackedUp: true }); await active;
  } finally { f.clean(); }
});

test('receipt commit failure after local save never reports saved or reruns the provider', async () => {
  const f = fixture();
  try {
    const c = f.make(async () => {
      const db = new Database(`${f.stateFile}.attempts.sqlite`);
      db.run("CREATE TRIGGER reject_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END");
      db.close();
      return { localSaved: true, remoteBackedUp: true };
    });
    c.setEnabled(true); await c.tick();
    expect(c.status().sessions[0]?.phase).toBe('recovery-required');
    const restarted = f.make(); await restarted.tick();
    expect(restarted.status().sessions[0]?.phase).toBe('recovery-required');
    expect(f.data.calls).toBe(1);
  } finally { f.clean(); }
});

test('an ambiguous provider rejection remains fenced after restart and re-enabling', async () => {
  const f = fixture();
  try {
    const c = f.make(async () => { throw new Error('connection lost after dispatch'); });
    c.setEnabled(true); await c.tick();
    expect(c.status().sessions[0]?.phase).toBe('recovery-required');
    const restarted = f.make(); restarted.setEnabled(false); restarted.setEnabled(true);
    await restarted.tick();
    expect(restarted.status().sessions[0]?.phase).toBe('recovery-required');
    expect(f.data.calls).toBe(1);
  } finally { f.clean(); }
});

test('version 1 JSON receipts migrate once and cannot resurrect after a fresh opt-in', async () => {
  const f = fixture();
  try {
    writeFileSync(f.stateFile, JSON.stringify({ schemaVersion: 1,
      settings: { enabled: true, enabledAt: '2026-09-07T00:00:00Z' },
      receipts: { 'session-0': { completedThresholds: [50], lastCheckpointAt: '2026-09-07T00:00:02Z',
        lastCheckpointThreshold: 50, projectId: 'project', projectName: 'Project', backupWarning: null } }, attempts: {} }));
    const db = new Database(`${f.stateFile}.attempts.sqlite`);
    db.run('CREATE TABLE attempts (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    db.run('PRAGMA user_version=1'); db.close();
    const c = f.make(); await c.tick(); await f.make().tick();
    expect(f.data.calls).toBe(0);
    c.setEnabled(false); c.setEnabled(true); await c.tick();
    expect(f.data.calls).toBe(1);
  } finally { f.clean(); }
});
