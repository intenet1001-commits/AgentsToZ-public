import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_REPOSITORY_WORKFLOW_VERSION,
  completeRepositoryFirstTask,
  detectRepositoryWorkflow,
  inspectWorktreeLaunch,
  inspectWorktreeSource,
  upgradeRepositoryWorkflow,
} from "../repository-workflow-server";

const temporaryRoots: string[] = [];

function projectWithGit(): string {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-repository-workflow-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".git"));
  return root;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout || "").trim();
}

function projectWithRealGit(): string {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-real-git-"));
  temporaryRoots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "tests@agentstoz.local"]);
  git(root, ["config", "user.name", "AgentsToZ Tests"]);
  git(root, ["commit", "--allow-empty", "-m", "Initial commit"]);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("versioned repository workflow", () => {
  test("offers a non-destructive upgrade for an existing Git repository", () => {
    const root = projectWithGit();
    const before = detectRepositoryWorkflow(root);
    expect(before.isGit).toBe(true);
    expect(before.installedVersion).toBe(0);
    expect(before.updateAvailable).toBe(true);

    const installed = upgradeRepositoryWorkflow(root);
    expect(installed.installedVersion).toBe(CURRENT_REPOSITORY_WORKFLOW_VERSION);
    expect(installed.updateAvailable).toBe(false);
    expect(installed.firstTaskPending).toBe(true);
  });

  test("marks the first AI task choice once and preserves it during upgrades", () => {
    const root = projectWithGit();
    upgradeRepositoryWorkflow(root);
    expect(completeRepositoryFirstTask(root).firstTaskPending).toBe(false);
    expect(upgradeRepositoryWorkflow(root).firstTaskPending).toBe(false);
  });

  test("supports a linked worktree .git pointer file", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-linked-worktree-"));
    temporaryRoots.push(root);
    const linkedGitDir = join(root, "git-metadata", "worktrees", "feature");
    mkdirSync(linkedGitDir, { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: git-metadata/worktrees/feature\n");

    upgradeRepositoryWorkflow(root);
    const stored = JSON.parse(readFileSync(join(linkedGitDir, "agentstoz", "repository-workflow.json"), "utf8"));
    expect(stored.workflowVersion).toBe(CURRENT_REPOSITORY_WORKFLOW_VERSION);
  });

  test("does not downgrade a workflow written by a newer app", () => {
    const root = projectWithGit();
    const path = join(root, ".git", "agentstoz", "repository-workflow.json");
    mkdirSync(join(root, ".git", "agentstoz"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      workflowVersion: CURRENT_REPOSITORY_WORKFLOW_VERSION + 1,
      firstTaskRouting: "ask",
      firstTaskPending: false,
    }));

    const status = upgradeRepositoryWorkflow(root);
    expect(status.installedVersion).toBe(CURRENT_REPOSITORY_WORKFLOW_VERSION + 1);
    expect(JSON.parse(readFileSync(path, "utf8")).workflowVersion)
      .toBe(CURRENT_REPOSITORY_WORKFLOW_VERSION + 1);
  });

  test("reports a missing project folder clearly", () => {
    expect(() => detectRepositoryWorkflow(join(tmpdir(), "missing-agentstoz-project")))
      .toThrow("프로젝트 폴더가 없습니다");
  });

  test("blocks worktree creation until visible main-tree files are committed", () => {
    const root = projectWithRealGit();
    writeFileSync(join(root, "AGENTS.md"), "project instructions\n");
    writeFileSync(join(root, ".DS_Store"), "local metadata\n");
    mkdirSync(join(root, ".agent-memory", "backups"), { recursive: true });
    writeFileSync(join(root, ".agent-memory", "backups", "CORE-old.md"), "backup\n");

    const dirty = inspectWorktreeSource(root);
    expect(dirty.ready).toBe(false);
    expect(dirty.changedPaths).toContain("AGENTS.md");
    expect(dirty.changedPaths).not.toContain(".DS_Store");
    expect(dirty.changedPaths).not.toContain(".agent-memory/backups/CORE-old.md");

    git(root, ["add", "AGENTS.md"]);
    git(root, ["commit", "-m", "Add project instructions"]);
    const clean = inspectWorktreeSource(root);
    expect(clean.ready).toBe(true);
    expect(clean.headFileCount).toBe(1);
  });

  test("rejects an existing empty worktree that is missing main project memory", () => {
    const root = projectWithRealGit();
    mkdirSync(join(root, ".agent-memory"), { recursive: true });
    writeFileSync(join(root, ".agent-memory", "config.json"), "{}\n");
    const linked = join(root, ".claude", "worktrees", "task-empty");
    mkdirSync(join(root, ".claude", "worktrees"), { recursive: true });
    git(root, ["worktree", "add", "-b", "task-empty", linked]);

    const status = inspectWorktreeLaunch(root, linked);
    expect(status.registered).toBe(true);
    expect(status.targetFileCount).toBe(0);
    expect(status.memoryConfiguredInMain).toBe(true);
    expect(status.memoryAvailableInTarget).toBe(false);
    expect(status.ready).toBe(false);
  });
});
