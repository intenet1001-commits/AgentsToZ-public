import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Host-private Apple Container command contract.
 *
 * This module is deliberately a pure planner/parser. It never executes a
 * command and its values (container name, nonce and staging path) must never be
 * copied into an Agent Runtime public DTO.
 */

export const APPLE_CONTAINER_EXECUTABLE = '/usr/local/bin/container' as const;
export const APPLE_CONTAINER_GUEST_STAGING_PATH = '/agentstoz/workspace' as const;
export const APPLE_CONTAINER_NONCE_LABEL = 'com.agentstoz.agent-runtime.nonce' as const;
export const APPLE_CONTAINER_RUNTIME_HANDLER = 'container-runtime-linux' as const;
/**
 * Future broker-owned, root-provisioned kernel path. No task may fall back to
 * Apple Container's mutable per-user default-kernel symlink/config.
 */
export const APPLE_CONTAINER_KERNEL_PATH =
  '/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/apple-container/1.3.1/vmlinux-6.18.35-197-debug' as const;
/** SHA-256 of Apple's configured Kata 3.32.0 arm64 source archive, not the extracted kernel. */
export const APPLE_CONTAINER_KERNEL_SOURCE_ARCHIVE_SHA256 =
  '8736c054d9223974735394f822000823baef509e1c33405ec798240fa9b6e4b5' as const;
/**
 * Apple Container 1.3.1 is built against Containerization 0.42.0. This is the
 * immutable linux/arm64 manifest for that release's vminit image, not its
 * mutable 0.42.0 tag or multi-platform index. Every task pins it explicitly so
 * a user config file cannot replace the VM's init filesystem.
 */
export const APPLE_CONTAINER_VMINIT_IMAGE =
  'ghcr.io/apple/containerization/vminit@sha256:71f6c228becbb32398ee44b8569249524722c2e11030f61cc7a5673695e5a422' as const;
export const APPLE_CONTAINER_MAX_OUTPUT_BYTES = 256 * 1024;
export const APPLE_CONTAINER_MAX_LIST_ENTRIES = 512;

export const APPLE_CONTAINER_NETWORK_POLICIES = Object.freeze(['none'] as const);
export type AppleContainerNetworkPolicy = typeof APPLE_CONTAINER_NETWORK_POLICIES[number];

export interface AppleContainerTaskIdentityInput {
  readonly taskId: string;
  /** A fresh, host-private, 32-byte lowercase hex nonce. */
  readonly nonce: string;
}

export interface AppleContainerCreatePlanInput extends AppleContainerTaskIdentityInput {
  /** A trusted app-data directory. It is never mounted itself. */
  readonly privateStagingRoot: string;
  /** The one task staging directory mounted read-write into the guest. */
  readonly stagingPath: string;
  /** Registry-qualified immutable OCI reference ending in @sha256:<64 lowercase hex>. */
  readonly image: string;
  readonly cpuCount?: number;
  readonly memoryMiB?: number;
  readonly networkPolicy?: AppleContainerNetworkPolicy;
}

export interface AppleContainerCleanupPlanInput extends AppleContainerTaskIdentityInput {
  readonly stopTimeoutSeconds?: number;
}

export interface AppleContainerImageDescriptorExpectation {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}

export type AppleContainerProcessUserExpectation =
  | Readonly<{ kind: 'raw'; userString: string }>
  | Readonly<{ kind: 'id'; uid: number; gid: number }>;

export interface AppleContainerProcessRlimitExpectation {
  readonly limit: string;
  readonly soft: number;
  readonly hard: number;
}

/**
 * Image qualification facts that are intentionally independent of argv.
 *
 * A digest-pinned image still controls its entrypoint, environment and user,
 * so an inspect proof is incomplete unless the exact qualified OCI config is
 * checked after `create` and before `start`.
 */
export interface AppleContainerInspectExpectation {
  readonly state: 'stopped' | 'running';
  readonly imageDescriptor: AppleContainerImageDescriptorExpectation;
  readonly initProcess: Readonly<{
    executable: string;
    arguments: readonly string[];
    environment: readonly string[];
    workingDirectory: typeof APPLE_CONTAINER_GUEST_STAGING_PATH;
    terminal: false;
    user: AppleContainerProcessUserExpectation;
    supplementalGroups: readonly number[];
    rlimits: readonly AppleContainerProcessRlimitExpectation[];
  }>;
}

/** An argv-only plan. Never pass argv through a shell or concatenate it. */
export interface AppleContainerCommandPlan {
  readonly executable: typeof APPLE_CONTAINER_EXECUTABLE;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type AppleContainerListProof = Readonly<{
  state: 'absent' | 'present-owned';
}>;

export type AppleContainerCommandPlanErrorCode =
  | 'APPLE_CONTAINER_PLAN_INVALID_INPUT'
  | 'APPLE_CONTAINER_OUTPUT_TOO_LARGE'
  | 'APPLE_CONTAINER_OUTPUT_INVALID'
  | 'APPLE_CONTAINER_IDENTITY_MISMATCH';

export class AppleContainerCommandPlanError extends Error {
  constructor(readonly code: AppleContainerCommandPlanErrorCode) {
    // Never echo host-private input in an exception that could reach a client.
    super(code);
    this.name = 'AppleContainerCommandPlanError';
  }
}

const TASK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const NONCE_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const REGISTRY_HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPOSITORY_SEGMENT_RE = /^[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)?$/;
const CONTAINER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/;
const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_CPU_COUNT = 2;
const MIN_CPU_COUNT = 1;
const MAX_CPU_COUNT = 8;
const DEFAULT_MEMORY_MIB = 4 * 1024;
const MIN_MEMORY_MIB = 512;
const MAX_MEMORY_MIB = 16 * 1024;
const DEFAULT_STOP_TIMEOUT_SECONDS = 5;
const MIN_STOP_TIMEOUT_SECONDS = 1;
const MAX_STOP_TIMEOUT_SECONDS = 30;
const MAX_HOST_PATH_BYTES = 4 * 1024;
const MAX_LABELS_PER_CONTAINER = 128;
const MAX_LABEL_VALUE_BYTES = 4 * 1024;

function fail(code: AppleContainerCommandPlanErrorCode): never {
  throw new AppleContainerCommandPlanError(code);
}

function assertIdentity(input: AppleContainerTaskIdentityInput): void {
  if (input === null
    || typeof input !== 'object'
    || !TASK_ID_RE.test(input.taskId)
    || !NONCE_RE.test(input.nonce)) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
}

/**
 * The OS resource name contains neither the task id nor nonce. Both values are
 * nevertheless cryptographically bound to the exact, DNS-safe name.
 */
export function deriveAppleContainerName(input: AppleContainerTaskIdentityInput): string {
  assertIdentity(input);
  const digest = createHash('sha256')
    .update('agentstoz-apple-container-v1\0', 'utf8')
    .update(input.taskId, 'utf8')
    .update('\0', 'utf8')
    .update(input.nonce, 'ascii')
    .digest('hex');
  const name = `agentstoz-ar-${digest.slice(0, 48)}`;
  if (!CONTAINER_ID_RE.test(name)) fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  return name;
}

function assertPinnedImage(image: string): void {
  if (typeof image !== 'string'
    || image.length > 512
    || image !== image.toLowerCase()
    || image.includes('://')) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  const parts = image.split('@');
  const imageName = parts[0];
  const imageDigest = parts[1];
  if (parts.length !== 2
    || imageName === undefined
    || imageDigest === undefined
    || !DIGEST_RE.test(imageDigest)) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  const nameParts = imageName.split('/');
  const registry = nameParts[0];
  // Requiring an explicit registry avoids an implicit, host-configurable
  // registry and rejects tag-only or local shorthand references.
  if (nameParts.length < 2
    || registry === undefined
    || !isExplicitRegistry(registry)
    || !nameParts.slice(1).every((part) => REPOSITORY_SEGMENT_RE.test(part))) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
}

function isExplicitRegistry(registry: string): boolean {
  const matchedPort = registry.match(/:([0-9]+)$/)?.[1];
  if (registry.includes(':') && matchedPort === undefined) return false;
  if (matchedPort !== undefined
    && (matchedPort.startsWith('0') || Number(matchedPort) > 65_535)) return false;
  const host = matchedPort === undefined
    ? registry
    : registry.slice(0, -(matchedPort.length + 1));
  if (host === 'localhost') return true;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((label) => REGISTRY_HOST_LABEL_RE.test(label));
}

function utf8Bytes(value: string): number {
  // The cheap UTF-16 bound avoids an unnecessary large allocation first.
  if (value.length > APPLE_CONTAINER_MAX_OUTPUT_BYTES) {
    return APPLE_CONTAINER_MAX_OUTPUT_BYTES + 1;
  }
  return new TextEncoder().encode(value).byteLength;
}

function assertPrivateStagingPath(privateRoot: string, stagingPath: string): void {
  for (const path of [privateRoot, stagingPath]) {
    if (typeof path !== 'string'
      || !isAbsolute(path)
      || resolve(path) !== path
      || path.normalize('NFC') !== path
      || path.includes('\0')
      || /[\r\n,]/.test(path)
      || utf8Bytes(path) > MAX_HOST_PATH_BYTES) {
      fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
    }
  }
  // A broad root can never establish that the supplied child is app-private.
  if (privateRoot === sep || stagingPath === privateRoot) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  const child = relative(privateRoot, stagingPath);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    return fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  return result;
}

function commandPlan(argv: readonly string[], timeoutMs: number): Readonly<AppleContainerCommandPlan> {
  return Object.freeze({
    executable: APPLE_CONTAINER_EXECUTABLE,
    argv: Object.freeze([...argv]),
    timeoutMs,
    maxOutputBytes: APPLE_CONTAINER_MAX_OUTPUT_BYTES,
  });
}

function mutationPlan(
  argv: readonly string[],
  timeoutMs: number,
): Readonly<AppleContainerCommandPlan> {
  // All command vocabulary is assembled inside this module. Callers cannot
  // inject an option, guest command, environment entry, port or shell token.
  if (argv.some((arg) => arg === '--all' || arg === '-a')) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  return commandPlan(argv, timeoutMs);
}

function createArgv(input: AppleContainerCreatePlanInput): readonly string[] {
  assertIdentity(input);
  assertPinnedImage(input.image);
  assertPrivateStagingPath(input.privateStagingRoot, input.stagingPath);
  const cpuCount = boundedInteger(input.cpuCount, DEFAULT_CPU_COUNT, MIN_CPU_COUNT, MAX_CPU_COUNT);
  const memoryMiB = boundedInteger(
    input.memoryMiB,
    DEFAULT_MEMORY_MIB,
    MIN_MEMORY_MIB,
    MAX_MEMORY_MIB,
  );
  const networkPolicy = input.networkPolicy ?? 'none';
  if (!APPLE_CONTAINER_NETWORK_POLICIES.includes(networkPolicy)) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  const containerName = deriveAppleContainerName(input);
  const argv = [
    'create',
    '--name', containerName,
    '--label', `${APPLE_CONTAINER_NONCE_LABEL}=${input.nonce}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--cpus', String(cpuCount),
    '--memory', `${memoryMiB}M`,
    '--network', networkPolicy,
    '--no-dns',
    '--mount',
    `type=bind,source=${input.stagingPath},target=${APPLE_CONTAINER_GUEST_STAGING_PATH}`,
    '--workdir', APPLE_CONTAINER_GUEST_STAGING_PATH,
    '--os', 'linux',
    '--arch', 'arm64',
    '--runtime', APPLE_CONTAINER_RUNTIME_HANDLER,
    '--init-image', APPLE_CONTAINER_VMINIT_IMAGE,
    '--kernel', APPLE_CONTAINER_KERNEL_PATH,
    '--scheme', 'https',
    // Do not use --init: it changes the workload process model. --init-image is
    // different: Apple Container always boots a VM init filesystem, so pin that
    // otherwise implicit TCB artifact independently of the workload image.
    input.image,
  ];
  return argv;
}

/** Creates a stopped resource with an exact durable identity. */
export function planAppleContainerCreate(
  input: AppleContainerCreatePlanInput,
): Readonly<AppleContainerCommandPlan> {
  return mutationPlan(createArgv(input), 2 * 60_000);
}

/** Starts only the exact identity created by this planner. */
export function planAppleContainerStart(
  input: AppleContainerTaskIdentityInput,
): Readonly<AppleContainerCommandPlan> {
  return mutationPlan(['start', deriveAppleContainerName(input)], 30_000);
}

/** Inspects only one exact identity; it never enumerates or selects a prefix. */
export function planAppleContainerInspect(
  input: AppleContainerTaskIdentityInput,
): Readonly<AppleContainerCommandPlan> {
  return commandPlan(['inspect', deriveAppleContainerName(input)], 30_000);
}

/**
 * The sole broad selector in this module is read-only and exact. Including
 * stopped resources is required before an absence proof may release a lease.
 */
export function planAppleContainerListAll(): Readonly<AppleContainerCommandPlan> {
  return commandPlan(['list', '--all', '--format', 'json'], 30_000);
}

/**
 * Exact cleanup sequence. The executor must continue through kill and delete
 * even if stop reports that the resource is already stopped.
 */
export function planAppleContainerCleanup(
  input: AppleContainerCleanupPlanInput,
): readonly Readonly<AppleContainerCommandPlan>[] {
  const name = deriveAppleContainerName(input);
  const timeout = boundedInteger(
    input.stopTimeoutSeconds,
    DEFAULT_STOP_TIMEOUT_SECONDS,
    MIN_STOP_TIMEOUT_SECONDS,
    MAX_STOP_TIMEOUT_SECONDS,
  );
  return Object.freeze([
    mutationPlan(
      ['stop', '--signal', 'SIGTERM', '--time', String(timeout), name],
      (timeout + 10) * 1_000,
    ),
    mutationPlan(['kill', '--signal', 'KILL', name], 30_000),
    mutationPlan(['delete', '--force', name], 30_000),
  ]);
}

type JsonObject = Record<string, unknown>;

interface ParsedContainerIdentity {
  readonly id: string;
  readonly nonce: string | null;
  readonly configuration: JsonObject;
  readonly status: JsonObject;
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('APPLE_CONTAINER_OUTPUT_INVALID');
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseContainerListJson(output: string): readonly ParsedContainerIdentity[] {
  if (typeof output !== 'string' || utf8Bytes(output) > APPLE_CONTAINER_MAX_OUTPUT_BYTES) {
    fail('APPLE_CONTAINER_OUTPUT_TOO_LARGE');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return fail('APPLE_CONTAINER_OUTPUT_INVALID');
  }
  if (!Array.isArray(decoded) || decoded.length > APPLE_CONTAINER_MAX_LIST_ENTRIES) {
    fail('APPLE_CONTAINER_OUTPUT_INVALID');
  }
  const seen = new Set<string>();
  return decoded.map((entry) => {
    const item = asObject(entry);
    // Apple Container 1.3.1 ManagedContainer has this exact top-level shape.
    if (!exactKeys(item, ['id', 'configuration', 'status'])
      || typeof item.id !== 'string'
      || !CONTAINER_ID_RE.test(item.id)) {
      return fail('APPLE_CONTAINER_OUTPUT_INVALID');
    }
    const configuration = asObject(item.configuration);
    const status = asObject(item.status);
    if (typeof configuration.id !== 'string'
      || configuration.id !== item.id
      || !Object.hasOwn(configuration, 'labels')
      || Object.keys(status).length > 64
      || Object.keys(configuration).length > 128
      || seen.has(item.id)) {
      return fail('APPLE_CONTAINER_OUTPUT_INVALID');
    }
    seen.add(item.id);
    const labels = asObject(configuration.labels);
    const labelEntries = Object.entries(labels);
    if (labelEntries.length > MAX_LABELS_PER_CONTAINER
      || labelEntries.some(([key, value]) => !LABEL_KEY_RE.test(key)
        || typeof value !== 'string'
        || utf8Bytes(value) > MAX_LABEL_VALUE_BYTES)) {
      return fail('APPLE_CONTAINER_OUTPUT_INVALID');
    }
    const nonce = labels[APPLE_CONTAINER_NONCE_LABEL];
    return Object.freeze({
      id: item.id,
      nonce: typeof nonce === 'string' ? nonce : null,
      configuration,
      status,
    });
  });
}

function isExactEmptyArray(value: unknown): value is readonly [] {
  return Array.isArray(value) && value.length === 0;
}

function isExactEmptyObject(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function exactStringArray(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => typeof value === 'string' && value === expected[index]);
}

function exactUint32Array(actual: unknown, expected: readonly number[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => Number.isSafeInteger(value)
      && value >= 0
      && value <= 0xffff_ffff
      && value === expected[index]);
}

function isIso8601Second(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isBoundedPlainString(value: unknown, maxBytes = MAX_LABEL_VALUE_BYTES): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.normalize('NFC') === value
    && !/[\u0000-\u001f\u007f]/.test(value)
    && utf8Bytes(value) <= maxBytes;
}

function expectedUserJson(user: AppleContainerProcessUserExpectation): JsonObject {
  if (user.kind === 'raw') {
    if (!isBoundedPlainString(user.userString)) fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
    return { raw: { userString: user.userString } };
  }
  if (user.kind !== 'id'
    || !Number.isSafeInteger(user.uid)
    || user.uid < 0
    || user.uid > 0xffff_ffff
    || !Number.isSafeInteger(user.gid)
    || user.gid < 0
    || user.gid > 0xffff_ffff) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  return { id: { uid: user.uid, gid: user.gid } };
}

function exactJson(actual: unknown, expected: unknown): boolean {
  if (actual === null || expected === null
    || typeof actual !== 'object' || typeof expected !== 'object') {
    return actual === expected;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual)
      && Array.isArray(expected)
      && actual.length === expected.length
      && actual.every((value, index) => exactJson(value, expected[index]));
  }
  const actualObject = actual as JsonObject;
  const expectedObject = expected as JsonObject;
  const expectedKeys = Object.keys(expectedObject);
  return exactKeys(actualObject, expectedKeys)
    && expectedKeys.every(key => exactJson(actualObject[key], expectedObject[key]));
}

function assertInspectExpectation(
  input: AppleContainerCreatePlanInput,
  expectation: AppleContainerInspectExpectation,
): void {
  if (expectation === null
    || typeof expectation !== 'object'
    || (expectation.state !== 'stopped' && expectation.state !== 'running')
    || expectation.imageDescriptor === null
    || typeof expectation.imageDescriptor !== 'object'
    || !isBoundedPlainString(expectation.imageDescriptor.mediaType, 256)
    || !DIGEST_RE.test(expectation.imageDescriptor.digest)
    || expectation.imageDescriptor.digest !== input.image.split('@')[1]
    || !Number.isSafeInteger(expectation.imageDescriptor.size)
    || expectation.imageDescriptor.size < 1
    || expectation.initProcess === null
    || typeof expectation.initProcess !== 'object'
    || !isBoundedPlainString(expectation.initProcess.executable)
    || !expectation.initProcess.executable.startsWith('/')
    || expectation.initProcess.workingDirectory !== APPLE_CONTAINER_GUEST_STAGING_PATH
    || expectation.initProcess.terminal !== false
    || !Array.isArray(expectation.initProcess.arguments)
    || expectation.initProcess.arguments.length > 256
    || !expectation.initProcess.arguments.every(value => isBoundedPlainString(value))
    || !Array.isArray(expectation.initProcess.environment)
    || expectation.initProcess.environment.length > 256
    || !expectation.initProcess.environment.every(value => isBoundedPlainString(value))
    || !Array.isArray(expectation.initProcess.supplementalGroups)
    || expectation.initProcess.supplementalGroups.length > 128
    || !expectation.initProcess.supplementalGroups.every(value => Number.isSafeInteger(value)
      && value >= 0
      && value <= 0xffff_ffff)
    || !Array.isArray(expectation.initProcess.rlimits)
    || expectation.initProcess.rlimits.length > 64
    || !expectation.initProcess.rlimits.every(value => value !== null
      && typeof value === 'object'
      && isBoundedPlainString(value.limit, 128)
      && Number.isSafeInteger(value.soft)
      && value.soft >= 0
      && Number.isSafeInteger(value.hard)
      && value.hard >= value.soft)) {
    fail('APPLE_CONTAINER_PLAN_INVALID_INPUT');
  }
  expectedUserJson(expectation.initProcess.user);
}

/** Copies and freezes an exact image/process qualification before it is used. */
export function normalizeAppleContainerInspectExpectation(
  input: AppleContainerCreatePlanInput,
  expectation: AppleContainerInspectExpectation,
): Readonly<AppleContainerInspectExpectation> {
  assertIdentity(input);
  assertPinnedImage(input.image);
  assertPrivateStagingPath(input.privateStagingRoot, input.stagingPath);
  assertInspectExpectation(input, expectation);
  const user = expectation.initProcess.user.kind === 'raw'
    ? Object.freeze({
      kind: 'raw' as const,
      userString: expectation.initProcess.user.userString,
    })
    : Object.freeze({
      kind: 'id' as const,
      uid: expectation.initProcess.user.uid,
      gid: expectation.initProcess.user.gid,
    });
  return Object.freeze({
    state: expectation.state,
    imageDescriptor: Object.freeze({
      mediaType: expectation.imageDescriptor.mediaType,
      digest: expectation.imageDescriptor.digest,
      size: expectation.imageDescriptor.size,
    }),
    initProcess: Object.freeze({
      executable: expectation.initProcess.executable,
      arguments: Object.freeze([...expectation.initProcess.arguments]),
      environment: Object.freeze([...expectation.initProcess.environment]),
      workingDirectory: APPLE_CONTAINER_GUEST_STAGING_PATH,
      terminal: false as const,
      user,
      supplementalGroups: Object.freeze([...expectation.initProcess.supplementalGroups]),
      rlimits: Object.freeze(expectation.initProcess.rlimits.map(value => Object.freeze({
        limit: value.limit,
        soft: value.soft,
        hard: value.hard,
      }))),
    }),
  });
}

function hasExpectedStatus(
  status: JsonObject,
  expectedState: AppleContainerInspectExpectation['state'],
): boolean {
  const expectedKeys = expectedState === 'running'
    ? ['state', 'networks', 'startedDate']
    : ['state', 'networks'];
  return exactKeys(status, expectedKeys)
    && status.state === expectedState
    && isExactEmptyArray(status.networks)
    && (expectedState === 'stopped' || isIso8601Second(status.startedDate));
}

function hasExpectedInspectConfiguration(
  resource: ParsedContainerIdentity,
  input: AppleContainerCreatePlanInput,
  expectation: AppleContainerInspectExpectation,
): boolean {
  const configuration = resource.configuration;
  const configurationKeys = [
    'id', 'image', 'mounts', 'publishedPorts', 'publishedSockets', 'labels',
    'sysctls', 'networks', 'rosetta', 'initProcess', 'platform', 'resources',
    'runtimeHandler', 'virtualization', 'ssh', 'readOnly', 'useInit',
    'capAdd', 'capDrop', 'creationDate',
  ] as const;
  const image = configuration.image;
  const mounts = configuration.mounts;
  const resources = configuration.resources;
  const platform = configuration.platform;
  const initProcess = configuration.initProcess;
  if (!exactKeys(configuration, configurationKeys)
    || image === null || typeof image !== 'object' || Array.isArray(image)
    || !exactKeys(image as JsonObject, ['reference', 'descriptor'])
    || (image as JsonObject).reference !== input.image
    || !Array.isArray(mounts)
    || mounts.length !== 1
    || resources === null || typeof resources !== 'object' || Array.isArray(resources)
    || platform === null || typeof platform !== 'object' || Array.isArray(platform)
    || initProcess === null || typeof initProcess !== 'object' || Array.isArray(initProcess)) {
    return false;
  }

  const imageObject = image as JsonObject;
  const descriptor = imageObject.descriptor;
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || !exactKeys(descriptor as JsonObject, ['mediaType', 'digest', 'size'])
    || (descriptor as JsonObject).mediaType !== expectation.imageDescriptor.mediaType
    || (descriptor as JsonObject).digest !== expectation.imageDescriptor.digest
    || (descriptor as JsonObject).size !== expectation.imageDescriptor.size) {
    return false;
  }

  const mount = mounts[0];
  if (mount === null || typeof mount !== 'object' || Array.isArray(mount)) return false;
  const mountObject = mount as JsonObject;
  const mountType = mountObject.type;
  if (!exactKeys(mountObject, ['type', 'source', 'destination', 'options'])
    || !isExactEmptyObject(
      mountType !== null
        && typeof mountType === 'object'
        && !Array.isArray(mountType)
        ? (mountType as JsonObject).virtiofs
        : null,
    )
    || !exactKeys(mountType as JsonObject, ['virtiofs'])
    || mountObject.source !== input.stagingPath
    || mountObject.destination !== APPLE_CONTAINER_GUEST_STAGING_PATH
    || !isExactEmptyArray(mountObject.options)) {
    return false;
  }

  const labels = configuration.labels;
  const expectedCpuCount = input.cpuCount ?? DEFAULT_CPU_COUNT;
  const expectedMemoryMiB = input.memoryMiB ?? DEFAULT_MEMORY_MIB;
  const resourceObject = resources as JsonObject;
  const platformObject = platform as JsonObject;
  const processObject = initProcess as JsonObject;
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)
    || !exactKeys(labels as JsonObject, [APPLE_CONTAINER_NONCE_LABEL])
    || (labels as JsonObject)[APPLE_CONTAINER_NONCE_LABEL] !== input.nonce
    || !exactKeys(resourceObject, ['cpus', 'memoryInBytes', 'cpuOverhead'])
    || resourceObject.cpus !== expectedCpuCount
    || resourceObject.memoryInBytes !== expectedMemoryMiB * 1024 * 1024
    || resourceObject.cpuOverhead !== 1
    || !exactKeys(platformObject, ['os', 'architecture'])
    || platformObject.os !== 'linux'
    || platformObject.architecture !== 'arm64'
    || !exactKeys(processObject, [
      'executable', 'arguments', 'environment', 'workingDirectory', 'terminal',
      'user', 'supplementalGroups', 'rlimits',
    ])
    || processObject.executable !== expectation.initProcess.executable
    || !exactStringArray(processObject.arguments, expectation.initProcess.arguments)
    || !exactStringArray(processObject.environment, expectation.initProcess.environment)
    || processObject.workingDirectory !== expectation.initProcess.workingDirectory
    || processObject.terminal !== expectation.initProcess.terminal
    || !exactJson(processObject.user, expectedUserJson(expectation.initProcess.user))
    || !exactUint32Array(
      processObject.supplementalGroups,
      expectation.initProcess.supplementalGroups,
    )
    || !Array.isArray(processObject.rlimits)
    || processObject.rlimits.length !== expectation.initProcess.rlimits.length
    || !processObject.rlimits.every((value, index) => {
      const expected = expectation.initProcess.rlimits[index];
      return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && expected !== undefined
        && exactKeys(value as JsonObject, ['limit', 'soft', 'hard'])
        && (value as JsonObject).limit === expected.limit
        && (value as JsonObject).soft === expected.soft
        && (value as JsonObject).hard === expected.hard;
    })
    || !isIso8601Second(configuration.creationDate)) {
    return false;
  }

  return configuration.runtimeHandler === APPLE_CONTAINER_RUNTIME_HANDLER
    && configuration.readOnly === true
    && configuration.rosetta === false
    && configuration.virtualization === false
    && configuration.ssh === false
    && configuration.useInit === false
    && isExactEmptyArray(configuration.capAdd)
    && Array.isArray(configuration.capDrop)
    && configuration.capDrop.length === 1
    && configuration.capDrop[0] === 'ALL'
    && isExactEmptyArray(configuration.publishedPorts)
    && isExactEmptyArray(configuration.publishedSockets)
    && isExactEmptyArray(configuration.networks)
    && isExactEmptyObject(configuration.sysctls)
    && hasExpectedStatus(resource.status, expectation.state);
}

function exactIdentityProof(
  resources: readonly ParsedContainerIdentity[],
  input: AppleContainerTaskIdentityInput,
): AppleContainerListProof {
  const expectedId = deriveAppleContainerName(input);
  const byId = resources.find((resource) => resource.id === expectedId);
  const byNonce = resources.find((resource) => resource.nonce === input.nonce);
  if (byId === undefined && byNonce === undefined) {
    return Object.freeze({ state: 'absent' });
  }
  if (byId?.nonce !== input.nonce || byNonce?.id !== expectedId) {
    return fail('APPLE_CONTAINER_IDENTITY_MISMATCH');
  }
  return Object.freeze({ state: 'present-owned' });
}

/**
 * Parses a complete (including stopped resources) Apple Container 1.3.1 JSON
 * list supplied by the trusted adapter. Absence means neither the exact derived
 * id nor its nonce label exists; prefix or task-id matches are never evidence.
 */
export function parseAppleContainerListProof(
  output: string,
  input: AppleContainerTaskIdentityInput,
): AppleContainerListProof {
  assertIdentity(input);
  return exactIdentityProof(parseContainerListJson(output), input);
}

/**
 * A successful exact inspect must return one matching resource and prove the
 * security-relevant Apple Container 1.3.1 configuration, not merely a label.
 * vminit is not exposed by `inspect`; its immutable reference is therefore
 * enforced by the planner/runner grammar and the separately qualified TCB.
 */
export function parseAppleContainerInspectProof(
  output: string,
  input: AppleContainerCreatePlanInput,
  expectation: AppleContainerInspectExpectation,
): Readonly<{ state: 'present-owned' }> {
  assertIdentity(input);
  assertPinnedImage(input.image);
  assertPrivateStagingPath(input.privateStagingRoot, input.stagingPath);
  const normalizedExpectation = normalizeAppleContainerInspectExpectation(input, expectation);
  const resources = parseContainerListJson(output);
  if (resources.length !== 1) fail('APPLE_CONTAINER_OUTPUT_INVALID');
  const proof = exactIdentityProof(resources, input);
  if (proof.state !== 'present-owned') fail('APPLE_CONTAINER_IDENTITY_MISMATCH');
  if (!hasExpectedInspectConfiguration(resources[0]!, input, normalizedExpectation)) {
    fail('APPLE_CONTAINER_IDENTITY_MISMATCH');
  }
  return Object.freeze({ state: 'present-owned' });
}
