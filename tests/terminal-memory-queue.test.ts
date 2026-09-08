import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TerminalMemoryQueue, TERMINAL_MEMORY_COMPLETED_HISTORY_LIMIT,
  TERMINAL_MEMORY_BUSY_RETRY_MS, TERMINAL_MEMORY_STATUS_LIMIT, type TerminalMemoryJob,
} from '../src/terminalMemoryQueue';
const job = { sessionId: 'session-example', targetId: 'project-example', cwd: '/tmp/project', agent: 'claude' as const };
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'workroom-memory-'));
  return { file: join(root, 'queue.json'), dispose: () => rmSync(root, { recursive: true, force: true }) };
};

test('durable pending work resumes once and repeated close/shutdown enqueues stay idempotent', async () => {
  const { file, dispose } = fixture(); let calls = 0;
  const save = async () => { calls++; return 'saved' as const; };
  try {
    const first = new TerminalMemoryQueue(file, save);
    first.enqueue(job); first.enqueue(job); expect(calls).toBe(0);
    const restarted = new TerminalMemoryQueue(file, save);
    await Promise.all([restarted.tick(), restarted.tick()]);
    expect(calls).toBe(1); expect(restarted.status()[0]?.state).toBe('saved');
    const again = new TerminalMemoryQueue(file, save); again.enqueue(job); await again.tick();
    expect(calls).toBe(1);
    expect(Object.keys(again.status()[0]!)).toEqual(['sessionId', 'targetId', 'state']);
  } finally { dispose(); }
});

test('a deferred live CLI yields to ended sessions; permanent failures never loop', async () => {
  const { file, dispose } = fixture(); const calls: string[] = []; let ended = false;
  try {
    const queue = new TerminalMemoryQueue(file, async current => {
      calls.push(current.sessionId);
      if (current.sessionId === 'first' && !ended) return 'pending';
      if (current.sessionId === 'failed') throw new Error('private error');
      return 'saved';
    });
    for (const sessionId of ['first', 'second', 'failed']) queue.enqueue({ ...job, sessionId });
    for (let i = 0; i < 4; i++) await queue.tick();
    expect(calls).toEqual(['first', 'second', 'failed', 'first']);
    ended = true; await queue.tick(); await queue.tick();
    expect(calls).toEqual(['first', 'second', 'failed', 'first', 'first']);
    expect(queue.status().find(row => row.sessionId === 'failed')?.state).toBe('failed');
    expect(readFileSync(`${file}.sqlite`).includes(Buffer.from('private error'))).toBeFalse();
    await new TerminalMemoryQueue(file, async () => { throw new Error('must not retry'); }).tick();
  } finally { dispose(); }
});

for (const code of ['WORKSPACE_LEASE_BUSY', 'MEMORY_SAVE_BUSY', 'MEMORY_SAVE_STOPPED']) test(`${code} retries after its persisted delay without starving other sessions`, async () => {
  const { file, dispose } = fixture(); let now = 1000; let busy = true; const calls: string[] = [];
  const save = async (current: TerminalMemoryJob) => {
    calls.push(current.sessionId);
    if (current.sessionId === 'first' && busy) throw Object.assign(new Error('busy'), { code });
    return 'saved' as const;
  };
  try {
    const queue = new TerminalMemoryQueue(file, save, () => now);
    queue.enqueue({ ...job, sessionId: 'first' }); queue.enqueue({ ...job, sessionId: 'second' });
    await queue.tick(); await queue.tick(); await queue.tick();
    expect(calls).toEqual(['first', 'second']);
    expect(queue.status().find(row => row.sessionId === 'first')?.state).toBe('retrying');
    const restarted = new TerminalMemoryQueue(file, save, () => now);
    await restarted.tick(); expect(calls).toHaveLength(2);
    busy = false; now += TERMINAL_MEMORY_BUSY_RETRY_MS;
    await restarted.tick(); await restarted.tick(); expect(calls).toEqual(['first', 'second', 'first']);
  } finally { dispose(); }
});

test('dead-owner recovery is explicit and never invokes the memory model again after restart', async () => {
  const { file, dispose } = fixture(); let calls = 0;
  const save = async () => { calls++; throw Object.assign(new Error('private path'), { code: 'WORKSPACE_LEASE_RECOVERY_REQUIRED' }); };
  try {
    const queue = new TerminalMemoryQueue(file, save); queue.enqueue(job);
    await queue.tick(); await queue.tick();
    expect(queue.status()[0]?.state).toBe('recovery-required');
    const restarted = new TerminalMemoryQueue(file, save); await restarted.tick();
    expect(calls).toBe(1); expect(restarted.status()[0]?.state).toBe('recovery-required');
  } finally { dispose(); }
});

test('migration preserves exact JSON and separates pending work from ambiguous in-flight saves', async () => {
  const { file, dispose } = fixture(); const calls: string[] = [];
  const legacy = JSON.stringify([
    { ...job, sessionId: 'interrupted', state: 'saving' },
    { ...job, sessionId: 'waiting', state: 'pending' },
    { ...job, sessionId: 'failed', state: 'failed' },
  ]);
  try {
    writeFileSync(file, legacy);
    const save = async (current: TerminalMemoryJob) => { calls.push(current.sessionId); return 'saved' as const; };
    const queue = new TerminalMemoryQueue(file, save); await queue.tick(); await queue.tick();
    expect(calls).toEqual(['waiting']);
    expect(queue.status().find(row => row.sessionId === 'interrupted')?.state).toBe('recovery-required');
    expect(readFileSync(file, 'utf8')).toBe(legacy);
    const restarted = new TerminalMemoryQueue(file, save); await restarted.tick(); expect(calls).toHaveLength(1);
  } finally { dispose(); }
});

test('thousands of unresolved rows remain durable while status pages and completed history are bounded', async () => {
  const { file, dispose } = fixture(); let calls = 0;
  try {
    const unresolved = Array.from({ length: 8000 }, (_, i) => ({ ...job, sessionId: `failed-${i}`, state: 'failed' }));
    const successes = Array.from({ length: 1000 }, (_, i) => ({ ...job, sessionId: `saved-${i}`, state: 'saved' }));
    writeFileSync(file, JSON.stringify([...unresolved, ...successes, { ...job, state: 'pending' }]));
    const queue = new TerminalMemoryQueue(file, async () => { calls++; return 'saved'; });
    const first = queue.statusPage();
    expect(first.jobs).toHaveLength(TERMINAL_MEMORY_STATUS_LIMIT);
    expect(first.total).toBe(8001 + TERMINAL_MEMORY_COMPLETED_HISTORY_LIMIT); expect(first.unresolved).toBe(8001);
    const ids = new Set<string>();
    for (let offset: number | null = 0; offset !== null;) {
      const page = queue.statusPage(offset, 128);
      expect(page.jobs.length).toBeLessThanOrEqual(128);
      for (const row of page.jobs) ids.add(row.sessionId);
      offset = page.nextOffset;
    }
    expect(ids.size).toBe(first.total);
    await queue.tick(); await queue.tick(); expect(calls).toBe(1);
    expect(new TerminalMemoryQueue(file, async () => 'saved').statusPage().unresolved).toBe(8000);
    expect(() => queue.statusPage(0, 10000)).toThrow();
    expect(() => queue.statusPage(-1)).toThrow();
  } finally { dispose(); }
});

test('successful display history compacts without losing old duplicate fences', async () => {
  const { file, dispose } = fixture(); let calls = 0;
  try {
    const queue = new TerminalMemoryQueue(file, async () => { calls++; return 'saved'; });
    for (let i = 0; i < 150; i++) { queue.enqueue({ ...job, sessionId: `session-${i}` }); await queue.tick(); }
    expect(queue.status()).toHaveLength(TERMINAL_MEMORY_COMPLETED_HISTORY_LIMIT);
    queue.enqueue({ ...job, sessionId: 'session-0' }); await queue.tick(); expect(calls).toBe(150);
    const restarted = new TerminalMemoryQueue(file, async () => { calls++; return 'saved'; });
    restarted.enqueue({ ...job, sessionId: 'session-0' }); await restarted.tick(); expect(calls).toBe(150);
  } finally { dispose(); }
});

test('corrupt migration rolls back all rows and preserves the original; symlinks and future versions are rejected', () => {
  const { file, dispose } = fixture();
  try {
    const original = JSON.stringify([{ ...job, state: 'pending' }, { bad: true }]);
    writeFileSync(file, original);
    expect(() => new TerminalMemoryQueue(file, async () => 'saved').status()).toThrow('보존');
    expect(readFileSync(file, 'utf8')).toBe(original);
    writeFileSync(file, JSON.stringify([{ ...job, state: 'pending' }]));
    expect(new TerminalMemoryQueue(file, async () => 'saved').status()).toHaveLength(1);
    const db = new Database(`${file}.sqlite`); db.run('PRAGMA user_version=99'); db.close();
    expect(() => new TerminalMemoryQueue(file, async () => 'saved').enqueue(job)).toThrow('보존');
    const link = file + '-link'; symlinkSync(file, link);
    expect(() => new TerminalMemoryQueue(link, async () => 'saved').status()).toThrow('보존');
    const dbLink = file + '-db-link'; symlinkSync(`${file}.sqlite`, dbLink + '.sqlite');
    expect(() => new TerminalMemoryQueue(dbLink, async () => 'saved').status()).toThrow('보존');
  } finally { dispose(); }
});

test('failure to persist a finished receipt never replays the save, and is visible as recovery required', async () => {
  const { file, dispose } = fixture(); let calls = 0; const lock: {db: Database | null} = {db: null};
  try {
    const queue = new TerminalMemoryQueue(file, async () => {
      calls++; lock.db = new Database(`${file}.sqlite`); lock.db.run('BEGIN IMMEDIATE'); return 'saved';
    });
    queue.enqueue(job);
    await expect(queue.tick()).rejects.toThrow('보존');
    lock.db!.run('ROLLBACK'); lock.db!.close(); lock.db = null;
    expect(queue.status()[0]?.state).toBe('recovery-required');
    await queue.tick(); expect(calls).toBe(1);
    const restarted = new TerminalMemoryQueue(file, async () => { calls++; return 'saved'; });
    await restarted.tick(); expect(calls).toBe(1); expect(restarted.status()[0]?.state).toBe('recovery-required');
  } finally { if (lock.db) { lock.db.run('ROLLBACK'); lock.db.close(); } dispose(); }
});


test('verified Workroom recovery binds the original job and preserves backup pending',async()=>{
  const root=mkdtempSync(join(tmpdir(),'workroom-recovery-'));
  try {
    const queue=new TerminalMemoryQueue(join(root,'queue.json'),async()=>{throw Object.assign(new Error('interrupted'),{code:'PROJECT_MEMORY_SESSION_RECOVERY_REQUIRED'});});
    const job={sessionId:'recover-one',targetId:'project-one',cwd:root,agent:'codex' as const};
    queue.enqueue(job);await queue.tick();
    expect(queue.status()[0]?.state).toBe('recovery-required');
    expect(()=>queue.recordRecoveredLocalSave({...job,targetId:'another'},false)).toThrow();
    queue.recordRecoveredLocalSave(job,true);
    expect(queue.status()[0]?.state).toBe('backup-pending');
    queue.recordRecoveredLocalSave(job,false);
    expect(queue.status()[0]?.state).toBe('saved');
    queue.enqueue(job);
    expect(queue.status()).toHaveLength(1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('a durable local receipt survives post-save failures and stale callback results without replay', async () => {
  for (const backupPending of [true, false]) {
    for (const outcome of ['failure', 'busy', 'pending', 'unchanged', 'unavailable', 'backup-pending'] as const) {
      const { file, dispose } = fixture(); let calls = 0;
      try {
        const queue = new TerminalMemoryQueue(file, async current => {
          calls++;
          queue.recordRecoveredLocalSave(current, backupPending);
          // sessionEnd can throw after onLocalSaved, for example when its
          // separate host-session completion receipt cannot be persisted.
          if (outcome === 'failure') throw new Error('host completion write failed');
          if (outcome === 'busy') throw Object.assign(new Error('busy'), { code: 'WORKSPACE_LEASE_BUSY' });
          return outcome;
        });
        queue.enqueue(job); await queue.tick();
        const expected = backupPending ? 'backup-pending' : 'saved';
        expect(queue.status()[0]?.state).toBe(expected);
        const restarted = new TerminalMemoryQueue(file, async () => { calls++; return 'saved'; }, () => Date.now() + 60_000);
        restarted.enqueue(job); await restarted.tick();
        expect(calls).toBe(1);
        expect(restarted.status()[0]?.state).toBe(expected);
      } finally { dispose(); }
    }
  }
});

test('backup success completes a local receipt and a late pending receipt cannot downgrade it', async () => {
  const { file, dispose } = fixture();
  try {
    const queue = new TerminalMemoryQueue(file, async current => {
      queue.recordRecoveredLocalSave(current, true);
      return 'saved';
    });
    queue.enqueue(job); await queue.tick();
    expect(queue.statusPage().unresolved).toBe(0);
    queue.recordRecoveredLocalSave(job, true);
    expect(queue.status()[0]?.state).toBe('saved');
    expect(queue.statusPage().unresolved).toBe(0);
  } finally { dispose(); }
});

test('process exit immediately after the local receipt preserves the outcome on restart', async () => {
  for (const backupPending of [true, false]) {
    const { file, dispose } = fixture();
    try {
      const script = file + '.ts';
      writeFileSync(script, `
        import { TerminalMemoryQueue } from ${JSON.stringify(join(import.meta.dir, '../src/terminalMemoryQueue.ts'))};
        const queue = new TerminalMemoryQueue(process.argv[2], async job => {
          queue.recordRecoveredLocalSave(job, ${backupPending});
          process.exit(93);
        });
        queue.enqueue(${JSON.stringify(job)});
        await queue.tick();
      `);
      const child = Bun.spawn([process.execPath, script, file], { stdout: 'ignore', stderr: 'pipe' });
      expect(await child.exited).toBe(93);
      let calls = 0;
      const restarted = new TerminalMemoryQueue(file, async () => { calls++; return 'saved'; });
      restarted.enqueue(job); await restarted.tick();
      expect(calls).toBe(0);
      expect(restarted.status()[0]?.state).toBe(backupPending ? 'backup-pending' : 'saved');
    } finally { dispose(); }
  }
});
