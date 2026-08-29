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
const SERVER_VERSION = "1.3.0";
const PROTOCOL_VERSION = "2025-06-18";

export const AGENTSTOZ_USE_MCP_SERVER_NAME = "agentstoz_use";

export const AGENTSTOZ_USE_MCP_TOOLS: ToolDefinition[] = [
  {
    name: "agentstoz_use_list_projects",
    description: "List this device's registered AgentsToZ projects without exposing local folder paths.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentstoz_use_list_workspace_roots",
    description: "List registered workspace-root IDs and display names without exposing local paths. Call this before creating a project.",
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
): Record<string, string | boolean> {
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
  action: Record<string, string | boolean>,
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

export function agentsToZUseMcpTimeoutMs(action: Record<string, string | boolean>): number {
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
