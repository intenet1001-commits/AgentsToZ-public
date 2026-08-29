import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agentstoz-service-api-")));
  roots.push(home);
  const project = join(home, "projects", "study-finance");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  const memory = initializeProjectMemory({
    folderPath: project,
    projectName: "Study Finance",
    autoBackup: false,
  });
  const apiEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  const appData = resolveAppDataDir(process.platform, apiEnv, home);
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(appData, "ports.json"), JSON.stringify([{
    id: "study-finance-id",
    name: "Study Finance",
    folderPath: project,
  }]));
  const { baseUrl, child } = await startTestApiServer({
    cwd: join(import.meta.dir, ".."),
    env: apiEnv,
  });
  children.push(child);
  return { appData, baseUrl, memory, project };
}

describe("USE service memory HTTP API", () => {
  test("is read-only on status and creates one stable local memory only on ensure", async () => {
    const { appData, baseUrl, memory, project } = await fixture();
    const serviceRoot = join(appData, "service-memories");

    const before = await post(baseUrl, "/api/service-memory/status", {
      portId: "study-finance-id",
      serviceKey: "default",
    });
    expect(before.response.status).toBe(200);
    expect(before.body.serviceMemory).toEqual({ exists: false, ready: false, record: null, problem: null });
    expect(existsSync(serviceRoot)).toBe(false);

    const bootstrapBefore = await post(baseUrl, "/api/buzz-agent-bootstrap/status", {
      scope: "service",
      portId: "study-finance-id",
      deviceName: "Test Mac",
    });
    expect(bootstrapBefore.response.status).toBe(200);
    expect(bootstrapBefore.body.serviceMemory).toBeNull();
    expect(bootstrapBefore.body.instructions).toBeNull();
    expect(existsSync(serviceRoot)).toBe(false);

    const created = await post(baseUrl, "/api/service-memory/ensure", {
      portId: "study-finance-id",
      serviceKey: "default",
      displayName: "study_finance",
    });
    expect(created.response.status).toBe(200);
    expect(created.body.created).toBe(true);
    expect(created.body.project).toMatchObject({
      projectId: "study-finance-id",
      canonicalPath: project,
      memoryId: memory.config!.memoryId,
    });
    expect(created.body.serviceMemory).toMatchObject({
      exists: true,
      ready: true,
      record: {
        role: "use",
        linkedProjectMemoryId: memory.config!.memoryId,
        linkedCanonicalPath: project,
      },
    });

    const serviceMemoryId = created.body.serviceMemory.record.serviceMemoryId as string;
    const sourcePath = created.body.serviceMemory.record.sourcePath as string;
    appendFileSync(sourcePath, "\nValidated use note.\n");

    const reused = await post(baseUrl, "/api/service-memory/ensure", {
      portId: "study-finance-id",
      serviceKey: "default",
      displayName: "study_finance",
    });
    expect(reused.response.status).toBe(200);
    expect(reused.body.created).toBe(false);
    expect(reused.body.serviceMemory.record.serviceMemoryId).toBe(serviceMemoryId);
    expect(readFileSync(sourcePath, "utf8")).toContain("Validated use note.");

    const bootstrapAfter = await post(baseUrl, "/api/buzz-agent-bootstrap/status", {
      scope: "service",
      portId: "study-finance-id",
      deviceName: "Test Mac",
    });
    expect(bootstrapAfter.response.status).toBe(200);
    expect(bootstrapAfter.body.serviceMemory.serviceMemoryId).toBe(serviceMemoryId);
    expect(bootstrapAfter.body.instructions).toContain("DEV_HANDOFF");
    expect(bootstrapAfter.body.instructions).toContain(sourcePath);
  }, 30_000);

  test("rejects unregistered projects and remote web origins without creating memory", async () => {
    const { appData, baseUrl } = await fixture();
    const missing = await post(baseUrl, "/api/service-memory/ensure", { portId: "missing-id" });
    expect(missing.response.status).toBe(404);
    expect(missing.body.code).toBe("PROJECT_NOT_REGISTERED");

    const denied = await post(baseUrl, "/api/service-memory/ensure", {
      portId: "study-finance-id",
    }, { Origin: "https://attacker.example" });
    expect(denied.response.status).toBe(403);
    expect(denied.body.code).toBe("LOCAL_API_ORIGIN_DENIED");
    expect(existsSync(join(appData, "service-memories"))).toBe(false);
  }, 30_000);
});
