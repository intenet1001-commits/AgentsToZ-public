import { describe, expect, test } from "bun:test";
import { parseAgentsToZProjectRequest, routeAgentsToZProjectRequest, routeAgentsToZExactProjectRequest } from "../src/agentstozProjectRouting";
import type { ProjectMemoryProjectResolution } from "../src/projectMemoryProjectResolver";

describe("AgentsToZ project routing request", () => {
  test("parses the canonical two-bot mention and exact project token", () => {
    expect(parseAgentsToZProjectRequest(
      "@agentstoz @cs-ceo #csncompany2-0 로그인 버그를 조사하고 테스트해줘",
    )).toEqual({
      ok: true,
      project: "csncompany2-0",
      task: "로그인 버그를 조사하고 테스트해줘",
      mentions: ["agentstoz", "cs-ceo"],
    });
  });

  test("accepts router-only requests without inventing a worker mention", () => {
    expect(parseAgentsToZProjectRequest("@agentstoz #demo 상태를 확인해줘")).toEqual({
      ok: true,
      project: "demo",
      task: "상태를 확인해줘",
      mentions: ["agentstoz"],
    });
  });

  test("resolves a copied #project name without requiring the optional local hash", () => {
    const resolution: ProjectMemoryProjectResolution = {
      ok: true,
      id: "project-id",
      name: "demo",
      requestedPath: "/projects/demo",
      canonicalPath: "/projects/demo",
      matchedBy: "name",
    };
    expect(routeAgentsToZProjectRequest(
      "@agentstoz #demo 상태를 확인해줘",
      project => project === "demo" ? resolution : { ok: false, code: "PROJECT_NOT_REGISTERED", error: "x", candidates: [] },
      () => "req-name-only",
    )).toEqual({ ok: true, requestId: "req-name-only", project: "demo", task: "상태를 확인해줘", resolution });
  });

  test("strips the copied local hash from the worker task and rejects identity-only text", () => {
    expect(parseAgentsToZProjectRequest(
      "@agentstoz #demo\n로컬프로젝트해시: 3F9A1C2E\n상태를 확인해줘",
    )).toMatchObject({ ok: true, project: "demo", task: "상태를 확인해줘" });
    expect(parseAgentsToZProjectRequest(
      "@agentstoz #demo\n로컬프로젝트해시: 3F9A1C2E",
    )).toMatchObject({ ok: false, code: "TASK_REQUIRED" });
  });

  test("fails closed when the router mention or project selector is missing", () => {
    expect(parseAgentsToZProjectRequest("@csncompany #demo 작업해줘")).toMatchObject({
      ok: false,
      code: "ROUTER_MENTION_REQUIRED",
    });
    expect(parseAgentsToZProjectRequest("@agentstoz 작업해줘")).toMatchObject({
      ok: false,
      code: "PROJECT_SELECTOR_REQUIRED",
    });
  });

  test("rejects fuzzy, duplicate, malformed, and empty project selectors", () => {
    for (const text of [
      "@agentstoz #demo #other 작업해줘",
      "@agentstoz # 작업해줘",
      "@agentstoz #demo",
    ]) {
      expect(parseAgentsToZProjectRequest(text).ok).toBe(false);
    }
  });

  test("normalizes the documented bot-name aliases", () => {
    expect(parseAgentsToZProjectRequest(
      "@agentstoz-bot @cs-ceo #demo 작업해줘",
    )).toMatchObject({
      ok: true,
      project: "demo",
      task: "작업해줘",
      mentions: ["agentstoz", "cs-ceo"],
    });
  });

  test("does not treat a project-looking token inside a code span as the selector", () => {
    expect(parseAgentsToZProjectRequest("@agentstoz `#demo` 작업해줘")).toMatchObject({
      ok: false,
      code: "PROJECT_SELECTOR_REQUIRED",
    });
  });

  test("routes an exact copied project name without requiring # autocomplete", () => {
    const resolution: ProjectMemoryProjectResolution = {
      ok: true,
      id: "project-id",
      name: "agentstoz-e2e-project",
      requestedPath: "/projects/agentstoz-e2e-project",
      canonicalPath: "/projects/agentstoz-e2e-project",
      matchedBy: "name",
    };
    expect(routeAgentsToZExactProjectRequest(
      "agentstoz-e2e-project",
      "상태 확인해줘",
      () => resolution,
      () => "req-exact",
    )).toEqual({ ok: true, requestId: "req-exact", project: "agentstoz-e2e-project", task: "상태 확인해줘", resolution });
  });

  test("exact copied project route fails closed for missing values", () => {
    expect(routeAgentsToZExactProjectRequest("", "작업", () => ({ ok: false, code: "PROJECT_NOT_REGISTERED", error: "x", candidates: [] })))
      .toMatchObject({ ok: false, code: "PROJECT_QUERY_REQUIRED" });
    expect(routeAgentsToZExactProjectRequest("agentstoz-e2e-project", "", () => ({ ok: false, code: "PROJECT_NOT_REGISTERED", error: "x", candidates: [] })))
      .toMatchObject({ ok: false, code: "TASK_REQUIRED" });
  });

  test("routes only after exact resolution and carries one request ID", () => {
    const resolution: ProjectMemoryProjectResolution = {
      ok: true,
      id: "project-id",
      name: "demo",
      requestedPath: "/projects/demo",
      canonicalPath: "/projects/demo",
      matchedBy: "id",
    };
    expect(routeAgentsToZProjectRequest(
      "@agentstoz @csncompany #demo 작업해줘",
      () => resolution,
      () => "req-123",
    )).toEqual({
      ok: true,
      requestId: "req-123",
      project: "demo",
      task: "작업해줘",
      resolution,
    });
  });

  test("fails closed without dispatch when exact resolution fails", () => {
    const resolution: ProjectMemoryProjectResolution = {
      ok: false,
      code: "PROJECT_NOT_REGISTERED",
      error: "not found",
      candidates: [],
    };
    expect(routeAgentsToZProjectRequest(
      "@agentstoz #typo 작업해줘",
      () => resolution,
      () => "must-not-be-used",
    )).toMatchObject({
      ok: false,
      code: "PROJECT_NOT_REGISTERED",
    });
  });
});
