/**
 * Pure validation for a host-observed Agent Runtime staging result.
 *
 * The provider's own manifest is not authoritative. Before calling this
 * function, the trusted host must walk the disposable staging tree without
 * following links and supply `fileType`, `sizeBytes`, and `linkCount` from that
 * observation. Materialization must re-check the same facts at the open/copy
 * boundary; this module deliberately performs no filesystem access.
 */

export const AGENT_RUNTIME_STAGING_RESULT_VERSION = 'agentstoz-staging-result-v1' as const;

export const AGENT_RUNTIME_STAGING_MAX_ENTRIES = 4_096;
export const AGENT_RUNTIME_STAGING_MAX_PATH_BYTES = 1_024;
export const AGENT_RUNTIME_STAGING_MAX_SEGMENT_BYTES = 255;
export const AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH = 32;
export const AGENT_RUNTIME_STAGING_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export interface AgentRuntimeStagingWriteEntry {
  operation: 'write';
  path: string;
  fileType: 'regular-file';
  sizeBytes: number;
  /** Trusted host `lstat` link count. Exactly one is required. */
  linkCount: 1;
}

export interface AgentRuntimeStagingDeleteEntry {
  operation: 'delete';
  path: string;
}

export type AgentRuntimeStagingResultEntry =
  | AgentRuntimeStagingWriteEntry
  | AgentRuntimeStagingDeleteEntry;

export interface AgentRuntimeStagingResult {
  version: typeof AGENT_RUNTIME_STAGING_RESULT_VERSION;
  entries: AgentRuntimeStagingResultEntry[];
}

export type AgentRuntimeStagingResultErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_ENTRY'
  | 'UNSAFE_PATH'
  | 'PATH_LIMIT_EXCEEDED'
  | 'PROTECTED_PATH'
  | 'DUPLICATE_PATH'
  | 'PATH_COLLISION'
  | 'PATH_SHAPE_COLLISION'
  | 'ENTRY_LIMIT_EXCEEDED'
  | 'NON_REGULAR_FILE'
  | 'HARDLINK_AMBIGUOUS'
  | 'FILE_SIZE_LIMIT_EXCEEDED'
  | 'TOTAL_SIZE_LIMIT_EXCEEDED';

export class AgentRuntimeStagingResultError extends Error {
  constructor(
    readonly code: AgentRuntimeStagingResultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeStagingResultError';
  }
}

type JsonRecord = Record<string, unknown>;

const utf8 = new TextEncoder();

const protectedComponentKeys = new Set([
  '.git',
  '.agent-memory',
  '.agents',
  '.agentstoz',
  '.claude',
  '.codex',
  'agents.md',
  'claude.md',
]);

function fail(code: AgentRuntimeStagingResultErrorCode, message: string): never {
  throw new AgentRuntimeStagingResultError(code, message);
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
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

/**
 * A compatibility-normalized, case-insensitive key is stricter than either
 * APFS or NTFS alone. It makes one result set portable instead of letting the
 * destination filesystem choose which colliding entry wins.
 */
function portablePathKey(path: string): string {
  // Uppercase-then-lowercase also collapses common Unicode full-case-fold
  // expansions such as ß/SS and final/non-final sigma. It intentionally errs
  // on the side of rejecting a portable-name collision.
  return path.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
}

function isProtectedComponent(component: string): boolean {
  const key = portablePathKey(component);
  return protectedComponentKeys.has(key)
    || key.startsWith('.agentstoz-')
    || key.startsWith('.agentstoz_');
}

interface NormalizedPath {
  path: string;
  components: string[];
  portableKey: string;
}

/**
 * Validate one manifest path without resolving it against a host path.
 * The accepted syntax is a canonical NFC, slash-separated relative path.
 */
export function normalizeAgentRuntimeStagingPath(value: unknown): NormalizedPath {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('UNSAFE_PATH', 'staging 결과 경로는 비어 있지 않은 문자열이어야 합니다.');
  }
  // The character bound avoids doing normalization/encoding work on an
  // unbounded string. UTF-8 bytes are checked independently below.
  if (value.length > AGENT_RUNTIME_STAGING_MAX_PATH_BYTES) {
    return fail('PATH_LIMIT_EXCEEDED', 'staging 결과 경로가 허용 길이를 초과했습니다.');
  }
  if (value.includes('\0')
    || /[\u0001-\u001f\u007f-\u009f]/u.test(value)
    || containsUnpairedSurrogate(value)) {
    return fail('UNSAFE_PATH', 'staging 결과 경로에 안전하지 않은 문자가 있습니다.');
  }
  if (value.startsWith('/')
    || value.includes('\\')
    || /^[A-Za-z]:/u.test(value)) {
    return fail('UNSAFE_PATH', 'staging 결과에는 상대 POSIX 경로만 허용됩니다.');
  }
  if (value !== value.normalize('NFC')) {
    return fail('UNSAFE_PATH', 'staging 결과 경로는 Unicode NFC 정규형이어야 합니다.');
  }
  if (utf8.encode(value).byteLength > AGENT_RUNTIME_STAGING_MAX_PATH_BYTES) {
    return fail('PATH_LIMIT_EXCEEDED', 'staging 결과 경로가 허용 바이트 길이를 초과했습니다.');
  }

  const components = value.split('/');
  if (components.length > AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH) {
    return fail('PATH_LIMIT_EXCEEDED', 'staging 결과 경로 깊이가 허용 범위를 초과했습니다.');
  }
  for (const component of components) {
    const portableComponent = component.normalize('NFKC');
    if (!component || component === '.' || component === '..') {
      return fail('UNSAFE_PATH', 'staging 결과 경로는 정규화된 상대경로여야 합니다.');
    }
    if (component.trim() !== component
      || component.endsWith('.')
      || component.includes(':')
      || portableComponent === '.'
      || portableComponent === '..'
      || portableComponent.includes('/')
      || portableComponent.includes('\\')
      || portableComponent.includes(':')) {
      return fail('UNSAFE_PATH', 'staging 결과 경로 구성요소가 휴대 가능한 형식이 아닙니다.');
    }
    if (utf8.encode(component).byteLength > AGENT_RUNTIME_STAGING_MAX_SEGMENT_BYTES) {
      return fail('PATH_LIMIT_EXCEEDED', 'staging 결과 경로 구성요소가 너무 깁니다.');
    }
    if (isProtectedComponent(component)) {
      return fail('PROTECTED_PATH', 'staging 결과가 Git 또는 AgentsToZ 제어 경로를 변경할 수 없습니다.');
    }
  }

  return { path: value, components, portableKey: portablePathKey(value) };
}

function normalizeEntry(value: unknown): {
  entry: AgentRuntimeStagingResultEntry;
  path: NormalizedPath;
} {
  const raw = asRecord(value)
    ?? fail('INVALID_ENTRY', 'staging 결과 항목이 올바른 객체가 아닙니다.');
  const operation = raw.operation;

  if (operation === 'delete') {
    if (!hasExactKeys(raw, ['operation', 'path'])) {
      return fail('INVALID_ENTRY', '삭제 항목에는 operation과 path만 허용됩니다.');
    }
    const path = normalizeAgentRuntimeStagingPath(raw.path);
    return { entry: { operation, path: path.path }, path };
  }

  if (operation !== 'write') {
    return fail('INVALID_ENTRY', 'staging 결과에는 regular-file write와 delete만 허용됩니다.');
  }
  if (!hasExactKeys(raw, ['operation', 'path', 'fileType', 'sizeBytes', 'linkCount'])) {
    return fail('INVALID_ENTRY', '쓰기 항목 필드가 올바르지 않습니다.');
  }
  const path = normalizeAgentRuntimeStagingPath(raw.path);
  if (raw.fileType !== 'regular-file') {
    return fail('NON_REGULAR_FILE', 'staging 결과에는 일반 파일만 쓸 수 있습니다.');
  }
  if (raw.linkCount !== 1) {
    return fail('HARDLINK_AMBIGUOUS', 'hard link인 staging 파일은 반영할 수 없습니다.');
  }
  if (typeof raw.sizeBytes !== 'number'
    || !Number.isSafeInteger(raw.sizeBytes)
    || raw.sizeBytes < 0) {
    return fail('INVALID_ENTRY', 'staging 파일 크기가 올바르지 않습니다.');
  }
  if (raw.sizeBytes > AGENT_RUNTIME_STAGING_MAX_FILE_BYTES) {
    return fail('FILE_SIZE_LIMIT_EXCEEDED', 'staging 파일이 개별 파일 크기 제한을 초과했습니다.');
  }

  return {
    entry: {
      operation,
      path: path.path,
      fileType: 'regular-file',
      sizeBytes: raw.sizeBytes,
      linkCount: 1,
    },
    path,
  };
}

/**
 * Normalize a complete staging result as an unordered, collision-free change
 * set. It returns new objects and never reads or mutates the filesystem.
 */
export function normalizeAgentRuntimeStagingResult(value: unknown): AgentRuntimeStagingResult {
  const raw = asRecord(value)
    ?? fail('INVALID_MANIFEST', 'staging 결과 manifest가 올바른 객체가 아닙니다.');
  if (!hasExactKeys(raw, ['version', 'entries'])
    || raw.version !== AGENT_RUNTIME_STAGING_RESULT_VERSION
    || !Array.isArray(raw.entries)) {
    return fail('INVALID_MANIFEST', 'staging 결과 manifest 형식 또는 버전이 올바르지 않습니다.');
  }
  if (raw.entries.length > AGENT_RUNTIME_STAGING_MAX_ENTRIES) {
    return fail('ENTRY_LIMIT_EXCEEDED', 'staging 결과 항목 수가 제한을 초과했습니다.');
  }

  const entries: AgentRuntimeStagingResultEntry[] = [];
  const exactPaths = new Set<string>();
  const prefixSpellings = new Map<string, string>();
  const fullPortableKeys: string[] = [];
  let totalWriteBytes = 0;

  for (const rawEntry of raw.entries) {
    const normalized = normalizeEntry(rawEntry);
    const { path, components, portableKey } = normalized.path;

    if (exactPaths.has(path)) {
      return fail('DUPLICATE_PATH', 'staging 결과에 같은 경로가 중복되었습니다.');
    }
    exactPaths.add(path);

    // Detect spelling collisions at every directory prefix as well as at the
    // leaf. For example, `Source/a.ts` and `source/b.ts` are ambiguous on a
    // case-insensitive destination even though their full paths differ.
    for (let depth = 1; depth <= components.length; depth += 1) {
      const prefix = components.slice(0, depth).join('/');
      const prefixKey = portablePathKey(prefix);
      const prior = prefixSpellings.get(prefixKey);
      if (prior !== undefined && prior !== prefix) {
        return fail('PATH_COLLISION', 'staging 결과에 대소문자 또는 Unicode 경로 충돌이 있습니다.');
      }
      prefixSpellings.set(prefixKey, prefix);
    }

    if (normalized.entry.operation === 'write') {
      if (totalWriteBytes > AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES - normalized.entry.sizeBytes) {
        return fail('TOTAL_SIZE_LIMIT_EXCEEDED', 'staging 결과 전체 크기가 제한을 초과했습니다.');
      }
      totalWriteBytes += normalized.entry.sizeBytes;
    }

    fullPortableKeys.push(portableKey);
    entries.push(normalized.entry);
  }

  // Every entry is a leaf operation. A result containing both `path` and
  // `path/child` would require treating the first entry as a directory and is
  // therefore outside the regular-file/deletion model.
  const fullPortableKeySet = new Set(fullPortableKeys);
  for (const key of fullPortableKeys) {
    const components = key.split('/');
    for (let depth = 1; depth < components.length; depth += 1) {
      if (fullPortableKeySet.has(components.slice(0, depth).join('/'))) {
        return fail('PATH_SHAPE_COLLISION', 'staging 결과에 파일과 하위 경로가 함께 있습니다.');
      }
    }
  }

  return {
    version: AGENT_RUNTIME_STAGING_RESULT_VERSION,
    entries,
  };
}
