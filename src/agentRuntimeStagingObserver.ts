import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  lstat,
  open,
  opendir,
  realpath,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  normalize,
  parse,
  resolve,
} from 'node:path';
import {
  AGENT_RUNTIME_STAGING_MAX_ENTRIES,
  AGENT_RUNTIME_STAGING_MAX_FILE_BYTES,
  AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES,
  AGENT_RUNTIME_STAGING_RESULT_VERSION,
  normalizeAgentRuntimeStagingPath,
  normalizeAgentRuntimeStagingResult,
  type AgentRuntimeStagingResult,
} from './agentRuntimeStagingResult';

/**
 * Trusted-host, read-only observation of a disposable Agent Runtime staging
 * tree.
 *
 * Security boundary: the caller must pass the one canonical, task-private
 * staging root only after the task VM has been stopped and its absence has
 * been proven. This module never follows a leaf symlink, opens regular files
 * with O_NOFOLLOW, pins directory/file handles while checking metadata, and
 * requires two identical complete scans.
 *
 * Node/Bun does not expose a portable openat(2)-style recursive walker on
 * macOS. Consequently an adversarial host process able to rename an ancestor
 * between pathname operations can still create an ABA race. Double scanning
 * and pinned-handle checks fail closed for observable races, but this observer
 * alone is not materialization authorization. The materializer must retain
 * exclusive ownership, re-open from the trusted root without following links,
 * and revalidate identity, type, link count, size, and SHA-256 at copy time.
 * This module never modifies the filesystem and never invokes a command.
 */

export const AGENT_RUNTIME_STAGING_OBSERVER_VERSION = 'agentstoz-staging-observer-v1' as const;
export const AGENT_RUNTIME_STAGING_OBSERVER_DEFAULT_TIMEOUT_MS = 15_000;
export const AGENT_RUNTIME_STAGING_OBSERVER_MAX_TIMEOUT_MS = 60_000;
export const AGENT_RUNTIME_STAGING_OBSERVER_MAX_ROOT_BYTES = 4_096;

const READ_CHUNK_BYTES = 64 * 1024;

export type AgentRuntimeStagingObserverErrorCode =
  | 'INVALID_ROOT'
  | 'ROOT_NOT_CANONICAL'
  | 'ROOT_IDENTITY_CHANGED'
  | 'PLATFORM_PRIMITIVE_UNAVAILABLE'
  | 'PROTECTED_PATH'
  | 'PATH_COLLISION'
  | 'UNSAFE_NODE_TYPE'
  | 'HARDLINK_AMBIGUOUS'
  | 'ENTRY_LIMIT_EXCEEDED'
  | 'FILE_SIZE_LIMIT_EXCEEDED'
  | 'TOTAL_SIZE_LIMIT_EXCEEDED'
  | 'OBSERVATION_ABORTED'
  | 'OBSERVATION_TIMED_OUT'
  | 'TREE_MUTATED_DURING_OBSERVATION'
  | 'FILESYSTEM_OBSERVATION_FAILED'
  | 'SNAPSHOT_INVALID'
  | 'SNAPSHOT_ROOT_MISMATCH'
  | 'UNSUPPORTED_TREE_SHAPE';

export class AgentRuntimeStagingObserverError extends Error {
  constructor(readonly code: AgentRuntimeStagingObserverErrorCode) {
    super(code);
    this.name = 'AgentRuntimeStagingObserverError';
  }
}

export interface AgentRuntimeStagingObserverOptions {
  /** A smaller timeout may be selected, but the fixed safety ceiling cannot be expanded. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AgentRuntimeStagingTrustedNodeMetadata {
  readonly path: string;
  readonly kind: 'directory' | 'regular-file';
  readonly deviceId: string;
  readonly inode: string;
  readonly mode: number;
  readonly userId: string;
  readonly groupId: string;
  readonly linkCount: string;
  readonly statSizeBytes: string;
  readonly modifiedTimeNs: string;
  readonly changedTimeNs: string;
  /** Present only for a bounded regular file. */
  readonly sizeBytes?: number;
  /** Present only for a bounded regular file. */
  readonly sha256?: string;
}

export interface AgentRuntimeStagingTreeSnapshot {
  readonly version: typeof AGENT_RUNTIME_STAGING_OBSERVER_VERSION;
  readonly entryCount: number;
  readonly totalFileBytes: number;
  /** Host-private snapshots must never be serialized across an app boundary. */
  toJSON(): never;
}

export interface AgentRuntimeStagingTrustedResult {
  readonly version: typeof AGENT_RUNTIME_STAGING_OBSERVER_VERSION;
  readonly canonicalRoot: string;
  readonly rootIdentity: Readonly<AgentRuntimeStagingTrustedNodeMetadata>;
  readonly writeCount: number;
  /** Returns a frozen copy of final-tree evidence for revalidation. */
  getFinalNode(path: string): Readonly<AgentRuntimeStagingTrustedNodeMetadata> | null;
  /** Returns base-tree evidence so a future target can be conflict-checked. */
  getBaseNode(path: string): Readonly<AgentRuntimeStagingTrustedNodeMetadata> | null;
  /** Root-first frozen directory evidence, followed by the final node itself. */
  getFinalChain(path: string): readonly Readonly<AgentRuntimeStagingTrustedNodeMetadata>[];
  /** Host-private evidence must never be serialized across an app boundary. */
  toJSON(): never;
}

export interface AgentRuntimeObservedStagingResult {
  readonly manifest: Readonly<AgentRuntimeStagingResult>;
  /**
   * Non-enumerable host-private evidence. JSON serialization of the enclosing
   * result contains only `manifest`; direct serialization of `trusted` fails.
   */
  readonly trusted: AgentRuntimeStagingTrustedResult;
}

interface NodeMetadata extends AgentRuntimeStagingTrustedNodeMetadata {
  readonly kind: 'directory' | 'regular-file';
}

interface ScanState {
  readonly canonicalRoot: string;
  readonly root: NodeMetadata;
  readonly nodes: ReadonlyMap<string, NodeMetadata>;
  readonly entryCount: number;
  readonly totalFileBytes: number;
}

interface ObservationContext {
  readonly signal?: AbortSignal;
  readonly startedAt: number;
  readonly timeoutMs: number;
}

const snapshotStates = new WeakMap<AgentRuntimeStagingTreeSnapshot, ScanState>();

function fail(code: AgentRuntimeStagingObserverErrorCode): never {
  throw new AgentRuntimeStagingObserverError(code);
}

function checkpoint(context: ObservationContext): void {
  if (context.signal?.aborted) fail('OBSERVATION_ABORTED');
  if (performance.now() - context.startedAt >= context.timeoutMs) {
    fail('OBSERVATION_TIMED_OUT');
  }
}

function portablePathKey(value: string): string {
  return value.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
}

function isAdditionalProtectedComponent(component: string): boolean {
  return portablePathKey(component).startsWith('.agentstoz');
}

function statMetadata(
  path: string,
  kind: NodeMetadata['kind'],
  stat: BigIntStats,
  sha256?: string,
): NodeMetadata {
  const sizeBytes = kind === 'regular-file' ? Number(stat.size) : undefined;
  return Object.freeze({
    path,
    kind,
    deviceId: stat.dev.toString(10),
    inode: stat.ino.toString(10),
    mode: Number(stat.mode),
    userId: stat.uid.toString(10),
    groupId: stat.gid.toString(10),
    linkCount: stat.nlink.toString(10),
    statSizeBytes: stat.size.toString(10),
    modifiedTimeNs: stat.mtimeNs.toString(10),
    changedTimeNs: stat.ctimeNs.toString(10),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(sha256 === undefined ? {} : { sha256 }),
  });
}

function sameNodeMetadata(left: NodeMetadata, right: NodeMetadata): boolean {
  return left.path === right.path
    && left.kind === right.kind
    && left.deviceId === right.deviceId
    && left.inode === right.inode
    && left.mode === right.mode
    && left.userId === right.userId
    && left.groupId === right.groupId
    && left.linkCount === right.linkCount
    && left.statSizeBytes === right.statSizeBytes
    && left.modifiedTimeNs === right.modifiedTimeNs
    && left.changedTimeNs === right.changedTimeNs
    && left.sizeBytes === right.sizeBytes
    && left.sha256 === right.sha256;
}

function sameIdentityAndMetadata(left: NodeMetadata, right: NodeMetadata): boolean {
  return sameNodeMetadata(left, right);
}

function ensureSafeNodeType(stat: BigIntStats): NodeMetadata['kind'] {
  if (stat.isSymbolicLink()) fail('UNSAFE_NODE_TYPE');
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'regular-file';
  // Includes sockets, FIFOs, block devices, and character devices.
  return fail('UNSAFE_NODE_TYPE');
}

function assertRegularFileBounds(stat: BigIntStats): number {
  if (stat.nlink !== 1n) fail('HARDLINK_AMBIGUOUS');
  if (stat.size < 0n || stat.size > BigInt(AGENT_RUNTIME_STAGING_MAX_FILE_BYTES)) {
    fail('FILE_SIZE_LIMIT_EXCEEDED');
  }
  return Number(stat.size);
}

async function safeLstat(path: string, context: ObservationContext): Promise<BigIntStats> {
  checkpoint(context);
  const stat = await lstat(path, { bigint: true });
  checkpoint(context);
  return stat;
}

async function assertRealPath(path: string, context: ObservationContext): Promise<void> {
  checkpoint(context);
  const observed = await realpath(path);
  checkpoint(context);
  if (observed !== path) fail('TREE_MUTATED_DURING_OBSERVATION');
}

async function listDirectoryNamesBounded(
  path: string,
  context: ObservationContext,
  maxNames: number,
): Promise<string[]> {
  checkpoint(context);
  // Streaming iteration prevents an oversized directory from being allocated
  // as one unbounded readdir result. Node returns Buffer names for this
  // encoding; current Bun releases may still return strings.
  const directory = await opendir(path, {
    // Supported by Node and Bun at runtime although Node's opendir type omits
    // the buffer sentinel that its readdir type exposes.
    encoding: 'buffer' as unknown as BufferEncoding,
    bufferSize: 32,
  });
  const names: string[] = [];
  try {
    for await (const rawEntry of directory) {
      checkpoint(context);
      // Bun 1.3 yields the encoded name directly here, while Node yields a
      // Dirent whose `name` has the selected encoding. Support both without
      // trusting the Dirent's advisory file-type bits.
      const candidate = rawEntry as unknown;
      const rawName = (typeof candidate === 'string' || ArrayBuffer.isView(candidate))
        ? candidate
        : (candidate as { name?: unknown })?.name;
      let name: string;
      if (typeof rawName === 'string') {
        if (rawName.includes('\ufffd')) fail('UNSAFE_NODE_TYPE');
        name = rawName;
      } else if (ArrayBuffer.isView(rawName)) {
        const bytes = Buffer.from(new Uint8Array(
          rawName.buffer,
          rawName.byteOffset,
          rawName.byteLength,
        ));
        name = bytes.toString('utf8');
        if (!Buffer.from(name, 'utf8').equals(bytes)) fail('UNSAFE_NODE_TYPE');
      } else {
        return fail('UNSAFE_NODE_TYPE');
      }
      names.push(name);
      if (names.length > maxNames) {
        fail('ENTRY_LIMIT_EXCEEDED');
      }
    }
  } finally {
    try {
      // Node returns a Promise; Bun may synchronously return void once the
      // async iterator has auto-closed the directory.
      await directory.close();
    } catch {
      // Already-closed is expected after normal async iteration. Observation
      // errors still propagate from the try block.
    }
  }
  checkpoint(context);
  names.sort();
  return names;
}

async function openPinned(
  path: string,
  flags: number,
  context: ObservationContext,
): Promise<FileHandle> {
  checkpoint(context);
  const handle = await open(path, flags);
  try {
    checkpoint(context);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function pinnedStat(
  handle: FileHandle,
  context: ObservationContext,
): Promise<BigIntStats> {
  checkpoint(context);
  const stat = await handle.stat({ bigint: true });
  checkpoint(context);
  return stat;
}

async function hashRegularFile(
  absolutePath: string,
  relativePath: string,
  initialStat: BigIntStats,
  context: ObservationContext,
): Promise<NodeMetadata> {
  const expectedSize = assertRegularFileBounds(initialStat);
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') fail('PLATFORM_PRIMITIVE_UNAVAILABLE');

  let handle: FileHandle | undefined;
  try {
    handle = await openPinned(absolutePath, constants.O_RDONLY | noFollow, context);
    const openedBefore = await pinnedStat(handle, context);
    if (ensureSafeNodeType(openedBefore) !== 'regular-file') fail('UNSAFE_NODE_TYPE');
    assertRegularFileBounds(openedBefore);

    const expected = statMetadata(relativePath, 'regular-file', initialStat);
    const pinnedBefore = statMetadata(relativePath, 'regular-file', openedBefore);
    if (!sameIdentityAndMetadata(expected, pinnedBefore)) {
      fail('TREE_MUTATED_DURING_OBSERVATION');
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, expectedSize)));
    let offset = 0;
    while (offset < expectedSize) {
      checkpoint(context);
      const length = Math.min(buffer.byteLength, expectedSize - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      checkpoint(context);
      if (bytesRead <= 0 || bytesRead > length) fail('TREE_MUTATED_DURING_OBSERVATION');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    // A bounded one-byte read catches growth before the metadata re-check.
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await handle.read(extra, 0, 1, expectedSize);
    checkpoint(context);
    if (extraRead.bytesRead !== 0) fail('TREE_MUTATED_DURING_OBSERVATION');

    const openedAfter = await pinnedStat(handle, context);
    const pathAfter = await safeLstat(absolutePath, context);
    if (ensureSafeNodeType(pathAfter) !== 'regular-file') fail('UNSAFE_NODE_TYPE');
    assertRegularFileBounds(pathAfter);
    const pinnedAfter = statMetadata(relativePath, 'regular-file', openedAfter);
    const namedAfter = statMetadata(relativePath, 'regular-file', pathAfter);
    if (!sameIdentityAndMetadata(expected, pinnedAfter)
      || !sameIdentityAndMetadata(expected, namedAfter)) {
      fail('TREE_MUTATED_DURING_OBSERVATION');
    }

    return statMetadata(relativePath, 'regular-file', openedAfter, hash.digest('hex'));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function scanTreeOnce(
  canonicalRoot: string,
  context: ObservationContext,
): Promise<ScanState> {
  const nodes = new Map<string, NodeMetadata>();
  const portablePaths = new Map<string, string>();
  let entryCount = 0;
  let totalFileBytes = 0;

  const scanDirectory = async (
    absolutePath: string,
    relativePath: string,
    expectedStat?: BigIntStats,
  ): Promise<NodeMetadata> => {
    checkpoint(context);
    const before = await safeLstat(absolutePath, context);
    if (ensureSafeNodeType(before) !== 'directory') fail('UNSAFE_NODE_TYPE');
    const beforeMetadata = statMetadata(relativePath, 'directory', before);
    if (expectedStat !== undefined) {
      const expected = statMetadata(relativePath, 'directory', expectedStat);
      if (!sameIdentityAndMetadata(expected, beforeMetadata)) {
        fail('TREE_MUTATED_DURING_OBSERVATION');
      }
    }
    await assertRealPath(absolutePath, context);

    const noFollow = constants.O_NOFOLLOW;
    const directoryOnly = constants.O_DIRECTORY;
    if (typeof noFollow !== 'number' || typeof directoryOnly !== 'number') {
      fail('PLATFORM_PRIMITIVE_UNAVAILABLE');
    }
    const handle = await openPinned(
      absolutePath,
      constants.O_RDONLY | noFollow | directoryOnly,
      context,
    );
    try {
      const pinnedBefore = await pinnedStat(handle, context);
      const pinnedMetadata = statMetadata(relativePath, 'directory', pinnedBefore);
      if (ensureSafeNodeType(pinnedBefore) !== 'directory'
        || !sameIdentityAndMetadata(beforeMetadata, pinnedMetadata)) {
        fail('TREE_MUTATED_DURING_OBSERVATION');
      }

      const namesBefore = await listDirectoryNamesBounded(
        absolutePath,
        context,
        AGENT_RUNTIME_STAGING_MAX_ENTRIES - entryCount,
      );
      // Reserve the full directory listing before recursion. Otherwise every
      // recursive frame could retain another maximum-sized sibling list before
      // the global node limit was reached.
      entryCount += namesBefore.length;
      for (const name of namesBefore) {
        checkpoint(context);
        const childRelativePath = relativePath ? `${relativePath}/${name}` : name;

        // Path policy and protected components are checked before lstat/open or
        // descending into the child.
        const normalized = normalizeAgentRuntimeStagingPath(childRelativePath);
        if (normalized.path !== childRelativePath || isAdditionalProtectedComponent(name)) {
          fail('PROTECTED_PATH');
        }
        const portableKey = portablePathKey(childRelativePath);
        const priorSpelling = portablePaths.get(portableKey);
        if (priorSpelling !== undefined && priorSpelling !== childRelativePath) {
          fail('PATH_COLLISION');
        }
        portablePaths.set(portableKey, childRelativePath);

        const childAbsolutePath = join(absolutePath, name);
        const childStat = await safeLstat(childAbsolutePath, context);
        const kind = ensureSafeNodeType(childStat);
        let metadata: NodeMetadata;
        if (kind === 'directory') {
          metadata = await scanDirectory(childAbsolutePath, childRelativePath, childStat);
        } else {
          const sizeBytes = assertRegularFileBounds(childStat);
          if (totalFileBytes > AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES - sizeBytes) {
            fail('TOTAL_SIZE_LIMIT_EXCEEDED');
          }
          totalFileBytes += sizeBytes;
          await assertRealPath(childAbsolutePath, context);
          metadata = await hashRegularFile(
            childAbsolutePath,
            childRelativePath,
            childStat,
            context,
          );
        }
        nodes.set(childRelativePath, metadata);
      }

      const namesAfter = await listDirectoryNamesBounded(
        absolutePath,
        context,
        Math.min(AGENT_RUNTIME_STAGING_MAX_ENTRIES, namesBefore.length + 1),
      );
      if (namesBefore.length !== namesAfter.length
        || namesBefore.some((name, index) => name !== namesAfter[index])) {
        fail('TREE_MUTATED_DURING_OBSERVATION');
      }
      const pinnedAfter = await pinnedStat(handle, context);
      const pathAfter = await safeLstat(absolutePath, context);
      if (ensureSafeNodeType(pinnedAfter) !== 'directory'
        || ensureSafeNodeType(pathAfter) !== 'directory'
        || !sameIdentityAndMetadata(
          beforeMetadata,
          statMetadata(relativePath, 'directory', pinnedAfter),
        )
        || !sameIdentityAndMetadata(
          beforeMetadata,
          statMetadata(relativePath, 'directory', pathAfter),
        )) {
        fail('TREE_MUTATED_DURING_OBSERVATION');
      }
      await assertRealPath(absolutePath, context);
      return beforeMetadata;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const root = await scanDirectory(canonicalRoot, '');
  return Object.freeze({
    canonicalRoot,
    root,
    nodes,
    entryCount,
    totalFileBytes,
  });
}

function sameScan(left: ScanState, right: ScanState): boolean {
  if (left.canonicalRoot !== right.canonicalRoot
    || left.entryCount !== right.entryCount
    || left.totalFileBytes !== right.totalFileBytes
    || !sameNodeMetadata(left.root, right.root)
    || left.nodes.size !== right.nodes.size) {
    return false;
  }
  for (const [path, leftNode] of left.nodes) {
    const rightNode = right.nodes.get(path);
    if (rightNode === undefined || !sameNodeMetadata(leftNode, rightNode)) return false;
  }
  return true;
}

function createSnapshot(state: ScanState): AgentRuntimeStagingTreeSnapshot {
  const snapshot: AgentRuntimeStagingTreeSnapshot = Object.freeze({
    version: AGENT_RUNTIME_STAGING_OBSERVER_VERSION,
    entryCount: state.entryCount,
    totalFileBytes: state.totalFileBytes,
    toJSON(): never {
      throw new AgentRuntimeStagingObserverError('SNAPSHOT_INVALID');
    },
  });
  snapshotStates.set(snapshot, state);
  return snapshot;
}

function snapshotState(snapshot: AgentRuntimeStagingTreeSnapshot): ScanState {
  return snapshotStates.get(snapshot) ?? fail('SNAPSHOT_INVALID');
}

function validateCanonicalRoot(root: unknown): asserts root is string {
  if (typeof root !== 'string'
    || root.length === 0
    || root.length > AGENT_RUNTIME_STAGING_OBSERVER_MAX_ROOT_BYTES
    || Buffer.byteLength(root, 'utf8') > AGENT_RUNTIME_STAGING_OBSERVER_MAX_ROOT_BYTES
    || root.includes('\0')
    || /[\u0001-\u001f\u007f-\u009f]/u.test(root)
    || !isAbsolute(root)
    || normalize(root) !== root
    || resolve(root) !== root
    || parse(root).root === root) {
    fail('ROOT_NOT_CANONICAL');
  }
}

function observationContext(options: AgentRuntimeStagingObserverOptions): ObservationContext {
  const timeoutMs = options.timeoutMs ?? AGENT_RUNTIME_STAGING_OBSERVER_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs)
    || timeoutMs < 0
    || timeoutMs > AGENT_RUNTIME_STAGING_OBSERVER_MAX_TIMEOUT_MS) {
    fail('OBSERVATION_TIMED_OUT');
  }
  return {
    signal: options.signal,
    startedAt: performance.now(),
    timeoutMs,
  };
}

/**
 * Produce a host-private snapshot only after two complete scans agree.
 */
export async function observeAgentRuntimeStagingTree(
  canonicalRoot: string,
  options: AgentRuntimeStagingObserverOptions = {},
): Promise<AgentRuntimeStagingTreeSnapshot> {
  validateCanonicalRoot(canonicalRoot);
  const context = observationContext(options);
  checkpoint(context);

  try {
    const rootBefore = await safeLstat(canonicalRoot, context);
    if (ensureSafeNodeType(rootBefore) !== 'directory') fail('INVALID_ROOT');
    const rootBeforeMetadata = statMetadata('', 'directory', rootBefore);
    const resolvedRoot = await realpath(canonicalRoot);
    checkpoint(context);
    if (resolvedRoot !== canonicalRoot) fail('ROOT_NOT_CANONICAL');

    const first = await scanTreeOnce(canonicalRoot, context);
    const second = await scanTreeOnce(canonicalRoot, context);
    const rootAfter = await safeLstat(canonicalRoot, context);
    const rootAfterMetadata = statMetadata('', 'directory', rootAfter);
    if (ensureSafeNodeType(rootAfter) !== 'directory'
      || !sameIdentityAndMetadata(rootBeforeMetadata, rootAfterMetadata)
      || !sameScan(first, second)) {
      fail('TREE_MUTATED_DURING_OBSERVATION');
    }
    await assertRealPath(canonicalRoot, context);
    return createSnapshot(second);
  } catch (error) {
    if (error instanceof AgentRuntimeStagingObserverError
      || (error instanceof Error && error.name === 'AgentRuntimeStagingResultError')) {
      throw error;
    }
    return fail('FILESYSTEM_OBSERVATION_FAILED');
  }
}

function copyMetadata(metadata: NodeMetadata): Readonly<AgentRuntimeStagingTrustedNodeMetadata> {
  return Object.freeze({ ...metadata });
}

function createTrustedResult(
  base: ScanState,
  final: ScanState,
  writePaths: readonly string[],
): AgentRuntimeStagingTrustedResult {
  const trusted: AgentRuntimeStagingTrustedResult = {
    version: AGENT_RUNTIME_STAGING_OBSERVER_VERSION,
    canonicalRoot: final.canonicalRoot,
    rootIdentity: copyMetadata(final.root),
    writeCount: writePaths.length,
    getFinalNode(path: string) {
      if (path === '') return copyMetadata(final.root);
      const normalized = normalizeAgentRuntimeStagingPath(path);
      const node = final.nodes.get(normalized.path);
      return node === undefined ? null : copyMetadata(node);
    },
    getBaseNode(path: string) {
      if (path === '') return copyMetadata(base.root);
      const normalized = normalizeAgentRuntimeStagingPath(path);
      const node = base.nodes.get(normalized.path);
      return node === undefined ? null : copyMetadata(node);
    },
    getFinalChain(path: string) {
      const normalized = normalizeAgentRuntimeStagingPath(path);
      const chain: Readonly<AgentRuntimeStagingTrustedNodeMetadata>[] = [copyMetadata(final.root)];
      for (let depth = 1; depth <= normalized.components.length; depth += 1) {
        const part = normalized.components.slice(0, depth).join('/');
        const node = final.nodes.get(part);
        if (node === undefined) fail('SNAPSHOT_INVALID');
        if (depth < normalized.components.length && node.kind !== 'directory') {
          fail('SNAPSHOT_INVALID');
        }
        chain.push(copyMetadata(node));
      }
      return Object.freeze(chain);
    },
    toJSON(): never {
      throw new AgentRuntimeStagingObserverError('SNAPSHOT_INVALID');
    },
  };

  return Object.freeze(trusted);
}

/**
 * Compare two authentic snapshots of the same staging root. File bytes (not
 * mtime) decide writes. The existing staging-result validator is always the
 * final path/collision/size authority.
 */
export function buildAgentRuntimeStagingResult(
  baseSnapshot: AgentRuntimeStagingTreeSnapshot,
  finalSnapshot: AgentRuntimeStagingTreeSnapshot,
): AgentRuntimeObservedStagingResult {
  const base = snapshotState(baseSnapshot);
  const final = snapshotState(finalSnapshot);
  if (base.canonicalRoot !== final.canonicalRoot) fail('SNAPSHOT_ROOT_MISMATCH');
  if (base.root.deviceId !== final.root.deviceId || base.root.inode !== final.root.inode) {
    fail('ROOT_IDENTITY_CHANGED');
  }

  const allPaths = new Set([...base.nodes.keys(), ...final.nodes.keys()]);
  const entries: Array<
    | { operation: 'write'; path: string; fileType: 'regular-file'; sizeBytes: number; linkCount: 1 }
    | { operation: 'delete'; path: string }
  > = [];
  const writePaths: string[] = [];

  for (const path of [...allPaths].sort()) {
    const before = base.nodes.get(path);
    const after = final.nodes.get(path);
    if (before !== undefined && after !== undefined && before.kind !== after.kind) {
      fail('UNSUPPORTED_TREE_SHAPE');
    }
    if (before?.kind === 'regular-file' && after === undefined) {
      entries.push({ operation: 'delete', path });
      continue;
    }
    if (after?.kind !== 'regular-file') continue;
    if (before?.kind !== 'regular-file' || before.sha256 !== after.sha256) {
      if (after.sizeBytes === undefined || after.sha256 === undefined || after.linkCount !== '1') {
        fail('SNAPSHOT_INVALID');
      }
      entries.push({
        operation: 'write',
        path,
        fileType: 'regular-file',
        sizeBytes: after.sizeBytes,
        linkCount: 1,
      });
      writePaths.push(path);
    }
  }

  const normalized = normalizeAgentRuntimeStagingResult({
    version: AGENT_RUNTIME_STAGING_RESULT_VERSION,
    entries,
  });
  const frozenEntries = Object.freeze(normalized.entries.map((entry) => Object.freeze({ ...entry })));
  const manifest = Object.freeze({
    version: normalized.version,
    entries: frozenEntries,
  }) as Readonly<AgentRuntimeStagingResult>;
  const trusted = createTrustedResult(base, final, Object.freeze([...writePaths]));

  const result = {} as AgentRuntimeObservedStagingResult;
  Object.defineProperties(result, {
    manifest: {
      configurable: false,
      enumerable: true,
      writable: false,
      value: manifest,
    },
    trusted: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: trusted,
    },
  });
  return Object.freeze(result);
}
