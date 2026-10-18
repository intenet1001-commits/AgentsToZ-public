import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { agentsToZUseMcpConfiguredCommand } from "./src/agentsToZUseMcpLauncher";
import { dirname, isAbsolute, join } from "node:path";
import {
  buildServiceBuzzAgentInstructions,
  defaultBuzzServiceAgentName,
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
import { agentsToZUseCodexMcpAddArgv, classifyAgentsToZUseCodexMcpEntry } from "./src/agentstozUseCodexMcpEntry";
import { readControlProfileAccess } from "./src/controlProfileStore";
import { resolveAppDataDirFromEnvironment } from "./src/appDataDir";
import { runWithTimeout } from "./project-memory-server";

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

const BOOTSTRAP_COMMAND_OUTPUT_LIMIT = 64 * 1024;

async function bootstrapCommand(command: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Use the existing contained process runner: it drains bounded output and
  // reaps the child (and its helpers) before returning from a timeout.
  // spawnSync previously inherited the API server's cwd; keep the CLI's
  // project-local configuration lookup unchanged.
  return runWithTimeout(command, process.cwd(), timeoutMs, undefined, { maxOutputBytes: BOOTSTRAP_COMMAND_OUTPUT_LIMIT });
}

async function commandLookup(name: string): Promise<string | null> {
  try {
    const result = await bootstrapCommand(
      process.platform === "win32" ? ["where", name] : ["/usr/bin/which", name],
      3_000,
    );
    if (result.exitCode !== 0) return null;
    return existingFile(result.stdout.split(/\r?\n/).map(value => value.trim()));
  } catch {
    return null;
  }
}

async function runtimeExecutable(id: BuzzAgentRuntime): Promise<string | null> {
  const home = homedir();
  if (id === "codex") {
    return existingFile([
      process.env.CODEX_CLI_PATH ?? "",
      join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ]) ?? await commandLookup("codex");
  }
  if (id === "claude") {
    return existingFile([
      process.env.CLAUDE_AGENT_ACP_PATH ?? "",
      join(home, ".local", "bin", "claude-agent-acp"),
      "/opt/homebrew/bin/claude-agent-acp",
      "/usr/local/bin/claude-agent-acp",
    ]) ?? await commandLookup("claude-agent-acp");
  }
  return existingFile([
    process.env.HERMES_ACP_PATH ?? "",
    join(home, ".local", "bin", "hermes-acp"),
    "/opt/homebrew/bin/hermes-acp",
    "/usr/local/bin/hermes-acp",
  ]) ?? await commandLookup("hermes-acp");
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

const codexMcpConfigFlights = new Map<string, Promise<Record<string, unknown> | null>>();
let codexMcpMutationTail: Promise<void> = Promise.resolve();
let codexMcpConfigGeneration = 0;

async function readCodexMcpConfig(codex: string): Promise<Record<string, unknown> | null> {
  const key = JSON.stringify([
    codex, process.cwd(), process.env.HOME ?? homedir(),
    process.env.CODEX_HOME ?? "", process.env.XDG_CONFIG_HOME ?? "", codexMcpConfigGeneration,
  ]);
  const inFlight = codexMcpConfigFlights.get(key);
  if (inFlight) return inFlight;
  // Share only an active CLI read. A completed result must never hide a user
  // change to the global Codex MCP entry from the next Refresh.
  const task = (async (): Promise<Record<string, unknown> | null> => {
    try {
      const result = await bootstrapCommand([codex, "mcp", "get", AGENTSTOZ_USE_MCP_SERVER_NAME, "--json"], 5_000);
      if (result.exitCode !== 0) return null;
      const parsed = JSON.parse(result.stdout);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  codexMcpConfigFlights.set(key, task);
  void task.finally(() => {
    if (codexMcpConfigFlights.get(key) === task) codexMcpConfigFlights.delete(key);
  });
  return task;
}

async function inspectAgentsToZUseCodexMcpNow(
  controllerPortId: string,
  codexExecutable: Promise<string | null> = runtimeExecutable("codex"),
): Promise<CodexMcpInspection> {
  const bundledPath = resolveAgentsToZUseMcpExecutable();
  // ⚠️ OPS 프로필 설치기와 **같은 답**을 써야 한다 — 한쪽이 런처를 적고 다른 쪽이 번들을 기대하면
  // 상대가 쓴 항목을 「충돌」로 판정한다. 판정은 `agentsToZUseMcpConfiguredCommand` 한 곳이다.
  const executablePath = agentsToZUseMcpConfiguredCommand(homedir(), bundledPath, (path: string) => existsSync(path));
  const codex = await codexExecutable;
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
  const config = await readCodexMcpConfig(codex);
  if (!config) {
    return {
      serverName: AGENTSTOZ_USE_MCP_SERVER_NAME,
      executablePath,
      installed: false,
      ready: false,
      problem: "Codex에 AgentsToZ 제한형 제어 도구를 연결해야 합니다.",
    };
  }
  // Shared with the OPS profile installer so neither calls the other's entry a conflict.
  const verdict = classifyAgentsToZUseCodexMcpEntry(config, {
    executable: executablePath,
    bundledExecutable: bundledPath,
    controllerPortId,
    profileAvailable: agentsToZUseProfileReadable(),
  });
  const ready = verdict === "ready";
  return {
    serverName: AGENTSTOZ_USE_MCP_SERVER_NAME,
    executablePath,
    // A disabled entry is not "installed": the installer may re-add it, as before.
    installed: config.enabled !== false,
    ready,
    problem: ready ? null
      : verdict === "needs-controller"
        ? "Codex에 AgentsToZ 제어 도구는 연결돼 있지만 이 앱의 프로필 연결이 없습니다. OPS 프로필을 먼저 연결하세요."
        : "기존 agentstoz_use MCP 설정이 이 앱 또는 프로젝트와 일치하지 않습니다. 기존 설정을 확인한 뒤 다시 연결하세요.",
  };
}

export async function inspectAgentsToZUseCodexMcp(
  controllerPortId: string,
  codexExecutable: Promise<string | null> = runtimeExecutable("codex"),
): Promise<CodexMcpInspection> {
  // Status callers see the result after every queued global config mutation;
  // the installer uses inspectNow inside its own queue slot to avoid deadlock.
  await codexMcpMutationTail;
  return inspectAgentsToZUseCodexMcpNow(controllerPortId, codexExecutable);
}

/** Mirrors the MCP server's own profile lookup (agentstoz-use-mcp-server.ts profileAccess). */
function agentsToZUseProfileReadable(): boolean {
  try {
    return readControlProfileAccess(resolveAppDataDirFromEnvironment(process.platform, process.env, process.env.HOME ?? homedir())) !== null;
  } catch {
    return false;
  }
}

async function installAgentsToZUseCodexMcpNow(controllerPortId: string): Promise<CodexMcpInspection & { changed: boolean }> {
  // This preflight runs after the previous install has completed. A different
  // controller's entry is therefore observed as a conflict, never overwritten.
  const current = await inspectAgentsToZUseCodexMcpNow(controllerPortId);
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
  const codex = await runtimeExecutable("codex");
  if (!codex) throw new AgentsToZUseControlError(
    "Codex CLI를 찾지 못했습니다.",
    "AGENTSTOZ_USE_CODEX_NOT_AVAILABLE",
    409,
  );
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    // Do not let the verification read join a status probe that began before
    // the write, even if that probe's child is still draining.
    codexMcpConfigGeneration++;
    result = await bootstrapCommand(agentsToZUseCodexMcpAddArgv(codex, current.executablePath, controllerPortId), 10_000);
  } catch {
    throw new AgentsToZUseControlError(
      "Codex MCP 설정을 저장하지 못했습니다.",
      "AGENTSTOZ_USE_CODEX_MCP_INSTALL_FAILED",
      500,
    );
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new AgentsToZUseControlError(
      detail || "Codex MCP 설정을 저장하지 못했습니다.",
      "AGENTSTOZ_USE_CODEX_MCP_INSTALL_FAILED",
      500,
    );
  }
  codexMcpConfigGeneration++;
  const installed = await inspectAgentsToZUseCodexMcpNow(controllerPortId);
  if (!installed.ready) throw new AgentsToZUseControlError(
    installed.problem ?? "Codex MCP 연결 확인에 실패했습니다.",
    "AGENTSTOZ_USE_CODEX_MCP_VERIFY_FAILED",
    500,
  );
  return { ...installed, changed: true };
}

export function installAgentsToZUseCodexMcp(controllerPortId: string): Promise<CodexMcpInspection & { changed: boolean }> {
  // Codex stores one global agentstoz_use entry. Serialize the whole
  // inspect/add/verify transaction across controller projects in this server.
  const result = codexMcpMutationTail.then(() => installAgentsToZUseCodexMcpNow(controllerPortId));
  codexMcpMutationTail = result.then(() => undefined, () => undefined);
  return result;
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

type RuntimeConfiguration = {
  state: "ready" | "needs-model" | "unknown";
  problem: string | null;
};

// Coalesce overlapping status requests from multiple setup windows. Never keep
// a completed result: a user changing the Hermes model expects Refresh to read it.
const hermesStatusFlights = new Map<string, Promise<RuntimeConfiguration>>();

async function runtimeConfiguration(id: BuzzAgentRuntime): Promise<RuntimeConfiguration> {
  if (id !== "hermes") return { state: "unknown", problem: null };
  const home = homedir();
  const hermes = existingFile([
    process.env.HERMES_CLI_PATH ?? "",
    join(home, ".local", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ]) ?? await commandLookup("hermes");
  if (!hermes) return { state: "unknown", problem: "Hermes CLI 상태를 확인하지 못했습니다." };
  const key = JSON.stringify([hermes, home, process.env.HERMES_HOME ?? ""]);
  const inFlight = hermesStatusFlights.get(key);
  if (inFlight) return inFlight;
  const task = (async (): Promise<RuntimeConfiguration> => {
    try {
      const result = await bootstrapCommand([hermes, "status"], 5_000);
      if (result.exitCode !== 0) return { state: "unknown", problem: "Hermes 모델 상태를 확인하지 못했습니다." };
      return parseHermesRuntimeConfiguration(result.stdout);
    } catch {
      return { state: "unknown", problem: "Hermes 모델 상태를 확인하지 못했습니다." };
    }
  })();
  hermesStatusFlights.set(key, task);
  void task.finally(() => {
    if (hermesStatusFlights.get(key) === task) hermesStatusFlights.delete(key);
  });
  return task;
}

export async function inspectBuzzAgentBootstrap(input: {
  deviceName?: unknown;
  scope?: "service";
  project?: BuzzProjectAgentTarget | null;
  serviceMemory?: BuzzServiceMemoryTarget | null;
} = {}): Promise<BuzzAgentBootstrapInspection> {
  const scope = "service";
  const appPath = resolveBuzzAppPath();
  const project = input.project ?? null;
  const serviceMemory = input.serviceMemory ?? null;
  const controlProject = isAgentsToZControlProject(project);
  const codexExecutable = runtimeExecutable("codex");
  const codexMcp = controlProject
    ? inspectAgentsToZUseCodexMcp(project!.projectId, codexExecutable)
    : null;
  const runtimes: BuzzAgentRuntimeInspection[] = await Promise.all(([
    ["codex", "Codex"],
    ["claude", "Claude Code"],
    ["hermes", "Hermes"],
  ] as const).map(async ([id, label]) => {
    const executablePath = await (id === "codex" ? codexExecutable : runtimeExecutable(id));
    const configuration = executablePath ? await runtimeConfiguration(id) : { state: "unknown" as const, problem: null };
    return {
      id,
      label,
      installed: executablePath !== null,
      executablePath,
      configurationState: configuration.state,
      configurationProblem: configuration.problem,
    };
  }));
  const defaultRuntime = runtimes.find(runtime => runtime.id === "codex" && runtime.installed)?.id
    ?? runtimes.find(runtime => runtime.installed)?.id
    ?? "codex";
  const control: AgentsToZUseControlTarget | null = controlProject
    ? {
      endpoint: AGENTSTOZ_USE_CONTROL_ENDPOINT,
      controllerPortId: project!.projectId,
      actions: AGENTSTOZ_USE_ACTIONS,
      codexMcp: await codexMcp!,
    }
    : null;
  const agentName = defaultBuzzServiceAgentName({
      projectName: project?.projectName,
      deviceName: input.deviceName,
      agentsToZControl: control !== null,
    });
  const instructions = project && serviceMemory
    ? buildServiceBuzzAgentInstructions({
      deviceName: input.deviceName,
      project,
      serviceMemory,
      runtime: defaultRuntime,
      control,
    })
    : null;
  return {
    scope,
    ready: appPath !== null
      && runtimes.some(runtime => runtime.installed)
      && project !== null && serviceMemory !== null,
    appInstalled: appPath !== null,
    appPath,
    canonicalRoot: null,
    skillPath: null,
    canonicalRootReady: false,
    canonicalProblem: null,
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
