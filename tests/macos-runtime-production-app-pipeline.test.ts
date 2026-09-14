import { describe, expect, test } from 'bun:test';
import type { MacOSRuntimeProductionNativeContext } from '../build-macos-runtime-native-production';
import {
  executeMacOSRuntimeProductionAppPipelineForTest,
  macOSRuntimeProductionAppPipelineSpawnArgv,
  planMacOSRuntimeProductionAppPipeline,
  type MacOSRuntimeProductionAppPipelineDependencies,
} from '../src/macOSRuntimeProductionAppPipeline';
import type { MacOSRuntimeProductionAppBuildReceipt } from '../src/macOSRuntimeProductionAppBuild';

const SHA = 'a'.repeat(40);

function context(): MacOSRuntimeProductionNativeContext {
  return {
    identityResolution: {
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
        commonName: 'Developer ID Application: AgentsToZ Builder (A1B2C3D4E5)',
        teamIdentifier: 'A1B2C3D4E5',
      },
    },
  } as unknown as MacOSRuntimeProductionNativeContext;
}

function appBuild(
  overrides: Partial<MacOSRuntimeProductionAppBuildReceipt> = {},
): MacOSRuntimeProductionAppBuildReceipt {
  return {
    schemaVersion: 1,
    kind: 'macos-runtime-production-app-build',
    result: 'signed-awaiting-notarization',
    nativeSourceDigest: 'b'.repeat(64),
    helpersBundled: true,
    nestedCodeSigned: 3,
    nestedCodeIntegrityVerified: 3,
    nestedCodeRequirementsVerified: 3,
    brokerIntegrityVerified: true,
    workerIntegrityVerified: true,
    appSigned: true,
    appIntegrityVerified: true,
    appInspectionVerified: true,
    appRequirementVerified: true,
    brokerRequirementVerified: true,
    workerRequirementVerified: true,
    notarized: false,
    installed: false,
    serviceRegistered: false,
    accountCreated: false,
    executionAuthorized: false,
    authoritative: false,
    reusable: false,
    ready: false,
    ...overrides,
  };
}

function dependencies(events: string[]): MacOSRuntimeProductionAppPipelineDependencies {
  return {
    verifySource() {
      events.push('source');
      return {
        headSha: SHA,
        currentBranch: 'main',
        remote: 'origin',
        remoteUrl: 'git@example.invalid:owner/repository.git',
        defaultBranch: 'main',
        remoteHeadSha: SHA,
        unpublishedOverride: false,
      };
    },
    async withNativeArtifacts(consume) {
      events.push('native');
      return consume(context());
    },
    async buildProductionSidecars() {
      events.push('sidecars');
    },
    tauriEnvironment() {
      return { AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE: '/private/tmp/Generated/RuntimeBrokerClientBridge.m' };
    },
    async run(command) {
      events.push(command.operation);
      if (command.operation === 'build-unsigned-app') {
        expect(command.args).toEqual(['build', '--bundles', 'app', '--no-sign', '--ci']);
        expect(command.env.AGENTSTOZ_RELEASE_SOURCE_STATUS).toBe('published');
        expect(command.env.AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE)
          .toBe('/private/tmp/Generated/RuntimeBrokerClientBridge.m');
      }
    },
    now() {
      events.push('clock');
      return 123_456;
    },
    assertFreshApp(path, startedAt) {
      events.push('fresh-app');
      expect(path).toBe('/private/tmp/agentstoz-target/release/bundle/macos/AgentsToZ_byCS.app');
      expect(startedAt).toBe(123_456);
    },
    async finalize() {
      events.push('finalize');
      return appBuild();
    },
  };
}

describe('macOS runtime production app pipeline', () => {
  test('plans an unsigned Tauri app that must be signed manually inside-out', () => {
    const plan = planMacOSRuntimeProductionAppPipeline(context(), {
      projectRoot: '/private/tmp/agentstoz-source',
      targetDir: '/private/tmp/agentstoz-target',
      tauriEnvironment: {
        AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE: '/private/tmp/Generated/RuntimeBrokerClientBridge.m',
      },
      releaseSourceSha: SHA,
    });
    expect(plan.commands.map(command => command.operation))
      .toEqual(['build-frontend', 'build-unsigned-app']);
    expect(plan.commands[0].executable)
      .toBe('/private/tmp/agentstoz-source/node_modules/.bin/vite');
    expect(plan.commands[1].executable)
      .toBe('/private/tmp/agentstoz-source/node_modules/.bin/tauri');
    expect(plan.tauriCodeSigningDisabled).toBeTrue();
    expect(plan.manualInsideOutSigningRequired).toBeTrue();
    expect(plan.executionAuthorized).toBeFalse();
  });

  test('executes the complete pre-notarization sequence without granting authority', async () => {
    const events: string[] = [];
    const receipt = await executeMacOSRuntimeProductionAppPipelineForTest(
      dependencies(events),
      {
        projectRoot: '/private/tmp/agentstoz-source',
        targetDir: '/private/tmp/agentstoz-target',
      },
    );
    expect(events).toEqual([
      'source',
      'native',
      'sidecars',
      'build-frontend',
      'clock',
      'build-unsigned-app',
      'fresh-app',
      'source',
      'finalize',
      'source',
    ]);
    expect(receipt.result).toBe('signed-awaiting-notarization');
    expect(receipt.sidecarsBuiltWithProductionPin).toBeTrue();
    expect(receipt.executionAuthorized).toBeFalse();
    expect(receipt.authoritative).toBeFalse();
    expect(receipt.ready).toBeFalse();
  });

  for (const stage of ['before-signing', 'after-signing'] as const) {
    test(`rejects source drift ${stage} without issuing a release receipt`, async () => {
      const events: string[] = [];
      const base = dependencies(events);
      let checks = 0;
      await expect(executeMacOSRuntimeProductionAppPipelineForTest({
        ...base,
        verifySource() {
          const source = base.verifySource();
          checks++;
          return checks >= (stage === 'before-signing' ? 2 : 3)
            ? { ...source, headSha: 'b'.repeat(40), remoteHeadSha: 'b'.repeat(40) }
            : source;
        },
      }, { projectRoot: '/private/tmp/agentstoz-source', targetDir: '/private/tmp/agentstoz-target' }))
        .rejects.toThrow('source changed during build');
      expect(events.includes('finalize')).toBe(stage === 'after-signing');
    });
  }

  test('rejects unpublished source before any identity or build work', async () => {
    const events: string[] = [];
    const base = dependencies(events);
    await expect(executeMacOSRuntimeProductionAppPipelineForTest({
      ...base,
      verifySource() {
        events.push('source');
        return {
          headSha: SHA,
          currentBranch: 'feature',
          remote: 'origin',
          remoteUrl: 'git@example.invalid:owner/repository.git',
          defaultBranch: 'main',
          remoteHeadSha: 'b'.repeat(40),
          unpublishedOverride: false,
        };
      },
    })).rejects.toThrow('release source rejected');
    expect(events).toEqual(['source']);
  });

  test('rejects a partial signing receipt instead of promoting it', async () => {
    const events: string[] = [];
    const base = dependencies(events);
    await expect(executeMacOSRuntimeProductionAppPipelineForTest({
      ...base,
      async finalize() {
        events.push('finalize');
        return {
          ...appBuild(),
          appIntegrityVerified: false,
        } as unknown as MacOSRuntimeProductionAppBuildReceipt;
      },
    }, {
      projectRoot: '/private/tmp/agentstoz-source',
      targetDir: '/private/tmp/agentstoz-target',
    })).rejects.toThrow('receipt rejected');
    expect(events.at(-1)).toBe('finalize');
  });

  test('spawns the resolved executable instead of letting PATH pick argv[0]', () => {
    // The plan resolves an absolute node_modules/.bin path, but the shipped
    // executor used to spawn `[...command.args]`, so argv[0] was the bare word
    // `build`. The unsigned-app command also prepends
    // <projectRoot>/scripts/macos-bin to its own PATH, so a file named `build`
    // placed there would have built the very .app that is then Developer ID
    // signed and notarized. Only the plan was covered before; the executor's
    // argv had no test at all.
    const plan = planMacOSRuntimeProductionAppPipeline(context(), {
      projectRoot: '/private/tmp/agentstoz-source',
      targetDir: '/private/tmp/agentstoz-target',
      releaseSourceSha: SHA,
      tauriEnvironment: {
        AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE: '/private/tmp/Generated/RuntimeBrokerClientBridge.m',
      },
    });
    expect(plan.commands.length).toBeGreaterThan(0);
    for (const command of plan.commands) {
      const argv = macOSRuntimeProductionAppPipelineSpawnArgv(command);
      expect(argv[0]).toBe(command.executable);
      expect(argv[0]!.startsWith('/')).toBe(true);
      expect(argv.slice(1)).toEqual([...command.args]);
      // A bare subcommand as argv[0] is the defect being pinned.
      expect(argv[0]).not.toBe(command.args[0]);
    }
  });
});
