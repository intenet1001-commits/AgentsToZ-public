import { describe, expect, test } from "bun:test";
import {
  mergeDiscoveredWorktreeFamilies,
  type DiscoveredWorktree,
} from "../src/worktreeDiscoveryMerge";

describe("registered worktree discovery merge", () => {
  test("adds an externally-created linked worktree to a closed project", () => {
    const next = mergeDiscoveredWorktreeFamilies({}, [{
      projectId: "project-a",
      worktrees: [
        { path: "/repo", branch: "main", head: "aaa", is_main: true },
        { path: "/Users/me/orca/workspaces/task", branch: "task", head: "bbb", is_main: false },
      ],
    }]);
    expect(next["project-a"]?.map(item => item.path)).toEqual([
      "/repo",
      "/Users/me/orca/workspaces/task",
    ]);
  });

  test("invalidates rich panel status when Git identity changes", () => {
    const previous: Record<string, Array<DiscoveredWorktree & {
      changedFiles?: number;
      aheadCount?: number;
    }>> = {
      "project-a": [{
        path: "/repo/worktrees/task",
        branch: "old-task",
        head: "aaa",
        is_main: false,
        changedFiles: 4,
        aheadCount: 2,
      }],
    };
    const next = mergeDiscoveredWorktreeFamilies(previous, [{
      projectId: "project-a",
      worktrees: [{
        path: "/repo/worktrees/task",
        branch: "task",
        head: "bbb",
        is_main: false,
      }],
    }]);
    expect(next["project-a"]?.[0]).toEqual({
      path: "/repo/worktrees/task",
      branch: "task",
      head: "bbb",
      is_main: false,
    });
  });

  test("keeps prior state when a project is omitted after a transient failure", () => {
    const previous = {
      "project-a": [{ path: "/repo", branch: "main", is_main: true }],
    };
    expect(mergeDiscoveredWorktreeFamilies(previous, [])).toBe(previous);
  });

  test("prunes only projects that are no longer registered and accepts successful empty families", () => {
    const previous = {
      "removed": [{ path: "/old", branch: "main", is_main: true }],
      "not-git": [{ path: "/stale", branch: "main", is_main: true }],
      "failed": [{ path: "/keep", branch: "main", is_main: true }],
    };
    const next = mergeDiscoveredWorktreeFamilies(previous, [{
      projectId: "not-git",
      worktrees: [],
    }], ["not-git", "failed"]);
    expect(next.removed).toBeUndefined();
    expect(next["not-git"]).toEqual([]);
    expect(next.failed).toEqual(previous.failed);
  });
});
