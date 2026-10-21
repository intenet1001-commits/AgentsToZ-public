import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSwiftManifestCompatibility } from './src/swiftManifestCompatibility';
import {
  parseMacOSRuntimeBrokerFixtureProofLine,
  type MacOSRuntimeBrokerFixtureProof,
} from './src/macOSRuntimeBrokerFixture';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = realpathSync(join(projectRoot, 'src-tauri', 'native', 'macos-runtime'));
const artifactRoot = join(packageRoot, '.artifacts');
const configRoot = join(packageRoot, 'Config');

const brokerName = 'com.intenet.agentstozbycs.runtime-broker';
const brokerFixtureName = 'com.intenet.agentstozbycs.runtime-broker-fixture';
const workerFixtureName = 'com.intenet.agentstozbycs.runtime-worker-fixture';
const dedicatedWorkerFixtureName = 'com.intenet.agentstozbycs.runtime-dedicated-worker-fixture';
const protocolSelfTestName = 'agentstoz-runtime-protocol-self-test';
const launchDaemonName = `${brokerName}.plist`;
const dedicatedWorkerFixturePlistName = `${dedicatedWorkerFixtureName}.plist`;
const fixtureFlag = '--harmless-self-test-v1';

const xcrunPath = '/usr/bin/xcrun';
const codesignPath = '/usr/bin/codesign';
const lipoPath = '/usr/bin/lipo';
const plutilPath = '/usr/bin/plutil';
const swVersPath = '/usr/bin/sw_vers';
const artifactPublishLock = join(packageRoot, '.artifacts-publish.lock');

interface CommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface MacOSRuntimeNativeBuildManifest {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-native-development-build';
  readonly mode: 'development-ad-hoc';
  readonly architecture: 'arm64';
  readonly deploymentTarget: '13.0';
  readonly runtimeMinimum: '26.0';
  readonly broker: Readonly<{ name: typeof brokerName; sha256: string }>;
  readonly brokerFixture: Readonly<{ name: typeof brokerFixtureName; sha256: string }>;
  readonly workerFixture: Readonly<{ name: typeof workerFixtureName; sha256: string }>;
  readonly dedicatedWorkerFixture: Readonly<{
    name: typeof dedicatedWorkerFixtureName;
    sha256: string;
  }>;
  readonly fixture: Readonly<MacOSRuntimeBrokerFixtureProof>;
  readonly appBundled: false;
  readonly serviceRegistered: false;
  readonly accountCreated: false;
  readonly dedicatedIdentityFixtureExecuted: false;
  readonly containerInvoked: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

function nativeEnvironment(scratchRoot: string): NodeJS.ProcessEnv {
  return {
    // Honor an explicitly selected Apple toolchain without inheriting arbitrary
    // shell/provider environment into native build subprocesses.
    ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: realpathSync(process.env.DEVELOPER_DIR) } : {}),
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
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  },
): CommandResult {
  const result = spawnSync(executable, [...args], {
    cwd: '/',
    encoding: 'utf8',
    env: options.env,
    input: '',
    killSignal: 'SIGKILL',
    maxBuffer: options.maxOutputBytes ?? 4 * 1024 * 1024,
    shell: false,
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  });
  return Object.freeze({
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  });
}

function commandFailure(executable: string, result: CommandResult): Error {
  const output = `${result.stdout}${result.stderr}`.trim();
  const suffix = output.length === 0 ? '' : `\n${output.slice(-8_192)}`;
  return new Error(`native command failed: ${executable}${suffix}`);
}

function runRequired(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): CommandResult {
  const result = run(executable, args, { env, timeoutMs });
  if (result.error || result.signal !== null || result.status !== 0) {
    throw commandFailure(executable, result);
  }
  return result;
}

function assertInside(parent: string, candidate: string): void {
  const relativePath = relative(resolve(parent), resolve(candidate));
  if (relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)) {
    throw new Error('native build path escaped its scratch root');
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function signDevelopmentArtifact(
  path: string,
  identifier: string,
  env: NodeJS.ProcessEnv,
): void {
  const args = [
    '--force',
    '--sign', '-',
    '--identifier', identifier,
    '--options', 'runtime',
  ];
  args.push(path);
  runRequired(codesignPath, args, env, 10_000);
  runRequired(codesignPath, ['--verify', '--strict', '--verbose=4', path], env, 10_000);
  const details = runRequired(
    codesignPath,
    ['--display', '--verbose=4', path],
    env,
    10_000,
  );
  const combined = `${details.stdout}\n${details.stderr}`;
  const lines = combined.split(/\r?\n/u);
  const codeDirectory = lines.find(line => line.startsWith('CodeDirectory '));
  const flagsMatch = codeDirectory === undefined
    ? null
    : / flags=0x([0-9a-f]+)\(([^)]*)\)(?: |$)/u.exec(codeDirectory);
  const flags = flagsMatch?.[1] === undefined ? 0n : BigInt(`0x${flagsMatch[1]}`);
  const flagNames = new Set((flagsMatch?.[2] ?? '').split(','));
  if (!lines.includes(`Identifier=${identifier}`)
    || !lines.includes('Signature=adhoc')
    || !lines.includes('TeamIdentifier=not set')
    || (flags & 0x2n) === 0n
    || (flags & 0x1_0000n) === 0n
    || !flagNames.has('adhoc')
    || !flagNames.has('runtime')) {
    throw new Error('native development signature rejected');
  }
}

function verifyNativeBinary(
  path: string,
  identifier: string,
  env: NodeJS.ProcessEnv,
): void {
  const architectures = runRequired(lipoPath, ['-archs', path], env, 10_000).stdout.trim();
  if (architectures !== 'arm64') {
    throw new Error('native runtime artifact must be thin arm64');
  }
  const buildInfo = runRequired(
    xcrunPath,
    ['vtool', '-show-build', path],
    env,
    10_000,
  ).stdout;
  if (!/^\s*platform MACOS$/mu.test(buildInfo)
    || !/^\s*minos 13\.0$/mu.test(buildInfo)) {
    throw new Error('native runtime deployment target rejected');
  }
  signDevelopmentArtifact(path, identifier, env);
}

function exactExecutableFailure(
  path: string,
  args: readonly string[],
  expectedStatus: number,
  expectedStderr: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = run(path, args, {
    env,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  if (result.error
    || result.signal !== null
    || result.status !== expectedStatus
    || result.stdout !== ''
    || result.stderr !== `${expectedStderr}\n`) {
    throw new Error(
      `native fail-closed invocation rejected: ${path.slice(path.lastIndexOf('/') + 1)}`
      + ` status=${String(result.status)} signal=${String(result.signal)}`
      + ` stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
}

function atomicStageArtifacts(
  binaries: Readonly<Record<string, string>>,
  manifest: Readonly<MacOSRuntimeNativeBuildManifest>,
): void {
  try {
    mkdirSync(artifactPublishLock, { mode: 0o700 });
  } catch {
    throw new Error(
      'macOS runtime artifact publish is busy; see src-tauri/native/macos-runtime/README.md',
    );
  }
  const backupRoot = join(packageRoot, `.artifacts-backup-${process.pid}-${randomUUID()}`);
  let stageRoot: string | null = null;
  let movedOld = false;
  try {
    stageRoot = mkdtempSync(join(packageRoot, '.artifacts-stage-'));
    const binRoot = join(stageRoot, 'bin');
    const stagedConfigRoot = join(stageRoot, 'Config');
    mkdirSync(binRoot, { mode: 0o700 });
    mkdirSync(stagedConfigRoot, { mode: 0o700 });
    for (const [name, source] of Object.entries(binaries)) {
      const destination = join(binRoot, name);
      copyFileSync(source, destination);
      chmodSync(destination, 0o500);
    }
    for (const name of [
      'AppClient.entitlements',
      'BrokerService.entitlements',
      launchDaemonName,
      dedicatedWorkerFixturePlistName,
    ]) {
      const destination = join(stagedConfigRoot, name);
      copyFileSync(join(configRoot, name), destination);
      chmodSync(destination, 0o400);
    }
    writeFileSync(
      join(stageRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    if (existsSync(artifactRoot)) {
      renameSync(artifactRoot, backupRoot);
      movedOld = true;
    }
    renameSync(stageRoot, artifactRoot);
    if (movedOld) rmSync(backupRoot, { recursive: true, force: true });
  } catch (cause) {
    if (!existsSync(artifactRoot) && movedOld && existsSync(backupRoot)) {
      renameSync(backupRoot, artifactRoot);
    }
    if (stageRoot !== null && existsSync(stageRoot)) {
      rmSync(stageRoot, { recursive: true, force: true });
    }
    throw cause;
  } finally {
    rmdirSync(artifactPublishLock);
  }
}

export function buildMacOSRuntimeNative(
  options: { readonly stageArtifacts?: boolean } = {},
): Readonly<MacOSRuntimeNativeBuildManifest> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('macOS runtime native build requires Apple Silicon macOS');
  }
  const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-macos-runtime-native-')));
  const env = nativeEnvironment(scratchRoot);
  try {
    const swiftCompiler = runRequired(xcrunPath, ['--find', 'swiftc'], env).stdout.trim();
    if (!isAbsolute(swiftCompiler) || /[\r\n]/u.test(swiftCompiler)) {
      throw new Error('xcrun returned an invalid Swift compiler path');
    }
    const manifestApi = join(dirname(realpathSync(swiftCompiler)), '..', 'lib', 'swift', 'pm', 'ManifestAPI');
    const compatibleLibraries = stageSwiftManifestCompatibility(manifestApi, scratchRoot);
    if (compatibleLibraries) {
      env.SWIFTPM_CUSTOM_LIBS_DIR = compatibleLibraries;
      console.info('[macos-runtime-native] using build-local public interfaces for mixed-version CLT metadata');
    }
    for (const name of [
      'AppClient.entitlements',
      'BrokerService.entitlements',
      launchDaemonName,
      dedicatedWorkerFixturePlistName,
    ]) {
      runRequired(plutilPath, ['-lint', join(configRoot, name)], env, 10_000);
    }

    const swiftArguments = [
      'swift', 'build',
      '--package-path', packageRoot,
      '--scratch-path', scratchRoot,
      '--configuration', 'release',
      '--disable-automatic-resolution',
    ] as const;
    runRequired(xcrunPath, swiftArguments, env);
    const binPathResult = runRequired(
      xcrunPath,
      [...swiftArguments, '--show-bin-path'],
      env,
    );
    const reportedBinRoot = binPathResult.stdout.trim();
    if (reportedBinRoot.length === 0 || /[\r\n]/u.test(reportedBinRoot)) {
      throw new Error('native build returned an invalid binary directory');
    }
    const binRoot = realpathSync(reportedBinRoot);
    assertInside(scratchRoot, binRoot);

    const brokerPath = join(binRoot, brokerName);
    const brokerFixturePath = join(binRoot, brokerFixtureName);
    const workerFixturePath = join(binRoot, workerFixtureName);
    const dedicatedWorkerFixturePath = join(binRoot, dedicatedWorkerFixtureName);
    const protocolSelfTestPath = join(binRoot, protocolSelfTestName);
    for (const path of [
      brokerPath,
      brokerFixturePath,
      workerFixturePath,
      dedicatedWorkerFixturePath,
      protocolSelfTestPath,
    ]) {
      assertInside(scratchRoot, path);
      if (!existsSync(path) || realpathSync(path) !== path) {
        throw new Error('native runtime artifact missing or redirected');
      }
    }

    verifyNativeBinary(brokerPath, brokerName, env);
    verifyNativeBinary(brokerFixturePath, brokerFixtureName, env);
    verifyNativeBinary(workerFixturePath, workerFixtureName, env);
    verifyNativeBinary(dedicatedWorkerFixturePath, dedicatedWorkerFixtureName, env);
    verifyNativeBinary(protocolSelfTestPath, protocolSelfTestName, env);

    const selfTest = runRequired(protocolSelfTestPath, [], env, 5_000);
    if (selfTest.stdout !== 'runtime-protocol-self-test: passed\n'
      || selfTest.stderr !== '') {
      throw new Error('native protocol self-test output rejected');
    }
    exactExecutableFailure(
      brokerPath,
      ['--unexpected-argument'],
      64,
      'runtime-broker: invalid invocation',
      env,
    );
    if (typeof process.geteuid === 'function' && process.geteuid() !== 0) {
      const productVersion = runRequired(
        swVersPath,
        ['-productVersion'],
        env,
        5_000,
      ).stdout.trim();
      const hostMajorVersion = Number.parseInt(productVersion.split('.')[0] ?? '', 10);
      if (!Number.isSafeInteger(hostMajorVersion) || hostMajorVersion < 10) {
        throw new Error('macOS host version rejected');
      }
      exactExecutableFailure(
        brokerPath,
        [],
        hostMajorVersion >= 26 ? 77 : 69,
        hostMajorVersion >= 26
          ? 'runtime-broker: root launch daemon required'
          : 'runtime-broker: unsupported platform',
        env,
      );
    }
    exactExecutableFailure(
      brokerFixturePath,
      ['--unexpected-argument'],
      64,
      'runtime-broker-fixture: invalid invocation',
      env,
    );
    exactExecutableFailure(
      workerFixturePath,
      [],
      64,
      'runtime-worker-fixture: invalid invocation',
      env,
    );
    exactExecutableFailure(
      dedicatedWorkerFixturePath,
      [],
      64,
      'runtime-dedicated-worker-fixture: invalid invocation',
      env,
    );
    if (typeof process.geteuid === 'function' && process.geteuid() !== 0) {
      const productVersion = runRequired(
        swVersPath,
        ['-productVersion'],
        env,
        5_000,
      ).stdout.trim();
      const hostMajorVersion = Number.parseInt(productVersion.split('.')[0] ?? '', 10);
      exactExecutableFailure(
        dedicatedWorkerFixturePath,
        ['--harmless-dedicated-worker-fixture-v1'],
        hostMajorVersion >= 26 ? 77 : 69,
        hostMajorVersion >= 26
          ? 'runtime-dedicated-worker-fixture: dedicated identity required'
          : 'runtime-dedicated-worker-fixture: unsupported platform',
        env,
      );
    }

    const fixtureResult = run(brokerFixturePath, [fixtureFlag], {
      env,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    if (fixtureResult.error
      || fixtureResult.signal !== null
      || fixtureResult.status !== 0
      || fixtureResult.stderr !== '') {
      throw commandFailure(brokerFixturePath, fixtureResult);
    }
    const fixture = parseMacOSRuntimeBrokerFixtureProofLine(fixtureResult.stdout);
    const manifest = Object.freeze({
      schemaVersion: 1,
      kind: 'macos-runtime-native-development-build',
      mode: 'development-ad-hoc',
      architecture: 'arm64',
      deploymentTarget: '13.0',
      runtimeMinimum: '26.0',
      broker: Object.freeze({ name: brokerName, sha256: sha256(brokerPath) }),
      brokerFixture: Object.freeze({
        name: brokerFixtureName,
        sha256: sha256(brokerFixturePath),
      }),
      workerFixture: Object.freeze({
        name: workerFixtureName,
        sha256: sha256(workerFixturePath),
      }),
      dedicatedWorkerFixture: Object.freeze({
        name: dedicatedWorkerFixtureName,
        sha256: sha256(dedicatedWorkerFixturePath),
      }),
      fixture,
      appBundled: false,
      serviceRegistered: false,
      accountCreated: false,
      dedicatedIdentityFixtureExecuted: false,
      containerInvoked: false,
      authoritative: false,
      reusable: false,
      ready: false,
    } as const satisfies MacOSRuntimeNativeBuildManifest);

    if (options.stageArtifacts !== false) {
      atomicStageArtifacts({
        [brokerName]: brokerPath,
        [brokerFixtureName]: brokerFixturePath,
        [workerFixtureName]: workerFixturePath,
        [dedicatedWorkerFixtureName]: dedicatedWorkerFixturePath,
      }, manifest);
    }
    return manifest;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--test-only')) {
    console.error('usage: bun build-macos-runtime-native.ts [--test-only]');
    process.exit(64);
  }
  try {
    const manifest = buildMacOSRuntimeNative({
      stageArtifacts: args[0] !== '--test-only',
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'native runtime build failed');
    process.exit(1);
  }
}
