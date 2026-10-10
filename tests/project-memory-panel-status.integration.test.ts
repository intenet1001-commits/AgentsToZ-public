import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectMemory } from "../project-memory-server";
import { resolveAppDataDir } from "../src/appDataDir";
import { startTestApiServer } from "./startTestApiServer";

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function post(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

describe("/api/project-memory/panel-status", () => {
  test("returns local, archive and remote status in one response; the local poll reuses the snapshot", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agentstoz-panel-status-")));
    roots.push(home);
    const project = join(home, "projects", "demo");
    mkdirSync(project, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: project });
    const initialized = initializeProjectMemory({ folderPath: project, projectName: "Demo", autoBackup: false });
    const env = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
      PORTMGR_ALLOWED_ORIGINS: "",
    };
    const appData = resolveAppDataDir(process.platform, env, home);
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(appData, "ports.json"), JSON.stringify([{ id: "demo-id", name: "Demo", folderPath: project }]));
    const { baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, ".."), env });
    children.push(child);

    const full = await post(baseUrl, "/api/project-memory/panel-status", { folderPath: project, scope: "full" });
    expect(full.response.status).toBe(200);
    expect(full.body.status.exists).toBe(true);
    expect(full.body.status.config.memoryId).toBe(initialized.config!.memoryId);
    expect(full.body.status).toHaveProperty("sessionRecovery");
    expect(full.body.privateGitHubArchive).toMatchObject({ available: true });
    // No Supabase is configured in this sandbox: the remote half reports its own
    // failure without turning the healthy local status into an error.
    expect(full.body.remote?.ok).toBe(false);
    expect(typeof full.body.remote?.error).toBe("string");

    const local = await post(baseUrl, "/api/project-memory/panel-status", { folderPath: project, scope: "local" });
    expect(local.response.status).toBe(200);
    expect(local.body.remote).toBeNull();
    expect(local.body.stale).toBe(false);
    expect(local.body.computedAt).toBe(full.body.computedAt);

    const missing = await post(baseUrl, "/api/project-memory/panel-status", { folderPath: join(home, "gone"), scope: "local" });
    expect(missing.response.status).toBe(400);
    expect(typeof missing.body.error).toBe("string");
  }, 60_000);
});
