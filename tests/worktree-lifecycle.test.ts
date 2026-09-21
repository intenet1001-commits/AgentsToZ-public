import { describe, expect, test } from "bun:test";
import {
  canonicalProjectFamilyRootId,
  generatedWorktreeParentId,
  projectFamilyIdsForRemoval,
  shouldApplyRichWorktreePollResult,
  shouldRunRichWorktreePoll,
  withoutProjectFamilyRows,
  withoutVerifiedLegacyGeneratedRemoteRows,
} from "../src/worktreeLifecycle";

describe("rich worktree polling lifecycle", () => {
  test("runs only for a visible project tab with an expanded project", () => {
    expect(shouldRunRichWorktreePoll("ports", false, 1)).toBe(true);
    expect(shouldRunRichWorktreePoll("portal", false, 1)).toBe(false);
    expect(shouldRunRichWorktreePoll("runtime", false, 1)).toBe(false);
    expect(shouldRunRichWorktreePoll("memory", false, 1)).toBe(false);
    expect(shouldRunRichWorktreePoll("ports", true, 1)).toBe(false);
    expect(shouldRunRichWorktreePoll("ports", false, 0)).toBe(false);
  });

  test("drops a background result after its panel collapses or tab becomes hidden", () => {
    const expanded = new Set(["project"]);
    expect(shouldApplyRichWorktreePollResult("ports", false, expanded, "project")).toBe(true);
    expect(shouldApplyRichWorktreePollResult("portal", false, expanded, "project")).toBe(false);
    expect(shouldApplyRichWorktreePollResult("ports", true, expanded, "project")).toBe(false);
    expect(shouldApplyRichWorktreePollResult("ports", false, new Set(), "project")).toBe(false);
  });
});

describe("generated worktree row removal", () => {
  const rows = [
    { id: "parent", name: "Parent" },
    { id: "parent_wt_one", name: "One", folderPath: "/repo-wt/one", worktreePath: "/repo-wt/one" },
    { id: "child-with-random-id", name: "Two", folderPath: "/repo-wt/two", worktreePath: "/repo-wt/two", worktreeParentId: "parent" },
    { id: "parent_wt_trap", name: "Unrelated imported row" },
    { id: "parent-other", name: "Manual sibling" },
    { id: "other_wt_one", name: "Other" },
  ];

  test("selects only the parent and its generated `_wt_` family", () => {
    expect(projectFamilyIdsForRemoval(rows, "parent")).toEqual([
      "parent",
      "parent_wt_one",
      "child-with-random-id",
    ]);
  });

  test("removes the same exact family locally without touching manual siblings", () => {
    expect(withoutProjectFamilyRows(rows, "parent").map(row => row.id)).toEqual([
      "parent_wt_trap",
      "parent-other",
      "other_wt_one",
    ]);
  });

  test("walks old nested generated rows transitively and resolves the canonical root", () => {
    const nested = [
      { id: "root", name: "Root" },
      { id: "child", name: "Child", folderPath: "/wt/child", worktreePath: "/wt/child", worktreeParentId: "root" },
      { id: "grandchild", name: "Grandchild", folderPath: "/wt/grand", worktreePath: "/wt/grand", worktreeParentId: "child" },
    ];
    expect(canonicalProjectFamilyRootId(nested, nested[2]!)).toBe("root");
    expect(projectFamilyIdsForRemoval(nested, "root")).toEqual(["root", "child", "grandchild"]);
    expect(withoutProjectFamilyRows(nested, "root")).toEqual([]);
  });

  test("requires a live parent and local path evidence even with explicit provenance", () => {
    expect(generatedWorktreeParentId(rows, rows[1]!)).toBe("parent");
    expect(generatedWorktreeParentId(rows, rows[2]!)).toBe("parent");
    expect(generatedWorktreeParentId(rows, rows[3]!)).toBeNull();
    expect(generatedWorktreeParentId(rows, {
      id: "remote-child",
      worktreeParentId: "parent",
    })).toBeNull();
    expect(generatedWorktreeParentId(rows.filter(row => row.id !== "parent"), rows[1]!)).toBeNull();
  });

  test("non-destructively hides only a legacy remote child proven by the live Git family", () => {
    const parent = { id: "project", name: "Demo", folderPath: "/repo" };
    const legacyChild = {
      id: "project_wt_feature",
      name: "Demo (feature)",
      folderPath: "/repo-worktrees/feature",
    };
    const manualTrap = {
      id: "project_wt_manual",
      name: "My manual project",
      folderPath: "/repo-worktrees/manual",
    };
    const remoteRows = [parent, legacyChild, manualTrap];
    expect(withoutVerifiedLegacyGeneratedRemoteRows({
      localRows: [],
      remoteRows,
      worktreesByParent: {
        project: [
          { path: "/repo", is_main: true },
          { path: "/repo-worktrees/feature/", is_main: false },
          { path: "/repo-worktrees/manual", is_main: false },
        ],
      },
    }).map(row => row.id)).toEqual(["project", "project_wt_manual"]);
    expect(withoutVerifiedLegacyGeneratedRemoteRows({
      localRows: [],
      remoteRows,
      worktreesByParent: {},
    })).toEqual(remoteRows);
  });
});
