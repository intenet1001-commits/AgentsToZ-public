import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSidecars } from '../build-sidecar';
import { verifyReleaseSource, type ReleaseSource } from '../releaseSourceGuard';
import { resolveMacOSRuntimeProductionBuildIdentity, type MacOSRuntimeProductionBuildIdentityResolution } from './macOSRuntimeProductionCanary';
import { validMacOSRuntimeProductionIdentity } from './macOSRuntimeProductionSigningPlan';
import { MACOS_BASE_EMPTY_ENTITLEMENTS, MACOS_BASE_REQUIRED_FILES, inspectMacOSBaseBundle, signMacOSBaseApp } from './macOSBaseAppSigning';

export function macOSBaseBuildEnvironment(inherited: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'DEVELOPER_DIR', 'SDKROOT']) {
    if (inherited[name]) env[name] = inherited[name]!;
  }
  return { ...env, LANG: 'C', LC_ALL: 'C', MACOSX_DEPLOYMENT_TARGET: '13.0' };
}

export interface MacOSBaseBuildCommand {
  operation: 'frontend' | 'unsigned-app'; executable: string; args: string[];
  cwd: string; env: Record<string, string>;
}

export function planMacOSBaseBuild(projectRoot: string, targetDir: string, sourceSha: string, inherited: NodeJS.ProcessEnv): MacOSBaseBuildCommand[] {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error('base source SHA rejected');
  const env: Record<string, string> = { ...macOSBaseBuildEnvironment(inherited), CARGO_TARGET_DIR: targetDir,
    AGENTSTOZ_RELEASE_SOURCE_SHA: sourceSha, AGENTSTOZ_RELEASE_SOURCE_STATUS: 'published' };
  const config = { build: { beforeBuildCommand: '' }, bundle: {
    resources: MACOS_BASE_REQUIRED_FILES.filter(path => path.startsWith('Contents/Resources/resources/'))
      .map(path => path.replace('Contents/Resources/', '')),
    macOS: { signingIdentity: null, entitlements: null, minimumSystemVersion: '13.0' },
  } };
  return [
    { operation: 'frontend', executable: join(projectRoot, 'node_modules/.bin/vite'), args: ['build'], cwd: projectRoot, env },
    { operation: 'unsigned-app', executable: join(projectRoot, 'node_modules/.bin/tauri'),
      args: ['build', '--bundles', 'app', '--no-sign', '--ci', '--config', JSON.stringify(config)], cwd: projectRoot,
      env: { ...env, PATH: `${join(projectRoot, 'scripts/macos-bin')}:${env.PATH ?? ''}` } },
  ];
}

function assertPublishedPublicSource(source: Readonly<ReleaseSource>): void {
  if (source.unpublishedOverride || !/^[0-9a-f]{40}$/u.test(source.headSha) || source.headSha !== source.remoteHeadSha
    || !/^(?:https:\/\/github\.com\/|git@github\.com:)intenet1001-commits\/AgentsToZ-public(?:\.git)?$/u.test(source.remoteUrl)) {
    throw new Error('Developer ID base builds require the clean, published AgentsToZ-public snapshot');
  }
}

export interface MacOSBasePipelineDependencies {
  verifySource(): Readonly<ReleaseSource>;
  resolveIdentity(): Promise<Readonly<MacOSRuntimeProductionBuildIdentityResolution>>;
  createTarget(): string;
  buildSidecars(env: Record<string, string>): Promise<void>;
  run(command: MacOSBaseBuildCommand): Promise<void>;
  assertFresh(app: string, startedAt: number): void;
  sign(identity: Readonly<MacOSRuntimeProductionBuildIdentityResolution>, app: string, entitlements: string): ReturnType<typeof signMacOSBaseApp>;
  now(): number;
}

export async function executeMacOSBaseAppPipelineForTest(projectRoot: string, dependencies: MacOSBasePipelineDependencies) {
  const source = dependencies.verifySource();
  assertPublishedPublicSource(source);
  const identity = await dependencies.resolveIdentity();
  if (!validMacOSRuntimeProductionIdentity(identity)) throw new Error('Developer ID private-key canary failed');
  const targetDir = dependencies.createTarget();
  const app = join(targetDir, 'release/bundle/macos/AgentsToZ_byCS.app');
  const env = macOSBaseBuildEnvironment(process.env);
  const revalidate = () => {
    const current = dependencies.verifySource();
    assertPublishedPublicSource(current);
    if (current.headSha !== source.headSha || current.remoteUrl !== source.remoteUrl
      || current.remote !== source.remote || current.defaultBranch !== source.defaultBranch) throw new Error('base source changed during build');
  };
  await dependencies.buildSidecars(env);
  const commands = planMacOSBaseBuild(projectRoot, targetDir, source.headSha, env);
  await dependencies.run(commands[0]!);
  const startedAt = dependencies.now();
  await dependencies.run(commands[1]!);
  dependencies.assertFresh(app, startedAt);
  revalidate();
  const entitlements = join(targetDir, 'base-empty-entitlements.plist');
  writeFileSync(entitlements, MACOS_BASE_EMPTY_ENTITLEMENTS, { mode: 0o600, flag: 'wx' });
  const signed = await dependencies.sign(identity, app, entitlements);
  if (signed.mode !== 'developer-id-base' || signed.result !== 'signed-awaiting-notarization'
    || !signed.appSigned || signed.nestedCodeSigned !== 3 || !/^[0-9a-f]{64}$/u.test(signed.bundleDigest)
    || signed.enhancedRuntimeEnabled !== false || signed.notarized !== false || signed.installed !== false || signed.ready !== false) {
    throw new Error('base signing receipt rejected');
  }
  revalidate();
  const receipt = Object.freeze({ ...signed, sourceSha: source.headSha, appBundlePath: app,
    sourceCommitVerified: true, unsignedAppBuiltFresh: true } as const);
  writeFileSync(join(targetDir, 'developer-id-base.receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return receipt;
}

export async function executeMacOSBaseAppPipeline() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Developer ID base supports Apple Silicon macOS only');
  const projectRoot = realpathSync(join(import.meta.dir, '..'));
  // Vite's ignored local env files must not enter a public build snapshot.
  if (readdirSync(projectRoot).some(name => name.startsWith('.env') && name !== '.env.example')) throw new Error('base release checkout contains local environment files');
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  return executeMacOSBaseAppPipelineForTest(projectRoot, {
    verifySource: () => {
      const remotes = git(['remote']);
      if (remotes.exitCode !== 0 || remotes.stdout.trim() !== 'origin') throw new Error('base release checkout must have only its public origin');
      return verifyReleaseSource({ runGit: git });
    },
    resolveIdentity: resolveMacOSRuntimeProductionBuildIdentity,
    createTarget: () => {
      const root = join(homedir(), 'cargo-targets/agentstoz/developer-id-base');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return realpathSync(mkdtempSync(join(root, 'candidate-')));
    },
    buildSidecars: env => buildSidecars({ kind: 'macos-developer-id-base' }, { env }),
    run: async command => {
      const child = Bun.spawn([command.executable, ...command.args], { cwd: command.cwd, env: command.env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      if (await child.exited !== 0) throw new Error(`base ${command.operation} build failed`);
    },
    assertFresh: (app, startedAt) => {
      inspectMacOSBaseBundle(app);
      if (lstatSync(join(app, 'Contents/MacOS/app')).mtimeMs < startedAt) throw new Error('base app executable is stale');
    },
    sign: signMacOSBaseApp,
    now: Date.now,
  });
}
