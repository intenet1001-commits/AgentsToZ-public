import { describe, expect, test } from 'bun:test';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
  planMacOSRuntimeProductionArtifactSigning,
  type MacOSRuntimeProductionArtifactLayout,
} from '../src/macOSRuntimeProductionSigningPlan';

const TEAM_ID = 'A1B2C3D4E5';
const FINGERPRINT = 'A'.repeat(40);
const ROOT = '/private/tmp/agentstoz-runtime-production/artifacts';

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
      certificateFingerprint: FINGERPRINT,
      commonName: `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`,
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

describe('macOS runtime production signing command plan', () => {
  test('signs both inner artifacts before inspection and pins role requirements', () => {
    const plan = planMacOSRuntimeProductionArtifactSigning(resolution(), layout());
    expect(plan.commands.map(value => value.operation)).toEqual([
      'sign-broker',
      'sign-worker',
      'verify-broker',
      'verify-worker',
      'inspect-broker',
      'inspect-worker',
      'require-broker',
      'require-worker',
    ]);
    expect(plan.commands.every(value => value.executable === '/usr/bin/codesign')).toBeTrue();
    expect(plan.commands[0]!.args).toEqual([
      '--force', '--sign', FINGERPRINT,
      '--options', 'runtime', '--timestamp',
      '--identifier', MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
      '--entitlements', `${ROOT}/Config/BrokerService.entitlements`,
      `${ROOT}/bin/${MACOS_RUNTIME_PRODUCTION_BROKER_NAME}`,
    ]);
    expect(plan.commands[1]!.args).not.toContain('--entitlements');
    expect(plan.commands[6]!.args.join(' ')).toContain(
      'entitlement["com.intenet.agentstozbycs.runtime-broker.service"] = "service-v1"',
    );
    expect(plan.commands[7]!.args.join(' ')).not.toContain('entitlement[');
    expect(plan.commands[6]!.args.join(' ')).toContain(`subject.OU] = "${TEAM_ID}"`);
    expect(plan).toMatchObject({
      commandCount: 8,
      insideOutOrder: true,
      appSigned: false,
      notarized: false,
      installed: false,
      authoritative: false,
      reusable: false,
      ready: false,
    });
  });

  test('rejects a raw or stale identity before producing any command', () => {
    const verified = resolution();
    const missing: MacOSRuntimeProductionBuildIdentityResolution = {
      ...verified,
      identity: null,
    };
    expect(() => planMacOSRuntimeProductionArtifactSigning(missing, layout()))
      .toThrow('identity rejected');
    const stale: MacOSRuntimeProductionBuildIdentityResolution = {
      ...verified,
      diagnostic: { ...verified.diagnostic, result: 'not-verified' },
    };
    expect(() => planMacOSRuntimeProductionArtifactSigning(stale, layout()))
      .toThrow('identity rejected');
  });

  test('accepts only the exact scratch artifact layout', () => {
    for (const bad of [
      { ...layout(), artifactRoot: '/' },
      { ...layout(), brokerPath: `${ROOT}/bin/other` },
      { ...layout(), dedicatedWorkerPath: `${ROOT}/bin/other` },
      { ...layout(), brokerEntitlementsPath: `${ROOT}/Config/other.entitlements` },
      { ...layout(), artifactRoot: `${ROOT}\nredirected` },
    ]) {
      expect(() => planMacOSRuntimeProductionArtifactSigning(resolution(), bad))
        .toThrow('layout rejected');
    }
  });
});
