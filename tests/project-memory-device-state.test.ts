import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProjectMemory,
  markProjectMemoryRemembered,
  readProjectMemoryDeviceState,
} from "../project-memory-server";

setDefaultTimeout(30_000);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-device-state-"));
  temps.push(root);
  return root;
}

describe("shared identity and device-local sync state", () => {
  test("new projects keep volatile cursors out of tracked config", () => {
    const root = project();
    initializeProjectMemory({ folderPath: root, projectName: "demo" });
    markProjectMemoryRemembered({ folderPath: root, narrative: "기기 상태 분리를 검증했다" });

    const config = JSON.parse(readFileSync(join(root, ".agent-memory/config.json"), "utf8"));
    const state = JSON.parse(readFileSync(join(root, ".agent-memory/state.json"), "utf8"));
    expect(config.memoryId).toBeTruthy();
    expect(config.sourcePath).toBe(".agent-memory/CORE.md");
    expect(config).not.toHaveProperty("lastPulledRevisionId");
    expect(config).not.toHaveProperty("lastSyncedHash");
    expect(config).not.toHaveProperty("lastRememberedAt");
    expect(state.lastRememberedAt).toBeTruthy();
    expect(state.lastRememberedActivityFingerprint).toBeTruthy();
  });

  test("legacy config state is read once and migrated without losing its baseline", () => {
    const root = project();
    initializeProjectMemory({ folderPath: root, projectName: "demo" });
    const path = join(root, ".agent-memory/config.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, `${JSON.stringify({
      ...legacy,
      lastPulledRevisionId: "rev-old",
      lastSyncedHash: "hash-old",
      lastRememberedAt: "2026-08-01T00:00:00.000Z",
      lastRememberedHead: "head-old",
    }, null, 2)}\n`);
    rmSync(join(root, ".agent-memory/state.json"), { force: true });

    const state = readProjectMemoryDeviceState(root);
    expect(state.lastPulledRevisionId).toBe("rev-old");
    expect(state.lastSyncedHash).toBe("hash-old");
    expect(state.lastRememberedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(state.lastRememberedHead).toBe("head-old");

    markProjectMemoryRemembered({ folderPath: root, narrative: "legacy state migration" });
    const migratedConfig = JSON.parse(readFileSync(path, "utf8"));
    expect(migratedConfig).not.toHaveProperty("lastSyncedHash");
    expect(existsSync(join(root, ".agent-memory/state.json"))).toBe(true);
  });

  test("fresh clones of the same origin derive the same memory ID", () => {
    const a = project();
    const b = project();
    for (const root of [a, b]) {
      git(root, "init", "-q");
      git(root, "remote", "add", "origin", "git@github.com:Acme/SameRepo.git");
      initializeProjectMemory({ folderPath: root, projectName: "same" });
    }
    const configA = JSON.parse(readFileSync(join(a, ".agent-memory/config.json"), "utf8"));
    const configB = JSON.parse(readFileSync(join(b, ".agent-memory/config.json"), "utf8"));
    expect(configA.memoryId).toBe(configB.memoryId);
  });

  test("fork origins derive different memory IDs", () => {
    const a = project();
    const b = project();
    git(a, "init", "-q");
    git(b, "init", "-q");
    git(a, "remote", "add", "origin", "git@github.com:alice/app.git");
    git(b, "remote", "add", "origin", "git@github.com:bob/app.git");
    initializeProjectMemory({ folderPath: a, projectName: "app" });
    initializeProjectMemory({ folderPath: b, projectName: "app" });
    const configA = JSON.parse(readFileSync(join(a, ".agent-memory/config.json"), "utf8"));
    const configB = JSON.parse(readFileSync(join(b, ".agent-memory/config.json"), "utf8"));
    expect(configA.memoryId).not.toBe(configB.memoryId);
  });

  test("state.json is generated as ignored device-local data", () => {
    const root = project();
    initializeProjectMemory({ folderPath: root, projectName: "demo" });
    expect(readFileSync(join(root, ".agent-memory/.gitignore"), "utf8")).toContain("state.json");
  });
});
