import { describe, expect, test } from "bun:test";
import {
  buildBuzzAgentSetupClipboard,
  buildGenericBuzzCsCeoInstructions,
  buildServiceBuzzAgentInstructions,
  defaultBuzzCsCeoAgentName,
  defaultBuzzServiceAgentName,
} from "../src/buzzAgentBootstrapContract";

describe("generic Buzz CS-CEO bootstrap contract", () => {
  test("uses one device-scoped reusable agent name", () => {
    expect(defaultBuzzCsCeoAgentName("Mac-CS1")).toBe("CS-CEO · Mac-CS1");
    expect(defaultBuzzCsCeoAgentName("  ")).toBe("CS-CEO · 이 단말");
    expect(defaultBuzzCsCeoAgentName("x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  test("points at the canonical CSnCompany root without binding a project memory", () => {
    const instructions = buildGenericBuzzCsCeoInstructions({
      deviceName: "Mac-CS1",
      canonicalRoot: "/Users/example/product_2026/myplugin_series/CSnCompany_2-0",
      skillPath: "/Users/example/product_2026/myplugin_series/CSnCompany_2-0/plugins/cs-ceo-v15/skills/cs-ceo/SKILL.md",
      runtime: "codex",
    });

    expect(instructions).toContain("reusable CS-CEO");
    expect(instructions).toContain("/Users/example/product_2026/myplugin_series/CSnCompany_2-0");
    expect(instructions).toContain("plugins/cs-ceo-v15/skills/cs-ceo/SKILL.md");
    expect(instructions).toContain("Codex");
    expect(instructions).toContain("explicit target project");
    expect(instructions).toContain("/api/project-memory/thread/status");
    expect(instructions).toContain("current channel UUID");
    expect(instructions).toContain("BUZZ_RELAY_URL");
    expect(instructions).not.toContain("memory ID");
    expect(instructions).not.toContain("BUZZ_PRIVATE_KEY");
    expect(instructions).not.toContain("90e60ca7-e624-4a9a-9c2a-e346715a9f46");
  });

  test("copies an honest owner-reviewed Buzz Desktop handoff", () => {
    const clipboard = buildBuzzAgentSetupClipboard({
      agentName: "CS-CEO · Mac-CS1",
      canonicalRoot: "/Users/example/CSnCompany_2-0",
      runtime: "codex",
      instructions: "generic instructions",
    });
    expect(clipboard).toContain("Buzz Desktop > Agents > New agent");
    expect(clipboard).toContain("Name: CS-CEO · Mac-CS1");
    expect(clipboard).toContain("Runtime: Codex");
    expect(clipboard).toContain("Bootstrap repository (system prompt absolute path): /Users/example/CSnCompany_2-0");
    expect(clipboard).not.toContain("Working directory:");
    expect(clipboard).toContain("최종 Create/Save는 소유자가 Buzz Desktop에서 검토 후 실행");
  });

  test("builds a USE service agent with a separate platform-independent memory", () => {
    const project = {
      projectId: "project-123",
      projectName: "Design Lab",
      canonicalPath: "/Users/example/projects/design-lab",
      memoryId: "884575df-63c4-407c-8b43-860d1295e663",
    };
    const serviceMemory = {
      serviceMemoryId: "20a41c23-3d92-5d3c-af5f-3dc55f8e45e1",
      serviceKey: "default",
      displayName: "Design Lab",
      sourcePath: "/Users/example/Library/Application Support/AgentsToZ/service-memories/20a41c23/CORE.md",
      configPath: "/Users/example/Library/Application Support/AgentsToZ/service-memories/20a41c23/config.json",
    };
    expect(defaultBuzzServiceAgentName({ projectName: project.projectName, deviceName: "Mac-CS1" }))
      .toBe("Design Lab · Mac-CS1");

    const instructions = buildServiceBuzzAgentInstructions({ deviceName: "Mac-CS1", project, serviceMemory, runtime: "claude" });
    expect(instructions).toContain("user-facing service agent for Design Lab");
    expect(instructions).toContain(project.canonicalPath);
    expect(instructions).toContain(project.memoryId);
    expect(instructions).toContain(serviceMemory.serviceMemoryId);
    expect(instructions).toContain(serviceMemory.sourcePath);
    expect(instructions).toContain("Do not directly edit the linked DEV project's source files");
    expect(instructions).toContain("DEV_HANDOFF");
    expect(instructions).toContain("creating another local project");
    expect(instructions).toContain("explicitly chooses private or public");
    expect(instructions).toContain("Buzz, Hermes, or Telegram");
    expect(instructions).not.toContain("remember-session");
    expect(instructions).not.toContain("BUZZ_PRIVATE_KEY");

    const clipboard = buildBuzzAgentSetupClipboard({
      agentName: "Design Lab · Mac-CS1",
      runtime: "claude",
      instructions,
      scope: "service",
      project,
      serviceMemory,
    });
    expect(clipboard).toContain(`Linked DEV project: ${project.canonicalPath}`);
    expect(clipboard).toContain(`DEV memory ID: ${project.memoryId}`);
    expect(clipboard).toContain(`USE service memory ID: ${serviceMemory.serviceMemoryId}`);
    expect(clipboard).toContain("Channel assignment: USE channels only");
    expect(clipboard).not.toContain("Bootstrap repository");
  });

  test("adds the bounded local control plane only to an AgentsToZ USE agent", () => {
    const project = {
      projectId: "agentstoz-port",
      projectName: "AgentsToZ_byCS",
      canonicalPath: "/Users/example/AgentsToZ_byCS",
      memoryId: "884575df-63c4-407c-8b43-860d1295e663",
    };
    const serviceMemory = {
      serviceMemoryId: "20a41c23-3d92-5d3c-af5f-3dc55f8e45e1",
      serviceKey: "default",
      displayName: "AgentsToZ USE",
      sourcePath: "/Users/example/service-memory/CORE.md",
      configPath: "/Users/example/service-memory/config.json",
    };
    const instructions = buildServiceBuzzAgentInstructions({
      deviceName: "Mac-CS1",
      project,
      serviceMemory,
      runtime: "codex",
      control: {
        endpoint: "http://127.0.0.1:3001/api/agentstoz-use/action",
        controllerPortId: project.projectId,
        actions: ["list-projects", "open-code-app"],
        codexMcp: {
          serverName: "agentstoz_use",
          executablePath: "/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp",
          installed: true,
          ready: true,
          problem: null,
        },
      },
    });
    expect(defaultBuzzServiceAgentName({
      projectName: project.projectName,
      deviceName: "Mac-CS1",
      agentsToZControl: true,
    })).toBe("AgentsToZ USE · Mac-CS1");
    expect(instructions).toContain("bounded conversational control surface");
    expect(instructions).toContain("Fixed controllerPortId: agentstoz-port");
    expect(instructions).toContain("Never provide a folder path, shell command");
    expect(instructions).toContain("agentstoz_use_list_projects");
    expect(instructions).toContain("agentstoz_use_connect_buzz_channel");
    expect(instructions).toContain("current channel UUID and channel name from the Buzz <context> block");
    expect(instructions).toContain("ask whether the user also wants a GitHub repository");
    expect(instructions).toContain("ask private or public before creation");
    expect(instructions).toContain("cannot deep-link to a channel");
  });
});
