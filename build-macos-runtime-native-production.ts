#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  resolveMacOSRuntimeProductionBuildIdentity,
  type MacOSRuntimeProductionBuildIdentityResolution,
} from './src/macOSRuntimeProductionCanary';
import {
  executeMacOSRuntimeProductionArtifactSigning,
  type MacOSRuntimeProductionSigningExecutionReceipt,
} from './src/macOSRuntimeProductionSigningExecutor';
import {
  MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
  MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
  type MacOSRuntimeProductionArtifactLayout,
} from './src/macOSRuntimeProductionSigningPlan';
import {
  removeMacOSRuntimeProductionSourceStage,
  stageMacOSRuntimeProductionSourcesForTest,
  type MacOSRuntimeProductionSourceStage,
} from './stage-macos-runtime-production-sources';

const xcrunPath = '/usr/bin/xcrun';
const plutilPath = '/usr/bin/plutil';

export interface MacOSRuntimeProductionNativeManifest {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-native-production-build';
  readonly mode: 'developer-id-production';
  readonly architecture: 'arm64';
  readonly deploymentTarget: '13.0';
  readonly runtimeMinimum: '26.0';
  readonly pinnedSourceDigest: string;
  readonly broker: Readonly<{
    name: typeof MACOS_RUNTIME_PRODUCTION_BROKER_NAME;
    sha256: string;
  }>;
  readonly dedicatedWorker: Readonly<{
    name: typeof MACOS_RUNTIME_PRODUCTION_WORKER_NAME;
    sha256: string;
  }>;
  readonly bundleInputs: Readonly<{
    brokerPlistSha256: string;
    dedicatedWorkerPlistSha256: string;
    appClientEntitlementsSha256: string;
  }>;
  readonly signing: Readonly<MacOSRuntimeProductionSigningExecutionReceipt>;
  readonly appBundled: false;
  readonly appSigned: false;
  readonly notarized: false;
  readonly installed: false;
  readonly serviceRegistered: false;
  readonly accountCreated: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

/** Build-private callback context; never serialize `identityResolution`. */
export interface MacOSRuntimeProductionNativeContext {
  readonly sourceStage: Readonly<MacOSRuntimeProductionSourceStage>;
  readonly artifactLayout: Readonly<MacOSRuntimeProductionArtifactLayout>;
  readonly identityResolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>;
  readonly manifest: Readonly<MacOSRuntimeProductionNativeManifest>;
}

export function macOSRuntimeProductionTauriBuildEnvironment(
  context: Readonly<MacOSRuntimeProductionNativeContext>,
): Readonly<Record<'AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE', string>> {
  const bridge = realpathSync(context.sourceStage.objectiveCClientBridgePath);
  if (bridge !== context.sourceStage.objectiveCClientBridgePath
    || !bridge.endsWith('/Generated/RuntimeBrokerClientBridge.m')) {
    throw new Error('macOS runtime production client bridge rejected');
  }
  return Object.freeze({
    AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE: bridge,
  });
}

function environment(scratchRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: scratchRoot,
    CLANG_MODULE_CACHE_PATH: join(scratchRoot, 'clang-module-cache'),
    SWIFTPM_MODULECACHE_OVERRIDE: join(scratchRoot, 'swift-module-cache'),
  };
}

function run(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
) {
  const result = spawnSync(executable, [...args], {
    cwd: '/',
    encoding: 'utf8',
    env,
    input: '',
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error || result.signal !== null || result.status !== 0) {
    throw new Error(`macOS runtime production native command failed: ${executable}`);
  }
  return Object.freeze({ stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
}

function assertInside(parent: string, candidate: string): void {
  const value = relative(parent, candidate);
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error('macOS runtime production native path escaped scratch');
  }
}

function exactFile(path: string, executable: boolean): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || realpathSync(path) !== path
    || (executable && (metadata.mode & 0o111) === 0)) {
    throw new Error('macOS runtime production native artifact rejected');
  }
}

function atomicBuildCopy(source: string, destination: string, mode: number): void {
  exactFile(source, mode === 0o500);
  copyFileSync(source, destination);
  chmodSync(destination, mode);
  exactFile(destination, mode === 0o500);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyMachO(path: string, env: NodeJS.ProcessEnv): void {
  const architectures = run(xcrunPath, ['lipo', '-archs', path], env, 10_000).stdout.trim();
  const build = run(xcrunPath, ['vtool', '-show-build', path], env, 10_000).stdout;
  if (architectures !== 'arm64'
    || !/^\s*platform MACOS$/mu.test(build)
    || !/^\s*minos 13\.0$/mu.test(build)) {
    throw new Error('macOS runtime production native Mach-O rejected');
  }
}

function runProtocolSelfTest(path: string, env: NodeJS.ProcessEnv): void {
  exactFile(path, true);
  const result = run(path, [], env, 5_000);
  if (result.stdout !== 'runtime-protocol-self-test: passed\n' || result.stderr !== '') {
    throw new Error('macOS runtime production protocol self-test rejected');
  }
}

export async function withMacOSRuntimeProductionNativeArtifacts<T>(
  consume: (context: Readonly<MacOSRuntimeProductionNativeContext>) => Promise<T> | T,
): Promise<T> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('macOS runtime production native build requires Apple Silicon macOS');
  }
  const resolution = await resolveMacOSRuntimeProductionBuildIdentity();
  if (resolution.identity === null || resolution.diagnostic.result !== 'snapshot-verified') {
    throw new Error(
      `macOS runtime production identity unavailable: ${resolution.diagnostic.reason}`,
    );
  }
  const projectRoot = import.meta.dir;
  const scratchParent = realpathSync(tmpdir());
  let stage: Readonly<MacOSRuntimeProductionSourceStage> | null = null;
  try {
    stage = stageMacOSRuntimeProductionSourcesForTest(resolution, {
      sourcePackageRoot: realpathSync(join(
        projectRoot,
        'src-tauri',
        'native',
        'macos-runtime',
      )),
      typescriptSigningProbePath: realpathSync(join(
        projectRoot,
        'src',
        'macOSRuntimeBrokerSigning.ts',
      )),
      scratchParent,
    });
    const env = environment(stage.scratchRoot);
    for (const name of [
      'BrokerService.entitlements',
      'AppClient.entitlements',
      `${MACOS_RUNTIME_PRODUCTION_BROKER_NAME}.plist`,
      `${MACOS_RUNTIME_PRODUCTION_WORKER_NAME}.plist`,
    ]) {
      run(plutilPath, ['-lint', join(stage.packageRoot, 'Config', name)], env, 10_000);
    }
    const buildScratch = join(stage.scratchRoot, 'swift-build');
    const swiftArguments = [
      'swift', 'build',
      '--package-path', stage.packageRoot,
      '--scratch-path', buildScratch,
      '--configuration', 'release',
      '--disable-automatic-resolution',
    ] as const;
    run(xcrunPath, swiftArguments, env);
    const reportedBinRoot = run(
      xcrunPath,
      [...swiftArguments, '--show-bin-path'],
      env,
    ).stdout.trim();
    if (!isAbsolute(reportedBinRoot) || /[\r\n\u0000]/u.test(reportedBinRoot)) {
      throw new Error('macOS runtime production binary root rejected');
    }
    const binRoot = realpathSync(reportedBinRoot);
    assertInside(stage.scratchRoot, binRoot);
    const builtBroker = join(binRoot, MACOS_RUNTIME_PRODUCTION_BROKER_NAME);
    const builtWorker = join(binRoot, MACOS_RUNTIME_PRODUCTION_WORKER_NAME);
    const builtSelfTest = join(binRoot, 'agentstoz-runtime-protocol-self-test');
    for (const path of [builtBroker, builtWorker, builtSelfTest]) {
      assertInside(stage.scratchRoot, path);
      exactFile(path, true);
    }
    verifyMachO(builtBroker, env);
    verifyMachO(builtWorker, env);
    runProtocolSelfTest(builtSelfTest, env);

    const artifactRoot = join(stage.scratchRoot, 'artifacts');
    const binDestination = join(artifactRoot, 'bin');
    const configDestination = join(artifactRoot, 'Config');
    mkdirSync(binDestination, { recursive: true, mode: 0o700 });
    mkdirSync(configDestination, { mode: 0o700 });
    const layout: MacOSRuntimeProductionArtifactLayout = Object.freeze({
      artifactRoot,
      brokerPath: join(binDestination, MACOS_RUNTIME_PRODUCTION_BROKER_NAME),
      dedicatedWorkerPath: join(binDestination, MACOS_RUNTIME_PRODUCTION_WORKER_NAME),
      brokerEntitlementsPath: join(configDestination, 'BrokerService.entitlements'),
    });
    atomicBuildCopy(builtBroker, layout.brokerPath, 0o500);
    atomicBuildCopy(builtWorker, layout.dedicatedWorkerPath, 0o500);
    atomicBuildCopy(
      join(stage.packageRoot, 'Config', 'BrokerService.entitlements'),
      layout.brokerEntitlementsPath,
      0o400,
    );
    const signing = await executeMacOSRuntimeProductionArtifactSigning(
      resolution,
      layout,
    );
    if (signing.result !== 'verified') {
      throw new Error(`macOS runtime production signing failed: ${signing.reason}`);
    }
    exactFile(layout.brokerPath, true);
    exactFile(layout.dedicatedWorkerPath, true);
    const manifest = Object.freeze({
      schemaVersion: 1,
      kind: 'macos-runtime-native-production-build',
      mode: 'developer-id-production',
      architecture: 'arm64',
      deploymentTarget: '13.0',
      runtimeMinimum: '26.0',
      pinnedSourceDigest: stage.pinnedSourceDigest,
      broker: Object.freeze({
        name: MACOS_RUNTIME_PRODUCTION_BROKER_NAME,
        sha256: sha256(layout.brokerPath),
      }),
      dedicatedWorker: Object.freeze({
        name: MACOS_RUNTIME_PRODUCTION_WORKER_NAME,
        sha256: sha256(layout.dedicatedWorkerPath),
      }),
      bundleInputs: Object.freeze({
        brokerPlistSha256: sha256(join(
          stage.packageRoot,
          'Config',
          `${MACOS_RUNTIME_PRODUCTION_BROKER_NAME}.plist`,
        )),
        dedicatedWorkerPlistSha256: sha256(join(
          stage.packageRoot,
          'Config',
          `${MACOS_RUNTIME_PRODUCTION_WORKER_NAME}.plist`,
        )),
        appClientEntitlementsSha256: sha256(join(
          stage.packageRoot,
          'Config',
          'AppClient.entitlements',
        )),
      }),
      signing,
      appBundled: false,
      appSigned: false,
      notarized: false,
      installed: false,
      serviceRegistered: false,
      accountCreated: false,
      authoritative: false,
      reusable: false,
      ready: false,
    } as const satisfies MacOSRuntimeProductionNativeManifest);
    return await consume(Object.freeze({
      sourceStage: stage,
      artifactLayout: layout,
      identityResolution: resolution,
      manifest,
    }));
  } finally {
    if (stage !== null) removeMacOSRuntimeProductionSourceStage(stage, scratchParent);
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    console.error('usage: bun build-macos-runtime-native-production.ts');
    process.exit(64);
  }
  try {
    const manifest = await withMacOSRuntimeProductionNativeArtifacts(
      context => context.manifest,
    );
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } catch (cause) {
    console.error(cause instanceof Error
      ? cause.message
      : 'macOS runtime production native build failed');
    process.exit(2);
  }
}
