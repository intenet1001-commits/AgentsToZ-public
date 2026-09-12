#!/usr/bin/env bun

/**
 * macOS 빌드 래퍼 — CARGO_TARGET_DIR을 $HOME/cargo-targets/portmanager 로 동적 설정.
 *
 * 이유:
 * 1. .cargo/config.toml에 절대경로를 하드코딩하면 다른 맥에서 빌드 실패
 * 2. iCloud Drive (Documents/) 안에 프로젝트가 있으면 ETIMEDOUT 에러 발생
 * 3. $HOME을 동적으로 읽어서 모든 맥에서 동일하게 동작
 *
 * 사용법:
 *   bun build-macos.ts [--dmg]
 *   bun build-macos.ts --dmg  → DMG 번들만 빌드
 *   bun build-macos.ts        → 전체 빌드 (.app + DMG)
 *   bun build-macos.ts --allow-unpublished-source → 미공개 소스 테스트용(공식 설치·배포 금지)
 */

import { $ } from "bun";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "os";
import { join } from "path";
import { verifyReleaseSource } from "./releaseSourceGuard";
import { stageMacOSRuntimeDevelopmentBundle } from "./stage-macos-runtime-development-bundle";

const targetDir = join(homedir(), "cargo-targets", "portmanager");
process.env.CARGO_TARGET_DIR = targetDir;

const buildArguments = process.argv.slice(2);
const allowedBuildArguments = new Set(["--dmg", "--allow-unpublished-source"]);
const rejectedBuildArguments = buildArguments.filter(value => !allowedBuildArguments.has(value));
if (rejectedBuildArguments.length > 0) {
  console.error(`[build-macos] 지원하지 않는 옵션: ${rejectedBuildArguments.join(", ")}`);
  if (rejectedBuildArguments.includes("--production-runtime")) {
    console.error(
      "[build-macos] production runtime 서명 pipeline은 아직 연결 전입니다. "
      + "ad-hoc 빌드로 대체하지 않습니다.",
    );
  }
  console.error("usage: bun build-macos.ts [--dmg] [--allow-unpublished-source]");
  process.exit(64);
}

// Tauri clears extended attributes recursively before signing. The xattr binary on
// some macOS versions lacks `-r`; the project shim implements that one operation via
// find and delegates all other calls to /usr/bin/xattr.
process.env.PATH = `${join(import.meta.dir, "scripts", "macos-bin")}:${process.env.PATH ?? ""}`;

const isDmg = buildArguments.includes("--dmg");
const allowUnpublishedSource = buildArguments.includes("--allow-unpublished-source");
const appBundlePath = join(targetDir, "release", "bundle", "macos", "AgentsToZ_byCS.app");
const dmgDir = join(targetDir, "release", "bundle", "dmg");
const tauriBin = join(import.meta.dir, "node_modules", ".bin", process.platform === "win32" ? "tauri.exe" : "tauri");

console.log(`[build-macos] CARGO_TARGET_DIR=${targetDir}`);
console.log(`[build-macos] Build type: ${isDmg ? "DMG only" : "full (.app + DMG)"}`);

// Release provenance gate. Run this before update-version.ts so a rejected
// build cannot dirty the worktree or consume a build number. The live remote
// HEAD is queried instead of trusting a possibly stale origin/HEAD cache.
const releaseSource = verifyReleaseSource({
  allowUnpublishedSource,
  runGit(args) {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  },
});
if (releaseSource.unpublishedOverride) {
  console.warn(`[build-macos] ⚠️ 미공개 소스 테스트 빌드: ${releaseSource.headSha}`);
  console.warn("[build-macos] --allow-unpublished-source 산출물은 공식 설치·배포본으로 취급하지 마세요.");
} else {
  console.log(
    `[build-macos] release source verified: ${releaseSource.remote}/${releaseSource.defaultBranch} @ ${releaseSource.headSha}`,
  );
}
process.env.AGENTSTOZ_RELEASE_SOURCE_SHA = releaseSource.headSha;
process.env.AGENTSTOZ_RELEASE_SOURCE_STATUS = releaseSource.unpublishedOverride ? "unpublished" : "published";

if (!existsSync(tauriBin)) {
  console.error(`[build-macos] Tauri CLI를 찾을 수 없습니다: ${tauriBin}`);
  console.error("[build-macos] 먼저 bun install --frozen-lockfile 을 실행하세요.");
  process.exit(1);
}

// 1. 버전 업데이트
await $`bun update-version.ts`;

// 업데이트된 버전 번호 읽기
const { buildNumber: newVersion } = await Bun.file("build-number.json").json() as { buildNumber: number };

// 2. Frontend 빌드
await $`bun run build:sidecar`;
await $`bun run build:macos-runtime-native`;
await $`bun run build`;

// 3. Tauri 빌드 (CARGO_TARGET_DIR 환경변수가 자동으로 상속됨)
const tauriBuildStartedAt = Date.now();
if (isDmg) {
  const result = await $`${tauriBin} build --bundles dmg`.nothrow();
  // DMG 후처리 (실패해도 fix-dmg 실행)
  await $`bun fix-dmg.ts`;
  if (result.exitCode !== 0) {
    const hasFreshApp = existsSync(appBundlePath) && statSync(appBundlePath).mtimeMs >= tauriBuildStartedAt;
    const hasFreshDmg = existsSync(dmgDir) && readdirSync(dmgDir)
      .filter(file => file.endsWith(".dmg"))
      .some(file => statSync(join(dmgDir, file)).mtimeMs >= tauriBuildStartedAt);
    if (!hasFreshApp || !hasFreshDmg) {
      console.error(`[build-macos] Tauri 빌드 실패 (exit code ${result.exitCode}) — 이전 번들을 성공으로 재사용하지 않습니다.`);
      process.exit(result.exitCode || 1);
    }
    console.log("[build-macos] ⚠️ Tauri DMG 마무리 오류 — 이번 빌드에서 생성된 app/DMG를 fix-dmg로 복구 완료");
  }
} else {
  const result = await $`${tauriBin} build`.nothrow();
  // DMG 후처리 — bundle_dmg.sh 실패 시 임시 DMG로 자동 복구
  await $`bun fix-dmg.ts`;
  if (result.exitCode !== 0) {
    const hasFreshApp = existsSync(appBundlePath) && statSync(appBundlePath).mtimeMs >= tauriBuildStartedAt;
    const hasFreshDmg = existsSync(dmgDir) && readdirSync(dmgDir)
      .filter(file => file.endsWith(".dmg"))
      .some(file => statSync(join(dmgDir, file)).mtimeMs >= tauriBuildStartedAt);
    if (!hasFreshApp || !hasFreshDmg) {
      console.error(`[build-macos] Tauri 빌드 실패 (exit code ${result.exitCode}) — 이전 번들을 성공으로 재사용하지 않습니다.`);
      process.exit(result.exitCode || 1);
    }
    console.log("[build-macos] ⚠️ Tauri DMG 마무리 오류 — 이번 빌드에서 생성된 app/DMG를 fix-dmg로 복구 완료");
  }
}

// Ad-hoc signing normally gives the app a CDHash-only designated requirement,
// which changes on every build and makes macOS ask for Documents permission
// again. The bundle ID is unique to AgentsToZ, so seal the unpacked app with a
// stable identifier-based requirement after Tauri finishes signing it.
if (existsSync(appBundlePath)) {
  const runtimeStage = stageMacOSRuntimeDevelopmentBundle({
    appBundlePath,
    artifactRoot: join(
      import.meta.dir,
      "src-tauri",
      "native",
      "macos-runtime",
      ".artifacts",
    ),
  });
  console.log(`[build-macos] native runtime development layout: ${runtimeStage.result}`);
  const stableRequirement = '=designated => identifier "com.intenet.agentstozbycs"';
  await $`codesign --force --deep --sign - --requirements ${stableRequirement} ${appBundlePath}`;
  await $`codesign --verify --deep --strict ${appBundlePath}`;
  console.log(`[build-macos] stable designated requirement applied: com.intenet.agentstozbycs`);
}

// 4. 버전 파일 git commit (push는 수동)
const gitAdd = await $`git add build-number.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/icons/ mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj`.nothrow();
if (gitAdd.exitCode === 0) {
  const gitCommit = await $`git commit -m "chore: bump to v${newVersion}" -- build-number.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/icons/ mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj`.nothrow();
  if (gitCommit.exitCode === 0) {
    console.log(`\n📦 버전 v${newVersion} commit 완료 — git push로 GitHub에 반영하세요`);
  } else {
    // 변경사항 없으면 commit 불필요 (이미 커밋된 상태)
    console.log(`\n📦 버전 파일 변경 없음 (이미 commit됨)`);
  }
} else {
  console.warn(`\n⚠️ git add 실패 — 수동으로 커밋하세요`);
}

console.log(`\n✅ macOS 빌드 완료`);
console.log(`   .app: ${join(targetDir, "release", "bundle", "macos")}`);
if (isDmg) {
  console.log(`   .dmg: ${join(targetDir, "release", "bundle", "dmg")}`);
}
