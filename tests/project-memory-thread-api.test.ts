import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeProjectMemory } from "../project-memory-server";
import { resolveAppDataDir } from "../src/appDataDir";

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("isolated API server did not become ready");
}

async function post(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

async function fixture(initialized = true) {
  // macOS의 /var 는 /private/var 심볼릭 링크다. 서버는 프로젝트 루트를 정규화해
  // 돌려주므로, 기대값도 같은 정규화를 거친 경로여야 플랫폼과 무관하게 성립한다.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agentstoz-thread-api-")));
  roots.push(home);
  const project = join(home, "projects", "demo");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  const memory = initialized
    ? initializeProjectMemory({ folderPath: project, projectName: "Demo Memory", autoBackup: false })
    : null;
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
  const port = 33_000 + Math.floor(Math.random() * 2_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "api-server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...apiEnv, API_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  await waitForHealth(baseUrl);
  return { home, project, memory, baseUrl, portsFile: join(appData, "ports.json") };
}

const route = { platform: "telegram", chatId: "8175665017", threadId: "6884" };

describe("project-memory thread HTTP API", () => {
  test("starts an initialized registered project and resolves it by exact topic", async () => {
    const { baseUrl, project, memory } = await fixture(true);
    const started = await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "Demo Memory" });
    expect(started.response.status).toBe(200);
    expect(started.body.ok).toBe(true);
    expect(started.body.binding).toMatchObject({
      ...route,
      projectId: "demo-id",
      projectName: "Demo Memory",
      memoryId: memory!.config!.memoryId,
      canonicalPath: project,
    });
    expect(started.body.initialized).toBe(false);

    const status = await post(baseUrl, "/api/project-memory/thread/status", route);
    expect(status.response.status).toBe(200);
    expect(status.body.ok).toBe(true);
    expect(status.body.binding.memoryId).toBe(memory!.config!.memoryId);
  }, 20_000);

  test("registers a fresh AWS clone idempotently before linking by memory id", async () => {
    const { baseUrl, project, memory, portsFile } = await fixture(true);
    await Bun.write(portsFile, "[]\n");

    const first = await post(baseUrl, "/api/project-memory/register-project", {
      folderPath: project,
      projectName: "AWS Demo",
    });
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      created: true,
      project: {
        name: "AWS Demo",
        folderPath: project,
        memoryId: memory!.config!.memoryId,
      },
    });

    const second = await post(baseUrl, "/api/project-memory/register-project", {
      folderPath: project,
      projectName: "AWS Demo renamed",
    });
    expect(second.response.status).toBe(200);
    expect(second.body).toMatchObject({
      ok: true,
      created: false,
      project: {
        id: first.body.project.id,
        name: "AWS Demo renamed",
        memoryId: memory!.config!.memoryId,
      },
    });
    const rows = JSON.parse(await Bun.file(portsFile).text());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.body.project.id, folderPath: project });

    const linked = await post(baseUrl, "/api/project-memory/thread/start", {
      ...route,
      project: memory!.config!.memoryId,
    });
    expect(linked.response.status).toBe(200);
    expect(linked.body.binding).toMatchObject({
      projectId: first.body.project.id,
      memoryId: memory!.config!.memoryId,
      canonicalPath: project,
    });
  }, 20_000);

  test("start explicitly initializes a registered project but never an unregistered path", async () => {
    const { baseUrl, project } = await fixture(false);
    const started = await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "demo-id" });
    expect(started.response.status).toBe(200);
    expect(started.body.initialized).toBe(true);
    expect(started.body.binding.canonicalPath).toBe(project);

    const denied = await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: join(project, "typo") });
    expect(denied.response.status).toBe(404);
    expect(denied.body.code).toBe("PROJECT_NOT_REGISTERED");
  }, 20_000);

  test("creates and registers a standalone topic memory before reporting missing Supabase config", async () => {
    const { baseUrl, portsFile } = await fixture(true);
    const createRoute = { ...route, threadId: "7683" };
    const created = await post(baseUrl, "/api/project-memory/thread/create", { ...createRoute, name: "gws cli" });
    expect(created.response.status).toBe(502);
    expect(created.body).toMatchObject({
      ok: false,
      created: true,
      localCreated: true,
      supabaseSaved: false,
    });
    expect(created.body.binding).toMatchObject({ ...createRoute, projectName: "gws cli" });
    const rows = JSON.parse(await Bun.file(portsFile).text());
    const registered = rows.find((row: any) => row.id === created.body.binding.projectId);
    expect(registered).toMatchObject({ name: "gws cli", category: "장기기억" });
    const status = await post(baseUrl, "/api/project-memory/thread/status", createRoute);
    expect(status.response.status).toBe(200);
    expect(status.body.binding.memoryId).toBe(created.body.binding.memoryId);
  }, 20_000);

  test("creates ~/projects on a fresh rootless AWS host before creating the project", async () => {
    const { baseUrl, home, portsFile } = await fixture(true);
    // fixture가 만든 기존 demo는 이 시나리오에 필요 없다. 특히 ~/projects가 처음부터
    // 존재하면 실제 새 AWS 계정에서 발생한 ENOENT 회귀를 잡지 못한다.
    rmSync(join(home, "projects"), { recursive: true, force: true });
    await Bun.write(portsFile, "[]\n");

    const created = await post(baseUrl, "/api/project-memory/thread/create-project", {
      ...route,
      threadId: "project-rootless",
      name: "매출 대시보드",
    });

    // disposable HOME에는 Supabase 설정이 없어 원격 백업만 실패한다. 로컬 프로젝트와
    // topic binding은 보존되어 /memory_sync로 재시도할 수 있어야 한다.
    expect(created.response.status).toBe(502);
    expect(created.body).toMatchObject({
      ok: false,
      created: true,
      localCreated: true,
      supabaseSaved: false,
      rootPath: join(home, "projects"),
      folderPath: join(home, "projects", "매출-대시보드"),
      rootWasDefaulted: true,
      git: { initialized: true },
    });
    expect(existsSync(join(home, "projects", "매출-대시보드", ".git"))).toBe(true);
    expect(existsSync(join(home, "projects", "매출-대시보드", ".agent-memory", "config.json"))).toBe(true);

    const rows = JSON.parse(await Bun.file(portsFile).text());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "매출-대시보드", folderPath: join(home, "projects", "매출-대시보드") });
  }, 20_000);

  test("asks Telegram to choose when the AWS host has multiple workspace roots", async () => {
    const { baseUrl, home, portsFile } = await fixture(true);
    const roots = [
      { id: "work", name: "업무", path: join(home, "work") },
      { id: "lab", name: "실험", path: join(home, "lab") },
    ];
    for (const root of roots) mkdirSync(root.path, { recursive: true });
    await Bun.write(join(dirname(portsFile), "workspace-roots.json"), JSON.stringify(roots));

    const result = await post(baseUrl, "/api/project-memory/thread/create-project", {
      ...route,
      threadId: "project-needs-root",
      name: "새 앱",
    });

    expect(result.response.status).toBe(409);
    expect(result.body).toEqual({
      ok: false,
      code: "PROJECT_START_ROOT_REQUIRED",
      needsRoot: true,
      roots,
      error: "작업 루트를 골라 주세요.",
    });
    expect(existsSync(join(home, "work", "새-앱"))).toBe(false);
    expect(existsSync(join(home, "lab", "새-앱"))).toBe(false);
  }, 20_000);

  test("root chat and another topic cannot inherit this topic binding", async () => {
    const { baseUrl } = await fixture(true);
    await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "demo-id" });

    const root = await post(baseUrl, "/api/project-memory/thread/status", { ...route, threadId: null });
    expect(root.response.status).toBe(404);
    expect(root.body.code).toBe("PROJECT_MEMORY_THREAD_NOT_BOUND");

    const other = await post(baseUrl, "/api/project-memory/thread/status", { ...route, threadId: "9999" });
    expect(other.response.status).toBe(404);
    expect(other.body.code).toBe("PROJECT_MEMORY_THREAD_NOT_BOUND");
  }, 20_000);

  test("does not silently replace an existing topic with another project", async () => {
    const { baseUrl, home, portsFile } = await fixture(true);
    const other = join(home, "projects", "other");
    mkdirSync(other, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: other });
    initializeProjectMemory({ folderPath: other, projectName: "Other", autoBackup: false });
    const rows = JSON.parse(await Bun.file(portsFile).text());
    rows.push({ id: "other-id", name: "Other", folderPath: other });
    await Bun.write(portsFile, JSON.stringify(rows));

    await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "demo-id" });
    const rebound = await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "other-id" });
    expect(rebound.response.status).toBe(409);
    expect(rebound.body.code).toBe("PROJECT_MEMORY_THREAD_BINDING_EXISTS");
    const status = await post(baseUrl, "/api/project-memory/thread/status", route);
    expect(status.body.binding.projectId).toBe("demo-id");
  }, 20_000);

  test("re-resolves projectId from current ports instead of trusting the cached path", async () => {
    const { baseUrl, project, home, portsFile } = await fixture(true);
    await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "demo-id" });
    const moved = join(home, "projects", "demo-moved");
    renameSync(project, moved);
    const rows = JSON.parse(await Bun.file(portsFile).text());
    rows[0].folderPath = moved;
    await Bun.write(portsFile, JSON.stringify(rows));

    const status = await post(baseUrl, "/api/project-memory/thread/status", route);
    expect(status.response.status).toBe(200);
    expect(status.body.binding.canonicalPath).toBe(moved);
  }, 20_000);

  test("stop is scoped and idempotent", async () => {
    const { baseUrl } = await fixture(true);
    await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "demo-id" });
    const stopped = await post(baseUrl, "/api/project-memory/thread/stop", route);
    expect(stopped.body).toEqual({ ok: true, removed: true });
    const stoppedAgain = await post(baseUrl, "/api/project-memory/thread/stop", route);
    expect(stoppedAgain.body).toEqual({ ok: true, removed: false });
  }, 20_000);

  test("manual sync is not suppressed by the automatic-backup preference", async () => {
    const { baseUrl } = await fixture(true);
    await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "demo-id" });
    const synced = await post(baseUrl, "/api/project-memory/thread/sync", route);
    // The disposable HOME deliberately has no portal.json. Reaching that
    // configuration error proves manual sync was attempted instead of being
    // suppressed by config.autoBackup=false.
    expect(synced.response.status).toBe(500);
    expect(String(synced.body.error)).toMatch(/Supabase|portal|설정/i);
  }, 20_000);

  test("status fails closed if the stored memory identity no longer matches the project", async () => {
    const { baseUrl, project } = await fixture(true);
    await post(baseUrl, "/api/project-memory/thread/start", { ...route, project: "demo-id" });
    const configPath = join(project, ".agent-memory", "config.json");
    const config = JSON.parse(await Bun.file(configPath).text());
    config.memoryId = "tampered-memory-id";
    await Bun.write(configPath, JSON.stringify(config));

    const status = await post(baseUrl, "/api/project-memory/thread/status", route);
    expect(status.response.status).toBe(409);
    expect(status.body.code).toBe("PROJECT_MEMORY_THREAD_IDENTITY_MISMATCH");
  }, 20_000);
});
