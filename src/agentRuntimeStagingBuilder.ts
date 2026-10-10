import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  AgentRuntimeStagingObserverError,
  buildAgentRuntimeStagingResult,
  observeAgentRuntimeStagingTree,
  type AgentRuntimeStagingTreeSnapshot,
} from './agentRuntimeStagingObserver';
import {
  AGENT_RUNTIME_STAGING_MAX_ENTRIES,
  AGENT_RUNTIME_STAGING_MAX_FILE_BYTES,
  AGENT_RUNTIME_STAGING_MAX_PATH_BYTES,
  AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH,
  AGENT_RUNTIME_STAGING_MAX_SEGMENT_BYTES,
  AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES,
} from './agentRuntimeStagingResult';

/**
 * Host-private, command-free materialization of one immutable Git tree into a
 * disposable Agent Runtime staging directory.
 *
 * Trust boundary: the caller is responsible for obtaining `manifest` and
 * `readBlob` from one already-verified immutable Git commit. This module does
 * not run Git or accept a repository path. It independently verifies every
 * streamed blob against its Git object id and creates only regular files.
 *
 * Control-path policy is deterministic omission. A tracked entry is omitted
 * when any component is `.git`, `.agent-memory`, `.agents`, `.claude`,
 * `.codex`, starts with `.agentstoz`, or is AGENTS.md/CLAUDE.md (portable
 * case/NFKC comparison). Metadata, path safety and collision checks still
 * apply to omitted entries, but their blob bytes are never requested. This
 * stricter all-depth policy matches the staging observer and prevents an
 * instruction or credential file from becoming guest-writable.
 *
 * Node/Bun does not expose openat(2) on macOS. The builder therefore requires
 * an owner-only root, creates a fresh direct child, uses O_EXCL|O_NOFOLLOW,
 * pins file handles, revalidates identities, and invokes the double-scan
 * staging observer. A hostile same-UID host process can still race pathname
 * ancestors; the returned identity is valid at observation time and must be
 * revalidated immediately before a mount. No actual project/worktree path is
 * ever read or written here.
 */

export const AGENT_RUNTIME_GIT_TREE_MANIFEST_VERSION = 'agentstoz-git-tree-manifest-v1' as const;
export const AGENT_RUNTIME_STAGING_BUILD_REQUEST_VERSION = 'agentstoz-staging-build-request-v1' as const;
export const AGENT_RUNTIME_STAGING_BUILD_RESULT_VERSION = 'agentstoz-staging-build-result-v1' as const;
export const AGENT_RUNTIME_STAGING_PROTECTED_OMISSION_POLICY = 'agentstoz-protected-omit-v1' as const;
export const AGENT_RUNTIME_STAGING_BUILDER_DEFAULT_TIMEOUT_MS = 30_000;
export const AGENT_RUNTIME_STAGING_BUILDER_MAX_TIMEOUT_MS = 60_000;
export const AGENT_RUNTIME_STAGING_BUILDER_MAX_ROOT_BYTES = 4_096;
export const AGENT_RUNTIME_STAGING_BUILDER_MAX_BLOB_CHUNK_BYTES = 64 * 1024;
export const AGENT_RUNTIME_STAGING_BUILDER_MAX_BLOB_CHUNKS = 262_144;

export type AgentRuntimeGitFileMode = '100644' | '100755';

export interface AgentRuntimeGitTreeManifestEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: AgentRuntimeGitFileMode;
  readonly sizeBytes: number;
}

export interface AgentRuntimeGitTreeManifest {
  readonly version: typeof AGENT_RUNTIME_GIT_TREE_MANIFEST_VERSION;
  readonly commit: string;
  readonly entries: readonly Readonly<AgentRuntimeGitTreeManifestEntry>[];
}

export interface AgentRuntimeStagingBuildRequest {
  readonly version: typeof AGENT_RUNTIME_STAGING_BUILD_REQUEST_VERSION;
  /** Existing owner-only, canonical app-private directory. */
  readonly privateStagingRoot: string;
  /** Fresh direct child of privateStagingRoot. */
  readonly stagingPath: string;
  readonly manifest: AgentRuntimeGitTreeManifest;
}

export interface AgentRuntimeStagingBlobRequest {
  readonly commit: string;
  readonly oid: string;
  readonly sizeBytes: number;
}

export type AgentRuntimeStagingBlobStream =
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

export type AgentRuntimeStagingBlobSource = (
  request: Readonly<AgentRuntimeStagingBlobRequest>,
) => AgentRuntimeStagingBlobStream | Promise<AgentRuntimeStagingBlobStream>;

export interface AgentRuntimeStagingBuilderOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AgentRuntimeStagingBuildResult {
  readonly version: typeof AGENT_RUNTIME_STAGING_BUILD_RESULT_VERSION;
  readonly gitCommit: string;
  readonly omissionPolicy: typeof AGENT_RUNTIME_STAGING_PROTECTED_OMISSION_POLICY;
  /** Unique host-private SHA-256 binding the path/inode to this snapshot. */
  readonly stagingIdentity: string;
  /** Deterministic SHA-256 over the commit plus exact observed tree content. */
  readonly snapshotIdentity: string;
  readonly includedEntryCount: number;
  readonly omittedProtectedEntryCount: number;
  readonly totalFileBytes: number;
  /** A successful staging directory also remains an explicitly owned resource. */
  readonly cleanupRequired: true;
  /** Host-private baseline for later task-result comparison; not enumerable. */
  readonly baselineSnapshot: AgentRuntimeStagingTreeSnapshot;
}

export type AgentRuntimeStagingBuilderErrorCode =
  | 'AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST'
  | 'AGENT_RUNTIME_STAGING_BUILDER_SCHEMA_UNSUPPORTED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_INVALID_MANIFEST'
  | 'AGENT_RUNTIME_STAGING_BUILDER_INVALID_ENTRY'
  | 'AGENT_RUNTIME_STAGING_BUILDER_INVALID_GIT_OID'
  | 'AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_PATH'
  | 'AGENT_RUNTIME_STAGING_BUILDER_PATH_LIMIT_EXCEEDED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_PATH_COLLISION'
  | 'AGENT_RUNTIME_STAGING_BUILDER_PATH_SHAPE_COLLISION'
  | 'AGENT_RUNTIME_STAGING_BUILDER_ENTRY_LIMIT_EXCEEDED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_FILE_SIZE_LIMIT_EXCEEDED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_TOTAL_SIZE_LIMIT_EXCEEDED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_PLATFORM_UNSUPPORTED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_STAGING_ROOT'
  | 'AGENT_RUNTIME_STAGING_BUILDER_STAGING_PATH_NOT_FRESH'
  | 'AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_BLOB_SOURCE_FAILED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID'
  | 'AGENT_RUNTIME_STAGING_BUILDER_BLOB_SIZE_MISMATCH'
  | 'AGENT_RUNTIME_STAGING_BUILDER_BLOB_OID_MISMATCH'
  | 'AGENT_RUNTIME_STAGING_BUILDER_FILESYSTEM_OPERATION_FAILED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_OBSERVER_REJECTED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_ABORTED'
  | 'AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT';

export class AgentRuntimeStagingBuilderError extends Error {
  constructor(
    readonly code: AgentRuntimeStagingBuilderErrorCode,
    readonly cleanupRequired = false,
  ) {
    // Never reflect a path, OID, blob-source message, or filesystem diagnostic.
    super(code);
    this.name = 'AgentRuntimeStagingBuilderError';
  }
}

type JsonObject = Record<string, unknown>;

interface NormalizedPath {
  readonly path: string;
  readonly components: readonly string[];
  readonly portableKey: string;
  readonly protected: boolean;
}

interface NormalizedEntry extends AgentRuntimeGitTreeManifestEntry {
  readonly pathInfo: NormalizedPath;
}

interface NormalizedManifestInternal {
  readonly manifest: Readonly<AgentRuntimeGitTreeManifest>;
  readonly entries: readonly Readonly<NormalizedEntry>[];
  readonly objectAlgorithm: 'sha1' | 'sha256';
}

interface BuildContext {
  readonly signal?: AbortSignal;
  readonly deadline: number;
}

interface DirectoryIdentity {
  readonly deviceId: bigint;
  readonly inode: bigint;
  readonly userId: bigint;
  readonly mode: number;
}

interface WrittenEntry {
  readonly entry: Readonly<NormalizedEntry>;
  readonly sha256: string;
}

const utf8 = new TextEncoder();
const GIT_SHA1_RE = /^[a-f0-9]{40}$/;
const GIT_SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_SAFE_INPUT_CHARS = 8_192;
const MAX_TASK_COMPONENT_BYTES = 255;

function fail(
  code: AgentRuntimeStagingBuilderErrorCode,
  cleanupRequired = false,
): never {
  throw new AgentRuntimeStagingBuilderError(code, cleanupRequired);
}

function asObject(
  value: unknown,
  code: AgentRuntimeStagingBuilderErrorCode,
): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(code);
  }
  return value as JsonObject;
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function portablePathKey(value: string): string {
  return value.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
}

function isProtectedComponent(value: string): boolean {
  const key = portablePathKey(value);
  return key === '.git'
    || key === '.agent-memory'
    || key === '.agents'
    || key === '.claude'
    || key === '.codex'
    || key.startsWith('.agentstoz')
    || key === 'agents.md'
    || key === 'claude.md';
}

function normalizeManifestPath(value: unknown): NormalizedPath {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_PATH');
  }
  if (value.length > AGENT_RUNTIME_STAGING_MAX_PATH_BYTES) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_LIMIT_EXCEEDED');
  }
  if (value.includes('\0')
    || /[\u0001-\u001f\u007f-\u009f]/u.test(value)
    || containsUnpairedSurrogate(value)
    || value.startsWith('/')
    || value.includes('\\')
    || /^[A-Za-z]:/u.test(value)
    || value !== value.normalize('NFC')) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_PATH');
  }
  if (utf8.encode(value).byteLength > AGENT_RUNTIME_STAGING_MAX_PATH_BYTES) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_LIMIT_EXCEEDED');
  }

  const components = value.split('/');
  if (components.length > AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_LIMIT_EXCEEDED');
  }
  let protectedPath = false;
  for (const component of components) {
    const compatibility = component.normalize('NFKC');
    if (!component
      || component === '.'
      || component === '..'
      || component.trim() !== component
      || component.endsWith('.')
      || component.includes(':')
      || compatibility === '.'
      || compatibility === '..'
      || compatibility.includes('/')
      || compatibility.includes('\\')
      || compatibility.includes(':')) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_PATH');
    }
    if (utf8.encode(component).byteLength > AGENT_RUNTIME_STAGING_MAX_SEGMENT_BYTES) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_LIMIT_EXCEEDED');
    }
    protectedPath ||= isProtectedComponent(component);
  }

  return Object.freeze({
    path: value,
    components: Object.freeze(components),
    portableKey: portablePathKey(value),
    protected: protectedPath,
  });
}

function normalizeGitOid(value: unknown, length: 40 | 64): string {
  const valid = length === 40 ? GIT_SHA1_RE : GIT_SHA256_RE;
  if (typeof value !== 'string' || !valid.test(value) || /^0+$/u.test(value)) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_GIT_OID');
  }
  return value;
}

function normalizeManifestInternal(
  value: unknown,
  checkpoint?: () => void,
): NormalizedManifestInternal {
  const raw = asObject(value, 'AGENT_RUNTIME_STAGING_BUILDER_INVALID_MANIFEST');
  if (raw.version !== AGENT_RUNTIME_GIT_TREE_MANIFEST_VERSION) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_SCHEMA_UNSUPPORTED');
  }
  if (!hasExactKeys(raw, ['version', 'commit', 'entries']) || !Array.isArray(raw.entries)) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_MANIFEST');
  }
  if (raw.entries.length > AGENT_RUNTIME_STAGING_MAX_ENTRIES) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_ENTRY_LIMIT_EXCEEDED');
  }

  const commitLength = typeof raw.commit === 'string' && GIT_SHA1_RE.test(raw.commit)
    ? 40
    : typeof raw.commit === 'string' && GIT_SHA256_RE.test(raw.commit)
      ? 64
      : null;
  if (commitLength === null || /^0+$/u.test(raw.commit as string)) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_GIT_OID');
  }

  const entries: NormalizedEntry[] = [];
  const exactPaths = new Set<string>();
  const portablePrefixes = new Map<string, string>();
  const fullPortableKeys = new Set<string>();
  let totalBytes = 0;

  for (const candidate of raw.entries) {
    checkpoint?.();
    const entry = asObject(candidate, 'AGENT_RUNTIME_STAGING_BUILDER_INVALID_ENTRY');
    if (!hasExactKeys(entry, ['path', 'oid', 'mode', 'sizeBytes'])
      || (entry.mode !== '100644' && entry.mode !== '100755')
      || typeof entry.sizeBytes !== 'number'
      || !Number.isSafeInteger(entry.sizeBytes)
      || entry.sizeBytes < 0) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_ENTRY');
    }
    if (entry.sizeBytes > AGENT_RUNTIME_STAGING_MAX_FILE_BYTES) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_FILE_SIZE_LIMIT_EXCEEDED');
    }
    if (totalBytes > AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES - entry.sizeBytes) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_TOTAL_SIZE_LIMIT_EXCEEDED');
    }
    totalBytes += entry.sizeBytes;

    const pathInfo = normalizeManifestPath(entry.path);
    const oid = normalizeGitOid(entry.oid, commitLength);
    if (exactPaths.has(pathInfo.path)) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_COLLISION');
    }
    exactPaths.add(pathInfo.path);

    for (let depth = 1; depth <= pathInfo.components.length; depth += 1) {
      const prefix = pathInfo.components.slice(0, depth).join('/');
      const key = portablePathKey(prefix);
      const prior = portablePrefixes.get(key);
      if (prior !== undefined && prior !== prefix) {
        return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_COLLISION');
      }
      portablePrefixes.set(key, prefix);
    }
    if (fullPortableKeys.has(pathInfo.portableKey)) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_COLLISION');
    }
    fullPortableKeys.add(pathInfo.portableKey);
    entries.push(Object.freeze({
      path: pathInfo.path,
      oid,
      mode: entry.mode,
      sizeBytes: entry.sizeBytes,
      pathInfo,
    }));
  }

  for (const entry of entries) {
    for (let depth = 1; depth < entry.pathInfo.components.length; depth += 1) {
      const parentKey = portablePathKey(entry.pathInfo.components.slice(0, depth).join('/'));
      if (fullPortableKeys.has(parentKey)) {
        return fail('AGENT_RUNTIME_STAGING_BUILDER_PATH_SHAPE_COLLISION');
      }
    }
  }

  // UTF-16 code-unit order is runtime/locale independent after NFC validation.
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const publicEntries = Object.freeze(entries.map((entry) => Object.freeze({
    path: entry.path,
    oid: entry.oid,
    mode: entry.mode,
    sizeBytes: entry.sizeBytes,
  })));
  const manifest = Object.freeze({
    version: AGENT_RUNTIME_GIT_TREE_MANIFEST_VERSION,
    commit: raw.commit as string,
    entries: publicEntries,
  });
  return Object.freeze({
    manifest,
    entries: Object.freeze(entries),
    objectAlgorithm: commitLength === 40 ? 'sha1' : 'sha256',
  });
}

/** Pure exact-schema validation; returned entries are path-sorted and frozen. */
export function normalizeAgentRuntimeGitTreeManifest(
  value: unknown,
): Readonly<AgentRuntimeGitTreeManifest> {
  return normalizeManifestInternal(value).manifest;
}

function createContext(options: AgentRuntimeStagingBuilderOptions): BuildContext {
  const timeoutMs = options.timeoutMs ?? AGENT_RUNTIME_STAGING_BUILDER_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs)
    || timeoutMs < 0
    || timeoutMs > AGENT_RUNTIME_STAGING_BUILDER_MAX_TIMEOUT_MS) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT');
  }
  return {
    signal: options.signal,
    deadline: performance.now() + timeoutMs,
  };
}

function checkpoint(context: BuildContext): void {
  if (context.signal?.aborted) fail('AGENT_RUNTIME_STAGING_BUILDER_ABORTED');
  if (performance.now() >= context.deadline) fail('AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT');
}

async function boundedAwait<T>(operation: PromiseLike<T>, context: BuildContext): Promise<T> {
  checkpoint(context);
  const remaining = Math.max(0, context.deadline - performance.now());
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => rejectPromise(
      new AgentRuntimeStagingBuilderError('AGENT_RUNTIME_STAGING_BUILDER_ABORTED'),
    ));
    const timer = setTimeout(() => finish(() => rejectPromise(
      new AgentRuntimeStagingBuilderError('AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT'),
    )), remaining);
    context.signal?.addEventListener('abort', onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
    Promise.resolve(operation).then(
      (value) => {
        if (context.signal?.aborted) {
          finish(() => rejectPromise(
            new AgentRuntimeStagingBuilderError('AGENT_RUNTIME_STAGING_BUILDER_ABORTED'),
          ));
        } else if (performance.now() >= context.deadline) {
          finish(() => rejectPromise(
            new AgentRuntimeStagingBuilderError('AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT'),
          ));
        } else {
          finish(() => resolvePromise(value));
        }
      },
      (error) => finish(() => rejectPromise(error)),
    );
  });
}

function normalizeBuildRequest(
  value: unknown,
  context: BuildContext,
): {
  readonly privateStagingRoot: string;
  readonly stagingPath: string;
  readonly manifest: NormalizedManifestInternal;
} {
  const raw = asObject(value, 'AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST');
  if (raw.version !== AGENT_RUNTIME_STAGING_BUILD_REQUEST_VERSION) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_SCHEMA_UNSUPPORTED');
  }
  if (!hasExactKeys(raw, ['version', 'privateStagingRoot', 'stagingPath', 'manifest'])) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST');
  }
  for (const path of [raw.privateStagingRoot, raw.stagingPath]) {
    if (typeof path !== 'string'
      || path.length === 0
      || path.length > MAX_SAFE_INPUT_CHARS
      || Buffer.byteLength(path, 'utf8') > AGENT_RUNTIME_STAGING_BUILDER_MAX_ROOT_BYTES
      || path.includes('\0')
      || /[\u0001-\u001f\u007f-\u009f]/u.test(path)
      || containsUnpairedSurrogate(path)
      || path !== path.normalize('NFC')
      || !isAbsolute(path)
      || normalize(path) !== path
      || resolve(path) !== path
      || parse(path).root === path) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST');
    }
  }
  const privateStagingRoot = raw.privateStagingRoot as string;
  const stagingPath = raw.stagingPath as string;
  const taskRelative = relative(privateStagingRoot, stagingPath);
  if (privateStagingRoot === sep
    || taskRelative === ''
    || taskRelative === '..'
    || taskRelative.startsWith(`..${sep}`)
    || isAbsolute(taskRelative)
    || dirname(stagingPath) !== privateStagingRoot
    || Buffer.byteLength(taskRelative, 'utf8') > MAX_TASK_COMPONENT_BYTES) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST');
  }
  checkpoint(context);
  return {
    privateStagingRoot,
    stagingPath,
    manifest: normalizeManifestInternal(raw.manifest, () => checkpoint(context)),
  };
}

function permissionBits(stat: BigIntStats): number {
  return Number(stat.mode & 0o777n);
}

function directoryIdentity(stat: BigIntStats): DirectoryIdentity {
  return {
    deviceId: stat.dev,
    inode: stat.ino,
    userId: stat.uid,
    mode: permissionBits(stat),
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.deviceId === right.deviceId
    && left.inode === right.inode
    && left.userId === right.userId
    && left.mode === right.mode;
}

async function inspectPrivateDirectory(
  path: string,
  expectedUserId: bigint,
  context: BuildContext,
): Promise<DirectoryIdentity> {
  const stat = await boundedAwait(lstat(path, { bigint: true }), context);
  if (stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.uid !== expectedUserId
    || permissionBits(stat) !== 0o700) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_STAGING_ROOT');
  }
  const resolved = await boundedAwait(realpath(path), context);
  if (resolved !== path) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_STAGING_ROOT');
  }
  return directoryIdentity(stat);
}

async function assertDirectoryUnchanged(
  path: string,
  expected: DirectoryIdentity,
  context: BuildContext,
): Promise<void> {
  const actual = await inspectPrivateDirectory(path, expected.userId, context);
  if (!sameDirectoryIdentity(expected, actual)) {
    fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED');
  }
}

async function assertPathAbsent(path: string, context: BuildContext): Promise<void> {
  checkpoint(context);
  try {
    await boundedAwait(lstat(path, { bigint: true }), context);
    fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_PATH_NOT_FRESH');
  } catch (error) {
    if (error instanceof AgentRuntimeStagingBuilderError) throw error;
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

function uniqueIncludedDirectories(entries: readonly Readonly<NormalizedEntry>[]): string[] {
  const directories = new Set<string>();
  for (const entry of entries) {
    if (entry.pathInfo.protected) continue;
    for (let depth = 1; depth < entry.pathInfo.components.length; depth += 1) {
      directories.add(entry.pathInfo.components.slice(0, depth).join('/'));
    }
  }
  return [...directories].sort((left, right) => {
    const depthDifference = left.split('/').length - right.split('/').length;
    return depthDifference || (left < right ? -1 : left > right ? 1 : 0);
  });
}

function asyncIteratorFor(
  value: unknown,
): AsyncIterator<Uint8Array> | Iterator<Uint8Array> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID');
  }
  const asyncFactory = (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator];
  if (typeof asyncFactory === 'function') {
    const iterator = asyncFactory.call(value) as AsyncIterator<Uint8Array>;
    if (iterator === null || typeof iterator !== 'object' || typeof iterator.next !== 'function') {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID');
    }
    return iterator;
  }
  const syncFactory = (value as Iterable<Uint8Array>)[Symbol.iterator];
  if (typeof syncFactory === 'function') {
    const iterator = syncFactory.call(value) as Iterator<Uint8Array>;
    if (iterator === null || typeof iterator !== 'object' || typeof iterator.next !== 'function') {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID');
    }
    return iterator;
  }
  return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID');
}

async function closeIterator(
  iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array>,
  context: BuildContext,
): Promise<void> {
  if (typeof iterator.return !== 'function') return;
  try {
    await boundedAwait(Promise.resolve().then(() => iterator.return!()), context);
  } catch {
    // The primary fail-closed error wins. The source has no project path or
    // file handle and cannot continue writes after this builder closes it.
  }
}

async function closeFileHandleBestEffort(
  handle: FileHandle,
  context: BuildContext,
): Promise<void> {
  try {
    // Start close even when the deadline has just elapsed, but never let an
    // unresponsive close extend the builder's wall-clock contract.
    const closing = handle.close();
    try {
      await boundedAwait(closing, context);
    } catch {
      void closing.catch(() => undefined);
    }
  } catch {
    // The original validation/materialization failure remains authoritative.
  }
}

async function writeChunkFully(
  handle: FileHandle,
  chunk: Uint8Array,
  context: BuildContext,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    checkpoint(context);
    const result = await boundedAwait(
      handle.write(chunk, offset, chunk.byteLength - offset, null),
      context,
    );
    if (!Number.isSafeInteger(result.bytesWritten)
      || result.bytesWritten <= 0
      || result.bytesWritten > chunk.byteLength - offset) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_FILESYSTEM_OPERATION_FAILED');
    }
    offset += result.bytesWritten;
  }
}

async function materializeOneFile(
  root: string,
  entry: Readonly<NormalizedEntry>,
  gitCommit: string,
  objectAlgorithm: 'sha1' | 'sha256',
  readBlob: AgentRuntimeStagingBlobSource,
  expectedUserId: bigint,
  context: BuildContext,
): Promise<WrittenEntry> {
  const absolutePath = join(root, ...entry.pathInfo.components);
  const expectedMode = entry.mode === '100755' ? 0o700 : 0o600;
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    return fail('AGENT_RUNTIME_STAGING_BUILDER_PLATFORM_UNSUPPORTED');
  }

  let handle: FileHandle | undefined;
  try {
    handle = await boundedAwait(open(
      absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      expectedMode,
    ), context);
    await boundedAwait(handle.chmod(expectedMode), context);

    const blobRequest = Object.freeze({
      commit: gitCommit,
      oid: entry.oid,
      sizeBytes: entry.sizeBytes,
    });
    let source: AgentRuntimeStagingBlobStream;
    try {
      source = await boundedAwait(Promise.resolve().then(() => readBlob(blobRequest)), context);
    } catch (error) {
      if (error instanceof AgentRuntimeStagingBuilderError) throw error;
      return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_SOURCE_FAILED');
    }

    const iterator = await boundedAwait(
      Promise.resolve().then(() => asyncIteratorFor(source)),
      context,
    );
    const gitHash = createHash(objectAlgorithm);
    gitHash.update(`blob ${entry.sizeBytes}\0`, 'utf8');
    const sha256 = createHash('sha256');
    let observedBytes = 0;
    let observedChunks = 0;
    let completed = false;
    try {
      while (!completed) {
        checkpoint(context);
        let next: IteratorResult<Uint8Array>;
        try {
          next = await boundedAwait(Promise.resolve().then(() => iterator.next()), context);
        } catch (error) {
          if (error instanceof AgentRuntimeStagingBuilderError) throw error;
          return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_SOURCE_FAILED');
        }
        if (next === null || typeof next !== 'object' || typeof next.done !== 'boolean') {
          return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID');
        }
        if (next.done) {
          completed = true;
          break;
        }
        const chunk = next.value;
        observedChunks += 1;
        if (!(chunk instanceof Uint8Array)
          || chunk.byteLength === 0
          || chunk.byteLength > AGENT_RUNTIME_STAGING_BUILDER_MAX_BLOB_CHUNK_BYTES
          || observedChunks > AGENT_RUNTIME_STAGING_BUILDER_MAX_BLOB_CHUNKS) {
          return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID');
        }
        if (observedBytes > entry.sizeBytes - chunk.byteLength) {
          return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_SIZE_MISMATCH');
        }
        gitHash.update(chunk);
        sha256.update(chunk);
        await writeChunkFully(handle, chunk, context);
        observedBytes += chunk.byteLength;
      }
    } finally {
      if (!completed) await closeIterator(iterator, context);
    }

    if (observedBytes !== entry.sizeBytes) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_SIZE_MISMATCH');
    }
    if (gitHash.digest('hex') !== entry.oid) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_BLOB_OID_MISMATCH');
    }
    await boundedAwait(handle.sync(), context);
    const pinned = await boundedAwait(handle.stat({ bigint: true }), context);
    if (!pinned.isFile()
      || pinned.isSymbolicLink()
      || pinned.uid !== expectedUserId
      || pinned.nlink !== 1n
      || pinned.size !== BigInt(entry.sizeBytes)
      || permissionBits(pinned) !== expectedMode) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED');
    }
    const rawSha256 = sha256.digest('hex');
    await boundedAwait(handle.close(), context);
    handle = undefined;

    const named = await boundedAwait(lstat(absolutePath, { bigint: true }), context);
    if (!named.isFile()
      || named.isSymbolicLink()
      || named.dev !== pinned.dev
      || named.ino !== pinned.ino
      || named.uid !== expectedUserId
      || named.nlink !== 1n
      || named.size !== BigInt(entry.sizeBytes)
      || permissionBits(named) !== expectedMode
      || await boundedAwait(realpath(absolutePath), context) !== absolutePath) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED');
    }
    return Object.freeze({ entry, sha256: rawSha256 });
  } catch (error) {
    if (error instanceof AgentRuntimeStagingBuilderError) throw error;
    return fail('AGENT_RUNTIME_STAGING_BUILDER_FILESYSTEM_OPERATION_FAILED');
  } finally {
    if (handle !== undefined) await closeFileHandleBestEffort(handle, context);
  }
}

function snapshotIdentity(
  gitCommit: string,
  entries: readonly WrittenEntry[],
): string {
  const hash = createHash('sha256');
  hash.update(`${AGENT_RUNTIME_STAGING_BUILD_RESULT_VERSION}\0`, 'utf8');
  hash.update(`${AGENT_RUNTIME_STAGING_PROTECTED_OMISSION_POLICY}\0`, 'utf8');
  hash.update(`${gitCommit.length}:${gitCommit}\0`, 'utf8');
  for (const { entry, sha256 } of entries) {
    hash.update(`${Buffer.byteLength(entry.path, 'utf8')}:${entry.path}\0`, 'utf8');
    hash.update(`${entry.mode}\0${entry.sizeBytes}\0${sha256}\0`, 'utf8');
  }
  return hash.digest('hex');
}

function stagingResourceIdentity(
  stagingPath: string,
  identity: DirectoryIdentity,
  observedSnapshotIdentity: string,
): string {
  const hash = createHash('sha256');
  hash.update('agentstoz-staging-resource-v1\0', 'utf8');
  hash.update(`${Buffer.byteLength(stagingPath, 'utf8')}:${stagingPath}\0`, 'utf8');
  hash.update(`${identity.deviceId}:${identity.inode}:${identity.userId}:${identity.mode}\0`, 'utf8');
  hash.update(observedSnapshotIdentity, 'ascii');
  return hash.digest('hex');
}

function failFromObserver(error: unknown): never {
  if (error instanceof AgentRuntimeStagingObserverError) {
    if (error.code === 'OBSERVATION_ABORTED') {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_ABORTED');
    }
    if (error.code === 'OBSERVATION_TIMED_OUT') {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT');
    }
  }
  return fail('AGENT_RUNTIME_STAGING_BUILDER_OBSERVER_REJECTED');
}

function resultWithPrivateSnapshot(
  fields: Omit<AgentRuntimeStagingBuildResult, 'baselineSnapshot'>,
  baselineSnapshot: AgentRuntimeStagingTreeSnapshot,
): Readonly<AgentRuntimeStagingBuildResult> {
  const result = {} as AgentRuntimeStagingBuildResult;
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  Object.defineProperty(result, 'baselineSnapshot', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: baselineSnapshot,
  });
  return Object.freeze(result);
}

/**
 * Materialize one fresh staging tree. Any error after the atomic task-directory
 * creation attempt has `cleanupRequired=true`; callers must quarantine and
 * identity-check that path before deleting it. This function never removes a
 * partial tree because cleanup belongs to the durable containment lifecycle.
 */
export async function materializeAgentRuntimeStaging(
  requestValue: unknown,
  readBlob: AgentRuntimeStagingBlobSource,
  options: AgentRuntimeStagingBuilderOptions = {},
): Promise<Readonly<AgentRuntimeStagingBuildResult>> {
  const context = createContext(options);
  let cleanupRequired = false;
  try {
    if (typeof readBlob !== 'function') {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST');
    }
    const request = normalizeBuildRequest(requestValue, context);
    if (typeof process.geteuid !== 'function') {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_PLATFORM_UNSUPPORTED');
    }
    const expectedUserId = BigInt(process.geteuid());
    const privateRootIdentity = await inspectPrivateDirectory(
      request.privateStagingRoot,
      expectedUserId,
      context,
    );
    await assertPathAbsent(request.stagingPath, context);

    const included = request.manifest.entries.filter((entry) => !entry.pathInfo.protected);
    const omittedProtectedEntryCount = request.manifest.entries.length - included.length;
    const directories = uniqueIncludedDirectories(request.manifest.entries);
    if (directories.length + included.length > AGENT_RUNTIME_STAGING_MAX_ENTRIES) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_ENTRY_LIMIT_EXCEEDED');
    }

    // A timed-out mkdir may still complete in the kernel. Mark reconciliation
    // as required before starting the first operation that can create a path.
    cleanupRequired = true;
    await boundedAwait(mkdir(request.stagingPath, { mode: 0o700 }), context);
    await boundedAwait(chmod(request.stagingPath, 0o700), context);
    await assertDirectoryUnchanged(request.privateStagingRoot, privateRootIdentity, context);
    const taskRootIdentity = await inspectPrivateDirectory(
      request.stagingPath,
      expectedUserId,
      context,
    );

    let emptySnapshot: AgentRuntimeStagingTreeSnapshot;
    try {
      const remaining = Math.max(0, Math.floor(context.deadline - performance.now()));
      emptySnapshot = await boundedAwait(observeAgentRuntimeStagingTree(request.stagingPath, {
        timeoutMs: Math.min(remaining, AGENT_RUNTIME_STAGING_BUILDER_MAX_TIMEOUT_MS),
        signal: context.signal,
      }), context);
    } catch (error) {
      if (error instanceof AgentRuntimeStagingBuilderError) throw error;
      return failFromObserver(error);
    }

    const directoryIdentities = new Map<string, DirectoryIdentity>();
    directoryIdentities.set('', taskRootIdentity);
    for (const directory of directories) {
      checkpoint(context);
      const absolutePath = join(request.stagingPath, ...directory.split('/'));
      try {
        await boundedAwait(mkdir(absolutePath, { mode: 0o700 }), context);
        await boundedAwait(chmod(absolutePath, 0o700), context);
      } catch (error) {
        if (error instanceof AgentRuntimeStagingBuilderError) throw error;
        return fail('AGENT_RUNTIME_STAGING_BUILDER_FILESYSTEM_OPERATION_FAILED');
      }
      directoryIdentities.set(directory, await inspectPrivateDirectory(
        absolutePath,
        expectedUserId,
        context,
      ));
      await assertDirectoryUnchanged(request.stagingPath, taskRootIdentity, context);
    }

    const written: WrittenEntry[] = [];
    let totalFileBytes = 0;
    for (const entry of included) {
      checkpoint(context);
      const parentRelative = entry.pathInfo.components.slice(0, -1).join('/');
      const parentIdentity = directoryIdentities.get(parentRelative);
      if (parentIdentity === undefined) {
        return fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED');
      }
      const parentAbsolute = parentRelative
        ? join(request.stagingPath, ...parentRelative.split('/'))
        : request.stagingPath;
      await assertDirectoryUnchanged(parentAbsolute, parentIdentity, context);
      const completed = await materializeOneFile(
        request.stagingPath,
        entry,
        request.manifest.manifest.commit,
        request.manifest.objectAlgorithm,
        readBlob,
        expectedUserId,
        context,
      );
      written.push(completed);
      totalFileBytes += entry.sizeBytes;
      await assertDirectoryUnchanged(request.stagingPath, taskRootIdentity, context);
    }

    await assertDirectoryUnchanged(request.privateStagingRoot, privateRootIdentity, context);
    await assertDirectoryUnchanged(request.stagingPath, taskRootIdentity, context);
    let finalSnapshot: AgentRuntimeStagingTreeSnapshot;
    try {
      const remaining = Math.max(0, Math.floor(context.deadline - performance.now()));
      finalSnapshot = await boundedAwait(observeAgentRuntimeStagingTree(request.stagingPath, {
        timeoutMs: Math.min(remaining, AGENT_RUNTIME_STAGING_BUILDER_MAX_TIMEOUT_MS),
        signal: context.signal,
      }), context);
    } catch (error) {
      if (error instanceof AgentRuntimeStagingBuilderError) throw error;
      return failFromObserver(error);
    }

    let observed;
    try {
      observed = buildAgentRuntimeStagingResult(emptySnapshot, finalSnapshot);
    } catch {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_OBSERVER_REJECTED');
    }
    if (emptySnapshot.entryCount !== 0
      || emptySnapshot.totalFileBytes !== 0
      || finalSnapshot.entryCount !== directories.length + included.length
      || finalSnapshot.totalFileBytes !== totalFileBytes
      || observed.manifest.entries.length !== included.length
      || observed.trusted.writeCount !== included.length) {
      return fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED');
    }
    for (const completed of written) {
      const node = observed.trusted.getFinalNode(completed.entry.path);
      const expectedMode = completed.entry.mode === '100755' ? 0o700 : 0o600;
      if (node?.kind !== 'regular-file'
        || node.sha256 !== completed.sha256
        || node.sizeBytes !== completed.entry.sizeBytes
        || node.linkCount !== '1'
        || node.userId !== expectedUserId.toString(10)
        || (node.mode & 0o777) !== expectedMode) {
        return fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED');
      }
      const chain = observed.trusted.getFinalChain(completed.entry.path);
      if (chain.slice(0, -1).some((nodeInChain) => (
        nodeInChain.kind !== 'directory'
        || nodeInChain.userId !== expectedUserId.toString(10)
        || (nodeInChain.mode & 0o777) !== 0o700
      ))) {
        return fail('AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED');
      }
    }
    await assertDirectoryUnchanged(request.stagingPath, taskRootIdentity, context);

    const observedSnapshotIdentity = snapshotIdentity(
      request.manifest.manifest.commit,
      written,
    );
    return resultWithPrivateSnapshot({
      version: AGENT_RUNTIME_STAGING_BUILD_RESULT_VERSION,
      gitCommit: request.manifest.manifest.commit,
      omissionPolicy: AGENT_RUNTIME_STAGING_PROTECTED_OMISSION_POLICY,
      stagingIdentity: stagingResourceIdentity(
        request.stagingPath,
        taskRootIdentity,
        observedSnapshotIdentity,
      ),
      snapshotIdentity: observedSnapshotIdentity,
      includedEntryCount: included.length,
      omittedProtectedEntryCount,
      totalFileBytes,
      cleanupRequired: true,
    }, finalSnapshot);
  } catch (error) {
    if (error instanceof AgentRuntimeStagingBuilderError) {
      if (cleanupRequired && !error.cleanupRequired) {
        throw new AgentRuntimeStagingBuilderError(error.code, true);
      }
      throw error;
    }
    throw new AgentRuntimeStagingBuilderError(
      'AGENT_RUNTIME_STAGING_BUILDER_FILESYSTEM_OPERATION_FAILED',
      cleanupRequired,
    );
  }
}
