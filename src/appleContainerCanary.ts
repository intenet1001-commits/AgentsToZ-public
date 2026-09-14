import { Buffer } from 'node:buffer';

import {
  APPLE_CONTAINER_EXECUTABLE,
  deriveAppleContainerName,
  parseAppleContainerInspectProof,
  parseAppleContainerListProof,
  planAppleContainerCleanup,
  planAppleContainerCreate,
  planAppleContainerInspect,
  planAppleContainerListAll,
  planAppleContainerStart,
  type AppleContainerCommandPlan,
  type AppleContainerCreatePlanInput,
  type AppleContainerInspectExpectation,
} from './appleContainerCommandPlan';
import {
  normalizeAgentRuntimeContainmentCapability,
  type AgentRuntimeContainmentCapability,
} from './agentRuntimeContainment';
import {
  buildAgentRuntimeStagingResult,
  type AgentRuntimeStagingTreeSnapshot,
} from './agentRuntimeStagingObserver';
import type {
  AppleContainerCommandResult,
  AppleContainerRuntimeProbeDependencies,
  AppleContainerRuntimeProbeOptions,
  probeAppleContainerRuntimeDependencyCapability,
} from './appleContainerRuntime';

/**
 * Immutable multi-platform index used only by the first harmless lifecycle
 * canary. The planner selects linux/arm64; that child manifest is separately
 * pinned here so a future image qualification record can verify both levels.
 */
export const APPLE_CONTAINER_CANARY_IMAGE =
  'registry.k8s.io/pause@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a' as const;
export const APPLE_CONTAINER_CANARY_LINUX_ARM64_MANIFEST_DIGEST =
  'sha256:e50b7059b633caf3c1449b8da680d11845cda4506b513ee7a2de00725f0a34a7' as const;
export const APPLE_CONTAINER_CANARY_INDEX_MEDIA_TYPE =
  'application/vnd.docker.distribution.manifest.list.v2+json' as const;
export const APPLE_CONTAINER_CANARY_INDEX_SIZE = 2_405 as const;
export const APPLE_CONTAINER_LIFECYCLE_CANARY_PROOF_VERSION =
  'agentstoz-apple-container-lifecycle-canary-v1' as const;

const CANARY_CPU_COUNT = 1;
const CANARY_MEMORY_MIB = 512;
const MAX_ENVIRONMENT_VALUE_BYTES = 4 * 1024;
const OPTIONAL_HOST_ENVIRONMENT_KEYS = Object.freeze([
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
] as const);

export interface AppleContainerLifecycleCanaryInput {
  /** Existing bounded Agent Runtime task id. */
  readonly taskId: string;
  /** Fresh host-private 32-byte lowercase-hex nonce. */
  readonly nonce: string;
  /** Trusted app-data root; it is never mounted itself. */
  readonly privateStagingRoot: string;
  /** One disposable, task-private staging directory. */
  readonly stagingPath: string;
  /**
   * Optional prior evidence for stale/cross-root detection only. The canary
   * always observes `stagingPath` again immediately before creating a VM.
   */
  readonly baseSnapshot?: AgentRuntimeStagingTreeSnapshot;
}

export interface AppleContainerLifecycleCanaryRunnerOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Trusted adapter contract. Implementations must use an argv API such as
 * execFile/spawn with shell:false and must enforce the supplied output and
 * timeout ceilings. No default command runner exists: importing or calling
 * this module without explicit dependencies cannot execute Apple Container.
 */
export interface AppleContainerLifecycleCanaryDependencies {
  readonly probeRuntimeDependencyCapability: typeof probeAppleContainerRuntimeDependencyCapability;
  readonly runtimeProbeOptions?: AppleContainerRuntimeProbeOptions;
  readonly runtimeProbeDependencies?: AppleContainerRuntimeProbeDependencies;
  readonly observeStagingTree: (
    canonicalStagingPath: string,
  ) => Promise<AgentRuntimeStagingTreeSnapshot>;
  readonly run: (
    executable: typeof APPLE_CONTAINER_EXECUTABLE,
    argv: readonly string[],
    options: AppleContainerLifecycleCanaryRunnerOptions,
  ) => Promise<AppleContainerCommandResult>;
  /** Only the explicitly enumerated keys are copied into a command environment. */
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
}

/**
 * This is deliberately not a containment capability and can never make the
 * Agent Runtime `ready`. It proves only one bounded lifecycle canary run.
 */
export interface AppleContainerLifecycleCanaryProof {
  readonly version: typeof APPLE_CONTAINER_LIFECYCLE_CANARY_PROOF_VERSION;
  readonly kind: 'apple-container-vm';
  readonly scope: 'lifecycle-canary-only';
  readonly result: 'passed';
  readonly ready: false;
}

export type AppleContainerLifecycleCanaryErrorCode =
  | 'APPLE_CONTAINER_CANARY_INVALID_INPUT'
  | 'APPLE_CONTAINER_CANARY_DEPENDENCY_NOT_QUALIFIED'
  | 'APPLE_CONTAINER_CANARY_STAGING_OBSERVATION_FAILED'
  | 'APPLE_CONTAINER_CANARY_PREFLIGHT_NOT_CLEAR'
  | 'APPLE_CONTAINER_CANARY_CREATE_FAILED'
  | 'APPLE_CONTAINER_CANARY_CREATE_IDENTITY_UNVERIFIED'
  | 'APPLE_CONTAINER_CANARY_STOPPED_CONFIGURATION_UNVERIFIED'
  | 'APPLE_CONTAINER_CANARY_START_FAILED'
  | 'APPLE_CONTAINER_CANARY_START_IDENTITY_UNVERIFIED'
  | 'APPLE_CONTAINER_CANARY_RUNNING_CONFIGURATION_UNVERIFIED'
  | 'APPLE_CONTAINER_CANARY_OWNERSHIP_UNPROVEN'
  | 'APPLE_CONTAINER_CANARY_CLEANUP_UNCERTAIN'
  | 'APPLE_CONTAINER_CANARY_ABSENCE_UNPROVEN'
  | 'APPLE_CONTAINER_CANARY_STAGING_NOT_EMPTY';

export class AppleContainerLifecycleCanaryError extends Error {
  constructor(readonly code: AppleContainerLifecycleCanaryErrorCode) {
    // Never reflect command output, host paths, environment values, or a cause.
    super(code);
    this.name = 'AppleContainerLifecycleCanaryError';
  }
}

interface PostRunReconciliation {
  readonly inspectState: 'stopped' | 'running' | null;
  readonly ownershipState: 'owned' | 'absent' | 'unproven';
  readonly commandProtocolCertain: boolean;
  readonly absenceProven: boolean;
}

function fail(code: AppleContainerLifecycleCanaryErrorCode): never {
  throw new AppleContainerLifecycleCanaryError(code);
}

function boundedEnvironmentValue(value: string): boolean {
  return value.length > 0
    && !value.includes('\0')
    && !/[\r\n]/.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_ENVIRONMENT_VALUE_BYTES;
}

function commandEnvironment(
  hostEnvironment: AppleContainerLifecycleCanaryDependencies['hostEnvironment'],
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
    LANG: 'C',
    LC_ALL: 'C',
  };
  for (const key of OPTIONAL_HOST_ENVIRONMENT_KEYS) {
    const value = hostEnvironment?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !boundedEnvironmentValue(value)) {
      return fail('APPLE_CONTAINER_CANARY_INVALID_INPUT');
    }
    env[key] = value;
  }
  return Object.freeze(env);
}

function isCommandResultShape(
  value: unknown,
  maxOutputBytes: number,
): value is AppleContainerCommandResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<AppleContainerCommandResult>;
  return (result.exitCode === null
      || (typeof result.exitCode === 'number'
        && Number.isSafeInteger(result.exitCode)
        && result.exitCode >= 0
        && result.exitCode <= 255))
    && typeof result.stdout === 'string'
    && typeof result.stderr === 'string'
    && typeof result.timedOut === 'boolean'
    && typeof result.outputTruncated === 'boolean'
    && Buffer.byteLength(result.stdout, 'utf8') <= maxOutputBytes
    && Buffer.byteLength(result.stderr, 'utf8') <= maxOutputBytes;
}

async function invoke(
  plan: Readonly<AppleContainerCommandPlan>,
  environment: Readonly<Record<string, string>>,
  dependencies: AppleContainerLifecycleCanaryDependencies,
): Promise<AppleContainerCommandResult> {
  return dependencies.run(plan.executable, plan.argv, Object.freeze({
    timeoutMs: plan.timeoutMs,
    maxOutputBytes: plan.maxOutputBytes,
    env: environment,
  }));
}

function commandSucceeded(
  result: unknown,
  plan: Readonly<AppleContainerCommandPlan>,
): result is AppleContainerCommandResult {
  return isCommandResultShape(result, plan.maxOutputBytes)
    && result.exitCode === 0
    && !result.timedOut
    && !result.outputTruncated
    && result.stderr.length === 0;
}

function commandProtocolCertain(
  result: unknown,
  plan: Readonly<AppleContainerCommandPlan>,
): boolean {
  return isCommandResultShape(result, plan.maxOutputBytes)
    && !result.timedOut
    && !result.outputTruncated
    && result.exitCode !== null;
}

function exactIdentityOutput(stdout: string, expectedId: string): boolean {
  // Swift `print` supplies one LF. The no-LF form is accepted for an adapter
  // that strips only that terminator; all other whitespace/text is rejected.
  return stdout === expectedId || stdout === `${expectedId}\n`;
}

function canaryInspectExpectation(
  state: AppleContainerInspectExpectation['state'],
): Readonly<AppleContainerInspectExpectation> {
  return Object.freeze({
    state,
    imageDescriptor: Object.freeze({
      mediaType: APPLE_CONTAINER_CANARY_INDEX_MEDIA_TYPE,
      digest: APPLE_CONTAINER_CANARY_IMAGE.split('@')[1]!,
      size: APPLE_CONTAINER_CANARY_INDEX_SIZE,
    }),
    initProcess: Object.freeze({
      executable: '/pause',
      arguments: Object.freeze([]),
      environment: Object.freeze([
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ]),
      workingDirectory: '/agentstoz/workspace',
      terminal: false,
      user: Object.freeze({ kind: 'raw' as const, userString: '65535:65535' }),
      supplementalGroups: Object.freeze([]),
      rlimits: Object.freeze([]),
    }),
  });
}

function dependencyIsQualified(value: unknown): boolean {
  let capability: Readonly<AgentRuntimeContainmentCapability>;
  try {
    capability = normalizeAgentRuntimeContainmentCapability(value);
  } catch {
    return false;
  }
  return capability.kind === 'apple-container-vm'
    && capability.ready === false
    && capability.reason === 'self-test-required';
}

async function exactListState(
  plan: Readonly<AppleContainerCommandPlan>,
  input: AppleContainerLifecycleCanaryInput,
  environment: Readonly<Record<string, string>>,
  dependencies: AppleContainerLifecycleCanaryDependencies,
): Promise<'owned' | 'absent' | 'unproven'> {
  try {
    const result = await invoke(plan, environment, dependencies);
    if (!commandSucceeded(result, plan)) return 'unproven';
    return parseAppleContainerListProof(result.stdout, input).state === 'present-owned'
      ? 'owned'
      : 'absent';
  } catch {
    return 'unproven';
  }
}

async function exactInspectState(
  input: AppleContainerCreatePlanInput,
  inspectPlan: Readonly<AppleContainerCommandPlan>,
  environment: Readonly<Record<string, string>>,
  dependencies: AppleContainerLifecycleCanaryDependencies,
): Promise<'stopped' | 'running' | null> {
  try {
    const result = await invoke(inspectPlan, environment, dependencies);
    if (!commandSucceeded(result, inspectPlan)) return null;
    for (const state of ['running', 'stopped'] as const) {
      try {
        parseAppleContainerInspectProof(result.stdout, input, canaryInspectExpectation(state));
        return state;
      } catch {
        // One bounded output is checked against both exact expected states.
      }
    }
  } catch {
    // Stable null keeps host-private command or parser detail out of callers.
  }
  return null;
}

async function hasExactInspectExpectation(
  input: AppleContainerCreatePlanInput,
  inspectPlan: Readonly<AppleContainerCommandPlan>,
  expectedState: AppleContainerInspectExpectation['state'],
  environment: Readonly<Record<string, string>>,
  dependencies: AppleContainerLifecycleCanaryDependencies,
): Promise<boolean> {
  try {
    const result = await invoke(inspectPlan, environment, dependencies);
    return commandSucceeded(result, inspectPlan)
      && parseAppleContainerInspectProof(
        result.stdout,
        input,
        canaryInspectExpectation(expectedState),
      ).state === 'present-owned';
  } catch {
    return false;
  }
}

async function reconcileAfterMutation(
  input: AppleContainerCreatePlanInput,
  inspectPlan: Readonly<AppleContainerCommandPlan>,
  cleanupPlans: readonly Readonly<AppleContainerCommandPlan>[],
  listPlan: Readonly<AppleContainerCommandPlan>,
  environment: Readonly<Record<string, string>>,
  dependencies: AppleContainerLifecycleCanaryDependencies,
): Promise<Readonly<PostRunReconciliation>> {
  const inspectState = await exactInspectState(
    input,
    inspectPlan,
    environment,
    dependencies,
  );
  if (inspectState === null) {
    const listState = await exactListState(listPlan, input, environment, dependencies);
    if (listState !== 'absent') {
      // A label is not an authorization token. If the full image, process,
      // mount and state proof is missing, never delete a same-name resource.
      return Object.freeze({
        inspectState,
        ownershipState: 'unproven',
        commandProtocolCertain: false,
        absenceProven: false,
      });
    }
    return Object.freeze({
      inspectState,
      ownershipState: 'absent',
      commandProtocolCertain: true,
      absenceProven: true,
    });
  }

  let protocolCertain = true;

  // Every exact cleanup operation is attempted. A failure or timeout in one
  // operation must never suppress the next operation or the absence query.
  for (const plan of cleanupPlans) {
    try {
      const result = await invoke(plan, environment, dependencies);
      if (!commandProtocolCertain(result, plan)) protocolCertain = false;
    } catch {
      protocolCertain = false;
    }
  }

  const absenceProven = await exactListState(
    listPlan,
    input,
    environment,
    dependencies,
  ) === 'absent';

  return Object.freeze({
    inspectState,
    ownershipState: 'owned',
    commandProtocolCertain: protocolCertain,
    absenceProven,
  });
}

/**
 * Plans the first harmless, no-network Apple Container lifecycle canary.
 *
 * Preconditions: a trusted runtime dependency probe must yield the exact
 * `self-test-required` capability, and the staging tree must already be a
 * disposable private clone. The pause image receives no guest command and is
 * expected to make no staging mutation. Exact cleanup and an all-resource
 * absence proof precede the final host observation. This function is not a
 * crash-safe top-level entry point: a production caller must durably reserve
 * the exact task/container identity before invoking it, transition the durable
 * row after the stopped configuration proof, and reconcile that reservation
 * after restart. A separately privileged broker must also exclusively own the
 * Apple service namespace; same-UID labels/nonces are not authorization. Until
 * those wrappers exist, real canary execution remains disabled.
 */
export async function runAppleContainerLifecycleCanary(
  input: AppleContainerLifecycleCanaryInput,
  dependencies: AppleContainerLifecycleCanaryDependencies,
): Promise<Readonly<AppleContainerLifecycleCanaryProof>> {
  if (input === null
    || typeof input !== 'object'
    || dependencies === null
    || typeof dependencies !== 'object'
    || typeof dependencies.probeRuntimeDependencyCapability !== 'function'
    || typeof dependencies.observeStagingTree !== 'function'
    || typeof dependencies.run !== 'function') {
    return fail('APPLE_CONTAINER_CANARY_INVALID_INPUT');
  }

  let createPlan: Readonly<AppleContainerCommandPlan>;
  let startPlan: Readonly<AppleContainerCommandPlan>;
  let inspectPlan: Readonly<AppleContainerCommandPlan>;
  let cleanupPlans: readonly Readonly<AppleContainerCommandPlan>[];
  let listPlan: Readonly<AppleContainerCommandPlan>;
  let expectedId: string;
  let environment: Readonly<Record<string, string>>;
  let planInput: AppleContainerCreatePlanInput;
  try {
    planInput = {
      taskId: input.taskId,
      nonce: input.nonce,
      privateStagingRoot: input.privateStagingRoot,
      stagingPath: input.stagingPath,
      image: APPLE_CONTAINER_CANARY_IMAGE,
      cpuCount: CANARY_CPU_COUNT,
      memoryMiB: CANARY_MEMORY_MIB,
      networkPolicy: 'none' as const,
    };
    createPlan = planAppleContainerCreate(planInput);
    startPlan = planAppleContainerStart(input);
    inspectPlan = planAppleContainerInspect(input);
    cleanupPlans = planAppleContainerCleanup(input);
    listPlan = planAppleContainerListAll();
    expectedId = deriveAppleContainerName(input);
    environment = commandEnvironment(dependencies.hostEnvironment);
  } catch {
    return fail('APPLE_CONTAINER_CANARY_INVALID_INPUT');
  }

  let capability: unknown;
  try {
    capability = await dependencies.probeRuntimeDependencyCapability(
      dependencies.runtimeProbeOptions,
      dependencies.runtimeProbeDependencies,
    );
  } catch {
    return fail('APPLE_CONTAINER_CANARY_DEPENDENCY_NOT_QUALIFIED');
  }
  if (!dependencyIsQualified(capability)) {
    return fail('APPLE_CONTAINER_CANARY_DEPENDENCY_NOT_QUALIFIED');
  }

  let baseSnapshot: AgentRuntimeStagingTreeSnapshot;
  try {
    // Caller-provided evidence must never skip observation of the exact path
    // that will be mounted. A genuine snapshot from another empty directory is
    // still the wrong authority for this staging path.
    baseSnapshot = await dependencies.observeStagingTree(input.stagingPath);
    if (input.baseSnapshot !== undefined) {
      const priorComparison = buildAgentRuntimeStagingResult(
        input.baseSnapshot,
        baseSnapshot,
      );
      if (priorComparison.manifest.entries.length !== 0) {
        return fail('APPLE_CONTAINER_CANARY_STAGING_NOT_EMPTY');
      }
    }
    if (baseSnapshot.entryCount !== 0 || baseSnapshot.totalFileBytes !== 0) {
      return fail('APPLE_CONTAINER_CANARY_STAGING_NOT_EMPTY');
    }
  } catch (cause) {
    if (cause instanceof AppleContainerLifecycleCanaryError) throw cause;
    return fail('APPLE_CONTAINER_CANARY_STAGING_OBSERVATION_FAILED');
  }

  // A same-name resource from an interrupted or adversarial prior attempt is
  // never adopted or deleted. Both exact id and nonce must be absent before
  // this invocation is allowed to create anything.
  const preflightState = await exactListState(listPlan, input, environment, dependencies);
  if (preflightState !== 'absent') {
    return fail('APPLE_CONTAINER_CANARY_PREFLIGHT_NOT_CLEAR');
  }

  let primaryFailure: AppleContainerLifecycleCanaryErrorCode | null = null;
  let reconciliation: Readonly<PostRunReconciliation> = Object.freeze({
    inspectState: null,
    ownershipState: 'unproven',
    commandProtocolCertain: false,
    absenceProven: false,
  });

  try {
    let createResult: AppleContainerCommandResult;
    try {
      createResult = await invoke(createPlan, environment, dependencies);
    } catch {
      primaryFailure = 'APPLE_CONTAINER_CANARY_CREATE_FAILED';
      createResult = {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
        outputTruncated: false,
      };
    }
    if (primaryFailure === null && !commandSucceeded(createResult, createPlan)) {
      primaryFailure = 'APPLE_CONTAINER_CANARY_CREATE_FAILED';
    } else if (primaryFailure === null && !exactIdentityOutput(createResult.stdout, expectedId)) {
      primaryFailure = 'APPLE_CONTAINER_CANARY_CREATE_IDENTITY_UNVERIFIED';
    }

    if (primaryFailure === null && !await hasExactInspectExpectation(
      planInput,
      inspectPlan,
      'stopped',
      environment,
      dependencies,
    )) {
      primaryFailure = 'APPLE_CONTAINER_CANARY_STOPPED_CONFIGURATION_UNVERIFIED';
    }

    if (primaryFailure === null) {
      let startResult: AppleContainerCommandResult;
      try {
        startResult = await invoke(startPlan, environment, dependencies);
      } catch {
        primaryFailure = 'APPLE_CONTAINER_CANARY_START_FAILED';
        startResult = {
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          outputTruncated: false,
        };
      }
      if (primaryFailure === null && !commandSucceeded(startResult, startPlan)) {
        primaryFailure = 'APPLE_CONTAINER_CANARY_START_FAILED';
      } else if (primaryFailure === null
        && !exactIdentityOutput(startResult.stdout, expectedId)) {
        primaryFailure = 'APPLE_CONTAINER_CANARY_START_IDENTITY_UNVERIFIED';
      }
    }

    if (primaryFailure === null && !await hasExactInspectExpectation(
      planInput,
      inspectPlan,
      'running',
      environment,
      dependencies,
    )) {
      primaryFailure = 'APPLE_CONTAINER_CANARY_RUNNING_CONFIGURATION_UNVERIFIED';
    }
  } finally {
    reconciliation = await reconcileAfterMutation(
      planInput,
      inspectPlan,
      cleanupPlans,
      listPlan,
      environment,
      dependencies,
    );
  }

  if (reconciliation.ownershipState === 'unproven') {
    return fail('APPLE_CONTAINER_CANARY_OWNERSHIP_UNPROVEN');
  }
  if (!reconciliation.absenceProven) {
    return fail('APPLE_CONTAINER_CANARY_ABSENCE_UNPROVEN');
  }

  try {
    const finalSnapshot = await dependencies.observeStagingTree(input.stagingPath);
    if (finalSnapshot.entryCount !== 0 || finalSnapshot.totalFileBytes !== 0) {
      return fail('APPLE_CONTAINER_CANARY_STAGING_NOT_EMPTY');
    }
    const observed = buildAgentRuntimeStagingResult(baseSnapshot, finalSnapshot);
    if (observed.manifest.entries.length !== 0) {
      return fail('APPLE_CONTAINER_CANARY_STAGING_NOT_EMPTY');
    }
  } catch (cause) {
    if (cause instanceof AppleContainerLifecycleCanaryError) throw cause;
    return fail('APPLE_CONTAINER_CANARY_STAGING_OBSERVATION_FAILED');
  }

  if (!reconciliation.commandProtocolCertain) {
    return fail('APPLE_CONTAINER_CANARY_CLEANUP_UNCERTAIN');
  }
  // A successful start must remain the exact fully qualified running resource
  // at the final pre-cleanup inspection. A list/label proof cannot qualify it.
  if (primaryFailure === null && reconciliation.inspectState !== 'running') {
    return fail('APPLE_CONTAINER_CANARY_OWNERSHIP_UNPROVEN');
  }
  if (primaryFailure !== null) return fail(primaryFailure);

  return Object.freeze({
    version: APPLE_CONTAINER_LIFECYCLE_CANARY_PROOF_VERSION,
    kind: 'apple-container-vm',
    scope: 'lifecycle-canary-only',
    result: 'passed',
    ready: false,
  });
}
