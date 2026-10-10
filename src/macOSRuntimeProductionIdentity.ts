import { execFile } from 'node:child_process';

export const MACOS_RUNTIME_PRODUCTION_IDENTITY_SCHEMA_VERSION = 1 as const;
export const MACOS_RUNTIME_SECURITY_PATH = '/usr/bin/security' as const;
export const MACOS_RUNTIME_IDENTITY_DISCOVERY_TIMEOUT_MS = 5_000 as const;
export const MACOS_RUNTIME_IDENTITY_DISCOVERY_MAX_OUTPUT_BYTES = 32 * 1024;

export type MacOSRuntimeProductionIdentityReason =
  | 'identity-snapshot-verified'
  | 'platform-unsupported'
  | 'identity-command-failed'
  | 'identity-output-rejected'
  | 'developer-id-application-missing'
  | 'developer-id-application-ambiguous'
  | 'production-team-rejected';

export interface MacOSRuntimeProductionIdentityDiagnostic {
  readonly schemaVersion: typeof MACOS_RUNTIME_PRODUCTION_IDENTITY_SCHEMA_VERSION;
  readonly kind: 'macos-runtime-production-identity';
  readonly scope: 'build-keychain-snapshot-only';
  readonly result: 'snapshot-verified' | 'not-verified';
  readonly reason: MacOSRuntimeProductionIdentityReason;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeProductionIdentity {
  /** SHA-1 certificate identity understood by codesign; never put in a public DTO. */
  readonly certificateFingerprint: string;
  /** Exact certificate subject common name; never accepted from argv or environment. */
  readonly commonName: string;
  /** Certificate subject OU parsed from the exact Developer ID Application name. */
  readonly teamIdentifier: string;
}

export interface MacOSRuntimeIdentityCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface MacOSRuntimeProductionIdentityDependencies {
  runSecurity(
    args: readonly string[],
    options: MacOSRuntimeIdentityCommandOptions,
  ): Promise<MacOSRuntimeIdentityCommandResult>;
}

export interface MacOSRuntimeIdentityCommandOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface MacOSRuntimeProductionIdentityResolution {
  readonly diagnostic: Readonly<MacOSRuntimeProductionIdentityDiagnostic>;
  readonly identity: Readonly<MacOSRuntimeProductionIdentity> | null;
}

interface ParsedIdentityLine {
  readonly certificateFingerprint: string;
  readonly commonName: string;
}

function diagnostic(
  reason: MacOSRuntimeProductionIdentityReason,
): Readonly<MacOSRuntimeProductionIdentityDiagnostic> {
  return Object.freeze({
    schemaVersion: MACOS_RUNTIME_PRODUCTION_IDENTITY_SCHEMA_VERSION,
    kind: 'macos-runtime-production-identity',
    scope: 'build-keychain-snapshot-only',
    result: reason === 'identity-snapshot-verified' ? 'snapshot-verified' : 'not-verified',
    reason,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}

function unavailable(
  reason: Exclude<MacOSRuntimeProductionIdentityReason, 'identity-snapshot-verified'>,
): Readonly<MacOSRuntimeProductionIdentityResolution> {
  return Object.freeze({ diagnostic: diagnostic(reason), identity: null });
}

function validTeamIdentifier(value: string): boolean {
  if (!/^[A-Z0-9]{10}$/u.test(value)) return false;
  if (new Set(value).size === 1) return false;
  return !new Set([
    'ABCDEFGHIJ', '1234567890', 'TEAMID1234', 'YOURTEAMID', 'XXXXXXXXXX',
  ]).has(value);
}

function parseSecurityOutput(
  output: string,
): { identities: readonly ParsedIdentityLine[]; total: number } | null {
  if (output.includes('\0') || Buffer.byteLength(output, 'utf8') > MACOS_RUNTIME_IDENTITY_DISCOVERY_MAX_OUTPUT_BYTES) {
    return null;
  }
  const lines = output.split(/\r?\n/u).filter(line => line.trim().length > 0);
  const identities: ParsedIdentityLine[] = [];
  let total: number | null = null;
  for (const line of lines) {
    const identityMatch = /^\s*\d+\) ([0-9A-F]{40}) "([^"\r\n]{1,512})"\s*$/u.exec(line);
    if (identityMatch !== null) {
      identities.push(Object.freeze({
        certificateFingerprint: identityMatch[1]!,
        commonName: identityMatch[2]!,
      }));
      continue;
    }
    const summaryMatch = /^\s*(\d+) valid identities found\s*$/u.exec(line);
    if (summaryMatch === null || total !== null) return null;
    const parsed = Number(summaryMatch[1]);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_024) return null;
    total = parsed;
  }
  if (total === null || total !== identities.length) return null;
  if (new Set(identities.map(value => value.certificateFingerprint)).size !== identities.length) {
    return null;
  }
  return { identities: Object.freeze(identities), total };
}

function developerIDApplication(
  value: ParsedIdentityLine,
): Readonly<MacOSRuntimeProductionIdentity> | null {
  const match = /^Developer ID Application: ([^\u0000-\u001F\u007F]{1,300}) \(([A-Z0-9]{10})\)$/u
    .exec(value.commonName);
  if (match === null || !validTeamIdentifier(match[2]!)) return null;
  return Object.freeze({
    certificateFingerprint: value.certificateFingerprint,
    commonName: value.commonName,
    teamIdentifier: match[2]!,
  });
}

export async function resolveMacOSRuntimeProductionIdentity(
  dependencies: MacOSRuntimeProductionIdentityDependencies = defaultDependencies,
  platform: NodeJS.Platform = process.platform,
): Promise<Readonly<MacOSRuntimeProductionIdentityResolution>> {
  if (platform !== 'darwin') return unavailable('platform-unsupported');
  let result: MacOSRuntimeIdentityCommandResult;
  try {
    result = await dependencies.runSecurity(
      Object.freeze(['find-identity', '-v', '-p', 'codesigning']),
      Object.freeze({
        timeoutMs: MACOS_RUNTIME_IDENTITY_DISCOVERY_TIMEOUT_MS,
        maxOutputBytes: MACOS_RUNTIME_IDENTITY_DISCOVERY_MAX_OUTPUT_BYTES,
        env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
      }),
    );
  } catch {
    return unavailable('identity-command-failed');
  }
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.stderr !== '') {
    return unavailable('identity-command-failed');
  }
  const parsed = parseSecurityOutput(result.stdout);
  if (parsed === null) return unavailable('identity-output-rejected');
  const prefixed = parsed.identities.filter(value =>
    value.commonName.startsWith('Developer ID Application: '));
  const candidates = prefixed
    .map(developerIDApplication)
    .filter((value): value is Readonly<MacOSRuntimeProductionIdentity> => value !== null);
  if (prefixed.length > 0 && candidates.length !== prefixed.length) {
    return unavailable('production-team-rejected');
  }
  if (candidates.length === 0) return unavailable('developer-id-application-missing');
  if (candidates.length !== 1) return unavailable('developer-id-application-ambiguous');
  return Object.freeze({
    diagnostic: diagnostic('identity-snapshot-verified'),
    identity: candidates[0]!,
  });
}

export async function inspectMacOSRuntimeProductionIdentity(): Promise<
  Readonly<MacOSRuntimeProductionIdentityDiagnostic>
> {
  return (await resolveMacOSRuntimeProductionIdentity()).diagnostic;
}

const defaultDependencies: MacOSRuntimeProductionIdentityDependencies = Object.freeze({
  runSecurity(
    args: readonly string[],
    options: MacOSRuntimeIdentityCommandOptions,
  ): Promise<MacOSRuntimeIdentityCommandResult> {
    return new Promise<MacOSRuntimeIdentityCommandResult>(resolve => {
      execFile(
        MACOS_RUNTIME_SECURITY_PATH,
        [...args],
        {
          cwd: '/',
          encoding: 'buffer',
          env: options.env,
          maxBuffer: options.maxOutputBytes,
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const commandError = error as (NodeJS.ErrnoException & {
            code?: string | number;
            killed?: boolean;
          }) | null;
          const code = commandError !== null && typeof commandError.code === 'number'
            ? commandError.code
            : error === null ? 0 : null;
          let normalizedStdout = '';
          let normalizedStderr = '';
          let invalidEncoding = false;
          try {
            normalizedStdout = new TextDecoder('utf-8', { fatal: true })
              .decode(Buffer.from(stdout));
            normalizedStderr = new TextDecoder('utf-8', { fatal: true })
              .decode(Buffer.from(stderr));
          } catch {
            invalidEncoding = true;
          }
          const combinedOutputBytes = Buffer.byteLength(normalizedStdout, 'utf8')
            + Buffer.byteLength(normalizedStderr, 'utf8');
          resolve(Object.freeze({
            exitCode: code,
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            timedOut: commandError?.killed === true,
            outputTruncated: commandError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              || combinedOutputBytes > options.maxOutputBytes
              || invalidEncoding,
          }));
        },
      );
    });
  },
});
