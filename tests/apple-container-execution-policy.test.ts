import { describe, expect, test } from 'bun:test';

import {
  APPLE_CONTAINER_EXECUTION_POLICY_VERSION,
  AppleContainerExecutionPolicyError,
  digestAppleContainerExecutionPolicy,
  type AppleContainerExecutionPolicyDigestInput,
} from '../src/appleContainerExecutionPolicy';
import {
  APPLE_CONTAINER_GUEST_STAGING_PATH,
  type AppleContainerInspectExpectation,
} from '../src/appleContainerCommandPlan';

const IMAGE_DIGEST = `sha256:${'b2'.repeat(32)}`;
const CREATE_INPUT = Object.freeze({
  taskId: 'task_12345678-1234-1234-1234-123456789abc',
  nonce: 'a1'.repeat(32),
  privateStagingRoot: '/private/var/agentstoz/tasks',
  stagingPath: '/private/var/agentstoz/tasks/task-one/staging',
  image: `ghcr.io/agentstoz/codex-runtime@${IMAGE_DIGEST}`,
  cpuCount: 2,
  memoryMiB: 4_096,
  networkPolicy: 'none' as const,
});

function expectation(
  state: 'stopped' | 'running' = 'stopped',
): Readonly<AppleContainerInspectExpectation> {
  return Object.freeze({
    state,
    imageDescriptor: Object.freeze({
      mediaType: 'application/vnd.oci.image.index.v1+json',
      digest: IMAGE_DIGEST,
      size: 12_345,
    }),
    initProcess: Object.freeze({
      executable: '/usr/local/bin/agentstoz-runtime',
      arguments: Object.freeze(['serve', '--protocol', 'v1']),
      environment: Object.freeze(['PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8']),
      workingDirectory: APPLE_CONTAINER_GUEST_STAGING_PATH,
      terminal: false,
      user: Object.freeze({ kind: 'id' as const, uid: 65_532, gid: 65_532 }),
      supplementalGroups: Object.freeze([]),
      rlimits: Object.freeze([
        Object.freeze({ limit: 'RLIMIT_NOFILE', soft: 1_024, hard: 1_024 }),
      ]),
    }),
  });
}

function input(): AppleContainerExecutionPolicyDigestInput {
  return {
    createInput: CREATE_INPUT,
    inspectExpectation: expectation(),
    kernelSha256: 'c3'.repeat(32),
    brokerTcbDigest: 'd4'.repeat(32),
  };
}

function digest(value: AppleContainerExecutionPolicyDigestInput): string {
  return digestAppleContainerExecutionPolicy(value).executionPolicyDigest;
}

describe('Apple Container canonical execution policy digest', () => {
  test('returns only frozen opaque digests and is deterministic', () => {
    const first = digestAppleContainerExecutionPolicy(input());
    const second = digestAppleContainerExecutionPolicy(input());
    expect(APPLE_CONTAINER_EXECUTION_POLICY_VERSION)
      .toBe('agentstoz-apple-container-execution-policy-v1');
    expect(first).toEqual(second);
    expect(first.executionPolicyDigest)
      .toBe('9f3af6bdba1ce7b97b56ae2d068a31e472084b0991367fb73082f4878249654a');
    expect(first.kernelSha256).toBe('c3'.repeat(32));
    expect(first.brokerTcbDigest).toBe('d4'.repeat(32));
    expect(Object.keys(first).sort()).toEqual([
      'brokerTcbDigest',
      'executionPolicyDigest',
      'kernelSha256',
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(CREATE_INPUT.taskId);
    expect(JSON.stringify(first)).not.toContain(CREATE_INPUT.stagingPath);
    expect(JSON.stringify(first)).not.toContain(CREATE_INPUT.nonce);
  });

  test('uses one state-independent policy for stopped and running proofs', () => {
    const stopped = input();
    const running = { ...input(), inspectExpectation: expectation('running') };
    expect(digest(stopped)).toBe(digest(running));
  });

  test('binds command identity, resources, image qualification, process and TCB', () => {
    const baseline = input();
    const expected = digest(baseline);
    const variants: AppleContainerExecutionPolicyDigestInput[] = [
      { ...baseline, createInput: { ...CREATE_INPUT, taskId: 'task_different_123' } },
      { ...baseline, createInput: { ...CREATE_INPUT, nonce: 'e5'.repeat(32) } },
      { ...baseline, createInput: {
        ...CREATE_INPUT,
        stagingPath: '/private/var/agentstoz/tasks/task-two/staging',
      } },
      { ...baseline, createInput: { ...CREATE_INPUT, cpuCount: 3 } },
      { ...baseline, createInput: { ...CREATE_INPUT, memoryMiB: 4_097 } },
      { ...baseline, inspectExpectation: {
        ...expectation(),
        imageDescriptor: { ...expectation().imageDescriptor, size: 12_346 },
      } },
      { ...baseline, inspectExpectation: {
        ...expectation(),
        initProcess: { ...expectation().initProcess, arguments: ['serve'] },
      } },
      { ...baseline, inspectExpectation: {
        ...expectation(),
        initProcess: {
          ...expectation().initProcess,
          user: { kind: 'id', uid: 65_531, gid: 65_532 },
        },
      } },
      { ...baseline, kernelSha256: 'f6'.repeat(32) },
      { ...baseline, brokerTcbDigest: '07'.repeat(32) },
    ];
    for (const variant of variants) expect(digest(variant)).not.toBe(expected);
  });

  test('copies caller-owned arrays before hashing', () => {
    const mutableArguments = ['serve'];
    const mutableExpectation = {
      ...expectation(),
      initProcess: {
        ...expectation().initProcess,
        arguments: mutableArguments,
      },
    };
    const before = digest({ ...input(), inspectExpectation: mutableExpectation });
    mutableArguments.push('--changed-after-call');
    const unchanged = digest({
      ...input(),
      inspectExpectation: {
        ...mutableExpectation,
        initProcess: { ...mutableExpectation.initProcess, arguments: ['serve'] },
      },
    });
    expect(before).toBe(unchanged);
  });

  test('fails closed without reflecting malformed private input', () => {
    for (const invalid of [
      { ...input(), kernelSha256: 'C3'.repeat(32) },
      { ...input(), brokerTcbDigest: 'short' },
      { ...input(), ignoredPolicyOverride: true },
      { ...input(), createInput: { ...CREATE_INPUT, mounts: ['/host-secret'] } },
      { ...input(), createInput: { ...CREATE_INPUT, stagingPath: '/tmp/host-secret\npath' } },
      { ...input(), inspectExpectation: { ...expectation(), state: 'future' } },
      { ...input(), inspectExpectation: { ...expectation(), ignoredCapability: 'NET_ADMIN' } },
      { ...input(), inspectExpectation: {
        ...expectation(),
        initProcess: { ...expectation().initProcess, ignoredEnvironment: 'TOKEN=secret' },
      } },
      { ...input(), inspectExpectation: {
        ...expectation(),
        initProcess: {
          ...expectation().initProcess,
          rlimits: [{
            ...expectation().initProcess.rlimits[0]!,
            ignoredLimit: 99,
          }],
        },
      } },
      { ...input(), inspectExpectation: {
        ...expectation(),
        imageDescriptor: { ...expectation().imageDescriptor, digest: `sha256:${'99'.repeat(32)}` },
      } },
    ]) {
      try {
        digest(invalid as AppleContainerExecutionPolicyDigestInput);
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(AppleContainerExecutionPolicyError);
        expect((error as Error).message).toBe('APPLE_CONTAINER_EXECUTION_POLICY_INVALID');
        expect((error as Error).message).not.toContain('host-secret');
      }
    }
  });
});
