import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  buildServiceBuzzAgentInstructions,
  buildGenericBuzzCsCeoInstructions,
  defaultBuzzServiceAgentName,
  defaultBuzzCsCeoAgentName,
  type BuzzAgentScope,
  type BuzzAgentRuntime,
  type BuzzProjectAgentTarget,
  type BuzzServiceMemoryTarget,
  type AgentsToZUseControlTarget,
} from "./src/buzzAgentBootstrapContract";
import {
  AGENTSTOZ_USE_ACTIONS,
  AGENTSTOZ_USE_CONTROL_ENDPOINT,
  AgentsToZUseControlError,
} from "./src/agentstozUseControl";
import { AGENTSTOZ_USE_MCP_SERVER_NAME } from "./agentstoz-use-mcp-server";
import { resolveBuzzAppPath } from "./buzz-project-server";

export type BuzzAgentRuntimeInspection = {
  id: BuzzAgentRuntime;
  label: string;
  installed: boolean;
  executablePath: string | null;
  configurationState: "ready" | "needs-model" | "unknown";
  configurationProblem: string | null;
};

export type BuzzAgentBootstrapInspection = {
  scope: BuzzAgentScope;
  ready: boolean;
  appInstalled: boolean;
  appPath: string | null;
  canonicalRoot: string | null;
  skillPath: string | null;
  canonicalRootReady: boolean;
  canonicalProblem: string | null;
  runtimes: BuzzAgentRuntimeInspection[];
  defaultRuntime: BuzzAgentRuntime;
  agentName: string;
  instructions: string | null;
  project: BuzzProjectAgentTarget | null;
  serviceMemory: BuzzServiceMemoryTarget | null;
  control: AgentsToZUseControlTarget | null;
  directCreateSupported: false;
  ownerApprovalRequired: true;
};

export function isAgentsToZControlProject(project: BuzzProjectAgentTarget | null | undefined): boolean {
  if (!project?.canonicalPath || !isAbsolute(project.canonicalPath)) return false;
  try {
    const packagePath = join(project.canonicalPath, "package.json");
    if (!existsSync(packagePath)
      || !existsSync(join(project.canonicalPath, "api-server.ts"))
      || !existsSync(join(project.canonicalPath, "src", "App.tsx"))) return false;
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
    return pkg.name === "AgentsToZ_byCS";
  } catch {
    return false;
  }
}

function existingFile(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // Keep checking known executable locations.
    }
  }
  return null;
}

function commandLookup(name: string): string | null {
  try {
    const result = Bun.spawnSync(
      process.platform === "win32" ? ["where", name] : ["/usr/bin/which", name],
      { stdout: "pipe", stderr: "ignore", timeout: 3_000 },
    );
    if (!result.success) return null;
    return existingFile((result.stdout?.toString() ?? "").split(/\r?\n/).map(value => value.trim()));
  } catch {
    return null;
  }
}

function runtimeExecutable(id: BuzzAgentRuntime): string | null {
  const home = homedir();
  if (id === "codex") {
    return existingFile([
      process.env.CODEX_CLI_PATH ?? "",
      join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ]) ?? commandLookup("codex");
  }
  if (id === "claude") {
    return existingFile([
      process.env.CLAUDE_AGENT_ACP_PATH ?? "",
      join(home, ".local", "bin", "claude-agent-acp"),
      "/opt/homebrew/bin/claude-agent-acp",
      "/usr/local/bin/claude-agent-acp",
    ]) ?? commandLookup("claude-agent-acp");
  }
  return existingFile([
    process.env.HERMES_ACP_PATH ?? "",
    join(home, ".local", "bin", "hermes-acp"),
    "/opt/homebrew/bin/hermes-acp",
    "/usr/local/bin/hermes-acp",
  ]) ?? commandLookup("hermes-acp");
}

type CodexMcpInspection = AgentsToZUseControlTarget["codexMcp"];

function bundledUseMcpName(): string {
  return process.platform === "win32" ? "agentstoz-use-mcp.exe" : "agentstoz-use-mcp";
}

export function resolveAgentsToZUseMcpExecutable(): string | null {
  const name = bundledUseMcpName();
  return existingFile([
    process.env.AGENTSTOZ_USE_MCP_PATH ?? "",
    join(dirname(process.execPath), name),
    join(import.meta.dir, "src-tauri", "resources", name),
  ]);
}

function readCodexMcpConfig(codex: string): Record<string, unknown> | null {
  try {
    const result = Bun.spawnSync([codex, "mcp", "get", AGENTSTOZ_USE_MCP_SERVER_NAME, "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    if (!result.success) return null;
    const parsed = JSON.parse(result.stdout?.toString() ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function inspectAgentsToZUseCodexMcp(controllerPortId: string): CodexMcpInspection {
  const executablePath = resolveAgentsToZUseMcpExecutable();
  const codex = runtimeExecutable("codex");
  if (!executablePath) {
    return {
      serverName: AGENTSTOZ_USE_MCP_SERVER_NAME,
      executablePath: null,
      installed: false,
      ready: false,
      problem: "설치된 AgentsToZ 앱에서 제한형 Codex 제어 도구를 찾지 못했습니다.",
    };
  }
  if (!codex) {
    return {
      serverName: AGENTSTOZ_USE_MCP_SERVER_NAME,
      executablePath,
      installed: false,
      ready: false,
      problem: "Codex CLI를 찾지 못했습니다.",
    };
  }
  const config = readCodexMcpConfig(codex);
  if (!config) {
    return {
      serverName: AGENTSTOZ_USE_MCP_SERVER_NAME,
      executablePath,
      installed: false,
      ready: false,
      problem: "Codex에 AgentsToZ 제한형 제어 도구를 연결해야 합니다.",
    };
  }
  const transport = config.transport && typeof config.transport === "object" && !Array.isArray(config.transport)
    ? config.transport as Record<string, unknown>
    : {};
  const env = transport.env && typeof transport.env === "object" && !Array.isArray(transport.env)
    ? transport.env as Record<string, unknown>
    : {};
  const installed = config.enabled === true;
  const matches = installed
    && transport.type === "stdio"
    && transport.command === executablePath
    && env.AGENTSTOZ_CONTROLLER_PORT_ID === controllerPortId;
  return {
    serverName: AGENTSTOZ_USE_MCP_SERVER_NAME,
    executablePath,
    installed,
    ready: matches,
    problem: matches ? null : "기존 agentstoz_use MCP 설정이 이 앱 또는 프로젝트와 일치하지 않습니다. 기존 설정을 확인한 뒤 다시 연결하세요.",
  };
}

export function installAgentsToZUseCodexMcp(controllerPortId: string): CodexMcpInspection & { changed: boolean } {
  const current = inspectAgentsToZUseCodexMcp(controllerPortId);
  if (current.ready) return { ...current, changed: false };
  if (current.installed) throw new AgentsToZUseControlError(
    current.problem ?? "기존 agentstoz_use MCP 설정과 충돌합니다.",
    "AGENTSTOZ_USE_CODEX_MCP_CONFLICT",
    409,
  );
  if (!current.executablePath) throw new AgentsToZUseControlError(
    current.problem ?? "AgentsToZ Codex 제어 도구를 찾지 못했습니다.",
    "AGENTSTOZ_USE_CODEX_MCP_NOT_AVAILABLE",
    409,
  );
  const codex = runtimeExecutable("codex");
  if (!codex) throw new AgentsToZUseControlError(
    "Codex CLI를 찾지 못했습니다.",
    "AGENTSTOZ_USE_CODEX_NOT_AVAILABLE",
    409,
  );
  const result = Bun.spawnSync([
    codex,
    "mcp",
    "add",
    "--env",
    `AGENTSTOZ_CONTROLLER_PORT_ID=${controllerPortId}`,
    AGENTSTOZ_USE_MCP_SERVER_NAME,
    "--",
    current.executablePath,
  ], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  if (!result.success) {
    const detail = (result.stderr?.toString() ?? result.stdout?.toString() ?? "").trim();
    throw new AgentsToZUseControlError(
      detail || "Codex MCP 설정을 저장하지 못했습니다.",
      "AGENTSTOZ_USE_CODEX_MCP_INSTALL_FAILED",
      500,
    );
  }
  const installed = inspectAgentsToZUseCodexMcp(controllerPortId);
  if (!installed.ready) throw new AgentsToZUseControlError(
    installed.problem ?? "Codex MCP 연결 확인에 실패했습니다.",
    "AGENTSTOZ_USE_CODEX_MCP_VERIFY_FAILED",
    500,
  );
  return { ...installed, changed: true };
}

export function parseHermesRuntimeConfiguration(output: string): {
  state: "ready" | "needs-model" | "unknown";
  problem: string | null;
} {
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, "");
  const model = normalized.match(/^\s*Model:\s*(.+?)\s*$/mi)?.[1]?.trim() ?? "";
  if (!model || /^\(not set\)$/i.test(model)) {
    return {
      state: "needs-model",
      problem: "Hermes 기본 모델이 설정되지 않았습니다. Buzz에서 검증된 custom model을 선택하거나 Hermes model 설정을 먼저 완료하세요.",
    };
  }
  return { state: "ready", problem: null };
}

function runtimeConfiguration(id: BuzzAgentRuntime): {
  state: "ready" | "needs-model" | "unknown";
  problem: string | null;
} {
  if (id !== "hermes") return { state: "unknown", problem: null };
  const home = homedir();
  const hermes = existingFile([
    process.env.HERMES_CLI_PATH ?? "",
    join(home, ".local", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ]) ?? commandLookup("hermes");
  if (!hermes) return { state: "unknown", problem: "Hermes CLI 상태를 확인하지 못했습니다." };
  try {
    const result = Bun.spawnSync([hermes, "status"], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    if (!result.success) return { state: "unknown", problem: "Hermes 모델 상태를 확인하지 못했습니다." };
    return parseHermesRuntimeConfiguration(result.stdout?.toString() ?? "");
  } catch {
    return { state: "unknown", problem: "Hermes 모델 상태를 확인하지 못했습니다." };
  }
}

function versionParts(name: string): number[] {
  return (name.match(/^cs-ceo-v(.+)$/)?.[1] ?? "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(value => Number(value));
}

function compareVersionedDirectory(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference) return difference;
  }
  return right.localeCompare(left);
}

export function findCanonicalCsCeoSkill(root: string): string | null {
  const pluginsDir = join(root, "plugins");
  if (!existsSync(pluginsDir)) return null;
  try {
    const versions = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^cs-ceo-v\d/.test(entry.name))
      .map(entry => entry.name)
      .sort(compareVersionedDirectory);
    for (const version of versions) {
      const skillPath = join(pluginsDir, version, "skills", "cs-ceo", "SKILL.md");
      if (existsSync(skillPath) && statSync(skillPath).isFile()) return realpathSync(skillPath);
    }
  } catch {
    return null;
  }
  return null;
}

function canonicalRootCandidates(explicitRoot?: unknown): string[] {
  const explicit = typeof explicitRoot === "string" ? explicitRoot.trim() : "";
  const envRoot = process.env.AGENTSTOZ_CS_CEO_ROOT?.trim() ?? "";
  return [
    explicit,
    envRoot,
    join(dirname(process.cwd()), "myplugin_series", "CSnCompany_2-0"),
    join(homedir(), "product_2026", "myplugin_series", "CSnCompany_2-0"),
  ];
}

export function resolveCanonicalCsCeoRoot(explicitRoot?: unknown): { root: string; skillPath: string } | null {
  const seen = new Set<string>();
  for (const candidate of canonicalRootCandidates(explicitRoot)) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      const root = realpathSync(candidate);
      if (seen.has(root) || !statSync(root).isDirectory()) continue;
      seen.add(root);
      if (basename(root) !== "CSnCompany_2-0" || !existsSync(join(root, ".git"))) continue;
      const skillPath = findCanonicalCsCeoSkill(root);
      if (skillPath) return { root, skillPath };
    } catch {
      // A candidate may disappear while local repositories are being moved.
    }
  }
  return null;
}

export function inspectBuzzAgentBootstrap(input: {
  deviceName?: unknown;
  canonicalRoot?: unknown;
  scope?: BuzzAgentScope;
  project?: BuzzProjectAgentTarget | null;
  serviceMemory?: BuzzServiceMemoryTarget | null;
} = {}): BuzzAgentBootstrapInspection {
  const scope = input.scope ?? "global";
  const appPath = resolveBuzzAppPath();
  const canonical = scope === "global" ? resolveCanonicalCsCeoRoot(input.canonicalRoot) : null;
  const runtimes: BuzzAgentRuntimeInspection[] = ([
    ["codex", "Codex"],
    ["claude", "Claude Code"],
    ["hermes", "Hermes"],
  ] as const).map(([id, label]) => {
    const executablePath = runtimeExecutable(id);
    const configuration = executablePath ? runtimeConfiguration(id) : { state: "unknown" as const, problem: null };
    return {
      id,
      label,
      installed: executablePath !== null,
      executablePath,
      configurationState: configuration.state,
      configurationProblem: configuration.problem,
    };
  });
  const defaultRuntime = runtimes.find(runtime => runtime.id === "codex" && runtime.installed)?.id
    ?? runtimes.find(runtime => runtime.installed)?.id
    ?? "codex";
  const project = scope === "service" ? input.project ?? null : null;
  const serviceMemory = scope === "service" ? input.serviceMemory ?? null : null;
  const control: AgentsToZUseControlTarget | null = isAgentsToZControlProject(project)
    ? {
      endpoint: AGENTSTOZ_USE_CONTROL_ENDPOINT,
      controllerPortId: project!.projectId,
      actions: AGENTSTOZ_USE_ACTIONS,
      codexMcp: inspectAgentsToZUseCodexMcp(project!.projectId),
    }
    : null;
  const agentName = scope === "service"
    ? defaultBuzzServiceAgentName({
      projectName: project?.projectName,
      deviceName: input.deviceName,
      agentsToZControl: control !== null,
    })
    : defaultBuzzCsCeoAgentName(input.deviceName);
  const instructions = project && serviceMemory
    ? buildServiceBuzzAgentInstructions({
      deviceName: input.deviceName,
      project,
      serviceMemory,
      runtime: defaultRuntime,
      control,
    })
    : canonical
      ? buildGenericBuzzCsCeoInstructions({
        deviceName: input.deviceName,
        canonicalRoot: canonical.root,
        skillPath: canonical.skillPath,
        runtime: defaultRuntime,
      })
      : null;
  return {
    scope,
    ready: appPath !== null
      && runtimes.some(runtime => runtime.installed)
      && (scope === "service" ? project !== null && serviceMemory !== null : canonical !== null),
    appInstalled: appPath !== null,
    appPath,
    canonicalRoot: canonical?.root ?? null,
    skillPath: canonical?.skillPath ?? null,
    canonicalRootReady: canonical !== null,
    canonicalProblem: scope === "service" || canonical
      ? null
      : "Git 정본 CSnCompany_2-0 폴더와 plugins/cs-ceo-v*/skills/cs-ceo/SKILL.md를 찾지 못했습니다.",
    runtimes,
    defaultRuntime,
    agentName,
    instructions,
    project,
    serviceMemory,
    control,
    directCreateSupported: false,
    ownerApprovalRequired: true,
  };
}
