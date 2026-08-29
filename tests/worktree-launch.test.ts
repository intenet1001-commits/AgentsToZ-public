import { describe, expect, test } from "bun:test";
import { resolveAgentLaunchContext } from "../src/worktreeLaunch";

describe("AI worktree launch context", () => {
  test("uses the linked worktree as the authoritative working directory", () => {
    expect(resolveAgentLaunchContext("/repo/main", "/repo/main/.claude/worktrees/task-1"))
      .toEqual({
        repositoryPath: "/repo/main",
        workingPath: "/repo/main/.claude/worktrees/task-1",
        worktreePath: "/repo/main/.claude/worktrees/task-1",
        isLinkedWorktree: true,
      });
  });

  test("does not misclassify the main row as a linked worktree", () => {
    expect(resolveAgentLaunchContext("/repo/main/", "/repo/main"))
      .toEqual({
        repositoryPath: "/repo/main",
        workingPath: "/repo/main",
        worktreePath: undefined,
        isLinkedWorktree: false,
      });
  });

  test("honors a persisted worktree project entry without an explicit row path", () => {
    expect(resolveAgentLaunchContext("/repo/task", undefined, "/repo/task"))
      .toEqual({
        repositoryPath: "/repo/task",
        workingPath: "/repo/task",
        worktreePath: "/repo/task",
        isLinkedWorktree: true,
      });
  });
});
