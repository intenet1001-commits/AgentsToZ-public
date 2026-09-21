import { agentsToZUseControlPromptLines } from "./agentstozUseControl";

export type BuzzAgentRuntime = "codex" | "claude" | "hermes";
export type BuzzAgentScope = "service";

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
    "If a request crosses the USE boundary, explain the boundary and hand it to the DEV owner or development agent rather than silently expanding authority.",
    ...controlLines,
  ].join("\n");
}

export function buildBuzzAgentSetupClipboard(input: {
  agentName: unknown;
  runtime: BuzzAgentRuntime;
  instructions: unknown;
  project?: BuzzProjectAgentTarget | null;
  serviceMemory?: BuzzServiceMemoryTarget | null;
}): string {
  const agentName = oneLine(input.agentName);
  const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
  const project = input.project ?? null;
  const serviceMemory = input.serviceMemory ?? null;
  const targetPath = oneLine(project?.canonicalPath);
  if (!agentName || !targetPath || !instructions || !project || !serviceMemory) {
    throw new Error("복사할 Buzz Agent 설정이 완성되지 않았습니다.");
  }
  return [
    "Buzz Desktop > Agents > New agent",
    `Name: ${agentName}`,
    `Runtime: ${BUZZ_AGENT_RUNTIME_LABELS[input.runtime]}`,
    `Linked DEV project: ${targetPath}`,
    `DEV memory ID: ${project.memoryId}`,
    `USE service memory ID: ${serviceMemory.serviceMemoryId}`,
    `USE service memory file: ${serviceMemory.sourcePath}`,
    "Channel assignment: USE channels only",
    "Visibility: 소유자만 설정 변경",
    "System prompt:",
    instructions,
    "",
    "최종 Create/Save는 소유자가 Buzz Desktop에서 검토 후 실행",
  ].join("\n");
}
