/**
 * Windows 빌드 래퍼 — 명시된 CARGO_TARGET_DIR을 존중하고, 없으면
 * %USERPROFILE%\cargo-targets\portmanager 를 사용한다.
 *
 * 이유: 프로젝트가 C:\Windows\System32\ 하위 경로에 있을 때, makensis.exe가
 * System32 아래 파일 읽기를 Windows OS 레벨에서 차단당함(os error 2/5).
 * target dir을 System32 밖으로 빼서 NSIS 번들링이 성공하도록 함.
 *
 * 추가 문제: sidecar 리소스 파일도 System32 경로에 있어 NSIS가 읽지 못함.
 * 빌드 전에 스테이징 경로로 복사하고 tauri.conf.json의 resources를 임시 패치한다.
 */
import { $ } from "bun";
import { homedir } from "os";
import { join, resolve } from "path";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";

const defaultTargetDir = join(homedir(), "cargo-targets", "portmanager");
const configuredTargetDir = process.env.CARGO_TARGET_DIR?.trim();
const targetDir = configuredTargetDir ? resolve(configuredTargetDir) : defaultTargetDir;
process.env.CARGO_TARGET_DIR = targetDir;

console.log(`[build-win] CARGO_TARGET_DIR=${targetDir}`);

if (process.env.CI?.toLowerCase() === "true") {
  console.log("[build-win] CI — committed version is preserved");
} else {
  await $`bun update-version.ts`;
}
await $`bun run build:sidecar`;
await $`bun run build`;

// NSIS cannot read files from C:\Windows\System32\ — stage sidecar outside.
// ⚠️ System32에 있을 때만 스테이징한다. bundle.resources에 절대경로를 넣으면
// Tauri가 드라이브 문자를 떼어내고(`C:/Users/...` → `/Users\...`) src-tauri 기준
// 상대경로로 해석해 "resource path doesn't exist"로 빌드가 죽는다.
// 일반 경로에서는 tauri.conf.json의 상대 경로(resources/agentstoz-api-sidecar*)를 그대로 쓴다.
const projectRoot = import.meta.dir;
const confPath = join(projectRoot, "src-tauri", "tauri.conf.json");
const needsStaging = /^[A-Za-z]:[\\/]Windows[\\/]System32[\\/]/i.test(projectRoot);

let confOriginal: string | null = null;
if (needsStaging) {
  const sidecarName = "agentstoz-api-sidecar.exe";
  const sidecarSrc = join(projectRoot, "src-tauri", "resources", sidecarName);
  const supervisorName = "windows-process-supervisor.ps1";
  const supervisorSrc = join(projectRoot, "src-tauri", "resources", supervisorName);
  const stagingDir = join(homedir(), "cargo-targets", "portmanager-resources");
  const sidecarDst = join(stagingDir, sidecarName);
  const supervisorDst = join(stagingDir, supervisorName);
  mkdirSync(stagingDir, { recursive: true });
  copyFileSync(sidecarSrc, sidecarDst);
  copyFileSync(supervisorSrc, supervisorDst);
  console.log(`[build-win] sidecar staged: ${sidecarDst}`);

  confOriginal = readFileSync(confPath, "utf-8");
  const conf = JSON.parse(confOriginal);
  const stagedGlob = sidecarDst.replace(/\\/g, "/");
  const stagedSupervisor = supervisorDst.replace(/\\/g, "/");
  conf.bundle.resources = {
    [stagedGlob]: sidecarName,
    [stagedSupervisor]: "windows-process-supervisor.ps1",
  };
  writeFileSync(confPath, JSON.stringify(conf, null, 2));
  console.log(`[build-win] tauri.conf.json patched → ${stagedGlob}`);
} else {
  console.log(`[build-win] 일반 경로 — tauri.conf.json의 상대 resources 사용`);
}

try {
  await $`bunx tauri build --bundles nsis`;
} finally {
  if (confOriginal !== null) {
    writeFileSync(confPath, confOriginal);
    console.log(`[build-win] tauri.conf.json restored`);
  }
}

console.log(`\n✅ 빌드 완료: ${join(targetDir, "release", "bundle", "nsis")}\\*.exe`);
