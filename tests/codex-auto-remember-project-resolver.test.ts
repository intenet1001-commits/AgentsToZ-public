import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectMemoryIdentity } from '../project-memory-server';
import { CodexAutoRememberCoordinator } from '../src/codexAutoRememberCoordinator';
import type { CodexAutoRememberObservation } from '../src/codexAutoRememberContract';
import { prepareAutoRememberProjectResolver } from '../src/codexAutoRememberProjectResolver';
import type { RegisteredProjectMemoryCandidate } from '../src/projectMemoryProjectResolver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  const path = mkdtempSync(join(tmpdir(), 'auto-remember-resolver-'));
  roots.push(path);
  return path;
}
function memory(path: string, memoryId: string) {
  mkdirSync(join(path, '.agent-memory'), { recursive: true });
  writeFileSync(join(path, '.agent-memory/config.json'), JSON.stringify({
    schemaVersion: 1, memoryId, sourcePath: '.agent-memory/CORE.md', agent: 'codex', autoBackup: false,
  }));
  writeFileSync(join(path, '.agent-memory/CORE.md'), '# fixture memory');
}
const identity = async (path: string) => ({
  exists: true, projectRoot: path,
  config: JSON.parse(readFileSync(join(path, '.agent-memory/config.json'), 'utf8')) as { memoryId: string },
});
const observation = (cwd: string, sessionId = 'session-1'): CodexAutoRememberObservation => ({
  sessionId, cwd, usedPercent: 51, capturedAt: '2026-09-07T01:00:00.000Z',
  turnId: 'turn-1', turnState: 'complete', turnCompletedAt: '2026-09-07T01:00:00.000Z',
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('automatic remember identity discovery', () => {
  test('132 registrations and 48 observations share one identity pass and one matching activity read per tick', async () => {
    const directory = root();
    const rows = Array.from({ length: 132 }, (_, index) => {
      const folderPath = join(directory, `project-${index}`);
      memory(folderPath, `memory-${index}`);
      return { id: `project-${index}`, folderPath };
    });
    const observations = Array.from({ length: 48 }, (_, index) => observation(rows[0]!.folderPath, `session-${index}`));
    const calls: string[] = [];
    const activity: string[] = [];
    let active = 0;
    let peak = 0;
    let prepared = 0;
    const coordinator = new CodexAutoRememberCoordinator({
      stateFile: join(directory, 'state.json'), listObservations: () => observations,
      resolveProject: () => { throw new Error('Per-observation full discovery must not run'); },
      prepareProjectResolver: () => {
        prepared++;
        return prepareAutoRememberProjectResolver({
          readRegistered: async () => rows,
          detectIdentity: async path => {
            calls.push(path); active++; peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 1));
            active--;
            return identity(path);
          },
        });
      },
      inspectMemory: project => {
        activity.push(project.projectId);
        return { exists: true, needsRemember: false, autoBackup: false };
      },
      checkpoint: async () => { throw new Error('No changed activity'); },
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    });
    await coordinator.tick();
    expect(prepared).toBe(0);
    coordinator.setEnabled(true);
    observations.forEach(row => { row.usedPercent = 10; });
    await coordinator.tick();
    expect(prepared).toBe(0);
    observations.forEach(row => { row.usedPercent = 51; });
    await coordinator.tick();
    expect(prepared).toBe(1);
    expect(calls).toHaveLength(132);
    expect(new Set(calls).size).toBe(132);
    expect(peak).toBe(4);
    expect(activity).toEqual(['project-0']);
    await coordinator.tick();
    expect(prepared).toBe(2);
    expect(calls).toHaveLength(264);
    expect(activity).toEqual(['project-0', 'project-0']);
  });

  test('an HTTP health request responds while asynchronous identity discovery is still waiting', async () => {
    const directory = root(); memory(directory, 'one');
    const entered = deferred(); const release = deferred();
    let finished = false;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true }) });
    const pending = prepareAutoRememberProjectResolver({
      readRegistered: async () => [{ id: 'one', folderPath: directory }],
      detectIdentity: async path => { entered.resolve(); await release.promise; return identity(path); },
    }).then(result => { finished = true; return result; });
    try {
      await entered.promise;
      const response = await fetch(`http://127.0.0.1:${server.port}/api/health`, { signal: AbortSignal.timeout(1000) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(finished).toBe(false);
    } finally {
      release.resolve(); await pending; await server.stop(true);
    }
  });

  test('coalesces proven aliases but rejects ambiguous, unregistered, and unreadable identities', async () => {
    const directory = root(); const main = join(directory, 'main'); const other = join(directory, 'other');
    memory(main, 'main'); memory(other, 'other');
    let rows: RegisteredProjectMemoryCandidate[] = [
      { id: 'main', folderPath: main }, { id: 'alias', folderPath: main },
    ];
    const deps = { readRegistered: async () => rows, detectIdentity: identity };
    const resolver = await prepareAutoRememberProjectResolver(deps);
    expect(await resolver(observation(main))).toMatchObject({ projectId: 'main', memoryId: 'main' });
    expect(await resolver(observation(other))).toBeNull();
    rows = [{ id: 'ambiguous', folderPath: main, worktreePath: other }];
    expect(await (await prepareAutoRememberProjectResolver(deps))(observation(main))).toBeNull();
    rows = [{ id: 'main', folderPath: main }];
    expect(await (await prepareAutoRememberProjectResolver({
      ...deps, detectIdentity: async () => { throw new Error('Git unavailable'); },
    }))(observation(main))).toBeNull();
  });

  test('rejects registration changes during preparation, before lookup, and after lease acquisition', async () => {
    const directory = root(); memory(directory, 'one');
    let rows = [{ id: 'one', folderPath: directory }];
    const deps = { readRegistered: async () => rows, detectIdentity: identity };
    const resolver = await prepareAutoRememberProjectResolver(deps);
    const selected = await resolver(observation(directory));
    expect(await selected?.validateRegistration?.()).toBe(true);
    rows = [];
    expect(await resolver(observation(directory))).toBeNull();
    expect(await selected?.validateRegistration?.()).toBe(false);
    rows = [{ id: 'one', folderPath: directory }];
    const changedWhilePreparing = await prepareAutoRememberProjectResolver({
      ...deps, detectIdentity: async path => { rows = []; return identity(path); },
    });
    expect(await changedWhilePreparing(observation(directory))).toBeNull();
  });

  test('lease revalidation rejects symlink retargeting and a replaced memory lineage', async () => {
    const directory = root(); const main = join(directory, 'main'); const other = join(directory, 'other');
    memory(main, 'main'); memory(other, 'other');
    const alias = join(directory, 'alias'); symlinkSync(main, alias);
    const deps = { readRegistered: async () => [{ id: 'one', folderPath: alias }], detectIdentity: identity };
    const resolver = await prepareAutoRememberProjectResolver(deps);
    const selected = await resolver(observation(alias));
    expect(selected).not.toBeNull();
    unlinkSync(alias); symlinkSync(other, alias);
    expect(await selected?.validateRegistration?.()).toBe(false);
    expect(await resolver(observation(alias))).toBeNull();
    const current = await (await prepareAutoRememberProjectResolver(deps))(observation(alias));
    memory(other, 'replaced');
    expect(await current?.validateRegistration?.()).toBe(false);
  });

  test('real Git-linked worktrees resolve to the registered main and never promote a stale linked copy', async () => {
    const directory = root(); const main = join(directory, 'main'); const linked = join(directory, 'linked');
    mkdirSync(main);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: main, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode) throw new Error(result.stderr.toString());
    };
    git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-b', 'linked', linked);
    memory(main, 'canonical'); memory(linked, 'stale');
    const deps = { readRegistered: async () => [{ id: 'main', folderPath: main }], detectIdentity: detectProjectMemoryIdentity };
    const selected = await (await prepareAutoRememberProjectResolver(deps))(observation(linked));
    expect(selected).toMatchObject({ projectId: 'main', memoryId: 'canonical' });
    expect(await selected?.validateRegistration?.()).toBe(true);
    rmSync(join(main, '.agent-memory'), { recursive: true });
    expect(await selected?.validateRegistration?.()).toBe(false);
    expect(await (await prepareAutoRememberProjectResolver(deps))(observation(linked))).toBeNull();
  });

  for (const phase of ['observations', 'prepare', 'resolve', 'inspect', 'lease'] as const) {
    test(`turning off and re-enabling at the same timestamp fences an in-flight ${phase}`, async () => {
      const directory = root(); const entered = deferred(); const release = deferred();
      let writes = 0;
      const pause = async () => { entered.resolve(); await release.promise; };
      const coordinator = new CodexAutoRememberCoordinator({
        stateFile: join(directory, 'state.json'),
        listObservations: async () => {
          if (phase === 'observations') {
            await pause();
            // Both branches return before project discovery. Old observations
            // must not repopulate runtime after a new policy epoch cleared it.
            return [
              { ...observation(directory, 'below-threshold'), usedPercent: 10 },
              { ...observation(directory, 'historical'), turnCompletedAt: '2026-09-06T23:00:00.000Z' },
            ];
          }
          return [observation(directory)];
        },
        ...(phase === 'prepare' ? {
          prepareProjectResolver: async () => {
            await pause();
            return () => ({ projectId: 'one', projectName: 'One', projectRoot: directory });
          },
        } : {}),
        resolveProject: async () => {
          if (phase === 'resolve') await pause();
          return { projectId: 'one', projectName: 'One', projectRoot: directory };
        },
        inspectMemory: async () => {
          if (phase === 'inspect') await pause();
          return { exists: true, needsRemember: true, autoBackup: false };
        },
        checkpoint: async ({ isActive }) => {
          if (phase === 'lease') await pause();
          if (isActive()) writes++;
          return { localSaved: true, remoteBackedUp: true };
        },
        now: () => new Date('2026-09-07T00:00:00.000Z'),
      });
      coordinator.setEnabled(true);
      const pending = coordinator.tick();
      await entered.promise;
      coordinator.setEnabled(false); coordinator.setEnabled(true);
      release.resolve(); await pending;
      expect(writes).toBe(0);
      expect(coordinator.status().sessions).toEqual([]);
    });
  }
});
