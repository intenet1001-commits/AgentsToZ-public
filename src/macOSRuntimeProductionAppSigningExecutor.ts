import { execFile } from 'node:child_process';
import {
  MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
  MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT,
  MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE,
} from './macOSRuntimeBrokerSigning';
import type { MacOSRuntimeProductionBuildIdentityResolution } from './macOSRuntimeProductionCanary';
import {
  planMacOSRuntimeProductionAppSigning,
  type MacOSRuntimeProductionAppLayout,
  type MacOSRuntimeProductionAppSigningCommand,
} from './macOSRuntimeProductionAppSigningPlan';

export const MACOS_RUNTIME_PRODUCTION_APP_SIGNING_TIMEOUT_MS = 20_000 as const;
export const MACOS_RUNTIME_PRODUCTION_APP_SIGNING_MAX_OUTPUT_BYTES = 64 * 1024;

const HARDENED_RUNTIME_FLAG = 0x1_0000n;
const AD_HOC_FLAG = 0x2n;

export type MacOSRuntimeProductionAppSigningReason =
  | 'production-app-signed-and-verified'
  | 'nested-code-sign-failed'
  | 'nested-code-signature-unverified'
  | 'nested-code-requirement-unverified'
  | 'app-sign-failed'
  | 'app-signature-unverified'
  | 'app-signature-output-rejected'
  | 'app-production-team-unverified'
  | 'app-developer-id-unverified'
  | 'app-hardened-runtime-required'
  | 'app-secure-timestamp-required'
  | 'app-client-entitlement-unverified'
  | 'app-requirement-unverified';

export interface MacOSRuntimeProductionAppSigningReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-app-signing-execution';
  readonly result: 'verified' | 'not-verified';
  readonly reason: MacOSRuntimeProductionAppSigningReason;
  readonly nestedCodeSigned: number;
  readonly nestedCodeIntegrityVerified: number;
  readonly nestedCodeRequirementsVerified: number;
  readonly brokerIntegrityVerified: boolean;
  readonly workerIntegrityVerified: boolean;
  readonly appSigned: boolean;
  readonly appIntegrityVerified: boolean;
  readonly appInspectionVerified: boolean;
  readonly appRequirementVerified: boolean;
  readonly brokerRequirementVerified: boolean;
  readonly workerRequirementVerified: boolean;
  readonly notarized: false;
  readonly installed: false;
  readonly serviceRegistered: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeProductionAppSigningCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface MacOSRuntimeProductionAppSigningCommandOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface MacOSRuntimeProductionAppSigningExecutorDependencies {
  runCodesign(
    args: readonly string[],
    options: MacOSRuntimeProductionAppSigningCommandOptions,
  ): Promise<MacOSRuntimeProductionAppSigningCommandResult>;
}

interface MutableState {
  nestedCodeSigned: number;
  nestedCodeIntegrityVerified: number;
  nestedCodeRequirementsVerified: number;
  brokerIntegrityVerified: boolean;
  workerIntegrityVerified: boolean;
  appSigned: boolean;
  appIntegrityVerified: boolean;
  appInspectionVerified: boolean;
  appRequirementVerified: boolean;
  brokerRequirementVerified: boolean;
  workerRequirementVerified: boolean;
}

class AppSigningFailure extends Error {
  constructor(readonly reason: MacOSRuntimeProductionAppSigningReason) {
    super(reason);
    this.name = 'AppSigningFailure';
  }
}

function fail(reason: MacOSRuntimeProductionAppSigningReason): never {
  throw new AppSigningFailure(reason);
}

function receipt(
  reason: MacOSRuntimeProductionAppSigningReason,
  state: Readonly<MutableState>,
): Readonly<MacOSRuntimeProductionAppSigningReceipt> {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-app-signing-execution',
    result: reason === 'production-app-signed-and-verified' ? 'verified' : 'not-verified',
    reason,
    ...state,
    notarized: false,
    installed: false,
    serviceRegistered: false,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}

function exactLine(output: string, prefix: string): string {
  const lines = output.split(/\r?\n/u).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return fail('app-signature-output-rejected');
  const value = lines[0]!.slice(prefix.length);
  if (value.length < 1 || value.length > 1_024) {
    return fail('app-signature-output-rejected');
  }
  return value;
}

function codeFlags(output: string): bigint {
  const lines = output.split(/\r?\n/u).filter(line => line.startsWith('CodeDirectory '));
  if (lines.length !== 1) return fail('app-signature-output-rejected');
  const match = /(?:^|\s)flags=0x([0-9a-fA-F]+)(?:\([^\r\n]*\))?(?:\s|$)/u.exec(lines[0]!);
  if (match === null) return fail('app-signature-output-rejected');
  try {
    return BigInt(`0x${match[1]!}`);
  } catch {
    return fail('app-signature-output-rejected');
  }
}

function verifyAppInspection(
  output: string,
  layout: Readonly<MacOSRuntimeProductionAppLayout>,
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
): void {
  const identity = resolution.identity!;
  if (exactLine(output, 'Executable=') !== layout.appExecutablePath
    || exactLine(output, 'Identifier=') !== MACOS_RUNTIME_BROKER_APP_IDENTIFIER
    || exactLine(output, 'Format=') !== 'app bundle with Mach-O thin (arm64)'
    || exactLine(output, 'Hash type=') !== 'sha256 size=32'
    || !/^[a-f0-9]{64}$/u.test(exactLine(output, 'CandidateCDHashFull sha256='))) {
    return fail('app-signature-output-rejected');
  }
  const signatures = output.split(/\r?\n/u).filter(line => /^Signature(?:=| )/u.test(line));
  if (signatures.length !== 1 || !/^Signature size=[1-9][0-9]*$/u.test(signatures[0]!)) {
    return fail('app-signature-output-rejected');
  }
  if (exactLine(output, 'TeamIdentifier=') !== identity.teamIdentifier) {
    return fail('app-production-team-unverified');
  }
  const authorities = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Authority='))
    .map(line => line.slice('Authority='.length));
  if (authorities.length !== 3
    || authorities[0] !== identity.commonName
    || authorities[1] !== 'Developer ID Certification Authority'
    || authorities[2] !== 'Apple Root CA') {
    return fail('app-developer-id-unverified');
  }
  const flags = codeFlags(output);
  if ((flags & AD_HOC_FLAG) !== 0n || (flags & HARDENED_RUNTIME_FLAG) === 0n) {
    return fail('app-hardened-runtime-required');
  }
  const timestamps = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Timestamp='))
    .map(line => line.slice('Timestamp='.length));
  if (timestamps.length !== 1
    || timestamps[0]!.length === 0
    || /^(?:none|not set)$/iu.test(timestamps[0]!)) {
    return fail('app-secure-timestamp-required');
  }
  const escapedKey = MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedValue = MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const entitlement = new RegExp(
    `<key>\\s*${escapedKey}\\s*</key>\\s*<string>\\s*${escapedValue}\\s*</string>`,
    'u',
  );
  if ((output.match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>`, 'gu')) ?? []).length !== 1
    || !entitlement.test(output)) {
    return fail('app-client-entitlement-unverified');
  }
}

function commandFailure(
  operation: MacOSRuntimeProductionAppSigningCommand['operation'],
): MacOSRuntimeProductionAppSigningReason {
  if (operation === 'sign-app') return 'app-sign-failed';
  if (operation.startsWith('sign-')) return 'nested-code-sign-failed';
  if (operation === 'verify-app' || operation === 'inspect-app') {
    return 'app-signature-unverified';
  }
  if (operation === 'require-app') return 'app-requirement-unverified';
  if (operation.startsWith('require-')) return 'nested-code-requirement-unverified';
  return 'nested-code-signature-unverified';
}

async function run(
  command: Readonly<MacOSRuntimeProductionAppSigningCommand>,
  dependencies: MacOSRuntimeProductionAppSigningExecutorDependencies,
): Promise<string> {
  let result: MacOSRuntimeProductionAppSigningCommandResult;
  try {
    result = await dependencies.runCodesign(command.args, Object.freeze({
      timeoutMs: MACOS_RUNTIME_PRODUCTION_APP_SIGNING_TIMEOUT_MS,
      maxOutputBytes: MACOS_RUNTIME_PRODUCTION_APP_SIGNING_MAX_OUTPUT_BYTES,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
    }));
  } catch {
    return fail(commandFailure(command.operation));
  }
  const byteCount = Buffer.byteLength(result.stdout, 'utf8')
    + Buffer.byteLength(result.stderr, 'utf8');
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
    return fail(commandFailure(command.operation));
  }
  if (byteCount > MACOS_RUNTIME_PRODUCTION_APP_SIGNING_MAX_OUTPUT_BYTES
    || result.stdout.includes('\0')
    || result.stderr.includes('\0')) {
    return fail('app-signature-output-rejected');
  }
  return `${result.stdout}\n${result.stderr}`;
}

export async function executeMacOSRuntimeProductionAppSigningForTest(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  layout: Readonly<MacOSRuntimeProductionAppLayout>,
  dependencies: MacOSRuntimeProductionAppSigningExecutorDependencies,
): Promise<Readonly<MacOSRuntimeProductionAppSigningReceipt>> {
  const state: MutableState = {
    nestedCodeSigned: 0,
    nestedCodeIntegrityVerified: 0,
    nestedCodeRequirementsVerified: 0,
    brokerIntegrityVerified: false,
    workerIntegrityVerified: false,
    appSigned: false,
    appIntegrityVerified: false,
    appInspectionVerified: false,
    appRequirementVerified: false,
    brokerRequirementVerified: false,
    workerRequirementVerified: false,
  };
  try {
    const plan = planMacOSRuntimeProductionAppSigning(resolution, layout);
    for (const command of plan.commands) {
      const output = await run(command, dependencies);
      if (command.operation === 'sign-api-sidecar'
        || command.operation === 'sign-use-mcp'
        || command.operation === 'sign-runtime-guard') state.nestedCodeSigned += 1;
      if (command.operation === 'verify-api-sidecar'
        || command.operation === 'verify-use-mcp'
        || command.operation === 'verify-runtime-guard') state.nestedCodeIntegrityVerified += 1;
      if (command.operation === 'require-api-sidecar'
        || command.operation === 'require-use-mcp'
        || command.operation === 'require-runtime-guard') state.nestedCodeRequirementsVerified += 1;
      if (command.operation === 'verify-broker') state.brokerIntegrityVerified = true;
      if (command.operation === 'verify-worker') state.workerIntegrityVerified = true;
      if (command.operation === 'sign-app') state.appSigned = true;
      if (command.operation === 'verify-app') state.appIntegrityVerified = true;
      if (command.operation === 'inspect-app') {
        verifyAppInspection(output, layout, resolution);
        state.appInspectionVerified = true;
      }
      if (command.operation === 'require-app') state.appRequirementVerified = true;
      if (command.operation === 'require-broker') state.brokerRequirementVerified = true;
      if (command.operation === 'require-worker') state.workerRequirementVerified = true;
    }
    return receipt('production-app-signed-and-verified', state);
  } catch (cause) {
    if (cause instanceof AppSigningFailure) return receipt(cause.reason, state);
    return receipt('app-signature-unverified', state);
  }
}

function strictUtf8(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

const defaultDependencies: MacOSRuntimeProductionAppSigningExecutorDependencies = Object.freeze({
  runCodesign(
    args: readonly string[],
    options: MacOSRuntimeProductionAppSigningCommandOptions,
  ): Promise<MacOSRuntimeProductionAppSigningCommandResult> {
    return new Promise(resolveRun => {
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

/** Shared bounded codesign transport; signing policy remains in each mode's planner. */
export const runMacOSAppCodesign = defaultDependencies.runCodesign;

export async function executeMacOSRuntimeProductionAppSigning(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  layout: Readonly<MacOSRuntimeProductionAppLayout>,
): Promise<Readonly<MacOSRuntimeProductionAppSigningReceipt>> {
  return executeMacOSRuntimeProductionAppSigningForTest(resolution, layout, defaultDependencies);
}
