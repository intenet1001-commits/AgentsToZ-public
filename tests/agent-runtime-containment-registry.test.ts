import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION,
  AgentRuntimeContainmentRegistry,
  AgentRuntimeContainmentRegistryError,
  containmentRegistryRecordToPublicState,
  openAgentRuntimeContainmentRegistry,
  type AgentRuntimeContainmentRegistryErrorCode,
  type ReserveAppleContainerContainmentInput,
} from '../src/agentRuntimeContainmentRegistry';
import { deriveAppleContainerName } from '../src/appleContainerCommandPlan';

const roots: string[] = [];
const registries: AgentRuntimeContainmentRegistry[] = [];
const STAGING_IDENTITY = 'd2'.repeat(32);

afterEach(() => {
  for (const registry of registries.splice(0).reverse()) registry.close();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; path: string } {
  // macOS exposes /var through /private/var. Registry paths deliberately
  // require their lexical parent to equal realpath, so tests use the canonical
  // temporary directory just as production callers must.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-containment-registry-')));
  roots.push(root);
  return { root, path: join(root, 'private-registry.sqlite') };
}

function open(path: string, clock?: () => string): AgentRuntimeContainmentRegistry {
  const registry = openAgentRuntimeContainmentRegistry(path, { clock });
  registries.push(registry);
  return registry;
}

function reservation(
  root: string,
  suffix = '12345678',
): ReserveAppleContainerContainmentInput {
  return {
    taskId: `task_${suffix}`,
    kind: 'apple-container-vm',
    nonce: suffix.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'b'),
    imageReference: `ghcr.io/agentstoz/codex-runtime@sha256:${'c1'.repeat(32)}`,
    executionPolicyDigest: 'e5'.repeat(32),
    kernelSha256: 'a6'.repeat(32),
    brokerTcbDigest: 'b7'.repeat(32),
    privateStagingRoot: join(root, 'staging'),
    stagingPath: join(root, 'staging', `task-${suffix}`),
    baseTarget: {
      targetId: `target_${suffix}`,
      kind: 'main',
      canonicalPath: join(root, 'projects', `project-${suffix}`),
      identity: 'e3'.repeat(32),
      gitCommit: 'f4'.repeat(20),
    },
  };
}

function seal(
  registry: AgentRuntimeContainmentRegistry,
  input: ReserveAppleContainerContainmentInput,
  stagingIdentity = STAGING_IDENTITY,
) {
  return registry.sealStaging({
    taskId: input.taskId,
    expectedGeneration: 1,
    stagingIdentity,
  });
}

function expectCode(
  operation: () => unknown,
  code: AgentRuntimeContainmentRegistryErrorCode,
): void {
  try {
    operation();
    throw new Error('Expected containment registry failure.');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeContainmentRegistryError);
    expect((error as AgentRuntimeContainmentRegistryError).code).toBe(code);
  }
}

function closeTracked(registry: AgentRuntimeContainmentRegistry): void {
  registry.close();
  const index = registries.indexOf(registry);
  if (index >= 0) registries.splice(index, 1);
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('Agent Runtime containment private registry', () => {
  test('cannot construct a registry handle without the private validated-factory token', () => {
    const database = new Database(':memory:');
    expectCode(
      () => new AgentRuntimeContainmentRegistry(database, Symbol('forged')),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );
    database.close();
  });

  test('durably reserves every pre-staging identity before resource creation', () => {
    const { root, path } = fixture();
    const occurredAt = '2026-09-04T08:00:00.000Z';
    const input = reservation(root);
    const registry = open(path, () => occurredAt);
    expect(existsSync(input.privateStagingRoot)).toBe(false);
    const result = registry.reserveAppleContainer(input);

    expect(result.duplicate).toBe(false);
    expect(existsSync(input.privateStagingRoot)).toBe(false);
    expect(result.record).toMatchObject({
      schemaVersion: AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION,
      taskId: input.taskId,
      kind: 'apple-container-vm',
      lifecycle: 'reserved',
      generation: 1,
      containerName: deriveAppleContainerName(input),
      nonce: input.nonce,
      imageReference: input.imageReference,
      imageDigest: 'c1'.repeat(32),
      executionPolicyDigest: input.executionPolicyDigest,
      kernelSha256: input.kernelSha256,
      brokerTcbDigest: input.brokerTcbDigest,
      privateStagingRoot: input.privateStagingRoot,
      stagingPath: input.stagingPath,
      stagingIdentity: null,
      baseTarget: input.baseTarget,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.baseTarget)).toBe(true);
    expect(registry.readAudit(input.taskId)).toEqual([{
      taskId: input.taskId,
      generation: 1,
      fromLifecycle: null,
      toLifecycle: 'reserved',
      stagingIdentity: null,
      executionPolicyDigest: input.executionPolicyDigest,
      kernelSha256: input.kernelSha256,
      brokerTcbDigest: input.brokerTcbDigest,
      occurredAt,
    }]);

    const database = new Database(path, { readonly: true });
    expect(database.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(database.query('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(database.query('PRAGMA user_version').get()).toEqual({
      user_version: AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION,
    });
    database.close();
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);

    closeTracked(registry);
    const reopened = open(path);
    expect(reopened.get(input.taskId)).toEqual(result.record);
    expect(reopened.listIncomplete()).toEqual([result.record]);
  });

  test('makes reservation retries idempotent and rejects ownership or sealed identity reuse', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    const first = registry.reserveAppleContainer(input);
    const duplicate = registry.reserveAppleContainer(input);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record).toEqual(first.record);
    expect(registry.readAudit(input.taskId)).toHaveLength(1);

    expectCode(() => registry.reserveAppleContainer({
      ...input,
      stagingPath: join(root, 'staging', 'different-task-path'),
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT');
    expectCode(() => registry.reserveAppleContainer({
      ...input,
      executionPolicyDigest: 'a8'.repeat(32),
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT');
    const second = reservation(root, 'abcdef12');
    expectCode(
      () => registry.reserveAppleContainer({
        ...second,
        nonce: input.nonce,
      }),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT',
    );
    registry.reserveAppleContainer(second);
    seal(registry, input);
    expect(registry.reserveAppleContainer(input)).toMatchObject({ duplicate: true });
    expectCode(() => seal(registry, second),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT');
  });

  test('validates the audit chain before authorizing an idempotent reservation retry', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    registry.reserveAppleContainer(input);
    const tamper = new Database(path);
    const auditDeleteGuard = tamper.query(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'agent_runtime_containment_audit_no_delete'
    `).get() as { sql: string };
    tamper.exec('DROP TRIGGER agent_runtime_containment_audit_no_delete');
    tamper.query(`
      DELETE FROM agent_runtime_containment_transitions
      WHERE task_id = ? AND generation = 1
    `).run(input.taskId);
    tamper.exec(auditDeleteGuard.sql);
    tamper.close();

    expectCode(
      () => registry.reserveAppleContainer(input),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );
  });

  test('uses compare-and-swap generations and appends every legal transition atomically', () => {
    const { root, path } = fixture();
    let tick = 0;
    const registry = open(path, () => new Date(Date.UTC(2026, 8, 4, 8, 0, tick++)).toISOString());
    const input = reservation(root);
    registry.reserveAppleContainer(input);
    let current = seal(registry, input);
    for (const nextLifecycle of [
      'containment-created',
      'running',
      'stopping',
      'stopped-proven',
      'result-validated',
      'materialized',
      'disposed',
    ] as const) {
      current = registry.transition({
        taskId: input.taskId,
        expectedGeneration: current.generation,
        expectedLifecycle: current.lifecycle,
        nextLifecycle,
      });
    }
    expect(current).toMatchObject({ lifecycle: 'disposed', generation: 9 });
    expect(registry.readAudit(input.taskId).map(event => [
      event.generation,
      event.fromLifecycle,
      event.toLifecycle,
      event.stagingIdentity,
    ])).toEqual([
      [1, null, 'reserved', null],
      [2, 'reserved', 'staging-prepared', STAGING_IDENTITY],
      [3, 'staging-prepared', 'containment-created', STAGING_IDENTITY],
      [4, 'containment-created', 'running', STAGING_IDENTITY],
      [5, 'running', 'stopping', STAGING_IDENTITY],
      [6, 'stopping', 'stopped-proven', STAGING_IDENTITY],
      [7, 'stopped-proven', 'result-validated', STAGING_IDENTITY],
      [8, 'result-validated', 'materialized', STAGING_IDENTITY],
      [9, 'materialized', 'disposed', STAGING_IDENTITY],
    ]);
    expectCode(() => registry.transition({
      taskId: input.taskId,
      expectedGeneration: 8,
      expectedLifecycle: 'materialized',
      nextLifecycle: 'disposed',
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT');
  });

  test('rejects skipped or repeated lifecycle edges before changing durable state', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    registry.reserveAppleContainer(input);
    expectCode(() => registry.transition({
      taskId: input.taskId,
      expectedGeneration: 1,
      expectedLifecycle: 'reserved',
      nextLifecycle: 'staging-prepared',
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_TRANSITION_INVALID');
    expectCode(() => registry.transition({
      taskId: input.taskId,
      expectedGeneration: 1,
      expectedLifecycle: 'reserved',
      nextLifecycle: 'containment-created',
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_TRANSITION_INVALID');
    expectCode(() => registry.transition({
      taskId: input.taskId,
      expectedGeneration: 1,
      expectedLifecycle: 'reserved',
      nextLifecycle: 'reserved',
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_TRANSITION_INVALID');
    expect(registry.get(input.taskId)).toMatchObject({
      lifecycle: 'reserved',
      generation: 1,
      stagingIdentity: null,
    });
    expect(registry.readAudit(input.taskId)).toHaveLength(1);
  });

  test('supports cleanup edges and retains disposed rows outside the incomplete list', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    const reserved = registry.reserveAppleContainer(input).record;
    const stopping = registry.transition({
      taskId: input.taskId,
      expectedGeneration: reserved.generation,
      expectedLifecycle: reserved.lifecycle,
      nextLifecycle: 'stopping',
    });
    const stopped = registry.transition({
      taskId: input.taskId,
      expectedGeneration: stopping.generation,
      expectedLifecycle: stopping.lifecycle,
      nextLifecycle: 'stopped-proven',
    });
    const disposed = registry.transition({
      taskId: input.taskId,
      expectedGeneration: stopped.generation,
      expectedLifecycle: stopped.lifecycle,
      nextLifecycle: 'disposed',
    });
    expect(registry.listIncomplete()).toEqual([]);
    expect(registry.listActive()).toEqual([]);
    expect(registry.get(input.taskId)).toEqual(disposed);
    expect(disposed.stagingIdentity).toBeNull();
    expect(registry.readAudit(input.taskId)).toEqual([
      expect.objectContaining({ generation: 1, stagingIdentity: null }),
      expect.objectContaining({ generation: 2, stagingIdentity: null }),
      expect.objectContaining({ generation: 3, stagingIdentity: null }),
      expect.objectContaining({ generation: 4, stagingIdentity: null }),
    ]);

    closeTracked(registry);
    const reopened = open(path);
    expect(reopened.get(input.taskId)).toEqual(disposed);
  });

  test('database guards keep task identity and audit rows append-only', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    registry.reserveAppleContainer(input);
    closeTracked(registry);

    const direct = new Database(path);
    expect(() => direct.query(`
      UPDATE agent_runtime_containments
      SET lifecycle = 'staging-prepared', generation = 2, updated_at = ?
      WHERE task_id = ?
    `).run('2026-09-04T08:01:00.000Z', input.taskId)).toThrow();
    expect(() => direct.query(`
      UPDATE agent_runtime_containments SET staging_identity = ? WHERE task_id = ?
    `).run(STAGING_IDENTITY, input.taskId)).toThrow();
    expect(() => direct.query(`
      UPDATE agent_runtime_containments SET nonce = ? WHERE task_id = ?
    `).run('a8'.repeat(32), input.taskId)).toThrow();
    expect(() => direct.query(`
      UPDATE agent_runtime_containments SET broker_tcb_digest = ? WHERE task_id = ?
    `).run('a9'.repeat(32), input.taskId)).toThrow();
    expect(() => direct.query(`
      UPDATE agent_runtime_containment_transitions
      SET occurred_at = ? WHERE task_id = ? AND generation = 1
    `).run('2026-09-04T00:00:00.000Z', input.taskId)).toThrow();
    expect(() => direct.query(`
      DELETE FROM agent_runtime_containment_transitions
      WHERE task_id = ? AND generation = 1
    `).run(input.taskId)).toThrow();
    expect(() => direct.query(`
      DELETE FROM agent_runtime_containments WHERE task_id = ?
    `).run(input.taskId)).toThrow();
    direct.close();

    const reopened = open(path);
    expect(reopened.get(input.taskId)).toMatchObject({
      nonce: input.nonce,
      generation: 1,
      lifecycle: 'reserved',
    });
    expect(reopened.readAudit(input.taskId)).toHaveLength(1);
  });

  test('seals staging once with CAS and keeps the sealed identity immutable through cleanup', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    const reserved = registry.reserveAppleContainer(input).record;
    expectCode(() => registry.sealStaging({
      taskId: input.taskId,
      expectedGeneration: reserved.generation,
      stagingIdentity: 'not-a-digest',
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');

    const sealed = seal(registry, input);
    expect(sealed).toMatchObject({
      lifecycle: 'staging-prepared',
      generation: 2,
      stagingIdentity: STAGING_IDENTITY,
    });
    expectCode(() => seal(registry, input),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT');
    const stopping = registry.transition({
      taskId: input.taskId,
      expectedGeneration: sealed.generation,
      expectedLifecycle: sealed.lifecycle,
      nextLifecycle: 'stopping',
    });
    expect(stopping.stagingIdentity).toBe(STAGING_IDENTITY);
    expect(registry.readAudit(input.taskId).map(event => event.stagingIdentity)).toEqual([
      null,
      STAGING_IDENTITY,
      STAGING_IDENTITY,
    ]);

    closeTracked(registry);
    const direct = new Database(path);
    expect(() => direct.query(`
      UPDATE agent_runtime_containments
      SET lifecycle = 'stopped-proven', generation = 4,
          staging_identity = ?, updated_at = ?
      WHERE task_id = ?
    `).run('a5'.repeat(32), '2026-09-04T08:02:00.000Z', input.taskId)).toThrow();
    direct.close();
    const reopened = open(path);
    expect(reopened.get(input.taskId)).toEqual(stopping);
  });

  test('projects an exact four-field public state without leaking private identity', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    const record = registry.reserveAppleContainer(input).record;
    for (const publicState of [
      containmentRegistryRecordToPublicState(record),
      registry.getPublicState(input.taskId),
    ]) {
      expect(publicState).toEqual({
        schemaVersion: 1,
        taskId: input.taskId,
        kind: 'apple-container-vm',
        lifecycle: 'reserved',
      });
      expect(Object.keys(publicState!)).toEqual(['schemaVersion', 'taskId', 'kind', 'lifecycle']);
      const serialized = JSON.stringify(publicState);
      for (const secret of [
        input.nonce,
        input.imageReference,
        input.executionPolicyDigest,
        input.kernelSha256,
        input.brokerTcbDigest,
        input.stagingPath,
        input.baseTarget.canonicalPath,
        deriveAppleContainerName(input),
      ]) expect(serialized).not.toContain(secret);
    }
  });

  test('strictly validates private paths, digests, commits and exact input shape', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const input = reservation(root);
    for (const invalid of [
      { ...input, nonce: 'A1'.repeat(32) },
      { ...input, imageReference: 'ghcr.io/agentstoz/runtime:latest' },
      { ...input, executionPolicyDigest: 'not-a-digest' },
      { ...input, kernelSha256: 'A6'.repeat(32) },
      { ...input, brokerTcbDigest: 'short' },
      { ...input, stagingPath: input.baseTarget.canonicalPath },
      { ...input, stagingIdentity: STAGING_IDENTITY },
      { ...input, baseTarget: { ...input.baseTarget, identity: 'short' } },
      { ...input, baseTarget: { ...input.baseTarget, gitCommit: 'F4'.repeat(20) } },
      { ...input, baseTarget: { ...input.baseTarget, kind: 'branch' } },
      { ...input, extraPrivateField: 'must-not-be-accepted' },
    ]) {
      expectCode(
        () => registry.reserveAppleContainer(invalid as ReserveAppleContainerContainmentInput),
        'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT',
      );
    }
    expect(registry.listIncomplete()).toEqual([]);
  });

  test('lists every incomplete reservation deterministically and fails closed on truncation', () => {
    const { root, path } = fixture();
    const registry = open(path);
    const first = reservation(root, 'aaaa1111');
    const second = {
      ...reservation(root, 'bbbb2222'),
      baseTarget: { ...reservation(root, 'bbbb2222').baseTarget, identity: '13'.repeat(32) },
    };
    registry.reserveAppleContainer(first);
    registry.reserveAppleContainer(second);
    expect(registry.listIncomplete().map(record => record.taskId)).toEqual([
      first.taskId,
      second.taskId,
    ]);
    expectCode(
      () => registry.listIncomplete(1),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAPACITY_EXCEEDED',
    );
    expectCode(
      () => registry.listActive(1),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAPACITY_EXCEEDED',
    );
    expectCode(
      () => registry.listIncomplete(0),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT',
    );
  });

  test('detects overflow beyond the default 1000-row startup reconciliation bound', () => {
    const { root } = fixture();
    const registry = open(':memory:');
    const base = reservation(root, 'cafe0000');
    for (let index = 0; index <= 1_000; index += 1) {
      const suffix = String(index).padStart(4, '0');
      registry.reserveAppleContainer({
        ...base,
        taskId: `task_capacity_${suffix}`,
        nonce: index.toString(16).padStart(64, '0'),
        stagingPath: join(root, 'staging', `capacity-${suffix}`),
      });
    }
    expectCode(
      () => registry.listIncomplete(),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAPACITY_EXCEEDED',
    );
  });

  test('fails closed on future schema and never rewrites it', () => {
    const { root, path } = fixture();
    const registry = open(path);
    registry.reserveAppleContainer(reservation(root));
    closeTracked(registry);
    const database = new Database(path);
    database.exec('PRAGMA user_version = 999');
    database.query(`
      UPDATE agent_runtime_containment_meta SET schema_version = 999 WHERE singleton = 1
    `).run();
    database.close();
    const beforeHash = fileHash(path);
    expectCode(
      () => openAgentRuntimeContainmentRegistry(path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_FUTURE_SCHEMA',
    );
    const proof = new Database(path, { readonly: true });
    expect(fileHash(path)).toBe(beforeHash);
    expect(proof.query('PRAGMA user_version').get()).toEqual({ user_version: 999 });
    proof.close();
  });

  test('fails closed on an older schema marker and does not auto-migrate it', () => {
    const { path } = fixture();
    const registry = open(path);
    closeTracked(registry);
    const database = new Database(path);
    database.exec('PRAGMA user_version = 1');
    database.query(`
      UPDATE agent_runtime_containment_meta SET schema_version = 1 WHERE singleton = 1
    `).run();
    const before = database.query(`
      SELECT sql FROM sqlite_master WHERE name = 'agent_runtime_containments'
    `).get();
    database.close();
    const beforeHash = fileHash(path);

    expectCode(
      () => openAgentRuntimeContainmentRegistry(path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );
    const proof = new Database(path, { readonly: true });
    expect(fileHash(path)).toBe(beforeHash);
    expect(proof.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(proof.query(`
      SELECT schema_version FROM agent_runtime_containment_meta WHERE singleton = 1
    `).get()).toEqual({ schema_version: 1 });
    expect(proof.query(`
      SELECT sql FROM sqlite_master WHERE name = 'agent_runtime_containments'
    `).get()).toEqual(before);
    proof.close();
  });

  test('does not checkpoint or rewrite WAL databases with old or future schema markers', () => {
    for (const version of [1, 999]) {
      const { path } = fixture();
      const registry = open(path);
      closeTracked(registry);
      const database = new Database(path);
      expect(database.query('PRAGMA journal_mode = WAL').get()).toEqual({ journal_mode: 'wal' });
      database.exec('PRAGMA wal_autocheckpoint = 0');
      database.exec('BEGIN IMMEDIATE');
      database.exec(`PRAGMA user_version = ${version}`);
      database.query(`
        UPDATE agent_runtime_containment_meta SET schema_version = ? WHERE singleton = 1
      `).run(version);
      database.exec('COMMIT');
      const walPath = `${path}-wal`;
      const shmPath = `${path}-shm`;
      expect(existsSync(walPath)).toBe(true);
      expect(existsSync(shmPath)).toBe(true);
      const mainBefore = fileHash(path);
      const walBefore = fileHash(walPath);
      const shmBefore = fileHash(shmPath);

      expectCode(
        () => openAgentRuntimeContainmentRegistry(path),
        'AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY',
      );
      expect(fileHash(path)).toBe(mainBefore);
      expect(fileHash(walPath)).toBe(walBefore);
      expect(fileHash(shmPath)).toBe(shmBefore);
      expect(database.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      database.close();
    }
  });

  test('preserves orphan journal artifacts when the main database is missing or empty', () => {
    for (const mainState of ['missing', 'empty'] as const) {
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const { path } = fixture();
        if (mainState === 'empty') writeFileSync(path, '', { mode: 0o600 });
        const artifactPath = `${path}${suffix}`;
        writeFileSync(artifactPath, `orphan-${suffix}-${mainState}`, { mode: 0o600 });
        const artifactBefore = fileHash(artifactPath);

        expectCode(
          () => openAgentRuntimeContainmentRegistry(path),
          'AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY',
        );
        expect(existsSync(path)).toBe(mainState === 'empty');
        if (mainState === 'empty') expect(readFileSync(path).byteLength).toBe(0);
        expect(fileHash(artifactPath)).toBe(artifactBefore);
      }
    }
  });

  test('fails closed when canonical table constraints are weakened', () => {
    const { path } = fixture();
    const registry = open(path);
    closeTracked(registry);
    const database = new Database(path);
    const schemaRows = database.query(`
      SELECT name, sql FROM sqlite_master
      WHERE name LIKE 'agent_runtime_containment%'
    `).all() as Array<{ name: string; sql: string | null }>;
    const schemaSql = (name: string): string => {
      const sql = schemaRows.find(row => row.name === name)?.sql;
      if (!sql) throw new Error(`missing test schema object: ${name}`);
      return sql;
    };
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec(`
      DROP TABLE agent_runtime_containment_transitions;
      DROP TABLE agent_runtime_containments;
    `);
    database.exec(`${schemaSql('agent_runtime_containments')
      .replace('generation >= 1', 'generation >= 0')};`);
    for (const name of [
      'agent_runtime_containments_active_idx',
      'agent_runtime_containments_staging_identity_uq',
      'agent_runtime_containment_transitions',
      'agent_runtime_containment_transition_guard',
      'agent_runtime_containment_transition_audit',
      'agent_runtime_containment_no_delete',
      'agent_runtime_containment_audit_no_update',
      'agent_runtime_containment_audit_no_delete',
    ]) database.exec(`${schemaSql(name)};`);
    database.close();
    expectCode(
      () => openAgentRuntimeContainmentRegistry(path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );
  });

  test('fails closed when the partial staging identity uniqueness contract is replaced', () => {
    const { path } = fixture();
    const registry = open(path);
    closeTracked(registry);
    const database = new Database(path);
    database.exec(`
      DROP INDEX agent_runtime_containments_staging_identity_uq;
      CREATE INDEX agent_runtime_containments_staging_identity_uq
        ON agent_runtime_containments(staging_identity)
        WHERE staging_identity IS NOT NULL;
    `);
    database.close();
    expectCode(
      () => openAgentRuntimeContainmentRegistry(path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );
  });

  test('fails closed when a sealed row or its attestation audit is tampered', () => {
    const rowFixture = fixture();
    const rowRegistry = open(rowFixture.path);
    const rowInput = reservation(rowFixture.root);
    rowRegistry.reserveAppleContainer(rowInput);
    seal(rowRegistry, rowInput);
    closeTracked(rowRegistry);
    const rowDatabase = new Database(rowFixture.path);
    const transitionGuard = rowDatabase.query(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'agent_runtime_containment_transition_guard'
    `).get() as { sql: string };
    const transitionAudit = rowDatabase.query(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'agent_runtime_containment_transition_audit'
    `).get() as { sql: string };
    rowDatabase.exec('DROP TRIGGER agent_runtime_containment_transition_guard');
    rowDatabase.exec('DROP TRIGGER agent_runtime_containment_transition_audit');
    rowDatabase.exec('PRAGMA ignore_check_constraints = ON');
    rowDatabase.query(`
      UPDATE agent_runtime_containments SET staging_identity = NULL WHERE task_id = ?
    `).run(rowInput.taskId);
    rowDatabase.exec('PRAGMA ignore_check_constraints = OFF');
    rowDatabase.exec(transitionGuard.sql);
    rowDatabase.exec(transitionAudit.sql);
    rowDatabase.close();
    expectCode(
      () => openAgentRuntimeContainmentRegistry(rowFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );

    const auditFixture = fixture();
    const auditRegistry = open(auditFixture.path);
    const auditInput = reservation(auditFixture.root, 'audit123');
    auditRegistry.reserveAppleContainer(auditInput);
    seal(auditRegistry, auditInput);
    closeTracked(auditRegistry);
    const auditDatabase = new Database(auditFixture.path);
    const auditGuard = auditDatabase.query(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'agent_runtime_containment_audit_no_update'
    `).get() as { sql: string };
    auditDatabase.exec('DROP TRIGGER agent_runtime_containment_audit_no_update');
    auditDatabase.query(`
      UPDATE agent_runtime_containment_transitions
      SET execution_policy_digest = ? WHERE task_id = ? AND generation = 2
    `).run('a5'.repeat(32), auditInput.taskId);
    auditDatabase.exec(auditGuard.sql);
    auditDatabase.close();
    expectCode(
      () => openAgentRuntimeContainmentRegistry(auditFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );
  });

  test('rejects corrupt bytes, missing audit rows and unknown database objects', () => {
    const corruptFixture = fixture();
    writeFileSync(corruptFixture.path, 'not sqlite', { mode: 0o600 });
    expectCode(
      () => openAgentRuntimeContainmentRegistry(corruptFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );

    const auditFixture = fixture();
    const registry = open(auditFixture.path);
    const input = reservation(auditFixture.root);
    registry.reserveAppleContainer(input);
    closeTracked(registry);
    const tamper = new Database(auditFixture.path);
    tamper.exec('DROP TRIGGER agent_runtime_containment_audit_no_delete');
    tamper.query(`
      DELETE FROM agent_runtime_containment_transitions WHERE task_id = ? AND generation = 1
    `).run(input.taskId);
    tamper.exec(`
      CREATE TRIGGER agent_runtime_containment_audit_no_delete
      BEFORE DELETE ON agent_runtime_containment_transitions
      BEGIN SELECT RAISE(ABORT, 'containment audit is append-only'); END;
    `);
    tamper.close();
    expectCode(
      () => openAgentRuntimeContainmentRegistry(auditFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );

    const extraFixture = fixture();
    const extraRegistry = open(extraFixture.path);
    closeTracked(extraRegistry);
    const extra = new Database(extraFixture.path);
    extra.exec('CREATE TABLE unexpected_private_data(secret TEXT)');
    extra.close();
    expectCode(
      () => openAgentRuntimeContainmentRegistry(extraFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT',
    );
  });

  test('rejects symlinked, hard-linked and non-private database locations', () => {
    const symlinkFixture = fixture();
    const target = join(symlinkFixture.root, 'target.sqlite');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, symlinkFixture.path);
    expectCode(
      () => openAgentRuntimeContainmentRegistry(symlinkFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH',
    );

    const ancestorFixture = fixture();
    const realParent = join(ancestorFixture.root, 'real-parent');
    const nestedParent = join(realParent, 'nested');
    const aliasParent = join(ancestorFixture.root, 'alias-parent');
    mkdirSync(nestedParent, { recursive: true, mode: 0o700 });
    symlinkSync(realParent, aliasParent);
    // The immediate `nested` component resolves as a real directory; only a
    // full realpath comparison detects the symlink in its ancestor.
    expectCode(
      () => openAgentRuntimeContainmentRegistry(join(aliasParent, 'nested', 'registry.sqlite')),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH',
    );

    const hardLinkFixture = fixture();
    const hardLinkTarget = join(hardLinkFixture.root, 'target.sqlite');
    writeFileSync(hardLinkTarget, '', { mode: 0o600 });
    linkSync(hardLinkTarget, hardLinkFixture.path);
    expectCode(
      () => openAgentRuntimeContainmentRegistry(hardLinkFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH',
    );

    const permissionsFixture = fixture();
    chmodSync(permissionsFixture.root, 0o755);
    expectCode(
      () => openAgentRuntimeContainmentRegistry(permissionsFixture.path),
      'AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH',
    );
  });

  test('detects stale CAS across separately opened registry handles', () => {
    const { root, path } = fixture();
    const first = open(path);
    const input = reservation(root);
    first.reserveAppleContainer(input);
    const second = open(path);
    first.sealStaging({
      taskId: input.taskId,
      expectedGeneration: 1,
      stagingIdentity: STAGING_IDENTITY,
    });
    expectCode(() => second.transition({
      taskId: input.taskId,
      expectedGeneration: 1,
      expectedLifecycle: 'reserved',
      nextLifecycle: 'stopping',
    }), 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT');
    expect(second.get(input.taskId)).toMatchObject({
      lifecycle: 'staging-prepared',
      generation: 2,
    });
  });
});
