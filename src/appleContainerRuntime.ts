import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat as nodeLstat, open as nodeOpen, realpath as nodeRealpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';

import {
  createAgentRuntimeContainmentCapability,
  type AgentRuntimeContainmentCapability,
  type AgentRuntimeContainmentReadinessReason,
} from './agentRuntimeContainment';

export const APPLE_CONTAINER_RUNTIME_KIND = 'apple-container-vm' as const;
export const APPLE_CONTAINER_CLI_PATH = '/usr/local/bin/container' as const;
export const APPLE_CONTAINER_API_SERVER_PATH = '/usr/local/bin/container-apiserver' as const;
export const APPLE_CONTAINER_CODESIGN_PATH = '/usr/bin/codesign' as const;
export const APPLE_CONTAINER_SW_VERS_PATH = '/usr/bin/sw_vers' as const;
export const APPLE_CONTAINER_TEAM_IDENTIFIER = 'UPBK2H6LZM' as const;
export const APPLE_CONTAINER_RUNTIME_RELEASE_ROOT =
  '/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/apple-container/1.3.1' as const;
export const APPLE_CONTAINER_RUNTIME_APP_ROOT =
  '/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/apple-container/1.3.1/app-root' as const;
export const APPLE_CONTAINER_RUNTIME_LOG_ROOT =
  '/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/apple-container/1.3.1/logs' as const;
export const APPLE_CONTAINER_RUNTIME_INSTALL_ROOT = '/usr/local' as const;
export const APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES = 32 * 1024;

const APPLE_CONTAINER_MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const APPLE_CONTAINER_HASH_BUFFER_BYTES = 1024 * 1024;
const APPLE_CONTAINER_SIGNATURE_TIMEOUT_MS = 5_000;
const APPLE_CONTAINER_VERSION_TIMEOUT_MS = 5_000;
// Apple 1.3.1's status command has an internal 10 second health-check timeout.
const APPLE_CONTAINER_STATUS_TIMEOUT_MS = 12_000;
const APPLE_CONTAINER_HOST_VERSION_TIMEOUT_MS = 2_000;
const APPLE_CONTAINER_MAX_JSON_STRING_BYTES = 8 * 1024;
const APPLE_CONTAINER_HOST_VERSION_RE = /^(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,2}))?(?:\.(0|[1-9]\d{0,2}))?$/;
const APPLE_CONTAINER_RELEASE_VERSION_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const APPLE_CONTAINER_SERVER_VERSION_RE = /^container-apiserver version ((?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})) \(build: ([a-z][a-z0-9-]{0,31}), commit: ([0-9a-f]{7,64}|unspecified)\)$/;
const APPLE_CONTAINER_COMMIT_RE = /^(?:[0-9a-f]{7,64}|unspecified)$/;

export interface AppleContainerReleaseFileIdentity {
  readonly path: string;
  readonly signingIdentifier: string;
  readonly sha256: string;
}

export interface AppleContainerTestedReleaseIdentity {
  readonly version: string;
  readonly sourceCommit: string;
  readonly teamIdentifier: string;
  readonly cli: AppleContainerReleaseFileIdentity;
  readonly apiServer: AppleContainerReleaseFileIdentity;
}

/**
 * Dependency-audited Apple Container candidate. This table does not mean the
 * build has passed containment qualification: the full installed payload,
 * service configuration, kernel/vminit identities, crash reconciliation and
 * detached-descendant E2E must all pass before readiness can become true.
 * Adding another row still requires a fresh package/signature/hash audit.
 */
export const APPLE_CONTAINER_TESTED_RELEASES: readonly AppleContainerTestedReleaseIdentity[] =
  Object.freeze([
    Object.freeze({
      version: '1.3.1',
      sourceCommit: 'a9a62e28f6beb88940122a3d7b286f2d5ae8053a',
      teamIdentifier: APPLE_CONTAINER_TEAM_IDENTIFIER,
      cli: Object.freeze({
        path: APPLE_CONTAINER_CLI_PATH,
        signingIdentifier: 'com.apple.container.cli',
        sha256: 'c6f8ef172248f7b8a30fa3e502359bba678bc993991c37b848dbead1914e86b1',
      }),
      apiServer: Object.freeze({
        path: APPLE_CONTAINER_API_SERVER_PATH,
        signingIdentifier: 'com.apple.container.apiserver',
        sha256: 'ace7e2200c4302b7184e29f4063d346305869202c8bda794eaae0613e39f79e2',
      }),
    }),
  ]);

export interface AppleContainerRuntimeFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly mode: number | bigint;
  readonly uid: number | bigint;
  readonly nlink: number | bigint;
  readonly mtimeNs?: number | bigint;
  readonly ctimeNs?: number | bigint;
  readonly mtimeMs?: number | bigint;
  readonly ctimeMs?: number | bigint;
}

export interface AppleContainerCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface AppleContainerRuntimeProbeDependencies {
  lstat(path: string): Promise<AppleContainerRuntimeFileStat>;
  realpath(path: string): Promise<string>;
  sha256File(path: string, expected: AppleContainerRuntimeFileFingerprint): Promise<string>;
  run(
    executable: string,
    args: readonly string[],
    options: {
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly env: Readonly<Record<string, string>>;
    },
  ): Promise<AppleContainerCommandResult>;
}

export interface AppleContainerRuntimeProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  /** Test/host injection only. Remote or browser request data must never set this. */
  readonly macOSVersion?: string;
}

export interface AppleContainerRuntimeFileFingerprint {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mode: number;
  readonly uid: string;
  readonly nlink: string;
  readonly mtime: string;
  readonly ctime: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface ParsedComponentVersion {
  readonly appName: 'container' | 'container-apiserver';
  readonly version: string;
  readonly buildType: string;
  readonly commit: string;
}

interface ParsedVersionPayload {
  readonly cli: ParsedComponentVersion;
  readonly server: ParsedComponentVersion | null;
  readonly serverReleaseVersion: string | null;
}

interface VerifiedReleaseFiles {
  readonly release: AppleContainerTestedReleaseIdentity;
  readonly cli: AppleContainerRuntimeFileFingerprint;
  readonly apiServer: AppleContainerRuntimeFileFingerprint;
}

type AppleContainerDependencyReadinessReason = Exclude<
  AgentRuntimeContainmentReadinessReason,
  'ready'
>;

class AppleContainerProbeFailure extends Error {
  constructor(readonly reason: AppleContainerDependencyReadinessReason) {
    super(reason);
    this.name = 'AppleContainerProbeFailure';
  }
}

function fail(reason: AppleContainerDependencyReadinessReason): never {
  throw new AppleContainerProbeFailure(reason);
}

function publicCapability(
  reason: AppleContainerDependencyReadinessReason,
): Readonly<AgentRuntimeContainmentCapability> {
  return createAgentRuntimeContainmentCapability(
    reason === 'platform-unsupported' ? null : APPLE_CONTAINER_RUNTIME_KIND,
    reason,
  );
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isMissingPathError(cause: unknown): boolean {
  if (!isRecord(cause)) return false;
  return cause.code === 'ENOENT' || cause.code === 'ENOTDIR';
}

function boundedString(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= APPLE_CONTAINER_MAX_JSON_STRING_BYTES
    && !value.includes('\0');
}

function scalarString(value: number | bigint | undefined): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fail('binary-identity-unverified');
}

function statFingerprint(stat: AppleContainerRuntimeFileStat): AppleContainerRuntimeFileFingerprint {
  const numericMode = Number(stat.mode);
  if (!Number.isSafeInteger(numericMode) || numericMode < 0) {
    return fail('binary-identity-unverified');
  }
  const mtime = stat.mtimeNs === undefined
    ? scalarString(stat.mtimeMs)
    : scalarString(stat.mtimeNs);
  const ctime = stat.ctimeNs === undefined
    ? scalarString(stat.ctimeMs)
    : scalarString(stat.ctimeNs);
  return Object.freeze({
    dev: scalarString(stat.dev),
    ino: scalarString(stat.ino),
    size: scalarString(stat.size),
    mode: numericMode,
    uid: scalarString(stat.uid),
    nlink: scalarString(stat.nlink),
    mtime,
    ctime,
  });
}

function sameFingerprint(
  left: AppleContainerRuntimeFileFingerprint,
  right: AppleContainerRuntimeFileFingerprint,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.mtime === right.mtime
    && left.ctime === right.ctime;
}

function pathChain(path: string): readonly string[] {
  if (!isAbsolute(path) || normalize(path) !== path) {
    return fail('binary-identity-unverified');
  }
  const chain: string[] = [];
  let cursor = path;
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return chain.reverse();
}

async function inspectTrustedPath(
  path: string,
  leafKind: 'file' | 'directory',
  dependencies: AppleContainerRuntimeProbeDependencies,
): Promise<AppleContainerRuntimeFileFingerprint> {
  const chain = pathChain(path);
  let leaf: AppleContainerRuntimeFileFingerprint | null = null;
  for (let index = 0; index < chain.length; index += 1) {
    const component = chain[index];
    if (!component) return fail('binary-identity-unverified');
    let info: AppleContainerRuntimeFileStat;
    let canonical: string;
    try {
      info = await dependencies.lstat(component);
      canonical = await dependencies.realpath(component);
    } catch (cause) {
      if (isMissingPathError(cause)) return fail('dependency-missing');
      return fail('binary-identity-unverified');
    }
    const isLeaf = index === chain.length - 1;
    const fingerprint = statFingerprint(info);
    if (canonical !== component
      || info.isSymbolicLink()
      || fingerprint.uid !== '0'
      || (fingerprint.mode & 0o022) !== 0
      || (isLeaf && leafKind === 'file' && (
        !info.isFile()
        || fingerprint.nlink !== '1'
        || (fingerprint.mode & 0o111) === 0
      ))
      || (isLeaf && leafKind === 'directory' && !info.isDirectory())
      || (!isLeaf && !info.isDirectory())) {
      return fail('binary-identity-unverified');
    }
    if (isLeaf) leaf = fingerprint;
  }
  return leaf ?? fail('binary-identity-unverified');
}

function codesignRequirement(release: AppleContainerTestedReleaseIdentity, identifier: string): string {
  return `=anchor apple generic and certificate leaf[subject.OU] = "${release.teamIdentifier}" and identifier "${identifier}"`;
}

function inspectionEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
  });
}

async function runChecked(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  failureReason: AppleContainerDependencyReadinessReason,
  dependencies: AppleContainerRuntimeProbeDependencies,
): Promise<AppleContainerCommandResult> {
  let result: AppleContainerCommandResult;
  try {
    result = await dependencies.run(executable, args, {
      timeoutMs,
      maxOutputBytes: APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES,
      env: inspectionEnvironment(),
    });
  } catch {
    return fail(failureReason);
  }
  if (result.timedOut
    || result.outputTruncated
    || result.exitCode !== 0
    || result.stderr.trim().length !== 0
    || Buffer.byteLength(result.stdout, 'utf8') > APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES
    || Buffer.byteLength(result.stderr, 'utf8') > APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES) {
    return fail(failureReason);
  }
  return result;
}

function parseJson(text: string, reason: AppleContainerDependencyReadinessReason): unknown {
  if (!text
    || Buffer.byteLength(text, 'utf8') > APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES
    || text.includes('\0')) return fail(reason);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(reason);
  }
}

function parseComponent(
  value: unknown,
  appName: ParsedComponentVersion['appName'],
  reason: AppleContainerDependencyReadinessReason,
): ParsedComponentVersion {
  if (!isRecord(value)
    || !hasExactKeys(value, ['appName', 'buildType', 'commit', 'version'])
    || value.appName !== appName
    || !boundedString(value.version)
    || !boundedString(value.buildType)
    || !boundedString(value.commit)
    || !APPLE_CONTAINER_COMMIT_RE.test(value.commit)) return fail(reason);
  return Object.freeze({
    appName,
    version: value.version,
    buildType: value.buildType,
    commit: value.commit,
  });
}

function parsedServerReleaseVersion(
  component: ParsedComponentVersion,
  reason: AppleContainerDependencyReadinessReason,
): string {
  const match = APPLE_CONTAINER_SERVER_VERSION_RE.exec(component.version);
  if (!match?.[1] || !match[2] || !match[3]
    || component.buildType !== match[2]
    || (component.commit === 'unspecified'
      ? match[3] !== 'unspecified'
      : !component.commit.startsWith(match[3]))) return fail(reason);
  return match[1];
}

function parseVersionPayload(text: string): ParsedVersionPayload {
  const value = parseJson(text, 'dependency-unhealthy');
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 2)) {
    return fail('dependency-unhealthy');
  }
  const cli = parseComponent(value[0], 'container', 'dependency-unhealthy');
  if (!APPLE_CONTAINER_RELEASE_VERSION_RE.test(cli.version)) {
    return fail('dependency-unhealthy');
  }
  if (value.length === 1) return Object.freeze({ cli, server: null, serverReleaseVersion: null });
  const server = parseComponent(value[1], 'container-apiserver', 'service-unhealthy');
  return Object.freeze({
    cli,
    server,
    serverReleaseVersion: parsedServerReleaseVersion(server, 'service-unhealthy'),
  });
}

function assertStatusPayload(
  text: string,
  expectedServer: ParsedComponentVersion,
  expectedVersion: string,
): void {
  const value = parseJson(text, 'service-unhealthy');
  const statusKeys = [
    'status',
    'appRoot',
    'installRoot',
    'apiServerVersion',
    'apiServerCommit',
    'apiServerBuild',
    'apiServerAppName',
  ] as const;
  if (!isRecord(value)
    || !hasExactKeys(value, [...statusKeys, 'logRoot'])
    || value.status !== 'running'
    || value.appRoot !== APPLE_CONTAINER_RUNTIME_APP_ROOT
    || value.installRoot !== APPLE_CONTAINER_RUNTIME_INSTALL_ROOT
    || value.logRoot !== APPLE_CONTAINER_RUNTIME_LOG_ROOT
    || !boundedString(value.apiServerVersion)
    || !boundedString(value.apiServerCommit)
    || !boundedString(value.apiServerBuild)
    || value.apiServerAppName !== 'container-apiserver'
    || !APPLE_CONTAINER_COMMIT_RE.test(value.apiServerCommit)) {
    return fail('service-unhealthy');
  }
  const statusServer: ParsedComponentVersion = {
    appName: 'container-apiserver',
    version: value.apiServerVersion,
    buildType: value.apiServerBuild,
    commit: value.apiServerCommit,
  };
  const statusVersion = parsedServerReleaseVersion(statusServer, 'service-unhealthy');
  if (statusVersion !== expectedVersion
    || statusServer.version !== expectedServer.version
    || statusServer.buildType !== expectedServer.buildType
    || statusServer.commit !== expectedServer.commit) {
    return fail('version-unsupported');
  }
}

async function hostMacOSVersion(
  options: AppleContainerRuntimeProbeOptions,
  dependencies: AppleContainerRuntimeProbeDependencies,
): Promise<string> {
  if (options.macOSVersion !== undefined) return options.macOSVersion;
  const result = await runChecked(
    APPLE_CONTAINER_SW_VERS_PATH,
    ['-productVersion'],
    APPLE_CONTAINER_HOST_VERSION_TIMEOUT_MS,
    'host-degraded',
    dependencies,
  );
  return result.stdout.trim();
}

function assertSupportedMacOSVersion(value: string): void {
  if (Buffer.byteLength(value, 'utf8') > 32) return fail('host-degraded');
  const match = APPLE_CONTAINER_HOST_VERSION_RE.exec(value);
  if (!match?.[1]) return fail('host-degraded');
  if (Number(match[1]) < 26) return fail('platform-unsupported');
}

async function verifyReleaseFiles(
  dependencies: AppleContainerRuntimeProbeDependencies,
): Promise<VerifiedReleaseFiles> {
  const cliBefore = await inspectTrustedPath(APPLE_CONTAINER_CLI_PATH, 'file', dependencies);
  const apiServerBefore = await inspectTrustedPath(
    APPLE_CONTAINER_API_SERVER_PATH,
    'file',
    dependencies,
  );
  let cliSha256: string;
  let apiServerSha256: string;
  try {
    [cliSha256, apiServerSha256] = await Promise.all([
      dependencies.sha256File(APPLE_CONTAINER_CLI_PATH, cliBefore),
      dependencies.sha256File(APPLE_CONTAINER_API_SERVER_PATH, apiServerBefore),
    ]);
  } catch {
    return fail('binary-identity-unverified');
  }
  cliSha256 = cliSha256.toLowerCase();
  apiServerSha256 = apiServerSha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cliSha256) || !/^[0-9a-f]{64}$/.test(apiServerSha256)) {
    return fail('binary-identity-unverified');
  }
  const release = APPLE_CONTAINER_TESTED_RELEASES.find(candidate =>
    candidate.cli.sha256 === cliSha256
      && candidate.apiServer.sha256 === apiServerSha256);
  if (!release) return fail('binary-identity-unverified');

  for (const file of [release.cli, release.apiServer]) {
    await runChecked(
      APPLE_CONTAINER_CODESIGN_PATH,
      ['--verify', '--strict', '-R', codesignRequirement(release, file.signingIdentifier), file.path],
      APPLE_CONTAINER_SIGNATURE_TIMEOUT_MS,
      'binary-identity-unverified',
      dependencies,
    );
  }
  const cliAfter = await inspectTrustedPath(APPLE_CONTAINER_CLI_PATH, 'file', dependencies);
  const apiServerAfter = await inspectTrustedPath(
    APPLE_CONTAINER_API_SERVER_PATH,
    'file',
    dependencies,
  );
  if (!sameFingerprint(cliBefore, cliAfter) || !sameFingerprint(apiServerBefore, apiServerAfter)) {
    return fail('binary-identity-unverified');
  }
  return Object.freeze({ release, cli: cliAfter, apiServer: apiServerAfter });
}

async function assertReleaseFilesUnchanged(
  files: VerifiedReleaseFiles,
  dependencies: AppleContainerRuntimeProbeDependencies,
): Promise<void> {
  const cli = await inspectTrustedPath(APPLE_CONTAINER_CLI_PATH, 'file', dependencies);
  const apiServer = await inspectTrustedPath(
    APPLE_CONTAINER_API_SERVER_PATH,
    'file',
    dependencies,
  );
  if (!sameFingerprint(files.cli, cli) || !sameFingerprint(files.apiServer, apiServer)) {
    return fail('binary-identity-unverified');
  }
}

/**
 * Performs read-only dependency qualification. It never starts services,
 * downloads an image, creates a VM/container, or enables Agent Runtime
 * execution. Passing this probe is intentionally not final containment
 * readiness. Even a passing service must report the broker-owned exact app,
 * install and log roots; a separately persisted and identity-bound broker/TCB
 * and escape E2E proof must compose it into `ready`. Raw paths, command output, and parser errors are
 * absent from the return value; only the provider-neutral public capability
 * contract crosses layers.
 */
export async function probeAppleContainerRuntimeDependencyCapability(
  options: AppleContainerRuntimeProbeOptions = {},
  dependencies: AppleContainerRuntimeProbeDependencies = defaultDependencies,
): Promise<Readonly<AgentRuntimeContainmentCapability>> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'darwin' || arch !== 'arm64') return publicCapability('platform-unsupported');

  try {
    assertSupportedMacOSVersion(await hostMacOSVersion(options, dependencies));
    const files = await verifyReleaseFiles(dependencies);
    const versionResult = await runChecked(
      APPLE_CONTAINER_CLI_PATH,
      ['system', 'version', '--format', 'json'],
      APPLE_CONTAINER_VERSION_TIMEOUT_MS,
      'dependency-unhealthy',
      dependencies,
    );
    const versions = parseVersionPayload(versionResult.stdout);
    if (versions.cli.version !== files.release.version
      || versions.cli.commit !== files.release.sourceCommit) {
      return publicCapability('version-unsupported');
    }
    if (!versions.server || !versions.serverReleaseVersion) {
      return publicCapability('service-unhealthy');
    }
    if (versions.serverReleaseVersion !== files.release.version
      || versions.serverReleaseVersion !== versions.cli.version
      || versions.cli.buildType !== 'release'
      || versions.server.buildType !== 'release'
      || versions.server.commit !== files.release.sourceCommit) {
      return publicCapability('version-unsupported');
    }

    const statusResult = await runChecked(
      APPLE_CONTAINER_CLI_PATH,
      ['system', 'status', '--format', 'json'],
      APPLE_CONTAINER_STATUS_TIMEOUT_MS,
      'service-unhealthy',
      dependencies,
    );
    assertStatusPayload(statusResult.stdout, versions.server, files.release.version);
    await assertReleaseFilesUnchanged(files, dependencies);
    return publicCapability('self-test-required');
  } catch (cause) {
    return publicCapability(
      cause instanceof AppleContainerProbeFailure ? cause.reason : 'host-degraded',
    );
  }
}

function defaultRunCommand(
  executable: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly env: Readonly<Record<string, string>>;
  },
): Promise<AppleContainerCommandResult> {
  return new Promise(resolveRun => {
    execFile(executable, [...args], {
      encoding: 'utf8',
      env: { ...options.env },
      maxBuffer: options.maxOutputBytes,
      shell: false,
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (cause, stdout, stderr) => {
      const raw = cause as (NodeJS.ErrnoException & {
        killed?: boolean;
        signal?: NodeJS.Signals | null;
      }) | null;
      resolveRun({
        exitCode: cause === null
          ? 0
          : (typeof raw?.code === 'number' ? raw.code : null),
        stdout,
        stderr,
        timedOut: Boolean(raw?.killed && raw.signal),
        outputTruncated: raw?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
    });
  });
}

async function hashTrustedFile(
  path: string,
  expected: AppleContainerRuntimeFileFingerprint,
): Promise<string> {
  const descriptor = await nodeOpen(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const beforeInfo = await descriptor.stat({ bigint: true });
    const before = statFingerprint(beforeInfo);
    if (!beforeInfo.isFile()
      || !sameFingerprint(before, expected)
      || beforeInfo.size < 1n
      || beforeInfo.size > BigInt(APPLE_CONTAINER_MAX_EXECUTABLE_BYTES)) {
      return fail('binary-identity-unverified');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(APPLE_CONTAINER_HASH_BUFFER_BYTES);
    let offset = 0n;
    while (offset < beforeInfo.size) {
      const remaining = beforeInfo.size - offset;
      const length = Number(remaining > BigInt(buffer.byteLength)
        ? BigInt(buffer.byteLength)
        : remaining);
      const { bytesRead } = await descriptor.read(buffer, 0, length, Number(offset));
      if (bytesRead < 1) return fail('binary-identity-unverified');
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await descriptor.read(extra, 0, 1, Number(beforeInfo.size))).bytesRead !== 0) {
      return fail('binary-identity-unverified');
    }
    const afterInfo = await descriptor.stat({ bigint: true });
    if (!afterInfo.isFile() || !sameFingerprint(before, statFingerprint(afterInfo))) {
      return fail('binary-identity-unverified');
    }
    return hash.digest('hex');
  } finally {
    await descriptor.close();
  }
}

const defaultDependencies: AppleContainerRuntimeProbeDependencies = {
  lstat: async path => nodeLstat(path, { bigint: true }),
  realpath: nodeRealpath,
  sha256File: hashTrustedFile,
  run: defaultRunCommand,
};
