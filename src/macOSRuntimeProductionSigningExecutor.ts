import { execFile } from 'node:child_process';
import type { MacOSRuntimeProductionBuildIdentityResolution } from './macOSRuntimeProductionCanary';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
  planMacOSRuntimeProductionArtifactSigning,
  type MacOSRuntimeProductionArtifactLayout,
  type MacOSRuntimeProductionSigningCommand,
} from './macOSRuntimeProductionSigningPlan';

export const MACOS_RUNTIME_PRODUCTION_SIGNING_TIMEOUT_MS = 15_000 as const;
export const MACOS_RUNTIME_PRODUCTION_SIGNING_MAX_OUTPUT_BYTES = 64 * 1024;

const HARDENED_RUNTIME_FLAG = 0x1_0000n;
const AD_HOC_FLAG = 0x2n;

export type MacOSRuntimeProductionSigningExecutionReason =
  | 'production-artifacts-signed-and-verified'
  | 'artifact-sign-failed'
  | 'artifact-signature-unverified'
  | 'artifact-signature-output-rejected'
  | 'artifact-production-team-unverified'
  | 'artifact-developer-id-unverified'
  | 'artifact-hardened-runtime-required'
  | 'artifact-secure-timestamp-required'
  | 'artifact-requirement-unverified';

export interface MacOSRuntimeProductionSigningExecutionReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-signing-execution';
  readonly result: 'verified' | 'not-verified';
  readonly reason: MacOSRuntimeProductionSigningExecutionReason;
  readonly brokerSigned: boolean;
  readonly workerSigned: boolean;
  readonly brokerIntegrityVerified: boolean;
  readonly workerIntegrityVerified: boolean;
  readonly brokerInspectionVerified: boolean;
  readonly workerInspectionVerified: boolean;
  readonly brokerRequirementVerified: boolean;
  readonly workerRequirementVerified: boolean;
  readonly appSigned: false;
  readonly notarized: false;
  readonly installed: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeProductionSigningCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface MacOSRuntimeProductionSigningExecutorDependencies {
  runCodesign(
    args: readonly string[],
    options: MacOSRuntimeProductionSigningCommandOptions,
  ): Promise<MacOSRuntimeProductionSigningCommandResult>;
}

export interface MacOSRuntimeProductionSigningCommandOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

class SigningExecutionFailure extends Error {
  constructor(readonly reason: MacOSRuntimeProductionSigningExecutionReason) {
    super(reason);
    this.name = 'SigningExecutionFailure';
  }
}

function fail(reason: MacOSRuntimeProductionSigningExecutionReason): never {
  throw new SigningExecutionFailure(reason);
}

function receipt(
  reason: MacOSRuntimeProductionSigningExecutionReason,
  state: {
    readonly brokerSigned: boolean;
    readonly workerSigned: boolean;
    readonly brokerIntegrityVerified: boolean;
    readonly workerIntegrityVerified: boolean;
    readonly brokerInspectionVerified: boolean;
    readonly workerInspectionVerified: boolean;
    readonly brokerRequirementVerified: boolean;
    readonly workerRequirementVerified: boolean;
  },
): Readonly<MacOSRuntimeProductionSigningExecutionReceipt> {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-signing-execution',
    result: reason === 'production-artifacts-signed-and-verified' ? 'verified' : 'not-verified',
    reason,
    ...state,
    appSigned: false,
    notarized: false,
    installed: false,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}

function exactLine(output: string, prefix: string): string {
  const lines = output.split(/\r?\n/u).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return fail('artifact-signature-output-rejected');
  const value = lines[0]!.slice(prefix.length);
  if (value.length < 1 || value.length > 1_024) {
    return fail('artifact-signature-output-rejected');
  }
  return value;
}

function flags(output: string): bigint {
  const lines = output.split(/\r?\n/u).filter(line => line.startsWith('CodeDirectory '));
  if (lines.length !== 1) return fail('artifact-signature-output-rejected');
  const match = /(?:^|\s)flags=0x([0-9a-fA-F]+)(?:\([^\r\n]*\))?(?:\s|$)/u.exec(lines[0]!);
  if (match === null) return fail('artifact-signature-output-rejected');
  try {
    return BigInt(`0x${match[1]!}`);
  } catch {
    return fail('artifact-signature-output-rejected');
  }
}

function verifyInspection(
  output: string,
  path: string,
  identifier: string,
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
): void {
  const identity = resolution.identity!;
  if (exactLine(output, 'Executable=') !== path
    || exactLine(output, 'Identifier=') !== identifier
    || exactLine(output, 'Format=') !== 'Mach-O thin (arm64)'
    || exactLine(output, 'Hash type=') !== 'sha256 size=32'
    || !/^[a-f0-9]{64}$/u.test(exactLine(output, 'CandidateCDHashFull sha256='))) {
    return fail('artifact-signature-output-rejected');
  }
  const signatures = output
    .split(/\r?\n/u)
    .filter(line => /^Signature(?:=| )/u.test(line));
  if (signatures.length !== 1 || !/^Signature size=[1-9][0-9]*$/u.test(signatures[0]!)) {
    return fail('artifact-signature-output-rejected');
  }
  if (exactLine(output, 'TeamIdentifier=') !== identity.teamIdentifier) {
    return fail('artifact-production-team-unverified');
  }
  const authorities = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Authority='))
    .map(line => line.slice('Authority='.length));
  if (authorities.length !== 3
    || authorities[0] !== identity.commonName
    || authorities[1] !== 'Developer ID Certification Authority'
    || authorities[2] !== 'Apple Root CA') {
    return fail('artifact-developer-id-unverified');
  }
  const codeFlags = flags(output);
  if ((codeFlags & AD_HOC_FLAG) !== 0n || (codeFlags & HARDENED_RUNTIME_FLAG) === 0n) {
    return fail('artifact-hardened-runtime-required');
  }
  const timestamps = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Timestamp='))
    .map(line => line.slice('Timestamp='.length));
  if (timestamps.length !== 1
    || timestamps[0]!.length === 0
    || /^(?:none|not set)$/iu.test(timestamps[0]!)) {
    return fail('artifact-secure-timestamp-required');
  }
}

function failureFor(operation: MacOSRuntimeProductionSigningCommand['operation']) {
  if (operation.startsWith('sign-')) return 'artifact-sign-failed' as const;
  if (operation.startsWith('require-')) return 'artifact-requirement-unverified' as const;
  return 'artifact-signature-unverified' as const;
}

async function run(
  command: Readonly<MacOSRuntimeProductionSigningCommand>,
  dependencies: MacOSRuntimeProductionSigningExecutorDependencies,
): Promise<string> {
  let result: MacOSRuntimeProductionSigningCommandResult;
  try {
    result = await dependencies.runCodesign(command.args, Object.freeze({
      timeoutMs: MACOS_RUNTIME_PRODUCTION_SIGNING_TIMEOUT_MS,
      maxOutputBytes: MACOS_RUNTIME_PRODUCTION_SIGNING_MAX_OUTPUT_BYTES,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
    }));
  } catch {
    return fail(failureFor(command.operation));
  }
  const byteCount = Buffer.byteLength(result.stdout, 'utf8')
    + Buffer.byteLength(result.stderr, 'utf8');
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
    return fail(failureFor(command.operation));
  }
  if (byteCount > MACOS_RUNTIME_PRODUCTION_SIGNING_MAX_OUTPUT_BYTES
    || result.stdout.includes('\0')
    || result.stderr.includes('\0')) {
    return fail('artifact-signature-output-rejected');
  }
  return `${result.stdout}\n${result.stderr}`;
}

export async function executeMacOSRuntimeProductionArtifactSigningForTest(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  layout: Readonly<MacOSRuntimeProductionArtifactLayout>,
  dependencies: MacOSRuntimeProductionSigningExecutorDependencies,
): Promise<Readonly<MacOSRuntimeProductionSigningExecutionReceipt>> {
  const state = {
    brokerSigned: false,
    workerSigned: false,
    brokerIntegrityVerified: false,
    workerIntegrityVerified: false,
    brokerInspectionVerified: false,
    workerInspectionVerified: false,
    brokerRequirementVerified: false,
    workerRequirementVerified: false,
  };
  try {
    const plan = planMacOSRuntimeProductionArtifactSigning(resolution, layout);
    for (const command of plan.commands) {
      const output = await run(command, dependencies);
      if (command.operation === 'sign-broker') state.brokerSigned = true;
      if (command.operation === 'sign-worker') state.workerSigned = true;
      if (command.operation === 'verify-broker') state.brokerIntegrityVerified = true;
      if (command.operation === 'verify-worker') state.workerIntegrityVerified = true;
      if (command.operation === 'inspect-broker') {
        verifyInspection(output, layout.brokerPath, MACOS_RUNTIME_PRODUCTION_BROKER_NAME, resolution);
        state.brokerInspectionVerified = true;
      }
      if (command.operation === 'inspect-worker') {
        verifyInspection(
          output,
          layout.dedicatedWorkerPath,
          MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
          resolution,
        );
        state.workerInspectionVerified = true;
      }
      if (command.operation === 'require-broker') state.brokerRequirementVerified = true;
      if (command.operation === 'require-worker') state.workerRequirementVerified = true;
    }
    return receipt('production-artifacts-signed-and-verified', state);
  } catch (cause) {
    if (cause instanceof SigningExecutionFailure) return receipt(cause.reason, state);
    return receipt('artifact-signature-unverified', state);
  }
}

function strictUtf8(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

const defaultDependencies: MacOSRuntimeProductionSigningExecutorDependencies = Object.freeze({
  runCodesign(
    args: readonly string[],
    options: MacOSRuntimeProductionSigningCommandOptions,
  ): Promise<MacOSRuntimeProductionSigningCommandResult> {
    return new Promise<MacOSRuntimeProductionSigningCommandResult>(resolveRun => {
      execFile('/usr/bin/codesign', [...args], {
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
  },
});

export async function executeMacOSRuntimeProductionArtifactSigning(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  layout: Readonly<MacOSRuntimeProductionArtifactLayout>,
): Promise<Readonly<MacOSRuntimeProductionSigningExecutionReceipt>> {
  return executeMacOSRuntimeProductionArtifactSigningForTest(
    resolution,
    layout,
    defaultDependencies,
  );
}
