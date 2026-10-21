import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';
import {
  generateMacOSRuntimeProductionPinnedSources,
  type MacOSRuntimeProductionSourceInputs,
} from '../src/macOSRuntimeProductionSourcePin';

const TEAM_ID = 'A1B2C3D4E5';
const FINGERPRINT = 'A'.repeat(40);
const COMMON_NAME = `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`;

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function inputs(): MacOSRuntimeProductionSourceInputs {
  return {
    swiftContract: source(
      'src-tauri/native/macos-runtime/Sources/RuntimeBrokerProtocol/Contract.swift',
    ),
    swiftProtocolSelfTest: source(
      'src-tauri/native/macos-runtime/Sources/RuntimeBrokerProtocolSelfTest/main.swift',
    ),
    objectiveCClientBridge: source(
      'src-tauri/native/macos-runtime/ClientBridge/RuntimeBrokerClientBridge.m',
    ),
    typescriptSigningProbe: source('src/macOSRuntimeBrokerSigning.ts'),
  };
}

function resolution(
  overrides: Partial<MacOSRuntimeProductionBuildIdentityResolution> = {},
): MacOSRuntimeProductionBuildIdentityResolution {
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
      certificateFingerprint: FINGERPRINT,
      commonName: COMMON_NAME,
      teamIdentifier: TEAM_ID,
    },
    ...overrides,
  };
}

describe('macOS runtime production source pin generator', () => {
  test('pins all native and static-inspection peers from one canary result', () => {
    const original = inputs();
    const generated = generateMacOSRuntimeProductionPinnedSources(resolution(), original);
    expect(generated.sourceFilesPinned).toBe(4);
    expect(generated.swiftContract).toContain(
      `productionTeamIdentifier: String? = "${TEAM_ID}"`,
    );
    expect(generated.swiftProtocolSelfTest).toContain(
      `productionTeamIdentifier == "${TEAM_ID}"`,
    );
    expect(generated.swiftProtocolSelfTest).toContain(
      `validatedProductionTeamIdentifier() == "${TEAM_ID}"`,
    );
    expect(generated.objectiveCClientBridge).toContain(
      `AgentsToZProductionTeamIdentifier = @"${TEAM_ID}";`,
    );
    expect(generated.typescriptSigningProbe).toContain(
      `MACOS_RUNTIME_BROKER_GENERATED_TEAM_IDENTIFIER: string | null = "${TEAM_ID}";`,
    );
    for (const value of [
      generated.swiftContract,
      generated.swiftProtocolSelfTest,
      generated.objectiveCClientBridge,
      generated.typescriptSigningProbe,
    ]) {
      expect(value).not.toContain(FINGERPRINT);
      expect(value).not.toContain(COMMON_NAME);
    }
    expect(generated.identityFingerprintEmbedded).toBeFalse();
    expect(generated.certificateNameEmbedded).toBeFalse();
    expect(generated.runtimeAuthorityGranted).toBeFalse();
    expect(inputs()).toEqual(original);
  });

  test('rejects non-canary, malformed, and placeholder identities', () => {
    const rejected = [
      resolution({ identity: null }),
      resolution({
        diagnostic: { ...resolution().diagnostic, result: 'not-verified' },
      }),
      resolution({
        identity: {
          certificateFingerprint: 'bad',
          commonName: COMMON_NAME,
          teamIdentifier: TEAM_ID,
        },
      }),
      resolution({
        identity: {
          certificateFingerprint: FINGERPRINT,
          commonName: 'Developer ID Application: Fake (ABCDEFGHIJ)',
          teamIdentifier: 'ABCDEFGHIJ',
        },
      }),
    ];
    for (const value of rejected) {
      expect(() => generateMacOSRuntimeProductionPinnedSources(value, inputs()))
        .toThrow('identity rejected');
    }
  });

  test('requires each checked-in sentinel exactly once and never partially returns', () => {
    const original = inputs();
    expect(() => generateMacOSRuntimeProductionPinnedSources(resolution(), {
      ...original,
      swiftContract: original.swiftContract.replace(
        'public static let productionTeamIdentifier: String? = nil',
        'public static let productionTeamIdentifier: String? = "already-pinned"',
      ),
    })).toThrow('sentinel rejected');
    expect(() => generateMacOSRuntimeProductionPinnedSources(resolution(), {
      ...original,
      objectiveCClientBridge: `${original.objectiveCClientBridge}\nstatic NSString *const AgentsToZProductionTeamIdentifier = nil;`,
    })).toThrow('sentinel rejected');
  });
});
