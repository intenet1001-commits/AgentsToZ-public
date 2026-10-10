#!/usr/bin/env bun
import {buildDutyKmsg} from './build-duty-kmsg';

/**
 * 설치형 Tauri 앱이 로컬 웹(9000)과 동일한 API 구현을 사용하도록
 * api-server.ts를 현재 플랫폼용 단일 실행 파일로 컴파일한다.
 *
 * 생성물은 Tauri resource로만 번들되며 Git에는 포함하지 않는다.
 */

import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WINDOWS_PTY_NATIVE_FILES, WINDOWS_PTY_RUNTIME_DIR, windowsPtyPrebuildDir } from "./src/windowsPtyRuntime";
import type { MacOSRuntimeProductionBuildIdentityResolution } from "./src/macOSRuntimeProductionCanary";
import { validMacOSRuntimeProductionIdentity } from "./src/macOSRuntimeProductionSigningPlan";

export type SidecarBuildMode =
  | Readonly<{ readonly kind: "development" }>
  | Readonly<{ readonly kind: "macos-developer-id-base" }>
  | Readonly<{
    readonly kind: "macos-runtime-production";
    readonly identityResolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>;
  }>;

export interface SidecarBuildCommand {
  readonly entrypoint: "api-server.ts" | "agentstoz-use-mcp-server.ts" | "agent-runtime-process-guard.ts";
  readonly outfile: string;
  readonly args: readonly string[];
}

export interface SidecarNativeBuildCommand {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly args: readonly string[];
}

export interface SidecarBuildPlan {
  readonly projectRoot: string;
  readonly resourceDir: string;
  readonly outputs: readonly [string, string, string];
  readonly staleOutputs: readonly [string, string, string];
  readonly commands: readonly SidecarBuildCommand[];
  readonly nativeCommands: readonly SidecarNativeBuildCommand[];
  readonly nativeOutputs: readonly string[];
  readonly staleNativeOutputs: readonly string[];
  readonly productionTeamIdentifierEmbedded: boolean;
}

function outputPaths(projectRoot: string, platform: NodeJS.Platform) {
  const resourceDir = join(projectRoot, "src-tauri", "resources");
  const names = [
    "agentstoz-api-sidecar",
    "agentstoz-use-mcp",
    "agentstoz-agent-runtime-guard",
  ] as const;
  const unix = names.map(name => join(resourceDir, name)) as [string, string, string];
  const windows = unix.map(path => `${path}.exe`) as [string, string, string];
  return {
    resourceDir,
    outputs: platform === "win32" ? windows : unix,
    staleOutputs: platform === "win32" ? unix : windows,
  } as const;
}

export function planSidecarBuild(
  mode: SidecarBuildMode,
  options: Readonly<{
    projectRoot?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    bunExecutable?: string;
  }> = {},
): Readonly<SidecarBuildPlan> {
  const projectRoot = options.projectRoot ?? import.meta.dir;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const bunExecutable = options.bunExecutable ?? process.execPath;
  const paths = outputPaths(projectRoot, platform);
  if (mode.kind === 'macos-developer-id-base' && (platform !== 'darwin' || arch !== 'arm64')) {
    throw new Error('macOS Developer ID base sidecars require Apple Silicon');
  }
  let productionDefine: readonly string[] = [];
  if (mode.kind === "macos-runtime-production") {
    if (platform !== "darwin"
      || arch !== "arm64"
      || !validMacOSRuntimeProductionIdentity(mode.identityResolution)) {
      throw new Error("macOS runtime production sidecar identity rejected");
    }
    productionDefine = Object.freeze([
      "--define",
      `__AGENTSTOZ_MACOS_RUNTIME_PRODUCTION_TEAM_IDENTIFIER__=${JSON.stringify(
        mode.identityResolution.identity!.teamIdentifier,
      )}`,
    ]);
  }
  const entries = [
    ["api-server.ts", paths.outputs[0]],
    ["agentstoz-use-mcp-server.ts", paths.outputs[1]],
    ["agent-runtime-process-guard.ts", paths.outputs[2]],
  ] as const;
  const commands = entries.map(([entrypoint, outfile]) => Object.freeze({
    entrypoint,
    outfile,
    args: Object.freeze([
      bunExecutable,
      "build",
      "--compile",
      ...(entrypoint === "api-server.ts" ? productionDefine : []),
      ...(mode.kind === 'macos-developer-id-base' || entrypoint === "agent-runtime-process-guard.ts"
        ? ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"]
        : []),
      entrypoint,
      "--outfile",
      outfile,
    ]),
  }));
  const nativeOutput = join(paths.resourceDir, 'agentstoz-codex-accessibility-helper');
  const nativeCommands = platform === 'darwin' ? [Object.freeze({
    entrypoint: join(projectRoot, 'src-tauri/native/codex-accessibility-helper/main.c'),
    outfile: nativeOutput,
    args: Object.freeze([
      '/usr/bin/clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-framework', 'ApplicationServices',
      join(projectRoot, 'src-tauri/native/codex-accessibility-helper/main.c'),
      '-o', nativeOutput,
    ]),
  })] : [];
  return Object.freeze({
    projectRoot,
    resourceDir: paths.resourceDir,
    outputs: Object.freeze(paths.outputs),
    staleOutputs: Object.freeze(paths.staleOutputs),
    commands: Object.freeze(commands),
    nativeCommands: Object.freeze(nativeCommands),
    nativeOutputs: Object.freeze(nativeCommands.map(command => command.outfile)),
    staleNativeOutputs: Object.freeze(platform === 'darwin' ? [] : [nativeOutput]),
    productionTeamIdentifierEmbedded: mode.kind === "macos-runtime-production",
  });
}

/**
 * Moves an output aside when a live process is holding it open.
 *
 * ⚠️ Windows refuses to overwrite a running executable but **allows renaming
 * one**, because an open handle follows the file rather than its path. Measured:
 * `bun build --compile` failed the whole build with
 * `failed to move executable to ...\agentstoz-use-mcp.exe: EPERM` while two
 * `agentstoz-use-mcp.exe` processes started by `agy` sessions were running --
 * and this repository's rule is never to kill an MCP an AI started, so closing
 * the user's editor was the only way to get a build.
 *
 * The displaced file keeps running under its new name and is swept by a later
 * build once nothing holds it. Nothing in use is ever deleted, and a rename that
 * fails is left alone so the compiler's own EPERM stays the reported error.
 *
 * ⚠️ The displaced copy must land **outside** the resource directory. Shipped
 * resources are globs (`resources/agentstoz-use-mcp*`), so an aside kept next to
 * the output matched one: a 116MB stale binary was bundled into the v598
 * installer, which is both dead weight and a second, older copy of a sidecar
 * inside the package. It also has to stay on the same volume, because
 * `renameSync` cannot cross one -- hence a sibling of `resources/`, not %TEMP%.
 */
const DISPLACED_OUTPUT_DIR = 'displaced-in-use';

export function displaceRunningWindowsOutput(outfile: string): void {
  if (process.platform !== 'win32' || !existsSync(outfile)) return;
  const asideDir = join(dirname(dirname(outfile)), DISPLACED_OUTPUT_DIR);
  const asideFor = (index: number) => join(asideDir, `${basename(outfile)}.in-use-${index}`);
  for (let index = 0; index < 8; index += 1) {
    // Sweep what earlier builds displaced. ⚠️ `force` only swallows ENOENT, and a
    // copy a process is still running raises EBUSY -- throwing here would break
    // the build for the very condition this function exists to survive.
    const stale = asideFor(index);
    try { if (existsSync(stale)) rmSync(stale, { force: true }); } catch { /* still held */ }
  }
  // Opening for write is the same access the compiler needs, so it answers the
  // only question that matters. Measured: a running binary gives EBUSY while a
  // free one opens, which is why nothing is renamed in the common case.
  // ⚠️ Do not probe through `cmd` -- its redirect cannot take a forward-slash
  // path, so every existing output looked held and got displaced needlessly.
  let descriptor: number | undefined;
  try {
    descriptor = openSync(outfile, 'r+');
    return;
  } catch { /* held: fall through to the rename */ }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  mkdirSync(asideDir, { recursive: true });
  for (let index = 0; index < 8; index += 1) {
    const aside = asideFor(index);
    if (existsSync(aside)) continue;
    try {
      renameSync(outfile, aside);
      console.log(`[build-sidecar] ${outfile} was in use — displaced so the build can continue`);
    } catch { continue; }
    return;
  }
}

/**
 * Stages the Workroom's Windows PTY beside the sidecar.
 *
 * `bun build --compile` bundles node-pty's JavaScript but cannot carry its
 * addon: the compiled module resolves `./prebuilds/win32-x64/conpty.node`
 * against a virtual path and fails at runtime. So node-pty is loaded from disk
 * instead (src/windowsPtyRuntime.ts), which means these files have to be here.
 *
 * Only the three addons are copied -- no `conpty/OpenConsole.exe`, no winpty.
 * A measured session reported `_useConptyDll: false`, i.e. it drove the
 * operating system's ConPTY, and the full round trip passed with just these
 * present. `.pdb` symbols are 28 of the package's 30MB and are never shipped.
 */
function stageWindowsPtyRuntime(projectRoot: string, resourceDir: string): void {
  const source = join(projectRoot, 'node_modules', 'node-pty');
  const target = join(resourceDir, WINDOWS_PTY_RUNTIME_DIR, 'node-pty');
  rmSync(join(resourceDir, WINDOWS_PTY_RUNTIME_DIR), { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true });
  cpSync(join(source, 'package.json'), join(target, 'package.json'));
  const prebuild = windowsPtyPrebuildDir();
  mkdirSync(join(target, prebuild), { recursive: true });
  for (const file of WINDOWS_PTY_NATIVE_FILES) {
    cpSync(join(source, prebuild, file), join(target, prebuild, file));
  }
  console.log(`[build-sidecar] staged Windows PTY runtime (${WINDOWS_PTY_NATIVE_FILES.length} addons, ${prebuild})`);
}

/**
 * Builds the Windows containment launcher and puts it beside the sidecar.
 *
 * The Agent Runtime guard cannot contain a provider on Windows by itself -- a
 * Job Object is not a security boundary there (measured: WMI, the task scheduler
 * and the running explorer each put a process outside one) -- so it delegates to
 * `agentstoz-windows-contain`, which runs the provider at low integrity in a
 * kill-on-close job with per-launch staging.
 *
 * ⚠️ Shipping it does **not** turn the Windows Agent Runtime on: that needs the
 * marker file beside the guard registry (src/windowsAgentRuntimeGate.ts). The
 * binary being present and the feature being enabled are deliberately separate,
 * so an upgrade never enables it on its own.
 *
 * Built in release: a debug build of this is both slow and, more to the point,
 * not what was measured.
 */
function buildWindowsContainmentLauncher(projectRoot: string, resourceDir: string): void {
  // Its own package (src-tauri/windows-contain): as a bin of the app crate, Tauri bundled it into every app.
  const manifest = join(projectRoot, 'src-tauri', 'windows-contain', 'Cargo.toml');
  const staged = join(resourceDir, 'agentstoz-windows-contain.exe');
  // ⚠️ Breaking a cycle, not papering over one. `tauri.conf.json` lists this
  // binary as a bundle resource, and Tauri's build script fails when a resource
  // glob matches nothing -- but the binary is produced by the very cargo build
  // that runs that script. An empty placeholder lets the script pass; the real
  // binary replaces it below, and a failed build removes it rather than leaving
  // a zero-byte "launcher" that could be bundled and then spawned.
  if (!existsSync(staged)) writeFileSync(staged, '');
  const built = Bun.spawnSync([
    'cargo', 'build', '--release',
    '--manifest-path', manifest,
  ], { cwd: projectRoot, stdout: 'inherit', stderr: 'inherit' });
  if (built.exitCode !== 0) {
    rmSync(staged, { force: true });
    throw new Error('[build-sidecar] the Windows containment launcher failed to build');
  }
  // CARGO_TARGET_DIR is redirected on Windows (build-win.ts), so the output is
  // found by asking cargo rather than by guessing a path.
  const located = Bun.spawnSync([
    'cargo', 'metadata', '--format-version', '1', '--no-deps',
    '--manifest-path', manifest,
  ], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
  if (located.exitCode !== 0) {
    rmSync(staged, { force: true });
    throw new Error('[build-sidecar] could not locate the cargo target directory');
  }
  const targetDirectory = JSON.parse(located.stdout.toString()).target_directory as string;
  const binary = join(targetDirectory, 'release', 'agentstoz-windows-contain.exe');
  if (!existsSync(binary)) {
    rmSync(staged, { force: true });
    throw new Error(`[build-sidecar] the containment launcher was not produced at ${binary}`);
  }
  cpSync(binary, staged);
  // A placeholder that survived would be bundled and then spawned as a launcher.
  if (statSync(staged).size === 0) {
    rmSync(staged, { force: true });
    throw new Error('[build-sidecar] the staged containment launcher is empty');
  }
  console.log('[build-sidecar] staged the Windows containment launcher');
}

export async function buildSidecars(mode: SidecarBuildMode, options: { env?: Record<string, string> } = {}): Promise<void> {
  const plan = planSidecarBuild(mode);
  const projectRoot = plan.projectRoot;
  mkdirSync(plan.resourceDir, { recursive: true });
  const templateResourceDir = join(plan.resourceDir, "templates");
  rmSync(templateResourceDir, { recursive: true, force: true });
  for (const name of ["hermes", "hermes-plugin"] as const) {
    cpSync(
      join(projectRoot, "templates", name),
      join(templateResourceDir, name),
      { recursive: true },
    );
  }
  const testerTemplates=join(templateResourceDir,'tester-agent');
  mkdirSync(testerTemplates,{recursive:true});
  cpSync(join(projectRoot,'scripts','agentstoz-maintainer.py'),join(testerTemplates,'agentstoz-maintainer.py'));
  if (process.platform === 'win32') {
    stageWindowsPtyRuntime(projectRoot, plan.resourceDir);
    buildWindowsContainmentLauncher(projectRoot, plan.resourceDir);
  }
  // 다른 플랫폼에서 남은 생성물이 함께 패키징되지 않도록 현재 대상의 반대쪽만 정리한다.
  for (const stale of plan.staleOutputs) rmSync(stale, { force: true });
  for (const stale of plan.staleNativeOutputs) rmSync(stale, { force: true });

  console.log(`[build-sidecar] compiling ${process.platform}/${process.arch}`);
  for (const command of [...plan.commands, ...plan.nativeCommands]) {
    displaceRunningWindowsOutput(command.outfile);
  }
  for (const command of plan.commands) {
    const child = Bun.spawn([...command.args], {
      cwd: plan.projectRoot,
      ...(options.env ? { env: options.env } : {}),
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`[build-sidecar] ${command.entrypoint} compile failed (${exitCode})`);
    }
  }
  for (const command of plan.nativeCommands) {
    const child = Bun.spawn([...command.args], {
      cwd: plan.projectRoot,
      ...(options.env ? { env: options.env } : {}),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`[build-sidecar] ${command.entrypoint} compile failed (${exitCode})`);
  }
  if (process.platform !== "win32") {
    for (const output of plan.outputs) chmodSync(output, 0o755);
    for (const output of plan.nativeOutputs) chmodSync(output, 0o755);
  }
  await buildDutyKmsg(plan.projectRoot);
  for (const output of plan.outputs) console.log(`[build-sidecar] ready: ${output}`);
  for (const output of plan.nativeOutputs) console.log(`[build-sidecar] ready: ${output}`);
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    console.error("usage: bun build-sidecar.ts");
    process.exit(64);
  }
  try {
    await buildSidecars(Object.freeze({ kind: "development" }));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "[build-sidecar] compile failed");
    process.exit(1);
  }
}
