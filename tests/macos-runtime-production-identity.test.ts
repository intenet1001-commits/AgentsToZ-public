import { describe, expect, test } from 'bun:test';
import {
  MACOS_RUNTIME_IDENTITY_DISCOVERY_MAX_OUTPUT_BYTES,
  MACOS_RUNTIME_IDENTITY_DISCOVERY_TIMEOUT_MS,
  resolveMacOSRuntimeProductionIdentity,
  type MacOSRuntimeIdentityCommandOptions,
  type MacOSRuntimeIdentityCommandResult,
  type MacOSRuntimeProductionIdentityDependencies,
} from '../src/macOSRuntimeProductionIdentity';

const FINGERPRINT = 'A'.repeat(40);
const TEAM_ID = 'A1B2C3D4E5';

function output(...names: string[]): string {
  return `${names.map((name, index) => `  ${index + 1}) ${String.fromCharCode(65 + index).repeat(40)} "${name}"`).join('\n')}\n     ${names.length} valid identities found\n`;
}

function result(stdout: string, overrides: Partial<MacOSRuntimeIdentityCommandResult> = {}) {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

class Host implements MacOSRuntimeProductionIdentityDependencies {
  calls: Array<{
    args: readonly string[];
    options: MacOSRuntimeIdentityCommandOptions;
  }> = [];
  next = result(output());

  async runSecurity(args: readonly string[], options: MacOSRuntimeIdentityCommandOptions) {
    this.calls.push({ args, options });
    return this.next;
  }
}

describe('macOS production Developer ID identity discovery', () => {
  test('selects exactly one real-shaped Developer ID Application without exposing it in diagnostics', async () => {
    const host = new Host();
    host.next = result(output(
      `Apple Development: Local Builder (${TEAM_ID})`,
      `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`,
    ));
    const resolved = await resolveMacOSRuntimeProductionIdentity(host, 'darwin');
    expect(resolved.diagnostic).toEqual({
      schemaVersion: 1,
      kind: 'macos-runtime-production-identity',
      scope: 'build-keychain-snapshot-only',
      result: 'snapshot-verified',
      reason: 'identity-snapshot-verified',
      authoritative: false,
      reusable: false,
      ready: false,
    });
    expect(resolved.identity).toEqual({
      certificateFingerprint: 'B'.repeat(40),
      commonName: `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`,
      teamIdentifier: TEAM_ID,
    });
    expect(JSON.stringify(resolved.diagnostic)).not.toContain(TEAM_ID);
    expect(JSON.stringify(resolved.diagnostic)).not.toContain('AgentsToZ Builder');
    expect(host.calls).toEqual([{
      args: ['find-identity', '-v', '-p', 'codesigning'],
      options: {
        timeoutMs: MACOS_RUNTIME_IDENTITY_DISCOVERY_TIMEOUT_MS,
        maxOutputBytes: MACOS_RUNTIME_IDENTITY_DISCOVERY_MAX_OUTPUT_BYTES,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    }]);
  });

  test('reports this Mac missing an identity shape without treating the snapshot as readiness', async () => {
    const host = new Host();
    const resolved = await resolveMacOSRuntimeProductionIdentity(host, 'darwin');
    expect(resolved.identity).toBeNull();
    expect(resolved.diagnostic.reason).toBe('developer-id-application-missing');
    expect(resolved.diagnostic.ready).toBeFalse();
    expect(resolved.diagnostic.reusable).toBeFalse();
  });

  test('rejects ambiguous Developer ID Application identities instead of choosing by order', async () => {
    const host = new Host();
    host.next = result(output(
      `Developer ID Application: First (${TEAM_ID})`,
      'Developer ID Application: Second (F6G7H8J9K0)',
    ));
    const resolved = await resolveMacOSRuntimeProductionIdentity(host, 'darwin');
    expect(resolved.identity).toBeNull();
    expect(resolved.diagnostic.reason).toBe('developer-id-application-ambiguous');
  });

  test('rejects placeholders, malformed summaries, duplicate fingerprints, and unparsed lines', async () => {
    const cases = [
      output('Developer ID Application: Fake (ABCDEFGHIJ)'),
      `  1) ${FINGERPRINT} "Developer ID Application: Real (${TEAM_ID})"\n  2 valid identities found\n`,
      `  1) ${FINGERPRINT} "Developer ID Application: Real (${TEAM_ID})"\n  2) ${FINGERPRINT} "Apple Development: Same (${TEAM_ID})"\n  2 valid identities found\n`,
      `unexpected\n  0 valid identities found\n`,
      `  1) ${FINGERPRINT} "Developer ID Application: Missing Team"\n  1 valid identities found\n`,
    ];
    for (const value of cases) {
      const host = new Host();
      host.next = result(value);
      const resolved = await resolveMacOSRuntimeProductionIdentity(host, 'darwin');
      expect(resolved.identity).toBeNull();
      expect(resolved.diagnostic.result).toBe('not-verified');
    }
  });

  test('fails closed on command, timeout, output, stderr, and platform failures', async () => {
    for (const next of [
      result('', { exitCode: 1 }),
      result('', { timedOut: true }),
      result('', { outputTruncated: true }),
      result('', { stderr: 'private keychain diagnostic' }),
    ]) {
      const host = new Host();
      host.next = next;
      const resolved = await resolveMacOSRuntimeProductionIdentity(host, 'darwin');
      expect(resolved.identity).toBeNull();
      expect(resolved.diagnostic.reason).toBe('identity-command-failed');
    }
    const host = new Host();
    const unsupported = await resolveMacOSRuntimeProductionIdentity(host, 'linux');
    expect(unsupported.diagnostic.reason).toBe('platform-unsupported');
    expect(host.calls).toHaveLength(0);
  });
});
