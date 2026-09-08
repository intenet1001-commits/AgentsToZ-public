import { describe, expect, test } from 'bun:test';
import {
  MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER,
  MACOS_RUNTIME_PRODUCTION_CANARY_MAX_OUTPUT_BYTES,
  MACOS_RUNTIME_PRODUCTION_CANARY_TIMEOUT_MS,
  inspectMacOSRuntimeProductionSigningCanaryForTest,
  type MacOSRuntimeProductionCanaryCommandOptions,
  type MacOSRuntimeProductionCanaryCommandResult,
  type MacOSRuntimeProductionCanaryDependencies,
  type MacOSRuntimeProductionCanaryReason,
  type MacOSRuntimeProductionCanaryStage,
} from '../src/macOSRuntimeProductionCanary';
import type { MacOSRuntimeProductionIdentityResolution } from '../src/macOSRuntimeProductionIdentity';

const TEAM_ID = 'A1B2C3D4E5';
const COMMON_NAME = `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`;
const FINGERPRINT = 'A'.repeat(40);
const CANARY_PATH = '/private/tmp/test-canary/agentstoz-runtime-signing-canary';

function identityResolution(): Readonly<MacOSRuntimeProductionIdentityResolution> {
  return Object.freeze({
    diagnostic: Object.freeze({
      schemaVersion: 1,
      kind: 'macos-runtime-production-identity',
      scope: 'build-keychain-snapshot-only',
      result: 'snapshot-verified',
      reason: 'identity-snapshot-verified',
      authoritative: false,
      reusable: false,
      ready: false,
    }),
    identity: Object.freeze({
      certificateFingerprint: FINGERPRINT,
      commonName: COMMON_NAME,
      teamIdentifier: TEAM_ID,
    }),
  });
}

function commandResult(
  stdout = '',
  stderr = '',
  overrides: Partial<MacOSRuntimeProductionCanaryCommandResult> = {},
): MacOSRuntimeProductionCanaryCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

function details(overrides: {
  format?: string;
  team?: string;
  authorities?: readonly string[];
  flags?: string;
  timestamp?: string;
} = {}): string {
  const authorities = overrides.authorities ?? [
    COMMON_NAME,
    'Developer ID Certification Authority',
    'Apple Root CA',
  ];
  return [
    `Executable=${CANARY_PATH}`,
    `Identifier=${MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER}`,
    `Format=${overrides.format ?? 'Mach-O thin (arm64)'}`,
    `CodeDirectory v=20500 size=100 flags=${overrides.flags ?? '0x10000(runtime)'} hashes=1+0 location=embedded`,
    'Hash type=sha256 size=32',
    `CandidateCDHashFull sha256=${'a'.repeat(64)}`,
    'Signature size=1234',
    ...authorities.map(value => `Authority=${value}`),
    `Timestamp=${overrides.timestamp ?? 'Sep 5, 2026 at 12:00:00'}`,
    `TeamIdentifier=${overrides.team ?? TEAM_ID}`,
  ].join('\n');
}

class Host implements MacOSRuntimeProductionCanaryDependencies {
  identity = identityResolution();
  stage: MacOSRuntimeProductionCanaryStage = {
    scratchRoot: '/private/tmp/test-canary',
    executablePath: CANARY_PATH,
  };
  createError = false;
  removeError = false;
  callIndex = 0;
  results: MacOSRuntimeProductionCanaryCommandResult[] = [
    commandResult(),
    commandResult(),
    commandResult('', details()),
    commandResult(),
  ];
  calls: Array<{
    args: readonly string[];
    options: MacOSRuntimeProductionCanaryCommandOptions;
  }> = [];
  removed: MacOSRuntimeProductionCanaryStage[] = [];

  async resolveIdentity() {
    return this.identity;
  }

  async createCanary() {
    if (this.createError) throw new Error('create failed');
    return this.stage;
  }

  async removeCanary(stage: Readonly<MacOSRuntimeProductionCanaryStage>) {
    this.removed.push(stage);
    if (this.removeError) throw new Error('remove failed');
  }

  async runCodesign(
    args: readonly string[],
    options: MacOSRuntimeProductionCanaryCommandOptions,
  ) {
    this.calls.push({ args, options });
    return this.results[this.callIndex++] ?? commandResult();
  }
}

describe('macOS production signing canary', () => {
  test('proves key possession and exact Developer ID properties without granting runtime authority', async () => {
    const host = new Host();
    const result = await inspectMacOSRuntimeProductionSigningCanaryForTest(host, 'darwin');
    expect(result).toEqual({
      schemaVersion: 1,
      kind: 'macos-runtime-production-signing-canary',
      scope: 'build-key-possession-snapshot-only',
      result: 'snapshot-verified',
      reason: 'canary-snapshot-verified',
      authoritative: false,
      reusable: false,
      ready: false,
    });
    expect(host.calls).toHaveLength(4);
    expect(host.calls[0]!.args).toEqual([
      '--force', '--sign', FINGERPRINT,
      '--identifier', MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER,
      '--options', 'runtime', '--timestamp', CANARY_PATH,
    ]);
    expect(host.calls[3]!.args).toContain(
      `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM_ID}" and identifier "${MACOS_RUNTIME_PRODUCTION_CANARY_IDENTIFIER}"`,
    );
    for (const call of host.calls) {
      expect(call.options).toEqual({
        timeoutMs: MACOS_RUNTIME_PRODUCTION_CANARY_TIMEOUT_MS,
        maxOutputBytes: MACOS_RUNTIME_PRODUCTION_CANARY_MAX_OUTPUT_BYTES,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
    }
    expect(host.removed).toEqual([host.stage]);
    expect(JSON.stringify(result)).not.toContain(TEAM_ID);
    expect(JSON.stringify(result)).not.toContain(FINGERPRINT);
  });

  test('accepts system canary arm64e and universal formats with all-slice signature checks', async () => {
    for (const format of [
      'Mach-O thin (arm64e)',
      'Mach-O universal (x86_64 arm64)',
      'Mach-O universal (x86_64 arm64e)',
    ]) {
      const host = new Host();
      host.results[2] = commandResult('', details({ format }));
      expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(host, 'darwin')).reason)
        .toBe('canary-snapshot-verified');
      expect(host.calls[1]!.args).toContain('--all-architectures');
      expect(host.calls[3]!.args).toContain('--all-architectures');
      host.callIndex = 0;
      host.results[3] = commandResult('', '', { exitCode: 1 });
      expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(host, 'darwin')).reason)
        .toBe('canary-requirement-unverified');
    }
  });

  test('rejects unknown or ambiguous canary formats', async () => {
    for (const format of [
      'Mach-O thin (unknown)',
      'Mach-O universal (x86_64 arm64e unknown)',
      'Mach-O universal (x86_64 arm64e) extra',
      'Mach-O thin (arm64)\nFormat=Mach-O universal (x86_64 arm64e)',
      'app bundle with Mach-O thin (arm64)',
    ]) {
      const host = new Host();
      host.results[2] = commandResult('', details({ format }));
      expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(host, 'darwin')).reason)
        .toBe('canary-signature-output-rejected');
    }
  });

  test('requires exact team, authority chain, hardened runtime, and secure timestamp', async () => {
    const cases: Array<{
      value: string;
      reason: MacOSRuntimeProductionCanaryReason;
    }> = [
      { value: details({ team: 'F6G7H8J9K0' }), reason: 'production-team-unverified' },
      {
        value: details({ authorities: [COMMON_NAME, 'Wrong CA', 'Apple Root CA'] }),
        reason: 'developer-id-unverified',
      },
      { value: details({ flags: '0x0(none)' }), reason: 'hardened-runtime-required' },
      { value: details({ flags: '0x10002(adhoc,runtime)' }), reason: 'hardened-runtime-required' },
      { value: details({ timestamp: 'none' }), reason: 'secure-timestamp-required' },
    ];
    for (const testCase of cases) {
      const host = new Host();
      host.results[2] = commandResult('', testCase.value);
      const result = await inspectMacOSRuntimeProductionSigningCanaryForTest(host, 'darwin');
      expect(result.reason).toBe(testCase.reason);
      expect(result.ready).toBeFalse();
      expect(host.removed).toHaveLength(1);
    }
  });

  test('fails closed for missing identity, unsupported platform, and staging failure', async () => {
    const missing = new Host();
    missing.identity = Object.freeze({
      diagnostic: Object.freeze({
        schemaVersion: 1,
        kind: 'macos-runtime-production-identity',
        scope: 'build-keychain-snapshot-only',
        result: 'not-verified',
        reason: 'developer-id-application-missing',
        authoritative: false,
        reusable: false,
        ready: false,
      }),
      identity: null,
    });
    expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(missing, 'darwin')).reason)
      .toBe('production-identity-unavailable');
    expect(missing.calls).toHaveLength(0);

    const unsupported = new Host();
    expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(unsupported, 'linux')).reason)
      .toBe('platform-unsupported');
    expect(unsupported.calls).toHaveLength(0);

    const staging = new Host();
    staging.createError = true;
    expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(staging, 'darwin')).reason)
      .toBe('canary-stage-failed');

    const malformedIdentity = new Host();
    malformedIdentity.identity = Object.freeze({
      ...identityResolution(),
      identity: Object.freeze({
        certificateFingerprint: 'not-a-fingerprint',
        commonName: COMMON_NAME,
        teamIdentifier: TEAM_ID,
      }),
    });
    expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(
      malformedIdentity,
      'darwin',
    )).reason).toBe('production-identity-unavailable');
    expect(malformedIdentity.calls).toHaveLength(0);

    const redirectedStage = new Host();
    redirectedStage.stage = {
      scratchRoot: '/private/tmp/test-canary',
      executablePath: '/private/tmp/other-canary',
    };
    expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(
      redirectedStage,
      'darwin',
    )).reason).toBe('canary-stage-failed');
    expect(redirectedStage.calls).toHaveLength(0);
    expect(redirectedStage.removed).toHaveLength(1);
  });

  test('separates signing, inspection, requirement, and cleanup failures', async () => {
    const cases: Array<{
      index: number;
      next: MacOSRuntimeProductionCanaryCommandResult;
      reason: MacOSRuntimeProductionCanaryReason;
    }> = [
      { index: 0, next: commandResult('', '', { exitCode: 1 }), reason: 'canary-sign-failed' },
      {
        index: 1,
        next: commandResult('', '', { timedOut: true }),
        reason: 'canary-signature-output-rejected',
      },
      {
        index: 2,
        next: commandResult('', '', { outputTruncated: true }),
        reason: 'canary-signature-output-rejected',
      },
      {
        index: 3,
        next: commandResult('', '', { exitCode: 1 }),
        reason: 'canary-requirement-unverified',
      },
    ];
    for (const testCase of cases) {
      const host = new Host();
      host.results[testCase.index] = testCase.next;
      const result = await inspectMacOSRuntimeProductionSigningCanaryForTest(host, 'darwin');
      expect(result.reason).toBe(testCase.reason);
      expect(host.removed).toHaveLength(1);
    }

    const cleanup = new Host();
    cleanup.removeError = true;
    expect((await inspectMacOSRuntimeProductionSigningCanaryForTest(cleanup, 'darwin')).reason)
      .toBe('canary-cleanup-failed');
  });
});
