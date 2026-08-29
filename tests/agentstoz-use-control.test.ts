import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectMemory } from "../project-memory-server";
import { resolveAppDataDir } from "../src/appDataDir";
import {
  AgentsToZUseControlError,
  agentsToZUseControlPromptLines,
  parseAgentsToZUseActionRequest,
} from "../src/agentstozUseControl";
import {
  AGENTSTOZ_USE_MCP_TOOLS,
  agentsToZUseMcpActionForTool,
  agentsToZUseMcpTimeoutMs,
  handleAgentsToZUseMcpRequest,
  resolveAgentsToZUseMcpEndpoint,
} from "../agentstoz-use-mcp-server";
import { startTestApiServer } from "./startTestApiServer";

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function post(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/agentstoz-use/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

async function fixture(options: { buzzAuthRequired?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agentstoz-use-api-")));
  roots.push(home);
  const controllerPath = join(home, "projects", "AgentsToZ_byCS");
  const targetPath = join(home, "projects", "study-finance");
  const newProjectPath = join(home, "projects", "한국어 프로젝트");
  const manualPath = join(home, "projects", "manual-channel-project");
  mkdirSync(join(controllerPath, "src"), { recursive: true });
  mkdirSync(targetPath, { recursive: true });
  mkdirSync(newProjectPath, { recursive: true });
  mkdirSync(manualPath, { recursive: true });
  writeFileSync(join(controllerPath, "package.json"), JSON.stringify({ name: "AgentsToZ_byCS" }));
  writeFileSync(join(controllerPath, "api-server.ts"), "// marker\n");
  writeFileSync(join(controllerPath, "src", "App.tsx"), "// marker\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: controllerPath });
  Bun.spawnSync(["git", "init", "-q"], { cwd: targetPath });
  Bun.spawnSync(["git", "init", "-q"], { cwd: newProjectPath });
  Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-q", "-m", "Initial"], { cwd: newProjectPath });
  const controllerMemory = initializeProjectMemory({ folderPath: controllerPath, projectName: "AgentsToZ_byCS", autoBackup: false });
  const targetMemory = initializeProjectMemory({ folderPath: targetPath, projectName: "Study Finance", autoBackup: false });
  initializeProjectMemory({ folderPath: newProjectPath, projectName: "한국어 프로젝트", autoBackup: false });
  const fakeGhPath = join(home, "fake-gh");
  writeFileSync(fakeGhPath, `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo "Logged in to github.com account test-owner"
  exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "create" ]; then
  repo_name="$3"
  shift 3
  source_path=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--source" ]; then source_path="$2"; shift 2; else shift; fi
  done
  git -C "$source_path" remote add origin "https://github.com/test-owner/$repo_name.git"
  exit $?
fi
exit 1
`);
  chmodSync(fakeGhPath, 0o755);
  const channelId = "11111111-1111-4111-8111-111111111111";
  const fakeBuzzPath = join(home, "fake-buzz");
  writeFileSync(fakeBuzzPath, `#!/bin/sh
if [ "$BUZZ_FAKE_AUTH_REQUIRED" = "1" ]; then
  echo '{"error":"auth_error","message":"BUZZ_PRIVATE_KEY is required"}' >&2
  exit 3
fi
if [ "$1" = "channels" ] && [ "$2" = "list" ]; then
  echo '{"channels":[{"channel_id":"${channelId}","name":"manual-project-dev"}]}'
  exit 0
fi
exit 1
`);
  chmodSync(fakeBuzzPath, 0o755);
  const apiEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    PORTMGR_GH_PATH: fakeGhPath,
    BUZZ_CLI_PATH: fakeBuzzPath,
    BUZZ_FAKE_AUTH_REQUIRED: options.buzzAuthRequired ? "1" : "0",
  };
  const appData = resolveAppDataDir(process.platform, apiEnv, home);
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(appData, "ports.json"), JSON.stringify([
    { id: "controller-id", name: "AgentsToZ_byCS", folderPath: controllerPath },
    {
      id: "study-id",
      name: "Study Finance",
      folderPath: targetPath,
      githubUrl: "https://github.com/example/study-finance",
    },
    { id: "new-id", name: "한국어 프로젝트", folderPath: newProjectPath },
    { id: "manual-id", name: "Manual Project", folderPath: manualPath },
  ]));
  writeFileSync(join(appData, "workspace-roots.json"), JSON.stringify([
    { id: "main-root", name: "Main workspace", path: join(home, "projects") },
  ]));
  const { baseUrl, child } = await startTestApiServer({
    cwd: join(import.meta.dir, ".."),
    env: apiEnv,
  });
  children.push(child);
  return { baseUrl, home, controllerMemory, targetMemory, manualPath, channelId };
}

describe("AgentsToZ USE action contract", () => {
  test("accepts only the bounded ID-based action schema", () => {
    expect(parseAgentsToZUseActionRequest({
      action: "open-code-app",
      controllerPortId: "controller-id",
      portId: "study-id",
      agent: "codex",
      folderPath: "/tmp/ignored",
      command: "rm -rf something",
    })).toEqual({
      action: "open-code-app",
      controllerPortId: "controller-id",
      portId: "study-id",
      agent: "codex",
      projectName: null,
      workspaceRootId: null,
      channelId: null,
      channelName: null,
      visibility: null,
      archiveMemory: false,
    });
    expect(() => parseAgentsToZUseActionRequest({
      action: "run-command",
      controllerPortId: "controller-id",
      command: "whoami",
    })).toThrow(AgentsToZUseControlError);
    expect(parseAgentsToZUseActionRequest({
      action: "create-github-repository",
      controllerPortId: "controller-id",
      portId: "study-id",
      visibility: "private",
      archiveMemory: true,
    }).archiveMemory).toBe(true);
    expect(() => parseAgentsToZUseActionRequest({
      action: "create-github-repository",
      controllerPortId: "controller-id",
      portId: "study-id",
      visibility: "public",
      archiveMemory: true,
    })).toThrow(/Private GitHub/);
  });

  test("teaches the agent to fail closed and never send paths, commands, or credentials", () => {
    const prompt = agentsToZUseControlPromptLines({ controllerPortId: "controller-id" }).join("\n");
    expect(prompt).toContain("agentstoz_use_list_projects");
    expect(prompt).toContain("agentstoz_use_open_code_app");
    expect(prompt).toContain("agentstoz_use_open_buzz_dev");
    expect(prompt).toContain("agentstoz_use_create_project");
    expect(prompt).toContain("agentstoz_use_connect_buzz_channel");
    expect(prompt).toContain("DEV_HANDOFF is only for changing the AgentsToZ product itself");
    expect(prompt).toContain("explicitly chooses private or public");
    expect(prompt).toContain("separately ask whether verified long-term memory");
    expect(prompt).toContain("Public repositories can never receive this memory archive");
    expect(prompt).toContain("Never provide a folder path, shell command, URL, private key, token");
    expect(prompt).toContain("Do not call the local endpoint through curl");
    expect(prompt).toContain("cannot deep-link to a channel");
    expect(prompt).not.toContain("BUZZ_PRIVATE_KEY");
  });
});

describe("AgentsToZ USE local action API", () => {
  test("lists and inspects registered projects without returning local paths", async () => {
    const { baseUrl, controllerMemory, targetMemory } = await fixture();
    const listed = await post(baseUrl, { action: "list-projects", controllerPortId: "controller-id" });
    expect(listed.response.status).toBe(200);
    expect(listed.body).toMatchObject({ success: true, performed: true, effect: "read-only" });
    expect(listed.body.projectCount).toBe(4);
    expect(listed.body.projects).toHaveLength(4);
    expect(JSON.stringify(listed.body)).not.toContain("folderPath");
    expect(JSON.stringify(listed.body)).not.toContain("canonicalPath");
    expect(listed.body.projects.find((project: any) => project.projectId === "controller-id").memoryId)
      .toBe(controllerMemory.config!.memoryId);
    expect(listed.body.projects.find((project: any) => project.projectId === "manual-id")).toMatchObject({
      memoryId: null,
      memory: { initialized: false },
    });

    const status = await post(baseUrl, {
      action: "project-status",
      controllerPortId: "controller-id",
      portId: "study-id",
    });
    expect(status.response.status).toBe(200);
    expect(status.body.project).toMatchObject({
      projectId: "study-id",
      memoryId: targetMemory.config!.memoryId,
      github: { connected: true, urls: ["https://github.com/example/study-finance"] },
      buzzDev: { connected: false },
    });
  }, 30_000);

  test("connects a verified current Buzz channel and initializes missing DEV memory", async () => {
    const { baseUrl, manualPath, channelId } = await fixture();
    const invalid = await post(baseUrl, {
      action: "connect-buzz-channel",
      controllerPortId: "controller-id",
      portId: "manual-id",
      channelId: "not-a-channel",
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.code).toBe("AGENTSTOZ_USE_BUZZ_CHANNEL_ID_INVALID");

    const unknown = await post(baseUrl, {
      action: "connect-buzz-channel",
      controllerPortId: "controller-id",
      portId: "manual-id",
      channelId: "22222222-2222-4222-8222-222222222222",
    });
    expect(unknown.response.status).toBe(404);
    expect(unknown.body.code).toBe("BUZZ_CHANNEL_NOT_FOUND");
    expect(await Bun.file(join(manualPath, ".agent-memory", "config.json")).exists()).toBe(false);

    const connected = await post(baseUrl, {
      action: "connect-buzz-channel",
      controllerPortId: "controller-id",
      portId: "manual-id",
      channelId,
      channelName: "manual-project-dev",
      relayUrl: "wss://attacker.example",
      allowUnverified: true,
    });
    expect(connected.response.status).toBe(201);
    expect(connected.body).toMatchObject({
      success: true,
      performed: true,
      effect: "connected-buzz-channel",
      connection: {
        projectId: "manual-id",
        memory: { initialized: true, createdNow: true },
        channel: { channelId, channelName: "manual-project-dev", verified: true },
      },
    });
    expect(JSON.stringify(connected.body)).not.toContain(manualPath);
    expect(JSON.stringify(connected.body)).not.toContain("attacker.example");
    expect(Bun.file(join(manualPath, ".agent-memory", "config.json")).size).toBeGreaterThan(0);

    const status = await post(baseUrl, {
      action: "project-status",
      controllerPortId: "controller-id",
      portId: "manual-id",
    });
    expect(status.body.project).toMatchObject({
      projectId: "manual-id",
      memory: { initialized: true },
      buzzDev: { connected: true, channelId, channelName: "manual-project-dev", verified: true },
    });
  }, 30_000);

  test("accepts an explicit current-channel context when CLI authentication is unavailable", async () => {
    const { baseUrl, channelId } = await fixture({ buzzAuthRequired: true });
    const connected = await post(baseUrl, {
      action: "connect-buzz-channel",
      controllerPortId: "controller-id",
      portId: "manual-id",
      channelId,
      channelName: "manual-project-dev",
    });
    expect(connected.response.status).toBe(201);
    expect(connected.body.connection).toMatchObject({
      projectId: "manual-id",
      memory: { initialized: true, createdNow: true },
      channel: {
        channelId,
        channelName: "manual-project-dev",
        verified: false,
        verificationProblem: { code: "BUZZ_CLI_AUTH_REQUIRED" },
      },
    });
  }, 30_000);

  test("creates a GitHub repository only for a registered project with explicit visibility", async () => {
    const { baseUrl, home } = await fixture();
    const missingVisibility = await post(baseUrl, {
      action: "create-github-repository",
      controllerPortId: "controller-id",
      portId: "new-id",
    });
    expect(missingVisibility.response.status).toBe(400);
    expect(missingVisibility.body.code).toBe("AGENTSTOZ_USE_GITHUB_VISIBILITY_REQUIRED");

    const created = await post(baseUrl, {
      action: "create-github-repository",
      controllerPortId: "controller-id",
      portId: "new-id",
      visibility: "private",
      archiveMemory: true,
      folderPath: "/tmp/ignored",
      repositoryName: "ignored-name",
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      success: true,
      performed: true,
      effect: "created-github-repository",
      repository: {
        projectId: "new-id",
        repositoryName: "project-newid",
        repositoryUrl: "https://github.com/test-owner/project-newid",
        visibility: "private",
        pushed: true,
        registrationUpdated: true,
      },
      memoryArchive: {
        requested: true,
        enabled: false,
      },
    });
    const createdJson = JSON.stringify(created.body);
    expect(createdJson).not.toContain("folderPath");
    expect(createdJson).not.toContain("/tmp/ignored");
    expect(createdJson).not.toContain("stagingPath");
    expect(createdJson).not.toContain(home);

    const status = await post(baseUrl, {
      action: "project-status",
      controllerPortId: "controller-id",
      portId: "new-id",
    });
    expect(status.body.project.github).toEqual({
      connected: true,
      urls: ["https://github.com/test-owner/project-newid"],
    });
  }, 30_000);

  test("lists path-free workspace choices and creates a registered project with app defaults", async () => {
    const { baseUrl } = await fixture();
    const listed = await post(baseUrl, {
      action: "list-workspace-roots",
      controllerPortId: "controller-id",
    });
    expect(listed.response.status).toBe(200);
    expect(listed.body).toMatchObject({
      success: true,
      performed: true,
      workspaceRoots: [{ workspaceRootId: "main-root", name: "Main workspace" }],
    });
    expect(JSON.stringify(listed.body)).not.toContain("projects/");

    const created = await post(baseUrl, {
      action: "create-project",
      controllerPortId: "controller-id",
      projectName: "새 프로젝트",
      workspaceRootId: "main-root",
      folderPath: "/tmp/ignored",
      command: "touch ignored",
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      success: true,
      performed: true,
      effect: "created-local-project",
      project: {
        projectName: "새-프로젝트",
        workspaceRoot: { workspaceRootId: "main-root", name: "Main workspace" },
        git: { initialized: true, initialCommitCreated: true },
        memory: { initialized: true },
      },
    });
    expect(JSON.stringify(created.body)).not.toContain("folderPath");
    expect(JSON.stringify(created.body)).not.toContain("/tmp/");

    const projects = await post(baseUrl, { action: "list-projects", controllerPortId: "controller-id" });
    expect(projects.body.projects.some((project: any) => project.projectId === created.body.project.projectId)).toBe(true);
  }, 30_000);

  test("rejects a non-AgentsToZ controller, arbitrary actions, and remote origins", async () => {
    const { baseUrl } = await fixture();
    const wrongController = await post(baseUrl, { action: "list-projects", controllerPortId: "study-id" });
    expect(wrongController.response.status).toBe(403);
    expect(wrongController.body.code).toBe("AGENTSTOZ_USE_CONTROLLER_MISMATCH");

    const arbitrary = await post(baseUrl, {
      action: "run-command",
      controllerPortId: "controller-id",
      command: "whoami",
    });
    expect(arbitrary.response.status).toBe(400);
    expect(arbitrary.body.code).toBe("AGENTSTOZ_USE_ACTION_NOT_ALLOWED");

    const malformed = await fetch(`${baseUrl}/api/agentstoz-use/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).code).toBe("AGENTSTOZ_USE_REQUEST_INVALID");

    const noBinding = await post(baseUrl, {
      action: "open-buzz-dev",
      controllerPortId: "controller-id",
      portId: "study-id",
    });
    expect(noBinding.response.status).toBe(409);
    expect(noBinding.body.code).toBe("AGENTSTOZ_USE_BUZZ_DEV_NOT_CONNECTED");

    const denied = await post(baseUrl, {
      action: "list-projects",
      controllerPortId: "controller-id",
    }, { Origin: "https://attacker.example" });
    expect(denied.response.status).toBe(403);
    expect(denied.body.code).toBe("LOCAL_API_ORIGIN_DENIED");
  }, 30_000);
});

describe("AgentsToZ USE Codex MCP bridge", () => {
  test("exposes only the nine bounded tools and maps IDs server-side", async () => {
    expect(AGENTSTOZ_USE_MCP_TOOLS.map(tool => tool.name)).toEqual([
      "agentstoz_use_list_projects",
      "agentstoz_use_list_workspace_roots",
      "agentstoz_use_create_project",
      "agentstoz_use_connect_buzz_channel",
      "agentstoz_use_create_github_repository",
      "agentstoz_use_project_status",
      "agentstoz_use_open_dashboard",
      "agentstoz_use_open_code_app",
      "agentstoz_use_open_buzz_dev",
    ]);
    expect(agentsToZUseMcpActionForTool("agentstoz_use_open_code_app", {
      portId: "study-id",
      agent: "codex",
      folderPath: "/tmp/ignored",
      command: "whoami",
    }, "controller-id")).toEqual({
      action: "open-code-app",
      controllerPortId: "controller-id",
      portId: "study-id",
      agent: "codex",
    });
    expect(() => agentsToZUseMcpActionForTool("run_command", { command: "whoami" }, "controller-id"))
      .toThrow("Unknown AgentsToZ USE tool");

    expect(agentsToZUseMcpActionForTool("agentstoz_use_create_project", {
      projectName: "새 프로젝트",
      workspaceRootId: "main-root",
      folderPath: "/tmp/ignored",
    }, "controller-id")).toEqual({
      action: "create-project",
      controllerPortId: "controller-id",
      projectName: "새 프로젝트",
      workspaceRootId: "main-root",
    });

    expect(agentsToZUseMcpActionForTool("agentstoz_use_create_github_repository", {
      portId: "new-id",
      visibility: "public",
      folderPath: "/tmp/ignored",
      repositoryName: "ignored",
    }, "controller-id")).toEqual({
      action: "create-github-repository",
      controllerPortId: "controller-id",
      portId: "new-id",
      visibility: "public",
    });

    expect(agentsToZUseMcpActionForTool("agentstoz_use_create_github_repository", {
      portId: "new-id",
      visibility: "private",
      archiveMemory: true,
    }, "controller-id")).toEqual({
      action: "create-github-repository",
      controllerPortId: "controller-id",
      portId: "new-id",
      visibility: "private",
      archiveMemory: true,
    });
    expect(() => agentsToZUseMcpActionForTool("agentstoz_use_create_github_repository", {
      portId: "new-id",
      visibility: "public",
      archiveMemory: true,
    }, "controller-id")).toThrow(/only for private/);
    expect(agentsToZUseMcpTimeoutMs({ action: "create-github-repository", archiveMemory: true })).toBe(600_000);
    expect(agentsToZUseMcpTimeoutMs({ action: "create-github-repository" })).toBe(150_000);

    expect(agentsToZUseMcpActionForTool("agentstoz_use_connect_buzz_channel", {
      portId: "manual-id",
      channelId: "11111111-1111-4111-8111-111111111111",
      channelName: "manual-project-dev",
      relayUrl: "wss://attacker.example",
    }, "controller-id")).toEqual({
      action: "connect-buzz-channel",
      controllerPortId: "controller-id",
      portId: "manual-id",
      channelId: "11111111-1111-4111-8111-111111111111",
      channelName: "manual-project-dev",
    });

    const listed = await handleAgentsToZUseMcpRequest({ id: 1, method: "tools/list" });
    expect((listed as any).result.tools).toHaveLength(9);
  });

  test("accepts only a credential-free loopback endpoint and returns structured API results", async () => {
    expect(() => resolveAgentsToZUseMcpEndpoint({
      AGENTSTOZ_USE_ENDPOINT: "https://example.com/api/agentstoz-use/action",
    })).toThrow("loopback control endpoint");
    expect(() => resolveAgentsToZUseMcpEndpoint({
      AGENTSTOZ_USE_ENDPOINT: "http://user:secret@127.0.0.1:3001/api/agentstoz-use/action",
    })).toThrow("loopback control endpoint");

    const { baseUrl } = await fixture();
    const result = await handleAgentsToZUseMcpRequest({
      id: 2,
      method: "tools/call",
      params: { name: "agentstoz_use_list_projects", arguments: {} },
    }, {
      AGENTSTOZ_CONTROLLER_PORT_ID: "controller-id",
      AGENTSTOZ_USE_ENDPOINT: `${baseUrl}/api/agentstoz-use/action`,
    }) as any;
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent).toMatchObject({
      success: true,
      performed: true,
      projectCount: 4,
    });
    expect(JSON.stringify(result)).not.toContain("folderPath");
  }, 30_000);
});
