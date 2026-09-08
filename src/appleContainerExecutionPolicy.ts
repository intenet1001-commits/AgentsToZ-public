import { createHash } from 'node:crypto';

import {
  normalizeAppleContainerInspectExpectation,
  planAppleContainerCreate,
  type AppleContainerCreatePlanInput,
  type AppleContainerInspectExpectation,
} from './appleContainerCommandPlan';

/**
 * Canonical policy format stored indirectly through its SHA-256 digest.
 * Changing any field or its meaning requires a new version and fresh records.
 */
export const APPLE_CONTAINER_EXECUTION_POLICY_VERSION =
  'agentstoz-apple-container-execution-policy-v1' as const;

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface AppleContainerExecutionPolicyDigestInput {
  /** Exact trusted create input, including private task identity and staging path. */
  readonly createInput: AppleContainerCreatePlanInput;
  /**
   * Qualified OCI image configuration. Runtime state is intentionally excluded:
   * the same immutable policy governs both the stopped and running proofs.
   */
  readonly inspectExpectation: AppleContainerInspectExpectation;
  /** SHA-256 of the exact broker-owned extracted kernel file. */
  readonly kernelSha256: string;
  /** SHA-256 of the complete independently qualified broker/runtime TCB record. */
  readonly brokerTcbDigest: string;
}

export interface AppleContainerExecutionPolicyDigests {
  readonly executionPolicyDigest: string;
  readonly kernelSha256: string;
  readonly brokerTcbDigest: string;
}

export class AppleContainerExecutionPolicyError extends Error {
  readonly code = 'APPLE_CONTAINER_EXECUTION_POLICY_INVALID' as const;

  constructor() {
    // Never reflect a task id, nonce, host path, image, or TCB value.
    super('APPLE_CONTAINER_EXECUTION_POLICY_INVALID');
    this.name = 'AppleContainerExecutionPolicyError';
  }
}

function fail(): never {
  throw new AppleContainerExecutionPolicyError();
}

function exactSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function hasExactExpectationShape(expectation: AppleContainerInspectExpectation): boolean {
  if (expectation === null
    || typeof expectation !== 'object'
    || !hasExactKeys(expectation, ['state', 'imageDescriptor', 'initProcess'])
    || expectation.imageDescriptor === null
    || typeof expectation.imageDescriptor !== 'object'
    || !hasExactKeys(expectation.imageDescriptor, ['mediaType', 'digest', 'size'])
    || expectation.initProcess === null
    || typeof expectation.initProcess !== 'object'
    || !hasExactKeys(expectation.initProcess, [
      'executable',
      'arguments',
      'environment',
      'workingDirectory',
      'terminal',
      'user',
      'supplementalGroups',
      'rlimits',
    ])
    || expectation.initProcess.user === null
    || typeof expectation.initProcess.user !== 'object'
    || (expectation.initProcess.user.kind === 'raw'
      ? !hasExactKeys(expectation.initProcess.user, ['kind', 'userString'])
      : !hasExactKeys(expectation.initProcess.user, ['kind', 'uid', 'gid']))
    || !Array.isArray(expectation.initProcess.rlimits)
    || expectation.initProcess.rlimits.some(value => value === null
      || typeof value !== 'object'
      || !hasExactKeys(value, ['limit', 'soft', 'hard']))) {
    return false;
  }
  return true;
}

function canonicalQualification(
  createInput: AppleContainerCreatePlanInput,
  expectation: AppleContainerInspectExpectation,
): Readonly<Omit<AppleContainerInspectExpectation, 'state'>> {
  if (!hasExactExpectationShape(expectation)) fail();
  // State is validated lifecycle evidence but not execution policy, so stopped
  // and running views of the same exact configuration hash equally.
  const normalized = normalizeAppleContainerInspectExpectation(createInput, expectation);
  return Object.freeze({
    imageDescriptor: normalized.imageDescriptor,
    initProcess: normalized.initProcess,
  });
}

/**
 * Produces only opaque private digests. The canonical policy itself contains
 * host-private values and must never be serialized into a public task DTO.
 */
export function digestAppleContainerExecutionPolicy(
  input: AppleContainerExecutionPolicyDigestInput,
): Readonly<AppleContainerExecutionPolicyDigests> {
  if (input === null
    || typeof input !== 'object'
    || !hasExactKeys(input, [
      'createInput',
      'inspectExpectation',
      'kernelSha256',
      'brokerTcbDigest',
    ])
    || input.createInput === null
    || typeof input.createInput !== 'object'
    || !hasOnlyKeys(input.createInput, [
      'taskId',
      'nonce',
      'privateStagingRoot',
      'stagingPath',
      'image',
      'cpuCount',
      'memoryMiB',
      'networkPolicy',
    ])
    || !exactSha256(input.kernelSha256)
    || !exactSha256(input.brokerTcbDigest)) {
    return fail();
  }

  try {
    const createPlan = planAppleContainerCreate(input.createInput);
    const qualification = canonicalQualification(
      input.createInput,
      input.inspectExpectation,
    );
    // Construct every object and key in a fixed order. No caller-supplied
    // object is stringified directly, so insertion order cannot alter policy.
    const canonicalPolicy = {
      version: APPLE_CONTAINER_EXECUTION_POLICY_VERSION,
      create: {
        executable: createPlan.executable,
        argv: [...createPlan.argv],
      },
      imageQualification: {
        descriptor: {
          mediaType: qualification.imageDescriptor.mediaType,
          digest: qualification.imageDescriptor.digest,
          size: qualification.imageDescriptor.size,
        },
        process: {
          executable: qualification.initProcess.executable,
          arguments: [...qualification.initProcess.arguments],
          environment: [...qualification.initProcess.environment],
          workingDirectory: qualification.initProcess.workingDirectory,
          terminal: qualification.initProcess.terminal,
          user: qualification.initProcess.user.kind === 'raw'
            ? {
              kind: 'raw' as const,
              userString: qualification.initProcess.user.userString,
            }
            : {
              kind: 'id' as const,
              uid: qualification.initProcess.user.uid,
              gid: qualification.initProcess.user.gid,
            },
          supplementalGroups: [...qualification.initProcess.supplementalGroups],
          rlimits: qualification.initProcess.rlimits.map((value) => ({
            limit: value.limit,
            soft: value.soft,
            hard: value.hard,
          })),
        },
      },
      kernelSha256: input.kernelSha256,
      brokerTcbDigest: input.brokerTcbDigest,
    };
    const executionPolicyDigest = createHash('sha256')
      .update(`${APPLE_CONTAINER_EXECUTION_POLICY_VERSION}\0`, 'utf8')
      .update(JSON.stringify(canonicalPolicy), 'utf8')
      .digest('hex');
    return Object.freeze({
      executionPolicyDigest,
      kernelSha256: input.kernelSha256,
      brokerTcbDigest: input.brokerTcbDigest,
    });
  } catch (error) {
    if (error instanceof AppleContainerExecutionPolicyError) throw error;
    return fail();
  }
}
