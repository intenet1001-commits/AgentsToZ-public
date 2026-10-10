import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProjectMemory } from '../project-memory-server';
import { resolveAppDataDir } from '../src/appDataDir';
import { acquireWorkspaceLease } from '../src/workspaceLease';
import { startTestApiServer } from './startTestApiServer';

test('real manual routes share admission, preserve query guards and acquire leases only after queue admission', async () => {
  const home = mkdtempSync(join(tmpdir(), 'memory-dispatch-api-'));
  const projects = ['a', 'b'].map(name => join(home, name));
  for (const project of projects) { mkdirSync(project); initializeProjectMemory({ folderPath: project, autoBackup: false }); }
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'),
    XDG_CONFIG_HOME: join(home, '.config'), APP_DATA_DIR: undefined, PORTMGR_BUNDLED_SIDECAR: undefined,
    SUPABASE_SERVICE_ROLE_KEY: '', MEMORY_DISPATCH_FIXTURE: home };
  const appData = resolveAppDataDir(process.platform, env, home);
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(appData, 'ports.json'), JSON.stringify(projects.map((folderPath, i) => ({ id: `fixture-${i}`, name: `Fixture ${i}`, folderPath }))));
  writeFileSync(join(home, 'fixture-ready'), '1');
  let child: Bun.Subprocess | undefined;
  let first: Promise<Response> | undefined; let queued: Promise<Response> | undefined;
  try {
    const api = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env, entrypoint: 'tests/fixtures/memory-save-dispatch-api.ts' });
    child = api.child;
    const post = (route: string, folderPath: string) => fetch(`${api.baseUrl}/api/project-memory/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderPath, autoBackup: false }),
    });
    first = post('session-end', projects[0]!);
    const callsPath = join(home, 'calls.jsonl');
    for (let i = 0; i < 200 && !existsSync(callsPath); i++) await Bun.sleep(10);
    expect(existsSync(callsPath)).toBe(true);
    const duplicate = await post('update', projects[0]!);
    expect(duplicate.status).toBe(409); expect((await duplicate.json() as any).code).toBe('MEMORY_SAVE_BUSY');
    const mismatch = await post(`update?folderPath=${encodeURIComponent(projects[1]!)}`, projects[0]!);
    expect(mismatch.status).toBe(400); expect((await mismatch.json() as any).code).toBe('WORKSPACE_LEASE_UNSAFE');
    queued = post('update', projects[1]!);
    // Poll metadata only; never enqueue a second provider-producing probe.
    let queuedProof = false;
    for (let i = 0; i < 100; i++) {
      const status = await fetch(`${api.baseUrl}/api/project-memory/auto-checkpoint/status`).then(response => response.json()) as any;
      if (status.saveDispatcher?.pending === 1) { queuedProof = true; break; }
      await Bun.sleep(10);
    }
    expect(queuedProof).toBe(true);
    const lease = await acquireWorkspaceLease({ workspacePath: projects[1]!, appDataDir: appData, attempts: 1 });
    expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(lease.release()).toBe(true);
    writeFileSync(join(home, 'release'), '1');
    expect((await first).status).toBe(200); expect((await queued).status).toBe(200);
    expect(readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).root)).toEqual(projects);
  } finally {
    writeFileSync(join(home, 'release'), '1');
    await Promise.allSettled([first, queued]);
    if (child) { child.kill(); await child.exited; }
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
