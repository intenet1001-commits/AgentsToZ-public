#!/usr/bin/env bun

import { join } from "node:path";
import { deriveBuildNumber, gitRunner, readBuildNumberFile } from "./buildVersion";

const TAURI_CONF_PATH = join(import.meta.dir, "src-tauri/tauri.conf.json");
const CARGO_TOML_PATH = join(import.meta.dir, "src-tauri/Cargo.toml");
const BUILD_NUMBER_PATH = join(import.meta.dir, "build-number.json");
const IOS_PROJECT_PATH = join(import.meta.dir, "mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj");

async function updateVersion() {
  try {
    // 빌드 번호 = 기준 번호 + 기준 커밋 뒤의 커밋 수 (buildVersion.ts). 올리고 커밋하지 않는다 —
    // 같은 커밋은 어느 기기에서 빌드해도 같은 번호다. 파일은 빌드 동안만 바뀌고 빌드 래퍼가 되돌린다.
    const anchor = readBuildNumberFile(import.meta.dir);
    const derived = deriveBuildNumber(anchor, gitRunner(import.meta.dir));
    if (!derived.ok) throw new Error(`빌드 번호를 정하지 못했습니다: ${derived.reason}`);
    const next = derived.buildNumber;

    // build-number.json: 이번 빌드의 번호. baseCommit을 빼야 빌드 중 이 파일을 읽는 쪽이 두 번 세지 않는다.
    await Bun.write(BUILD_NUMBER_PATH, JSON.stringify(
      anchor.baseCommit
        ? { buildNumber: next, derivedFrom: { buildNumber: anchor.buildNumber, baseCommit: anchor.baseCommit, head: derived.head } }
        : anchor,
      null, 2) + '\n');

    // tauri.conf.json 업데이트
    const confFile = Bun.file(TAURI_CONF_PATH);
    const config = await confFile.json() as Record<string, unknown>;
    const old = config.version;
    config.version = `${next}.0.0`;
    config.productName = 'AgentsToZ_byCS';
    await Bun.write(TAURI_CONF_PATH, JSON.stringify(config, null, 2) + '\n');

    // Windows app.exe file properties come from the Cargo package version.
    // Keep them aligned with tauri.conf.json and the installer version.
    const cargoToml = await Bun.file(CARGO_TOML_PATH).text();
    const nextVersion = `${next}.0.0`;
    const updatedCargoToml = cargoToml.replace(
      /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/,
      `$1"${nextVersion}"`,
    );
    if (updatedCargoToml === cargoToml) {
      throw new Error('src-tauri/Cargo.toml package version was not found');
    }
    await Bun.write(CARGO_TOML_PATH, updatedCargoToml);

    // The native iPhone release family follows the desktop/web build number.
    // USB development builds use a separate timestamp build ID, but checked-in
    // Xcode defaults and unsigned/TestFlight rehearsals must never drift back.
    const iosProject = await Bun.file(IOS_PROJECT_PATH).text();
    if ((iosProject.match(/CURRENT_PROJECT_VERSION = \d+;/g) ?? []).length !== 2
      || (iosProject.match(/MARKETING_VERSION = \d+\.0\.0;/g) ?? []).length !== 2) {
      throw new Error('iOS version settings were not found exactly twice');
    }
    await Bun.write(IOS_PROJECT_PATH, iosProject
      .replaceAll(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${next};`)
      .replaceAll(/MARKETING_VERSION = \d+\.0\.0;/g, `MARKETING_VERSION = ${next}.0.0;`));

    console.log(`[UpdateVersion] ✅ ${old} → v${next} (${next}.0.0)`);

    // 아이콘에 버전 번호 스탬프 — Python 없으면 스킵
    const stampScript = join(import.meta.dir, "stamp-icon.py");
    const pyCandidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
    let stamped = false;
    for (const pyCmd of pyCandidates) {
      try {
        const stamp = Bun.spawn([pyCmd, stampScript], { stdout: "inherit", stderr: "inherit" });
        const exitCode = await stamp.exited;
        if (exitCode === 0) { stamped = true; break; }
      } catch { /* 해당 python 명령어 없음 — 다음 시도 */ }
    }
    if (!stamped) console.warn(`[UpdateVersion] ⚠️ Python 없음 — 아이콘 스탬프 스킵 (빌드는 계속)`);
  } catch (error) {
    console.error(`[UpdateVersion] ❌ 에러:`, error);
    process.exit(1);
  }
}

updateVersion();
