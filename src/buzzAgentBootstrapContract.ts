import { agentsToZUseControlPromptLines } from "./agentstozUseControl";

export type BuzzAgentRuntime = "codex" | "claude" | "hermes";
export type BuzzAgentScope = "global" | "service";

export type BuzzProjectAgentTarget = {
  projectId: string;
  projectName: string;
  canonicalPath: string;
  memoryId: string;
};

export type BuzzServiceMemoryTarget = {
  serviceMemoryId: string;
  serviceKey: string;
  displayName: string;
  sourcePath: string;
  configPath: string;
};

export type AgentsToZUseControlTarget = {
  endpoint: string;
  controllerPortId: string;
  actions: readonly string[];
  codexMcp: {
    serverName: string;
    executablePath: string | null;
    installed: boolean;
    ready: boolean;
    problem: string | null;
  };
};

export const BUZZ_AGENT_RUNTIME_LABELS: Record<BuzzAgentRuntime, string> = {
  codex: "Codex",
  claude: "Claude Code",
  hermes: "Hermes",
};

function oneLine(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function bounded(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

export function defaultBuzzCsCeoAgentName(deviceName: unknown): string {
  const normalizedDeviceName = oneLine(deviceName) || "이 단말";
  return bounded(`CS-CEO · ${normalizedDeviceName}`, 64);
}

export function defaultBuzzServiceAgentName(input: {
  projectName: unknown;
  deviceName: unknown;
  agentsToZControl?: boolean;
}): string {
  const projectName = input.agentsToZControl
    ? "AgentsToZ USE"
    : oneLine(input.projectName) || "프로젝트";
  const deviceName = oneLine(input.deviceName) || "이 단말";
  return bounded(`${projectName} · ${deviceName}`, 64);
}

function relativeSkillPath(canonicalRoot: string, skillPath: string): string {
  const normalizedRoot = canonicalRoot.replace(/[\\/]+$/, "");
  if (skillPath.startsWith(`${normalizedRoot}/`) || skillPath.startsWith(`${normalizedRoot}\\`)) {
    return skillPath.slice(normalizedRoot.length + 1).replace(/\\/g, "/");
  }
  return skillPath;
}

export function buildGenericBuzzCsCeoInstructions(input: {
  deviceName: unknown;
  canonicalRoot: unknown;
  skillPath: unknown;
  runtime: BuzzAgentRuntime;
}): string {
  const deviceName = oneLine(input.deviceName) || "this device";
  const canonicalRoot = oneLine(input.canonicalRoot);
  const skillPath = oneLine(input.skillPath);
  const runtimeLabel = BUZZ_AGENT_RUNTIME_LABELS[input.runtime];
  if (!canonicalRoot || !skillPath || !runtimeLabel) {
    throw new Error("Buzz 범용 CS-CEO 설정에는 정본 폴더, CS-CEO skill, 실행기가 필요합니다.");
  }
  const canonicalSkill = relativeSkillPath(canonicalRoot, skillPath);
  return [
    `You are the reusable CS-CEO agent for device ${deviceName}.`,
    `Your canonical CS-CEO bootstrap repository is: ${canonicalRoot}`,
    "Buzz may start the ACP session in its own nest. Do not treat that nest as the target project; use the bootstrap repository and resolved project paths by absolute path.",
    `Use ${runtimeLabel} as the primary execution runtime for this agent.`,
    `Before orchestrating work, read the canonical CS-CEO skill at ${canonicalSkill} from the bootstrap working directory and follow it.`,
    "This is a device-level reusable agent. Do not assume a fixed project, Buzz channel, repository, or long-term-memory identity.",
    "At the start of project work in a Buzz channel, read the current channel UUID from the Buzz <context> block and POST a credential-free JSON request to http://127.0.0.1:3001/api/project-memory/thread/status with platform=buzz, chatId from the BUZZ_RELAY_URL environment value, and threadId set to that channel UUID.",
    "When that local resolver returns ok=true, use binding.canonicalPath as the explicit target project, verify binding.memoryId against that project's local config, and do not silently substitute the bootstrap repository.",
    "If the channel is not linked on this device or the local AgentsToZ API is unavailable, do not guess a folder. Ask for an explicit target project path or tell the owner to connect the project with AgentsToZ 'Buzz로 열기'.",
    "For substantial work in a target project, read that project's own instructions and local project-memory skill before editing, then use its remember-session workflow when meaningful work ends.",
    "A target project may gain a Git repository before or after work starts. Detect and use its current local Git state without requiring GitHub as a prerequisite.",
    "Coordinate only the runtimes and tools that are actually available, report important blockers honestly, and never copy authentication secrets into chat or project files.",
  ].join("\n");
}

export function buildServiceBuzzAgentInstructions(input: {
  deviceName: unknown;
  project: BuzzProjectAgentTarget;
  serviceMemory: BuzzServiceMemoryTarget;
  runtime: BuzzAgentRuntime;
  control?: AgentsToZUseControlTarget | null;
}): string {
  const deviceName = oneLine(input.deviceName) || "this device";
  const projectId = oneLine(input.project.projectId);
  const projectName = oneLine(input.project.projectName);
  const canonicalPath = oneLine(input.project.canonicalPath);
  const memoryId = oneLine(input.project.memoryId);
  const serviceMemoryId = oneLine(input.serviceMemory.serviceMemoryId);
  const serviceKey = oneLine(input.serviceMemory.serviceKey);
  const serviceMemoryPath = oneLine(input.serviceMemory.sourcePath);
  const serviceMemoryConfigPath = oneLine(input.serviceMemory.configPath);
  const runtimeLabel = BUZZ_AGENT_RUNTIME_LABELS[input.runtime];
  if (!projectId || !projectName || !canonicalPath || !memoryId || !serviceMemoryId
    || !serviceKey || !serviceMemoryPath || !serviceMemoryConfigPath || !runtimeLabel) {
    throw new Error("Buzz USE 서비스 Agent 설정에는 DEV 프로젝트, USE 운영기억, 실행기가 필요합니다.");
  }
  const controlLines = input.control
    ? agentsToZUseControlPromptLines({
      controllerPortId: input.control.controllerPortId,
      endpoint: input.control.endpoint,
    })
    : [];
  return [
    `You are the user-facing service agent for ${projectName} on device ${deviceName}.`,
    "Your role is USE: help people operate the product safely. You are not a product-development agent.",
    `Use ${runtimeLabel} as the primary execution runtime for this agent.`,
    `Linked AgentsToZ DEV project ID: ${projectId}`,
    `Linked DEV project path (read-only): ${canonicalPath}`,
    `Expected DEV project memory ID (read-only identity): ${memoryId}`,
    `USE service memory ID: ${serviceMemoryId}`,
    `USE service key: ${serviceKey}`,
    `USE service memory file: ${serviceMemoryPath}`,
    `USE service memory config: ${serviceMemoryConfigPath}`,
    "The USE service memory is the only durable memory you may update. Verify its config identity before using it and fail closed if it is missing or mismatched.",
    "The same USE service memory is shared when this service persona is used through Buzz, Hermes, or Telegram; a surface transcript is not a separate source of truth.",
    "Do not directly edit the linked DEV project's source files, project instructions, arbitrary Git state, GitHub settings, deployment configuration, or DEV memory. You may perform only an installed bounded AgentsToZ control operation when it explicitly supports the request; this includes creating another local project and creating that registered project's GitHub repository after the user explicitly chooses private or public.",
    "Do not run development, build, deployment, migration, or destructive commands from USE mode. Read product files only when needed to answer safely.",
    "Keep only validated operating knowledge, stable preferences, and reusable answers in USE memory. Do not store raw transcripts, secrets, private keys, or unnecessary personal data.",
    "When a bug or product change is needed, do not implement it. Produce a compact DEV_HANDOFF containing summary, reproduction, expected behavior, actual behavior, impact, evidence, and acceptance criteria.",
    "If a request crosses the USE boundary, explain the boundary and hand it to the DEV channel and CS-CEO rather than silently expanding authority.",
    ...controlLines,
  ].join("\n");
}

export function buildBuzzAgentSetupClipboard(input: {
  agentName: unknown;
  canonicalRoot?: unknown;
  runtime: BuzzAgentRuntime;
  instructions: unknown;
  scope?: BuzzAgentScope;
  project?: BuzzProjectAgentTarget | null;
  serviceMemory?: BuzzServiceMemoryTarget | null;
}): string {
  const agentName = oneLine(input.agentName);
  const canonicalRoot = oneLine(input.canonicalRoot);
  const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
  const scope = input.scope ?? "global";
  const project = input.project ?? null;
  const serviceMemory = input.serviceMemory ?? null;
  const targetPath = scope === "service" ? oneLine(project?.canonicalPath) : canonicalRoot;
  if (!agentName || !targetPath || !instructions || (scope === "service" && (!project || !serviceMemory))) {
    throw new Error("복사할 Buzz Agent 설정이 완성되지 않았습니다.");
  }
  return [
    "Buzz Desktop > Agents > New agent",
    `Name: ${agentName}`,
    `Runtime: ${BUZZ_AGENT_RUNTIME_LABELS[input.runtime]}`,
    scope === "service"
      ? `Linked DEV project: ${targetPath}`
      : `Bootstrap repository (system prompt absolute path): ${targetPath}`,
    scope === "service"
      ? `DEV memory ID: ${project!.memoryId}`
      : "Per-channel project path: AgentsToZ local binding resolver in the system prompt",
    ...(scope === "service"
      ? [
        `USE service memory ID: ${serviceMemory!.serviceMemoryId}`,
        `USE service memory file: ${serviceMemory!.sourcePath}`,
        "Channel assignment: USE channels only",
      ]
      : ["Channel assignment: 생성 후 필요한 DEV 채널에서 별도로 추가"]),
    "Visibility: 소유자만 설정 변경",
    "System prompt:",
    instructions,
    "",
    "최종 Create/Save는 소유자가 Buzz Desktop에서 검토 후 실행",
  ].join("\n");
}
