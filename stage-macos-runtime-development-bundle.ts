import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const BROKER_NAME = 'com.intenet.agentstozbycs.runtime-broker';
const DEDICATED_WORKER_NAME = 'com.intenet.agentstozbycs.runtime-dedicated-worker-fixture';
const BROKER_PLIST_NAME = `${BROKER_NAME}.plist`;
const DEDICATED_WORKER_PLIST_NAME = `${DEDICATED_WORKER_NAME}.plist`;

interface DevelopmentManifest {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-native-development-build';
  readonly mode: 'development-ad-hoc';
  readonly broker: Readonly<{ name: typeof BROKER_NAME; sha256: string }>;
  readonly dedicatedWorkerFixture: Readonly<{
    name: typeof DEDICATED_WORKER_NAME;
    sha256: string;
  }>;
  readonly appBundled: false;
  readonly serviceRegistered: false;
  readonly accountCreated: false;
  readonly dedicatedIdentityFixtureExecuted: false;
  readonly containerInvoked: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface StageMacOSRuntimeDevelopmentBundleOptions {
  readonly appBundlePath: string;
  readonly artifactRoot: string;
}

export interface StagedMacOSRuntimeDevelopmentBundle {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-development-bundle-stage';
  readonly result: 'staged';
  readonly helperCount: 2;
  readonly plistCount: 2;
  readonly productionIdentityEmbedded: false;
  readonly entitlementsApplied: false;
  readonly serviceRegistered: false;
  readonly executionAuthorized: false;
  readonly reusable: false;
  readonly ready: false;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertContained(parent: string, candidate: string): void {
  const value = relative(resolve(parent), resolve(candidate));
  if (value === '' || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error('macOS runtime bundle path escaped its fixed parent');
  }
}

function exactDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('macOS runtime bundle directory is unsafe');
  }
}

function ensureContainedDirectory(appBundlePath: string, path: string): void {
  assertContained(appBundlePath, path);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o755 });
  exactDirectory(path);
}

function exactSourceFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error('macOS runtime development artifact is unsafe');
  }
}

function atomicCopy(source: string, destination: string, mode: number): void {
  exactSourceFile(source);
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.stage`);
  copyFileSync(source, temporary);
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
  const metadata = lstatSync(destination);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error('macOS runtime staged artifact is unsafe');
  }
}

function readDevelopmentManifest(path: string): DevelopmentManifest {
  exactSourceFile(path);
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<DevelopmentManifest>;
  if (value.schemaVersion !== 1
    || value.kind !== 'macos-runtime-native-development-build'
    || value.mode !== 'development-ad-hoc'
    || value.broker?.name !== BROKER_NAME
    || value.dedicatedWorkerFixture?.name !== DEDICATED_WORKER_NAME
    || typeof value.broker.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.broker.sha256)
    || typeof value.dedicatedWorkerFixture.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.dedicatedWorkerFixture.sha256)
    || value.appBundled !== false
    || value.serviceRegistered !== false
    || value.accountCreated !== false
    || value.dedicatedIdentityFixtureExecuted !== false
    || value.containerInvoked !== false
    || value.authoritative !== false
    || value.reusable !== false
    || value.ready !== false) {
    throw new Error('macOS runtime development manifest rejected');
  }
  return value as DevelopmentManifest;
}

export function stageMacOSRuntimeDevelopmentBundle(
  options: StageMacOSRuntimeDevelopmentBundleOptions,
): Readonly<StagedMacOSRuntimeDevelopmentBundle> {
  const appBundlePath = realpathSync(options.appBundlePath);
  const artifactRoot = realpathSync(options.artifactRoot);
  exactDirectory(appBundlePath);
  exactDirectory(artifactRoot);
  if (basename(appBundlePath) !== 'AgentsToZ_byCS.app') {
    throw new Error('macOS runtime development stage requires the exact app bundle name');
  }

  const manifest = readDevelopmentManifest(join(artifactRoot, 'manifest.json'));
  const sourceBinRoot = join(artifactRoot, 'bin');
  const sourceConfigRoot = join(artifactRoot, 'Config');
  exactDirectory(sourceBinRoot);
  exactDirectory(sourceConfigRoot);
  const brokerSource = join(sourceBinRoot, BROKER_NAME);
  const workerSource = join(sourceBinRoot, DEDICATED_WORKER_NAME);
  if (sha256(brokerSource) !== manifest.broker.sha256
    || sha256(workerSource) !== manifest.dedicatedWorkerFixture.sha256) {
    throw new Error('macOS runtime development artifact digest mismatch');
  }

  const contents = join(appBundlePath, 'Contents');
  exactDirectory(contents);
  const library = join(contents, 'Library');
  const launchDaemons = join(library, 'LaunchDaemons');
  const launchServices = join(library, 'LaunchServices');
  ensureContainedDirectory(appBundlePath, library);
  ensureContainedDirectory(appBundlePath, launchDaemons);
  ensureContainedDirectory(appBundlePath, launchServices);

  atomicCopy(brokerSource, join(launchServices, BROKER_NAME), 0o500);
  atomicCopy(workerSource, join(launchServices, DEDICATED_WORKER_NAME), 0o500);
  atomicCopy(
    join(sourceConfigRoot, BROKER_PLIST_NAME),
    join(launchDaemons, BROKER_PLIST_NAME),
    0o400,
  );
  atomicCopy(
    join(sourceConfigRoot, DEDICATED_WORKER_PLIST_NAME),
    join(launchServices, DEDICATED_WORKER_PLIST_NAME),
    0o400,
  );

  return Object.freeze({
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
}
