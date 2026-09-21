import { describe, expect, test } from "bun:test";
import {
  buildBuzzAgentSetupClipboard,
  buildServiceBuzzAgentInstructions,
  defaultBuzzServiceAgentName,
} from "../src/buzzAgentBootstrapContract";

describe("Buzz USE service agent bootstrap contract", () => {
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
