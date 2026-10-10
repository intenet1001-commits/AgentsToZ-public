import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';
import {
  executeMacOSRuntimeProductionAppSigningForTest,
  type MacOSRuntimeProductionAppSigningCommandResult,
} from '../src/macOSRuntimeProductionAppSigningExecutor';
import type { MacOSRuntimeProductionAppLayout } from '../src/macOSRuntimeProductionAppSigningPlan';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
} from '../src/macOSRuntimeProductionSigningPlan';

const TEAM = 'Q1W2E3R4T5';

function identity(): MacOSRuntimeProductionBuildIdentityResolution {
  return {
    identity: {
      commonName: `Developer ID Application: Example (${TEAM})`,
      teamIdentifier: TEAM,
      certificateFingerprint: 'A'.repeat(40),
    },
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
  };
}

function layout(): MacOSRuntimeProductionAppLayout {
  const root = '/private/tmp/agentstoz-production';
  const appBundlePath = join(root, 'AgentsToZ_byCS.app');
  const resources = join(appBundlePath, 'Contents', 'Resources', 'resources');
  const services = join(appBundlePath, 'Contents', 'Library', 'LaunchServices');
  return {
    appBundlePath,
    appExecutablePath: join(appBundlePath, 'Contents', 'MacOS', 'app'),
    apiSidecarPath: join(resources, 'agentstoz-api-sidecar'),
    useMcpPath: join(resources, 'agentstoz-use-mcp'),
    runtimeGuardPath: join(resources, 'agentstoz-agent-runtime-guard'),
    brokerPath: join(services, MACOS_RUNTIME_PRODUCTION_BROKER_NAME),
    dedicatedWorkerPath: join(services, MACOS_RUNTIME_PRODUCTION_WORKER_NAME),
    appEntitlementsPath: join(root, 'Config', 'AppClient.entitlements'),
  };
}

function result(overrides: Partial<MacOSRuntimeProductionAppSigningCommandResult> = {}) {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

function appInspection(target: MacOSRuntimeProductionAppLayout, team = TEAM): string {
  return [
    `Executable=${target.appExecutablePath}`,
    'Identifier=com.intenet.agentstozbycs',
    'Format=app bundle with Mach-O thin (arm64)',
    'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+1 location=embedded',
    'Hash type=sha256 size=32',
    `CandidateCDHashFull sha256=${'ab'.repeat(32)}`,
    'Signature size=9000',
    `Authority=Developer ID Application: Example (${TEAM})`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${team}`,
    'Timestamp=Sep 5, 2026 at 12:00:00',
    '<plist><dict>',
    '<key>com.intenet.agentstozbycs.runtime-broker.client</key>',
    '<string>client-v1</string>',
    '</dict></plist>',
  ].join('\n');
}

describe('macOS runtime production app signing executor', () => {
  test('executes all seventeen operations and returns only a non-authoritative signing receipt', async () => {
    const target = layout();
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const receipt = await executeMacOSRuntimeProductionAppSigningForTest(
      identity(),
      target,
      {
        async runCodesign(args) {
          mutableCalls.push([...args]);
          return result(args.includes('--display')
            ? { stderr: appInspection(target) }
            : {});
        },
      },
    );
    expect(calls).toHaveLength(17);
    expect(receipt.result).toBe('verified');
    expect(receipt.nestedCodeSigned).toBe(3);
    expect(receipt.nestedCodeIntegrityVerified).toBe(3);
    expect(receipt.nestedCodeRequirementsVerified).toBe(3);
    expect(receipt.appSigned).toBe(true);
    expect(receipt.appInspectionVerified).toBe(true);
    expect(receipt.authoritative).toBe(false);
    expect(receipt.ready).toBe(false);
  });

  test('stops at app signing failure while retaining exact nested progress', async () => {
    let call = 0;
    const receipt = await executeMacOSRuntimeProductionAppSigningForTest(
      identity(),
      layout(),
      {
        async runCodesign() {
          call += 1;
          return result(call === 12 ? { exitCode: 1 } : {});
        },
      },
    );
    expect(receipt.reason).toBe('app-sign-failed');
    expect(receipt.nestedCodeSigned).toBe(3);
    expect(receipt.nestedCodeRequirementsVerified).toBe(3);
    expect(receipt.brokerIntegrityVerified).toBe(true);
    expect(receipt.workerIntegrityVerified).toBe(true);
    expect(receipt.appSigned).toBe(false);
  });

  test('rejects wrong Team ID and malformed client entitlement after outer signing', async () => {
    const target = layout();
    for (const inspection of [
      appInspection(target, 'Z9Y8X7W6V5'),
      appInspection(target).replace('<string>client-v1</string>', '<string>wrong</string>'),
    ]) {
      const receipt = await executeMacOSRuntimeProductionAppSigningForTest(
        identity(),
        target,
        {
          async runCodesign(args) {
            return result(args.includes('--display') ? { stdout: inspection } : {});
          },
        },
      );
      expect(receipt.result).toBe('not-verified');
      expect(receipt.appInspectionVerified).toBe(false);
    }
  });
});
