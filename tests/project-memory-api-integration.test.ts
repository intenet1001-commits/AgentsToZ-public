import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectMemory } from "../project-memory-server";
import { resolveAppDataDir } from "../src/appDataDir";
import { parseProjectMemoryEntries } from "../src/projectMemoryRecall";

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForHealth(baseUrl: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw lastError ?? new Error("isolated API server did not become ready");
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

describe("project-memory local HTTP API", () => {
  test("resolves an allowlisted project and closes recall -> feedback -> verified recall", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentstoz-api-home-"));
    roots.push(home);
    const project = join(home, "projects", "demo");
    mkdirSync(project, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: project });
    const status = initializeProjectMemory({
      folderPath: project,
      projectName: "Demo Memory",
      autoBackup: false,
    });
    const sourcePath = join(project, status.config!.sourcePath);
    writeFileSync(sourcePath, `# Project Core Memory\n\n## Key Decisions\n\n### 원격 최신본 확인\nPush 전에 remote head를 확인하고 stale parent면 중단한다.\n`);

    const apiEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
    };
    const appData = resolveAppDataDir(process.platform, apiEnv, home);
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(appData, "ports.json"), JSON.stringify([{
      id: "demo-id",
      name: "Demo Memory",
      folderPath: project,
    }]));

    const port = 31_000 + Math.floor(Math.random() * 2_000);
    const baseUrl = `http://127.0.0.1:${port}`;
    // Use the executable running the suite. GUI/systemd/non-login shells do not
    // necessarily expose the user's Bun install through PATH.
    const child = Bun.spawn([process.execPath, "api-server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...apiEnv, API_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    await waitForHealth(baseUrl);

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const health = await healthResponse.json() as any;
    expect(healthResponse.status).toBe(200);
    expect(health.capabilities).not.toContain("project-memory.feedback");
    expect(health.disabledCapabilities).toContain("project-memory.feedback");

    const resolved = await post(baseUrl, "/api/project-memory/resolve-project", { project: "Demo Memory" });
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.ok).toBe(true);
    expect(resolved.body.canonicalPath).toBe(project);
    expect(resolved.body.memoryId).toBe(status.config!.memoryId);
    expect(resolved.body.autoBackup).toBe(false);

    const recalled = await post(baseUrl, "/api/project-memory/recall", {
      folderPath: project,
      query: "remote head stale parent",
      limit: 3,
    });
    expect(recalled.response.status).toBe(200);
    expect(recalled.body.hits[0]?.title).toBe("원격 최신본 확인");
    const entryKey = recalled.body.hits[0]?.entryKey;
    expect(entryKey).toBe(parseProjectMemoryEntries(readFileSync(sourcePath, "utf8"))[0]?.entryKey);
    expect(recalled.body.hits[0]?.entryId).toBe(entryKey);
    expect(recalled.body.hits[0]?.contentVersionHash).toMatch(/^[0-9a-f]{32}$/);

    const quality = await post(baseUrl, "/api/project-memory/quality", { folderPath: project });
    expect(quality.response.status).toBe(200);
    expect(quality.body.quality.entryCount).toBe(1);
    expect(quality.body.feedbackEvents).toBe(0);

    const disabledFeedback = await post(baseUrl, "/api/project-memory/feedback", {
      folderPath: project,
      entryKey,
      kind: "confirmed",
      eventId: "caller-controlled",
      evidence: "must not influence recall until evidence v2 ships",
    });
    expect(disabledFeedback.response.status).toBe(503);
    expect(disabledFeedback.body.code).toBe("PROJECT_MEMORY_FEEDBACK_DISABLED");

    const unpromoted = await post(baseUrl, "/api/project-memory/recall", {
      folderPath: project,
      query: "stale parent",
    });
    expect(unpromoted.body.hits[0]?.promotionState).toBe("candidate");
    expect(unpromoted.body.hits[0]?.feedback).toEqual({
      applied: 0,
      confirmed: 0,
      corrected: 0,
      contradicted: 0,
    });

    const fabricated = await post(baseUrl, "/api/project-memory/feedback", {
      folderPath: project,
      entryKey: "0123456789abcdef01234567",
      kind: "confirmed",
    });
    expect(fabricated.response.status).toBe(503);
    expect(fabricated.body.code).toBe("PROJECT_MEMORY_FEEDBACK_DISABLED");

    const denied = await post(baseUrl, "/api/project-memory/recall", {
      folderPath: project,
      query: "stale parent",
    }, { Origin: "https://evil.example" });
    expect(denied.response.status).toBe(403);
    expect(denied.body.code).toBe("LOCAL_API_ORIGIN_DENIED");
  }, 20_000);
});
