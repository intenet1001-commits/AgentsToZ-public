import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findCanonicalCsCeoSkill,
  inspectBuzzAgentBootstrap,
  isAgentsToZControlProject,
  parseHermesRuntimeConfiguration,
  resolveCanonicalCsCeoRoot,
} from "../buzz-agent-bootstrap-server";

function temporaryCanonicalRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "buzz-cs-ceo-root-"));
  const root = join(parent, "CSnCompany_2-0");
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const version of ["cs-ceo-v14", "cs-ceo-v15"]) {
    const skillDir = join(root, "plugins", version, "skills", "cs-ceo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${version}\n`);
  }
  return realpathSync(root);
}

describe("Buzz generic CS-CEO canonical root discovery", () => {
  test("requires a Git root and chooses the newest canonical skill", () => {
    const root = temporaryCanonicalRoot();
    expect(findCanonicalCsCeoSkill(root)).toBe(join(root, "plugins", "cs-ceo-v15", "skills", "cs-ceo", "SKILL.md"));
    expect(resolveCanonicalCsCeoRoot(root)).toEqual({
      root,
      skillPath: join(root, "plugins", "cs-ceo-v15", "skills", "cs-ceo", "SKILL.md"),
    });
  });

  test("does not mistake a plugin cache leaf for the canonical repository", () => {
    const parent = mkdtempSync(join(tmpdir(), "buzz-cs-ceo-cache-"));
    const cacheLeaf = join(parent, "cs-ceo-v15");
    const skillDir = join(cacheLeaf, "plugins", "cs-ceo-v15", "skills", "cs-ceo");
    mkdirSync(join(cacheLeaf, ".git"), { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# cache\n");
    expect(resolveCanonicalCsCeoRoot(cacheLeaf)).not.toEqual(expect.objectContaining({ root: cacheLeaf }));
  });

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

  test("detects the real AgentsToZ project shape before enabling USE control", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-use-control-project-"));
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
    expect(isAgentsToZControlProject(project)).toBe(true);
    const status = inspectBuzzAgentBootstrap({
      scope: "service",
      project,
      serviceMemory,
      deviceName: "Test Mac",
    });
    expect(status.control).toMatchObject({ controllerPortId: project.projectId });
    expect(status.agentName).toBe("AgentsToZ USE · Test Mac");
    expect(status.instructions).toContain("/api/agentstoz-use/action");
  });
});
