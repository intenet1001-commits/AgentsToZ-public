import { describe, expect, test } from 'bun:test';
import { planSidecarBuild } from '../build-sidecar';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';

const TEAM_ID = 'A1B2C3D4E5';

function resolution(): MacOSRuntimeProductionBuildIdentityResolution {
  return {
    diagnostic: {
      schemaVersion: 1,
      kind: 'macos-runtime-production-signing-canary',
      scope: 'build-key-possession-snapshot-only',
      result: 'snapshot-verified',
      reason: 'canary-snapshot-verified',
      authoritative: false,
      reusable: false,
      ready: false,
    },
    identity: {
      certificateFingerprint: 'A'.repeat(40),
      commonName: `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`,
      teamIdentifier: TEAM_ID,
    },
  };
}

describe('sidecar build plan', () => {
  test('development builds contain no production Team ID define', () => {
    const plan = planSidecarBuild(
      { kind: 'development' },
      {
        projectRoot: '/private/tmp/agentstoz-source',
        platform: 'darwin',
        arch: 'arm64',
        bunExecutable: '/opt/bun/bin/bun',
      },
    );
    expect(plan.productionTeamIdentifierEmbedded).toBeFalse();
    expect(plan.commands).toHaveLength(3);
    expect(plan.commands.flatMap(command => command.args).join('\n'))
      .not.toContain('__AGENTSTOZ_MACOS_RUNTIME_PRODUCTION_TEAM_IDENTIFIER__');
  });

  test('production embeds the canary-verified Team ID only into the API sidecar', () => {
    const plan = planSidecarBuild(
      { kind: 'macos-runtime-production', identityResolution: resolution() },
      {
        projectRoot: '/private/tmp/agentstoz-source',
        platform: 'darwin',
        arch: 'arm64',
        bunExecutable: '/opt/bun/bin/bun',
      },
    );
    const marker = `__AGENTSTOZ_MACOS_RUNTIME_PRODUCTION_TEAM_IDENTIFIER__="${TEAM_ID}"`;
    expect(plan.productionTeamIdentifierEmbedded).toBeTrue();
    expect(plan.commands[0]!.args).toContain('--define');
    expect(plan.commands[0]!.args).toContain(marker);
    expect(plan.commands[1]!.args).not.toContain(marker);
    expect(plan.commands[2]!.args).not.toContain(marker);
    expect(plan.commands[2]!.args).toContain('--no-compile-autoload-dotenv');
    expect(plan.commands[2]!.args).toContain('--no-compile-autoload-bunfig');
  });

  test('production rejects unverified identity and non-Apple-Silicon targets', () => {
    const unverified = resolution();
    expect(() => planSidecarBuild({
      kind: 'macos-runtime-production',
      identityResolution: {
        ...unverified,
        diagnostic: { ...unverified.diagnostic, result: 'not-verified' },
      },
    }, { platform: 'darwin', arch: 'arm64' })).toThrow('identity rejected');
    expect(() => planSidecarBuild({
      kind: 'macos-runtime-production',
      identityResolution: resolution(),
    }, { platform: 'darwin', arch: 'x64' })).toThrow('identity rejected');
  });
});
