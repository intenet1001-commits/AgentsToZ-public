import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectBuzzAgentBootstrap,
  inspectAgentsToZUseCodexMcp,
  installAgentsToZUseCodexMcp,
  isAgentsToZControlProject,
  parseHermesRuntimeConfiguration,
} from "../buzz-agent-bootstrap-server";

function fakeExecutable(folder: string, name: string, body: string): string {
  mkdirSync(folder, {recursive: true});
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function withEnvironment<T>(values: Record<string, string>, work: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await work(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Buzz USE service agent bootstrap", () => {
  test("reports Hermes model readiness without exposing provider credentials", () => {
    expect(parseHermesRuntimeConfiguration("  Model:        (not set)\n  Provider: AWS Bedrock\n")).toEqual({
      state: "needs-model",
      problem: expect.stringContaining("기본 모델"),
    });
    expect(parseHermesRuntimeConfiguration("\u001b[32mModel: anthropic/claude-sonnet-4.6\u001b[0m\n")).toEqual({
      state: "ready",
      problem: null,
    });
  });

  test("detects the real AgentsToZ project shape before enabling USE control", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-use-control-project-"));
    const bin = join(root, "bin");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "AgentsToZ_byCS" }));
    writeFileSync(join(root, "api-server.ts"), "// marker\n");
    writeFileSync(join(root, "src", "App.tsx"), "// marker\n");
    const project = {
      projectId: "agentstoz-port",
      projectName: "AgentsToZ_byCS",
      canonicalPath: realpathSync(root),
      memoryId: "884575df-63c4-407c-8b43-860d1295e663",
    };
    const serviceMemory = {
      serviceMemoryId: "92323eab-f02a-5dcd-a8d4-c3ae0d513f1f",
      serviceKey: "default",
      displayName: "AgentsToZ USE",
      sourcePath: join(root, "use", "CORE.md"),
      configPath: join(root, "use", "config.json"),
    };
    const codex = fakeExecutable(bin, "codex", 'printf "{}\\n"');
    const claude = fakeExecutable(bin, "claude-agent-acp", "exit 0");
    const hermesAcp = fakeExecutable(bin, "hermes-acp", "exit 0");
    const hermes = fakeExecutable(bin, "hermes", 'printf "Model: fixture/model\\n"');
    try {
      expect(isAgentsToZControlProject(project)).toBe(true);
      const status = await withEnvironment({
        CODEX_CLI_PATH: codex,
        CLAUDE_AGENT_ACP_PATH: claude,
        HERMES_ACP_PATH: hermesAcp,
        HERMES_CLI_PATH: hermes,
      }, () => inspectBuzzAgentBootstrap({
        scope: "service",
        project,
        serviceMemory,
        deviceName: "Test Mac",
      }));
      expect(status.control).toMatchObject({ controllerPortId: project.projectId });
      expect(status.agentName).toBe("AgentsToZ USE · Test Mac");
      expect(status.instructions).toContain("/api/agentstoz-use/action");
    } finally { rmSync(root, {recursive: true, force: true}); }
  });

  test("shares only overlapping Hermes probes and stays responsive while the CLI waits", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-hermes-status-"));
    const bin = join(root, "bin");
    const log = join(root, "status.log");
    const hermes = fakeExecutable(bin, "hermes", `printf "called\\n" >> ${shellQuote(log)}\nsleep 0.3\nprintf "Model: fixture/model\\n"`);
    const hermesAcp = fakeExecutable(bin, "hermes-acp", "exit 0");
    const codex = fakeExecutable(bin, "codex", "exit 0");
    const claude = fakeExecutable(bin, "claude-agent-acp", "exit 0");
    try {
      await withEnvironment({
        HERMES_CLI_PATH: hermes, HERMES_ACP_PATH: hermesAcp,
        CODEX_CLI_PATH: codex, CLAUDE_AGENT_ACP_PATH: claude,
      }, async () => {
        const first = inspectBuzzAgentBootstrap();
        const second = inspectBuzzAgentBootstrap();
        const whileWaiting = await Promise.race([
          new Promise<string>(resolve => setTimeout(() => resolve("event-loop-responsive"), 20)),
          first.then(() => "status-already-finished"),
        ]);
        expect(whileWaiting).toBe("event-loop-responsive");
        const [one, two] = await Promise.all([first, second]);
        expect(one.runtimes.find(runtime => runtime.id === "hermes")?.configurationState).toBe("ready");
        expect(two.runtimes.find(runtime => runtime.id === "hermes")?.configurationState).toBe("ready");
        expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
        await inspectBuzzAgentBootstrap();
        expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
      });
    } finally { rmSync(root, {recursive: true, force: true}); }
  }, 10_000);

  test("runs Hermes status and Codex MCP inspection concurrently for a control project", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-control-status-parallel-"));
    const bin = join(root, "bin");
    const hermesStarted = join(root, "hermes.started");
    const codexStarted = join(root, "codex.started");
    const awaitPeer = (own: string, peer: string) => `: > ${shellQuote(own)}\ncount=0\nwhile [ ! -f ${shellQuote(peer)} ] && [ "$count" -lt 200 ]; do sleep 0.01; count=$((count + 1)); done\n[ -f ${shellQuote(peer)} ] || exit 7`;
    const hermes = fakeExecutable(bin, "hermes", `${awaitPeer(hermesStarted, codexStarted)}\nprintf "Model: fixture/model\\n"`);
    const codex = fakeExecutable(bin, "codex", `${awaitPeer(codexStarted, hermesStarted)}\nprintf '{"enabled":true}\\n'`);
    const hermesAcp = fakeExecutable(bin, "hermes-acp", "exit 0");
    const claude = fakeExecutable(bin, "claude-agent-acp", "exit 0");
    const mcp = fakeExecutable(bin, "agentstoz-use-mcp", "exit 0");
    mkdirSync(join(root, "src"), {recursive: true});
    writeFileSync(join(root, "package.json"), JSON.stringify({name: "AgentsToZ_byCS"}));
    writeFileSync(join(root, "api-server.ts"), "// marker\n");
    writeFileSync(join(root, "src", "App.tsx"), "// marker\n");
    try {
      await withEnvironment({
        HERMES_CLI_PATH: hermes, HERMES_ACP_PATH: hermesAcp,
        CODEX_CLI_PATH: codex, CLAUDE_AGENT_ACP_PATH: claude,
        AGENTSTOZ_USE_MCP_PATH: mcp,
      }, async () => {
        const status = await inspectBuzzAgentBootstrap({
          project: {
            projectId: "fixture-control",
            projectName: "AgentsToZ_byCS",
            canonicalPath: root,
            memoryId: "884575df-63c4-407c-8b43-860d1295e663",
          },
        });
        expect(status.runtimes.find(runtime => runtime.id === "hermes")?.configurationState).toBe("ready");
        expect(status.control?.codexMcp.installed).toBe(true);
      });
    } finally { rmSync(root, {recursive: true, force: true}); }
  }, 15_000);

  test("does not block the event loop while Codex MCP configuration is read", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-codex-mcp-status-"));
    const bin = join(root, "bin");
    const codex = fakeExecutable(bin, "codex", 'sleep 0.3\nprintf "{}\\n"');
    const mcp = fakeExecutable(bin, "agentstoz-use-mcp", "exit 0");
    try {
      await withEnvironment({CODEX_CLI_PATH: codex, AGENTSTOZ_USE_MCP_PATH: mcp}, async () => {
        const pending = inspectAgentsToZUseCodexMcp("fixture-controller");
        const whileWaiting = await Promise.race([
          new Promise<string>(resolve => setTimeout(() => resolve("event-loop-responsive"), 20)),
          pending.then(() => "status-already-finished"),
        ]);
        expect(whileWaiting).toBe("event-loop-responsive");
        expect((await pending).executablePath).not.toBeNull();
      });
    } finally { rmSync(root, {recursive: true, force: true}); }
  }, 10_000);

  test("coalesces concurrent Codex MCP reads without retaining a completed result", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-codex-mcp-reads-"));
    const bin = join(root, "bin");
    const log = join(root, "get.log");
    const codex = fakeExecutable(bin, "codex", `printf "get\\n" >> ${shellQuote(log)}\nsleep 0.3\nexit 1`);
    const mcp = fakeExecutable(bin, "agentstoz-use-mcp", "exit 0");
    try {
      await withEnvironment({CODEX_CLI_PATH: codex, AGENTSTOZ_USE_MCP_PATH: mcp}, async () => {
        const statuses = await Promise.all(Array.from({length: 16}, () => inspectAgentsToZUseCodexMcp("fixture-controller")));
        expect(statuses.every(status => !status.installed)).toBe(true);
        expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
        await inspectAgentsToZUseCodexMcp("fixture-controller");
        expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
      });
    } finally { rmSync(root, {recursive: true, force: true}); }
  }, 10_000);

  test("serializes synthetic Codex MCP installs and preserves the first controller binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-codex-mcp-install-"));
    const bin = join(root, "bin");
    const log = join(root, "commands.log");
    const config = join(root, "entry.json");
    const codex = fakeExecutable(bin, "codex", `
if [ "$1" = mcp ] && [ "$2" = get ]; then
  printf "get\\n" >> ${shellQuote(log)}
  sleep 0.2
  [ -f ${shellQuote(config)} ] || exit 1
  cat ${shellQuote(config)}
elif [ "$1" = mcp ] && [ "$2" = add ]; then
  printf "add\\n" >> ${shellQuote(log)}
  sleep 0.2
  for value in "$@"; do command="$value"; done
  printf '{"enabled":true,"transport":{"type":"stdio","command":"%s","env":{"AGENTSTOZ_CONTROLLER_PORT_ID":"controller-a"}}}\\n' "$command" > ${shellQuote(config)}
else
  exit 7
fi`);
    const mcp = fakeExecutable(bin, "agentstoz-use-mcp", "exit 0");
    try {
      await withEnvironment({CODEX_CLI_PATH: codex, AGENTSTOZ_USE_MCP_PATH: mcp}, async () => {
        const [first, second, otherController] = await Promise.all([
          installAgentsToZUseCodexMcp("controller-a"),
          installAgentsToZUseCodexMcp("controller-a"),
          installAgentsToZUseCodexMcp("controller-b").then(() => null, error => error),
        ]);
        expect([first.changed, second.changed]).toEqual([true, false]);
        expect(otherController).toMatchObject({
          code: "AGENTSTOZ_USE_CODEX_MCP_CONFLICT",
        });
        expect(readFileSync(log, "utf8").trim().split("\n").filter(line => line === "add")).toHaveLength(1);
        expect((await inspectAgentsToZUseCodexMcp("controller-a")).ready).toBe(true);
        expect((await inspectAgentsToZUseCodexMcp("controller-b")).ready).toBe(false);
      });
    } finally { rmSync(root, {recursive: true, force: true}); }
  }, 15_000);

  test("times out and reaps a hung Hermes status child without caching unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-hermes-timeout-"));
    const bin = join(root, "bin");
    const pidPath = join(root, "hermes.pid");
    const hermes = fakeExecutable(bin, "hermes", `printf "%s\\n" "$$" > ${shellQuote(pidPath)}\nsleep 30`);
    const hermesAcp = fakeExecutable(bin, "hermes-acp", "exit 0");
    const codex = fakeExecutable(bin, "codex", "exit 0");
    const claude = fakeExecutable(bin, "claude-agent-acp", "exit 0");
    try {
      await withEnvironment({
        HERMES_CLI_PATH: hermes, HERMES_ACP_PATH: hermesAcp,
        CODEX_CLI_PATH: codex, CLAUDE_AGENT_ACP_PATH: claude,
      }, async () => {
        const status = await inspectBuzzAgentBootstrap();
        expect(status.runtimes.find(runtime => runtime.id === "hermes")?.configurationState).toBe("unknown");
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally { rmSync(root, {recursive: true, force: true}); }
  }, 15_000);
});
