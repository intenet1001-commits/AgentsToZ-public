import {
  closeSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
  normalizeAgentRuntimeContainmentPublicState,
  transitionAgentRuntimeContainment,
  type AgentRuntimeContainmentLifecycleState,
  type AgentRuntimeContainmentPublicState,
} from './agentRuntimeContainment';
import {
  deriveAppleContainerName,
  planAppleContainerCreate,
} from './appleContainerCommandPlan';

/**
 * Host-private, crash-safe ownership registry for containment OS resources.
 *
 * A row MUST be committed before its corresponding OS resource is created.
 * Nothing in this module executes an external command or exposes private
 * resource identity through the public Agent Runtime contract.
 */

export const AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION = 2 as const;
export const AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_LIST = 1_000;
export const AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_AUDIT_READ = 1_000;

const APPLICATION_ID = 0x41545a43; // "ATZC"
const REGISTRY_CONSTRUCTION_TOKEN = Symbol('agent-runtime-containment-registry');
const TASK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_IMAGE_REFERENCE_BYTES = 512;
const ACTIVE_LIFECYCLES = Object.freeze([
  'reserved',
  'staging-prepared',
  'containment-created',
  'running',
  'stopping',
  'stopped-proven',
  'result-validated',
  'materialized',
] as const);
const STAGING_IDENTITY_REQUIRED_LIFECYCLES = Object.freeze([
  'staging-prepared',
  'containment-created',
  'running',
  'result-validated',
  'materialized',
] as const);

export type AgentRuntimeContainmentBaseTargetKind = 'main' | 'worktree';

export interface AgentRuntimeContainmentBaseTargetIdentity {
  /** Registered host-private target id, not a display label or path. */
  readonly targetId: string;
  readonly kind: AgentRuntimeContainmentBaseTargetKind;
  /** Canonical absolute path revalidated by the future materializer. */
  readonly canonicalPath: string;
  /** Host-computed stable identity digest for path/repository/worktree identity. */
  readonly identity: string;
  /** Exact commit from which the isolated staging copy was prepared. */
  readonly gitCommit: string;
}

export interface ReserveAppleContainerContainmentInput {
  readonly taskId: string;
  readonly kind: 'apple-container-vm';
  /** Fresh 32-byte lower-case hex secret used only for resource ownership. */
  readonly nonce: string;
  /** Registry-qualified immutable OCI reference containing @sha256:<digest>. */
  readonly imageReference: string;
  /** Digest of the canonical CPU/memory/network/capability/runtime execution policy. */
  readonly executionPolicyDigest: string;
  /** Qualified VM kernel artifact digest. */
  readonly kernelSha256: string;
  /** Digest of the broker-owned install/service/init-process TCB. */
  readonly brokerTcbDigest: string;
  /** Trusted app-private root; this broad directory is never mounted. */
  readonly privateStagingRoot: string;
  /** Unique task staging directory that may later be mounted read-write. */
  readonly stagingPath: string;
  readonly baseTarget: AgentRuntimeContainmentBaseTargetIdentity;
}

export interface SealAgentRuntimeStagingInput {
  readonly taskId: string;
  readonly expectedGeneration: number;
  /** Host-computed stable digest after the staging directory is fully prepared. */
  readonly stagingIdentity: string;
}

export interface AgentRuntimeContainmentPrivateRecord {
  readonly schemaVersion: typeof AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION;
  readonly taskId: string;
  readonly kind: 'apple-container-vm';
  readonly lifecycle: AgentRuntimeContainmentLifecycleState;
  readonly generation: number;
  readonly containerName: string;
  readonly nonce: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly executionPolicyDigest: string;
  readonly kernelSha256: string;
  readonly brokerTcbDigest: string;
  readonly privateStagingRoot: string;
  readonly stagingPath: string;
  /** Null until sealStaging atomically commits the prepared staging identity. */
  readonly stagingIdentity: string | null;
  readonly baseTarget: Readonly<AgentRuntimeContainmentBaseTargetIdentity>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentRuntimeContainmentTransitionAudit {
  readonly taskId: string;
  readonly generation: number;
  readonly fromLifecycle: AgentRuntimeContainmentLifecycleState | null;
  readonly toLifecycle: AgentRuntimeContainmentLifecycleState;
  /** Null until staging is sealed, and remains null on pre-seal cleanup paths. */
  readonly stagingIdentity: string | null;
  readonly executionPolicyDigest: string;
  readonly kernelSha256: string;
  readonly brokerTcbDigest: string;
  readonly occurredAt: string;
}

export interface ReserveAgentRuntimeContainmentResult {
  readonly duplicate: boolean;
  readonly record: Readonly<AgentRuntimeContainmentPrivateRecord>;
}

export interface TransitionAgentRuntimeContainmentInput {
  readonly taskId: string;
  readonly expectedGeneration: number;
  readonly expectedLifecycle: AgentRuntimeContainmentLifecycleState;
  readonly nextLifecycle: AgentRuntimeContainmentLifecycleState;
}

export type AgentRuntimeContainmentRegistryErrorCode =
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CLOSED'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_FUTURE_SCHEMA'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAPACITY_EXCEEDED'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_TASK_NOT_FOUND'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT'
  | 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_TRANSITION_INVALID';

export class AgentRuntimeContainmentRegistryError extends Error {
  constructor(readonly code: AgentRuntimeContainmentRegistryErrorCode) {
    // Do not reflect database paths, resource names, nonces, or image identity.
    super(code);
    this.name = 'AgentRuntimeContainmentRegistryError';
  }
}

type JsonObject = Record<string, unknown>;

interface ContainmentRow {
  task_id: unknown;
  kind: unknown;
  lifecycle: unknown;
  generation: unknown;
  container_name: unknown;
  nonce: unknown;
  image_reference: unknown;
  image_digest: unknown;
  execution_policy_digest: unknown;
  kernel_sha256: unknown;
  broker_tcb_digest: unknown;
  private_staging_root: unknown;
  staging_path: unknown;
  staging_identity: unknown;
  base_target_id: unknown;
  base_target_kind: unknown;
  base_target_path: unknown;
  base_target_identity: unknown;
  base_git_commit: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface AuditRow {
  task_id: unknown;
  generation: unknown;
  from_lifecycle: unknown;
  to_lifecycle: unknown;
  staging_identity: unknown;
  execution_policy_digest: unknown;
  kernel_sha256: unknown;
  broker_tcb_digest: unknown;
  occurred_at: unknown;
}

const CONTAINMENT_COLUMNS = `
  task_id, kind, lifecycle, generation, container_name, nonce,
  image_reference, image_digest, execution_policy_digest, kernel_sha256,
  broker_tcb_digest, private_staging_root, staging_path,
  staging_identity, base_target_id, base_target_kind, base_target_path,
  base_target_identity, base_git_commit, created_at, updated_at
`;

const ALLOWED_DATABASE_OBJECTS = new Set([
  'agent_runtime_containment_meta',
  'agent_runtime_containments',
  'agent_runtime_containment_transitions',
  'agent_runtime_containments_active_idx',
  'agent_runtime_containments_staging_identity_uq',
  'agent_runtime_containment_transition_guard',
  'agent_runtime_containment_transition_audit',
  'agent_runtime_containment_no_delete',
  'agent_runtime_containment_audit_no_update',
  'agent_runtime_containment_audit_no_delete',
]);

const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agent_runtime_containment_meta: Object.freeze(['singleton', 'schema_version']),
  agent_runtime_containments: Object.freeze([
    'task_id', 'kind', 'lifecycle', 'generation', 'container_name', 'nonce',
    'image_reference', 'image_digest', 'execution_policy_digest', 'kernel_sha256',
    'broker_tcb_digest', 'private_staging_root', 'staging_path',
    'staging_identity', 'base_target_id', 'base_target_kind', 'base_target_path',
    'base_target_identity', 'base_git_commit', 'created_at', 'updated_at',
  ]),
  agent_runtime_containment_transitions: Object.freeze([
    'task_id', 'generation', 'from_lifecycle', 'to_lifecycle', 'staging_identity',
    'execution_policy_digest', 'kernel_sha256', 'broker_tcb_digest', 'occurred_at',
  ]),
});

function fail(code: AgentRuntimeContainmentRegistryErrorCode): never {
  throw new AgentRuntimeContainmentRegistryError(code);
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value as JsonObject;
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_RE.test(value)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value;
}

function databaseTaskId(value: unknown): string {
  try {
    return taskId(value);
  } catch {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value;
}

function databaseDigest(value: unknown): string {
  try {
    return digest(value);
  } catch {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
}

function databaseNullableDigest(value: unknown): string | null {
  if (value === null) return null;
  return databaseDigest(value);
}

function safeGeneration(value: unknown, corruption = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail(corruption
      ? 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
      : 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value;
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result)
    || result < 1 || result > maximum) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return result;
}

function safeAfterGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value;
}

function isoTimestamp(value: unknown, corruption = false): string {
  if (typeof value !== 'string' || value.length > 64) {
    return fail(corruption
      ? 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
      : 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    return fail(corruption
      ? 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
      : 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value;
}

function canonicalAbsolutePath(value: unknown, corruption = false): string {
  const code = corruption
    ? 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
    : 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT';
  if (typeof value !== 'string'
    || !isAbsolute(value)
    || resolve(value) !== value
    || value.normalize('NFC') !== value
    || /[\u0000-\u001f\u007f]/.test(value)
    || utf8Bytes(value) > MAX_PATH_BYTES) {
    return fail(code);
  }
  return value;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const isInside = (candidate: string): boolean => candidate === ''
    || (!isAbsolute(candidate) && candidate !== '..' && !candidate.startsWith(`..${sep}`));
  return isInside(leftToRight) || isInside(rightToLeft);
}

function baseTargetKind(value: unknown, corruption = false): AgentRuntimeContainmentBaseTargetKind {
  if (value !== 'main' && value !== 'worktree') {
    return fail(corruption
      ? 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
      : 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value;
}

function gitCommit(value: unknown, corruption = false): string {
  if (typeof value !== 'string' || !GIT_COMMIT_RE.test(value)) {
    return fail(corruption
      ? 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
      : 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  return value;
}

function normalizeReservation(
  value: ReserveAppleContainerContainmentInput,
): Omit<AgentRuntimeContainmentPrivateRecord, 'schemaVersion' | 'lifecycle' | 'generation' | 'createdAt' | 'updatedAt'> {
  const raw = asObject(value);
  if (!hasExactKeys(raw, [
    'taskId', 'kind', 'nonce', 'imageReference', 'executionPolicyDigest',
    'kernelSha256', 'brokerTcbDigest', 'privateStagingRoot', 'stagingPath', 'baseTarget',
  ]) || raw.kind !== 'apple-container-vm') {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  const normalizedTaskId = taskId(raw.taskId);
  const base = asObject(raw.baseTarget);
  if (!hasExactKeys(base, ['targetId', 'kind', 'canonicalPath', 'identity', 'gitCommit'])) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  const normalizedBase = Object.freeze({
    targetId: taskId(base.targetId),
    kind: baseTargetKind(base.kind),
    canonicalPath: canonicalAbsolutePath(base.canonicalPath),
    identity: digest(base.identity),
    gitCommit: gitCommit(base.gitCommit),
  });
  const privateStagingRoot = canonicalAbsolutePath(raw.privateStagingRoot);
  const stagingPath = canonicalAbsolutePath(raw.stagingPath);
  if (pathsOverlap(normalizedBase.canonicalPath, privateStagingRoot)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  if (typeof raw.nonce !== 'string' || typeof raw.imageReference !== 'string'
    || utf8Bytes(raw.imageReference) > MAX_IMAGE_REFERENCE_BYTES) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  // Reuse the exact trusted planner validation so persistence and execution
  // cannot disagree about nonce, pinned image, or staging containment.
  try {
    planAppleContainerCreate({
      taskId: normalizedTaskId,
      nonce: raw.nonce,
      image: raw.imageReference,
      privateStagingRoot,
      stagingPath,
    });
  } catch {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
  const imageDigest = raw.imageReference.slice(raw.imageReference.lastIndexOf('@sha256:') + 8);
  return Object.freeze({
    taskId: normalizedTaskId,
    kind: 'apple-container-vm',
    containerName: deriveAppleContainerName({ taskId: normalizedTaskId, nonce: raw.nonce }),
    nonce: raw.nonce,
    imageReference: raw.imageReference,
    imageDigest: digest(imageDigest),
    executionPolicyDigest: digest(raw.executionPolicyDigest),
    kernelSha256: digest(raw.kernelSha256),
    brokerTcbDigest: digest(raw.brokerTcbDigest),
    privateStagingRoot,
    stagingPath,
    stagingIdentity: null,
    baseTarget: normalizedBase,
  });
}

function normalizeLifecycle(value: unknown, corruption = false): AgentRuntimeContainmentLifecycleState {
  try {
    return normalizeAgentRuntimeContainmentPublicState({
      schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
      taskId: 'validation_task',
      kind: 'apple-container-vm',
      lifecycle: value,
    }).lifecycle;
  } catch {
    return fail(corruption
      ? 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT'
      : 'AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
  }
}

function privateRecordFromRow(row: ContainmentRow | null): Readonly<AgentRuntimeContainmentPrivateRecord> | null {
  if (!row) return null;
  const normalizedTaskId = databaseTaskId(row.task_id);
  if (row.kind !== 'apple-container-vm') {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const lifecycle = normalizeLifecycle(row.lifecycle, true);
  const generation = safeGeneration(row.generation, true);
  const stagingIdentity = databaseNullableDigest(row.staging_identity);
  const stagingIdentityRequired = STAGING_IDENTITY_REQUIRED_LIFECYCLES.includes(
    lifecycle as typeof STAGING_IDENTITY_REQUIRED_LIFECYCLES[number],
  );
  if ((lifecycle === 'reserved' && stagingIdentity !== null)
    || (stagingIdentityRequired && stagingIdentity === null)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const nonce = typeof row.nonce === 'string' ? row.nonce : '';
  const imageReference = typeof row.image_reference === 'string' ? row.image_reference : '';
  const privateStagingRoot = canonicalAbsolutePath(row.private_staging_root, true);
  const stagingPath = canonicalAbsolutePath(row.staging_path, true);
  const basePath = canonicalAbsolutePath(row.base_target_path, true);
  if (pathsOverlap(basePath, privateStagingRoot)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  try {
    planAppleContainerCreate({
      taskId: normalizedTaskId,
      nonce,
      image: imageReference,
      privateStagingRoot,
      stagingPath,
    });
  } catch {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const expectedContainerName = deriveAppleContainerName({ taskId: normalizedTaskId, nonce });
  const expectedDigest = imageReference.slice(imageReference.lastIndexOf('@sha256:') + 8);
  if (row.container_name !== expectedContainerName
    || row.image_digest !== expectedDigest
    || typeof row.container_name !== 'string') {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const createdAt = isoTimestamp(row.created_at, true);
  const updatedAt = isoTimestamp(row.updated_at, true);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const baseTarget = Object.freeze({
    targetId: databaseTaskId(row.base_target_id),
    kind: baseTargetKind(row.base_target_kind, true),
    canonicalPath: basePath,
    identity: databaseDigest(row.base_target_identity),
    gitCommit: gitCommit(row.base_git_commit, true),
  });
  return Object.freeze({
    schemaVersion: AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION,
    taskId: normalizedTaskId,
    kind: 'apple-container-vm',
    lifecycle,
    generation,
    containerName: expectedContainerName,
    nonce,
    imageReference,
    imageDigest: databaseDigest(row.image_digest),
    executionPolicyDigest: databaseDigest(row.execution_policy_digest),
    kernelSha256: databaseDigest(row.kernel_sha256),
    brokerTcbDigest: databaseDigest(row.broker_tcb_digest),
    privateStagingRoot,
    stagingPath,
    stagingIdentity,
    baseTarget,
    createdAt,
    updatedAt,
  });
}

function auditFromRow(row: AuditRow): Readonly<AgentRuntimeContainmentTransitionAudit> {
  return Object.freeze({
    taskId: databaseTaskId(row.task_id),
    generation: safeGeneration(row.generation, true),
    fromLifecycle: row.from_lifecycle === null
      ? null
      : normalizeLifecycle(row.from_lifecycle, true),
    toLifecycle: normalizeLifecycle(row.to_lifecycle, true),
    stagingIdentity: databaseNullableDigest(row.staging_identity),
    executionPolicyDigest: databaseDigest(row.execution_policy_digest),
    kernelSha256: databaseDigest(row.kernel_sha256),
    brokerTcbDigest: databaseDigest(row.broker_tcb_digest),
    occurredAt: isoTimestamp(row.occurred_at, true),
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function sqliteErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AgentRuntimeContainmentRegistryError) throw error;
    const code = sqliteErrorCode(error);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY');
    }
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
}

function runImmediateTransaction<T>(database: Database, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The primary operation error is the actionable one.
    }
    throw error;
  }
}

function assertOwnedPrivateDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
  }
  if (process.platform !== 'win32') {
    const getuid = process.getuid;
    if ((typeof getuid === 'function' && info.uid !== getuid()) || (info.mode & 0o077) !== 0) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
    }
  }
}

function assertSafeDatabaseArtifact(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
  }
  if (process.platform !== 'win32') {
    const getuid = process.getuid;
    if (typeof getuid === 'function' && info.uid !== getuid()) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
    }
    if ((info.mode & 0o077) !== 0) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
    }
  }
}

function prepareDatabasePath(path: string): void {
  if (path === ':memory:') return;
  if (typeof path !== 'string'
    || !isAbsolute(path)
    || resolve(path) !== path
    || path.normalize('NFC') !== path
    || /[\u0000-\u001f\u007f]/.test(path)
    || utf8Bytes(path) > MAX_PATH_BYTES
    || !path.endsWith('.sqlite')) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
  }
  const parent = dirname(path);
  if (parent === sep) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertOwnedPrivateDirectory(parent);
  // lstat(parent) only catches a symlink in the final component. Requiring
  // byte-for-byte equality with realpath also rejects every ancestor symlink,
  // so SQLite cannot be redirected outside the selected private directory.
  if (realpathSync(parent) !== parent) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_UNSAFE_PATH');
  }

  const journalPath = `${path}-journal`;
  const walPath = `${path}-wal`;
  const sharedMemoryPath = `${path}-shm`;
  for (const artifact of [path, journalPath, walPath, sharedMemoryPath]) {
    assertSafeDatabaseArtifact(artifact);
  }
  // Do this before creating a missing main file: orphan rollback/WAL/SHM
  // artifacts are not authority for a new registry and remain untouched.
  if (existsSync(journalPath) || existsSync(walPath) || existsSync(sharedMemoryPath)) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY');
  }

  if (!existsSync(path)) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      closeSync(descriptor);
    } catch (error) {
      if (sqliteErrorCode(error) !== 'EEXIST') throw error;
    }
  }
  for (const artifact of [path, journalPath, walPath, sharedMemoryPath]) {
    assertSafeDatabaseArtifact(artifact);
  }
}

function applyPrivateDatabasePermissions(path: string): void {
  if (path === ':memory:' || process.platform === 'win32') return;
  chmodSync(path, 0o600);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const artifact = `${path}${suffix}`;
    if (existsSync(artifact)) chmodSync(artifact, 0o600);
  }
}

const META_TABLE_SQL = `
  CREATE TABLE agent_runtime_containment_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL
  )
`;

const CONTAINMENTS_TABLE_SQL = `
  CREATE TABLE agent_runtime_containments (
    task_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'apple-container-vm'),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN (
      'reserved', 'staging-prepared', 'containment-created', 'running',
      'stopping', 'stopped-proven', 'result-validated', 'materialized', 'disposed'
    )),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    container_name TEXT NOT NULL UNIQUE,
    nonce TEXT NOT NULL UNIQUE,
    image_reference TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    execution_policy_digest TEXT NOT NULL CHECK (
      typeof(execution_policy_digest) = 'text'
      AND length(execution_policy_digest) = 64
      AND execution_policy_digest NOT GLOB '*[^a-f0-9]*'
    ),
    kernel_sha256 TEXT NOT NULL CHECK (
      typeof(kernel_sha256) = 'text'
      AND length(kernel_sha256) = 64
      AND kernel_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    broker_tcb_digest TEXT NOT NULL CHECK (
      typeof(broker_tcb_digest) = 'text'
      AND length(broker_tcb_digest) = 64
      AND broker_tcb_digest NOT GLOB '*[^a-f0-9]*'
    ),
    private_staging_root TEXT NOT NULL,
    staging_path TEXT NOT NULL UNIQUE,
    staging_identity TEXT CHECK (
      staging_identity IS NULL OR (
        typeof(staging_identity) = 'text'
        AND length(staging_identity) = 64
        AND staging_identity NOT GLOB '*[^a-f0-9]*'
      )
    ),
    base_target_id TEXT NOT NULL,
    base_target_kind TEXT NOT NULL CHECK (base_target_kind IN ('main', 'worktree')),
    base_target_path TEXT NOT NULL,
    base_target_identity TEXT NOT NULL,
    base_git_commit TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (lifecycle = 'reserved' AND staging_identity IS NULL)
      OR lifecycle IN ('stopping', 'stopped-proven', 'disposed')
      OR (
        lifecycle IN (
          'staging-prepared', 'containment-created', 'running',
          'result-validated', 'materialized'
        ) AND staging_identity IS NOT NULL
      )
    )
  )
`;

const ACTIVE_INDEX_SQL = `
  CREATE INDEX agent_runtime_containments_active_idx
    ON agent_runtime_containments(lifecycle, created_at, task_id)
    WHERE lifecycle != 'disposed'
`;

const STAGING_IDENTITY_INDEX_SQL = `
  CREATE UNIQUE INDEX agent_runtime_containments_staging_identity_uq
    ON agent_runtime_containments(staging_identity)
    WHERE staging_identity IS NOT NULL
`;

const TRANSITIONS_TABLE_SQL = `
  CREATE TABLE agent_runtime_containment_transitions (
    task_id TEXT NOT NULL REFERENCES agent_runtime_containments(task_id),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    from_lifecycle TEXT,
    to_lifecycle TEXT NOT NULL,
    staging_identity TEXT CHECK (
      staging_identity IS NULL OR (
        typeof(staging_identity) = 'text'
        AND length(staging_identity) = 64
        AND staging_identity NOT GLOB '*[^a-f0-9]*'
      )
    ),
    execution_policy_digest TEXT NOT NULL CHECK (
      typeof(execution_policy_digest) = 'text'
      AND length(execution_policy_digest) = 64
      AND execution_policy_digest NOT GLOB '*[^a-f0-9]*'
    ),
    kernel_sha256 TEXT NOT NULL CHECK (
      typeof(kernel_sha256) = 'text'
      AND length(kernel_sha256) = 64
      AND kernel_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    broker_tcb_digest TEXT NOT NULL CHECK (
      typeof(broker_tcb_digest) = 'text'
      AND length(broker_tcb_digest) = 64
      AND broker_tcb_digest NOT GLOB '*[^a-f0-9]*'
    ),
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (task_id, generation)
  ) WITHOUT ROWID
`;

const TRANSITION_GUARD_TRIGGER_SQL = `
  CREATE TRIGGER agent_runtime_containment_transition_guard
  BEFORE UPDATE ON agent_runtime_containments
  BEGIN
    SELECT CASE WHEN
      NEW.task_id != OLD.task_id OR NEW.kind != OLD.kind
      OR NEW.container_name != OLD.container_name OR NEW.nonce != OLD.nonce
      OR NEW.image_reference != OLD.image_reference OR NEW.image_digest != OLD.image_digest
      OR NEW.execution_policy_digest != OLD.execution_policy_digest
      OR NEW.kernel_sha256 != OLD.kernel_sha256
      OR NEW.broker_tcb_digest != OLD.broker_tcb_digest
      OR NEW.private_staging_root != OLD.private_staging_root
      OR NEW.staging_path != OLD.staging_path
      OR NEW.base_target_id != OLD.base_target_id
      OR NEW.base_target_kind != OLD.base_target_kind
      OR NEW.base_target_path != OLD.base_target_path
      OR NEW.base_target_identity != OLD.base_target_identity
      OR NEW.base_git_commit != OLD.base_git_commit OR NEW.created_at != OLD.created_at
    THEN RAISE(ABORT, 'immutable containment identity') END;
    SELECT CASE WHEN NEW.staging_identity IS NOT OLD.staging_identity AND NOT (
      OLD.lifecycle = 'reserved' AND NEW.lifecycle = 'staging-prepared'
      AND OLD.staging_identity IS NULL AND NEW.staging_identity IS NOT NULL
      AND typeof(NEW.staging_identity) = 'text'
      AND length(NEW.staging_identity) = 64
      AND NEW.staging_identity NOT GLOB '*[^a-f0-9]*'
    ) THEN RAISE(ABORT, 'immutable staging identity') END;
    SELECT CASE WHEN NEW.generation != OLD.generation + 1
      THEN RAISE(ABORT, 'invalid containment generation') END;
    SELECT CASE WHEN NOT (
      (OLD.lifecycle = 'reserved' AND NEW.lifecycle IN ('staging-prepared', 'stopping'))
      OR (OLD.lifecycle = 'staging-prepared' AND NEW.lifecycle IN ('containment-created', 'stopping'))
      OR (OLD.lifecycle = 'containment-created' AND NEW.lifecycle IN ('running', 'stopping'))
      OR (OLD.lifecycle = 'running' AND NEW.lifecycle = 'stopping')
      OR (OLD.lifecycle = 'stopping' AND NEW.lifecycle = 'stopped-proven')
      OR (OLD.lifecycle = 'stopped-proven' AND NEW.lifecycle IN ('result-validated', 'disposed'))
      OR (OLD.lifecycle = 'result-validated' AND NEW.lifecycle IN ('materialized', 'disposed'))
      OR (OLD.lifecycle = 'materialized' AND NEW.lifecycle = 'disposed')
    ) THEN RAISE(ABORT, 'invalid containment transition') END;
    SELECT CASE WHEN OLD.lifecycle = 'reserved' AND NEW.lifecycle = 'staging-prepared'
      AND NOT (
        OLD.staging_identity IS NULL AND NEW.staging_identity IS NOT NULL
        AND typeof(NEW.staging_identity) = 'text'
        AND length(NEW.staging_identity) = 64
        AND NEW.staging_identity NOT GLOB '*[^a-f0-9]*'
      ) THEN RAISE(ABORT, 'staging transition must seal identity') END;
  END
`;

const TRANSITION_AUDIT_TRIGGER_SQL = `
  CREATE TRIGGER agent_runtime_containment_transition_audit
  AFTER UPDATE ON agent_runtime_containments
  BEGIN
    INSERT INTO agent_runtime_containment_transitions(
      task_id, generation, from_lifecycle, to_lifecycle, staging_identity,
      execution_policy_digest, kernel_sha256, broker_tcb_digest, occurred_at
    ) VALUES (
      NEW.task_id, NEW.generation, OLD.lifecycle, NEW.lifecycle,
      NEW.staging_identity, NEW.execution_policy_digest, NEW.kernel_sha256,
      NEW.broker_tcb_digest, NEW.updated_at
    );
  END
`;

const CONTAINMENT_NO_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER agent_runtime_containment_no_delete
  BEFORE DELETE ON agent_runtime_containments
  BEGIN
    SELECT RAISE(ABORT, 'containment rows are retained');
  END
`;

const AUDIT_NO_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER agent_runtime_containment_audit_no_update
  BEFORE UPDATE ON agent_runtime_containment_transitions
  BEGIN
    SELECT RAISE(ABORT, 'containment audit is append-only');
  END
`;

const AUDIT_NO_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER agent_runtime_containment_audit_no_delete
  BEFORE DELETE ON agent_runtime_containment_transitions
  BEGIN
    SELECT RAISE(ABORT, 'containment audit is append-only');
  END
`;

const EXPECTED_SCHEMA_OBJECT_SQL = Object.freeze({
  agent_runtime_containment_meta: META_TABLE_SQL,
  agent_runtime_containments: CONTAINMENTS_TABLE_SQL,
  agent_runtime_containments_active_idx: ACTIVE_INDEX_SQL,
  agent_runtime_containments_staging_identity_uq: STAGING_IDENTITY_INDEX_SQL,
  agent_runtime_containment_transitions: TRANSITIONS_TABLE_SQL,
  agent_runtime_containment_transition_guard: TRANSITION_GUARD_TRIGGER_SQL,
  agent_runtime_containment_transition_audit: TRANSITION_AUDIT_TRIGGER_SQL,
  agent_runtime_containment_no_delete: CONTAINMENT_NO_DELETE_TRIGGER_SQL,
  agent_runtime_containment_audit_no_update: AUDIT_NO_UPDATE_TRIGGER_SQL,
  agent_runtime_containment_audit_no_delete: AUDIT_NO_DELETE_TRIGGER_SQL,
});

function createSchema(database: Database): void {
  database.exec(`
    ${META_TABLE_SQL};
    ${CONTAINMENTS_TABLE_SQL};
    ${ACTIVE_INDEX_SQL};
    ${STAGING_IDENTITY_INDEX_SQL};
    ${TRANSITIONS_TABLE_SQL};
    ${TRANSITION_GUARD_TRIGGER_SQL};
    ${TRANSITION_AUDIT_TRIGGER_SQL};
    ${CONTAINMENT_NO_DELETE_TRIGGER_SQL};
    ${AUDIT_NO_UPDATE_TRIGGER_SQL};
    ${AUDIT_NO_DELETE_TRIGGER_SQL};
  `);
}

function tableNames(database: Database): string[] {
  return (database.query(`
    SELECT name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all() as Array<{ name?: unknown }>).map((row) => {
    if (typeof row.name !== 'string') fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    return row.name;
  });
}

function validateSchemaShape(database: Database): void {
  const normalizeSql = (value: unknown): string => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
  const names = tableNames(database);
  if (names.length !== ALLOWED_DATABASE_OBJECTS.size
    || names.some(name => !ALLOWED_DATABASE_OBJECTS.has(name))) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const tableInfo = database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
      type?: unknown;
      notnull?: unknown;
    }>;
    const columns = tableInfo.map(row => row.name);
    if (columns.length !== expected.length
      || columns.some((column, index) => column !== expected[index])) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    const stagingIdentity = tableInfo.find(row => row.name === 'staging_identity');
    if (stagingIdentity
      && (stagingIdentity.type !== 'TEXT' || stagingIdentity.notnull !== 0)) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
  }
  const stagingIdentityIndex = (database.query(`
    PRAGMA index_list(agent_runtime_containments)
  `).all() as Array<{
    name?: unknown;
    unique?: unknown;
    partial?: unknown;
  }>).find(row => row.name === 'agent_runtime_containments_staging_identity_uq');
  if (!stagingIdentityIndex
    || stagingIdentityIndex.unique !== 1
    || stagingIdentityIndex.partial !== 1) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const stagingIdentityIndexColumns = (database.query(`
    PRAGMA index_info(agent_runtime_containments_staging_identity_uq)
  `).all() as Array<{ name?: unknown }>).map(row => row.name);
  if (stagingIdentityIndexColumns.length !== 1
    || stagingIdentityIndexColumns[0] !== 'staging_identity') {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const stagingIdentityIndexSql = database.query(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'agent_runtime_containments_staging_identity_uq'
  `).get() as { sql?: unknown } | null;
  const normalizedIndexSql = normalizeSql(stagingIdentityIndexSql?.sql);
  if (normalizedIndexSql !== normalizeSql(`
    CREATE UNIQUE INDEX agent_runtime_containments_staging_identity_uq
      ON agent_runtime_containments(staging_identity)
      WHERE staging_identity IS NOT NULL
  `)) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  for (const [name, expectedSql] of Object.entries(EXPECTED_SCHEMA_OBJECT_SQL)) {
    const object = database.query(`
      SELECT sql FROM sqlite_master WHERE name = ?
    `).get(name) as { sql?: unknown } | null;
    if (normalizeSql(object?.sql) !== normalizeSql(expectedSql)) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
  }
}

function validateAuditChain(
  database: Database,
  record: Readonly<AgentRuntimeContainmentPrivateRecord>,
): void {
  const rows = database.query(`
    SELECT task_id, generation, from_lifecycle, to_lifecycle, staging_identity,
           execution_policy_digest, kernel_sha256, broker_tcb_digest, occurred_at
    FROM agent_runtime_containment_transitions
    WHERE task_id = ?
    ORDER BY generation ASC
  `).all(record.taskId) as AuditRow[];
  if (rows.length !== record.generation) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  let state = normalizeAgentRuntimeContainmentPublicState({
    schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
    taskId: record.taskId,
    kind: record.kind,
    lifecycle: 'reserved',
  });
  let previousOccurredAt = record.createdAt;
  let auditedStagingIdentity: string | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const audit = auditFromRow(rows[index]!);
    if (audit.taskId !== record.taskId || audit.generation !== index + 1) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    if (audit.executionPolicyDigest !== record.executionPolicyDigest
      || audit.kernelSha256 !== record.kernelSha256
      || audit.brokerTcbDigest !== record.brokerTcbDigest) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    if (index === 0) {
      if (audit.fromLifecycle !== null || audit.toLifecycle !== 'reserved'
        || audit.stagingIdentity !== null || audit.occurredAt !== record.createdAt) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
      }
      continue;
    }
    if (Date.parse(audit.occurredAt) < Date.parse(previousOccurredAt)) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    if (audit.fromLifecycle !== state.lifecycle) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    try {
      state = transitionAgentRuntimeContainment(state, audit.toLifecycle);
    } catch {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    if (audit.fromLifecycle === 'reserved' && audit.toLifecycle === 'staging-prepared') {
      if (auditedStagingIdentity !== null || audit.stagingIdentity === null) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
      }
      auditedStagingIdentity = audit.stagingIdentity;
    } else if (audit.stagingIdentity !== auditedStagingIdentity) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    previousOccurredAt = audit.occurredAt;
  }
  if (state.lifecycle !== record.lifecycle
    || auditedStagingIdentity !== record.stagingIdentity
    || rows.at(-1)?.occurred_at !== record.updatedAt) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
}

function validateAllRows(database: Database): void {
  const check = database.query('PRAGMA quick_check(1)').get() as Record<string, unknown> | null;
  if (!check || Object.values(check)[0] !== 'ok') {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const foreignKeyProblems = database.query('PRAGMA foreign_key_check').all();
  if (foreignKeyProblems.length !== 0) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  const rows = database.query(`SELECT ${CONTAINMENT_COLUMNS} FROM agent_runtime_containments`)
    .all() as ContainmentRow[];
  for (const row of rows) {
    const record = privateRecordFromRow(row);
    if (!record) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    validateAuditChain(database, record);
  }
  const transitionCount = database.query(`
    SELECT count(*) AS count FROM agent_runtime_containment_transitions
  `).get() as { count?: unknown } | null;
  const expectedCount = rows.reduce((sum, row) => sum + safeGeneration(row.generation, true), 0);
  if (transitionCount?.count !== expectedCount) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
}

function inspectSchema(database: Database): 'empty' | 'current' {
  const applicationId = database.query('PRAGMA application_id').get() as { application_id?: unknown };
  const userVersion = database.query('PRAGMA user_version').get() as { user_version?: unknown };
  const names = tableNames(database);
  const isEmpty = names.length === 0;
  if (isEmpty) {
    if (applicationId.application_id !== 0 || userVersion.user_version !== 0) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
    return 'empty';
  }
  if (typeof userVersion.user_version !== 'number'
    || !Number.isSafeInteger(userVersion.user_version)
    || typeof applicationId.application_id !== 'number'
    || !Number.isSafeInteger(applicationId.application_id)) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  if (applicationId.application_id !== APPLICATION_ID) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  if (userVersion.user_version > AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_FUTURE_SCHEMA');
  }
  const metaExists = names.includes('agent_runtime_containment_meta');
  if (!metaExists) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  const metaCount = database.query(`
    SELECT count(*) AS count FROM agent_runtime_containment_meta
  `).get() as { count?: unknown } | null;
  if (metaCount?.count !== 1) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  const meta = database.query(`
    SELECT schema_version FROM agent_runtime_containment_meta WHERE singleton = 1
  `).get() as { schema_version?: unknown } | null;
  const metaVersion = meta?.schema_version;
  if (typeof metaVersion === 'number'
    && metaVersion > AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_FUTURE_SCHEMA');
  }
  if (metaVersion !== AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION
    || userVersion.user_version !== AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
  validateSchemaShape(database);
  validateAllRows(database);
  return 'current';
}

function ensureSchema(database: Database): void {
  if (inspectSchema(database) === 'current') return;
  runImmediateTransaction(database, () => {
    createSchema(database);
    database.query(`
      INSERT INTO agent_runtime_containment_meta(singleton, schema_version) VALUES (1, ?)
    `).run(AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION);
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${AGENT_RUNTIME_CONTAINMENT_REGISTRY_SCHEMA_VERSION}`);
  });
  if (inspectSchema(database) !== 'current') {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
}

function recordsEqual(
  existing: Readonly<AgentRuntimeContainmentPrivateRecord>,
  normalized: ReturnType<typeof normalizeReservation>,
): boolean {
  return existing.taskId === normalized.taskId
    && existing.kind === normalized.kind
    && existing.containerName === normalized.containerName
    && existing.nonce === normalized.nonce
    && existing.imageReference === normalized.imageReference
    && existing.imageDigest === normalized.imageDigest
    && existing.executionPolicyDigest === normalized.executionPolicyDigest
    && existing.kernelSha256 === normalized.kernelSha256
    && existing.brokerTcbDigest === normalized.brokerTcbDigest
    && existing.privateStagingRoot === normalized.privateStagingRoot
    && existing.stagingPath === normalized.stagingPath
    && existing.baseTarget.targetId === normalized.baseTarget.targetId
    && existing.baseTarget.kind === normalized.baseTarget.kind
    && existing.baseTarget.canonicalPath === normalized.baseTarget.canonicalPath
    && existing.baseTarget.identity === normalized.baseTarget.identity
    && existing.baseTarget.gitCommit === normalized.baseTarget.gitCommit;
}

/** Explicitly selects the four-field browser-safe projection. */
export function containmentRegistryRecordToPublicState(
  record: AgentRuntimeContainmentPrivateRecord,
): Readonly<AgentRuntimeContainmentPublicState> {
  return normalizeAgentRuntimeContainmentPublicState({
    schemaVersion: AGENT_RUNTIME_CONTAINMENT_SCHEMA_VERSION,
    taskId: record.taskId,
    kind: record.kind,
    lifecycle: record.lifecycle,
  });
}

export class AgentRuntimeContainmentRegistry {
  private closed = false;

  constructor(
    private readonly database: Database,
    constructionToken: symbol,
    private readonly clock: () => string = nowIso,
  ) {
    if (constructionToken !== REGISTRY_CONSTRUCTION_TOKEN) {
      fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
    }
  }

  private assertOpen(): void {
    if (this.closed) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CLOSED');
  }

  private readByTaskId(taskIdValue: string): Readonly<AgentRuntimeContainmentPrivateRecord> | null {
    return privateRecordFromRow(this.database.query(`
      SELECT ${CONTAINMENT_COLUMNS}
      FROM agent_runtime_containments WHERE task_id = ?
    `).get(taskIdValue) as ContainmentRow | null);
  }

  reserveAppleContainer(
    input: ReserveAppleContainerContainmentInput,
  ): ReserveAgentRuntimeContainmentResult {
    this.assertOpen();
    const normalized = normalizeReservation(input);
    return guarded(() => runImmediateTransaction(this.database, () => {
      const existing = this.readByTaskId(normalized.taskId);
      if (existing) {
        if (!recordsEqual(existing, normalized)) {
          fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT');
        }
        validateAuditChain(this.database, existing);
        return Object.freeze({ duplicate: true, record: existing });
      }
      const colliding = this.database.query(`
        SELECT task_id FROM agent_runtime_containments
        WHERE container_name = ? OR nonce = ? OR staging_path = ?
        LIMIT 1
      `).get(
        normalized.containerName,
        normalized.nonce,
        normalized.stagingPath,
      );
      if (colliding) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT');
      const occurredAt = isoTimestamp(this.clock());
      this.database.query(`
        INSERT INTO agent_runtime_containments(
          task_id, kind, lifecycle, generation, container_name, nonce,
          image_reference, image_digest, execution_policy_digest, kernel_sha256,
          broker_tcb_digest, private_staging_root, staging_path,
          staging_identity, base_target_id, base_target_kind, base_target_path,
          base_target_identity, base_git_commit, created_at, updated_at
        ) VALUES (
          ?, ?, 'reserved', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        normalized.taskId,
        normalized.kind,
        normalized.containerName,
        normalized.nonce,
        normalized.imageReference,
        normalized.imageDigest,
        normalized.executionPolicyDigest,
        normalized.kernelSha256,
        normalized.brokerTcbDigest,
        normalized.privateStagingRoot,
        normalized.stagingPath,
        normalized.stagingIdentity,
        normalized.baseTarget.targetId,
        normalized.baseTarget.kind,
        normalized.baseTarget.canonicalPath,
        normalized.baseTarget.identity,
        normalized.baseTarget.gitCommit,
        occurredAt,
        occurredAt,
      );
      this.database.query(`
        INSERT INTO agent_runtime_containment_transitions(
          task_id, generation, from_lifecycle, to_lifecycle, staging_identity,
          execution_policy_digest, kernel_sha256, broker_tcb_digest, occurred_at
        ) VALUES (?, 1, NULL, 'reserved', NULL, ?, ?, ?, ?)
      `).run(
        normalized.taskId,
        normalized.executionPolicyDigest,
        normalized.kernelSha256,
        normalized.brokerTcbDigest,
        occurredAt,
      );
      const created = this.readByTaskId(normalized.taskId);
      if (!created) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
      validateAuditChain(this.database, created);
      return Object.freeze({ duplicate: false, record: created });
    }));
  }

  sealStaging(
    input: SealAgentRuntimeStagingInput,
  ): Readonly<AgentRuntimeContainmentPrivateRecord> {
    this.assertOpen();
    const raw = asObject(input);
    if (!hasExactKeys(raw, ['taskId', 'expectedGeneration', 'stagingIdentity'])) {
      return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
    }
    const normalizedTaskId = taskId(raw.taskId);
    const expectedGeneration = safeGeneration(raw.expectedGeneration);
    const stagingIdentity = digest(raw.stagingIdentity);
    return guarded(() => runImmediateTransaction(this.database, () => {
      const current = this.readByTaskId(normalizedTaskId);
      if (!current) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_TASK_NOT_FOUND');
      if (current.generation !== expectedGeneration
        || current.lifecycle !== 'reserved'
        || current.stagingIdentity !== null) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT');
      }
      const colliding = this.database.query(`
        SELECT task_id FROM agent_runtime_containments
        WHERE staging_identity = ? AND task_id != ?
        LIMIT 1
      `).get(stagingIdentity, normalizedTaskId);
      if (colliding) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_RESERVATION_CONFLICT');
      const nextGeneration = current.generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
      }
      const observedNow = isoTimestamp(this.clock());
      const occurredAt = Date.parse(observedNow) < Date.parse(current.updatedAt)
        ? current.updatedAt
        : observedNow;
      const changed = this.database.query(`
        UPDATE agent_runtime_containments
        SET lifecycle = 'staging-prepared', generation = ?,
            staging_identity = ?, updated_at = ?
        WHERE task_id = ? AND generation = ?
          AND lifecycle = 'reserved' AND staging_identity IS NULL
      `).run(
        nextGeneration,
        stagingIdentity,
        occurredAt,
        normalizedTaskId,
        expectedGeneration,
      ).changes;
      if (changed < 1) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT');
      const updated = this.readByTaskId(normalizedTaskId);
      if (!updated) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
      validateAuditChain(this.database, updated);
      return updated;
    }));
  }

  transition(
    input: TransitionAgentRuntimeContainmentInput,
  ): Readonly<AgentRuntimeContainmentPrivateRecord> {
    this.assertOpen();
    const raw = asObject(input);
    if (!hasExactKeys(raw, [
      'taskId', 'expectedGeneration', 'expectedLifecycle', 'nextLifecycle',
    ])) {
      return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_INVALID_ARGUMENT');
    }
    const normalizedTaskId = taskId(raw.taskId);
    const expectedGeneration = safeGeneration(raw.expectedGeneration);
    const expectedLifecycle = normalizeLifecycle(raw.expectedLifecycle);
    const nextLifecycle = normalizeLifecycle(raw.nextLifecycle);
    return guarded(() => runImmediateTransaction(this.database, () => {
      const current = this.readByTaskId(normalizedTaskId);
      if (!current) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_TASK_NOT_FOUND');
      if (current.generation !== expectedGeneration || current.lifecycle !== expectedLifecycle) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT');
      }
      if (current.lifecycle === 'reserved' && nextLifecycle === 'staging-prepared') {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_TRANSITION_INVALID');
      }
      try {
        transitionAgentRuntimeContainment(
          containmentRegistryRecordToPublicState(current),
          nextLifecycle,
        );
      } catch {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_TRANSITION_INVALID');
      }
      if (current.stagingIdentity === null
        && STAGING_IDENTITY_REQUIRED_LIFECYCLES.includes(
          nextLifecycle as typeof STAGING_IDENTITY_REQUIRED_LIFECYCLES[number],
        )) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_TRANSITION_INVALID');
      }
      const nextGeneration = current.generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
      }
      const observedNow = isoTimestamp(this.clock());
      const occurredAt = Date.parse(observedNow) < Date.parse(current.updatedAt)
        ? current.updatedAt
        : observedNow;
      const changed = this.database.query(`
        UPDATE agent_runtime_containments
        SET lifecycle = ?, generation = ?, updated_at = ?
        WHERE task_id = ? AND generation = ? AND lifecycle = ?
      `).run(
        nextLifecycle,
        nextGeneration,
        occurredAt,
        normalizedTaskId,
        expectedGeneration,
        expectedLifecycle,
      ).changes;
      // Bun/SQLite can include the AFTER UPDATE audit-trigger insert in this
      // count. Zero is the only impossible result for the exact PK+generation
      // predicate; BEGIN IMMEDIATE serializes competing registry writers.
      if (changed < 1) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAS_CONFLICT');
      const updated = this.readByTaskId(normalizedTaskId);
      if (!updated) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
      validateAuditChain(this.database, updated);
      return updated;
    }));
  }

  get(taskIdInput: string): Readonly<AgentRuntimeContainmentPrivateRecord> | null {
    this.assertOpen();
    const normalizedTaskId = taskId(taskIdInput);
    return guarded(() => {
      const record = this.readByTaskId(normalizedTaskId);
      if (record) validateAuditChain(this.database, record);
      return record;
    });
  }

  getPublicState(taskIdInput: string): Readonly<AgentRuntimeContainmentPublicState> | null {
    const record = this.get(taskIdInput);
    return record ? containmentRegistryRecordToPublicState(record) : null;
  }

  /** Every non-disposed row needs startup reconciliation; none are pruned. */
  listIncomplete(
    limitInput: number = AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_LIST,
  ): Readonly<AgentRuntimeContainmentPrivateRecord>[] {
    this.assertOpen();
    const limit = boundedLimit(
      limitInput,
      AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_LIST,
      AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_LIST,
    );
    return guarded(() => {
      const rows = this.database.query(`
        SELECT ${CONTAINMENT_COLUMNS}
        FROM agent_runtime_containments
        WHERE lifecycle != 'disposed'
        ORDER BY created_at ASC, task_id ASC
        LIMIT ?
      `).all(limit + 1) as ContainmentRow[];
      // This is a startup safety inventory, not a UI page. Returning a prefix
      // could leave an unobserved VM alive after restart, so overflow is an
      // explicit fail-closed host condition.
      if (rows.length > limit) {
        fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CAPACITY_EXCEEDED');
      }
      return rows.map((row) => {
        const record = privateRecordFromRow(row);
        if (!record || !ACTIVE_LIFECYCLES.includes(record.lifecycle as typeof ACTIVE_LIFECYCLES[number])) {
          return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
        }
        validateAuditChain(this.database, record);
        return record;
      });
    });
  }

  /** Alias with explicit resource-ownership semantics for startup supervisors. */
  listActive(
    limitInput: number = AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_LIST,
  ): Readonly<AgentRuntimeContainmentPrivateRecord>[] {
    return this.listIncomplete(limitInput);
  }

  readAudit(
    taskIdInput: string,
    afterGenerationInput = 0,
    limitInput = AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_AUDIT_READ,
  ): Readonly<AgentRuntimeContainmentTransitionAudit>[] {
    this.assertOpen();
    const normalizedTaskId = taskId(taskIdInput);
    const afterGeneration = safeAfterGeneration(afterGenerationInput);
    const limit = boundedLimit(
      limitInput,
      AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_AUDIT_READ,
      AGENT_RUNTIME_CONTAINMENT_REGISTRY_MAX_AUDIT_READ,
    );
    return guarded(() => {
      const record = this.readByTaskId(normalizedTaskId);
      if (!record) fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_TASK_NOT_FOUND');
      validateAuditChain(this.database, record);
      const rows = this.database.query(`
        SELECT task_id, generation, from_lifecycle, to_lifecycle, staging_identity,
               execution_policy_digest, kernel_sha256, broker_tcb_digest, occurred_at
        FROM agent_runtime_containment_transitions
        WHERE task_id = ? AND generation > ?
        ORDER BY generation ASC
        LIMIT ?
      `).all(normalizedTaskId, afterGeneration, limit) as AuditRow[];
      return rows.map(auditFromRow);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

export interface OpenAgentRuntimeContainmentRegistryOptions {
  /** Test-only deterministic clock; production callers omit this. */
  readonly clock?: () => string;
}

function preflightExistingDatabase(path: string): void {
  // Inspecting recovery artifacts can roll back/checkpoint the main file; even
  // read-only WAL inspection mutates shared-memory read marks. Refuse every
  // unexpected journal without opening any artifact.
  if (existsSync(`${path}-journal`)
    || existsSync(`${path}-wal`)
    || existsSync(`${path}-shm`)) {
    fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY');
  }
  let database: Database | null = null;
  try {
    database = new Database(path, { readonly: true });
    database.exec(`
      PRAGMA query_only = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 3000;
    `);
    inspectSchema(database);
  } catch (error) {
    if (error instanceof AgentRuntimeContainmentRegistryError) throw error;
    const code = sqliteErrorCode(error);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY');
    }
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  } finally {
    database?.close();
  }
}

export function openAgentRuntimeContainmentRegistry(
  path: string,
  options: OpenAgentRuntimeContainmentRegistryOptions = {},
): AgentRuntimeContainmentRegistry {
  prepareDatabasePath(path);
  // Reject old, future, and corrupt persisted schemas through a read-only
  // handle before journal-mode changes, chmod, recovery, or any other write.
  if (path !== ':memory:' && (
    lstatSync(path).size > 0
    || existsSync(`${path}-journal`)
    || existsSync(`${path}-wal`)
    || existsSync(`${path}-shm`)
  )) {
    preflightExistingDatabase(path);
  }
  let database: Database | null = null;
  try {
    database = new Database(path, { create: true });
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 3000;
      PRAGMA trusted_schema = OFF;
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
    `);
    applyPrivateDatabasePermissions(path);
    ensureSchema(database);
    return new AgentRuntimeContainmentRegistry(
      database,
      REGISTRY_CONSTRUCTION_TOKEN,
      options.clock ?? nowIso,
    );
  } catch (error) {
    database?.close();
    if (error instanceof AgentRuntimeContainmentRegistryError) throw error;
    const code = sqliteErrorCode(error);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_BUSY');
    }
    return fail('AGENT_RUNTIME_CONTAINMENT_REGISTRY_CORRUPT');
  }
}
