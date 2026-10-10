import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRememberAttemptStore, type AutoRememberReceipt } from '../src/autoRememberAttemptStore';
import { CodexAutoRememberCoordinator, type CodexAutoRememberCoordinatorDependencies } from '../src/codexAutoRememberCoordinator';
import type { AutoRememberBackup } from '../src/memoryBackupContract';

const empty: AutoRememberReceipt = { completedThresholds: [], lastCheckpointAt: null,
  lastCheckpointThreshold: null, projectId: null, projectName: null, backupWarning: null };
const saved = { ...empty, completedThresholds: [50], lastCheckpointAt: '2026-09-07T01:00:00Z',
  projectName: 'Project', backupWarning: 'pending', saveId: 'save-1' };
const backup: AutoRememberBackup = { projectId: 'project', projectRoot: '/work/project', projectName: 'Project',
  memoryId: 'memory', contentHash: 'a'.repeat(64), destinationHash: 'b'.repeat(64), parentRevisionId: null };

test('eight dispatched backup attempts stop durably without deleting their job', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-budget-'));
  try {
    const path = join(root, 'state.sqlite');
    const store = new AutoRememberAttemptStore(path, {});
    store.begin('session', 'save-1', 'epoch', empty);
    store.recordOutcome('session', 'save-1', 'epoch', saved, backup);
    for (let n = 1; n <= 8; n++) expect(store.claimBackup(n * 4_000_000)?.attempt).toBe(n);
    const restarted = new AutoRememberAttemptStore(path, {});
    expect(restarted.claimBackup(40_000_000)).toBeNull();
    expect(restarted.backupStatus()[0]).toMatchObject({ state: 'blocked', attempts: 8 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('version 2 pending intents stay unresolved through the outcome/outbox migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-v2-migration-'));
  try {
    const path = join(root, 'state.sqlite'); const db = new Database(path);
    db.run('CREATE TABLE intents (session_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE)');
    db.run("INSERT INTO intents VALUES ('legacy','old-save')"); db.run('PRAGMA user_version=2'); db.close();
    const store = new AutoRememberAttemptStore(path, {}); store.recoverOutcomes();
    expect(store.hasIntent('legacy')).toBe(true);
    expect(store.receipt('legacy', 'epoch')).toBeUndefined();
    expect(store.backupStatus()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace busy returns its retry budget and a completed backup preserves local warnings', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-busy-'));
  try {
    const store = new AutoRememberAttemptStore(join(root, 'state.sqlite'), {});
    store.begin('session', 'save-1', 'epoch', empty);
    store.recordOutcome('session', 'save-1', 'epoch', { ...saved, localWarning: 'capture incomplete' }, backup);
    store.recoverOutcomes();
    expect(store.claimBackup(0)?.attempt).toBe(1);
    store.deferBusyBackup('save-1', 1, 0);
    expect(store.claimBackup(29_999)).toBeNull();
    expect(store.claimBackup(30_000)?.attempt).toBe(1);
    store.finishBackup('save-1', 'complete');
    expect(store.receipt('session', 'epoch')?.backupWarning).toBe('capture incomplete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('confirmed outcomes recover atomically, but bare intents never become saved', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-recovery-'));
  try {
    const path = join(root, 'state.sqlite');
    const store = new AutoRememberAttemptStore(path, {});
    store.begin('confirmed', 'save-1', 'epoch', empty);
    store.begin('unknown', 'save-2', 'epoch', empty);
    store.recordOutcome('confirmed', 'save-1', 'epoch', saved, backup);
    const restarted = new AutoRememberAttemptStore(path, {});
    restarted.recoverOutcomes(); restarted.recoverOutcomes();
    expect(restarted.receipt('confirmed', 'epoch')).toEqual(saved);
    expect(restarted.hasIntent('confirmed')).toBe(false);
    expect(restarted.hasIntent('unknown')).toBe(true);
    expect(restarted.receipt('unknown', 'epoch')).toBeUndefined();
    // A concurrently returning owner cannot undo a recovered receipt.
    expect(() => store.finish('confirmed', 'save-1', 'epoch', saved)).not.toThrow();
    expect(restarted.backupStatus()).toHaveLength(1);
    expect(JSON.stringify(restarted.backupStatus())).not.toContain('/work');
    expect(JSON.stringify(restarted.backupStatus())).not.toContain(backup.destinationHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an outbox write error rolls back its outcome instead of losing the pending backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-atomic-'));
  try {
    const path = join(root, 'state.sqlite');
    const store = new AutoRememberAttemptStore(path, {});
    store.begin('session', 'save-1', 'epoch', empty);
    const db = new Database(path);
    db.run("CREATE TRIGGER reject_backup BEFORE INSERT ON backups BEGIN SELECT RAISE(ABORT, 'disk full'); END"); db.close();
    expect(() => store.recordOutcome('session', 'save-1', 'epoch', saved, backup)).toThrow();
    store.recoverOutcomes();
    expect(store.hasIntent('session')).toBe(true);
    expect(store.receipt('session', 'epoch')).toBeUndefined();
    expect(store.backupStatus()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('network backoff survives restart and an old backup cannot clear a newer warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-backoff-'));
  try {
    const path = join(root, 'state.sqlite');
    const store = new AutoRememberAttemptStore(path, {});
    store.begin('session', 'save-1', 'epoch', empty);
    store.recordOutcome('session', 'save-1', 'epoch', saved, backup); store.recoverOutcomes();
    expect(store.claimBackup(1_000)?.attempt).toBe(1);
    const restarted = new AutoRememberAttemptStore(path, {});
    expect(restarted.claimBackup(60_999)).toBeNull();
    expect(restarted.claimBackup(61_000)?.attempt).toBe(2);
    restarted.setReceipt('session', 'epoch', { ...saved, saveId: 'new-save' });
    restarted.finishBackup('save-1', 'complete');
    expect(restarted.receipt('session', 'epoch')?.backupWarning).toBe('pending');
    expect(restarted.backupStatus()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('coordinator recovers a post-save interruption and retries only the backup, even with AI disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-coordinator-'));
  let aiCalls = 0, pushes = 0;
  let now = Date.parse('2026-09-07T00:00:00Z');
  const dependencies: CodexAutoRememberCoordinatorDependencies = {
    stateFile: join(root, 'state.json'), now: () => new Date(now),
    listObservations: () => [{ sessionId: 'session', cwd: '/work/project', usedPercent: 55,
      capturedAt: '2026-09-07T01:00:00Z', turnState: 'complete', turnId: 'turn', turnCompletedAt: '2026-09-07T01:00:00Z' }],
    resolveProject: () => ({ projectId: 'project', projectName: 'Project', projectRoot: '/work/project' }),
    inspectMemory: () => ({ exists: true, needsRemember: true, autoBackup: true }),
    checkpoint: async ({ recordLocalSave }) => {
      aiCalls++;
      recordLocalSave({ localSaved: true, remoteBackedUp: false, backup });
      throw new Error('interrupted after durable local outcome');
    },
    retryBackup: async () => { pushes++; return pushes === 1 ? 'retry' : 'complete'; },
  };
  try {
    const first = new CodexAutoRememberCoordinator(dependencies); first.setEnabled(true); await first.tick();
    expect(first.status().sessions[0]?.phase).toBe('recovery-required');
    const restarted = new CodexAutoRememberCoordinator(dependencies); await restarted.tick();
    expect(restarted.status().sessions[0]?.phase).toBe('saved');
    expect(pushes).toBe(1); expect(aiCalls).toBe(1);
    restarted.setEnabled(false); now += 60_000;
    await restarted.tick(); await Promise.resolve();
    expect(pushes).toBe(2); expect(aiCalls).toBe(1);
    expect(restarted.status().backups).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('prepared completion binds recovered saves to the exact host identity and queues backup once', () => {
  const root=mkdtempSync(join(tmpdir(),'completion-context-'));
  try {
    const store=new AutoRememberAttemptStore(join(root,'attempts.sqlite'),{});
    store.begin('session','save-1','epoch',empty);
    store.prepareCompletion({id:'save-1',sessionId:'session',epoch:'epoch',root:'/work/project',memoryId:'memory',receipt:saved});
    expect(()=>store.completeRecovered('save-1','/another','memory',{backupWarning:null})).toThrow();
    store.completeRecovered('save-1','/work/project','memory',{backup,backupWarning:'pending'});
    store.completeRecovered('save-1','/work/project','memory',{backup,backupWarning:'pending'});
    expect(store.receipt('session','epoch')?.saveId).toBe('save-1');
    expect(store.hasIntent('session')).toBe(false);
    expect(store.backupStatus()).toHaveLength(1);
    store.setReceipt('session','epoch',{...saved,saveId:'newer-save'});
    store.completeRecovered('save-1','/work/project','memory',{backup,backupWarning:'pending'});
    expect(store.receipt('session','epoch')?.saveId).toBe('newer-save');
    expect(()=>store.completeRecovered('legacy','/work/project','memory',{backupWarning:null})).toThrow();
  } finally {rmSync(root,{recursive:true,force:true});}
});
