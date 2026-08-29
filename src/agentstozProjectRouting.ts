import type { ProjectMemoryProjectResolution } from "./projectMemoryProjectResolver";

export type AgentsToZProjectRequest =
  | {
      ok: true;
      project: string;
      task: string;
      mentions: string[];
    }
  | {
      ok: false;
      code:
        | "ROUTER_MENTION_REQUIRED"
        | "PROJECT_SELECTOR_REQUIRED"
        | "PROJECT_SELECTOR_AMBIGUOUS"
        | "TASK_REQUIRED";
      error: string;
    };

type AgentsToZProjectRouteErrorCode =
  | "ROUTER_MENTION_REQUIRED"
  | "PROJECT_SELECTOR_REQUIRED"
  | "PROJECT_SELECTOR_AMBIGUOUS"
  | "TASK_REQUIRED"
  | "PROJECT_QUERY_REQUIRED"
  | "PROJECT_NOT_REGISTERED"
  | "PROJECT_AMBIGUOUS"
  | "PROJECT_MEMORY_NOT_INITIALIZED";

export type AgentsToZProjectRoute =
  | {
      ok: true;
      requestId: string;
      project: string;
      task: string;
      resolution: Extract<ProjectMemoryProjectResolution, { ok: true }>;
    }
  | {
      ok: false;
      code: AgentsToZProjectRouteErrorCode;
      error: string;
      candidates?: Array<{ id: string; name: string; path: string }>;
    };

const ROUTER_ALIASES = new Set(["agentstoz", "agentstoz-bot"]);
const WORKER_ALIASES = new Set(["cs-ceo", "cs_ceo"]);

function maskCodeSpans(input: string): string {
  return input.replace(/`[^`]*`/g, value => value.replace(/[^\n]/g, " "));
}

/**
 * Parses only the transport-level routing syntax. It does not resolve a
 * project name; that must be done later against the registered allowlist.
 */
export function parseAgentsToZProjectRequest(input: unknown): AgentsToZProjectRequest {
  if (typeof input !== "string") {
    return { ok: false, code: "ROUTER_MENTION_REQUIRED", error: "@agentstoz 멘션이 필요합니다." };
  }

  const visible = maskCodeSpans(input);
  const mentionMatches = [...visible.matchAll(/@([A-Za-z0-9_-]+)/g)]
    .map(match => match[1]!.toLocaleLowerCase());
  const mentions = [...new Set(mentionMatches.flatMap(name => {
    if (ROUTER_ALIASES.has(name)) return ["agentstoz"];
    if (WORKER_ALIASES.has(name)) return ["cs-ceo"];
    return [];
  }))];
  if (!mentions.includes("agentstoz")) {
    return { ok: false, code: "ROUTER_MENTION_REQUIRED", error: "@agentstoz 멘션이 필요합니다." };
  }

  const selectors = [...visible.matchAll(/#([^\s#`]+)/g)];
  if (selectors.length === 0) {
    return { ok: false, code: "PROJECT_SELECTOR_REQUIRED", error: "정확한 #프로젝트이름이 필요합니다." };
  }
  if (selectors.length > 1) {
    return { ok: false, code: "PROJECT_SELECTOR_AMBIGUOUS", error: "한 요청에는 하나의 #프로젝트이름만 지정해야 합니다." };
  }

  const project = selectors[0]![1]!.trim();
  if (!project) {
    return { ok: false, code: "PROJECT_SELECTOR_REQUIRED", error: "비어 있지 않은 #프로젝트이름이 필요합니다." };
  }

  const task = visible
    // 앱의 「#프로젝트명 + 해시 복사」 둘째 줄은 이 단말의 보조 식별값이다.
    // worker 작업으로 전달하지 않으며, 이 줄만 남으면 TASK_REQUIRED로 안전하게 멈춘다.
    .replace(/^\s*로컬프로젝트해시\s*:\s*[A-Za-z0-9_-]{1,64}\s*$/gim, " ")
    .replace(/@[A-Za-z0-9_-]+/g, " ")
    .replace(/#[^\s#`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!task) {
    return { ok: false, code: "TASK_REQUIRED", error: "프로젝트 작업 내용이 필요합니다." };
  }

  return { ok: true, project, task, mentions };
}

export function routeAgentsToZProjectRequest(
  input: unknown,
  resolveProject: (project: string) => ProjectMemoryProjectResolution,
  requestIdFactory: () => string = () => crypto.randomUUID(),
): AgentsToZProjectRoute {
  const parsed = parseAgentsToZProjectRequest(input);
  if (!parsed.ok) return parsed;
  const resolution = resolveProject(parsed.project);
  if (!resolution.ok) return resolution;
  return {
    ok: true,
    requestId: requestIdFactory(),
    project: parsed.project,
    task: parsed.task,
    resolution,
  };
}

export function routeAgentsToZExactProjectRequest(
  projectInput: unknown,
  taskInput: unknown,
  resolveProject: (project: string) => ProjectMemoryProjectResolution,
  requestIdFactory: () => string = () => crypto.randomUUID(),
): AgentsToZProjectRoute {
  const project = typeof projectInput === "string" ? projectInput.trim() : "";
  if (!project) return { ok: false, code: "PROJECT_QUERY_REQUIRED", error: "정확한 프로젝트명이 필요합니다." };
  const task = typeof taskInput === "string" ? taskInput.trim() : "";
  if (!task) return { ok: false, code: "TASK_REQUIRED", error: "프로젝트 작업 내용이 필요합니다." };
  const resolution = resolveProject(project);
  if (!resolution.ok) return resolution;
  return { ok: true, requestId: requestIdFactory(), project, task, resolution };
}
