import { describe, expect, test } from "bun:test";
import { parseAgentsToZProjectRequest, routeAgentsToZProjectRequest, routeAgentsToZExactProjectRequest } from "../src/agentstozProjectRouting";
import type { ProjectMemoryProjectResolution } from "../src/projectMemoryProjectResolver";
import { projectIdentityClipboard } from "../src/projectCode";

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

  test('new one-line clipboard identity preserves the appended real task', () => {
    const identity = projectIdentityClipboard('demo', '1773136552857');
    for (const separator of [' ', '\n', '\r\n']) {
      expect(parseAgentsToZProjectRequest(`@agentstoz @cs-ceo ${identity}${separator}상태를 확인해줘`))
        .toEqual({ ok: true, project: 'demo', task: '상태를 확인해줘', mentions: ['agentstoz', 'cs-ceo'] });
    }
    expect(parseAgentsToZProjectRequest(`@agentstoz ${identity}`))
      .toMatchObject({ ok: false, code: 'TASK_REQUIRED' });
  });

  test('legacy identity still accepts a real task directly after its second-line hash', () => {
    expect(parseAgentsToZProjectRequest('@agentstoz #demo\n로컬프로젝트해시: 3F9A1C2E 상태를 확인해줘'))
      .toMatchObject({ ok: true, project: 'demo', task: '상태를 확인해줘' });
    expect(parseAgentsToZProjectRequest('@agentstoz\n#demo [로컬프로젝트해시: 3F9A1C2E]'))
      .toMatchObject({ ok: false, code: 'TASK_REQUIRED' });
  });

  test('hash-looking quoted or prose content is retained instead of becoming routing metadata', () => {
    for (const task of [
      '"로컬프로젝트해시: 3F9A1C2E" 문구를 설명해줘',
      "'로컬프로젝트해시: 3F9A1C2E' 문구를 설명해줘",
      '"[로컬프로젝트해시: 3F9A1C2E]" 문구를 설명해줘',
      '로컬프로젝트해시: show status 라는 문구를 설명해줘',
      '문구 로컬프로젝트해시: 3F9A1C2E 를 설명해줘',
      '> 로컬프로젝트해시: 3F9A1C2E',
    ]) {
      expect(parseAgentsToZProjectRequest(`@agentstoz #demo ${task}`))
        .toMatchObject({ ok: true, project: 'demo', task });
    }
    expect(parseAgentsToZProjectRequest('@agentstoz "#demo [로컬프로젝트해시: 3F9A1C2E]" 문구를 설명해줘'))
      .toMatchObject({ ok: true, project: 'demo', task: '" [로컬프로젝트해시: 3F9A1C2E]" 문구를 설명해줘' });
  });

  test('does not strip a malformed hash token or a hash that is part of another word', () => {
    for (const suffix of ['3F9A1C2E조회', '3F9A1C2E.', 'x'.repeat(65), '']) {
      const task = `[로컬프로젝트해시: ${suffix}] 문구를 확인해줘`.replace(/\s+/g, ' ');
      expect(parseAgentsToZProjectRequest(`@agentstoz #demo ${task}`))
        .toMatchObject({ ok: true, project: 'demo', task });
    }
  });

  test('retains the existing code-span boundary and multiple-selector rejection', () => {
    expect(parseAgentsToZProjectRequest('@agentstoz `#demo 로컬프로젝트해시: 3F9A1C2E` 작업해줘'))
      .toMatchObject({ ok: false, code: 'PROJECT_SELECTOR_REQUIRED' });
    expect(parseAgentsToZProjectRequest('@agentstoz #demo `로컬프로젝트해시: 3F9A1C2E` 작업해줘'))
      .toMatchObject({ ok: true, project: 'demo', task: '작업해줘' });
    expect(parseAgentsToZProjectRequest('@agentstoz #demo [로컬프로젝트해시: 3F9A1C2E] #other 작업해줘'))
      .toMatchObject({ ok: false, code: 'PROJECT_SELECTOR_AMBIGUOUS' });
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
