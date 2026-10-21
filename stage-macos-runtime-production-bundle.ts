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
import type { MacOSRuntimeProductionNativeManifest } from './build-macos-runtime-native-production';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
  type MacOSRuntimeProductionArtifactLayout,
} from './src/macOSRuntimeProductionSigningPlan';

const BROKER_PLIST_NAME = `${MACOS_RUNTIME_PRODUCTION_BROKER_NAME}.plist`;
const WORKER_PLIST_NAME = `${MACOS_RUNTIME_PRODUCTION_WORKER_NAME}.plist`;

export interface StageMacOSRuntimeProductionBundleOptions {
  readonly appBundlePath: string;
  readonly artifactLayout: Readonly<MacOSRuntimeProductionArtifactLayout>;
  readonly sourceConfigRoot: string;
  readonly manifest: Readonly<MacOSRuntimeProductionNativeManifest>;
}

export interface StagedMacOSRuntimeProductionBundle {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-bundle-stage';
  readonly result: 'staged-awaiting-app-signature';
  readonly helperCount: 2;
  readonly plistCount: 2;
  readonly appClientEntitlementsPath: string;
  readonly helperSignaturesPreverified: true;
  readonly appSigned: false;
  readonly notarized: false;
  readonly installed: false;
  readonly serviceRegistered: false;
  readonly executionAuthorized: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertContained(parent: string, candidate: string): void {
  const value = relative(resolve(parent), resolve(candidate));
  if (value === '' || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error('macOS runtime production bundle path escaped its fixed parent');
  }
}

function exactDirectory(path: string): string {
  const canonical = realpathSync(path);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== path) {
    throw new Error('macOS runtime production bundle directory is unsafe');
  }
  return canonical;
}

function ensureContainedDirectory(appBundlePath: string, path: string): void {
  assertContained(appBundlePath, path);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o755 });
  exactDirectory(path);
}

function exactFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || realpathSync(path) !== path) {
    throw new Error('macOS runtime production bundle input is unsafe');
  }
}

function atomicCopy(source: string, destination: string, mode: number): void {
  exactFile(source);
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.stage`);
  copyFileSync(source, temporary);
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
  exactFile(destination);
}

function exactDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function validateManifest(manifest: Readonly<MacOSRuntimeProductionNativeManifest>): void {
  const signing = manifest.signing;
  if (manifest.schemaVersion !== 1
    || manifest.kind !== 'macos-runtime-native-production-build'
    || manifest.mode !== 'developer-id-production'
    || manifest.broker.name !== MACOS_RUNTIME_PRODUCTION_BROKER_NAME
    || manifest.dedicatedWorker.name !== MACOS_RUNTIME_PRODUCTION_WORKER_NAME
    || !exactDigest(manifest.broker.sha256)
    || !exactDigest(manifest.dedicatedWorker.sha256)
    || !exactDigest(manifest.bundleInputs.brokerPlistSha256)
    || !exactDigest(manifest.bundleInputs.dedicatedWorkerPlistSha256)
    || !exactDigest(manifest.bundleInputs.appClientEntitlementsSha256)
    || signing.result !== 'verified'
    || signing.reason !== 'production-artifacts-signed-and-verified'
    || !signing.brokerSigned
    || !signing.workerSigned
    || !signing.brokerIntegrityVerified
    || !signing.workerIntegrityVerified
    || !signing.brokerInspectionVerified
    || !signing.workerInspectionVerified
    || !signing.brokerRequirementVerified
    || !signing.workerRequirementVerified
    || manifest.appBundled !== false
    || manifest.appSigned !== false
    || manifest.notarized !== false
    || manifest.installed !== false
    || manifest.serviceRegistered !== false
    || manifest.accountCreated !== false
    || manifest.authoritative !== false
    || manifest.reusable !== false
    || manifest.ready !== false) {
    throw new Error('macOS runtime production native manifest rejected');
  }
}

/**
 * Copies already Developer-ID-signed helpers and their fixed launchd plists
 * into a freshly built app bundle. This is deliberately not an authorization
 * receipt: the complete app still needs its client entitlement, inside-out
 * Developer ID signature, notarization, installation and live broker proof.
 */
export function stageMacOSRuntimeProductionBundle(
  options: Readonly<StageMacOSRuntimeProductionBundleOptions>,
): Readonly<StagedMacOSRuntimeProductionBundle> {
  validateManifest(options.manifest);
  const appBundlePath = exactDirectory(options.appBundlePath);
  const artifactRoot = exactDirectory(options.artifactLayout.artifactRoot);
  const sourceConfigRoot = exactDirectory(options.sourceConfigRoot);
  if (basename(appBundlePath) !== 'AgentsToZ_byCS.app'
    || basename(sourceConfigRoot) !== 'Config'
    || options.artifactLayout.brokerPath !== join(
      artifactRoot,
      'bin',
      MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
    )
    || options.artifactLayout.dedicatedWorkerPath !== join(
      artifactRoot,
      'bin',
      MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
    )) {
    throw new Error('macOS runtime production bundle layout rejected');
  }

  const brokerSource = options.artifactLayout.brokerPath;
  const workerSource = options.artifactLayout.dedicatedWorkerPath;
  const brokerPlistSource = join(sourceConfigRoot, BROKER_PLIST_NAME);
  const workerPlistSource = join(sourceConfigRoot, WORKER_PLIST_NAME);
  const appClientEntitlementsPath = join(sourceConfigRoot, 'AppClient.entitlements');
  for (const path of [
    brokerSource,
    workerSource,
    brokerPlistSource,
    workerPlistSource,
    appClientEntitlementsPath,
  ]) exactFile(path);
  if (sha256(brokerSource) !== options.manifest.broker.sha256
    || sha256(workerSource) !== options.manifest.dedicatedWorker.sha256
    || sha256(brokerPlistSource) !== options.manifest.bundleInputs.brokerPlistSha256
    || sha256(workerPlistSource)
      !== options.manifest.bundleInputs.dedicatedWorkerPlistSha256
    || sha256(appClientEntitlementsPath)
      !== options.manifest.bundleInputs.appClientEntitlementsSha256) {
    throw new Error('macOS runtime production bundle input digest mismatch');
  }

  const contents = join(appBundlePath, 'Contents');
  exactDirectory(contents);
  const library = join(contents, 'Library');
  const launchDaemons = join(library, 'LaunchDaemons');
  const launchServices = join(library, 'LaunchServices');
  ensureContainedDirectory(appBundlePath, library);
  ensureContainedDirectory(appBundlePath, launchDaemons);
  ensureContainedDirectory(appBundlePath, launchServices);

  atomicCopy(
    brokerSource,
    join(launchServices, MACOS_RUNTIME_PRODUCTION_BROKER_NAME),
    0o500,
  );
  atomicCopy(
    workerSource,
    join(launchServices, MACOS_RUNTIME_PRODUCTION_WORKER_NAME),
    0o500,
  );
  atomicCopy(brokerPlistSource, join(launchDaemons, BROKER_PLIST_NAME), 0o400);
  atomicCopy(workerPlistSource, join(launchServices, WORKER_PLIST_NAME), 0o400);

  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-bundle-stage',
    result: 'staged-awaiting-app-signature',
    helperCount: 2,
    plistCount: 2,
    appClientEntitlementsPath,
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
}
