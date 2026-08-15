#!/usr/bin/env bun

/**
 * 설치형 Tauri 앱이 로컬 웹(9000)과 동일한 API 구현을 사용하도록
 * api-server.ts를 현재 플랫폼용 단일 실행 파일로 컴파일한다.
 *
 * 생성물은 Tauri resource로만 번들되며 Git에는 포함하지 않는다.
 */

import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const projectRoot = import.meta.dir;
const resourceDir = join(projectRoot, "src-tauri", "resources");
const templateResourceDir = join(resourceDir, "templates");
const unixOutput = join(resourceDir, "agentstoz-api-sidecar");
const windowsOutput = `${unixOutput}.exe`;
const outputPath = process.platform === "win32" ? windowsOutput : unixOutput;

mkdirSync(resourceDir, { recursive: true });
rmSync(templateResourceDir, { recursive: true, force: true });
for (const name of ["hermes", "hermes-plugin"] as const) {
  cpSync(join(projectRoot, "templates", name), join(templateResourceDir, name), { recursive: true });
}

// 다른 플랫폼에서 남은 생성물이 함께 패키징되지 않도록 현재 대상의 반대쪽만 정리한다.
rmSync(process.platform === "win32" ? unixOutput : windowsOutput, { force: true });

console.log(`[build-sidecar] compiling ${process.platform}/${process.arch}`);
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    "api-server.ts",
    "--outfile",
    outputPath,
  ],
  {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await child.exited;
if (exitCode !== 0) {
  console.error(`[build-sidecar] compile failed (${exitCode})`);
  process.exit(exitCode);
}

if (process.platform !== "win32") chmodSync(outputPath, 0o755);
console.log(`[build-sidecar] ready: ${outputPath}`);
