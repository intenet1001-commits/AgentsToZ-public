import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  withMacOSRuntimeProductionNativeArtifacts,
  macOSRuntimeProductionTauriBuildEnvironment,
  type MacOSRuntimeProductionNativeContext,
} from '../build-macos-runtime-native-production';
import { buildSidecars } from '../build-sidecar';
import { verifyReleaseSource, type ReleaseSource } from '../releaseSourceGuard';
import {
  finalizeMacOSRuntimeProductionApp,
  type MacOSRuntimeProductionAppBuildReceipt,
} from './macOSRuntimeProductionAppBuild';

export type MacOSRuntimeProductionAppPipelineOperation =
  | 'build-frontend'
  | 'build-unsigned-app';

export interface MacOSRuntimeProductionAppPipelineCommand {
  readonly operation: MacOSRuntimeProductionAppPipelineOperation;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The single place a planned command becomes an argv.
 *
 * The planner resolves `executable` to an absolute path inside
 * `node_modules/.bin`, but the executor used to spawn `[...command.args]`
 * alone, making argv[0] the literal string `build` and letting PATH choose the
 * binary. The unsigned-app command prepends `<projectRoot>/scripts/macos-bin`
 * to its own PATH, so a file named `build` dropped there would have produced
 * the `.app` that is subsequently Developer ID signed and notarized.
 */
export function macOSRuntimeProductionAppPipelineSpawnArgv(
  command: Readonly<MacOSRuntimeProductionAppPipelineCommand>,
): readonly string[] {
  return Object.freeze([command.executable, ...command.args]);
}

export interface MacOSRuntimeProductionAppPipelinePlan {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-app-pipeline-plan';
  readonly appBundlePath: string;
  readonly commands: readonly [
    Readonly<MacOSRuntimeProductionAppPipelineCommand>,
    Readonly<MacOSRuntimeProductionAppPipelineCommand>,
  ];
  readonly tauriCodeSigningDisabled: true;
  readonly manualInsideOutSigningRequired: true;
  readonly notarized: false;
  readonly installed: false;
  readonly executionAuthorized: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeProductionAppPipelineReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-app-pipeline';
  readonly result: 'signed-awaiting-notarization';
  readonly sourceCommitVerified: true;
  readonly sidecarsBuiltWithProductionPin: true;
  readonly frontendBuilt: true;
  readonly unsignedAppBuiltFresh: true;
  readonly appBuild: Readonly<MacOSRuntimeProductionAppBuildReceipt>;
  readonly notarized: false;
  readonly installed: false;
  readonly serviceRegistered: false;
  readonly executionAuthorized: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeProductionAppPipelineDependencies {
  verifySource(): Readonly<ReleaseSource>;
  withNativeArtifacts<T>(
    consume: (context: Readonly<MacOSRuntimeProductionNativeContext>) => Promise<T> | T,
  ): Promise<T>;
  buildProductionSidecars(
    context: Readonly<MacOSRuntimeProductionNativeContext>,
  ): Promise<void>;
  tauriEnvironment(
    context: Readonly<MacOSRuntimeProductionNativeContext>,
  ): Readonly<Record<string, string>>;
  run(command: Readonly<MacOSRuntimeProductionAppPipelineCommand>): Promise<void>;
  now(): number;
  assertFreshApp(appBundlePath: string, buildStartedAt: number): void;
  finalize(
    context: Readonly<MacOSRuntimeProductionNativeContext>,
    appBundlePath: string,
  ): Promise<Readonly<MacOSRuntimeProductionAppBuildReceipt>>;
}

function frozenCommand(
  operation: MacOSRuntimeProductionAppPipelineOperation,
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Readonly<MacOSRuntimeProductionAppPipelineCommand> {
  return Object.freeze({
    operation,
    executable,
    args: Object.freeze([...args]),
    cwd,
    env: Object.freeze({ ...env }),
  });
}

export function planMacOSRuntimeProductionAppPipeline(
  context: Readonly<MacOSRuntimeProductionNativeContext>,
  options: Readonly<{
    projectRoot?: string;
    targetDir?: string;
    tauriEnvironment?: Readonly<Record<string, string>>;
    releaseSourceSha: string;
  }>,
): Readonly<MacOSRuntimeProductionAppPipelinePlan> {
  const projectRoot = options.projectRoot ?? realpathSync(join(import.meta.dir, '..'));
  const targetDir = options.targetDir ?? join(homedir(), 'cargo-targets', 'portmanager');
  if (!/^[0-9a-f]{40}$/u.test(options.releaseSourceSha)
    || context.identityResolution.identity === null
    || context.identityResolution.diagnostic.result !== 'snapshot-verified') {
    throw new Error('macOS runtime production app pipeline input rejected');
  }
  const frontend = join(projectRoot, 'node_modules', '.bin', 'vite');
  const tauri = join(projectRoot, 'node_modules', '.bin', 'tauri');
  const appBundlePath = join(
    targetDir,
    'release',
    'bundle',
    'macos',
    'AgentsToZ_byCS.app',
  );
  const releaseEnvironment = Object.freeze({
    AGENTSTOZ_RELEASE_SOURCE_SHA: options.releaseSourceSha,
    AGENTSTOZ_RELEASE_SOURCE_STATUS: 'published',
  });
  const tauriEnvironment = Object.freeze({
    ...releaseEnvironment,
    ...(options.tauriEnvironment ?? macOSRuntimeProductionTauriBuildEnvironment(context)),
    CARGO_TARGET_DIR: targetDir,
    PATH: `${join(projectRoot, 'scripts', 'macos-bin')}:${process.env.PATH ?? ''}`,
  });
  const commands = Object.freeze([
    frozenCommand('build-frontend', frontend, ['build'], projectRoot, releaseEnvironment),
    frozenCommand(
      'build-unsigned-app',
      tauri,
      ['build', '--bundles', 'app', '--no-sign', '--ci'],
      projectRoot,
      tauriEnvironment,
    ),
  ] as const);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-app-pipeline-plan',
    appBundlePath,
    commands,
    tauriCodeSigningDisabled: true,
    manualInsideOutSigningRequired: true,
    notarized: false,
    installed: false,
    executionAuthorized: false,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}

function verifiedAppBuild(
  receipt: Readonly<MacOSRuntimeProductionAppBuildReceipt>,
): boolean {
  return receipt.result === 'signed-awaiting-notarization'
    && receipt.helpersBundled
    && receipt.nestedCodeSigned === 3
    && receipt.appSigned
    && receipt.appIntegrityVerified
    && receipt.notarized === false
    && receipt.installed === false
    && receipt.serviceRegistered === false
    && receipt.executionAuthorized === false
    && receipt.authoritative === false
    && receipt.reusable === false
    && receipt.ready === false;
}

export async function executeMacOSRuntimeProductionAppPipelineForTest(
  dependencies: Readonly<MacOSRuntimeProductionAppPipelineDependencies>,
  options: Readonly<{ projectRoot?: string; targetDir?: string }> = {},
): Promise<Readonly<MacOSRuntimeProductionAppPipelineReceipt>> {
  const releaseSource = dependencies.verifySource();
  if (releaseSource.unpublishedOverride
    || !/^[0-9a-f]{40}$/u.test(releaseSource.headSha)
    || releaseSource.headSha !== releaseSource.remoteHeadSha) {
    throw new Error('macOS runtime production release source rejected');
  }
  const revalidateSource = () => {
    // Re-run the clean-worktree and live remote checks. A version bump,
    // checkout, or remote replacement during compilation cannot inherit the
    // release authorization that was granted to the original snapshot.
    const current = dependencies.verifySource();
    if (current.unpublishedOverride
      || current.headSha !== releaseSource.headSha
      || current.remoteHeadSha !== releaseSource.headSha
      || current.remote !== releaseSource.remote
      || current.remoteUrl !== releaseSource.remoteUrl
      || current.defaultBranch !== releaseSource.defaultBranch) {
      throw new Error('macOS runtime production release source changed during build');
    }
  };
  return dependencies.withNativeArtifacts(async context => {
    const tauriEnvironment = dependencies.tauriEnvironment(context);
    const plan = planMacOSRuntimeProductionAppPipeline(context, {
      ...options,
      tauriEnvironment,
      releaseSourceSha: releaseSource.headSha,
    });
    await dependencies.buildProductionSidecars(context);
    await dependencies.run(plan.commands[0]);
    const buildStartedAt = dependencies.now();
    await dependencies.run(plan.commands[1]);
    dependencies.assertFreshApp(plan.appBundlePath, buildStartedAt);
    revalidateSource();
    const appBuild = await dependencies.finalize(context, plan.appBundlePath);
    if (!verifiedAppBuild(appBuild)) {
      throw new Error('macOS runtime production app build receipt rejected');
    }
    revalidateSource();
    return Object.freeze({
      schemaVersion: 1,
      kind: 'macos-runtime-production-app-pipeline',
      result: 'signed-awaiting-notarization',
      sourceCommitVerified: true,
      sidecarsBuiltWithProductionPin: true,
      frontendBuilt: true,
      unsignedAppBuiltFresh: true,
      appBuild,
      notarized: false,
      installed: false,
      serviceRegistered: false,
      executionAuthorized: false,
      authoritative: false,
      reusable: false,
      ready: false,
    });
  });
}

function exactFreshApp(appBundlePath: string, buildStartedAt: number): void {
  const app = lstatSync(appBundlePath);
  const executablePath = join(appBundlePath, 'Contents', 'MacOS', 'app');
  const executable = lstatSync(executablePath);
  if (!app.isDirectory()
    || app.isSymbolicLink()
    || realpathSync(appBundlePath) !== appBundlePath
    || !executable.isFile()
    || executable.isSymbolicLink()
    || realpathSync(executablePath) !== executablePath
    || statSync(executablePath).mtimeMs < buildStartedAt) {
    throw new Error('macOS runtime production app is stale or unsafe');
  }
}

const defaultDependencies: MacOSRuntimeProductionAppPipelineDependencies = Object.freeze({
  verifySource() {
    return verifyReleaseSource({
      runGit(args) {
        const result = Bun.spawnSync(['git', ...args], {
          cwd: realpathSync(join(import.meta.dir, '..')),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
    });
  },
  withNativeArtifacts: withMacOSRuntimeProductionNativeArtifacts,
  async buildProductionSidecars(context: Readonly<MacOSRuntimeProductionNativeContext>) {
    await buildSidecars(Object.freeze({
      kind: 'macos-runtime-production',
      identityResolution: context.identityResolution,
    }));
  },
  tauriEnvironment: macOSRuntimeProductionTauriBuildEnvironment,
  async run(command: Readonly<MacOSRuntimeProductionAppPipelineCommand>) {
    const child = Bun.spawn([...macOSRuntimeProductionAppPipelineSpawnArgv(command)], {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`macOS runtime production ${command.operation} failed (${exitCode})`);
    }
  },
  now: Date.now,
  assertFreshApp: exactFreshApp,
  finalize: finalizeMacOSRuntimeProductionApp,
});

export async function executeMacOSRuntimeProductionAppPipeline(): Promise<
  Readonly<MacOSRuntimeProductionAppPipelineReceipt>
> {
  return executeMacOSRuntimeProductionAppPipelineForTest(defaultDependencies);
}
