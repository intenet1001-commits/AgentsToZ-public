#!/usr/bin/env bun

import { join } from "node:path";

const TAURI_CONF_PATH = join(import.meta.dir, "src-tauri/tauri.conf.json");
const CARGO_TOML_PATH = join(import.meta.dir, "src-tauri/Cargo.toml");
const BUILD_NUMBER_PATH = join(import.meta.dir, "build-number.json");
const IOS_PROJECT_PATH = join(import.meta.dir, "mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj");

async function updateVersion() {
  try {
    // 빌드 번호 읽기 → 증가
    const bnFile = Bun.file(BUILD_NUMBER_PATH);
    const { buildNumber } = await bnFile.json() as { buildNumber: number };
    const next = buildNumber + 1;

    // build-number.json 갱신
    await Bun.write(BUILD_NUMBER_PATH, JSON.stringify({ buildNumber: next }, null, 2) + '\n');

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
