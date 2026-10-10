import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageMacOSRuntimeDevelopmentBundle } from '../stage-macos-runtime-development-bundle';

const roots: string[] = [];
const brokerName = 'com.intenet.agentstozbycs.runtime-broker';
const workerName = 'com.intenet.agentstozbycs.runtime-dedicated-worker-fixture';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-bundle-stage-'));
  roots.push(root);
  const appBundlePath = join(root, 'AgentsToZ_byCS.app');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(join(appBundlePath, 'Contents'), { recursive: true });
  mkdirSync(join(artifactRoot, 'bin'), { recursive: true });
  mkdirSync(join(artifactRoot, 'Config'), { recursive: true });
  const broker = 'development-broker';
  const worker = 'development-dedicated-worker';
  writeFileSync(join(artifactRoot, 'bin', brokerName), broker, { mode: 0o500 });
  writeFileSync(join(artifactRoot, 'bin', workerName), worker, { mode: 0o500 });
  writeFileSync(
    join(artifactRoot, 'Config', `${brokerName}.plist`),
    '<plist><dict/></plist>\n',
    { mode: 0o400 },
  );
  writeFileSync(
    join(artifactRoot, 'Config', `${workerName}.plist`),
    '<plist><dict/></plist>\n',
    { mode: 0o400 },
  );
  const manifest = {
    schemaVersion: 1,
    kind: 'macos-runtime-native-development-build',
    mode: 'development-ad-hoc',
    broker: { name: brokerName, sha256: sha256(broker) },
    dedicatedWorkerFixture: { name: workerName, sha256: sha256(worker) },
    appBundled: false,
    serviceRegistered: false,
    accountCreated: false,
    dedicatedIdentityFixtureExecuted: false,
    containerInvoked: false,
    authoritative: false,
    reusable: false,
    ready: false,
  };
  writeFileSync(join(artifactRoot, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { root, appBundlePath, artifactRoot, manifest };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('macOS runtime development bundle stage', () => {
  test('places only the broker, dedicated worker, and their fixed plists', () => {
    const { appBundlePath, artifactRoot } = fixture();
    const result = stageMacOSRuntimeDevelopmentBundle({ appBundlePath, artifactRoot });
    expect(result).toEqual({
      schemaVersion: 1,
      kind: 'macos-runtime-development-bundle-stage',
      result: 'staged',
      helperCount: 2,
      plistCount: 2,
      productionIdentityEmbedded: false,
      entitlementsApplied: false,
      serviceRegistered: false,
      executionAuthorized: false,
      reusable: false,
      ready: false,
    });
    const launchServices = join(appBundlePath, 'Contents', 'Library', 'LaunchServices');
    const launchDaemons = join(appBundlePath, 'Contents', 'Library', 'LaunchDaemons');
    expect(readFileSync(join(launchServices, brokerName), 'utf8')).toBe('development-broker');
    expect(readFileSync(join(launchServices, workerName), 'utf8'))
      .toBe('development-dedicated-worker');
    expect(readFileSync(join(launchDaemons, `${brokerName}.plist`), 'utf8'))
      .toBe('<plist><dict/></plist>\n');
    expect(readFileSync(join(launchServices, `${workerName}.plist`), 'utf8'))
      .toBe('<plist><dict/></plist>\n');
  });

  test('rejects digest drift and never treats a staged layout as authority', () => {
    const { appBundlePath, artifactRoot } = fixture();
    chmodSync(join(artifactRoot, 'bin', brokerName), 0o700);
    writeFileSync(join(artifactRoot, 'bin', brokerName), 'tampered', { mode: 0o500 });
    expect(() => stageMacOSRuntimeDevelopmentBundle({ appBundlePath, artifactRoot }))
      .toThrow('digest mismatch');
  });

  test('rejects redirected artifact files', () => {
    const { root, appBundlePath, artifactRoot, manifest } = fixture();
    const external = join(root, 'external-worker');
    writeFileSync(external, 'development-dedicated-worker', { mode: 0o500 });
    rmSync(join(artifactRoot, 'bin', workerName));
    symlinkSync(external, join(artifactRoot, 'bin', workerName));
    chmodSync(join(artifactRoot, 'manifest.json'), 0o600);
    writeFileSync(join(artifactRoot, 'manifest.json'), JSON.stringify(manifest));
    expect(() => stageMacOSRuntimeDevelopmentBundle({ appBundlePath, artifactRoot }))
      .toThrow('unsafe');
  });
});
