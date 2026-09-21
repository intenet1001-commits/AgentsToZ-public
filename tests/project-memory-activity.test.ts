import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProjectMemory,
  initializeProjectMemory,
  markProjectMemoryRemembered,
} from "../project-memory-server";
import { CURRENT_PROJECT_MEMORY_VERSION } from "../src/projectMemoryVersion";
import { directorySymlinkType } from "./fs-test-capabilities";

setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
}

function configuredHookCommand(root: string, agent: "claude" | "codex" = "codex"): string {
  const hookConfig = JSON.parse(readFileSync(
    join(root, agent === "codex" ? ".codex/hooks.json" : ".claude/settings.json"),
    "utf8",
  ));
  const command = hookConfig.hooks.UserPromptSubmit
    .flatMap((entry: any) => entry.hooks ?? [])
    .map((handler: any) => handler.command)
    .find((candidate: unknown) => typeof candidate === "string" && candidate.includes("AGENTSTOZ_PROJECT_MEMORY_ACTIVITY"));
  if (typeof command === "string") return command;

  const encodedCommand = hookConfig.hooks.UserPromptSubmit
    .flatMap((entry: any) => entry.hooks ?? [])
    .map((handler: any) => handler.command)
    .find((candidate: unknown) => typeof candidate === "string" && candidate.includes("-EncodedCommand"));
  if (typeof encodedCommand !== "string") throw new Error("generated project-memory hook command missing");
  return encodedCommand;
}

function runConfiguredHook(root: string, cwd: string, agent: "claude" | "codex" = "codex", stdin = "") {
  const command = configuredHookCommand(root, agent);
  const argv = process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-c", command];
  return Bun.spawnSync(argv, {
    cwd,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("project-memory token-free activity detection", () => {
  let root = "";
  let linkedRoot = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agentstoz-memory-activity-"));
    linkedRoot = `${root}-linked`;
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "AgentsToZ Test");
    writeFileSync(join(root, "app.txt"), "initial\n");
    git(root, "add", "app.txt");
    git(root, "commit", "-m", "initial");
    initializeProjectMemory({
      folderPath: root,
      projectName: "activity-test",
      agent: "codex",
      autoBackup: false,
    });
  });

  afterAll(() => {
    if (linkedRoot) rmSync(linkedRoot, { recursive: true, force: true });
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("initialization establishes a quiet baseline and installs both prompt hooks", () => {
    const status = detectProjectMemory(root);
    expect(CURRENT_PROJECT_MEMORY_VERSION).toBeGreaterThanOrEqual(16);
    expect(status.activity.needsRemember).toBe(false);
    expect(status.activity.hooks).toEqual({ claude: true, codex: true });
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain("UserPromptSubmit");
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toContain("UserPromptSubmit");
    for (const path of [
      join(root, "CLAUDE.md"),
      join(root, "AGENTS.md"),
      join(root, ".agents/rules/agentstoz-output-style.md"),
    ]) {
      const instructions = readFileSync(path, "utf8");
      expect(instructions).toContain("AgentsToZ shared-output-style:start");
      expect(instructions).toContain("English translation:");
      expect(instructions).toContain("Write the actual response in the user's language");
    }

    const generated = [
      readFileSync(join(root, ".agents/skills/project-memory/SKILL.md"), "utf8"),
      readFileSync(join(root, ".agents/skills/remember-session/SKILL.md"), "utf8"),
      readFileSync(join(root, "AGENTS.md"), "utf8"),
    ];
    for (const content of generated) {
      expect(content).toContain(`memory-agent-version:${CURRENT_PROJECT_MEMORY_VERSION}`);
      expect(content).toContain("MEMORY_ROOT");
      expect(content).toContain("worktree list --porcelain");
      expect(content).toContain("Canonical project memory is unavailable");
    }
    expect(generated[0]).toContain('folderPath=$MEMORY_ROOT');
    expect(generated[1]).toContain('folderPath=$MEMORY_ROOT');
  });

  // The badge needs one new AI interaction and a project change worth remembering.
  const firePrompt = (agent: "claude" | "codex" = "codex", stdin = "") => {
    if (process.platform !== "win32") {
      const hook = Bun.spawnSync(
        ["/bin/sh", join(root, ".agent-memory/activity-hook.sh"), agent],
        { cwd: root, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" },
      );
      if (hook.exitCode !== 0) console.error(hook.stderr.toString());
      expect(hook.exitCode).toBe(0);
      return;
    }

    const hookConfig = JSON.parse(readFileSync(
      join(root, agent === "codex" ? ".codex/hooks.json" : ".claude/settings.json"),
      "utf8",
    ));
    const command = hookConfig.hooks.UserPromptSubmit
      .flatMap((entry: any) => entry.hooks ?? [])
      .map((handler: any) => handler.command)
      .find((candidate: unknown) => typeof candidate === "string" && candidate.includes("-EncodedCommand"));
    expect(typeof command).toBe("string");
    const hook = Bun.spawnSync(
      ["cmd.exe", "/d", "/s", "/c", command],
      { cwd: root, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" },
    );
    if (hook.exitCode !== 0) console.error(hook.stderr.toString());
    expect(hook.exitCode).toBe(0);
  };

  const bigChange = (target: string, marker: string) => {
    writeFileSync(target, Array.from({ length: 40 }, (_, i) => `${marker} line ${i}`).join("\n"));
  };

  test("a project change with no session behind it does not ask to be remembered", () => {
    bigChange(join(root, "app.txt"), "changed");
    const changed = detectProjectMemory(root);
    expect(changed.activity.needsRemember).toBe(false);
    // The gate short-circuits before git runs, so the fingerprint is not even
    // measured — a null here means "not asked", not "nothing changed".
    expect(changed.activity.fingerprintEvaluated).toBe(false);
    markProjectMemoryRemembered({ folderPath: root });
  });

  test("a session with no durable change behind it does not ask either", () => {
    git(root, "checkout", "--", "app.txt");
    markProjectMemoryRemembered({ folderPath: root });
    firePrompt();

    const status = detectProjectMemory(root);
    expect(status.activity.promptsSinceRemember).toBe(1);
    expect(status.activity.needsRemember).toBe(false);
  });

  test("a real session plus a real change asks once, and remembering clears it", () => {
    bigChange(join(root, "app.txt"), "session work");
    firePrompt();

    const changed = detectProjectMemory(root);
    expect(changed.activity.needsRemember).toBe(true);
    expect(changed.activity.reasons).toContain("project-changes");
    expect(changed.activity.churn).toBeGreaterThanOrEqual(12);
    expect(changed.activity.evidencePaths).toContain("app.txt");

    // Remembering resets the fingerprint baseline, so a following prompt
    // without another project change cannot re-light the badge.
    const remembered = markProjectMemoryRemembered({ folderPath: root });
    expect(remembered.activity.needsRemember).toBe(false);
    firePrompt();
    expect(detectProjectMemory(root).activity.needsRemember).toBe(false);
  });

  test("linked worktree changes share the main memory activity baseline", () => {
    git(root, "worktree", "add", "-b", "feature/activity", linkedRoot);
    markProjectMemoryRemembered({ folderPath: root });
    bigChange(join(linkedRoot, "app.txt"), "linked change");
    const hook = runConfiguredHook(root, linkedRoot);
    if (hook.exitCode !== 0) console.error(hook.stderr.toString());
    expect(hook.exitCode).toBe(0);
    expect(existsSync(join(root, ".agent-memory/activity.json"))).toBe(true);
    expect(existsSync(join(linkedRoot, ".agent-memory/activity.json"))).toBe(false);

    const changed = detectProjectMemory(linkedRoot);
    expect(realpathSync(changed.projectRoot)).toBe(realpathSync(root));
    expect(changed.activity.worktreeCount).toBe(1);
    // The linked worktree's work counts toward the one shared baseline.
    expect(changed.activity.needsRemember).toBe(true);
    expect(changed.activity.reasons).toContain("project-changes");
  });

  test("prompt hook stores metadata only and never stores prompt content", () => {
    markProjectMemoryRemembered({ folderPath: root });
    const secretPrompt = "do-not-store-this-prompt";
    firePrompt("codex", secretPrompt);

    const marker = readFileSync(join(root, ".agent-memory/activity.json"), "utf8");
    expect(marker).not.toContain(secretPrompt);
    expect(marker).toContain('"agent":"codex"');
    expect(existsSync(join(root, ".agent-memory/activity-count"))).toBe(false);
    expect(detectProjectMemory(root).activity.promptsSinceRemember).toBe(1);
  });

  test("repeated unchanged remembers are idempotent and do not grow the journal", () => {
    markProjectMemoryRemembered({ folderPath: root });
    const journalDir = join(root, ".agent-memory/journal");
    const before = readdirSync(journalDir).sort().map(name => [name, readFileSync(join(journalDir, name), "utf8")]);
    const configBefore = readFileSync(join(root, ".agent-memory/config.json"), "utf8");

    markProjectMemoryRemembered({ folderPath: root });

    const after = readdirSync(journalDir).sort().map(name => [name, readFileSync(join(journalDir, name), "utf8")]);
    expect(after).toEqual(before);
    expect(readFileSync(join(root, ".agent-memory/config.json"), "utf8")).toBe(configBefore);
  });
});

test("generated activity hooks fail closed when the canonical config is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-memory-hook-authority-"));
  const linkedRoot = `${root}-linked`;
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "AgentsToZ Test");
    writeFileSync(join(root, "app.txt"), "initial\n");
    git(root, "add", "app.txt");
    git(root, "commit", "-m", "initial");
    initializeProjectMemory({ folderPath: root, projectName: "hook-authority", agent: "codex", autoBackup: false });
    git(root, "worktree", "add", "-b", "feature/hook-authority", linkedRoot);

    // Simulate a stale linked-worktree copy while the canonical main config is
    // unavailable. The generated command must not fall back and write here.
    rmSync(join(root, ".agent-memory/config.json"));
    mkdirSync(join(linkedRoot, ".agent-memory"), { recursive: true });
    writeFileSync(
      join(linkedRoot, ".agent-memory/config.json"),
      '{"memoryId":"stale","sourcePath":".agent-memory/CORE.md"}\n',
    );
    writeFileSync(join(linkedRoot, ".agent-memory/CORE.md"), "# stale linked authority\n");
    if (process.platform === "win32") {
      writeFileSync(
        join(linkedRoot, ".agent-memory/activity-hook.ps1"),
        "Set-Content -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'activity.json') -Value 'stale'\n",
      );
    } else {
      writeFileSync(
        join(linkedRoot, ".agent-memory/activity-hook.sh"),
        '#!/bin/sh\nprintf stale > "$(dirname -- "$0")/activity.json"\n',
      );
    }

    const hook = runConfiguredHook(root, linkedRoot, "codex", "secret prompt");
    if (hook.exitCode !== 0) console.error(hook.stderr.toString());
    expect(hook.exitCode).toBe(0);
    expect(existsSync(join(linkedRoot, ".agent-memory/activity.json"))).toBe(false);

    const detected = detectProjectMemory(linkedRoot);
    expect(realpathSync(detected.projectRoot)).toBe(realpathSync(root));
    expect(detected.config).toBeNull();
    expect(() => markProjectMemoryRemembered({ folderPath: linkedRoot }))
      .toThrow("먼저 이 프로젝트에서 장기기억을 시작하세요.");
  } finally {
    if (existsSync(linkedRoot)) rmSync(linkedRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-memory initialization rejects a symlinked adapter directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-memory-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "agentstoz-memory-symlink-outside-"));
  try {
    symlinkSync(outside, join(root, ".codex"), directorySymlinkType);
    expect(() => initializeProjectMemory({
      folderPath: root,
      projectName: "symlink-test",
      agent: "codex",
      autoBackup: false,
    })).toThrow("심볼릭 링크");
    expect(existsSync(join(outside, "hooks.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
