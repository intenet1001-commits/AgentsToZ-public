import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  APPLE_CONTAINER_CANARY_IMAGE,
  APPLE_CONTAINER_CANARY_INDEX_MEDIA_TYPE,
  APPLE_CONTAINER_CANARY_INDEX_SIZE,
  APPLE_CONTAINER_CANARY_LINUX_ARM64_MANIFEST_DIGEST,
  APPLE_CONTAINER_LIFECYCLE_CANARY_PROOF_VERSION,
  AppleContainerLifecycleCanaryError,
  runAppleContainerLifecycleCanary,
  type AppleContainerLifecycleCanaryDependencies,
  type AppleContainerLifecycleCanaryErrorCode,
  type AppleContainerLifecycleCanaryInput,
  type AppleContainerLifecycleCanaryRunnerOptions,
} from '../src/appleContainerCanary';
import {
  APPLE_CONTAINER_EXECUTABLE,
  APPLE_CONTAINER_GUEST_STAGING_PATH,
  APPLE_CONTAINER_KERNEL_PATH,
  APPLE_CONTAINER_NONCE_LABEL,
  APPLE_CONTAINER_RUNTIME_HANDLER,
  deriveAppleContainerName,
} from '../src/appleContainerCommandPlan';
import { createAgentRuntimeContainmentCapability } from '../src/agentRuntimeContainment';
import {
  observeAgentRuntimeStagingTree,
  type AgentRuntimeStagingTreeSnapshot,
} from '../src/agentRuntimeStagingObserver';
import type { AppleContainerCommandResult } from '../src/appleContainerRuntime';

const TASK = Object.freeze({
  taskId: 'task_canary_12345678',
  nonce: 'a1'.repeat(32),
});

interface CapturedCall {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly options: AppleContainerLifecycleCanaryRunnerOptions;
}

type FakeBehavior =
  | AppleContainerCommandResult
  | Error
  | ((call: CapturedCall) => AppleContainerCommandResult | Promise<AppleContainerCommandResult>);

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function success(stdout = '', stderr = ''): AppleContainerCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
    outputTruncated: false,
  };
}

function failure(exitCode = 1, stderr = 'bounded failure'): AppleContainerCommandResult {
  return {
    exitCode,
    stdout: '',
    stderr,
    timedOut: false,
    outputTruncated: false,
  };
}

function managedContainerJson(
  id = deriveAppleContainerName(TASK),
  nonce = TASK.nonce,
  stagingPath = '/private/var/agentstoz/canary/staging',
  state: 'stopped' | 'running' = 'running',
): string {
  return JSON.stringify([{
    id,
    configuration: {
      id,
      labels: { [APPLE_CONTAINER_NONCE_LABEL]: nonce },
      image: {
        reference: APPLE_CONTAINER_CANARY_IMAGE,
        descriptor: {
          mediaType: APPLE_CONTAINER_CANARY_INDEX_MEDIA_TYPE,
          digest: APPLE_CONTAINER_CANARY_IMAGE.split('@')[1],
          size: APPLE_CONTAINER_CANARY_INDEX_SIZE,
        },
      },
      mounts: [{
        type: { virtiofs: {} },
        source: stagingPath,
        destination: APPLE_CONTAINER_GUEST_STAGING_PATH,
        options: [],
      }],
      resources: { cpus: 1, memoryInBytes: 512 * 1024 * 1024, cpuOverhead: 1 },
      platform: { os: 'linux', architecture: 'arm64' },
      initProcess: {
        executable: '/pause',
        arguments: [],
        environment: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
        workingDirectory: APPLE_CONTAINER_GUEST_STAGING_PATH,
        terminal: false,
        user: { raw: { userString: '65535:65535' } },
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
  }]);
}

class FakeCanaryHost {
  readonly calls: CapturedCall[] = [];
  readonly behaviors = new Map<string, FakeBehavior[]>();
  resourceState: 'absent' | 'stopped' | 'running' | 'wrong-nonce' | 'wrong-config' = 'absent';
  stagingPath = '/private/var/agentstoz/canary/staging';

  queue(operation: string, ...behaviors: FakeBehavior[]): void {
    this.behaviors.set(operation, [...behaviors]);
  }

  readonly run: AppleContainerLifecycleCanaryDependencies['run'] = async (
    executable,
    argv,
    options,
  ) => {
    const call = Object.freeze({
      executable,
      argv: Object.freeze([...argv]),
      options,
    });
    this.calls.push(call);
    const operation = argv[0] ?? '';
    if (operation === 'create') {
      this.resourceState = 'stopped';
      const mountIndex = argv.indexOf('--mount');
      const mount = mountIndex >= 0 ? argv[mountIndex + 1] : undefined;
      const prefix = 'type=bind,source=';
      const suffix = `,target=${APPLE_CONTAINER_GUEST_STAGING_PATH}`;
      if (mount?.startsWith(prefix) && mount.endsWith(suffix)) {
        this.stagingPath = mount.slice(prefix.length, -suffix.length);
      }
    }
    if (operation === 'start') this.resourceState = 'running';
    const queued = this.behaviors.get(operation);
    const behavior = queued?.shift();
    if (behavior instanceof Error) throw behavior;
    if (typeof behavior === 'function') return behavior(call);
    if (behavior !== undefined) return behavior;
    if (operation === 'create' || operation === 'start') {
      return success(`${deriveAppleContainerName(TASK)}\n`);
    }
    if (operation === 'inspect') {
      if (this.resourceState === 'absent') return failure(1, 'not found');
      const decoded = JSON.parse(managedContainerJson(
        deriveAppleContainerName(TASK),
        this.resourceState === 'wrong-nonce' ? 'b2'.repeat(32) : TASK.nonce,
        this.stagingPath,
        this.resourceState === 'stopped' ? 'stopped' : 'running',
      ));
      if (this.resourceState === 'wrong-config') {
        decoded[0].configuration.image.descriptor.digest = `sha256:${'c3'.repeat(32)}`;
      }
      return success(JSON.stringify(decoded));
    }
    if (operation === 'list') {
      if (this.resourceState === 'absent') return success('[]');
      return success(managedContainerJson(
        deriveAppleContainerName(TASK),
        this.resourceState === 'wrong-nonce' ? 'b2'.repeat(32) : TASK.nonce,
        this.stagingPath,
        this.resourceState === 'stopped' ? 'stopped' : 'running',
      ));
    }
    if (operation === 'delete') this.resourceState = 'absent';
    return success();
  };
}

async function canaryFixture(): Promise<{
  readonly privateRoot: string;
  readonly stagingPath: string;
  readonly input: AppleContainerLifecycleCanaryInput;
  readonly baseSnapshot: AgentRuntimeStagingTreeSnapshot;
}> {
  const created = await mkdtemp(join(tmpdir(), 'agentstoz-apple-canary-'));
  createdRoots.push(created);
  const privateRoot = await realpath(created);
  const stagingPath = join(privateRoot, 'staging');
  await mkdir(stagingPath);
  const baseSnapshot = await observeAgentRuntimeStagingTree(stagingPath);
  return {
    privateRoot,
    stagingPath,
    baseSnapshot,
    input: {
      ...TASK,
      privateStagingRoot: privateRoot,
      stagingPath,
      baseSnapshot,
    },
  };
}

function dependencies(
  host: FakeCanaryHost,
  observe: AppleContainerLifecycleCanaryDependencies['observeStagingTree'] =
    observeAgentRuntimeStagingTree,
): AppleContainerLifecycleCanaryDependencies {
  return {
    probeRuntimeDependencyCapability: async () =>
      createAgentRuntimeContainmentCapability('apple-container-vm', 'self-test-required'),
    observeStagingTree: observe,
    run: host.run,
    hostEnvironment: {
      PATH: '/malicious/path',
      LANG: 'malicious-locale',
      HOME: '/private/test-user',
      USER: 'test-user',
      LOGNAME: 'test-user',
      TMPDIR: '/private/test-tmp',
      SECRET_TOKEN: 'must-not-cross-runner-boundary',
    },
  };
}

async function expectCanaryCode(
  operation: Promise<unknown>,
  code: AppleContainerLifecycleCanaryErrorCode,
  privateValues: readonly string[] = [],
): Promise<void> {
  try {
    await operation;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppleContainerLifecycleCanaryError);
    expect((error as AppleContainerLifecycleCanaryError).code).toBe(code);
    expect(String(error)).toBe(`AppleContainerLifecycleCanaryError: ${code}`);
    for (const value of privateValues) expect(String(error)).not.toContain(value);
  }
}

describe('Apple Container harmless lifecycle canary', () => {
  test('uses the one pinned pause image, exact identity, bounded argv calls, and returns only non-ready proof', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    const proof = await runAppleContainerLifecycleCanary(fixture.input, dependencies(host));

    expect(proof).toEqual({
      version: APPLE_CONTAINER_LIFECYCLE_CANARY_PROOF_VERSION,
      kind: 'apple-container-vm',
      scope: 'lifecycle-canary-only',
      result: 'passed',
      ready: false,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.keys(proof).sort()).toEqual(['kind', 'ready', 'result', 'scope', 'version']);
    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain(fixture.privateRoot);
    expect(serialized).not.toContain(TASK.nonce);
    expect(serialized).not.toContain('/private/test-user');

    expect(APPLE_CONTAINER_CANARY_IMAGE).toBe(
      'registry.k8s.io/pause@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a',
    );
    expect(APPLE_CONTAINER_CANARY_LINUX_ARM64_MANIFEST_DIGEST).toBe(
      'sha256:e50b7059b633caf3c1449b8da680d11845cda4506b513ee7a2de00725f0a34a7',
    );
    expect(APPLE_CONTAINER_CANARY_INDEX_MEDIA_TYPE).toBe(
      'application/vnd.docker.distribution.manifest.list.v2+json',
    );
    expect(APPLE_CONTAINER_CANARY_INDEX_SIZE).toBe(2_405);

    expect(host.calls.map(call => call.argv[0])).toEqual([
      'list',
      'create',
      'inspect',
      'start',
      'inspect',
      'inspect',
      'stop',
      'kill',
      'delete',
      'list',
    ]);
    const create = host.calls[1]!;
    expect(create.executable).toBe(APPLE_CONTAINER_EXECUTABLE);
    expect(create.argv.at(-1)).toBe(APPLE_CONTAINER_CANARY_IMAGE);
    expect(create.argv).not.toContain('--detach');
    expect(create.argv).toContain('--read-only');
    expect(create.argv).toContain('--no-dns');
    expect(create.argv).toContain(APPLE_CONTAINER_KERNEL_PATH);
    expect(create.argv).toContain('none');
    expect(create.argv).toContain('512M');
    expect(create.argv).toContain(`${APPLE_CONTAINER_NONCE_LABEL}=${TASK.nonce}`);
    expect(create.argv.join(' ')).not.toMatch(/(?:^|\s)(?:sh|bash|zsh)(?:\s|$)/);
    expect(host.calls[0]?.argv).toEqual(['list', '--all', '--format', 'json']);
    expect(host.calls.at(-1)?.argv).toEqual(['list', '--all', '--format', 'json']);
    expect(host.calls.filter(call => call.argv.includes('--all'))).toHaveLength(2);

    for (const call of host.calls) {
      expect(call.options.timeoutMs).toBeGreaterThan(0);
      expect(call.options.maxOutputBytes).toBeGreaterThan(0);
      expect(Object.keys(call.options.env).sort()).toEqual([
        'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'TMPDIR', 'USER',
      ]);
      expect(call.options.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin');
      expect(call.options.env.SECRET_TOKEN).toBeUndefined();
      expect(Object.isFrozen(call.options)).toBe(true);
      expect(Object.isFrozen(call.options.env)).toBe(true);
      expect('shell' in call.options).toBe(false);
    }
  });

  test('always observes the exact staging path even when the caller provides prior evidence', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    let observations = 0;
    const observe = async (path: string) => {
      observations += 1;
      return observeAgentRuntimeStagingTree(path);
    };

    await runAppleContainerLifecycleCanary(fixture.input, dependencies(host, observe));
    expect(observations).toBe(2);

    const withoutBase = { ...fixture.input, baseSnapshot: undefined };
    await runAppleContainerLifecycleCanary(withoutBase, dependencies(new FakeCanaryHost(), observe));
    expect(observations).toBe(4);
  });

  test('rejects authentic prior evidence from a different empty root before execution', async () => {
    const fixture = await canaryFixture();
    const otherRoot = await mkdtemp(join(tmpdir(), 'agentstoz-apple-canary-other-'));
    createdRoots.push(otherRoot);
    const canonicalOtherRoot = await realpath(otherRoot);
    const otherSnapshot = await observeAgentRuntimeStagingTree(canonicalOtherRoot);
    const host = new FakeCanaryHost();
    let observations = 0;

    await expectCanaryCode(runAppleContainerLifecycleCanary({
      ...fixture.input,
      baseSnapshot: otherSnapshot,
    }, dependencies(host, async path => {
      observations += 1;
      return observeAgentRuntimeStagingTree(path);
    })), 'APPLE_CONTAINER_CANARY_STAGING_OBSERVATION_FAILED');

    expect(observations).toBe(1);
    expect(host.calls).toHaveLength(0);
  });

  test('requires the exact self-test-required dependency state before observation or execution', async () => {
    const fixture = await canaryFixture();
    for (const capability of [
      createAgentRuntimeContainmentCapability('apple-container-vm', 'ready'),
      createAgentRuntimeContainmentCapability('apple-container-vm', 'service-unhealthy'),
      createAgentRuntimeContainmentCapability(null, 'platform-unsupported'),
      { schemaVersion: 2, kind: 'apple-container-vm', ready: false, reason: 'self-test-required' },
    ]) {
      const host = new FakeCanaryHost();
      let observations = 0;
      await expectCanaryCode(runAppleContainerLifecycleCanary(fixture.input, {
        ...dependencies(host, async path => {
          observations += 1;
          return observeAgentRuntimeStagingTree(path);
        }),
        probeRuntimeDependencyCapability: async () => capability as never,
      }), 'APPLE_CONTAINER_CANARY_DEPENDENCY_NOT_QUALIFIED');
      expect(host.calls).toHaveLength(0);
      expect(observations).toBe(0);
    }

    const privateFailure = '/private/host/dependency/detail';
    await expectCanaryCode(runAppleContainerLifecycleCanary(fixture.input, {
      ...dependencies(new FakeCanaryHost()),
      probeRuntimeDependencyCapability: async () => {
        throw new Error(privateFailure);
      },
    }), 'APPLE_CONTAINER_CANARY_DEPENDENCY_NOT_QUALIFIED', [privateFailure]);
  });

  test('requires an authentically empty baseline, not merely an unchanged nonempty tree', async () => {
    const fixture = await canaryFixture();
    await writeFile(join(fixture.stagingPath, 'preexisting.txt'), 'unchanged is still forbidden');
    const nonemptyBaseline = await observeAgentRuntimeStagingTree(fixture.stagingPath);
    const host = new FakeCanaryHost();

    await expectCanaryCode(runAppleContainerLifecycleCanary({
      ...fixture.input,
      baseSnapshot: nonemptyBaseline,
    }, dependencies(host)), 'APPLE_CONTAINER_CANARY_STAGING_NOT_EMPTY');
    expect(host.calls).toHaveLength(0);

    const forgedEmpty = {
      version: 'agentstoz-staging-observer-v1',
      entryCount: 0,
      totalFileBytes: 0,
      toJSON(): never {
        throw new Error('forged');
      },
    } as AgentRuntimeStagingTreeSnapshot;
    await expectCanaryCode(runAppleContainerLifecycleCanary({
      ...fixture.input,
      baseSnapshot: forgedEmpty,
    }, dependencies(host)), 'APPLE_CONTAINER_CANARY_STAGING_OBSERVATION_FAILED');
    expect(host.calls).toHaveLength(0);
  });

  test('never adopts or deletes a pre-existing exact name with either state or wrong nonce', async () => {
    const fixture = await canaryFixture();
    for (const state of ['stopped', 'running', 'wrong-nonce'] as const) {
      const host = new FakeCanaryHost();
      host.resourceState = state;
      await expectCanaryCode(
        runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
        'APPLE_CONTAINER_CANARY_PREFLIGHT_NOT_CLEAR',
      );
      expect(host.calls.map(call => call.argv[0])).toEqual(['list']);
      expect(host.resourceState).toBe(state);
    }
  });

  test('rejects any create identity ambiguity but still cleans, proves absence, and observes staging', async () => {
    const fixture = await canaryFixture();
    for (const output of [
      `${deriveAppleContainerName(TASK)} extra\n`,
      ` ${deriveAppleContainerName(TASK)}\n`,
      `${deriveAppleContainerName(TASK)}\nsecond-line\n`,
      `${deriveAppleContainerName({ ...TASK, nonce: 'b2'.repeat(32) })}\n`,
    ]) {
      const host = new FakeCanaryHost();
      host.queue('create', success(output));
      let observations = 0;
      await expectCanaryCode(runAppleContainerLifecycleCanary(fixture.input, dependencies(
        host,
        async path => {
          observations += 1;
          return observeAgentRuntimeStagingTree(path);
        },
      )), 'APPLE_CONTAINER_CANARY_CREATE_IDENTITY_UNVERIFIED');
      expect(host.calls.map(call => call.argv[0])).toEqual([
        'list', 'create', 'inspect', 'stop', 'kill', 'delete', 'list',
      ]);
      expect(observations).toBe(2);
    }
  });

  test('does not start or delete when the stopped full configuration remains unproven', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    host.queue('create', () => {
      host.resourceState = 'wrong-config';
      return success(`${deriveAppleContainerName(TASK)}\n`);
    });

    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
      'APPLE_CONTAINER_CANARY_OWNERSHIP_UNPROVEN',
    );
    expect(host.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'inspect', 'list',
    ]);
    expect(host.resourceState).toBe('wrong-config');
    expect(host.calls.some(call => call.argv[0] === 'start')).toBe(false);
  });

  test('a timed-out create with exact stopped evidence is cleaned but can never pass', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    host.queue('create', {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      outputTruncated: false,
    });

    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
      'APPLE_CONTAINER_CANARY_CREATE_FAILED',
    );
    expect(host.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'stop', 'kill', 'delete', 'list',
    ]);
    expect(host.resourceState).toBe('absent');
  });

  test('a timed-out create with unproven full configuration never performs destructive cleanup', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    host.queue('create', () => {
      host.resourceState = 'wrong-nonce';
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
        outputTruncated: false,
      };
    });

    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
      'APPLE_CONTAINER_CANARY_OWNERSHIP_UNPROVEN',
    );
    expect(host.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'list',
    ]);
    expect(host.resourceState).toBe('wrong-nonce');
  });

  test('requires exact start identity and a second full running inspection', async () => {
    const fixture = await canaryFixture();
    const invalidStartOutput = new FakeCanaryHost();
    invalidStartOutput.queue('start', success('wrong-id\n'));
    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(invalidStartOutput)),
      'APPLE_CONTAINER_CANARY_START_IDENTITY_UNVERIFIED',
    );
    expect(invalidStartOutput.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'start', 'inspect', 'stop', 'kill', 'delete', 'list',
    ]);

    const wrongRunningConfig = new FakeCanaryHost();
    wrongRunningConfig.queue(
      'inspect',
      success(managedContainerJson(
        deriveAppleContainerName(TASK),
        TASK.nonce,
        fixture.stagingPath,
        'stopped',
      )),
      (() => {
        const decoded = JSON.parse(managedContainerJson(
          deriveAppleContainerName(TASK),
          TASK.nonce,
          fixture.stagingPath,
          'running',
        ));
        decoded[0].configuration.initProcess.executable = '/bin/sh';
        return success(JSON.stringify(decoded));
      })(),
    );
    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(wrongRunningConfig)),
      'APPLE_CONTAINER_CANARY_RUNNING_CONFIGURATION_UNVERIFIED',
    );
    expect(wrongRunningConfig.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'start', 'inspect', 'inspect',
      'stop', 'kill', 'delete', 'list',
    ]);
  });

  test('a timed-out start with exact running evidence is cleaned but can never pass', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    host.queue('start', {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      outputTruncated: false,
    });
    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
      'APPLE_CONTAINER_CANARY_START_FAILED',
    );
    expect(host.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'start', 'inspect',
      'stop', 'kill', 'delete', 'list',
    ]);
  });

  test('attempts stop, kill, force-delete, and list even after cleanup transport failures', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    host.queue('stop', new Error('/private/stop/detail'));
    host.queue('kill', {
      exitCode: null,
      stdout: '',
      stderr: 'private timeout detail',
      timedOut: true,
      outputTruncated: false,
    });

    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
      'APPLE_CONTAINER_CANARY_CLEANUP_UNCERTAIN',
      ['/private/stop/detail'],
    );
    expect(host.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'start', 'inspect', 'inspect',
      'stop', 'kill', 'delete', 'list',
    ]);
  });

  test('accepts ordinary bounded nonzero cleanup statuses only when exact list proves absence', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    host.queue('stop', failure(1, 'already stopped'));
    host.queue('kill', failure(1, 'not running'));
    host.queue('delete', () => {
      host.resourceState = 'absent';
      return failure(1, 'already absent');
    });

    await expect(runAppleContainerLifecycleCanary(fixture.input, dependencies(host)))
      .resolves.toMatchObject({ result: 'passed', ready: false });
    expect(host.calls.map(call => call.argv[0])).toEqual([
      'list', 'create', 'inspect', 'start', 'inspect', 'inspect',
      'stop', 'kill', 'delete', 'list',
    ]);
  });

  test('fails closed when all-resource absence is invalid, mismatched, or still present', async () => {
    const fixture = await canaryFixture();
    for (const listBehavior of [
      success(managedContainerJson()),
      success('{not-json'),
      success(managedContainerJson(
        deriveAppleContainerName(TASK),
        'b2'.repeat(32),
      )),
      new Error('/private/list/detail'),
    ]) {
      const host = new FakeCanaryHost();
      host.queue('list', success('[]'), listBehavior);
      await expectCanaryCode(
        runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
        'APPLE_CONTAINER_CANARY_ABSENCE_UNPROVEN',
        ['/private/list/detail'],
      );
      const operations = host.calls.map(call => call.argv[0]);
      expect(operations.slice(0, 9)).toEqual([
        'list', 'create', 'inspect', 'start', 'inspect', 'inspect',
        'stop', 'kill', 'delete',
      ]);
      expect(operations.at(-1)).toBe('list');
    }
  });

  test('requires an unchanged staging tree after exact absence proof', async () => {
    const fixture = await canaryFixture();
    const host = new FakeCanaryHost();
    host.queue('start', async () => {
      await writeFile(join(fixture.stagingPath, 'unexpected.txt'), 'canary must not write');
      return success(`${deriveAppleContainerName(TASK)}\n`);
    });

    await expectCanaryCode(
      runAppleContainerLifecycleCanary(fixture.input, dependencies(host)),
      'APPLE_CONTAINER_CANARY_STAGING_NOT_EMPTY',
      [fixture.stagingPath],
    );
  });

  test('maps invalid private inputs and observer failures to stable non-reflective codes', async () => {
    const fixture = await canaryFixture();
    const invalidPath = join(dirname(fixture.privateRoot), 'outside-staging');
    await expectCanaryCode(runAppleContainerLifecycleCanary({
      ...fixture.input,
      stagingPath: invalidPath,
    }, dependencies(new FakeCanaryHost())), 'APPLE_CONTAINER_CANARY_INVALID_INPUT', [invalidPath]);

    const privateObserverDetail = `/private/observer/${crypto.randomUUID()}`;
    await expectCanaryCode(runAppleContainerLifecycleCanary({
      ...fixture.input,
      baseSnapshot: undefined,
    }, dependencies(new FakeCanaryHost(), async () => {
      throw new Error(privateObserverDetail);
    })), 'APPLE_CONTAINER_CANARY_STAGING_OBSERVATION_FAILED', [privateObserverDetail]);
  });
});
