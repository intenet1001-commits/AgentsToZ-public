#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { MacOSRuntimeProductionBuildIdentityResolution } from './src/macOSRuntimeProductionCanary';
import {
  removeMacOSRuntimeProductionSourceStage,
  stageMacOSRuntimeProductionSourcesForTest,
} from './stage-macos-runtime-production-sources';

const testTeamIdentifier = 'T3ST1D2026';
const xcrunPath = '/usr/bin/xcrun';

function run(executable: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(executable, [...args], {
    cwd: '/',
    encoding: 'utf8',
    env,
    input: '',
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.signal !== null || result.status !== 0) {
    throw new Error(
      `production source fixture command failed: ${executable}`
      + `\n${`${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-8_192)}`,
    );
  }
  return Object.freeze({ stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('production source compile fixture requires Apple Silicon macOS');
}

const projectRoot = import.meta.dir;
const scratchParent = realpathSync(mkdtempSync(join(
  tmpdir(),
  'agentstoz-production-source-compile-',
)));
const resolution: MacOSRuntimeProductionBuildIdentityResolution = Object.freeze({
  diagnostic: Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-signing-canary',
    scope: 'build-key-possession-snapshot-only',
    result: 'snapshot-verified',
    reason: 'canary-snapshot-verified',
    authoritative: false,
    reusable: false,
    ready: false,
  }),
  identity: Object.freeze({
    certificateFingerprint: 'F'.repeat(40),
    commonName: `Developer ID Application: Test Fixture (${testTeamIdentifier})`,
    teamIdentifier: testTeamIdentifier,
  }),
});

let stage: Awaited<ReturnType<typeof stageMacOSRuntimeProductionSourcesForTest>> | null = null;
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
  const buildScratch = join(scratchParent, 'swift-build');
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: scratchParent,
    CLANG_MODULE_CACHE_PATH: join(scratchParent, 'clang-module-cache'),
    SWIFTPM_MODULECACHE_OVERRIDE: join(scratchParent, 'swift-module-cache'),
  };
  const swiftArgs = [
    'swift', 'build',
    '--package-path', stage.packageRoot,
    '--scratch-path', buildScratch,
    '--configuration', 'release',
    '--disable-automatic-resolution',
  ] as const;
  run(xcrunPath, swiftArgs, env);
  const reportedBinRoot = run(xcrunPath, [...swiftArgs, '--show-bin-path'], env).stdout.trim();
  if (!isAbsolute(reportedBinRoot) || /[\r\n\u0000]/u.test(reportedBinRoot)) {
    throw new Error('generated Swift binary root rejected');
  }
  const binRoot = realpathSync(reportedBinRoot);
  const relativeBinRoot = relative(scratchParent, binRoot);
  if (relativeBinRoot === '..'
    || relativeBinRoot.startsWith(`..${sep}`)
    || isAbsolute(relativeBinRoot)) {
    throw new Error('generated Swift binary root escaped scratch');
  }
  const selfTestPath = join(binRoot, 'agentstoz-runtime-protocol-self-test');
  const selfTestStat = lstatSync(selfTestPath);
  if (!selfTestStat.isFile()
    || selfTestStat.isSymbolicLink()
    || selfTestStat.nlink !== 1
    || realpathSync(selfTestPath) !== selfTestPath) {
    throw new Error('generated Swift self-test artifact rejected');
  }
  const selfTest = run(selfTestPath, [], env);
  if (selfTest.stdout !== 'runtime-protocol-self-test: passed\n' || selfTest.stderr !== '') {
    throw new Error('generated Swift production pin self-test rejected');
  }

  run(xcrunPath, [
    'clang',
    '-fsyntax-only',
    '-fobjc-arc',
    '-fmodules',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-mmacosx-version-min=10.13',
    '-I', join(stage.packageRoot, 'ClientBridge'),
    stage.objectiveCClientBridgePath,
  ], env);

  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
  const transpiledTypescript = transpiler.transformSync(
    await Bun.file(stage.typescriptSigningProbePath).text(),
  );
  if (transpiledTypescript.length === 0
    || !transpiledTypescript.includes(testTeamIdentifier)) {
    throw new Error('generated TypeScript production pin compile rejected');
  }

  process.stdout.write(`${JSON.stringify(Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-source-compile-fixture',
    result: 'passed',
    sourceFilesPinned: 4,
    swiftCompiled: true,
    objectiveCCompiled: true,
    typescriptCompiled: true,
    signed: false,
    serviceRegistered: false,
    accountCreated: false,
    authoritative: false,
    reusable: false,
    ready: false,
  }))}\n`);
} finally {
  if (stage !== null) {
    removeMacOSRuntimeProductionSourceStage(stage, scratchParent);
  }
  rmSync(scratchParent, { recursive: true, force: true });
}
