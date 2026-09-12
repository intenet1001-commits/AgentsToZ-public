#!/usr/bin/env bun

import { AGENTSTOZ_USE_CONTROL_ENDPOINT } from "./src/agentstozUseControl";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const SERVER_NAME = "agentstoz-use";
const SERVER_VERSION = "1.11.0";
const PROTOCOL_VERSION = "2025-06-18";

export const AGENTSTOZ_USE_MCP_INSTRUCTIONS = [
  "This server is the conversational control surface for AgentsToZ.",
  "When a user explicitly addresses ‘AgentsToZ’, ‘에이전츠투지’, or ‘아젠투지’ in text or Voice, immediately treat the remaining words as an AgentsToZ request and use these tools.",
  "Do not ask what kind of project they mean when they say ‘<name> 프로젝트 만들어’. First call agentstoz_use_list_workspace_roots; if several roots are returned, ask which returned root to use, then call agentstoz_use_create_project.",
  "Use only IDs returned by these tools. Never guess a local path, project ID, workspace-root ID, session ID, or mission ID.",
  "A new local project includes its folder, Git initial commit, AgentsToZ registration, and DEV long-term memory. GitHub is a separate optional action and visibility must be explicit.",
  "When the user asks for a control center, 관제센터, or orchestration folder, call agentstoz_use_create_control_center. It creates the portable control documents plus Git and long-term memory. Create a GitHub repository only after the user explicitly chooses private or public visibility.",
  "For Workroom requests, the supported agents are Codex, Claude, Hermes, and agy. Read a newly started session before sending its first instruction.",
  "Report completion only from a successful tool result.",
].join(" ");

export const AGENTSTOZ_USE_MCP_SERVER_NAME = "agentstoz_use";

export const AGENTSTOZ_USE_MCP_TOOLS: ToolDefinition[] = [
  {
    name: "agentstoz_use_list_projects",
    description: "List this device's registered AgentsToZ projects without exposing local folder paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentstoz_use_list_workspace_roots",
    description: "Start an AgentsToZ/에이전츠투지/아젠투지 project-creation request by listing registered workspace-root IDs and display names without exposing local paths. Always call this first when the user says to create a named project; do not ask what category of project they mean.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentstoz_use_create_project",
    description: "Create and register a new local AgentsToZ project using the app's safe defaults: folder, Git repository, initial commit, and DEV long-term memory. Only a workspace-root ID returned by agentstoz_use_list_workspace_roots is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string", minLength: 1, maxLength: 120 },
        workspaceRootId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["projectName", "workspaceRootId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_create_control_center",
    description: "Create and register a portable AgentsToZ control-center project for cross-project orchestration. It includes control documents, Git history, and DEV long-term memory. On another Mac, clone its GitHub repository through AgentsToZ so the same memoryId is pulled before any backup.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string", minLength: 1, maxLength: 120, default: "AgentsToZ-Control" },
        workspaceRootId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["workspaceRootId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_connect_buzz_channel",
    description: "Connect the current manually-created Buzz channel to a registered project. The channel UUID and name must come from the Buzz context; the server independently verifies them when local CLI authentication is available and initializes DEV memory only when missing.",
    inputSchema: {
      type: "object",
      properties: {
        portId: { type: "string", minLength: 1, maxLength: 200 },
        channelId: { type: "string", format: "uuid" },
        channelName: { type: "string", minLength: 1, maxLength: 64 },
      },
      required: ["portId", "channelId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_create_github_repository",
    description: "Create a private or public GitHub repository for a registered project, set origin, and push committed history. The user must explicitly choose visibility. For Private only, archiveMemory may be true only after the user separately asks to store verified long-term memory in the disaster-recovery branch. Local paths and repository names are resolved server-side.",
    inputSchema: {
      type: "object",
      properties: {
        portId: { type: "string", minLength: 1, maxLength: 200 },
        visibility: { type: "string", enum: ["private", "public"] },
        archiveMemory: { type: "boolean" },
      },
      required: ["portId", "visibility"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_project_status",
    description: "Read GitHub, long-term-memory, and Buzz DEV-channel status for a registered project ID returned by agentstoz_use_list_projects.",
    inputSchema: {
      type: "object",
      properties: { portId: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["portId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_list_workroom_sessions",
    description: "List this device's current Workroom terminal sessions for one registered project, including its registered worktrees, without exposing local paths or terminal output.",
    inputSchema: {
      type: "object",
      properties: { portId: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["portId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_read_workroom_session",
    description: "Read bounded recent output and status from a Workroom session previously listed for the same registered project.",
    inputSchema: {
      type: "object",
      properties: {
        portId: { type: "string", minLength: 1, maxLength: 200 },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        after: { type: "integer", minimum: 0 },
      },
      required: ["portId", "sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_start_workroom_session",
    description: "Start a new Codex, Claude, Hermes, or agy Workroom session in the registered project's main workspace. Read its output before sending an instruction because a local setup, trust, profile, or login screen may appear.",
    inputSchema: {
      type: "object",
      properties: {
        portId: { type: "string", minLength: 1, maxLength: 200 },
        agent: { type: "string", enum: ["codex", "claude", "hermes", "agy"] },
        requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,160}$" },
        missionId: { type: "string", minLength: 8, maxLength: 200 },
      },
      required: ["portId", "agent", "requestId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_send_workroom_instruction",
    description: "Send one natural-language instruction exactly once to a Codex, Claude, Hermes, or agy Workroom session previously listed for the same registered project.",
    inputSchema: {
      type: "object",
      properties: {
        portId: { type: "string", minLength: 1, maxLength: 200 },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        instruction: { type: "string", minLength: 1 },
        requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,160}$" },
        missionId: { type: "string", minLength: 8, maxLength: 200 },
      },
      required: ["portId", "sessionId", "instruction", "requestId"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_list_missions",
    description: "List recent durable orchestration missions. Ordinary conversation and simple project browsing do not create missions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentstoz_use_create_mission",
    description: "Create a durable mission for explicit or multi-project/multi-agent orchestration.",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 240 }, goal: { type: "string", minLength: 1 }, requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,160}$" } }, required: ["title", "goal", "requestId"], additionalProperties: false },
  },
  {
    name: "agentstoz_use_read_mission",
    description: "Read one mission and its bounded orchestration event history without project paths, prompts, or terminal output.",
    inputSchema: { type: "object", properties: {
      missionId: { type: "string", minLength: 8, maxLength: 200 },
      afterEventId: { type: "string", pattern: "^event_[0-9a-f-]{36}$" },
      eventLimit: { type: "integer", minimum: 1, maximum: 100 },
    }, required: ["missionId"], additionalProperties: false },
  },
  {
    name: "agentstoz_use_transition_mission",
    description: "Explicitly resume, pause, or complete a mission. A restart never resumes a mission automatically.",
    inputSchema: { type: "object", properties: { missionId: { type: "string", minLength: 8, maxLength: 200 }, transition: { type: "string", enum: ["resume", "pause", "complete"] }, requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,160}$" } }, required: ["missionId", "transition", "requestId"], additionalProperties: false },
  },
  {
    name: "agentstoz_use_link_mission_utterance",
    description: "Link one existing active What I Said utterance to a mission by reference only. The bridge verifies its registered project owner and never copies transcript text into the mission.",
    inputSchema: { type: "object", properties: {
      missionId: { type: "string", minLength: 8, maxLength: 200 },
      portId: { type: "string", minLength: 1, maxLength: 200 },
      whatISaidEventId: { type: "string", pattern: "^wis_[0-9a-f]{64}$" },
      relatedPortIds: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
      requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,160}$" },
    }, required: ["missionId", "portId", "whatISaidEventId", "requestId"], additionalProperties: false },
  },
  {
    name: "agentstoz_use_record_mission_project_result",
    description: "Record a bounded verified orchestration result and create project-memory candidates only for mentioned projects with an actual change, decision, or verified result.",
    inputSchema: { type: "object", properties: {
      missionId: { type: "string", minLength: 8, maxLength: 200 }, requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,160}$" },
      mentionedPortIds: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
      changedPortIds: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
      decisionPortIds: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
      verifiedResultPortIds: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
      resultSummary: { type: "string", minLength: 1, maxLength: 2000 },
    }, required: ["missionId", "requestId", "mentionedPortIds", "changedPortIds", "decisionPortIds", "verifiedResultPortIds", "resultSummary"], additionalProperties: false },
  },
  {
    name: "agentstoz_use_open_dashboard",
    description: "Bring the installed AgentsToZ desktop app to the foreground on this device.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentstoz_use_open_code_app",
    description: "Open a registered project in Codex, Claude, or Hermes. The local bridge resolves the folder from the registered project ID.",
    inputSchema: {
      type: "object",
      properties: {
        portId: { type: "string", minLength: 1, maxLength: 200 },
        agent: { type: "string", enum: ["codex", "claude", "hermes"] },
      },
      required: ["portId", "agent"],
      additionalProperties: false,
    },
  },
  {
    name: "agentstoz_use_open_buzz_dev",
    description: "Bring Buzz forward and return the connected DEV channel identity for a registered project ID.",
    inputSchema: {
      type: "object",
      properties: { portId: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["portId"],
      additionalProperties: false,
    },
  },
];

function oneLine(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function requiredId(value: unknown, field: string): string {
  const normalized = oneLine(value);
  if (!normalized || normalized.length > 200) throw new Error(`${field} must be a registered project ID.`);
  return normalized;
}

function requiredInstruction(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("instruction must be non-empty natural language.");
  return value;
}

export function resolveAgentsToZUseMcpEndpoint(env: Record<string, string | undefined> = process.env): string {
  const candidate = env.AGENTSTOZ_USE_ENDPOINT?.trim() || AGENTSTOZ_USE_CONTROL_ENDPOINT;
  const url = new URL(candidate);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "http:" || !loopback || url.pathname !== "/api/agentstoz-use/action"
    || url.username || url.password || url.search || url.hash) {
    throw new Error("AGENTSTOZ_USE_ENDPOINT must be the credential-free loopback control endpoint.");
  }
  return url.toString();
}

export function agentsToZUseMcpActionForTool(
  toolName: unknown,
  rawArguments: unknown,
  controllerPortId: unknown,
): Record<string, unknown> {
  const controller = requiredId(controllerPortId, "AGENTSTOZ_CONTROLLER_PORT_ID");
  const args = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {};
  if (toolName === "agentstoz_use_list_projects") {
    return { action: "list-projects", controllerPortId: controller };
  }
  if (toolName === "agentstoz_use_list_workspace_roots") {
    return { action: "list-workspace-roots", controllerPortId: controller };
  }
  if (toolName === "agentstoz_use_create_project") {
    return {
      action: "create-project",
      controllerPortId: controller,
      projectName: requiredId(args.projectName, "projectName"),
      workspaceRootId: requiredId(args.workspaceRootId, "workspaceRootId"),
    };
  }
  if (toolName === "agentstoz_use_create_control_center") {
    return {
      action: "create-control-center",
      controllerPortId: controller,
      projectName: oneLine(args.projectName) || "AgentsToZ-Control",
      workspaceRootId: requiredId(args.workspaceRootId, "workspaceRootId"),
    };
  }
  if (toolName === "agentstoz_use_create_github_repository") {
    const visibility = oneLine(args.visibility);
    if (visibility !== "private" && visibility !== "public") {
      throw new Error("visibility must be private or public.");
    }
    if (args.archiveMemory !== undefined && typeof args.archiveMemory !== "boolean") {
      throw new Error("archiveMemory must be an explicit boolean when provided.");
    }
    const archiveMemory = args.archiveMemory === true;
    if (archiveMemory && visibility !== "private") {
      throw new Error("archiveMemory is available only for private repositories.");
    }
    return {
      action: "create-github-repository",
      controllerPortId: controller,
      portId: requiredId(args.portId, "portId"),
      visibility,
      ...(archiveMemory ? { archiveMemory: true } : {}),
    };
  }
  if (toolName === "agentstoz_use_connect_buzz_channel") {
    return {
      action: "connect-buzz-channel",
      controllerPortId: controller,
      portId: requiredId(args.portId, "portId"),
      channelId: requiredId(args.channelId, "channelId"),
      ...(oneLine(args.channelName) ? { channelName: oneLine(args.channelName).slice(0, 64) } : {}),
    };
  }
  if (toolName === "agentstoz_use_project_status") {
    return { action: "project-status", controllerPortId: controller, portId: requiredId(args.portId, "portId") };
  }
  if (toolName === "agentstoz_use_list_workroom_sessions") {
    return { action: "list-workroom-sessions", controllerPortId: controller, portId: requiredId(args.portId, "portId") };
  }
  if (toolName === "agentstoz_use_read_workroom_session") {
    const after = args.after === undefined ? 0 : args.after;
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) throw new Error("after must be a non-negative safe integer.");
    return {
      action: "read-workroom-session",
      controllerPortId: controller,
      portId: requiredId(args.portId, "portId"),
      sessionId: requiredId(args.sessionId, "sessionId"),
      ...(after ? { after } : {}),
    };
  }
  if (toolName === "agentstoz_use_start_workroom_session") {
    const agent = oneLine(args.agent);
    if (agent !== "codex" && agent !== "claude" && agent !== "hermes" && agent !== "agy") throw new Error("agent must be codex, claude, hermes, or agy.");
    return {
      action: "start-workroom-session", controllerPortId: controller,
      portId: requiredId(args.portId, "portId"), agent,
      requestId: requiredId(args.requestId, "requestId"),
      ...(oneLine(args.missionId) ? { missionId: requiredId(args.missionId, "missionId") } : {}),
    };
  }
  if (toolName === "agentstoz_use_send_workroom_instruction") {
    return {
      action: "send-workroom-instruction", controllerPortId: controller,
      portId: requiredId(args.portId, "portId"), sessionId: requiredId(args.sessionId, "sessionId"),
      instruction: requiredInstruction(args.instruction), requestId: requiredId(args.requestId, "requestId"),
      ...(oneLine(args.missionId) ? { missionId: requiredId(args.missionId, "missionId") } : {}),
    };
  }
  if (toolName === "agentstoz_use_list_missions") return { action: "list-missions", controllerPortId: controller };
  if (toolName === "agentstoz_use_create_mission") return { action: "create-mission", controllerPortId: controller, title: requiredInstruction(args.title), goal: requiredInstruction(args.goal), requestId: requiredId(args.requestId, "requestId") };
  if (toolName === "agentstoz_use_read_mission") {
    const eventLimit = args.eventLimit === undefined ? 100 : args.eventLimit;
    if (typeof eventLimit !== "number" || !Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 100) throw new Error("eventLimit must be an integer from 1 to 100.");
    return {
      action: "read-mission", controllerPortId: controller, missionId: requiredId(args.missionId, "missionId"),
      ...(oneLine(args.afterEventId) ? { afterEventId: requiredId(args.afterEventId, "afterEventId") } : {}),
      ...(args.eventLimit === undefined ? {} : { eventLimit }),
    };
  }
  if (toolName === "agentstoz_use_transition_mission") {
    const transition = oneLine(args.transition); if (!["resume", "pause", "complete"].includes(transition)) throw new Error("transition must be resume, pause, or complete.");
    return { action: "transition-mission", controllerPortId: controller, missionId: requiredId(args.missionId, "missionId"), transition, requestId: requiredId(args.requestId, "requestId") };
  }
  if (toolName === "agentstoz_use_link_mission_utterance") {
    const relatedPortIds = Array.isArray(args.relatedPortIds) ? args.relatedPortIds.map(value => requiredId(value, "relatedPortIds")) : [];
    return { action: "link-mission-utterance", controllerPortId: controller, missionId: requiredId(args.missionId, "missionId"), portId: requiredId(args.portId, "portId"), whatISaidEventId: requiredId(args.whatISaidEventId, "whatISaidEventId"), relatedPortIds, requestId: requiredId(args.requestId, "requestId") };
  }
  if (toolName === "agentstoz_use_record_mission_project_result") {
    const ids = (field: string) => Array.isArray(args[field]) ? (args[field] as unknown[]).map(value => requiredId(value, field)) : [];
    return { action: "record-mission-project-result", controllerPortId: controller, missionId: requiredId(args.missionId, "missionId"), requestId: requiredId(args.requestId, "requestId"), mentionedPortIds: ids("mentionedPortIds"), changedPortIds: ids("changedPortIds"), decisionPortIds: ids("decisionPortIds"), verifiedResultPortIds: ids("verifiedResultPortIds"), resultSummary: requiredInstruction(args.resultSummary) };
  }
  if (toolName === "agentstoz_use_open_dashboard") {
    return { action: "open-dashboard", controllerPortId: controller };
  }
  if (toolName === "agentstoz_use_open_code_app") {
    const agent = oneLine(args.agent);
    if (agent !== "codex" && agent !== "claude" && agent !== "hermes") {
      throw new Error("agent must be codex, claude, or hermes.");
    }
    return {
      action: "open-code-app",
      controllerPortId: controller,
      portId: requiredId(args.portId, "portId"),
      agent,
    };
  }
  if (toolName === "agentstoz_use_open_buzz_dev") {
    return { action: "open-buzz-dev", controllerPortId: controller, portId: requiredId(args.portId, "portId") };
  }
  throw new Error("Unknown AgentsToZ USE tool.");
}

async function callLocalControl(
  action: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const response = await fetch(resolveAgentsToZUseMcpEndpoint(env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
    signal: AbortSignal.timeout(agentsToZUseMcpTimeoutMs(action)),
  });
  const result = await response.json().catch(() => ({
    success: false,
    code: "AGENTSTOZ_USE_INVALID_RESPONSE",
    error: "AgentsToZ returned a non-JSON response.",
  })) as Record<string, unknown>;
  if (!response.ok || result.success !== true || result.performed !== true) {
    const error = new Error(oneLine(result.error) || `AgentsToZ USE action failed with HTTP ${response.status}.`);
    (error as Error & { data?: unknown }).data = result;
    throw error;
  }
  return result;
}

export function agentsToZUseMcpTimeoutMs(action: Record<string, unknown>): number {
  if (action.action === "create-github-repository") {
    // The explicit Private-memory option performs a verified cold archive only
    // after repository creation. Fetch/verification/push retry can legitimately
    // exceed the repository-only window; aborting the client early would report
    // failure while the local server continues changing GitHub state.
    return action.archiveMemory === true ? 600_000 : 150_000;
  }
  return action.action === "connect-buzz-channel" ? 60_000 : 20_000;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export async function handleAgentsToZUseMcpRequest(
  request: JsonRpcRequest,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, unknown> | null> {
  const id = request.id ?? null;
  const method = oneLine(request.method);
  if (!method) return rpcError(id, -32600, "Invalid JSON-RPC request.");
  if (request.id === undefined && method.startsWith("notifications/")) return null;
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: AGENTSTOZ_USE_MCP_INSTRUCTIONS,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: AGENTSTOZ_USE_MCP_TOOLS });
  if (method === "tools/call") {
    const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    try {
      const action = agentsToZUseMcpActionForTool(params.name, params.arguments, env.AGENTSTOZ_CONTROLLER_PORT_ID);
      const result = await callLocalControl(action, env);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const data = error && typeof error === "object" && "data" in error
        ? (error as { data?: unknown }).data
        : undefined;
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify({ success: false, performed: false, error: detail, data }) }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let response: Record<string, unknown>;
      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        response = await handleAgentsToZUseMcpRequest(request) ?? {};
        if (!Object.keys(response).length) continue;
      } catch (error) {
        response = rpcError(null, -32700, error instanceof Error ? error.message : "Parse error.");
      }
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (import.meta.main) await main();
