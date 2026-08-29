export const AGENTSTOZ_USE_CONTROL_ENDPOINT = "http://127.0.0.1:3001/api/agentstoz-use/action";

export const AGENTSTOZ_USE_ACTIONS = [
  "list-projects",
  "list-workspace-roots",
  "create-project",
  "connect-buzz-channel",
  "create-github-repository",
  "project-status",
  "open-dashboard",
  "open-code-app",
  "open-buzz-dev",
] as const;

export type AgentsToZUseAction = typeof AGENTSTOZ_USE_ACTIONS[number];
export type AgentsToZUseCodeApp = "codex" | "claude" | "hermes";
export type AgentsToZUseGitHubVisibility = "private" | "public";

export type AgentsToZUseActionRequest = {
  action: AgentsToZUseAction;
  controllerPortId: string;
  portId: string | null;
  agent: AgentsToZUseCodeApp | null;
  projectName: string | null;
  workspaceRootId: string | null;
  channelId: string | null;
  channelName: string | null;
  visibility: AgentsToZUseGitHubVisibility | null;
  archiveMemory: boolean;
};

export class AgentsToZUseControlError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AgentsToZUseControlError";
  }
}

function oneLine(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function requiredId(value: unknown, field: string): string {
  const normalized = oneLine(value);
  if (!normalized || normalized.length > 200) {
    throw new AgentsToZUseControlError(
      `${field}는 등록된 프로젝트 ID여야 합니다.`,
      "AGENTSTOZ_USE_PROJECT_ID_INVALID",
    );
  }
  return normalized;
}

export function parseAgentsToZUseActionRequest(input: unknown): AgentsToZUseActionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentsToZUseControlError(
      "JSON 객체 요청이 필요합니다.",
      "AGENTSTOZ_USE_REQUEST_INVALID",
    );
  }
  const body = input as Record<string, unknown>;
  const action = oneLine(body.action) as AgentsToZUseAction;
  if (!AGENTSTOZ_USE_ACTIONS.includes(action)) {
    throw new AgentsToZUseControlError(
      `허용되지 않은 USE 동작입니다. 허용값: ${AGENTSTOZ_USE_ACTIONS.join(", ")}`,
      "AGENTSTOZ_USE_ACTION_NOT_ALLOWED",
    );
  }
  const controllerPortId = requiredId(body.controllerPortId, "controllerPortId");
  const requiresProject = action === "project-status"
    || action === "connect-buzz-channel"
    || action === "create-github-repository"
    || action === "open-code-app"
    || action === "open-buzz-dev";
  const portId = requiresProject ? requiredId(body.portId, "portId") : null;
  let agent: AgentsToZUseCodeApp | null = null;
  let projectName: string | null = null;
  let workspaceRootId: string | null = null;
  let channelId: string | null = null;
  let channelName: string | null = null;
  let visibility: AgentsToZUseGitHubVisibility | null = null;
  let archiveMemory = false;
  if (action === "open-code-app") {
    const candidate = oneLine(body.agent);
    if (candidate !== "codex" && candidate !== "claude" && candidate !== "hermes") {
      throw new AgentsToZUseControlError(
        "agent는 codex, claude, hermes 중 하나여야 합니다.",
        "AGENTSTOZ_USE_AGENT_INVALID",
      );
    }
    agent = candidate;
  }
  if (action === "create-project") {
    projectName = oneLine(body.projectName);
    if (!projectName || projectName.length > 120) {
      throw new AgentsToZUseControlError(
        "projectName은 1~120자의 프로젝트 이름이어야 합니다.",
        "AGENTSTOZ_USE_PROJECT_NAME_INVALID",
      );
    }
    workspaceRootId = oneLine(body.workspaceRootId) || null;
    if (!workspaceRootId || workspaceRootId.length > 200) {
      throw new AgentsToZUseControlError(
        "workspaceRootId는 등록된 작업 루트 ID여야 합니다.",
        "AGENTSTOZ_USE_WORKSPACE_ROOT_ID_INVALID",
      );
    }
  }
  if (action === "create-github-repository") {
    const candidate = oneLine(body.visibility);
    if (candidate !== "private" && candidate !== "public") {
      throw new AgentsToZUseControlError(
        "visibility는 private 또는 public을 명시해야 합니다.",
        "AGENTSTOZ_USE_GITHUB_VISIBILITY_REQUIRED",
      );
    }
    visibility = candidate;
    if (body.archiveMemory !== undefined && typeof body.archiveMemory !== "boolean") {
      throw new AgentsToZUseControlError(
        "archiveMemory는 사용자가 명시한 true 또는 false여야 합니다.",
        "AGENTSTOZ_USE_GITHUB_ARCHIVE_CHOICE_REQUIRED",
      );
    }
    archiveMemory = body.archiveMemory === true;
    if (archiveMemory && visibility !== "private") {
      throw new AgentsToZUseControlError(
        "장기기억 재해복구 보관은 Private GitHub에서만 켤 수 있습니다.",
        "AGENTSTOZ_USE_GITHUB_ARCHIVE_PRIVATE_REQUIRED",
      );
    }
  }
  if (action === "connect-buzz-channel") {
    const candidate = oneLine(body.channelId).toLocaleLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) {
      throw new AgentsToZUseControlError(
        "channelId는 현재 Buzz 채널의 UUID여야 합니다.",
        "AGENTSTOZ_USE_BUZZ_CHANNEL_ID_INVALID",
      );
    }
    channelId = candidate;
    channelName = oneLine(body.channelName).slice(0, 64) || null;
  }
  return { action, controllerPortId, portId, agent, projectName, workspaceRootId, channelId, channelName, visibility, archiveMemory };
}

export function agentsToZUseControlPromptLines(input: {
  controllerPortId: string;
  endpoint?: string;
}): string[] {
  const controllerPortId = requiredId(input.controllerPortId, "controllerPortId");
  const endpoint = oneLine(input.endpoint) || AGENTSTOZ_USE_CONTROL_ENDPOINT;
  return [
    "This project is AgentsToZ itself, so you may also act as its bounded conversational control surface on this device.",
    `The installed local bridge internally uses: ${endpoint}`,
    `Fixed controllerPortId: ${controllerPortId}`,
    "Use only the installed MCP tools named agentstoz_use_list_projects, agentstoz_use_list_workspace_roots, agentstoz_use_create_project, agentstoz_use_connect_buzz_channel, agentstoz_use_create_github_repository, agentstoz_use_project_status, agentstoz_use_open_dashboard, agentstoz_use_open_code_app, and agentstoz_use_open_buzz_dev. Do not call the local endpoint through curl, shell networking, or node_repl.",
    "The bridge sends fixed credential-free JSON. Never provide a folder path, shell command, URL, private key, token, credential, or raw user message to a control tool.",
    "For an existing project, first call agentstoz_use_list_projects and use only a portId returned by that tool. For a new project, first call agentstoz_use_list_workspace_roots and pass only a workspaceRootId returned by that tool. Never guess IDs and never call older path-based endpoints.",
    "The local bridge resolves every portId against the registered AgentsToZ project list and rejects actions outside the fixed tool set.",
    "USE owns bounded operations that already exist in the AgentsToZ app, including creating and registering a new local project through agentstoz_use_create_project. This operation may initialize that new project's Git repository and DEV memory because those are the app's normal project-creation defaults. Before creating a project, ask whether the user also wants a GitHub repository. If yes, ask private or public before creation, then create the local project first and call agentstoz_use_create_github_repository with the returned portId. If no, create only the local project.",
    "When the user asks to connect the current manually-created Buzz channel to a project, read the current channel UUID and channel name from the Buzz <context> block, list registered projects, and call agentstoz_use_connect_buzz_channel with only that returned portId plus the current channelId and channelName. This operation uses the configured local Buzz relay, initializes DEV project memory only when missing, and binds the channel. Never guess or ask for a folder path or relay URL. Report verified=false honestly when local Buzz CLI authentication could not independently verify the context-provided channel.",
    "Creating a GitHub repository is also USE when the user names an existing project and explicitly chooses private or public. Never infer visibility. If the user chooses Private, separately ask whether verified long-term memory should also be kept in the repository's dedicated disaster-recovery branch; pass archiveMemory=true only after an explicit yes. Public repositories can never receive this memory archive. agentstoz_use_create_github_repository derives the repository name and local source from the registered project ID, creates origin, and pushes committed history; uncommitted files are not uploaded.",
    "DEV_HANDOFF is only for changing the AgentsToZ product itself: source code, product behavior, builds, deployment, or the controller project's DEV memory. Do not hand off a request merely because an existing app operation changes normal project state.",
    "Creating, unlinking, or deleting a Buzz channel and executing arbitrary commands are not available in USE mode. Linking the current context-provided Buzz channel is available only through agentstoz_use_connect_buzz_channel.",
    "For open-buzz-dev, report the returned channel name and the exact-channel limitation honestly: the current Buzz API can bring the app forward but cannot deep-link to a channel.",
    "If the MCP tool is unavailable or reports an error, state that the Codex local control bridge or AgentsToZ sidecar is offline. Never claim an action succeeded without success=true and performed=true in the tool response.",
  ];
}
