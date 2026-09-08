#!/usr/bin/env bun

/**
 * 설치형 Tauri 앱이 로컬 웹(9000)과 동일한 API 구현을 사용하도록
 * api-server.ts를 현재 플랫폼용 단일 실행 파일로 컴파일한다.
 *
 * 생성물은 Tauri resource로만 번들되며 Git에는 포함하지 않는다.
 */

import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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

export interface SidecarBuildPlan {
  readonly projectRoot: string;
  readonly resourceDir: string;
  readonly outputs: readonly [string, string, string];
  readonly staleOutputs: readonly [string, string, string];
  readonly commands: readonly SidecarBuildCommand[];
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
  return Object.freeze({
    projectRoot,
    resourceDir: paths.resourceDir,
    outputs: Object.freeze(paths.outputs),
    staleOutputs: Object.freeze(paths.staleOutputs),
    commands: Object.freeze(commands),
    productionTeamIdentifierEmbedded: mode.kind === "macos-runtime-production",
  });
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
  // 다른 플랫폼에서 남은 생성물이 함께 패키징되지 않도록 현재 대상의 반대쪽만 정리한다.
  for (const stale of plan.staleOutputs) rmSync(stale, { force: true });

  console.log(`[build-sidecar] compiling ${process.platform}/${process.arch}`);
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
  if (process.platform !== "win32") {
    for (const output of plan.outputs) chmodSync(output, 0o755);
  }
  for (const output of plan.outputs) console.log(`[build-sidecar] ready: ${output}`);
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
