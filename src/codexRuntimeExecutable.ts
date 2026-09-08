import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync as nodeRealpathSync,
  statSync as nodeStatSync,
} from 'node:fs';
import {
  open as openFile,
  lstat as nodeLstat,
  realpath as nodeRealpath,
  stat as nodeStat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const CODEX_RUNTIME_MACOS_TEAM_ID = '2DC432GLL2' as const;
export const CODEX_RUNTIME_MACOS_IDENTIFIER = 'codex' as const;

const CODEX_RUNTIME_MACOS_REQUIREMENT = [
  '=anchor apple generic',
  `certificate leaf[subject.OU] = "${CODEX_RUNTIME_MACOS_TEAM_ID}"`,
  `identifier "${CODEX_RUNTIME_MACOS_IDENTIFIER}"`,
].join(' and ');
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_CODEX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 5_000;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_KILL_CONFIRM_MS = 2_000;
const PROCESS_STREAM_CLOSE_GRACE_MS = 250;
const MAX_CACHED_IDENTITIES = 16;
const EXECUTABLE_INSPECTION_POLICY_VERSION = 'agentstoz-codex-inspection-v1';
const CHATGPT_BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const CODEX_APP_BUNDLED_CODEX = '/Applications/Codex.app/Contents/Resources/codex';
const SAFE_VERSION_RE = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

type StatScalar = bigint | number | string;

export type CodexRuntimeExecutableSource =
  | 'standalone-native'
  | 'standalone-npm'
  | 'chatgpt-bundled'
  | 'codex-app-bundled';

export interface CodexRuntimeExecutableStat {
  dev: string;
  ino: string;
  size: string;
  mode: number;
  mtimeNs: string;
  ctimeNs: string;
}

export interface CodexRuntimeExecutableSigningIdentity {
  platform: 'darwin';
  teamId: typeof CODEX_RUNTIME_MACOS_TEAM_ID;
  identifier: typeof CODEX_RUNTIME_MACOS_IDENTIFIER;
}

export interface CodexRuntimeExecutableIdentity {
  /** Canonical path to the native binary. A script or package-manager shim is never returned. */
  path: string;
  source: CodexRuntimeExecutableSource;
  version: string;
  sha256: string;
  stat: CodexRuntimeExecutableStat;
  /** Linux has no equivalent platform code-signing proof, so hash/version remain the identity. */
  signing: CodexRuntimeExecutableSigningIdentity | null;
  /** Stable internal cache/profile key. It is not a public or remote DTO. */
  revision: string;
}

export type CodexRuntimeExecutableErrorCode =
  | 'CODEX_RUNTIME_EXECUTABLE_UNSUPPORTED_PLATFORM'
  | 'CODEX_RUNTIME_EXECUTABLE_PATH_INVALID'
  | 'CODEX_RUNTIME_EXECUTABLE_NOT_FOUND'
  | 'CODEX_RUNTIME_EXECUTABLE_NOT_REGULAR'
  | 'CODEX_RUNTIME_EXECUTABLE_NOT_EXECUTABLE'
  | 'CODEX_RUNTIME_EXECUTABLE_NOT_NATIVE'
  | 'CODEX_RUNTIME_NPM_LAUNCHER_INVALID'
  | 'CODEX_RUNTIME_NPM_NATIVE_NOT_FOUND'
  | 'CODEX_RUNTIME_EXECUTABLE_SIGNATURE_INVALID'
  | 'CODEX_RUNTIME_EXECUTABLE_HASH_INVALID'
  | 'CODEX_RUNTIME_EXECUTABLE_VERSION_INVALID'
  | 'CODEX_RUNTIME_EXECUTABLE_CHANGED'
  | 'CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED';

export class CodexRuntimeExecutableError extends Error {
  constructor(
    readonly code: CodexRuntimeExecutableErrorCode,
    message: string,
    readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CodexRuntimeExecutableError';
  }
}

export interface CodexRuntimeHostStat {
  isFile(): boolean;
  dev: StatScalar;
  ino: StatScalar;
  size: StatScalar;
  mode: StatScalar;
  mtimeNs: StatScalar;
  ctimeNs: StatScalar;
}

export interface CodexRuntimeCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CodexRuntimeExecutableDependencies {
  /** Distinguishes an absent candidate from a present dangling link or race. */
  lstat(path: string): Promise<CodexRuntimeHostStat>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<CodexRuntimeHostStat>;
  readTextFile(
    path: string,
    maxBytes: number,
    expectedStat: CodexRuntimeExecutableStat,
  ): Promise<string>;
  readFilePrefix(
    path: string,
    maxBytes: number,
    expectedStat: CodexRuntimeExecutableStat,
  ): Promise<Uint8Array>;
  sha256File(path: string, expectedStat: CodexRuntimeExecutableStat): Promise<string>;
  run(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number; env: Readonly<Record<string, string>> },
  ): Promise<CodexRuntimeCommandResult>;
}

export interface CodexRuntimeExecutableCurrentDependencies {
  realpathSync(path: string): string;
  statSync(path: string): CodexRuntimeHostStat;
  sha256FileSync(path: string, expectedStat: CodexRuntimeExecutableStat): string;
}

export interface CodexRuntimeExecutableCache {
  /** Full identities are stored by content-bearing revision. */
  readonly identities: Map<string, CodexRuntimeExecutableIdentity>;
  /** A cheap stat revision points at the full identity only after inspection succeeds. */
  readonly statRevisions: Map<string, string>;
  /** Concurrent inspection is coalesced only for the same native path and stat revision. */
  readonly inFlight: Map<string, Promise<CodexRuntimeExecutableIdentity>>;
}

export interface ResolveCodexRuntimeExecutableOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  homeDir?: string;
  pathEnv?: string;
  /** Explicit local preferences. Remote request data must never enter this list. */
  userCandidatePaths?: readonly string[];
  /** Re-run signature, hash, and version inspection even when the stat revision is unchanged. */
  fresh?: boolean;
  cache?: CodexRuntimeExecutableCache;
}

interface ExecutableCandidate {
  path: string;
  source: Exclude<CodexRuntimeExecutableSource, 'standalone-npm'>;
}

interface NativeCandidate {
  path: string;
  source: CodexRuntimeExecutableSource;
  expectedVersion: string | null;
}

interface NpmPlatformLayout {
  packageDirectory: string;
  targetTriple: string;
  os: 'darwin' | 'linux';
  cpu: 'arm64' | 'x64';
  versionSuffix: 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64';
}

interface JsonRecord {
  [key: string]: unknown;
}

export function createCodexRuntimeExecutableCache(): CodexRuntimeExecutableCache {
  return {
    identities: new Map(),
    statRevisions: new Map(),
    inFlight: new Map(),
  };
}

const defaultCache = createCodexRuntimeExecutableCache();
const SECURE_READ_OPEN_FLAGS = fsConstants.O_RDONLY
  | fsConstants.O_NOFOLLOW
  | fsConstants.O_NONBLOCK;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(
  code: CodexRuntimeExecutableErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): CodexRuntimeExecutableError {
  return new CodexRuntimeExecutableError(
    code,
    message,
    retryable,
    cause === undefined ? undefined : { cause },
  );
}

function isMissingPathError(cause: unknown): boolean {
  if (!isRecord(cause)) return false;
  return cause.code === 'ENOENT' || cause.code === 'ENOTDIR';
}

function safeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && isAbsolute(value)
    && !/[\u0000\r\n]/.test(value);
}

function scalar(value: StatScalar, label: string, allowNegative = false): string {
  let normalized: string;
  if (typeof value === 'bigint') normalized = value.toString();
  else if (typeof value === 'number' && Number.isSafeInteger(value)) normalized = String(value);
  else if (typeof value === 'string' && /^-?\d+$/.test(value)) normalized = value;
  else throw error('CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED', `Codex ${label} 값을 확인하지 못했습니다.`);
  if (!allowNegative && normalized.startsWith('-')) {
    throw error('CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED', `Codex ${label} 값이 올바르지 않습니다.`);
  }
  return normalized;
}

function normalizedStat(info: CodexRuntimeHostStat): CodexRuntimeExecutableStat {
  const modeText = scalar(info.mode, 'file mode');
  const mode = Number(modeText);
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw error('CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED', 'Codex file mode를 확인하지 못했습니다.');
  }
  return {
    dev: scalar(info.dev, 'device identity'),
    ino: scalar(info.ino, 'inode identity'),
    size: scalar(info.size, 'file size'),
    mode,
    mtimeNs: scalar(info.mtimeNs, 'mtime', true),
    ctimeNs: scalar(info.ctimeNs, 'ctime', true),
  };
}

function sameStat(left: CodexRuntimeExecutableStat, right: CodexRuntimeExecutableStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function boundedExecutableSize(stat: CodexRuntimeExecutableStat): number {
  const size = BigInt(stat.size);
  if (size < 1n || size > BigInt(MAX_CODEX_EXECUTABLE_BYTES)) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_HASH_INVALID',
      'Codex 실행 파일 크기가 안전한 검사 범위를 벗어났습니다.',
    );
  }
  return Number(size);
}

async function verifiedStat(
  path: string,
  dependencies: CodexRuntimeExecutableDependencies,
): Promise<CodexRuntimeExecutableStat> {
  let info: CodexRuntimeHostStat;
  try {
    info = await dependencies.stat(path);
  } catch (cause) {
    if (isMissingPathError(cause)) {
      throw error(
        'CODEX_RUNTIME_EXECUTABLE_CHANGED',
        'Codex 실행 파일이 경로 확인 직후 변경되었습니다.',
        true,
        cause,
      );
    }
    throw cause;
  }
  if (!info.isFile()) {
    throw error('CODEX_RUNTIME_EXECUTABLE_NOT_REGULAR', 'Codex 실행 대상이 일반 파일이 아닙니다.');
  }
  const stat = normalizedStat(info);
  if ((stat.mode & 0o111) === 0) {
    throw error('CODEX_RUNTIME_EXECUTABLE_NOT_EXECUTABLE', 'Codex 실행 파일에 실행 권한이 없습니다.');
  }
  return stat;
}

function statRevision(
  path: string,
  source: CodexRuntimeExecutableSource,
  expectedVersion: string | null,
  stat: CodexRuntimeExecutableStat,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string {
  return createHash('sha256').update([
    'agentstoz-codex-stat-v1',
    EXECUTABLE_INSPECTION_POLICY_VERSION,
    platform,
    arch,
    path,
    source,
    expectedVersion ?? '',
    stat.dev,
    stat.ino,
    stat.size,
    String(stat.mode),
    stat.mtimeNs,
    stat.ctimeNs,
  ].join('\0')).digest('hex');
}

/** Pure constructor helper for trusted internal fixtures and persisted diagnostics. */
export function codexRuntimeExecutableRevision(
  input: Omit<CodexRuntimeExecutableIdentity, 'revision'>,
): string {
  return createHash('sha256').update([
    'agentstoz-codex-executable-v1',
    input.path,
    input.source,
    input.version,
    input.sha256,
    input.stat.dev,
    input.stat.ino,
    input.stat.size,
    String(input.stat.mode),
    input.stat.mtimeNs,
    input.stat.ctimeNs,
    input.signing?.platform ?? '',
    input.signing?.teamId ?? '',
    input.signing?.identifier ?? '',
  ].join('\0')).digest('hex');
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

/** Pure validator for the internal resolver → service boundary. */
export function isCodexRuntimeExecutableIdentity(
  value: unknown,
): value is CodexRuntimeExecutableIdentity {
  if (!isRecord(value)
    || !hasExactKeys(value, ['path', 'source', 'version', 'sha256', 'stat', 'signing', 'revision'])
    || !safeAbsolutePath(value.path)
    || !['standalone-native', 'standalone-npm', 'chatgpt-bundled', 'codex-app-bundled']
      .includes(value.source as string)
    || typeof value.version !== 'string'
    || !SAFE_VERSION_RE.test(`codex-cli ${value.version}`)
    || typeof value.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.sha256)
    || typeof value.revision !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.revision)
    || !isRecord(value.stat)
    || !hasExactKeys(value.stat, ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'])) return false;
  const stat = value.stat;
  if (typeof stat.dev !== 'string' || !/^\d+$/.test(stat.dev)
    || typeof stat.ino !== 'string' || !/^\d+$/.test(stat.ino)
    || typeof stat.size !== 'string' || !/^\d+$/.test(stat.size)
    || typeof stat.mode !== 'number' || !Number.isSafeInteger(stat.mode) || stat.mode < 0
    || (stat.mode & 0o111) === 0
    || typeof stat.mtimeNs !== 'string' || !/^-?\d+$/.test(stat.mtimeNs)
    || typeof stat.ctimeNs !== 'string' || !/^-?\d+$/.test(stat.ctimeNs)) return false;
  if (value.signing !== null && (!isRecord(value.signing)
    || !hasExactKeys(value.signing, ['platform', 'teamId', 'identifier'])
    || value.signing.platform !== 'darwin'
    || value.signing.teamId !== CODEX_RUNTIME_MACOS_TEAM_ID
    || value.signing.identifier !== CODEX_RUNTIME_MACOS_IDENTIFIER)) return false;
  if ((value.source === 'chatgpt-bundled' || value.source === 'codex-app-bundled')
    && value.signing === null) return false;
  return codexRuntimeExecutableRevision({
    path: value.path,
    source: value.source as CodexRuntimeExecutableSource,
    version: value.version,
    sha256: value.sha256,
    stat: value.stat as unknown as CodexRuntimeExecutableStat,
    signing: value.signing as CodexRuntimeExecutableSigningIdentity | null,
  }) === value.revision;
}

/** Adds the host signing policy that cannot be inferred from a portable identity alone. */
export function isCodexRuntimeExecutableIdentityForPlatform(
  value: unknown,
  platform: NodeJS.Platform,
): value is CodexRuntimeExecutableIdentity {
  if (!isCodexRuntimeExecutableIdentity(value)) return false;
  if (platform === 'darwin') return value.signing !== null;
  if (platform === 'linux') {
    return value.signing === null
      && value.source !== 'chatgpt-bundled'
      && value.source !== 'codex-app-bundled';
  }
  return false;
}

function npmLayout(platform: NodeJS.Platform, arch: NodeJS.Architecture): NpmPlatformLayout {
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      packageDirectory: 'codex-darwin-arm64',
      targetTriple: 'aarch64-apple-darwin',
      os: 'darwin',
      cpu: 'arm64',
      versionSuffix: 'darwin-arm64',
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      packageDirectory: 'codex-darwin-x64',
      targetTriple: 'x86_64-apple-darwin',
      os: 'darwin',
      cpu: 'x64',
      versionSuffix: 'darwin-x64',
    };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return {
      packageDirectory: 'codex-linux-arm64',
      targetTriple: 'aarch64-unknown-linux-musl',
      os: 'linux',
      cpu: 'arm64',
      versionSuffix: 'linux-arm64',
    };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      packageDirectory: 'codex-linux-x64',
      targetTriple: 'x86_64-unknown-linux-musl',
      os: 'linux',
      cpu: 'x64',
      versionSuffix: 'linux-x64',
    };
  }
  throw error(
    'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
    '이 플랫폼 아키텍처의 공식 Codex npm native package를 확인할 수 없습니다.',
  );
}

async function canonicalPath(
  path: string,
  dependencies: CodexRuntimeExecutableDependencies,
): Promise<string> {
  if (!safeAbsolutePath(path)) {
    throw error('CODEX_RUNTIME_EXECUTABLE_PATH_INVALID', 'Codex 실행 파일 경로가 올바르지 않습니다.');
  }
  let canonical: string;
  try {
    canonical = await dependencies.realpath(path);
  } catch (cause) {
    if (isMissingPathError(cause)) {
      throw error('CODEX_RUNTIME_EXECUTABLE_NOT_FOUND', 'Codex 실행 파일을 찾지 못했습니다.');
    }
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED',
      'Codex 실행 파일 경로를 확인하지 못했습니다.',
      true,
      cause,
    );
  }
  if (!safeAbsolutePath(canonical)) {
    throw error('CODEX_RUNTIME_EXECUTABLE_PATH_INVALID', 'Codex canonical 경로가 올바르지 않습니다.');
  }
  return canonical;
}

async function readJson(
  path: string,
  dependencies: CodexRuntimeExecutableDependencies,
): Promise<JsonRecord> {
  const canonical = await canonicalPath(path, dependencies);
  const info = await dependencies.stat(canonical);
  const expectedStat = normalizedStat(info);
  if (!info.isFile()
    || BigInt(expectedStat.size) > BigInt(MAX_PACKAGE_JSON_BYTES)) {
    throw error('CODEX_RUNTIME_NPM_LAUNCHER_INVALID', 'Codex npm package metadata가 올바르지 않습니다.');
  }
  try {
    const parsed: unknown = JSON.parse(await dependencies.readTextFile(
      canonical,
      MAX_PACKAGE_JSON_BYTES,
      expectedStat,
    ));
    if (!isRecord(parsed)) throw new Error('package.json is not an object');
    return parsed;
  } catch (cause) {
    if (cause instanceof CodexRuntimeExecutableError) throw cause;
    throw error(
      'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
      'Codex npm package metadata를 검증하지 못했습니다.',
      false,
      cause,
    );
  }
}

function isOfficialRepository(value: unknown): boolean {
  return isRecord(value)
    && value.type === 'git'
    && value.url === 'git+https://github.com/openai/codex.git'
    && value.directory === 'codex-cli';
}

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

async function resolveNpmNative(
  launcher: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  dependencies: CodexRuntimeExecutableDependencies,
): Promise<NativeCandidate> {
  const packageRoot = dirname(dirname(launcher));
  if (relative(packageRoot, launcher) !== join('bin', 'codex.js')) {
    throw error(
      'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
      '임의의 JavaScript Codex shim은 Agent Runtime에서 실행하지 않습니다.',
    );
  }
  const layout = npmLayout(platform, arch);
  let packageJson: JsonRecord;
  try {
    packageJson = await readJson(join(packageRoot, 'package.json'), dependencies);
  } catch (cause) {
    if (cause instanceof CodexRuntimeExecutableError
      && cause.code === 'CODEX_RUNTIME_EXECUTABLE_NOT_FOUND') {
      throw error(
        'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
        'Codex JavaScript launcher에 공식 npm package metadata가 없습니다.',
        false,
        cause,
      );
    }
    throw cause;
  }
  const version = typeof packageJson.version === 'string' && SAFE_VERSION_RE.test(`codex-cli ${packageJson.version}`)
    ? packageJson.version
    : null;
  const bin = isRecord(packageJson.bin) ? packageJson.bin : null;
  const optionalDependencies = isRecord(packageJson.optionalDependencies)
    ? packageJson.optionalDependencies
    : null;
  const platformPackage = `@openai/${layout.packageDirectory}`;
  if (packageJson.name !== '@openai/codex'
    || packageJson.license !== 'Apache-2.0'
    || !version
    || bin?.codex !== 'bin/codex.js'
    || !isOfficialRepository(packageJson.repository)
    || optionalDependencies?.[platformPackage]
      !== `npm:@openai/codex@${version}-${layout.versionSuffix}`) {
    throw error(
      'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
      '공식 Codex npm launcher package 계약을 확인하지 못했습니다.',
    );
  }

  const platformRoots = [
    join(packageRoot, 'node_modules', '@openai', layout.packageDirectory),
    join(dirname(packageRoot), layout.packageDirectory),
  ];
  for (const lexicalRoot of platformRoots) {
    try {
      const platformJsonPath = await canonicalPath(join(lexicalRoot, 'package.json'), dependencies);
      const platformJson = await readJson(platformJsonPath, dependencies);
      if ((platformJson.name !== '@openai/codex' && platformJson.name !== platformPackage)
        || platformJson.version !== `${version}-${layout.versionSuffix}`
        || platformJson.license !== 'Apache-2.0'
        || !stringArrayEquals(platformJson.os, [layout.os])
        || !stringArrayEquals(platformJson.cpu, [layout.cpu])
        || !isOfficialRepository(platformJson.repository)) {
        throw error(
          'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
          'Codex npm native package 계약을 확인하지 못했습니다.',
        );
      }
      const native = await canonicalPath(
        join(dirname(platformJsonPath), 'vendor', layout.targetTriple, 'bin', 'codex'),
        dependencies,
      );
      await verifiedStat(native, dependencies);
      return { path: native, source: 'standalone-npm', expectedVersion: version };
    } catch (cause) {
      if (cause instanceof CodexRuntimeExecutableError
        && cause.code === 'CODEX_RUNTIME_EXECUTABLE_NOT_FOUND') continue;
      throw cause;
    }
  }

  // Older official npm layouts could carry vendor/ directly in the main package.
  try {
    const native = await canonicalPath(
      join(packageRoot, 'vendor', layout.targetTriple, 'bin', 'codex'),
      dependencies,
    );
    await verifiedStat(native, dependencies);
    return { path: native, source: 'standalone-npm', expectedVersion: version };
  } catch (cause) {
    if (!(cause instanceof CodexRuntimeExecutableError)
      || cause.code !== 'CODEX_RUNTIME_EXECUTABLE_NOT_FOUND') throw cause;
  }
  throw error(
    'CODEX_RUNTIME_NPM_NATIVE_NOT_FOUND',
    '공식 Codex npm package의 native 실행 파일을 찾지 못했습니다.',
  );
}

async function nativeCandidate(
  candidate: ExecutableCandidate,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  dependencies: CodexRuntimeExecutableDependencies,
  expectedCanonical: string,
): Promise<NativeCandidate> {
  const canonical = await canonicalPath(candidate.path, dependencies);
  if (canonical !== expectedCanonical) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_CHANGED',
      'Codex 실행 파일 링크 대상이 검사 도중 변경되었습니다.',
      true,
    );
  }
  await verifiedStat(canonical, dependencies);
  if (canonical.endsWith('/bin/codex.js')) {
    if (candidate.source !== 'standalone-native') {
      throw error(
        'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
        '앱 번들 Codex 실행 파일이 native binary가 아닙니다.',
      );
    }
    return resolveNpmNative(canonical, platform, arch, dependencies);
  }
  if (/\.(?:js|cjs|mjs|sh|command)$/i.test(canonical)) {
    throw error(
      'CODEX_RUNTIME_NPM_LAUNCHER_INVALID',
      '임의의 script shim은 Agent Runtime에서 실행하지 않습니다.',
    );
  }
  return { path: canonical, source: candidate.source, expectedVersion: null };
}

function candidateList(options: ResolveCodexRuntimeExecutableOptions): ExecutableCandidate[] {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return [];
  const home = options.homeDir ?? homedir();
  const paths: ExecutableCandidate[] = [];
  const seen = new Set<string>();
  const add = (path: string, source: ExecutableCandidate['source']) => {
    const key = `${source}\u0000${path}`;
    if (!safeAbsolutePath(path) || seen.has(key)) return;
    seen.add(key);
    paths.push({ path, source });
  };
  for (const path of options.userCandidatePaths ?? []) {
    if (!safeAbsolutePath(path)) {
      throw error(
        'CODEX_RUNTIME_EXECUTABLE_PATH_INVALID',
        '명시한 Codex 실행 파일 경로가 올바르지 않습니다.',
      );
    }
    add(path, 'standalone-native');
  }
  for (const directory of (options.pathEnv ?? process.env.PATH ?? '').split(':')) {
    if (safeAbsolutePath(directory)) add(join(directory, 'codex'), 'standalone-native');
  }
  for (const path of [
    join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.bun', 'bin', 'codex'),
    join(home, '.npm-global', 'bin', 'codex'),
    join(home, '.volta', 'bin', 'codex'),
  ]) add(path, 'standalone-native');
  if (platform === 'darwin') {
    add(CHATGPT_BUNDLED_CODEX, 'chatgpt-bundled');
    add(CODEX_APP_BUNDLED_CODEX, 'codex-app-bundled');
  }
  return paths;
}

function standaloneAliasTargetsBundledCodex(
  candidate: ExecutableCandidate,
  canonical: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin'
    && candidate.source === 'standalone-native'
    && (canonical === CHATGPT_BUNDLED_CODEX || canonical === CODEX_APP_BUNDLED_CODEX);
}

async function verifyNativeFormat(
  path: string,
  platform: NodeJS.Platform,
  expectedStat: CodexRuntimeExecutableStat,
  dependencies: CodexRuntimeExecutableDependencies,
): Promise<void> {
  let prefix: Uint8Array;
  try {
    prefix = await dependencies.readFilePrefix(path, 4, expectedStat);
  } catch (cause) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED',
      'Codex native 실행 파일 형식을 확인하지 못했습니다.',
      true,
      cause,
    );
  }
  const hex = [...prefix].map(value => value.toString(16).padStart(2, '0')).join('');
  const native = platform === 'linux'
    ? hex === '7f454c46'
    : ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(hex);
  if (!native) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_NOT_NATIVE',
      'Codex 실행 대상이 native binary가 아닙니다.',
    );
  }
}

async function inspectNativeCandidate(
  native: NativeCandidate,
  platform: NodeJS.Platform,
  stat: CodexRuntimeExecutableStat,
  dependencies: CodexRuntimeExecutableDependencies,
): Promise<CodexRuntimeExecutableIdentity> {
  await verifyNativeFormat(native.path, platform, stat, dependencies);
  let signing: CodexRuntimeExecutableSigningIdentity | null = null;
  if (platform === 'darwin') {
    const signature = await dependencies.run('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '-R',
      CODEX_RUNTIME_MACOS_REQUIREMENT,
      native.path,
    ], {
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    if (signature.timedOut || signature.exitCode !== 0) {
      throw error(
        'CODEX_RUNTIME_EXECUTABLE_SIGNATURE_INVALID',
        'Codex 실행 파일의 OpenAI code-signing identity를 확인하지 못했습니다.',
        signature.timedOut,
      );
    }
    signing = {
      platform: 'darwin',
      teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
      identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
    };
  }

  let sha256: string;
  try {
    boundedExecutableSize(stat);
    sha256 = (await dependencies.sha256File(native.path, stat)).toLowerCase();
  } catch (cause) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_HASH_INVALID',
      'Codex 실행 파일 hash를 계산하지 못했습니다.',
      true,
      cause,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw error('CODEX_RUNTIME_EXECUTABLE_HASH_INVALID', 'Codex 실행 파일 hash가 올바르지 않습니다.');
  }
  const afterHash = await verifiedStat(native.path, dependencies);
  if (!sameStat(stat, afterHash)) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_CHANGED',
      'Codex 실행 파일이 검증 도중 변경되었습니다.',
      true,
    );
  }

  const versionResult = await dependencies.run(native.path, ['--version'], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  const versionText = (versionResult.stdout.trim() || versionResult.stderr.trim());
  const versionMatch = SAFE_VERSION_RE.exec(versionText);
  if (versionResult.timedOut
    || versionResult.exitCode !== 0
    || !versionMatch?.[1]
    || (native.expectedVersion !== null && versionMatch[1] !== native.expectedVersion)) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_VERSION_INVALID',
      'Codex 실행 파일 version을 안전하게 확인하지 못했습니다.',
      versionResult.timedOut,
    );
  }
  const afterVersion = await verifiedStat(native.path, dependencies);
  if (!sameStat(stat, afterVersion)) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_CHANGED',
      'Codex 실행 파일이 검증 도중 변경되었습니다.',
      true,
    );
  }

  const withoutRevision: Omit<CodexRuntimeExecutableIdentity, 'revision'> = {
    path: native.path,
    source: native.source,
    version: versionMatch[1],
    sha256,
    stat,
    signing,
  };
  return {
    ...withoutRevision,
    revision: codexRuntimeExecutableRevision(withoutRevision),
  };
}

function rememberIdentity(
  cache: CodexRuntimeExecutableCache,
  statKey: string,
  identity: CodexRuntimeExecutableIdentity,
): void {
  cache.identities.delete(identity.revision);
  cache.identities.set(identity.revision, identity);
  cache.statRevisions.set(statKey, identity.revision);
  while (cache.identities.size > MAX_CACHED_IDENTITIES) {
    const oldest = cache.identities.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.identities.delete(oldest);
    for (const [key, revision] of cache.statRevisions) {
      if (revision === oldest) cache.statRevisions.delete(key);
    }
  }
}

async function inspectCandidate(
  candidate: ExecutableCandidate,
  expectedCanonical: string,
  options: ResolveCodexRuntimeExecutableOptions,
  dependencies: CodexRuntimeExecutableDependencies,
): Promise<CodexRuntimeExecutableIdentity> {
  const platform = options.platform ?? process.platform;
  const native = await nativeCandidate(
    candidate,
    platform,
    options.arch ?? process.arch,
    dependencies,
    expectedCanonical,
  );
  const stat = await verifiedStat(native.path, dependencies);
  const key = statRevision(
    native.path,
    native.source,
    native.expectedVersion,
    stat,
    platform,
    options.arch ?? process.arch,
  );
  const cache = options.cache ?? defaultCache;
  if (!options.fresh) {
    const cachedRevision = cache.statRevisions.get(key);
    const cached = cachedRevision ? cache.identities.get(cachedRevision) : undefined;
    if (cached) {
      const current = await verifiedStat(native.path, dependencies);
      if (sameStat(stat, current)) return cached;
      cache.statRevisions.delete(key);
    }
  }

  let pending = cache.inFlight.get(key);
  if (!pending) {
    pending = inspectNativeCandidate(native, platform, stat, dependencies);
    cache.inFlight.set(key, pending);
    void pending.finally(() => {
      if (cache.inFlight.get(key) === pending) cache.inFlight.delete(key);
    }).catch(() => undefined);
  }
  const identity = await pending;
  const current = await verifiedStat(native.path, dependencies);
  if (!sameStat(identity.stat, current)) {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_CHANGED',
      'Codex 실행 파일이 검증 직후 변경되었습니다.',
      true,
    );
  }
  rememberIdentity(cache, key, identity);
  return identity;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function processErrorCode(cause: unknown): string | null {
  return isRecord(cause) && typeof cause.code === 'string' ? cause.code : null;
}

function detachedProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    if (processErrorCode(cause) === 'ESRCH') return false;
    // EPERM still proves that the process group exists. Unknown inspection
    // failures stay fail-closed and are handled as an incomplete cleanup.
    return true;
  }
}

function signalDetachedProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (cause) {
    if (processErrorCode(cause) === 'ESRCH') return false;
    return false;
  }
}

/**
 * Runs a short executable inspection inside its own POSIX process group.
 * Even `--version` is untrusted until inspection finishes: timeout, excessive
 * output, direct-child exit with inherited pipes, and spawn errors all converge
 * on TERM -> KILL -> process-group disappearance before this promise settles.
 */
export function runCodexRuntimeInspectionCommand(
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; env: Readonly<Record<string, string>> },
): Promise<CodexRuntimeCommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    const deadline = performance.now() + Math.max(1, options.timeoutMs);
    const child = nodeSpawn(executable, [...args], {
      detached: true,
      env: { ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitCode: number | null = null;
    let exited = false;
    let closed = false;
    let finalizing = false;
    let outputExceeded = false;
    let spawnFailed = false;

    let resolveClosed!: () => void;
    const closePromise = new Promise<void>(resolve => { resolveClosed = resolve; });

    const boundedAppend = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer,
    ): number => {
      const remaining = Math.max(0, options.maxOutputBytes - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.byteLength > remaining) outputExceeded = true;
      return Math.min(options.maxOutputBytes, currentBytes + chunk.byteLength);
    };

    const cleanupConfirmed = (): boolean => {
      const pid = child.pid;
      return (spawnFailed || exited)
        && (pid === undefined || !detachedProcessGroupAlive(pid));
    };

    const waitForCleanup = async (deadline: number): Promise<boolean> => {
      while (!cleanupConfirmed() && performance.now() < deadline) await delay(20);
      return cleanupConfirmed();
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const finalize = async (timeoutTriggered: boolean): Promise<void> => {
      if (finalizing) return;
      finalizing = true;
      // Timers and child events share one JS loop. If the loop stalls past the
      // deadline, an exit/output callback can otherwise clear the queued timer
      // and incorrectly turn a late result into success.
      const timedOut = timeoutTriggered || performance.now() >= deadline;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        const pid = child.pid;
        if (pid !== undefined && detachedProcessGroupAlive(pid)) {
          signalDetachedProcessGroup(pid, 'SIGTERM');
        }
        if (!exited && !spawnFailed) {
          try { child.kill('SIGTERM'); } catch { /* group cleanup remains authoritative */ }
        }

        const terminatedDuringGrace = await waitForCleanup(
          performance.now() + PROCESS_TERMINATION_GRACE_MS,
        );
        if (!terminatedDuringGrace) {
          if (pid !== undefined) signalDetachedProcessGroup(pid, 'SIGKILL');
          if (!exited && !spawnFailed) {
            try { child.kill('SIGKILL'); } catch { /* verified below */ }
          }
        }
        if (!await waitForCleanup(performance.now() + PROCESS_KILL_CONFIRM_MS)) {
          throw error(
            'CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED',
            'Codex 실행 파일 검사 프로세스 종료를 확인하지 못했습니다.',
            true,
          );
        }

        if (!closed) {
          await Promise.race([closePromise, delay(PROCESS_STREAM_CLOSE_GRACE_MS)]);
        }
        if (!closed) {
          child.stdout.destroy();
          child.stderr.destroy();
          await Promise.race([closePromise, delay(PROCESS_STREAM_CLOSE_GRACE_MS)]);
        }
        resolveRun({
          exitCode: outputExceeded || spawnFailed ? null : exitCode,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
          timedOut,
        });
      } catch (cause) {
        child.stdout.destroy();
        child.stderr.destroy();
        rejectRun(cause instanceof CodexRuntimeExecutableError
          ? cause
          : error(
            'CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED',
            'Codex 실행 파일 검사 프로세스를 안전하게 정리하지 못했습니다.',
            true,
            cause,
          ));
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes = boundedAppend(stdoutChunks, stdoutBytes, buffer);
      if (outputExceeded) void finalize(false);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes = boundedAppend(stderrChunks, stderrBytes, buffer);
      if (outputExceeded) void finalize(false);
    });
    child.once('error', () => {
      spawnFailed = true;
      void finalize(false);
    });
    child.once('exit', code => {
      exited = true;
      exitCode = code;
      void finalize(false);
    });
    child.once('close', () => {
      closed = true;
      resolveClosed();
    });
    timeoutHandle = setTimeout(() => { void finalize(true); }, options.timeoutMs);
  });
}

const defaultDependencies: CodexRuntimeExecutableDependencies = {
  lstat: async path => nodeLstat(path, { bigint: true }),
  realpath: nodeRealpath,
  stat: async path => nodeStat(path, { bigint: true }),
  readTextFile: async (path, maxBytes, expectedStat) => {
    const handle = await openFile(path, SECURE_READ_OPEN_FLAGS);
    try {
      const info = await handle.stat({ bigint: true });
      const before = normalizedStat(info);
      if (!info.isFile()
        || !sameStat(before, expectedStat)
        || info.size > BigInt(maxBytes)) throw new Error('bounded file required');
      const expectedSize = Number(info.size);
      const buffer = Buffer.allocUnsafe(Math.max(1, expectedSize));
      let offset = 0;
      while (offset < expectedSize) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          expectedSize - offset,
          offset,
        );
        if (bytesRead < 1) throw new Error('metadata ended before its verified size');
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
        throw new Error('metadata exceeded its verified size');
      }
      const after = normalizedStat(await handle.stat({ bigint: true }));
      if (!sameStat(before, after) || !sameStat(after, expectedStat)) {
        throw new Error('metadata changed during read');
      }
      return buffer.subarray(0, expectedSize).toString('utf8');
    } finally {
      await handle.close();
    }
  },
  readFilePrefix: async (path, maxBytes, expectedStat) => {
    const handle = await openFile(path, SECURE_READ_OPEN_FLAGS);
    try {
      const info = await handle.stat({ bigint: true });
      const before = normalizedStat(info);
      if (!info.isFile() || !sameStat(before, expectedStat)) {
        throw new Error('verified regular file required');
      }
      const buffer = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      const afterInfo = await handle.stat({ bigint: true });
      const after = normalizedStat(afterInfo);
      if (!afterInfo.isFile()
        || !sameStat(before, after)
        || !sameStat(after, expectedStat)) {
        throw new Error('native file changed during prefix read');
      }
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  sha256File: async (path, expectedStat) => {
    const expectedSize = boundedExecutableSize(expectedStat);
    const handle = await openFile(path, SECURE_READ_OPEN_FLAGS);
    try {
      const beforeInfo = await handle.stat({ bigint: true });
      const before = normalizedStat(beforeInfo);
      if (!beforeInfo.isFile() || !sameStat(before, expectedStat)) {
        throw new Error('file descriptor identity changed');
      }
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, expectedSize));
      let offset = 0;
      while (offset < expectedSize) {
        const length = Math.min(buffer.byteLength, expectedSize - offset);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead < 1) throw new Error('executable ended before its verified size');
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
        throw new Error('executable grew during hashing');
      }
      const after = normalizedStat(await handle.stat({ bigint: true }));
      if (!sameStat(before, after) || !sameStat(after, expectedStat)) {
        throw new Error('file descriptor identity changed during hashing');
      }
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  },
  run: runCodexRuntimeInspectionCommand,
};

/** @internal Exported so the non-blocking special-file guard has a regression test. */
export function hashCodexRuntimeExecutableFileSync(
  path: string,
  expectedStat: CodexRuntimeExecutableStat,
): string {
  const expectedSize = boundedExecutableSize(expectedStat);
  const descriptor = openSync(path, SECURE_READ_OPEN_FLAGS);
  const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, expectedSize));
  const hash = createHash('sha256');
  try {
    const beforeInfo = fstatSync(descriptor, { bigint: true });
    const before = normalizedStat(beforeInfo);
    if (!beforeInfo.isFile() || !sameStat(before, expectedStat)) {
      throw new Error('file descriptor identity changed');
    }
    let offset = 0;
    while (offset < expectedSize) {
      const length = Math.min(buffer.byteLength, expectedSize - offset);
      const bytesRead = readSync(descriptor, buffer, 0, length, offset);
      if (bytesRead < 1) throw new Error('executable ended before its verified size');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, expectedSize) !== 0) {
      throw new Error('executable grew during hashing');
    }
    const after = normalizedStat(fstatSync(descriptor, { bigint: true }));
    if (!sameStat(before, after) || !sameStat(after, expectedStat)) {
      throw new Error('file descriptor identity changed during hashing');
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

const defaultCurrentDependencies: CodexRuntimeExecutableCurrentDependencies = {
  realpathSync: nodeRealpathSync,
  statSync: path => nodeStatSync(path, { bigint: true }),
  sha256FileSync: hashCodexRuntimeExecutableFileSync,
};

/**
 * Resolves exactly one POSIX Codex runtime identity. The first present standalone
 * candidate is authoritative: an unverifiable user install fails closed instead
 * of silently changing account/config semantics by falling back to an app bundle.
 * macOS app-bundled binaries are considered only when every standalone candidate is absent.
 */
export async function resolveCodexRuntimeExecutable(
  options: ResolveCodexRuntimeExecutableOptions = {},
  dependencies: CodexRuntimeExecutableDependencies = defaultDependencies,
): Promise<CodexRuntimeExecutableIdentity | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_UNSUPPORTED_PLATFORM',
      '이 단계의 Codex 실행 파일 identity 검증은 macOS와 Linux에서만 지원합니다.',
    );
  }
  for (const candidate of candidateList(options)) {
    try {
      await dependencies.lstat(candidate.path);
    } catch (cause) {
      if (isMissingPathError(cause)) continue;
      throw error(
        'CODEX_RUNTIME_EXECUTABLE_INSPECTION_FAILED',
        'Codex 실행 파일 후보 상태를 확인하지 못했습니다.',
        true,
        cause,
      );
    }
    let canonicalBeforeInspection: string;
    try {
      canonicalBeforeInspection = await canonicalPath(candidate.path, dependencies);
    } catch (cause) {
      if (cause instanceof CodexRuntimeExecutableError
        && cause.code === 'CODEX_RUNTIME_EXECUTABLE_NOT_FOUND') {
        throw error(
          'CODEX_RUNTIME_EXECUTABLE_PATH_INVALID',
          'Codex 실행 파일 후보가 끊어진 링크이거나 확인 중 변경되었습니다.',
          true,
          cause,
        );
      }
      throw cause;
    }
    // PATH or an explicit symlink must not relabel an app bundle as a
    // standalone install or move it ahead of a real standalone candidate.
    // The same binary remains eligible later through its exact fallback row.
    if (standaloneAliasTargetsBundledCodex(candidate, canonicalBeforeInspection, platform)) {
      continue;
    }
    try {
      return await inspectCandidate(
        candidate,
        canonicalBeforeInspection,
        options,
        dependencies,
      );
    } catch (cause) {
      if (cause instanceof CodexRuntimeExecutableError
        && cause.code === 'CODEX_RUNTIME_EXECUTABLE_NOT_FOUND') {
        // The lexical entry existed immediately before realpath. Treat a
        // dangling link or removal race as a terminal invalid candidate rather
        // than silently changing accounts/config by selecting an app bundle.
        throw error(
          'CODEX_RUNTIME_EXECUTABLE_PATH_INVALID',
          'Codex 실행 파일 후보가 끊어진 링크이거나 확인 중 변경되었습니다.',
          true,
          cause,
        );
      }
      // Present-but-unverifiable is intentionally terminal. Do not silently
      // switch from the user's CLI/account/config lifecycle to an app bundle.
      throw cause;
    }
  }
  return null;
}

/**
 * Synchronous last-await boundary for Agent Runtime. It re-reads SHA-256 as
 * well as stat identity so an in-place rewrite that preserves path/size/mtime
 * cannot cross from a successful compatibility probe into provider spawn.
 */
export function assertCodexRuntimeExecutableIdentityCurrent(
  identity: CodexRuntimeExecutableIdentity,
  dependencies: CodexRuntimeExecutableCurrentDependencies = defaultCurrentDependencies,
): void {
  try {
    if (!isCodexRuntimeExecutableIdentityForPlatform(identity, process.platform)) {
      throw new Error('invalid executable identity for this host');
    }
    const canonical = dependencies.realpathSync(identity.path);
    if (canonical !== identity.path) throw new Error('canonical path changed');
    const beforeInfo = dependencies.statSync(canonical);
    if (!beforeInfo.isFile()) throw new Error('not a regular file');
    const before = normalizedStat(beforeInfo);
    if ((before.mode & 0o111) === 0 || !sameStat(identity.stat, before)) {
      throw new Error('stat identity changed');
    }
    boundedExecutableSize(before);
    const sha256 = dependencies.sha256FileSync(canonical, before).toLowerCase();
    const afterInfo = dependencies.statSync(canonical);
    if (!afterInfo.isFile()) throw new Error('not a regular file after hash');
    const after = normalizedStat(afterInfo);
    if (!sameStat(before, after) || sha256 !== identity.sha256) {
      throw new Error('content identity changed');
    }
  } catch (cause) {
    if (cause instanceof CodexRuntimeExecutableError
      && cause.code === 'CODEX_RUNTIME_EXECUTABLE_CHANGED') throw cause;
    throw error(
      'CODEX_RUNTIME_EXECUTABLE_CHANGED',
      '검증 이후 Codex 실행 파일이 변경되어 실행을 차단했습니다.',
      true,
      cause,
    );
  }
}
