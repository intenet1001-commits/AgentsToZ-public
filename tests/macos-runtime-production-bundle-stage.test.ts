import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MacOSRuntimeProductionNativeManifest } from '../build-macos-runtime-native-production';
import { stageMacOSRuntimeProductionBundle } from '../stage-macos-runtime-production-bundle';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME as brokerName,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME as workerName,
} from '../src/macOSRuntimeProductionSigningPlan';

const roots: string[] = [];

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-runtime-production-bundle-')));
  roots.push(root);
  const appBundlePath = join(root, 'AgentsToZ_byCS.app');
  const artifactRoot = join(root, 'artifacts');
  const sourceConfigRoot = join(root, 'macos-runtime', 'Config');
  mkdirSync(join(appBundlePath, 'Contents'), { recursive: true });
  mkdirSync(join(artifactRoot, 'bin'), { recursive: true });
  mkdirSync(join(artifactRoot, 'Config'), { recursive: true });
  mkdirSync(sourceConfigRoot, { recursive: true });
  const values = {
    broker: 'signed-production-broker',
    worker: 'signed-production-worker',
    brokerPlist: '<plist><dict><key>broker</key></dict></plist>\n',
    workerPlist: '<plist><dict><key>worker</key></dict></plist>\n',
    appEntitlements: '<plist><dict><key>client</key></dict></plist>\n',
  };
  const brokerPath = join(artifactRoot, 'bin', brokerName);
  const dedicatedWorkerPath = join(artifactRoot, 'bin', workerName);
  const brokerEntitlementsPath = join(artifactRoot, 'Config', 'BrokerService.entitlements');
  writeFileSync(brokerPath, values.broker, { mode: 0o500 });
  writeFileSync(dedicatedWorkerPath, values.worker, { mode: 0o500 });
  writeFileSync(brokerEntitlementsPath, '<plist/>\n', { mode: 0o400 });
  writeFileSync(join(sourceConfigRoot, `${brokerName}.plist`), values.brokerPlist, {
    mode: 0o400,
  });
  writeFileSync(join(sourceConfigRoot, `${workerName}.plist`), values.workerPlist, {
    mode: 0o400,
  });
  writeFileSync(join(sourceConfigRoot, 'AppClient.entitlements'), values.appEntitlements, {
    mode: 0o400,
  });
  const manifest = {
    schemaVersion: 1,
    kind: 'macos-runtime-native-production-build',
    mode: 'developer-id-production',
    architecture: 'arm64',
    deploymentTarget: '13.0',
    runtimeMinimum: '26.0',
    pinnedSourceDigest: 'ab'.repeat(32),
    broker: { name: brokerName, sha256: hash(values.broker) },
    dedicatedWorker: { name: workerName, sha256: hash(values.worker) },
    bundleInputs: {
      brokerPlistSha256: hash(values.brokerPlist),
      dedicatedWorkerPlistSha256: hash(values.workerPlist),
      appClientEntitlementsSha256: hash(values.appEntitlements),
    },
    signing: {
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
    },
    appBundled: false,
    appSigned: false,
    notarized: false,
    installed: false,
    serviceRegistered: false,
    accountCreated: false,
    authoritative: false,
    reusable: false,
    ready: false,
  } as const satisfies MacOSRuntimeProductionNativeManifest;
  return {
    root,
    appBundlePath,
    artifactLayout: { artifactRoot, brokerPath, dedicatedWorkerPath, brokerEntitlementsPath },
    sourceConfigRoot,
    manifest,
    values,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('macOS runtime production bundle stage', () => {
  test('stages only preverified helpers and fixed plists while keeping authority closed', () => {
    const input = fixture();
    const result = stageMacOSRuntimeProductionBundle(input);
    expect(result).toEqual({
      schemaVersion: 1,
      kind: 'macos-runtime-production-bundle-stage',
      result: 'staged-awaiting-app-signature',
      helperCount: 2,
      plistCount: 2,
      appClientEntitlementsPath: join(input.sourceConfigRoot, 'AppClient.entitlements'),
      helperSignaturesPreverified: true,
      appSigned: false,
      notarized: false,
      installed: false,
      serviceRegistered: false,
      executionAuthorized: false,
      authoritative: false,
      reusable: false,
      ready: false,
    });
    const services = join(input.appBundlePath, 'Contents', 'Library', 'LaunchServices');
    const daemons = join(input.appBundlePath, 'Contents', 'Library', 'LaunchDaemons');
    expect(readFileSync(join(services, brokerName), 'utf8')).toBe(input.values.broker);
    expect(readFileSync(join(services, workerName), 'utf8')).toBe(input.values.worker);
    expect(readFileSync(join(daemons, `${brokerName}.plist`), 'utf8'))
      .toBe(input.values.brokerPlist);
    expect(readFileSync(join(services, `${workerName}.plist`), 'utf8'))
      .toBe(input.values.workerPlist);
  });

  test('rejects unsigned or incomplete helper proof before touching the app', () => {
    const input = fixture();
    const manifest = {
      ...input.manifest,
      signing: { ...input.manifest.signing, brokerRequirementVerified: false },
    } as MacOSRuntimeProductionNativeManifest;
    expect(() => stageMacOSRuntimeProductionBundle({ ...input, manifest }))
      .toThrow('manifest rejected');
  });

  test('rejects digest drift and redirected config inputs', () => {
    const drift = fixture();
    chmodSync(join(drift.sourceConfigRoot, `${brokerName}.plist`), 0o600);
    writeFileSync(join(drift.sourceConfigRoot, `${brokerName}.plist`), 'tampered');
    expect(() => stageMacOSRuntimeProductionBundle(drift)).toThrow('digest mismatch');

    const redirected = fixture();
    const source = join(redirected.root, 'external-entitlements');
    writeFileSync(source, redirected.values.appEntitlements, { mode: 0o400 });
    rmSync(join(redirected.sourceConfigRoot, 'AppClient.entitlements'));
    symlinkSync(source, join(redirected.sourceConfigRoot, 'AppClient.entitlements'));
    expect(() => stageMacOSRuntimeProductionBundle(redirected)).toThrow('input is unsafe');
  });
});
