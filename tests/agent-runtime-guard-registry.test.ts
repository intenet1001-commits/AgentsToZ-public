import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';

import {
  AGENT_RUNTIME_GUARD_REGISTRY_FILENAME,
  activateAgentRuntimeGuardReservation,
  decodeAgentRuntimeGuardReservation,
  encodeAgentRuntimeGuardReservation,
  inspectAgentRuntimeGuardRecords,
  prepareAgentRuntimeGuardRegistry,
  type AgentRuntimeGuardReservation,
} from '../src/agentRuntimeGuardRegistry';

const roots: string[] = [];
const children = new Set<Bun.Subprocess>();
const REGISTRY_MODULE_URL = pathToFileURL(
  join(import.meta.dir, '..', 'src', 'agentRuntimeGuardRegistry.ts'),
).href;

interface ActivationResult {
  outcome: 'active' | 'rejected';
  pid: number;
}

function fixtureRoot(label: string): {
  root: string;
  appDataDir: string;
  cwd: string;
} {
  const root = mkdtempSync(join(tmpdir(), `agentstoz-guard-registry-${label}-`));
  roots.push(root);
  const appDataDir = join(root, 'app-data');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { root, appDataDir, cwd };
}

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function ownerFor(pid: number): string {
  return `v3:${pid}:${'a'.repeat(32)}:guarded`;
}

function legacyOwnerFor(pid: number): string {
  return `v2:${pid}:${'b'.repeat(32)}`;
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

async function eventually<T>(
  read: () => T | null,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error('guard registry test condition was not reached');
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function definitelyDeadPid(): Promise<number> {
  const child = Bun.spawn([
    process.execPath,
    '--no-env-file',
    '-e',
    'process.exit(0)',
  ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  const pid = child.pid;
  await child.exited;
  expect(pid).toBeGreaterThan(1);
  return pid;
}

function spawnActivator(input: {
  reservation: AgentRuntimeGuardReservation;
  expectedParentPid: number;
  barrierPath: string;
  readyPath: string;
  resultPath: string;
}): Bun.Subprocess {
  const source = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { activateAgentRuntimeGuardReservation } from ${JSON.stringify(REGISTRY_MODULE_URL)};
    const barrierPath = process.env.AGENTSTOZ_TEST_BARRIER;
    const readyPath = process.env.AGENTSTOZ_TEST_READY;
    const resultPath = process.env.AGENTSTOZ_TEST_RESULT;
    const encoded = process.env.AGENTSTOZ_TEST_RESERVATION;
    const expectedParentPid = Number(process.env.AGENTSTOZ_TEST_PARENT_PID);
    if (!barrierPath || !readyPath || !resultPath || !encoded) process.exit(64);
    writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
    while (!existsSync(barrierPath)) await Bun.sleep(2);
    try {
      activateAgentRuntimeGuardReservation(encoded, expectedParentPid, 'codex');
      writeFileSync(resultPath, JSON.stringify({ outcome: 'active', pid: process.pid }), { mode: 0o600 });
      setInterval(() => {}, 1_000);
    } catch {
      writeFileSync(resultPath, JSON.stringify({ outcome: 'rejected', pid: process.pid }), { mode: 0o600 });
      process.exit(0);
    }
  `;
  const child = Bun.spawn([
    process.execPath,
    '--no-env-file',
    '-e',
    source,
  ], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      AGENTSTOZ_TEST_BARRIER: input.barrierPath,
      AGENTSTOZ_TEST_READY: input.readyPath,
      AGENTSTOZ_TEST_RESULT: input.resultPath,
      AGENTSTOZ_TEST_RESERVATION: encodeAgentRuntimeGuardReservation(input.reservation),
      AGENTSTOZ_TEST_PARENT_PID: String(input.expectedParentPid),
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    detached: true,
  });
  children.add(child);
  return child;
}

async function stopChild(child: Bun.Subprocess): Promise<void> {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  await child.exited.catch(() => undefined);
  children.delete(child);
}

afterEach(async () => {
  for (const child of [...children]) await stopChild(child);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Runtime durable process guard registry', () => {
  test('persists a reserved row and transports only one exact canonical reservation', () => {
    const { appDataDir, cwd } = fixtureRoot('transport');
    const registry = prepareAgentRuntimeGuardRegistry(appDataDir);
    const reservation = registry.reserve({ kind: 'codex', cwd });
    const encoded = encodeAgentRuntimeGuardReservation(reservation);

    expect(decodeAgentRuntimeGuardReservation(encoded)).toEqual(reservation);
    expect(Object.keys(decodeAgentRuntimeGuardReservation(encoded)).sort()).toEqual([
      'databasePath', 'kind', 'launchId', 'parentPid', 'protocol', 'token',
    ]);
    expect(() => decodeAgentRuntimeGuardReservation(`${encoded}=`)).toThrow();
    expect(() => decodeAgentRuntimeGuardReservation(encodeRaw({
      ...reservation,
      extra: 'must-not-cross',
    }))).toThrow();
    expect(() => decodeAgentRuntimeGuardReservation(encodeRaw({
      ...reservation,
      protocol: 'agentstoz-process-guard-reservation-v2',
    }))).toThrow();

    const reopened = prepareAgentRuntimeGuardRegistry(appDataDir);
    expect(reopened.databasePath).toBe(registry.databasePath);
    const records = inspectAgentRuntimeGuardRecords(reopened);
    expect(records).toEqual([expect.objectContaining({
      launchId: reservation.launchId,
      state: 'reserved',
      parentPid: process.pid,
      guardPid: null,
      pgid: null,
      kind: 'codex',
      scopeHash: createHash('sha256').update(cwd).digest('hex'),
      activatedAtMs: null,
    })]);
    expect('token' in records[0]!).toBe(false);
  });

  test('cancels only the exact reserved launch id, token, owner, and kind', () => {
    const { appDataDir, cwd } = fixtureRoot('cancel');
    const registry = prepareAgentRuntimeGuardRegistry(appDataDir);
    const reservation = registry.reserve({ kind: 'codex', cwd });
    const forged: AgentRuntimeGuardReservation = {
      ...reservation,
      token: `${reservation.token[0] === '0' ? '1' : '0'}${reservation.token.slice(1)}`,
    };

    expect(registry.cancelReservation(forged)).toBe(false);
    expect(inspectAgentRuntimeGuardRecords(registry)).toHaveLength(1);
    expect(registry.cancelReservation(reservation)).toBe(true);
    expect(registry.cancelReservation(reservation)).toBe(false);
    expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([]);
  });

  test('recovers a dead owner reserved row but never a live owner or malformed owner', async () => {
    const { appDataDir, cwd } = fixtureRoot('reserved-recovery');
    const registry = prepareAgentRuntimeGuardRegistry(appDataDir);
    const live = registry.reserve({ kind: 'codex', cwd });

    expect(registry.canRecoverDeadOwner(ownerFor(process.pid))).toBe(false);
    expect(registry.canRecoverDeadOwner('legacy-owner')).toBe(false);
    expect(inspectAgentRuntimeGuardRecords(registry)).toHaveLength(1);
    expect(registry.cancelReservation(live)).toBe(true);

    const deadPid = await definitelyDeadPid();
    registry.reserve({ kind: 'codex', cwd, parentPid: deadPid });
    expect(registry.canRecoverDeadOwner(`v3:${deadPid}:${'c'.repeat(32)}:manual`)).toBe(false);
    expect(registry.canRecoverDeadOwner(ownerFor(deadPid))).toBe(true);
    expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([]);

    const legacyDeadPid = await definitelyDeadPid();
    registry.reserve({ kind: 'codex', cwd, parentPid: legacyDeadPid });
    expect(registry.canRecoverDeadOwner(legacyOwnerFor(legacyDeadPid))).toBe(true);
    expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'blocks recovery while an active group exists and deletes it only after ESRCH',
    async () => {
      const { root, appDataDir, cwd } = fixtureRoot('active-recovery');
      const registry = prepareAgentRuntimeGuardRegistry(appDataDir);
      const deadPid = await definitelyDeadPid();
      const reservation = registry.reserve({ kind: 'codex', cwd, parentPid: deadPid });
      const barrierPath = join(root, 'activate.go');
      const readyPath = join(root, 'activator.ready');
      const resultPath = join(root, 'activator.result.json');
      writeFileSync(barrierPath, 'go', { mode: 0o600 });
      const child = spawnActivator({
        reservation,
        expectedParentPid: deadPid,
        barrierPath,
        readyPath,
        resultPath,
      });
      const result = await eventually(() => readJson<ActivationResult>(resultPath));

      expect(result).toEqual({ outcome: 'active', pid: child.pid });
      expect(processGroupAlive(child.pid)).toBe(true);
      expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([
        expect.objectContaining({
          launchId: reservation.launchId,
          state: 'active',
          parentPid: deadPid,
          guardPid: child.pid,
          pgid: child.pid,
        }),
      ]);
      expect(registry.canRecoverDeadOwner(ownerFor(deadPid))).toBe(false);
      expect(registry.releaseAfterGroupTermination(reservation, child.pid)).toBe(false);

      await stopChild(child);
      await eventually(() => processGroupAlive(child.pid) ? null : true);
      expect(registry.canRecoverDeadOwner(ownerFor(deadPid))).toBe(true);
      expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([]);
      expect(registry.releaseAfterGroupTermination(reservation, child.pid)).toBe(true);
    },
  );

  test('fails closed on a future schema and on an internally corrupt row', async () => {
    const future = fixtureRoot('future-schema');
    const runtimeDirectory = join(future.appDataDir, 'agent-runtime');
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const futurePath = join(
      realpathSync(runtimeDirectory),
      AGENT_RUNTIME_GUARD_REGISTRY_FILENAME,
    );
    const futureDatabase = new Database(futurePath);
    futureDatabase.exec(`
      CREATE TABLE process_guard_registry_meta (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL
      );
      INSERT INTO process_guard_registry_meta(singleton, schema_version) VALUES (1, 2);
    `);
    futureDatabase.close();
    if (process.platform !== 'win32') chmodSync(futurePath, 0o600);

    expect(() => inspectAgentRuntimeGuardRecords({ databasePath: futurePath }))
      .toThrow('schema is unsupported');
    expect(() => prepareAgentRuntimeGuardRegistry(future.appDataDir))
      .toThrow('schema is unsupported');
    const futureCheck = new Database(futurePath, { readonly: true });
    try {
      const created = futureCheck.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'process_guard_records'
      `).get();
      // Merely inspecting an unsupported future registry must not backfill the
      // current schema into a database owned by a newer application version.
      expect(created).toBeNull();
    } finally {
      futureCheck.close();
    }

    const corrupt = fixtureRoot('corrupt-row');
    const registry = prepareAgentRuntimeGuardRegistry(corrupt.appDataDir);
    const deadPid = await definitelyDeadPid();
    registry.reserve({ kind: 'codex', cwd: corrupt.cwd, parentPid: deadPid });
    const corruptDatabase = new Database(registry.databasePath);
    corruptDatabase.exec('PRAGMA ignore_check_constraints = ON');
    corruptDatabase.query(`UPDATE process_guard_records SET scope_hash = 'invalid'`).run();
    corruptDatabase.close();

    expect(() => inspectAgentRuntimeGuardRecords(registry)).toThrow('invalid record');
    expect(() => registry.canRecoverDeadOwner(ownerFor(deadPid))).toThrow('invalid record');
    expect(() => prepareAgentRuntimeGuardRegistry(corrupt.appDataDir)).toThrow('invalid record');
  });

  test.skipIf(process.platform === 'win32')(
    'fails closed on unsafe database links and permissions, including startup',
    () => {
      const linked = fixtureRoot('database-symlink');
      const linkedRegistry = prepareAgentRuntimeGuardRegistry(linked.appDataDir);
      const outside = join(linked.root, 'outside.sqlite');
      writeFileSync(outside, 'not a registry', { mode: 0o600 });
      unlinkSync(linkedRegistry.databasePath);
      symlinkSync(outside, linkedRegistry.databasePath);
      expect(() => inspectAgentRuntimeGuardRecords(linkedRegistry)).toThrow('regular file');
      expect(() => prepareAgentRuntimeGuardRegistry(linked.appDataDir)).toThrow('regular file');

      const permissiveFile = fixtureRoot('database-mode');
      const fileRegistry = prepareAgentRuntimeGuardRegistry(permissiveFile.appDataDir);
      chmodSync(fileRegistry.databasePath, 0o644);
      expect(() => inspectAgentRuntimeGuardRecords(fileRegistry)).toThrow('permissions are unsafe');
      expect(() => prepareAgentRuntimeGuardRegistry(permissiveFile.appDataDir))
        .toThrow('permissions are unsafe');

      const permissiveDirectory = fixtureRoot('directory-mode');
      const directoryRegistry = prepareAgentRuntimeGuardRegistry(permissiveDirectory.appDataDir);
      chmodSync(dirname(directoryRegistry.databasePath), 0o755);
      expect(() => inspectAgentRuntimeGuardRecords(directoryRegistry))
        .toThrow('directory permissions are unsafe');
      expect(() => prepareAgentRuntimeGuardRegistry(permissiveDirectory.appDataDir))
        .toThrow('directory permissions are unsafe');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'narrows a safe legacy directory only before the first registry is created',
    () => {
      const { appDataDir } = fixtureRoot('legacy-directory-mode');
      const runtimeDirectory = join(appDataDir, 'agent-runtime');
      mkdirSync(runtimeDirectory, { recursive: true, mode: 0o755 });
      chmodSync(appDataDir, 0o755);
      chmodSync(runtimeDirectory, 0o755);

      const registry = prepareAgentRuntimeGuardRegistry(appDataDir);

      expect(statSync(appDataDir).mode & 0o777).toBe(0o700);
      expect(statSync(runtimeDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(registry.databasePath).mode & 0o777).toBe(0o600);
    },
  );

  test('does not silently trust a pre-existing empty registry file', () => {
    const { appDataDir } = fixtureRoot('empty-existing-database');
    const runtimeDirectory = join(appDataDir, 'agent-runtime');
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const databasePath = join(
      realpathSync(runtimeDirectory),
      AGENT_RUNTIME_GUARD_REGISTRY_FILENAME,
    );
    writeFileSync(databasePath, '', { mode: 0o600 });

    // A zero-byte file after an unclean shutdown is ambiguous: it may have
    // replaced durable active-group evidence. Treating it as a brand-new
    // registry would authorize dead-owner workspace-lock recovery.
    expect(() => prepareAgentRuntimeGuardRegistry(appDataDir))
      .toThrow('registry is corrupt');
    expect(statSync(databasePath).size).toBe(0);
  });

  test.skipIf(process.platform === 'win32')(
    'serializes activation against dead-owner recovery so exactly one side wins',
    async () => {
      const { root, appDataDir, cwd } = fixtureRoot('activation-race');
      const registry = prepareAgentRuntimeGuardRegistry(appDataDir);
      const deadPid = await definitelyDeadPid();
      const owner = ownerFor(deadPid);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const reservation = registry.reserve({ kind: 'codex', cwd, parentPid: deadPid });
        const barrierPath = join(root, `race-${attempt}.go`);
        const readyPath = join(root, `race-${attempt}.ready`);
        const resultPath = join(root, `race-${attempt}.result.json`);
        const child = spawnActivator({
          reservation,
          expectedParentPid: deadPid,
          barrierPath,
          readyPath,
          resultPath,
        });
        await eventually(() => existsSync(readyPath) ? true : null);

        writeFileSync(barrierPath, 'go', { mode: 0o600 });
        const recovered = registry.canRecoverDeadOwner(owner);
        const result = await eventually(() => readJson<ActivationResult>(resultPath));

        if (result.outcome === 'active') {
          expect(recovered).toBe(false);
          expect(processGroupAlive(child.pid)).toBe(true);
          await stopChild(child);
          await eventually(() => processGroupAlive(child.pid) ? null : true);
          expect(registry.canRecoverDeadOwner(owner)).toBe(true);
        } else {
          expect(recovered).toBe(true);
          await child.exited;
          children.delete(child);
        }
        expect(inspectAgentRuntimeGuardRecords(registry)).toEqual([]);
      }
    },
    15_000,
  );

  test('does not mutate a symlink target before rejecting an unsafe app-data path', () => {
    if (process.platform === 'win32') return;
    const { root } = fixtureRoot('app-data-symlink');
    const outside = join(root, 'outside-app-data');
    const linkedAppData = join(root, 'linked-app-data');
    mkdirSync(outside, { mode: 0o755 });
    chmodSync(outside, 0o755);
    symlinkSync(outside, linkedAppData, 'dir');

    expect(() => prepareAgentRuntimeGuardRegistry(linkedAppData)).toThrow('directory is unsafe');
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });
});
