import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");

describe("AgentsToZ project route API contract", () => {
  test("exposes a read-only route endpoint that builds the worker plan from the resolved project", () => {
    expect(api).toContain('url.pathname === "/api/agentstoz/project-route"');
    expect(api).toContain("routeAgentsToZProjectRequest");
    expect(api).toContain("planAgentsToZProjectWorker");
    expect(api).toContain("canonicalPath");
    expect(api).toContain("memoryId");
  });

  test("route endpoint delegates the same validated request to the real worker dispatcher", () => {
    expect(api).toContain("/api/project-memory/dispatch-worker");
    expect(api).toContain("dispatchResponse");
    expect(api).toContain("requestId: routed.requestId");
    expect(api).not.toContain('dispatch: "planned"');
  });

  test("resolve endpoint validates project name and memory ID as one exact identity pair", () => {
    expect(api).toContain("memoryId?: unknown");
    expect(api).toContain("MEMORY_ID_MISMATCH");
    expect(api).toContain("프로젝트명과 memory ID가 동일한 등록 프로젝트를 가리키지 않습니다.");
  });
  test("Telegram group and private messages share the project-trigger dispatcher and reply target", () => {
    expect(api).toContain('url.pathname === "/api/project-memory/telegram-trigger"');
    expect(api).toContain('trigger: "telegram-project-selector"');
    expect(api).toContain('chatType === "group"');
    expect(api).toContain('chatType === "private"');
    expect(api).toContain('platform: "telegram"');
    expect(api).toContain("threadId: typeof body.threadId === \"string\" ? body.threadId : null");
  });

  test("worker exit lifecycle records local memory and attempts configured remote backup", () => {
    const marker = "void worker.exited.then";
    const start = api.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const lifecycle = api.slice(start, start + 2400);
    expect(lifecycle).toContain("markProjectMemoryRemembered");
    expect(lifecycle).toContain("pushProjectMemory");
    expect(lifecycle).toContain("backupError");
  });
});
