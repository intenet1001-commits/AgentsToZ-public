import { isAbsolute, join } from 'node:path';
import {
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID,
  MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT,
  MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE,
} from './macOSRuntimeBrokerSigning';
import type { MacOSRuntimeProductionBuildIdentityResolution } from './macOSRuntimeProductionCanary';

export const MACOS_RUNTIME_PRODUCTION_BROKER_NAME =
  'com.intenet.agentstozbycs.runtime-broker' as const;
export const MACOS_RUNTIME_PRODUCTION_WORKER_NAME =
  'com.intenet.agentstozbycs.runtime-dedicated-worker-fixture' as const;
export const MACOS_RUNTIME_PRODUCTION_CODESIGN_PATH = '/usr/bin/codesign' as const;

export interface MacOSRuntimeProductionArtifactLayout {
  readonly artifactRoot: string;
  readonly brokerPath: string;
  readonly dedicatedWorkerPath: string;
  readonly brokerEntitlementsPath: string;
}

export interface MacOSRuntimeProductionSigningCommand {
  readonly executable: typeof MACOS_RUNTIME_PRODUCTION_CODESIGN_PATH;
  readonly operation:
    | 'sign-broker'
    | 'sign-worker'
    | 'verify-broker'
    | 'verify-worker'
    | 'inspect-broker'
    | 'inspect-worker'
    | 'require-broker'
    | 'require-worker';
  readonly args: readonly string[];
}

export interface MacOSRuntimeProductionSigningPlan {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-signing-plan';
  readonly commands: readonly MacOSRuntimeProductionSigningCommand[];
  readonly commandCount: 8;
  readonly insideOutOrder: true;
  readonly appSigned: false;
  readonly notarized: false;
  readonly installed: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export function validMacOSRuntimeProductionIdentity(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
): boolean {
  const identity = resolution.identity;
  if (resolution.diagnostic.result !== 'snapshot-verified'
    || resolution.diagnostic.reason !== 'canary-snapshot-verified'
    || resolution.diagnostic.authoritative !== false
    || resolution.diagnostic.reusable !== false
    || resolution.diagnostic.ready !== false
    || identity === null
    || !/^[A-Z0-9]{10}$/u.test(identity.teamIdentifier)
    || !/^[0-9A-F]{40}$/u.test(identity.certificateFingerprint)
    || !new RegExp(
      `^Developer ID Application: [^\\u0000-\\u001F\\u007F]{1,300} \\(${identity.teamIdentifier}\\)$`,
      'u',
    ).test(identity.commonName)) {
    return false;
  }
  const team = identity.teamIdentifier;
  return new Set(team).size > 1 && !new Set([
    'ABCDEFGHIJ', '1234567890', 'TEAMID1234', 'YOURTEAMID', 'XXXXXXXXXX',
  ]).has(team);
}

function validRoot(value: string): boolean {
  return isAbsolute(value)
    && value !== '/'
    && !/[\u0000-\u001F\u007F]/u.test(value)
    && !value.endsWith('/');
}

function validateLayout(layout: Readonly<MacOSRuntimeProductionArtifactLayout>): void {
  if (!validRoot(layout.artifactRoot)
    || layout.brokerPath !== join(
      layout.artifactRoot,
      'bin',
      MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
    )
    || layout.dedicatedWorkerPath !== join(
      layout.artifactRoot,
      'bin',
      MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
    )
    || layout.brokerEntitlementsPath !== join(
      layout.artifactRoot,
      'Config',
      'BrokerService.entitlements',
    )) {
    throw new Error('macOS runtime production signing layout rejected');
  }
}

function requirement(
  identifier: string,
  teamIdentifier: string,
  roleEntitlement = false,
): string {
  return '=anchor apple generic'
    + ` and certificate 1[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID}] exists`
    + ` and certificate leaf[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID}] exists`
    + ` and certificate leaf[subject.OU] = "${teamIdentifier}"`
    + ` and identifier "${identifier}"`
    + (roleEntitlement
      ? ` and entitlement["${MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT}"] = "${MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE}"`
      : '');
}

function command(
  operation: MacOSRuntimeProductionSigningCommand['operation'],
  args: readonly string[],
): Readonly<MacOSRuntimeProductionSigningCommand> {
  return Object.freeze({
    executable: MACOS_RUNTIME_PRODUCTION_CODESIGN_PATH,
    operation,
    args: Object.freeze([...args]),
  });
}

export function planMacOSRuntimeProductionArtifactSigning(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  layout: Readonly<MacOSRuntimeProductionArtifactLayout>,
): Readonly<MacOSRuntimeProductionSigningPlan> {
  if (!validMacOSRuntimeProductionIdentity(resolution)) {
    throw new Error('macOS runtime production signing identity rejected');
  }
  validateLayout(layout);
  const identity = resolution.identity!;
  const commonSignArgs = [
    '--force',
    '--sign', identity.certificateFingerprint,
    '--options', 'runtime',
    '--timestamp',
  ] as const;
  const commonVerifyArgs = [
    '--verify', '--strict', '--all-architectures', '--verbose=4',
  ] as const;
  const commands = Object.freeze([
    command('sign-broker', [
      ...commonSignArgs,
      '--identifier', MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
      '--entitlements', layout.brokerEntitlementsPath,
      layout.brokerPath,
    ]),
    command('sign-worker', [
      ...commonSignArgs,
      '--identifier', MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
      layout.dedicatedWorkerPath,
    ]),
    command('verify-broker', [...commonVerifyArgs, layout.brokerPath]),
    command('verify-worker', [...commonVerifyArgs, layout.dedicatedWorkerPath]),
    command('inspect-broker', [
      '--display', '--verbose=4', '--entitlements', '-', '--xml', layout.brokerPath,
    ]),
    command('inspect-worker', ['--display', '--verbose=4', layout.dedicatedWorkerPath]),
    command('require-broker', [
      ...commonVerifyArgs,
      '-R',
      requirement(MACOS_RUNTIME_PRODUCTION_BROKER_NAME, identity.teamIdentifier, true),
      layout.brokerPath,
    ]),
    command('require-worker', [
      ...commonVerifyArgs,
      '-R',
      requirement(MACOS_RUNTIME_PRODUCTION_WORKER_NAME, identity.teamIdentifier),
      layout.dedicatedWorkerPath,
    ]),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-signing-plan',
    commands,
    commandCount: 8,
    insideOutOrder: true,
    appSigned: false,
    notarized: false,
    installed: false,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}
