import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID,
} from './macOSRuntimeBrokerSigning';
import {
  resolveMacOSRuntimeProductionIdentity,
  type MacOSRuntimeProductionIdentity,
  type MacOSRuntimeProductionIdentityResolution,
} from './macOSRuntimeProductionIdentity';

export const MACOS_RUNTIME_PRODUCTION_CANARY_SCHEMA_VERSION = 1 as const;
export const MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER =
  'com.intenet.agentstozbycs.runtime-signing-canary' as const;
export const MACOS_RUNTIME_PRODUCTION_CANARY_SOURCE = '/usr/bin/true' as const;
export const MACOS_RUNTIME_PRODUCTION_CANARY_CODESIGN_PATH = '/usr/bin/codesign' as const;
export const MACOS_RUNTIME_PRODUCTION_CANARY_TIMEOUT_MS = 15_000 as const;
export const MACOS_RUNTIME_PRODUCTION_CANARY_MAX_OUTPUT_BYTES = 64 * 1024;

const HARDENED_RUNTIME_FLAG = 0x1_0000n;
const AD_HOC_FLAG = 0x2n;
const SCRATCH_PREFIX = 'agentstoz-runtime-signing-canary-';
// The trusted system /usr/bin/true may be universal, including arm64e on
// current macOS. This proves key possession; shipped artifacts separately
// retain their exact thin-arm64 checks. codesign verifies every canary slice.
const CANARY_MACH_O_FORMATS = new Set([
  'Mach-O thin (arm64)',
  'Mach-O thin (arm64e)',
  'Mach-O universal (x86_64 arm64)',
  'Mach-O universal (x86_64 arm64e)',
]);

export type MacOSRuntimeProductionCanaryReason =
  | 'canary-snapshot-verified'
  | 'platform-unsupported'
  | 'production-identity-unavailable'
  | 'canary-source-unverified'
  | 'canary-stage-failed'
  | 'canary-sign-failed'
  | 'canary-signature-output-rejected'
  | 'production-team-unverified'
  | 'developer-id-unverified'
  | 'hardened-runtime-required'
  | 'secure-timestamp-required'
  | 'canary-requirement-unverified'
  | 'canary-cleanup-failed';

export interface MacOSRuntimeProductionCanaryDiagnostic {
  readonly schemaVersion: typeof MACOS_RUNTIME_PRODUCTION_CANARY_SCHEMA_VERSION;
  readonly kind: 'macos-runtime-production-signing-canary';
  readonly scope: 'build-key-possession-snapshot-only';
  readonly result: 'snapshot-verified' | 'not-verified';
  readonly reason: MacOSRuntimeProductionCanaryReason;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

/**
 * Private build-tool result. `identity` must never enter an HTTP/Tauri/mobile
 * DTO or runtime registry. Even a verified value is not runtime authority.
 */
export interface MacOSRuntimeProductionBuildIdentityResolution {
  readonly diagnostic: Readonly<MacOSRuntimeProductionCanaryDiagnostic>;
  readonly identity: Readonly<MacOSRuntimeProductionIdentity> | null;
}

export interface MacOSRuntimeProductionCanaryCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface MacOSRuntimeProductionCanaryCommandOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface MacOSRuntimeProductionCanaryStage {
  readonly scratchRoot: string;
  readonly executablePath: string;
}

export interface MacOSRuntimeProductionCanaryDependencies {
  resolveIdentity(): Promise<Readonly<MacOSRuntimeProductionIdentityResolution>>;
  createCanary(): Promise<Readonly<MacOSRuntimeProductionCanaryStage>>;
  removeCanary(stage: Readonly<MacOSRuntimeProductionCanaryStage>): Promise<void>;
  runCodesign(
    args: readonly string[],
    options: MacOSRuntimeProductionCanaryCommandOptions,
  ): Promise<MacOSRuntimeProductionCanaryCommandResult>;
}

class CanaryFailure extends Error {
  constructor(readonly reason: MacOSRuntimeProductionCanaryReason) {
    super(reason);
    this.name = 'CanaryFailure';
  }
}

function fail(reason: MacOSRuntimeProductionCanaryReason): never {
  throw new CanaryFailure(reason);
}

function diagnostic(
  reason: MacOSRuntimeProductionCanaryReason,
): Readonly<MacOSRuntimeProductionCanaryDiagnostic> {
  return Object.freeze({
    schemaVersion: MACOS_RUNTIME_PRODUCTION_CANARY_SCHEMA_VERSION,
    kind: 'macos-runtime-production-signing-canary',
    scope: 'build-key-possession-snapshot-only',
    result: reason === 'canary-snapshot-verified' ? 'snapshot-verified' : 'not-verified',
    reason,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}

function boundedOutput(result: MacOSRuntimeProductionCanaryCommandResult): string {
  const byteCount = Buffer.byteLength(result.stdout, 'utf8')
    + Buffer.byteLength(result.stderr, 'utf8');
  if (result.exitCode !== 0
    || result.timedOut
    || result.outputTruncated
    || byteCount > MACOS_RUNTIME_PRODUCTION_CANARY_MAX_OUTPUT_BYTES
    || result.stdout.includes('\0')
    || result.stderr.includes('\0')) {
    return fail('canary-signature-output-rejected');
  }
  return `${result.stdout}\n${result.stderr}`;
}

async function codesign(
  args: readonly string[],
  dependencies: MacOSRuntimeProductionCanaryDependencies,
  failureReason: MacOSRuntimeProductionCanaryReason,
): Promise<string> {
  let result: MacOSRuntimeProductionCanaryCommandResult;
  try {
    result = await dependencies.runCodesign(Object.freeze([...args]), Object.freeze({
      timeoutMs: MACOS_RUNTIME_PRODUCTION_CANARY_TIMEOUT_MS,
      maxOutputBytes: MACOS_RUNTIME_PRODUCTION_CANARY_MAX_OUTPUT_BYTES,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
    }));
  } catch {
    return fail(failureReason);
  }
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
    return fail(failureReason);
  }
  return boundedOutput(result);
}

function exactLine(output: string, prefix: string): string {
  const values = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length));
  if (values.length !== 1 || values[0]!.length < 1 || values[0]!.length > 1_024) {
    return fail('canary-signature-output-rejected');
  }
  return values[0]!;
}

function codeDirectoryFlags(output: string): bigint {
  const lines = output.split(/\r?\n/u).filter(line => line.startsWith('CodeDirectory '));
  if (lines.length !== 1) return fail('canary-signature-output-rejected');
  const match = /(?:^|\s)flags=0x([0-9a-fA-F]+)(?:\([^\r\n]*\))?(?:\s|$)/u.exec(lines[0]!);
  if (match === null) return fail('canary-signature-output-rejected');
  try {
    return BigInt(`0x${match[1]!}`);
  } catch {
    return fail('canary-signature-output-rejected');
  }
}

function verifySignatureDetails(
  output: string,
  executablePath: string,
  identity: Readonly<MacOSRuntimeProductionIdentity>,
): void {
  if (exactLine(output, 'Executable=') !== executablePath
    || exactLine(output, 'Identifier=') !== MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER
    || !CANARY_MACH_O_FORMATS.has(exactLine(output, 'Format='))
    || exactLine(output, 'Hash type=') !== 'sha256 size=32') {
    return fail('canary-signature-output-rejected');
  }
  const cdHash = exactLine(output, 'CandidateCDHashFull sha256=');
  if (!/^[a-f0-9]{64}$/u.test(cdHash)) {
    return fail('canary-signature-output-rejected');
  }
  const signature = output
    .split(/\r?\n/u)
    .filter(line => /^Signature(?:=| )/u.test(line));
  if (signature.length !== 1
    || !/^Signature size=[1-9][0-9]*$/u.test(signature[0]!)) {
    return fail('canary-signature-output-rejected');
  }
  if (exactLine(output, 'TeamIdentifier=') !== identity.teamIdentifier) {
    return fail('production-team-unverified');
  }
  const authorities = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Authority='))
    .map(line => line.slice('Authority='.length));
  if (authorities.length !== 3
    || authorities[0] !== identity.commonName
    || authorities[1] !== 'Developer ID Certification Authority'
    || authorities[2] !== 'Apple Root CA') {
    return fail('developer-id-unverified');
  }
  const flags = codeDirectoryFlags(output);
  if ((flags & AD_HOC_FLAG) !== 0n || (flags & HARDENED_RUNTIME_FLAG) === 0n) {
    return fail('hardened-runtime-required');
  }
  const timestamps = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Timestamp='))
    .map(line => line.slice('Timestamp='.length));
  if (timestamps.length !== 1
    || timestamps[0]!.length === 0
    || /^(?:none|not set)$/iu.test(timestamps[0]!)) {
    return fail('secure-timestamp-required');
  }
}

function productionRequirement(teamIdentifier: string): string {
  return `=anchor apple generic and certificate 1[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID}] exists and certificate leaf[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID}] exists and certificate leaf[subject.OU] = "${teamIdentifier}" and identifier "${MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER}"`;
}

function validIdentity(identity: Readonly<MacOSRuntimeProductionIdentity>): boolean {
  const team = identity.teamIdentifier;
  if (!/^[A-Z0-9]{10}$/u.test(team)
    || new Set(team).size === 1
    || new Set([
      'ABCDEFGHIJ', '1234567890', 'TEAMID1234', 'YOURTEAMID', 'XXXXXXXXXX',
    ]).has(team)
    || !/^[0-9A-F]{40}$/u.test(identity.certificateFingerprint)) {
    return false;
  }
  const commonName = /^Developer ID Application: ([^\u0000-\u001F\u007F]{1,300}) \(([A-Z0-9]{10})\)$/u
    .exec(identity.commonName);
  return commonName !== null && commonName[2] === team;
}

function validStage(stage: Readonly<MacOSRuntimeProductionCanaryStage>): boolean {
  return isAbsolute(stage.scratchRoot)
    && isAbsolute(stage.executablePath)
    && !/[\u0000-\u001F\u007F]/u.test(stage.scratchRoot)
    && stage.executablePath === join(
      stage.scratchRoot,
      'agentstoz-runtime-signing-canary',
    );
}

async function verifyCanary(
  stage: Readonly<MacOSRuntimeProductionCanaryStage>,
  identity: Readonly<MacOSRuntimeProductionIdentity>,
  dependencies: MacOSRuntimeProductionCanaryDependencies,
): Promise<void> {
  await codesign([
    '--force',
    '--sign', identity.certificateFingerprint,
    '--identifier', MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER,
    '--options', 'runtime',
    '--timestamp',
    stage.executablePath,
  ], dependencies, 'canary-sign-failed');
  await codesign([
    '--verify', '--strict', '--all-architectures', '--verbose=4', stage.executablePath,
  ], dependencies, 'canary-signature-output-rejected');
  const details = await codesign([
    '--display', '--verbose=4', stage.executablePath,
  ], dependencies, 'canary-signature-output-rejected');
  verifySignatureDetails(details, stage.executablePath, identity);
  await codesign([
    '--verify',
    '--strict',
    '--all-architectures',
    '--verbose=4',
    '-R',
    productionRequirement(identity.teamIdentifier),
    stage.executablePath,
  ], dependencies, 'canary-requirement-unverified');
}

async function inspectSnapshot(
  dependencies: MacOSRuntimeProductionCanaryDependencies,
  platform: NodeJS.Platform,
): Promise<Readonly<MacOSRuntimeProductionBuildIdentityResolution>> {
  const unavailable = (
    reason: Exclude<MacOSRuntimeProductionCanaryReason, 'canary-snapshot-verified'>,
  ) => Object.freeze({ diagnostic: diagnostic(reason), identity: null });
  if (platform !== 'darwin') return unavailable('platform-unsupported');
  let identityResolution: Readonly<MacOSRuntimeProductionIdentityResolution>;
  try {
    identityResolution = await dependencies.resolveIdentity();
  } catch {
    return unavailable('production-identity-unavailable');
  }
  if (identityResolution.identity === null
    || identityResolution.diagnostic.result !== 'snapshot-verified'
    || !validIdentity(identityResolution.identity)) {
    return unavailable('production-identity-unavailable');
  }
  let stage: Readonly<MacOSRuntimeProductionCanaryStage> | null = null;
  let result: Readonly<MacOSRuntimeProductionCanaryDiagnostic>;
  try {
    stage = await dependencies.createCanary();
    if (!validStage(stage)) return fail('canary-stage-failed');
    await verifyCanary(stage, identityResolution.identity, dependencies);
    result = diagnostic('canary-snapshot-verified');
  } catch (cause) {
    result = diagnostic(cause instanceof CanaryFailure ? cause.reason : 'canary-stage-failed');
  }
  if (stage !== null) {
    try {
      await dependencies.removeCanary(stage);
    } catch {
      return unavailable('canary-cleanup-failed');
    }
  }
  return Object.freeze({
    diagnostic: result,
    identity: result.result === 'snapshot-verified' ? identityResolution.identity : null,
  });
}

function assertContained(parent: string, candidate: string): void {
  const value = relative(resolve(parent), resolve(candidate));
  if (value === '' || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error('canary path escaped scratch root');
  }
}

async function createDefaultCanary(): Promise<Readonly<MacOSRuntimeProductionCanaryStage>> {
  const sourceStat = await lstat(MACOS_RUNTIME_PRODUCTION_CANARY_SOURCE);
  if (!sourceStat.isFile()
    || sourceStat.isSymbolicLink()
    || sourceStat.uid !== 0
    || (sourceStat.mode & 0o0022) !== 0
    || await realpath(MACOS_RUNTIME_PRODUCTION_CANARY_SOURCE)
      !== MACOS_RUNTIME_PRODUCTION_CANARY_SOURCE) {
    return fail('canary-source-unverified');
  }
  const temporaryParent = await realpath(tmpdir());
  const scratchRoot = await realpath(await mkdtemp(join(temporaryParent, SCRATCH_PREFIX)));
  const executablePath = join(scratchRoot, 'agentstoz-runtime-signing-canary');
  assertContained(scratchRoot, executablePath);
  try {
    await chmod(scratchRoot, 0o700);
    await copyFile(
      MACOS_RUNTIME_PRODUCTION_CANARY_SOURCE,
      executablePath,
      fsConstants.COPYFILE_EXCL,
    );
    await chmod(executablePath, 0o500);
    const stagedStat = await lstat(executablePath);
    if (!stagedStat.isFile()
      || stagedStat.isSymbolicLink()
      || stagedStat.nlink !== 1
      || await realpath(executablePath) !== executablePath) {
      throw new Error('canary stage rejected');
    }
    return Object.freeze({ scratchRoot, executablePath });
  } catch (cause) {
    await rm(scratchRoot, { recursive: true, force: true });
    throw cause;
  }
}

async function removeDefaultCanary(
  stage: Readonly<MacOSRuntimeProductionCanaryStage>,
): Promise<void> {
  const temporaryParent = await realpath(tmpdir());
  const canonicalRoot = await realpath(stage.scratchRoot);
  const expectedPrefix = join(temporaryParent, SCRATCH_PREFIX);
  if (!canonicalRoot.startsWith(expectedPrefix)
    || relative(temporaryParent, canonicalRoot).includes(sep)
    || stage.executablePath !== join(canonicalRoot, 'agentstoz-runtime-signing-canary')) {
    throw new Error('canary cleanup path rejected');
  }
  await rm(canonicalRoot, { recursive: true, force: false });
}

function strictUtf8(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function defaultRunCodesign(
  args: readonly string[],
  options: MacOSRuntimeProductionCanaryCommandOptions,
): Promise<MacOSRuntimeProductionCanaryCommandResult> {
  return new Promise(resolveRun => {
    execFile(MACOS_RUNTIME_PRODUCTION_CANARY_CODESIGN_PATH, [...args], {
      cwd: '/',
      encoding: 'buffer',
      env: { ...options.env },
      killSignal: 'SIGKILL',
      maxBuffer: options.maxOutputBytes,
      shell: false,
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (cause, stdout, stderr) => {
      if (cause !== null) {
        resolveRun(Object.freeze({
          exitCode: typeof cause.code === 'number' ? cause.code : null,
          stdout: '',
          stderr: '',
          timedOut: cause.killed === true,
          outputTruncated: cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }));
        return;
      }
      try {
        const stdoutText = strictUtf8(Buffer.from(stdout));
        const stderrText = strictUtf8(Buffer.from(stderr));
        const outputTruncated = Buffer.byteLength(stdoutText, 'utf8')
          + Buffer.byteLength(stderrText, 'utf8') > options.maxOutputBytes;
        resolveRun(Object.freeze({
          exitCode: 0,
          stdout: outputTruncated ? '' : stdoutText,
          stderr: outputTruncated ? '' : stderrText,
          timedOut: false,
          outputTruncated,
        }));
      } catch {
        resolveRun(Object.freeze({
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          outputTruncated: true,
        }));
      }
    });
  });
}

const defaultDependencies: MacOSRuntimeProductionCanaryDependencies = Object.freeze({
  resolveIdentity: resolveMacOSRuntimeProductionIdentity,
  createCanary: createDefaultCanary,
  removeCanary: removeDefaultCanary,
  runCodesign: defaultRunCodesign,
});

export async function inspectMacOSRuntimeProductionSigningCanary(): Promise<
  Readonly<MacOSRuntimeProductionCanaryDiagnostic>
> {
  return (await inspectSnapshot(defaultDependencies, process.platform)).diagnostic;
}

export async function resolveMacOSRuntimeProductionBuildIdentity(): Promise<
  Readonly<MacOSRuntimeProductionBuildIdentityResolution>
> {
  return inspectSnapshot(defaultDependencies, process.platform);
}

/** Test-only dependency injection. The result is still never runtime authority. */
export async function inspectMacOSRuntimeProductionSigningCanaryForTest(
  dependencies: MacOSRuntimeProductionCanaryDependencies,
  platform: NodeJS.Platform = process.platform,
): Promise<Readonly<MacOSRuntimeProductionCanaryDiagnostic>> {
  return (await inspectSnapshot(dependencies, platform)).diagnostic;
}
