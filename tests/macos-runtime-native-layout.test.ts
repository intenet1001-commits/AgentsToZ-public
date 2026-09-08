import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const packageSource = source('src-tauri/native/macos-runtime/Package.swift');
const contractSource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeBrokerProtocol/Contract.swift',
);
const securitySource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeBrokerProtocol/SecurityRequirements.swift',
);
const brokerSource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeBroker/main.swift',
);
const dedicatedFixtureCoordinatorSource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeBroker/DedicatedIdentityFixture.swift',
);
const dedicatedAccountProvisionerSource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeBroker/DedicatedAccountProvisioner.swift',
);
const fixtureSource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeBrokerFixture/main.swift',
);
const workerSource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeWorkerFixture/main.swift',
);
const dedicatedWorkerSource = source(
  'src-tauri/native/macos-runtime/Sources/RuntimeDedicatedWorkerFixture/main.swift',
);
const launchDaemonSource = source(
  'src-tauri/native/macos-runtime/Config/com.intenet.agentstozbycs.runtime-broker.plist',
);
const clientEntitlements = source(
  'src-tauri/native/macos-runtime/Config/AppClient.entitlements',
);
const brokerEntitlements = source(
  'src-tauri/native/macos-runtime/Config/BrokerService.entitlements',
);
const dedicatedWorkerPlist = source(
  'src-tauri/native/macos-runtime/Config/com.intenet.agentstozbycs.runtime-dedicated-worker-fixture.plist',
);
const nativeBuildSource = source('build-macos-runtime-native.ts');
const productionNativeBuildSource = source('build-macos-runtime-native-production.ts');
const productionIdentitySource = source('src/macOSRuntimeProductionIdentity.ts');
const productionCanarySource = source('src/macOSRuntimeProductionCanary.ts');
const productionInspectionSource = source('inspect-macos-runtime-production.ts');
const tauriBuildSource = source('src-tauri/build.rs');
const clientBridgeHeader = source(
  'src-tauri/native/macos-runtime/ClientBridge/RuntimeBrokerClientBridge.h',
);
const clientBridgeSource = source(
  'src-tauri/native/macos-runtime/ClientBridge/RuntimeBrokerClientBridge.m',
);
const rustClientBridgeSource = source('src-tauri/src/macos_runtime_client_bridge.rs');
const tauriSource = source('src-tauri/src/lib.rs');
const tauriConfig = JSON.parse(source('src-tauri/tauri.conf.json'));
const runtimeProtocolSource = source('src/agentRuntimeProtocol.ts');
const verifyWorkflow = source('.github/workflows/verify.yml');

describe('macOS native runtime boundary layout', () => {
  test('keeps production signing discovery and canary snapshots non-authoritative', () => {
    expect(productionIdentitySource).toContain("scope: 'build-keychain-snapshot-only'");
    expect(productionCanarySource).toContain("scope: 'build-key-possession-snapshot-only'");
    expect(productionCanarySource).toContain("'/usr/bin/true'");
    expect(productionCanarySource).toContain("'/usr/bin/codesign'");
    expect(productionCanarySource).toContain("'--timestamp'");
    expect(productionCanarySource).toContain('certificate leaf[subject.OU]');
    expect(productionInspectionSource).toContain('authoritative: false');
    expect(productionInspectionSource).toContain('reusable: false');
    expect(productionInspectionSource).toContain('ready: false');
    expect(productionInspectionSource).not.toContain('teamIdentifier');
    expect(productionInspectionSource).not.toContain('certificateFingerprint');
    expect(productionNativeBuildSource).toContain('resolveMacOSRuntimeProductionBuildIdentity');
    expect(productionNativeBuildSource).toContain('stageMacOSRuntimeProductionSourcesForTest');
    expect(productionNativeBuildSource).toContain('executeMacOSRuntimeProductionArtifactSigning');
    expect(productionNativeBuildSource).toContain('withMacOSRuntimeProductionNativeArtifacts');
    expect(productionNativeBuildSource).toContain('bundleInputs: Object.freeze({');
    expect(productionNativeBuildSource).not.toContain("'--sign', '-'");
    expect(productionNativeBuildSource).not.toContain('SMAppService');
    expect(productionNativeBuildSource).not.toContain('/bin/launchctl');
  });

  test('is dependency-free, arm64-shaped and isolated from normal cross-platform builds', () => {
    expect(packageSource).toContain('.macOS(.v13)');
    expect(packageSource).not.toContain('.package(');
    expect(packageSource).toContain('com.intenet.agentstozbycs.runtime-broker');
    expect(packageSource).toContain('RuntimeBrokerFixture');
    expect(packageSource).toContain('RuntimeWorkerFixture');
    expect(packageSource).toContain('RuntimeDedicatedWorkerFixture');
    expect(tauriConfig.bundle.macOS.files).toBeUndefined();
    expect(tauriConfig.bundle.resources).not.toContain('native/macos-runtime');
    expect(runtimeProtocolSource).toContain(
      "export const AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED = false as const;",
    );
  });

  test('keeps the production XPC interface bounded and live-peer authenticated', () => {
    expect(contractSource.match(/func probe\(/gu)).toHaveLength(1);
    expect(contractSource).toContain('func probe(_ challenge: NSData');
    expect(contractSource.match(/func runDedicatedIdentityFixture\(/gu)).toHaveLength(1);
    expect(contractSource.match(/func provisionDedicatedIdentity\(/gu)).toHaveLength(1);
    expect(contractSource).toContain('_ challenge: NSData');
    for (const rejected of ['execute', 'command', 'workingDirectory', 'environment', 'credential']) {
      expect(contractSource).not.toContain(`func ${rejected}`);
    }
    expect(brokerSource).toContain('geteuid() == 0, getegid() == 0');
    expect(brokerSource).toContain('getppid() == 1');
    expect(brokerSource).toContain('currentProcessSatisfiesBrokerRequirement');
    expect(brokerSource).toContain('setConnectionCodeSigningRequirement');
    expect(brokerSource).toContain('NSXPCListener(');
    expect(brokerSource).not.toContain('ProcessInfo.processInfo.environment');
    expect(brokerSource).not.toContain('CommandLine.arguments[1]');
    expect(contractSource).toContain('productionTeamIdentifier: String? = nil');
    expect(securitySource).toContain('certificate leaf[subject.OU]');
    expect(securitySource).toContain('entitlement[\\"');
  });

  test('uses the minimal SMAppService LaunchDaemon contract without development registration', () => {
    expect(launchDaemonSource).toContain(
      '<string>Contents/Library/LaunchServices/com.intenet.agentstozbycs.runtime-broker</string>',
    );
    expect(launchDaemonSource.match(/<key>com\.intenet\.agentstozbycs\.runtime-broker<\/key>/gu))
      .toHaveLength(1);
    expect(launchDaemonSource).toContain('<key>Label</key>');
    expect(launchDaemonSource).toContain('<key>BundleProgram</key>');
    expect(launchDaemonSource).toContain('<key>MachServices</key>');
    for (const forbiddenKey of [
      'Program',
      'ProgramArguments',
      'UserName',
      'EnvironmentVariables',
      'RunAtLoad',
      'KeepAlive',
      'SMAuthorizedClients',
      'AssociatedBundleIdentifiers',
    ]) {
      expect(launchDaemonSource).not.toContain(`<key>${forbiddenKey}</key>`);
    }
    for (const forbiddenOperation of [
      'SMAppService.register',
      'SMAppService.unregister',
      'launchctl bootstrap',
      'launchctl bootout',
      'container system start',
      'sudo ',
    ]) {
      expect(nativeBuildSource).not.toContain(forbiddenOperation);
      expect(brokerSource).not.toContain(forbiddenOperation);
      expect(fixtureSource).not.toContain(forbiddenOperation);
      expect(workerSource).not.toContain(forbiddenOperation);
    }
  });

  test('links an exact Tauri-main SMAppService and mutually pinned XPC client bridge', () => {
    expect(tauriBuildSource).toContain('RuntimeBrokerClientBridge.m');
    expect(tauriBuildSource).toContain('AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE');
    expect(tauriBuildSource).toContain('agentstoz-runtime-production-sources-');
    expect(productionNativeBuildSource)
      .toContain('macOSRuntimeProductionTauriBuildEnvironment');
    expect(tauriBuildSource).toContain('CARGO_CFG_TARGET_OS');
    expect(tauriBuildSource).toContain('framework=ServiceManagement');
    expect(clientBridgeHeader).toContain('agentstoz_runtime_broker_service_status');
    expect(clientBridgeHeader).toContain('agentstoz_runtime_broker_register');
    expect(clientBridgeHeader).toContain('agentstoz_runtime_broker_unregister');
    expect(clientBridgeHeader).toContain('agentstoz_runtime_broker_probe');
    expect(clientBridgeHeader).toContain(
      'agentstoz_runtime_broker_run_dedicated_identity_fixture',
    );
    expect(clientBridgeHeader).toContain(
      'agentstoz_runtime_broker_provision_dedicated_identity',
    );
    expect(clientBridgeSource).toContain('daemonServiceWithPlistName:AgentsToZBrokerPlistName');
    expect(clientBridgeSource).toContain('registerAndReturnError');
    expect(clientBridgeSource).toContain('unregisterAndReturnError');
    expect(clientBridgeSource).toContain('NSXPCConnectionPrivileged');
    expect(clientBridgeSource).toContain('setCodeSigningRequirement:brokerRequirement');
    expect(clientBridgeSource).toContain('AgentsToZValidateDedicatedFixtureProof');
    expect(clientBridgeSource).toContain('AgentsToZValidateDedicatedProvisioningProof');
    expect(clientBridgeSource).toContain('SecCodeCheckValidity');
    expect(clientBridgeSource).toContain('@available(macOS 26.0, *)');
    expect(clientBridgeSource).toContain(
      'static NSString *const AgentsToZProductionTeamIdentifier = nil;',
    );
    expect(clientBridgeSource).toContain('/Applications/AgentsToZ_byCS.app');
    expect(clientBridgeSource).toContain('Contents/Library/LaunchDaemons');
    expect(clientBridgeSource).toContain('Contents/Library/LaunchServices');
    expect(clientBridgeSource).not.toContain('ProcessInfo.processInfo.environment');
    expect(clientBridgeSource).not.toContain('getenv(');
    expect(clientBridgeSource).not.toContain('localizedDescription');
    expect(rustClientBridgeSource).toContain('execution_authorized: false');
    expect(rustClientBridgeSource).toContain('reusable: false');
    expect(rustClientBridgeSource).toContain('ready: false');
    expect(rustClientBridgeSource).toContain('if !confirmed');
    expect(tauriSource).toContain('agent_runtime_native_broker_status');
    expect(tauriSource).toContain('agent_runtime_native_broker_register');
    expect(tauriSource).toContain('agent_runtime_native_broker_unregister');
    expect(tauriSource).toContain('agent_runtime_native_broker_probe');
    expect(tauriSource).toContain(
      'agent_runtime_native_broker_dedicated_identity_fixture',
    );
    expect(tauriSource).toContain(
      'agent_runtime_native_broker_provision_dedicated_identity',
    );
  });

  test('pins one versioned role entitlement per production peer', () => {
    expect(clientEntitlements.match(/<key>/gu)).toHaveLength(1);
    expect(clientEntitlements).toContain(
      '<key>com.intenet.agentstozbycs.runtime-broker.client</key>',
    );
    expect(clientEntitlements).toContain('<string>client-v1</string>');
    expect(brokerEntitlements.match(/<key>/gu)).toHaveLength(1);
    expect(brokerEntitlements).toContain(
      '<key>com.intenet.agentstozbycs.runtime-broker.service</key>',
    );
    expect(brokerEntitlements).toContain('<string>service-v1</string>');
  });

  test('keeps process launch in the development fixture and the worker inert', () => {
    expect(fixtureSource).toContain('let process = Process()');
    expect(fixtureSource).toContain('SecRandomCopyBytes');
    expect(fixtureSource).toContain('maximumWireBytes');
    expect(fixtureSource).toContain('.seconds(3)');
    expect(brokerSource).not.toContain('Process()');
    for (const forbidden of [
      'Process()',
      'URLSession',
      'Network',
      'posix_spawn',
      'execve',
      'system(',
      'Apple Container',
    ]) {
      expect(workerSource).not.toContain(forbidden);
    }
  });

  test('makes the dedicated worker proof possible only in the fixed background identity', () => {
    expect(dedicatedWorkerSource).toContain('dedicatedIdentifierRange');
    expect(dedicatedWorkerSource).toContain('dedicatedAccountName');
    expect(dedicatedWorkerSource).toContain('dedicatedAccountHome');
    expect(dedicatedWorkerSource).toContain('dedicatedAccountShell');
    expect(dedicatedWorkerSource).toContain('getppid() == 1');
    expect(dedicatedWorkerSource).toContain('groups.contains(0)');
    expect(dedicatedWorkerSource).toContain('groups.contains(80)');
    expect(dedicatedWorkerSource).toContain('managerName == "Background"');
    expect(dedicatedWorkerSource).toContain('URL(fileURLWithPath: "/bin/launchctl")');
    expect(dedicatedWorkerSource).toContain('process.arguments = ["managername"]');
    expect(dedicatedWorkerSource).toContain('.seconds(3)');
    expect(dedicatedWorkerSource).toContain('"networkTouched": false');
    expect(dedicatedWorkerSource).toContain('"fileMutationPerformed": false');
    expect(dedicatedWorkerSource).toContain('"containerInvoked": false');
    expect(dedicatedWorkerSource).toContain('"authoritative": false');
    expect(dedicatedWorkerSource).toContain('"reusable": false');
    expect(dedicatedWorkerSource).toContain('"ready": false');
    for (const forbidden of [
      'URLSession',
      'Network',
      'posix_spawn',
      'execve',
      'system(',
      'container system',
      'write(to:',
      'FileManager.default.createFile',
    ]) {
      expect(dedicatedWorkerSource).not.toContain(forbidden);
    }
    expect(dedicatedWorkerPlist).toContain('<key>LimitLoadToSessionType</key>');
    expect(dedicatedWorkerPlist).toContain('<string>Background</string>');
    expect(dedicatedWorkerPlist).toContain('<key>RunAtLoad</key>');
    expect(dedicatedWorkerPlist).toContain(
      '/Applications/AgentsToZ_byCS.app/Contents/Library/LaunchServices/com.intenet.agentstozbycs.runtime-dedicated-worker-fixture',
    );
    expect(dedicatedWorkerPlist).toContain('--harmless-dedicated-worker-fixture-v1');
    expect(dedicatedWorkerPlist).not.toContain('<key>UserName</key>');
    expect(dedicatedWorkerPlist).not.toContain('<key>KeepAlive</key>');
  });

  test('runs the dedicated launchd fixture only from the signed root broker with fixed resources', () => {
    expect(brokerSource).toContain('RuntimeDedicatedIdentityFixture.run(challenge: request)');
    expect(dedicatedFixtureCoordinatorSource).toContain('geteuid() == 0');
    expect(dedicatedFixtureCoordinatorSource).toContain('getegid() == 0');
    expect(dedicatedFixtureCoordinatorSource).toContain('getppid() == 1');
    expect(dedicatedFixtureCoordinatorSource).toContain('getpwnam(');
    expect(dedicatedFixtureCoordinatorSource).toContain('getgrnam(');
    expect(dedicatedFixtureCoordinatorSource).toContain('URL(fileURLWithPath: "/bin/launchctl")');
    expect(dedicatedFixtureCoordinatorSource).toContain('["bootstrap", domain]');
    expect(dedicatedFixtureCoordinatorSource).toContain('["bootout", service]');
    expect(dedicatedFixtureCoordinatorSource).toContain('O_NOFOLLOW');
    expect(dedicatedFixtureCoordinatorSource).toContain('O_EXCL');
    expect(dedicatedFixtureCoordinatorSource).toContain('fchown(descriptor, 0, 0)');
    expect(dedicatedFixtureCoordinatorSource).toContain('Set(object.keys) == expectedKeys');
    expect(dedicatedFixtureCoordinatorSource).toContain('challenge.base64EncodedString()');
    expect(dedicatedFixtureCoordinatorSource).not.toContain('container system');
    expect(dedicatedFixtureCoordinatorSource).not.toContain('URLSession');
    expect(dedicatedFixtureCoordinatorSource).not.toContain('ProcessInfo.processInfo.environment');
  });

  test('provisions one fixed non-login account through OpenDirectory with collision-safe rollback', () => {
    expect(packageSource).toContain('.linkedFramework("OpenDirectory")');
    expect(brokerSource).toContain('RuntimeDedicatedAccountProvisioner.provision(challenge: request)');
    expect(dedicatedAccountProvisionerSource).toContain('import OpenDirectory');
    expect(dedicatedAccountProvisionerSource).toContain('getpwnam(accountName)');
    expect(dedicatedAccountProvisionerSource).toContain('getgrnam(accountName)');
    expect(dedicatedAccountProvisionerSource).toContain('getpwuid(identifier) == nil');
    expect(dedicatedAccountProvisionerSource).toContain('getgrgid(gid_t(value)) == nil');
    expect(dedicatedAccountProvisionerSource).toContain('kODAttributeTypePassword: "*"');
    expect(dedicatedAccountProvisionerSource).toContain('dedicatedAccountHome');
    expect(dedicatedAccountProvisionerSource).toContain('dedicatedAccountShell');
    expect(dedicatedAccountProvisionerSource).toContain('groups.contains(0)');
    expect(dedicatedAccountProvisionerSource).toContain('groups.contains(80)');
    expect(dedicatedAccountProvisionerSource).toContain('createdUser.delete()');
    expect(dedicatedAccountProvisionerSource).toContain('createdGroup.delete()');
    expect(dedicatedAccountProvisionerSource).toContain('O_EXCL');
    expect(dedicatedAccountProvisionerSource).toContain('O_NOFOLLOW');
    expect(dedicatedAccountProvisionerSource).toContain('fchown(descriptor, 0, 0)');
    expect(dedicatedAccountProvisionerSource).toContain('"executionAuthorized": false');
    for (const forbidden of [
      'Process()',
      '/usr/bin/dscl',
      '/usr/sbin/sysadminctl',
      'CommandLine.arguments[1]',
      'ProcessInfo.processInfo.environment',
      'URLSession',
      'container system',
    ]) {
      expect(dedicatedAccountProvisionerSource).not.toContain(forbidden);
    }
  });

  test('builds in scratch and stages only explicit development artifacts', () => {
    expect(nativeBuildSource).toContain("mkdtempSync(join(tmpdir(), 'agentstoz-macos-runtime-native-'))");
    expect(nativeBuildSource).toContain("'.artifacts-publish.lock'");
    expect(nativeBuildSource).toContain('macOS runtime artifact publish is busy; see');
    expect(nativeBuildSource).toContain("architectures !== 'arm64'");
    expect(nativeBuildSource).toContain("minos 13\\.0");
    expect(nativeBuildSource).toContain("'--sign', '-'");
    expect(nativeBuildSource).toContain('(flags & 0x1_0000n) === 0n');
    expect(nativeBuildSource).toContain("!flagNames.has('runtime')");
    expect(nativeBuildSource).not.toContain("'--deep'");
    expect(nativeBuildSource).toContain('appBundled: false');
    expect(nativeBuildSource).toContain('serviceRegistered: false');
    expect(nativeBuildSource).toContain('accountCreated: false');
    expect(nativeBuildSource).toContain('dedicatedIdentityFixtureExecuted: false');
    expect(nativeBuildSource).toContain('containerInvoked: false');
    expect(nativeBuildSource).toContain('authoritative: false');
    expect(nativeBuildSource).toContain('reusable: false');
    expect(nativeBuildSource).toContain('ready: false');
    expect(verifyWorkflow).toContain('macos-runtime-native:');
    expect(verifyWorkflow).toContain('runs-on: macos-26');
    expect(verifyWorkflow).toContain('bun run test:macos-runtime-native');
  });
});
