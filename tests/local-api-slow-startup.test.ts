import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOwnedFileLock } from '../src/portalFileLock';
import { startTestApiServer } from './startTestApiServer';

test('slow supervisor initialization does not run the Workroom queue before its dependencies exist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentstoz-slow-startup-'));
  const appData = join(directory, 'app-data');
  mkdirSync(appData);
  writeFileSync(join(appData, 'ports.json'), '[]');
  const queueFile = join(appData, 'workroom-memory-queue.json');
  const job = { sessionId: 'startup-fixture', targetId: 'unregistered-fixture', cwd: directory, agent: 'codex', state: 'pending' };
  const initialQueue = JSON.stringify([job], null, 2);
  writeFileSync(queueFile, initialQueue);
  // The real sidecar must exhaust its 75 x 40ms wait on this live owner.
  // No test-specific delay or weakened lock is added to production startup.
  const release = await acquireOwnedFileLock(join(appData, 'agent-runtime', 'supervisor-v1.lock'));
  let child: Bun.Subprocess | undefined;
  let stderr: Promise<string> | undefined;
  try {
    const startedAt = performance.now();
    const server = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: directory,
        APP_DATA_DIR: appData,
        APPDATA: join(directory, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: join(directory, '.config'),
        AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
        AGENTSTOZ_SKIP_HERMES_SYNC: '1',
        PORTMGR_BUNDLED_SIDECAR: '0',
        PORTMGR_PARENT_PID: '0',
      },
    });
    child = server.child;
    stderr = new Response(child.stderr as ReadableStream).text();
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    // Auto remember remains disabled. Its initialized callback defers the job
    // in SQLite without replacing legacy JSON or resolving a target/calling AI.
    const deadline = performance.now() + 5_000;
    type QueueRow = {state: string; turn: number};
    let stored: QueueRow | null = null;
    while ((!stored || stored.turn < 1) && performance.now() < deadline) {
      expect(child.exitCode).toBeNull();
      await Bun.sleep(50);
      if (existsSync(queueFile + '.sqlite')) {
        let db: Database | undefined;
        try {
          db = new Database(queueFile + '.sqlite', {readonly: true});
          // The SQLite file exists before the initializer's schema transaction commits.
          // Wait for that commit within the same deadline instead of racing CREATE TABLE.
          if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) {
            stored = db.query('SELECT state,turn FROM jobs WHERE sessionId=?').get(job.sessionId) as QueueRow | null;
          }
        } catch (error) {
          // Initialization can hold an exclusive schema lock even after the
          // file appears. Retry only that transient read within the original
          // deadline; malformed schemas and all other errors still fail.
          if ((error as {code?: string}).code !== 'SQLITE_BUSY') throw error;
        }
        finally { db?.close(); }
      }
    }
    expect(stored?.turn).toBeGreaterThanOrEqual(1);
    expect(stored?.state).toBe('pending');
    expect(readFileSync(queueFile, 'utf8')).toBe(initialQueue);
    const readiness = await fetch(`${server.baseUrl}/api/agent-runtime/readiness`, {
      headers: {Origin: 'tauri://localhost'}, signal: AbortSignal.timeout(5_000),
    });
    expect(readiness.status).toBe(200);
    const diagnostic = await readiness.json();
    expect(diagnostic.ready).toBeFalse();
    expect(diagnostic.gates.at(-1).reason).toBe('runtime-supervisor-unavailable');
    const response = await fetch(`${server.baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
    expect(response.status).toBe(200);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child) {
      try { child.kill(); } catch { /* Only this test's child is owned here. */ }
      const forceExit = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 2_000);
      try { await child.exited; } finally { clearTimeout(forceExit); }
    }
    release();
    rmSync(directory, { recursive: true, force: true });
  }
  const errors = await stderr;
  expect(errors).toContain('agent runtime supervisor 저장 잠금을 3000ms 안에 획득하지 못했습니다.');
  expect(errors).not.toMatch(/ReferenceError|Cannot access .* before initialization/);
}, 20_000);
