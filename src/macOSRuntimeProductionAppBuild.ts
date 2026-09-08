import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { MacOSRuntimeProductionNativeContext } from '../build-macos-runtime-native-production';
import {
  stageMacOSRuntimeProductionBundle,
  type StageMacOSRuntimeProductionBundleOptions,
  type StagedMacOSRuntimeProductionBundle,
} from '../stage-macos-runtime-production-bundle';
import {
  executeMacOSRuntimeProductionAppSigning,
  type MacOSRuntimeProductionAppSigningReceipt,
} from './macOSRuntimeProductionAppSigningExecutor';
import type { MacOSRuntimeProductionAppLayout } from './macOSRuntimeProductionAppSigningPlan';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
} from './macOSRuntimeProductionSigningPlan';

export interface MacOSRuntimeProductionAppBuildReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-app-build';
  readonly result: 'signed-awaiting-notarization';
  readonly nativeSourceDigest: string;
  readonly helpersBundled: true;
  readonly nestedCodeSigned: 3;
  readonly nestedCodeIntegrityVerified: 3;
  readonly nestedCodeRequirementsVerified: 3;
  readonly brokerIntegrityVerified: true;
  readonly workerIntegrityVerified: true;
  readonly appSigned: true;
  readonly appIntegrityVerified: true;
  readonly appInspectionVerified: true;
  readonly appRequirementVerified: true;
  readonly brokerRequirementVerified: true;
  readonly workerRequirementVerified: true;
  readonly notarized: false;
  readonly installed: false;
  readonly serviceRegistered: false;
  readonly accountCreated: false;
  readonly executionAuthorized: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeProductionAppBuildDependencies {
  stage(
    options: Readonly<StageMacOSRuntimeProductionBundleOptions>,
  ): Readonly<StagedMacOSRuntimeProductionBundle>;
  sign(
    context: Readonly<MacOSRuntimeProductionNativeContext>,
    layout: Readonly<MacOSRuntimeProductionAppLayout>,
  ): Promise<Readonly<MacOSRuntimeProductionAppSigningReceipt>>;
}

function exactAppBundle(path: string): string {
  const canonical = realpathSync(path);
  const metadata = lstatSync(path);
  if (canonical !== path
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || !canonical.endsWith('/AgentsToZ_byCS.app')) {
    throw new Error('macOS runtime production app bundle rejected');
  }
  return canonical;
}

export function macOSRuntimeProductionAppLayout(
  appBundlePath: string,
  appEntitlementsPath: string,
): Readonly<MacOSRuntimeProductionAppLayout> {
  const resources = join(appBundlePath, 'Contents', 'Resources', 'resources');
  const services = join(appBundlePath, 'Contents', 'Library', 'LaunchServices');
  return Object.freeze({
    appBundlePath,
    appExecutablePath: join(appBundlePath, 'Contents', 'MacOS', 'app'),
    apiSidecarPath: join(resources, 'agentstoz-api-sidecar'),
    useMcpPath: join(resources, 'agentstoz-use-mcp'),
    runtimeGuardPath: join(resources, 'agentstoz-agent-runtime-guard'),
    brokerPath: join(services, MACOS_RUNTIME_PRODUCTION_BROKER_NAME),
    dedicatedWorkerPath: join(services, MACOS_RUNTIME_PRODUCTION_WORKER_NAME),
    appEntitlementsPath,
  });
}

function verifiedSigning(
  signing: Readonly<MacOSRuntimeProductionAppSigningReceipt>,
): boolean {
  return signing.result === 'verified'
    && signing.reason === 'production-app-signed-and-verified'
    && signing.nestedCodeSigned === 3
    && signing.nestedCodeIntegrityVerified === 3
    && signing.nestedCodeRequirementsVerified === 3
    && signing.brokerIntegrityVerified
    && signing.workerIntegrityVerified
    && signing.appSigned
    && signing.appIntegrityVerified
    && signing.appInspectionVerified
    && signing.appRequirementVerified
    && signing.brokerRequirementVerified
    && signing.workerRequirementVerified
    && signing.notarized === false
    && signing.installed === false
    && signing.serviceRegistered === false
    && signing.authoritative === false
    && signing.reusable === false
    && signing.ready === false;
}

export async function finalizeMacOSRuntimeProductionAppForTest(
  context: Readonly<MacOSRuntimeProductionNativeContext>,
  appBundlePath: string,
  dependencies: Readonly<MacOSRuntimeProductionAppBuildDependencies>,
): Promise<Readonly<MacOSRuntimeProductionAppBuildReceipt>> {
  const app = exactAppBundle(appBundlePath);
  const configRoot = join(context.sourceStage.packageRoot, 'Config');
  const appEntitlementsPath = join(configRoot, 'AppClient.entitlements');
  const stage = dependencies.stage(Object.freeze({
    appBundlePath: app,
    artifactLayout: context.artifactLayout,
    sourceConfigRoot: configRoot,
    manifest: context.manifest,
  }));
  if (stage.result !== 'staged-awaiting-app-signature'
    || stage.helperCount !== 2
    || stage.plistCount !== 2
    || stage.appClientEntitlementsPath !== appEntitlementsPath
    || !stage.helperSignaturesPreverified
    || stage.appSigned !== false
    || stage.executionAuthorized !== false
    || stage.authoritative !== false
    || stage.reusable !== false
    || stage.ready !== false) {
    throw new Error('macOS runtime production bundle stage receipt rejected');
  }
  const layout = macOSRuntimeProductionAppLayout(app, appEntitlementsPath);
  const signing = await dependencies.sign(context, layout);
  if (!verifiedSigning(signing)) {
    throw new Error(`macOS runtime production app signing failed: ${signing.reason}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-app-build',
    result: 'signed-awaiting-notarization',
    nativeSourceDigest: context.manifest.pinnedSourceDigest,
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
  });
}

const defaultDependencies: MacOSRuntimeProductionAppBuildDependencies = Object.freeze({
  stage: stageMacOSRuntimeProductionBundle,
  sign(
    context: Readonly<MacOSRuntimeProductionNativeContext>,
    layout: Readonly<MacOSRuntimeProductionAppLayout>,
  ) {
    return executeMacOSRuntimeProductionAppSigning(context.identityResolution, layout);
  },
});

export async function finalizeMacOSRuntimeProductionApp(
  context: Readonly<MacOSRuntimeProductionNativeContext>,
  appBundlePath: string,
): Promise<Readonly<MacOSRuntimeProductionAppBuildReceipt>> {
  return finalizeMacOSRuntimeProductionAppForTest(context, appBundlePath, defaultDependencies);
}
