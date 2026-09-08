import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';
import {
  MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER,
  MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER,
  MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER,
  planMacOSRuntimeProductionAppSigning,
  type MacOSRuntimeProductionAppLayout,
} from '../src/macOSRuntimeProductionAppSigningPlan';
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

function layout(root = '/private/tmp/agentstoz-production'): MacOSRuntimeProductionAppLayout {
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

describe('macOS runtime production app signing plan', () => {
  test('signs nested sidecars before the outer app and uses deep only for final verification', () => {
    const target = layout();
    const plan = planMacOSRuntimeProductionAppSigning(identity(), target);
    expect(plan.commandCount).toBe(17);
    expect(plan.commands.map(command => command.operation)).toEqual([
      'sign-api-sidecar',
      'sign-use-mcp',
      'sign-runtime-guard',
      'verify-api-sidecar',
      'verify-use-mcp',
      'verify-runtime-guard',
      'require-api-sidecar',
      'require-use-mcp',
      'require-runtime-guard',
      'verify-broker',
      'verify-worker',
      'sign-app',
      'verify-app',
      'inspect-app',
      'require-app',
      'require-broker',
      'require-worker',
    ]);
    const signCommands = plan.commands.filter(command => command.operation.startsWith('sign-'));
    expect(signCommands.every(command => !command.args.includes('--deep'))).toBe(true);
    expect(plan.commands.find(command => command.operation === 'verify-app')?.args)
      .toContain('--deep');
    expect(plan.commands.find(command => command.operation === 'sign-app')?.args)
      .toContain(target.appEntitlementsPath);
    expect(plan.authoritative).toBe(false);
    expect(plan.ready).toBe(false);
  });

  test('pins stable identities for every compiled sidecar and both XPC roles', () => {
    const plan = planMacOSRuntimeProductionAppSigning(identity(), layout());
    const text = plan.commands.flatMap(command => command.args).join('\n');
    expect(text).toContain(MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER);
    expect(text).toContain(MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER);
    expect(text).toContain(MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER);
    expect(text).toContain('runtime-broker.client');
    expect(text).toContain('runtime-broker.service');
    expect(text).toContain(`certificate leaf[subject.OU] = "${TEAM}"`);
  });

  test('rejects raw identities and any path drift before emitting commands', () => {
    expect(() => planMacOSRuntimeProductionAppSigning(
      { ...identity(), diagnostic: { ...identity().diagnostic, result: 'not-verified' } },
      layout(),
    )).toThrow('identity rejected');
    const target = layout();
    expect(() => planMacOSRuntimeProductionAppSigning(
      identity(),
      { ...target, runtimeGuardPath: '/tmp/other' },
    )).toThrow('layout rejected');
    expect(() => planMacOSRuntimeProductionAppSigning(
      identity(),
      { ...target, appEntitlementsPath: join(target.appBundlePath, 'Contents', 'fake.plist') },
    )).toThrow('layout rejected');
  });
});
