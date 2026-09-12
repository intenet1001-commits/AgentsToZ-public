import { isAbsolute, join } from 'node:path';
import {
  MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
  MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT,
  MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID,
  MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT,
  MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE,
} from './macOSRuntimeBrokerSigning';
import type { MacOSRuntimeProductionBuildIdentityResolution } from './macOSRuntimeProductionCanary';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_CODESIGN_PATH,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
  validMacOSRuntimeProductionIdentity,
} from './macOSRuntimeProductionSigningPlan';

export const MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER =
  'com.intenet.agentstozbycs.sidecar.api' as const;
export const MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER =
  'com.intenet.agentstozbycs.sidecar.use-mcp' as const;
export const MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER =
  'com.intenet.agentstozbycs.sidecar.runtime-guard' as const;

export interface MacOSRuntimeProductionAppLayout {
  readonly appBundlePath: string;
  readonly appExecutablePath: string;
  readonly apiSidecarPath: string;
  readonly useMcpPath: string;
  readonly runtimeGuardPath: string;
  readonly brokerPath: string;
  readonly dedicatedWorkerPath: string;
  readonly appEntitlementsPath: string;
}

export type MacOSRuntimeProductionAppSigningOperation =
  | 'sign-api-sidecar'
  | 'sign-use-mcp'
  | 'sign-runtime-guard'
  | 'verify-api-sidecar'
  | 'verify-use-mcp'
  | 'verify-runtime-guard'
  | 'require-api-sidecar'
  | 'require-use-mcp'
  | 'require-runtime-guard'
  | 'verify-broker'
  | 'verify-worker'
  | 'sign-app'
  | 'verify-app'
  | 'inspect-app'
  | 'require-app'
  | 'require-broker'
  | 'require-worker';

export interface MacOSRuntimeProductionAppSigningCommand {
  readonly executable: typeof MACOS_RUNTIME_PRODUCTION_CODESIGN_PATH;
  readonly operation: MacOSRuntimeProductionAppSigningOperation;
  readonly args: readonly string[];
}

export interface MacOSRuntimeProductionAppSigningPlan {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-app-signing-plan';
  readonly commands: readonly MacOSRuntimeProductionAppSigningCommand[];
  readonly commandCount: 17;
  readonly nestedCodeSignedFirst: true;
  readonly deepSigningUsed: false;
  readonly appSigned: false;
  readonly notarized: false;
  readonly installed: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

function validRoot(path: string): boolean {
  return isAbsolute(path)
    && path !== '/'
    && !/[\u0000-\u001F\u007F]/u.test(path)
    && !path.endsWith('/');
}

function validateLayout(layout: Readonly<MacOSRuntimeProductionAppLayout>): void {
  const app = layout.appBundlePath;
  if (!validRoot(app)
    || !app.endsWith('/AgentsToZ_byCS.app')
    || layout.appExecutablePath !== join(app, 'Contents', 'MacOS', 'app')
    || layout.apiSidecarPath !== join(
      app,
      'Contents',
      'Resources',
      'resources',
      'agentstoz-api-sidecar',
    )
    || layout.useMcpPath !== join(
      app,
      'Contents',
      'Resources',
      'resources',
      'agentstoz-use-mcp',
    )
    || layout.runtimeGuardPath !== join(
      app,
      'Contents',
      'Resources',
      'resources',
      'agentstoz-agent-runtime-guard',
    )
    || layout.brokerPath !== join(
      app,
      'Contents',
      'Library',
      'LaunchServices',
      MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
    )
    || layout.dedicatedWorkerPath !== join(
      app,
      'Contents',
      'Library',
      'LaunchServices',
      MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
    )
    || !validRoot(layout.appEntitlementsPath)
    || layout.appEntitlementsPath.startsWith(`${app}/`)) {
    throw new Error('macOS runtime production app signing layout rejected');
  }
}

function requirement(
  identifier: string,
  teamIdentifier: string,
  entitlement?: readonly [string, string],
): string {
  return '=anchor apple generic'
    + ` and certificate 1[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID}] exists`
    + ` and certificate leaf[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID}] exists`
    + ` and certificate leaf[subject.OU] = "${teamIdentifier}"`
    + ` and identifier "${identifier}"`
    + (entitlement === undefined
      ? ''
      : ` and entitlement["${entitlement[0]}"] = "${entitlement[1]}"`);
}

function command(
  operation: MacOSRuntimeProductionAppSigningOperation,
  args: readonly string[],
): Readonly<MacOSRuntimeProductionAppSigningCommand> {
  return Object.freeze({
    executable: MACOS_RUNTIME_PRODUCTION_CODESIGN_PATH,
    operation,
    args: Object.freeze([...args]),
  });
}

export function planMacOSRuntimeProductionAppSigning(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  layout: Readonly<MacOSRuntimeProductionAppLayout>,
): Readonly<MacOSRuntimeProductionAppSigningPlan> {
  if (!validMacOSRuntimeProductionIdentity(resolution)) {
    throw new Error('macOS runtime production app signing identity rejected');
  }
  validateLayout(layout);
  const identity = resolution.identity!;
  const sign = ['--force', '--sign', identity.certificateFingerprint, '--options', 'runtime', '--timestamp'];
  const verify = ['--verify', '--strict', '--all-architectures', '--verbose=4'];
  const nested = [
    ['sign-api-sidecar', MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER, layout.apiSidecarPath],
    ['sign-use-mcp', MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER, layout.useMcpPath],
    ['sign-runtime-guard', MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER, layout.runtimeGuardPath],
  ] as const;
  const commands: MacOSRuntimeProductionAppSigningCommand[] = [];
  for (const [operation, identifier, path] of nested) {
    commands.push(command(operation, [...sign, '--identifier', identifier, path]));
  }
  commands.push(
    command('verify-api-sidecar', [...verify, layout.apiSidecarPath]),
    command('verify-use-mcp', [...verify, layout.useMcpPath]),
    command('verify-runtime-guard', [...verify, layout.runtimeGuardPath]),
    command('require-api-sidecar', [
      ...verify,
      '-R',
      requirement(MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER, identity.teamIdentifier),
      layout.apiSidecarPath,
    ]),
    command('require-use-mcp', [
      ...verify,
      '-R',
      requirement(MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER, identity.teamIdentifier),
      layout.useMcpPath,
    ]),
    command('require-runtime-guard', [
      ...verify,
      '-R',
      requirement(MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER, identity.teamIdentifier),
      layout.runtimeGuardPath,
    ]),
    command('verify-broker', [...verify, layout.brokerPath]),
    command('verify-worker', [...verify, layout.dedicatedWorkerPath]),
    command('sign-app', [
      ...sign,
      '--identifier', MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
      '--entitlements', layout.appEntitlementsPath,
      layout.appBundlePath,
    ]),
    command('verify-app', [...verify, '--deep', layout.appBundlePath]),
    command('inspect-app', ['--display', '--verbose=4', '--entitlements', '-', '--xml', layout.appBundlePath]),
    command('require-app', [
      ...verify,
      '-R',
      requirement(
        MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
        identity.teamIdentifier,
        [MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT, MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE],
      ),
      layout.appBundlePath,
    ]),
    command('require-broker', [
      ...verify,
      '-R',
      requirement(
        MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
        identity.teamIdentifier,
        [MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT, MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE],
      ),
      layout.brokerPath,
    ]),
    command('require-worker', [
      ...verify,
      '-R',
      requirement(MACOS_RUNTIME_PRODUCTION_WORKER_NAME, identity.teamIdentifier),
      layout.dedicatedWorkerPath,
    ]),
  );
  if (commands.length !== 17
    || commands.slice(0, 11).some(candidate => candidate.operation === 'sign-app')
    || commands.some(candidate => candidate.operation.startsWith('sign-')
      && candidate.args.includes('--deep'))) {
    throw new Error('macOS runtime production app signing order rejected');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-app-signing-plan',
    commands: Object.freeze(commands),
    commandCount: 17,
    nestedCodeSignedFirst: true,
    deepSigningUsed: false,
    appSigned: false,
    notarized: false,
    installed: false,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}
