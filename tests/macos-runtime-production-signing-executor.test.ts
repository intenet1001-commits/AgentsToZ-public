import { describe, expect, test } from 'bun:test';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';
import {
  executeMacOSRuntimeProductionArtifactSigningForTest,
  type MacOSRuntimeProductionSigningCommandResult,
  type MacOSRuntimeProductionSigningExecutorDependencies,
} from '../src/macOSRuntimeProductionSigningExecutor';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
  type MacOSRuntimeProductionArtifactLayout,
} from '../src/macOSRuntimeProductionSigningPlan';

const ROOT = '/private/tmp/agentstoz-runtime-production/artifacts';
const TEAM_ID = 'A1B2C3D4E5';
const COMMON_NAME = `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`;

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
      commonName: COMMON_NAME,
      teamIdentifier: TEAM_ID,
    },
  };
}

function layout(): MacOSRuntimeProductionArtifactLayout {
  return {
    artifactRoot: ROOT,
    brokerPath: `${ROOT}/bin/${MACOS_RUNTIME_PRODUCTION_BROKER_NAME}`,
    dedicatedWorkerPath: `${ROOT}/bin/${MACOS_RUNTIME_PRODUCTION_WORKER_NAME}`,
    brokerEntitlementsPath: `${ROOT}/Config/BrokerService.entitlements`,
  };
}

function inspection(path: string, identifier: string, overrides: {
  team?: string;
  authority?: string;
  flags?: string;
  timestamp?: string;
} = {}): string {
  return [
    `Executable=${path}`,
    `Identifier=${identifier}`,
    'Format=Mach-O thin (arm64)',
    `CodeDirectory v=20500 size=100 flags=${overrides.flags ?? '0x10000(runtime)'} hashes=1+0 location=embedded`,
    'Hash type=sha256 size=32',
    `CandidateCDHashFull sha256=${'a'.repeat(64)}`,
    'Signature size=1200',
    `Authority=${overrides.authority ?? COMMON_NAME}`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `Timestamp=${overrides.timestamp ?? 'Sep 5, 2026 at 12:00:00'}`,
    `TeamIdentifier=${overrides.team ?? TEAM_ID}`,
  ].join('\n');
}

function success(stderr = ''): MacOSRuntimeProductionSigningCommandResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr,
    timedOut: false,
    outputTruncated: false,
  };
}

class Host implements MacOSRuntimeProductionSigningExecutorDependencies {
  index = 0;
  calls: readonly string[][] = [];
  results: MacOSRuntimeProductionSigningCommandResult[] = [
    success(),
    success(),
    success(),
    success(),
    success(inspection(
      `${ROOT}/bin/${MACOS_RUNTIME_PRODUCTION_BROKER_NAME}`,
      MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
    )),
    success(inspection(
      `${ROOT}/bin/${MACOS_RUNTIME_PRODUCTION_WORKER_NAME}`,
      MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
    )),
    success(),
    success(),
  ];

  async runCodesign(args: readonly string[]) {
    this.calls = [...this.calls, [...args]];
    return this.results[this.index++] ?? success();
  }
}

describe('macOS runtime production signing executor', () => {
  test('executes and re-parses all eight planned signing operations without granting readiness', async () => {
    const host = new Host();
    const result = await executeMacOSRuntimeProductionArtifactSigningForTest(
      resolution(),
      layout(),
      host,
    );
    expect(result).toEqual({
      schemaVersion: 1,
      kind: 'macos-runtime-production-signing-execution',
      result: 'verified',
      reason: 'production-artifacts-signed-and-verified',
      brokerSigned: true,
      workerSigned: true,
      brokerIntegrityVerified: true,
      workerIntegrityVerified: true,
      brokerInspectionVerified: true,
      workerInspectionVerified: true,
      brokerRequirementVerified: true,
      workerRequirementVerified: true,
      appSigned: false,
      notarized: false,
      installed: false,
      authoritative: false,
      reusable: false,
      ready: false,
    });
    expect(host.calls).toHaveLength(8);
  });

  test('rejects mismatched team, authority, flags, timestamp, and malformed display output', async () => {
    const cases = [
      { value: inspection(layout().brokerPath, MACOS_RUNTIME_PRODUCTION_BROKER_NAME, { team: 'F6G7H8J9K0' }), reason: 'artifact-production-team-unverified' },
      { value: inspection(layout().brokerPath, MACOS_RUNTIME_PRODUCTION_BROKER_NAME, { authority: 'Wrong leaf' }), reason: 'artifact-developer-id-unverified' },
      { value: inspection(layout().brokerPath, MACOS_RUNTIME_PRODUCTION_BROKER_NAME, { flags: '0x2(adhoc)' }), reason: 'artifact-hardened-runtime-required' },
      { value: inspection(layout().brokerPath, MACOS_RUNTIME_PRODUCTION_BROKER_NAME, { timestamp: 'none' }), reason: 'artifact-secure-timestamp-required' },
      { value: 'malformed', reason: 'artifact-signature-output-rejected' },
    ] as const;
    for (const testCase of cases) {
      const host = new Host();
      host.results[4] = success(testCase.value);
      const result = await executeMacOSRuntimeProductionArtifactSigningForTest(
        resolution(),
        layout(),
        host,
      );
      expect(result.reason).toBe(testCase.reason);
      expect(result.ready).toBeFalse();
      expect(host.calls).toHaveLength(5);
    }
  });

  test('keeps partial progress explicit and stops at the first command failure', async () => {
    const signFailure = new Host();
    signFailure.results[0] = { ...success(), exitCode: 1 };
    const failedSign = await executeMacOSRuntimeProductionArtifactSigningForTest(
      resolution(), layout(), signFailure,
    );
    expect(failedSign.reason).toBe('artifact-sign-failed');
    expect(failedSign.brokerSigned).toBeFalse();
    expect(signFailure.calls).toHaveLength(1);

    const requirementFailure = new Host();
    requirementFailure.results[6] = { ...success(), timedOut: true };
    const failedRequirement = await executeMacOSRuntimeProductionArtifactSigningForTest(
      resolution(), layout(), requirementFailure,
    );
    expect(failedRequirement.reason).toBe('artifact-requirement-unverified');
    expect(failedRequirement.brokerIntegrityVerified).toBeTrue();
    expect(failedRequirement.workerIntegrityVerified).toBeTrue();
    expect(failedRequirement.brokerInspectionVerified).toBeTrue();
    expect(failedRequirement.workerInspectionVerified).toBeTrue();
    expect(failedRequirement.brokerRequirementVerified).toBeFalse();
    expect(requirementFailure.calls).toHaveLength(7);
  });
});
