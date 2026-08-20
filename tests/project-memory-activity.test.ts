import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProjectMemory,
  initializeProjectMemory,
  markProjectMemoryRemembered,
} from "../project-memory-server";
import { directorySymlinkType } from "./fs-test-capabilities";

setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
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
    expect(status.activity.needsRemember).toBe(false);
    expect(status.activity.hooks).toEqual({ claude: true, codex: true });
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain("UserPromptSubmit");
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toContain("UserPromptSubmit");
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
    firePrompt();

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
