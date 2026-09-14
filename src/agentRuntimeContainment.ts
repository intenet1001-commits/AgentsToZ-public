/**
 * Provider-neutral, browser-safe contract for Agent Runtime containment.
 *
 * This contract deliberately contains no executable path, command, OS resource
 * identifier, environment value, credential, or free-form diagnostic text.
 * Those values belong to a host-private registry and must never cross the
 * desktop/remote capability boundary.
 */

export const AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION = 1 as const;

export const AGENT_RUNTIME_CONTAINMENT_KINDS = Object.freeze([
  'apple-container-vm',
  'linux-systemd-cgroup-v2',
  'windows-job-object',
] as const);
export type AgentRuntimeContainmentKind =
  typeof AGENT_RUNTIME_CONTAINMENT_KINDS[number];

export const AGENT_RUNTIME_CONTAINMENT_LIFECYCLE_STATES = Object.freeze([
  'reserved',
  'staging-prepared',
  'containment-created',
  'running',
  'stopping',
  'stopped-proven',
  'result-validated',
  'materialized',
  'disposed',
] as const);
export type AgentRuntimeContainmentLifecycleState =
  typeof AGENT_RUNTIME_CONTAINMENT_LIFECYCLE_STATES[number];

/**
 * Stable, public-safe reasons for a fail-closed containment capability.
 *
 * A host may expose one of these codes to a desktop or remote client. Detailed
 * probe output stays host-private because it can contain paths, commands,
 * package identities, or other sensitive local metadata.
 */
export const AGENT_RUNTIME_CONTAINMENT_READINESS_REASONS = Object.freeze([
  'ready',
  'policy-disabled',
  'platform-unsupported',
  'dependency-missing',
  'dependency-unhealthy',
  'service-unhealthy',
  'version-unsupported',
  'binary-identity-unverified',
  'image-missing',
  'image-identity-unverified',
  'self-test-required',
  'self-test-failed',
  'reconciliation-required',
  'host-degraded',
] as const);
export type AgentRuntimeContainmentReadinessReason =
  typeof AGENT_RUNTIME_CONTAINMENT_READINESS_REASONS[number];

/** The complete public state for one task; OS resource identity remains private. */
export interface AgentRuntimeContainmentPublicState {
  readonly schemaVersion: typeof AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION;
  /** Existing bounded Agent Runtime task id, never an OS resource name. */
  readonly taskId: string;
  readonly kind: AgentRuntimeContainmentKind;
  readonly lifecycle: AgentRuntimeContainmentLifecycleState;
}

/** Public capability DTO. It intentionally has no free-form detail field. */
export interface AgentRuntimeContainmentCapability {
  readonly schemaVersion: typeof AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION;
  readonly kind: AgentRuntimeContainmentKind | null;
  readonly ready: boolean;
  readonly reason: AgentRuntimeContainmentReadinessReason;
}

export type AgentRuntimeContainmentContractErrorCode =
  | 'AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID'
  | 'AGENT_RUNTIME_CONTAINMENT_SCHEMA_UNSUPPORTED'
  | 'AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID';

export class AgentRuntimeContainmentContractError extends Error {
  constructor(readonly code: AgentRuntimeContainmentContractErrorCode) {
    super(code);
    this.name = 'AgentRuntimeContainmentContractError';
  }
}

type JsonObject = Record<string, unknown>;

const STATE_KEYS = Object.freeze(['schemaVersion', 'taskId', 'kind', 'lifecycle'] as const);
const CAPABILITY_KEYS = Object.freeze(['schemaVersion', 'kind', 'ready', 'reason'] as const);
const TASK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

const lifecycleTargets = (
  ...states: AgentRuntimeContainmentLifecycleState[]
): readonly AgentRuntimeContainmentLifecycleState[] => Object.freeze(states);

const NEXT_LIFECYCLE_STATES: Readonly<
  Record<AgentRuntimeContainmentLifecycleState, readonly AgentRuntimeContainmentLifecycleState[]>
> = Object.freeze({
  // A failed/cancelled preparation still enters the explicit cleanup path;
  // it must not pretend that an OS containment resource was created.
  reserved: lifecycleTargets('staging-prepared', 'stopping'),
  'staging-prepared': lifecycleTargets('containment-created', 'stopping'),
  'containment-created': lifecycleTargets('running', 'stopping'),
  running: lifecycleTargets('stopping'),
  stopping: lifecycleTargets('stopped-proven'),
  // Failed/cancelled tasks may have no result to validate or materialize.
  'stopped-proven': lifecycleTargets('result-validated', 'disposed'),
  // A valid result can be reviewed/quarantined without being materialized.
  'result-validated': lifecycleTargets('materialized', 'disposed'),
  materialized: lifecycleTargets('disposed'),
  disposed: lifecycleTargets(),
});

function fail(code: AgentRuntimeContainmentContractErrorCode): never {
  throw new AgentRuntimeContainmentContractError(code);
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
  }
  return value as JsonObject;
}

function assertCurrentSchema(raw: JsonObject): void {
  if (raw.schemaVersion !== AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION) {
    fail('AGENT_RUNTIME_CONTAINMENT_SCHEMA_UNSUPPORTED');
  }
}

function hasExactKeys(raw: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(raw).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isContainmentKind(value: unknown): value is AgentRuntimeContainmentKind {
  return typeof value === 'string'
    && AGENT_RUNTIME_CONTAINMENT_KINDS.includes(value as AgentRuntimeContainmentKind);
}

function isLifecycleState(value: unknown): value is AgentRuntimeContainmentLifecycleState {
  return typeof value === 'string'
    && AGENT_RUNTIME_CONTAINMENT_LIFECYCLE_STATES.includes(
      value as AgentRuntimeContainmentLifecycleState,
    );
}

function isReadinessReason(value: unknown): value is AgentRuntimeContainmentReadinessReason {
  return typeof value === 'string'
    && AGENT_RUNTIME_CONTAINMENT_READINESS_REASONS.includes(
      value as AgentRuntimeContainmentReadinessReason,
    );
}

export function normalizeAgentRuntimeContainmentPublicState(
  value: unknown,
): Readonly<AgentRuntimeContainmentPublicState> {
  const raw = asObject(value);
  assertCurrentSchema(raw);
  if (!hasExactKeys(raw, STATE_KEYS)
    || typeof raw.taskId !== 'string'
    || !TASK_ID_RE.test(raw.taskId)
    || !isContainmentKind(raw.kind)
    || !isLifecycleState(raw.lifecycle)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
  }
  return Object.freeze({
    schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
    taskId: raw.taskId,
    kind: raw.kind,
    lifecycle: raw.lifecycle,
  });
}

export function createAgentRuntimeContainmentReservedState(
  taskId: string,
  kind: AgentRuntimeContainmentKind,
): Readonly<AgentRuntimeContainmentPublicState> {
  return normalizeAgentRuntimeContainmentPublicState({
    schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
    taskId,
    kind,
    lifecycle: 'reserved',
  });
}

/**
 * Advances one explicit durable lifecycle edge. Cleanup edges intentionally
 * allow a failure/cancellation to stop before running and to dispose without
 * claiming that a result was validated or materialized. Other skips,
 * regressions, repeats, and transitions after disposal are rejected.
 */
export function transitionAgentRuntimeContainment(
  currentValue: unknown,
  nextLifecycle: AgentRuntimeContainmentLifecycleState,
): Readonly<AgentRuntimeContainmentPublicState> {
  const current = normalizeAgentRuntimeContainmentPublicState(currentValue);
  if (!isLifecycleState(nextLifecycle)
    || !NEXT_LIFECYCLE_STATES[current.lifecycle].includes(nextLifecycle)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_TRANSITION_INVALID');
  }
  return Object.freeze({ ...current, lifecycle: nextLifecycle });
}

export function normalizeAgentRuntimeContainmentCapability(
  value: unknown,
): Readonly<AgentRuntimeContainmentCapability> {
  const raw = asObject(value);
  assertCurrentSchema(raw);
  if (!hasExactKeys(raw, CAPABILITY_KEYS)
    || (raw.kind !== null && !isContainmentKind(raw.kind))
    || typeof raw.ready !== 'boolean'
    || !isReadinessReason(raw.reason)
    || (raw.ready && (raw.reason !== 'ready' || raw.kind === null))
    || (!raw.ready && raw.reason === 'ready')) {
    return fail('AGENT_RUNTIME_CONTAINMENT_CONTRACT_INVALID');
  }
  return Object.freeze({
    schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
    kind: raw.kind,
    ready: raw.ready,
    reason: raw.reason,
  });
}

export function createAgentRuntimeContainmentCapability(
  kind: AgentRuntimeContainmentKind | null,
  reason: AgentRuntimeContainmentReadinessReason,
): Readonly<AgentRuntimeContainmentCapability> {
  return normalizeAgentRuntimeContainmentCapability({
    schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
    kind,
    ready: reason === 'ready',
    reason,
  });
}

/** Invalid, unknown, and future-version values are never treated as ready. */
export function isAgentRuntimeContainmentReady(value: unknown): boolean {
  try {
    return normalizeAgentRuntimeContainmentCapability(value).ready;
  } catch {
    return false;
  }
}
