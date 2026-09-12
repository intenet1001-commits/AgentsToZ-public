export const AGENTSTOZ_USE_CONTROL_ENDPOINT = "http://127.0.0.1:3001/api/agentstoz-use/action";

export const AGENTSTOZ_USE_ACTIONS = [
  "list-projects",
  "list-workspace-roots",
  "create-project",
  "create-control-center",
  "connect-buzz-channel",
  "create-github-repository",
  "project-status",
  "list-workroom-sessions",
  "read-workroom-session",
  "start-workroom-session",
  "send-workroom-instruction",
  "list-missions",
  "create-mission",
  "read-mission",
  "transition-mission",
  "link-mission-utterance",
  "record-mission-project-result",
  "open-dashboard",
  "open-code-app",
  "open-buzz-dev",
] as const;

export type AgentsToZUseAction = typeof AGENTSTOZ_USE_ACTIONS[number];
export type AgentsToZUseCodeApp = "codex" | "claude" | "hermes";
export type AgentsToZUseWorkroomAgent = AgentsToZUseCodeApp | "agy";
export type AgentsToZUseGitHubVisibility = "private" | "public";

export type AgentsToZUseActionRequest = {
  action: AgentsToZUseAction;
  controllerPortId: string;
  portId: string | null;
  agent: AgentsToZUseWorkroomAgent | null;
  projectName: string | null;
  workspaceRootId: string | null;
  channelId: string | null;
  channelName: string | null;
  visibility: AgentsToZUseGitHubVisibility | null;
  archiveMemory: boolean;
  sessionId: string | null;
  after: number;
  afterEventId?: string | null;
  eventLimit?: number;
  requestId: string | null;
  instruction: string | null;
  missionId?: string | null;
  missionTransition?: "resume" | "pause" | "complete" | null;
  title?: string | null;
  goal?: string | null;
  whatISaidEventId?: string | null;
  relatedPortIds?: string[];
  mentionedPortIds?: string[];
  changedPortIds?: string[];
  decisionPortIds?: string[];
  verifiedResultPortIds?: string[];
  resultSummary?: string | null;
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
    || action === "list-workroom-sessions"
    || action === "read-workroom-session"
    || action === "start-workroom-session"
    || action === "send-workroom-instruction"
    || action === "link-mission-utterance"
    || action === "connect-buzz-channel"
    || action === "create-github-repository"
    || action === "open-code-app"
    || action === "open-buzz-dev";
  const portId = requiresProject ? requiredId(body.portId, "portId") : null;
  let agent: AgentsToZUseWorkroomAgent | null = null;
  let projectName: string | null = null;
  let workspaceRootId: string | null = null;
  let channelId: string | null = null;
  let channelName: string | null = null;
  let visibility: AgentsToZUseGitHubVisibility | null = null;
  let archiveMemory = false;
  let sessionId: string | null = null;
  let after = 0;
  let afterEventId: string | null = null;
  let eventLimit = 100;
  let requestId: string | null = null;
  let instruction: string | null = null;
  let missionId: string | null = null;
  let missionTransition: "resume" | "pause" | "complete" | null = null;
  let title: string | null = null;
  let goal: string | null = null;
  let whatISaidEventId: string | null = null;
  let relatedPortIds: string[] = [];
  let mentionedPortIds: string[] = [];
  let changedPortIds: string[] = [];
  let decisionPortIds: string[] = [];
  let verifiedResultPortIds: string[] = [];
  let resultSummary: string | null = null;
  if (action === "create-mission") {
    title = oneLine(body.title); goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!title || title.length > 240 || !goal || new TextEncoder().encode(goal).length > 4_000) throw new AgentsToZUseControlError("미션 제목과 목표가 필요합니다.", "AGENTSTOZ_USE_MISSION_INPUT_INVALID");
  }
  if (action === "read-mission" || action === "transition-mission" || action === "link-mission-utterance") missionId = requiredId(body.missionId, "missionId");
  if (action === "read-mission") {
    if (body.afterEventId !== undefined) {
      afterEventId = requiredId(body.afterEventId, "afterEventId");
      if (!/^event_[0-9a-f-]{36}$/.test(afterEventId)) throw new AgentsToZUseControlError("afterEventId 형식이 올바르지 않습니다.", "AGENTSTOZ_USE_MISSION_CURSOR_INVALID");
    }
    if (body.eventLimit !== undefined && (typeof body.eventLimit !== "number" || !Number.isSafeInteger(body.eventLimit) || body.eventLimit < 1 || body.eventLimit > 100)) {
      throw new AgentsToZUseControlError("eventLimit은 1~100의 정수여야 합니다.", "AGENTSTOZ_USE_MISSION_CURSOR_INVALID");
    }
    eventLimit = typeof body.eventLimit === "number" ? body.eventLimit : 100;
  }
  if (action === "link-mission-utterance") {
    whatISaidEventId = requiredId(body.whatISaidEventId, "whatISaidEventId");
    if (!/^wis_[0-9a-f]{64}$/.test(whatISaidEventId)) throw new AgentsToZUseControlError("whatISaidEventId 형식이 올바르지 않습니다.", "AGENTSTOZ_USE_WHAT_I_SAID_ID_INVALID");
    if (body.relatedPortIds !== undefined && !Array.isArray(body.relatedPortIds)) throw new AgentsToZUseControlError("relatedPortIds는 프로젝트 ID 배열이어야 합니다.", "AGENTSTOZ_USE_PROJECT_ID_INVALID");
    const values = (body.relatedPortIds ?? []) as unknown[];
    if (values.length > 16) throw new AgentsToZUseControlError("관련 프로젝트는 최대 16개까지 연결할 수 있습니다.", "AGENTSTOZ_USE_PROJECT_ID_INVALID");
    relatedPortIds = [...new Set(values.map(value => requiredId(value, "relatedPortIds")))];
  }
  if (action === "record-mission-project-result") {
    missionId = requiredId(body.missionId, "missionId");
    const projectIds = (field: string): string[] => {
      const value = body[field];
      if (!Array.isArray(value) || value.length > 16) throw new AgentsToZUseControlError(`${field}는 최대 16개의 프로젝트 ID 배열이어야 합니다.`, "AGENTSTOZ_USE_PROJECT_ID_INVALID");
      return [...new Set(value.map(item => requiredId(item, field)))];
    };
    mentionedPortIds = projectIds("mentionedPortIds"); changedPortIds = projectIds("changedPortIds");
    decisionPortIds = projectIds("decisionPortIds"); verifiedResultPortIds = projectIds("verifiedResultPortIds");
    resultSummary = typeof body.resultSummary === "string" ? body.resultSummary.replace(/\r\n?/g, "\n").trim() : "";
    if (!resultSummary || new TextEncoder().encode(resultSummary).length > 2_000 || resultSummary.includes("\0")) throw new AgentsToZUseControlError("resultSummary는 2,000바이트 이하의 결과 요약이어야 합니다.", "AGENTSTOZ_USE_MISSION_INPUT_INVALID");
  }
  if (action === "transition-mission") {
    const transition = oneLine(body.transition);
    if (transition !== "resume" && transition !== "pause" && transition !== "complete") throw new AgentsToZUseControlError("미션 상태 변경값이 올바르지 않습니다.", "AGENTSTOZ_USE_MISSION_TRANSITION_INVALID");
    missionTransition = transition;
  }
  if (action === "read-workroom-session" || action === "send-workroom-instruction") {
    sessionId = requiredId(body.sessionId, "sessionId");
  }
  if ((action === "start-workroom-session" || action === "send-workroom-instruction") && body.missionId !== undefined) {
    missionId = requiredId(body.missionId, "missionId");
    if (!missionId.startsWith("mission_")) throw new AgentsToZUseControlError("missionId 형식이 올바르지 않습니다.", "AGENTSTOZ_USE_MISSION_INPUT_INVALID");
  }
  if (action === "read-workroom-session") {
    if (body.after !== undefined && (typeof body.after !== "number" || !Number.isSafeInteger(body.after) || body.after < 0)) {
      throw new AgentsToZUseControlError(
        "after는 0 이상의 안전한 정수여야 합니다.",
        "AGENTSTOZ_USE_WORKROOM_CURSOR_INVALID",
      );
    }
    after = typeof body.after === "number" ? body.after : 0;
  }
  if (action === "start-workroom-session" || action === "send-workroom-instruction") {
    const candidateRequestId = oneLine(body.requestId);
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(candidateRequestId)) {
      throw new AgentsToZUseControlError("requestId 형식이 올바르지 않습니다.", "AGENTSTOZ_USE_WORKROOM_REQUEST_ID_INVALID");
    }
    requestId = candidateRequestId;
    if (action === "start-workroom-session") {
      const candidate = oneLine(body.agent);
      if (candidate !== "codex" && candidate !== "claude" && candidate !== "hermes" && candidate !== "agy") {
        throw new AgentsToZUseControlError("새 워크룸 세션의 agent는 codex, claude, hermes 또는 agy여야 합니다.", "AGENTSTOZ_USE_AGENT_INVALID");
      }
      agent = candidate;
    } else {
      if (typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.includes("\0")
        || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.instruction)) {
        throw new AgentsToZUseControlError("instruction은 제어 문자가 없는 작업 지시여야 합니다.", "AGENTSTOZ_USE_WORKROOM_INSTRUCTION_INVALID");
      }
      instruction = body.instruction.replace(/\r\n?/g, "\n").trim();
      if (new TextEncoder().encode(instruction).length > 4_000) {
        throw new AgentsToZUseControlError("instruction은 UTF-8 기준 4,000바이트 이하여야 합니다.", "AGENTSTOZ_USE_WORKROOM_INSTRUCTION_TOO_LARGE");
      }
    }
  }
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
  if (action === "create-project" || action === "create-control-center") {
    projectName = action === "create-control-center"
      ? (oneLine(body.projectName) || "AgentsToZ-Control")
      : oneLine(body.projectName);
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
  if (action === "create-mission" || action === "transition-mission" || action === "link-mission-utterance" || action === "record-mission-project-result") {
    const candidateRequestId = oneLine(body.requestId);
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(candidateRequestId)) throw new AgentsToZUseControlError("requestId 형식이 올바르지 않습니다.", "AGENTSTOZ_USE_MISSION_REQUEST_ID_INVALID");
    requestId = candidateRequestId;
  }
  return { action, controllerPortId, portId, agent, projectName, workspaceRootId, channelId, channelName, visibility, archiveMemory, sessionId, after, requestId, instruction,
    ...(action === "create-mission" ? { title, goal } : {}),
    ...(action === "read-mission" || action === "link-mission-utterance" || ((action === "start-workroom-session" || action === "send-workroom-instruction") && missionId) ? { missionId } : {}),
    ...(action === "read-mission" ? { afterEventId, eventLimit } : {}),
    ...(action === "transition-mission" ? { missionId, missionTransition } : {}),
    ...(action === "link-mission-utterance" ? { whatISaidEventId, relatedPortIds } : {}),
    ...(action === "record-mission-project-result" ? { missionId, mentionedPortIds, changedPortIds, decisionPortIds, verifiedResultPortIds, resultSummary } : {}),
  };
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
    "Use only the installed MCP tools named agentstoz_use_list_projects, agentstoz_use_list_workspace_roots, agentstoz_use_create_project, agentstoz_use_connect_buzz_channel, agentstoz_use_create_github_repository, agentstoz_use_project_status, agentstoz_use_list_workroom_sessions, agentstoz_use_read_workroom_session, agentstoz_use_start_workroom_session, agentstoz_use_send_workroom_instruction, agentstoz_use_list_missions, agentstoz_use_create_mission, agentstoz_use_read_mission, agentstoz_use_transition_mission, agentstoz_use_link_mission_utterance, agentstoz_use_record_mission_project_result, agentstoz_use_open_dashboard, agentstoz_use_open_code_app, and agentstoz_use_open_buzz_dev. Do not call the local endpoint through curl, shell networking, or node_repl.",
    "Use missions only for explicit durable orchestration or multi-project/multi-agent work. Listing projects and simply opening an app stay ephemeral. After interruption or restart, call resume only when the user explicitly asks to continue that mission.",
    "The bridge sends fixed credential-free JSON. Never provide a folder path, shell command, URL, private key, token, or credential to a control tool. Only agentstoz_use_send_workroom_instruction may receive the user's bounded natural-language instruction.",
    "For an existing project, first call agentstoz_use_list_projects and use only a portId returned by that tool. For a new project, first call agentstoz_use_list_workspace_roots and pass only a workspaceRootId returned by that tool. Never guess IDs and never call older path-based endpoints.",
    "The local bridge resolves every portId against the registered AgentsToZ project list and rejects actions outside the fixed tool set.",
    "To inspect Workroom, list sessions for a returned project ID first. Read output only with a sessionId returned for that same project. Never guess a session ID or describe a historical session as running.",
    "To start a Codex, Claude, Hermes, or agy Workroom session, use a returned project ID and a fresh requestId, then read its output before sending any instruction because the CLI may present a local setup, trust, profile, or login screen. To instruct an existing session, list it first, use its exact sessionId, and use a fresh requestId. Reuse a requestId only to retry the exact same action; never reuse it for different content.",
    "USE owns bounded operations that already exist in the AgentsToZ app, including creating and registering a new local project through agentstoz_use_create_project. This operation may initialize that new project's Git repository and DEV memory because those are the app's normal project-creation defaults. Before creating a project, ask whether the user also wants a GitHub repository. If yes, ask private or public before creation, then create the local project first and call agentstoz_use_create_github_repository with the returned portId. If no, create only the local project.",
    "When the user asks to connect the current manually-created Buzz channel to a project, read the current channel UUID and channel name from the Buzz <context> block, list registered projects, and call agentstoz_use_connect_buzz_channel with only that returned portId plus the current channelId and channelName. This operation uses the configured local Buzz relay, initializes DEV project memory only when missing, and binds the channel. Never guess or ask for a folder path or relay URL. Report verified=false honestly when local Buzz CLI authentication could not independently verify the context-provided channel.",
    "Creating a GitHub repository is also USE when the user names an existing project and explicitly chooses private or public. Never infer visibility. If the user chooses Private, separately ask whether verified long-term memory should also be kept in the repository's dedicated disaster-recovery branch; pass archiveMemory=true only after an explicit yes. Public repositories can never receive this memory archive. agentstoz_use_create_github_repository derives the repository name and local source from the registered project ID, creates origin, and pushes committed history; uncommitted files are not uploaded.",
    "DEV_HANDOFF is only for changing the AgentsToZ product itself: source code, product behavior, builds, deployment, or the controller project's DEV memory. Do not hand off a request merely because an existing app operation changes normal project state.",
    "Creating, unlinking, or deleting a Buzz channel and executing arbitrary commands are not available in USE mode. Linking the current context-provided Buzz channel is available only through agentstoz_use_connect_buzz_channel.",
    "For open-buzz-dev, report the returned channel name and the exact-channel limitation honestly: the current Buzz API can bring the app forward but cannot deep-link to a channel.",
    "If the MCP tool is unavailable or reports an error, state that the Codex local control bridge or AgentsToZ sidecar is offline. Never claim an action succeeded without success=true and performed=true in the tool response.",
  ];
}
