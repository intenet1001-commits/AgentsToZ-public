import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MacOSRuntimeProductionNativeContext } from '../build-macos-runtime-native-production';
import {
  finalizeMacOSRuntimeProductionAppForTest,
  macOSRuntimeProductionAppLayout,
} from '../src/macOSRuntimeProductionAppBuild';
import type { MacOSRuntimeProductionAppSigningReceipt } from '../src/macOSRuntimeProductionAppSigningExecutor';

const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-production-app-build-')));
  roots.push(root);
  const appBundlePath = join(root, 'AgentsToZ_byCS.app');
  const packageRoot = join(root, 'macos-runtime');
  mkdirSync(join(appBundlePath, 'Contents'), { recursive: true });
  mkdirSync(join(packageRoot, 'Config'), { recursive: true });
  const context = {
    sourceStage: {
      packageRoot,
    },
    artifactLayout: { artifactRoot: join(root, 'artifacts') },
    identityResolution: {},
    manifest: { pinnedSourceDigest: 'ab'.repeat(32) },
  } as unknown as MacOSRuntimeProductionNativeContext;
  return { root, appBundlePath, packageRoot, context };
}

function signed(): MacOSRuntimeProductionAppSigningReceipt {
  return {
    schemaVersion: 1,
    kind: 'macos-runtime-production-app-signing-execution',
    result: 'verified',
    reason: 'production-app-signed-and-verified',
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
    authoritative: false,
    reusable: false,
    ready: false,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('macOS runtime production app build composition', () => {
  test('joins native artifacts, bundle stage and app signing without claiming runtime authority', async () => {
    const input = fixture();
    const receipt = await finalizeMacOSRuntimeProductionAppForTest(
      input.context,
      input.appBundlePath,
      {
        stage(options) {
          expect(options.appBundlePath).toBe(input.appBundlePath);
          expect(options.sourceConfigRoot).toBe(join(input.packageRoot, 'Config'));
          return {
            schemaVersion: 1,
            kind: 'macos-runtime-production-bundle-stage',
            result: 'staged-awaiting-app-signature',
            helperCount: 2,
            plistCount: 2,
            appClientEntitlementsPath: join(input.packageRoot, 'Config', 'AppClient.entitlements'),
            helperSignaturesPreverified: true,
            appSigned: false,
            notarized: false,
            installed: false,
            serviceRegistered: false,
            executionAuthorized: false,
            authoritative: false,
            reusable: false,
            ready: false,
          };
        },
        async sign(_context, layout) {
          expect(layout).toEqual(macOSRuntimeProductionAppLayout(
            input.appBundlePath,
            join(input.packageRoot, 'Config', 'AppClient.entitlements'),
          ));
          return signed();
        },
      },
    );
    expect(receipt.result).toBe('signed-awaiting-notarization');
    expect(receipt.appSigned).toBe(true);
    expect(receipt.executionAuthorized).toBe(false);
    expect(receipt.authoritative).toBe(false);
    expect(receipt.ready).toBe(false);
  });

  test('rejects an optimistic stage or partial signing receipt', async () => {
    const input = fixture();
    const baseStage = {
      schemaVersion: 1,
      kind: 'macos-runtime-production-bundle-stage',
      result: 'staged-awaiting-app-signature',
      helperCount: 2,
      plistCount: 2,
      appClientEntitlementsPath: join(input.packageRoot, 'Config', 'AppClient.entitlements'),
      helperSignaturesPreverified: true,
      appSigned: false,
      notarized: false,
      installed: false,
      serviceRegistered: false,
      executionAuthorized: false,
      authoritative: false,
      reusable: false,
      ready: false,
    } as const;
    await expect(finalizeMacOSRuntimeProductionAppForTest(
      input.context,
      input.appBundlePath,
      {
        stage() { return { ...baseStage, executionAuthorized: true } as never; },
        async sign() { return signed(); },
      },
    )).rejects.toThrow('stage receipt rejected');
    await expect(finalizeMacOSRuntimeProductionAppForTest(
      input.context,
      input.appBundlePath,
      {
        stage() { return baseStage; },
        async sign() { return { ...signed(), appRequirementVerified: false }; },
      },
    )).rejects.toThrow('app signing failed');
  });
});
