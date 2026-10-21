#!/usr/bin/env bun

/**
 * DMG 빌드 후처리 스크립트
 * Tauri의 DMG 번들러가 실패했을 때 임시 DMG 파일을 최종 위치로 복사합니다.
 */

import { join } from "node:path";
import { homedir } from "os";
import { existsSync, readdirSync, copyFileSync, mkdirSync, statSync } from "node:fs";

const PROJECT_DIR = import.meta.dir;
// .cargo/config.toml의 target-dir 설정과 동일한 경로 (iCloud 밖)
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(homedir(), "cargo-targets", "portmanager");
const MACOS_DIR = join(CARGO_TARGET_DIR, "release/bundle/macos");
const DMG_DIR = join(CARGO_TARGET_DIR, "release/bundle/dmg");
// CARGO_TARGET_DIR 미설정 시 fallback (기본 src-tauri/target)
const FALLBACK_DMG_DIR = join(PROJECT_DIR, "src-tauri/target/release/bundle/dmg");

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function fixDmg() {
  try {
    console.log("[FixDMG] Checking for temporary DMG files...");

    // 1) 최근 10분 내 생성된 DMG가 이미 있으면 빌드 성공 — 모든 처리 건너뜀
    const TEN_MIN = 10 * 60 * 1000;
    if (existsSync(DMG_DIR)) {
      const recentDmg = readdirSync(DMG_DIR)
        .filter(f => f.endsWith(".dmg") && !f.startsWith("rw."))
        .find(f => Date.now() - statSync(join(DMG_DIR, f)).mtime.getTime() < TEN_MIN);
      if (recentDmg) {
        console.log(`[FixDMG] ✅ Recent DMG already exists: ${recentDmg} — skipping`);
        // stale rw.* temp 파일 정리
        if (existsSync(MACOS_DIR)) {
          readdirSync(MACOS_DIR)
            .filter(f => f.startsWith("rw.") && f.endsWith(".dmg"))
            .forEach(f => {
              const p = join(MACOS_DIR, f);
              try { require("node:fs").unlinkSync(p); } catch {}
            });
        }
        return;
      }
    }

    // 2) temp DMG 처리 (CARGO_TARGET_DIR 경로) — 빌드 성공했지만 DMG가 macos/ 에 임시 저장된 경우
    if (existsSync(MACOS_DIR)) {
      const files = readdirSync(MACOS_DIR);
      const tempDmgFiles = files.filter(f => f.startsWith("rw.") && f.endsWith(".dmg"));

      const latestTempDmg = tempDmgFiles.sort().reverse()[0];
      if (latestTempDmg) {
        const tempDmgPath = join(MACOS_DIR, latestTempDmg);
        const finalDmgName = latestTempDmg.replace(/^rw\.\d+\./, "");
        const finalDmgPath = join(DMG_DIR, finalDmgName);
        console.log(`[FixDMG] Found temporary DMG: ${latestTempDmg}`);
        console.log(`[FixDMG] Copying to: ${finalDmgPath}`);
        ensureDir(DMG_DIR);
        copyFileSync(tempDmgPath, finalDmgPath);
        console.log(`[FixDMG] ✅ Successfully created: ${finalDmgName}`);
        return;
      }
    }

    if (existsSync(FALLBACK_DMG_DIR)) {
      const fallbackFiles = readdirSync(FALLBACK_DMG_DIR).filter(f => f.endsWith(".dmg") && !f.startsWith("rw."));
      const latestFallback = fallbackFiles
        .map(f => ({ name: f, mtime: statSync(join(FALLBACK_DMG_DIR, f)).mtime.getTime() }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (latestFallback) {
        const latest = latestFallback.name;
        const dest = join(DMG_DIR, latest);
        if (!existsSync(dest)) {
          const src = join(FALLBACK_DMG_DIR, latest);
          ensureDir(DMG_DIR);
          console.log(`[FixDMG] Copying from fallback path: ${latest}`);
          copyFileSync(src, dest);
          console.log(`[FixDMG] ✅ Successfully created: ${latest}`);
        } else {
          console.log(`[FixDMG] ✅ DMG already in target dir: ${latest}`);
        }
        return;
      }
    }

    console.log("[FixDMG] ℹ️  No DMG files found anywhere.");
  } catch (error) {
    console.error("[FixDMG] ❌ Error:", error);
    process.exit(1);
  }
}

fixDmg();
