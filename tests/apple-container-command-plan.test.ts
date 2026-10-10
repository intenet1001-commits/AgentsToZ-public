import { describe, expect, test } from 'bun:test';
import {
  APPLE_CONTAINER_EXECUTABLE,
  APPLE_CONTAINER_GUEST_STAGING_PATH,
  APPLE_CONTAINER_KERNEL_PATH,
  APPLE_CONTAINER_KERNEL_SOURCE_ARCHIVE_SHA256,
  APPLE_CONTAINER_MAX_LIST_ENTRIES,
  APPLE_CONTAINER_MAX_OUTPUT_BYTES,
  APPLE_CONTAINER_NONCE_LABEL,
  APPLE_CONTAINER_RUNTIME_HANDLER,
  APPLE_CONTAINER_VMINIT_IMAGE,
  deriveAppleContainerName,
  parseAppleContainerInspectProof,
  parseAppleContainerListProof,
  planAppleContainerCleanup,
  planAppleContainerCreate,
  planAppleContainerInspect,
  planAppleContainerListAll,
  planAppleContainerStart,
  type AppleContainerInspectExpectation,
} from '../src/appleContainerCommandPlan';

const TASK = Object.freeze({
  taskId: 'task_12345678-1234-1234-1234-123456789abc',
  nonce: 'a1'.repeat(32),
});
const IMAGE = `ghcr.io/agentstoz/codex-runtime@sha256:${'b2'.repeat(32)}`;
const CREATE_INPUT = Object.freeze({
  ...TASK,
  privateStagingRoot: '/private/var/agentstoz/tasks',
  stagingPath: '/private/var/agentstoz/tasks/task-one/staging',
  image: IMAGE,
});
const IMAGE_DESCRIPTOR = Object.freeze({
  mediaType: 'application/vnd.oci.image.index.v1+json',
  digest: `sha256:${'b2'.repeat(32)}`,
  size: 1_234,
});

function inspectExpectation(
  state: 'stopped' | 'running' = 'running',
): Readonly<AppleContainerInspectExpectation> {
  return Object.freeze({
    state,
    imageDescriptor: IMAGE_DESCRIPTOR,
    initProcess: Object.freeze({
      executable: '/usr/local/bin/agentstoz-runtime',
      arguments: Object.freeze(['serve']),
      environment: Object.freeze(['PATH=/usr/local/bin:/usr/bin:/bin']),
      workingDirectory: APPLE_CONTAINER_GUEST_STAGING_PATH,
      terminal: false,
      user: Object.freeze({ kind: 'id' as const, uid: 65_532, gid: 65_532 }),
      supplementalGroups: Object.freeze([]),
      rlimits: Object.freeze([]),
    }),
  });
}

function appleJson(
  id: string,
  nonce: string | null = TASK.nonce,
  extra: Record<string, unknown> = {},
  state: 'stopped' | 'running' = 'running',
): string {
  const labels = nonce === null ? {} : { [APPLE_CONTAINER_NONCE_LABEL]: nonce };
  return JSON.stringify([{
    id,
    configuration: {
      id,
      labels,
      image: { reference: IMAGE, descriptor: IMAGE_DESCRIPTOR },
      mounts: [{
        type: { virtiofs: {} },
        source: CREATE_INPUT.stagingPath,
        destination: APPLE_CONTAINER_GUEST_STAGING_PATH,
        options: [],
      }],
      resources: { cpus: 2, memoryInBytes: 4 * 1024 * 1024 * 1024, cpuOverhead: 1 },
      platform: { os: 'linux', architecture: 'arm64' },
      initProcess: {
        executable: '/usr/local/bin/agentstoz-runtime',
        arguments: ['serve'],
        environment: ['PATH=/usr/local/bin:/usr/bin:/bin'],
        workingDirectory: APPLE_CONTAINER_GUEST_STAGING_PATH,
        terminal: false,
        user: { id: { uid: 65_532, gid: 65_532 } },
        supplementalGroups: [],
        rlimits: [],
      },
      runtimeHandler: APPLE_CONTAINER_RUNTIME_HANDLER,
      readOnly: true,
      rosetta: false,
      virtualization: false,
      ssh: false,
      useInit: false,
      capAdd: [],
      capDrop: ['ALL'],
      publishedPorts: [],
      publishedSockets: [],
      networks: [],
      sysctls: {},
      creationDate: '2026-09-04T06:00:00Z',
    },
    status: state === 'running'
      ? { state, networks: [], startedDate: '2026-09-04T06:00:01Z' }
      : { state, networks: [] },
    ...extra,
  }]);
}

describe('Apple Container trusted argv planner', () => {
  test('derives a stable safe private name from both task id and nonce', () => {
    const name = deriveAppleContainerName(TASK);
    expect(name).toMatch(/^agentstoz-ar-[a-f0-9]{48}$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).not.toContain(TASK.taskId);
    expect(name).not.toContain(TASK.nonce);
    expect(deriveAppleContainerName(TASK)).toBe(name);
    expect(deriveAppleContainerName({ ...TASK, nonce: 'c3'.repeat(32) })).not.toBe(name);
    expect(deriveAppleContainerName({ ...TASK, taskId: 'task_different_123' })).not.toBe(name);
  });

  test('builds stopped create with one private RW mount and fixed containment policy', () => {
    const name = deriveAppleContainerName(TASK);
    const create = planAppleContainerCreate(CREATE_INPUT);
    for (const command of [create]) {
      expect(command.executable).toBe(APPLE_CONTAINER_EXECUTABLE);
      expect(command.maxOutputBytes).toBe(APPLE_CONTAINER_MAX_OUTPUT_BYTES);
      expect(command.argv).toContain('--read-only');
      expect(command.argv).toContain('--no-dns');
      expect(command.argv).toContain(APPLE_CONTAINER_VMINIT_IMAGE);
      expect(command.argv).toContain(APPLE_CONTAINER_KERNEL_PATH);
      expect(command.argv).toContain(APPLE_CONTAINER_RUNTIME_HANDLER);
      expect(command.argv).toContain(IMAGE);
      expect(command.argv).toContain(name);
      expect(command.argv).toContain(`${APPLE_CONTAINER_NONCE_LABEL}=${TASK.nonce}`);
      expect(command.argv).toContain(
        `type=bind,source=${CREATE_INPUT.stagingPath},target=${APPLE_CONTAINER_GUEST_STAGING_PATH}`,
      );
      expect(command.argv.filter((arg) => arg === '--mount')).toHaveLength(1);
      expect(command.argv).not.toContain('--all');
      expect(command.argv).not.toContain('-a');
      expect(command.argv).not.toContain('--ssh');
      expect(command.argv).not.toContain('--publish');
      expect(command.argv).not.toContain('--env');
      expect(command.argv).not.toContain('--rm');
      expect(Object.isFrozen(command)).toBe(true);
      expect(Object.isFrozen(command.argv)).toBe(true);
    }
    expect(create.argv).toEqual([
      'create', '--name', name,
      '--label', `${APPLE_CONTAINER_NONCE_LABEL}=${TASK.nonce}`,
      '--read-only', '--cap-drop', 'ALL',
      '--cpus', '2', '--memory', '4096M',
      '--network', 'none', '--no-dns',
      '--mount', `type=bind,source=${CREATE_INPUT.stagingPath},target=${APPLE_CONTAINER_GUEST_STAGING_PATH}`,
      '--workdir', APPLE_CONTAINER_GUEST_STAGING_PATH,
      '--os', 'linux', '--arch', 'arm64',
      '--runtime', APPLE_CONTAINER_RUNTIME_HANDLER,
      '--init-image', APPLE_CONTAINER_VMINIT_IMAGE,
      '--kernel', APPLE_CONTAINER_KERNEL_PATH,
      '--scheme', 'https', IMAGE,
    ]);
    expect(create.argv).not.toContain('--progress');
    expect(create.argv.at(-1)).toBe(IMAGE);
    expect(create.argv).not.toContain('--init');
    expect(create.argv).toContain('--init-image');
    expect(APPLE_CONTAINER_KERNEL_SOURCE_ARCHIVE_SHA256).toBe(
      '8736c054d9223974735394f822000823baef509e1c33405ec798240fa9b6e4b5',
    );
  });

  test('bounds resource settings and accepts only the explicit no-network policy', () => {
    const plan = planAppleContainerCreate({
      ...CREATE_INPUT,
      cpuCount: 8,
      memoryMiB: 16 * 1024,
      networkPolicy: 'none',
    });
    expect(plan.argv).toContain('8');
    expect(plan.argv).toContain('16384M');
    for (const bad of [
      { cpuCount: 0 },
      { cpuCount: 9 },
      { cpuCount: 1.5 },
      { memoryMiB: 511 },
      { memoryMiB: 16 * 1024 + 1 },
      { networkPolicy: 'default' },
    ]) {
      expect(() => planAppleContainerCreate({ ...CREATE_INPUT, ...bad } as typeof CREATE_INPUT))
        .toThrow('APPLE_CONTAINER_PLAN_INVALID_INPUT');
    }
  });

  test('rejects tag-only, latest, malformed and ambiguous image references', () => {
    for (const image of [
      'ghcr.io/agentstoz/codex-runtime:latest',
      `ghcr.io/agentstoz/codex-runtime:1.0@sha256:${'b2'.repeat(32)}`,
      `codex-runtime@sha256:${'b2'.repeat(32)}`,
      `agentstoz/codex-runtime@sha256:${'b2'.repeat(32)}`,
      `ghcr..io/agentstoz/codex-runtime@sha256:${'b2'.repeat(32)}`,
      `-ghcr.io/agentstoz/codex-runtime@sha256:${'b2'.repeat(32)}`,
      `https://ghcr.io/agentstoz/codex-runtime@sha256:${'b2'.repeat(32)}`,
      `GHCR.IO/agentstoz/codex-runtime@sha256:${'b2'.repeat(32)}`,
      `ghcr.io/agentstoz/codex-runtime@sha256:${'b2'.repeat(31)}`,
      `localhost:99999/agentstoz/runtime@sha256:${'b2'.repeat(32)}`,
    ]) {
      expect(() => planAppleContainerCreate({ ...CREATE_INPUT, image }))
        .toThrow('APPLE_CONTAINER_PLAN_INVALID_INPUT');
    }
  });

  test('rejects non-private, non-normalized and mount-syntax-hostile staging paths', () => {
    for (const paths of [
      { privateStagingRoot: '/', stagingPath: '/task/staging' },
      { privateStagingRoot: '/private/tasks', stagingPath: '/private/tasks' },
      { privateStagingRoot: '/private/tasks', stagingPath: '/private/other/staging' },
      { privateStagingRoot: '/private/tasks', stagingPath: '/private/tasks/../secret' },
      { privateStagingRoot: '/private/tasks', stagingPath: '/private/tasks/a,readonly' },
      { privateStagingRoot: '/private/tasks', stagingPath: 'relative/staging' },
    ]) {
      expect(() => planAppleContainerCreate({ ...CREATE_INPUT, ...paths }))
        .toThrow('APPLE_CONTAINER_PLAN_INVALID_INPUT');
    }
  });

  test('rejects malformed task ids and nonces without reflecting private values', () => {
    for (const identity of [
      { taskId: '../escape', nonce: TASK.nonce },
      { taskId: 'short', nonce: TASK.nonce },
      { taskId: TASK.taskId, nonce: 'A1'.repeat(32) },
      { taskId: TASK.taskId, nonce: 'a1'.repeat(31) },
    ]) {
      try {
        deriveAppleContainerName(identity);
        throw new Error('expected rejection');
      } catch (error) {
        expect(String(error)).toBe('AppleContainerCommandPlanError: APPLE_CONTAINER_PLAN_INVALID_INPUT');
        expect(String(error)).not.toContain(identity.taskId);
        expect(String(error)).not.toContain(identity.nonce);
      }
    }
  });

  test('plans exact start, inspect, stop, kill and force-delete without shell or broad selectors', () => {
    const name = deriveAppleContainerName(TASK);
    expect(planAppleContainerStart(TASK).argv).toEqual(['start', name]);
    expect(planAppleContainerInspect(TASK).argv).toEqual(['inspect', name]);
    const cleanup = planAppleContainerCleanup({ ...TASK, stopTimeoutSeconds: 7 });
    expect(cleanup.map((item) => item.argv)).toEqual([
      ['stop', '--signal', 'SIGTERM', '--time', '7', name],
      ['kill', '--signal', 'KILL', name],
      ['delete', '--force', name],
    ]);
    for (const item of cleanup) {
      expect(item.executable).toBe('/usr/local/bin/container');
      expect(item.argv).not.toContain('--all');
      expect(item.argv).not.toContain('-a');
      expect(item.argv.join(' ')).not.toMatch(/(?:^|\s)(?:sh|bash|zsh)(?:\s|$)/);
    }
    expect(() => planAppleContainerCleanup({ ...TASK, stopTimeoutSeconds: 0 }))
      .toThrow('APPLE_CONTAINER_PLAN_INVALID_INPUT');
    expect(() => planAppleContainerCleanup({ ...TASK, stopTimeoutSeconds: 31 }))
      .toThrow('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  });

  test('allows --all only for the exact read-only JSON list needed for absence proof', () => {
    const list = planAppleContainerListAll();
    expect(list.argv).toEqual(['list', '--all', '--format', 'json']);
    expect(list.executable).toBe(APPLE_CONTAINER_EXECUTABLE);
    for (const mutation of [
      planAppleContainerCreate(CREATE_INPUT),
      planAppleContainerStart(TASK),
      ...planAppleContainerCleanup(TASK),
    ]) {
      expect(mutation.argv).not.toContain('--all');
      expect(mutation.argv).not.toContain('-a');
    }
  });
});

describe('Apple Container exact bounded output parser', () => {
  const id = deriveAppleContainerName(TASK);

  test('accepts only an exact id and exact nonce label as owned', () => {
    expect(parseAppleContainerListProof(appleJson(id), TASK)).toEqual({ state: 'present-owned' });
    expect(parseAppleContainerInspectProof(
      appleJson(id),
      CREATE_INPUT,
      inspectExpectation(),
    )).toEqual({ state: 'present-owned' });
    expect(parseAppleContainerInspectProof(
      appleJson(id, TASK.nonce, {}, 'stopped'),
      CREATE_INPUT,
      inspectExpectation('stopped'),
    )).toEqual({ state: 'present-owned' });
  });

  test('inspect rejects an owned label when any security-relevant configuration changed', () => {
    const mutations: Array<(entry: any) => void> = [
      entry => { entry.configuration.image.reference = `ghcr.io/evil/runtime@sha256:${'c3'.repeat(32)}`; },
      entry => { entry.configuration.image.descriptor.digest = `sha256:${'c3'.repeat(32)}`; },
      entry => { entry.configuration.image.descriptor.mediaType = 'application/octet-stream'; },
      entry => { entry.configuration.image.descriptor.size += 1; },
      entry => { entry.configuration.mounts[0].source = '/private/other'; },
      entry => { entry.configuration.mounts.push({ type: { virtiofs: {} }, source: '/tmp', destination: '/tmp', options: [] }); },
      entry => { entry.configuration.readOnly = false; },
      entry => { entry.configuration.capDrop = []; },
      entry => { entry.configuration.capAdd = ['ALL']; },
      entry => { entry.configuration.networks = [{ network: 'default' }]; },
      entry => { entry.configuration.ssh = true; },
      entry => { entry.configuration.runtimeHandler = 'attacker-runtime'; },
      entry => { entry.configuration.initProcess.executable = '/bin/sh'; },
      entry => { entry.configuration.initProcess.arguments = ['-c', 'evil']; },
      entry => { entry.configuration.initProcess.environment.push('TOKEN=secret'); },
      entry => { entry.configuration.initProcess.workingDirectory = '/'; },
      entry => { entry.configuration.initProcess.user = { id: { uid: 0, gid: 0 } }; },
      entry => { entry.configuration.initProcess.supplementalGroups = [0]; },
      entry => { entry.configuration.initProcess.rlimits = [{ limit: 'RLIMIT_NOFILE', soft: 1, hard: 1 }]; },
      entry => { entry.configuration.resources.memoryInBytes = 16 * 1024 * 1024 * 1024; },
      entry => { entry.status.state = 'stopped'; },
      entry => { entry.configuration.unexpected = true; },
      entry => { delete entry.configuration.creationDate; },
    ];
    for (const mutate of mutations) {
      const decoded = JSON.parse(appleJson(id));
      mutate(decoded[0]);
      expect(() => parseAppleContainerInspectProof(
        JSON.stringify(decoded),
        CREATE_INPUT,
        inspectExpectation(),
      ))
        .toThrow('APPLE_CONTAINER_IDENTITY_MISMATCH');
    }
  });

  test('proves absence only when neither the exact id nor nonce appears', () => {
    const unrelated = deriveAppleContainerName({
      taskId: 'task_unrelated_123',
      nonce: 'c3'.repeat(32),
    });
    expect(parseAppleContainerListProof(appleJson(unrelated, 'c3'.repeat(32)), TASK))
      .toEqual({ state: 'absent' });
    expect(parseAppleContainerListProof('[]', TASK)).toEqual({ state: 'absent' });
    expect(() => parseAppleContainerInspectProof('[]', CREATE_INPUT, inspectExpectation()))
      .toThrow('APPLE_CONTAINER_OUTPUT_INVALID');
  });

  test('fails closed on an exact-id/wrong-nonce or nonce/wrong-id split identity', () => {
    const unrelated = deriveAppleContainerName({
      taskId: 'task_unrelated_456',
      nonce: 'c3'.repeat(32),
    });
    expect(() => parseAppleContainerListProof(appleJson(id, 'c3'.repeat(32)), TASK))
      .toThrow('APPLE_CONTAINER_IDENTITY_MISMATCH');
    expect(() => parseAppleContainerListProof(appleJson(unrelated, TASK.nonce), TASK))
      .toThrow('APPLE_CONTAINER_IDENTITY_MISMATCH');
    const split = JSON.stringify([
      JSON.parse(appleJson(id, 'c3'.repeat(32)))[0],
      JSON.parse(appleJson(unrelated, TASK.nonce))[0],
    ]);
    expect(() => parseAppleContainerListProof(split, TASK))
      .toThrow('APPLE_CONTAINER_IDENTITY_MISMATCH');
  });

  test('requires Apple 1.3.1 exact top-level identity shape and consistent ids', () => {
    for (const output of [
      '{}',
      'null',
      '[null]',
      JSON.stringify([{ id }]),
      appleJson(id, TASK.nonce, { privatePath: '/secret' }),
      JSON.stringify([{ id, configuration: { id: 'different-id', labels: {} }, status: {} }]),
      JSON.stringify([{ id, configuration: { id, labels: [] }, status: {} }]),
      JSON.stringify([
        JSON.parse(appleJson(id))[0],
        JSON.parse(appleJson(id))[0],
      ]),
      'not json',
    ]) {
      expect(() => parseAppleContainerListProof(output, TASK))
        .toThrow('APPLE_CONTAINER_OUTPUT_INVALID');
    }
  });

  test('bounds bytes, list cardinality, keys, labels and inspect cardinality', () => {
    expect(() => parseAppleContainerListProof(' '.repeat(APPLE_CONTAINER_MAX_OUTPUT_BYTES + 1), TASK))
      .toThrow('APPLE_CONTAINER_OUTPUT_TOO_LARGE');
    expect(() => parseAppleContainerListProof(
      JSON.stringify(Array.from({ length: APPLE_CONTAINER_MAX_LIST_ENTRIES + 1 }, () => null)),
      TASK,
    )).toThrow('APPLE_CONTAINER_OUTPUT_INVALID');
    const manyLabels = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`label.${index}`, 'value']),
    );
    expect(() => parseAppleContainerListProof(JSON.stringify([{
      id,
      configuration: { id, labels: manyLabels },
      status: {},
    }]), TASK)).toThrow('APPLE_CONTAINER_OUTPUT_INVALID');
    const unrelated = deriveAppleContainerName({ taskId: 'task_unrelated_789', nonce: 'c3'.repeat(32) });
    expect(() => parseAppleContainerInspectProof(
      JSON.stringify([
        JSON.parse(appleJson(id))[0],
        JSON.parse(appleJson(unrelated, 'c3'.repeat(32)))[0],
      ]),
      CREATE_INPUT,
      inspectExpectation(),
    )).toThrow('APPLE_CONTAINER_OUTPUT_INVALID');
  });

  test('rejects weak, mismatched, or malformed inspect expectations', () => {
    const valid = inspectExpectation();
    const invalidExpectations = [
      { ...valid, imageDescriptor: { ...valid.imageDescriptor, digest: `sha256:${'c3'.repeat(32)}` } },
      { ...valid, imageDescriptor: { ...valid.imageDescriptor, size: 0 } },
      { ...valid, initProcess: { ...valid.initProcess, executable: 'relative' } },
      { ...valid, initProcess: { ...valid.initProcess, workingDirectory: '/' } },
      { ...valid, initProcess: { ...valid.initProcess, terminal: true } },
      { ...valid, initProcess: { ...valid.initProcess, user: { kind: 'id', uid: -1, gid: 0 } } },
      { ...valid, initProcess: { ...valid.initProcess, rlimits: [{ limit: 'NOFILE', soft: 2, hard: 1 }] } },
    ];
    for (const expectation of invalidExpectations) {
      expect(() => parseAppleContainerInspectProof(
        appleJson(id),
        CREATE_INPUT,
        expectation as AppleContainerInspectExpectation,
      )).toThrow('APPLE_CONTAINER_PLAN_INVALID_INPUT');
    }
  });
});
