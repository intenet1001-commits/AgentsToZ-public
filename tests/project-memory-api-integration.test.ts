import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectMemory } from "../project-memory-server";
import { resolveAppDataDir } from "../src/appDataDir";
import { parseProjectMemoryEntries } from "../src/projectMemoryRecall";
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
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_PORTAL_INTEGRATION_ORIGINS: [
        'https://env-portal-integration-test.vercel.app/',
        'null',
        'https://user:secret@credential-origin.example',
        'https://path-origin.example/not-an-origin',
        'https://query-origin.example/?token=value',
      ].join(','),
    };
    const appData = resolveAppDataDir(process.platform, apiEnv, home);
    mkdirSync(appData, { recursive: true });
    const portalOrigin = "https://portal-integration-test.vercel.app";
    writeFileSync(join(appData, "portal.json"), JSON.stringify({ portalDeployUrl: portalOrigin }));
    writeFileSync(join(appData, "ports.json"), JSON.stringify([{
      id: "demo-id",
      name: "Demo Memory",
      folderPath: project,
    }]));

    // Use the executable running the suite. GUI/systemd/non-login shells do not
    // necessarily expose the user's Bun install through PATH.
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, ".."),
      env: apiEnv,
    });
    children.push(child);

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

    const portalResolved = await post(baseUrl, "/api/project-memory/resolve-project", {
      project: status.config!.memoryId,
    }, { Origin: portalOrigin });
    expect(portalResolved.response.status).toBe(200);
    expect(portalResolved.body.canonicalPath).toBe(project);
    expect(portalResolved.response.headers.get("access-control-allow-origin")).toBe(portalOrigin);

    const envPortalOrigin = 'https://env-portal-integration-test.vercel.app';
    const envPortalResolved = await post(baseUrl, "/api/project-memory/resolve-project", {
      project: status.config!.memoryId,
    }, { Origin: envPortalOrigin });
    expect(envPortalResolved.response.status).toBe(200);
    expect(envPortalResolved.response.headers.get('access-control-allow-origin')).toBe(envPortalOrigin);

    const preflight = await fetch(`${baseUrl}/api/project-memory/resolve-project`, {
      method: "OPTIONS",
      headers: {
        Origin: portalOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');

    const wrongMethodPreflight = await fetch(`${baseUrl}/api/project-memory/resolve-project`, {
      method: 'OPTIONS',
      headers: {
        Origin: portalOrigin,
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(wrongMethodPreflight.status).toBe(403);
    expect(wrongMethodPreflight.headers.get('access-control-allow-origin')).toBeNull();

    for (const invalidOrigin of [
      'null',
      'https://user:secret@credential-origin.example',
      'https://path-origin.example/not-an-origin',
      'https://query-origin.example/?token=value',
    ]) {
      const invalid = await post(baseUrl, "/api/project-memory/resolve-project", {
        project: status.config!.memoryId,
      }, { Origin: invalidOrigin });
      expect(invalid.response.status, invalidOrigin).toBe(403);
      expect(invalid.body.code, invalidOrigin).toBe('LOCAL_API_ORIGIN_DENIED');
    }

    // AI 별칭은 파일·셸 도구가 없는 전용 Claude 호출이며, 공식 포털의
    // 실제 버튼이 정적 fallback으로만 끝나지 않도록 PNA preflight를 허용한다.
    const aliasPreflight = await fetch(`${baseUrl}/api/project-memory/suggest-display-name`, {
      method: "OPTIONS",
      headers: {
        Origin: portalOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(aliasPreflight.status).toBe(200);
    expect(aliasPreflight.headers.get("access-control-allow-origin")).toBe(portalOrigin);
    expect(aliasPreflight.headers.get("access-control-allow-private-network")).toBe("true");

    const refreshPreflight = await fetch(`${baseUrl}/api/project-memory/refresh-resolved-status`, {
      method: "OPTIONS",
      headers: {
        Origin: portalOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(refreshPreflight.status).toBe(200);
    expect(refreshPreflight.headers.get("access-control-allow-private-network")).toBe("true");

    // 공식 포털이어도 recall/프로세스 API로 권한이 넓어지지 않는다.
    const portalRecall = await post(baseUrl, "/api/project-memory/recall", {
      folderPath: project,
      query: "stale parent",
    }, { Origin: portalOrigin });
    expect(portalRecall.response.status).toBe(403);
    expect(portalRecall.body.code).toBe("LOCAL_API_ORIGIN_DENIED");

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
