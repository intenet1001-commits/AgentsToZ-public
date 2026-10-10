import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONTROL_CENTER_PROJECT_NAME, controlCenterTemplateFiles, findExistingOpsProject, resolveControlCenterProject,
} from "../src/controlCenterProject";
import golden from "./fixtures/ops-folder-names-golden.json";

describe("AgentsToZ control-center template", () => {
  test("keeps Git, project memory, and live mission state as separate sync layers", () => {
    const files = controlCenterTemplateFiles();
    const byPath = new Map(files.map(file => [file.relativePath, file.content]));

    // New OPS folders use the new name and rule file; AgentsToZ-Control stays recognized elsewhere.
    expect(CONTROL_CENTER_PROJECT_NAME).toBe("AgentsToZ-OPS");
    expect([...byPath.keys()]).toEqual([
      "README.md",
      "CONTROL.md",
      "PROJECTS.md",
      ".agents/rules/agentstoz-ops.md",
    ]);
    expect(byPath.get("README.md")).toStartWith("# AgentsToZ-OPS\n");
    expect(byPath.get("README.md")).toContain("동일한 `memoryId`");
    expect(byPath.get("README.md")).toContain("원격 기억을 먼저 Pull");
    expect(byPath.get("CONTROL.md")).toContain("미션 저장소");
    expect(byPath.get("CONTROL.md")).toContain("프로젝트 기억");
    expect(byPath.get("PROJECTS.md")).not.toContain("/Users/");
  });

  test("uses the chosen project name without embedding one user's repository identity", () => {
    const contents = controlCenterTemplateFiles("My-Control").map(file => file.content).join("\n");
    expect(contents).toContain("# My-Control");
    expect(contents).not.toContain("intenet1001-commits");
    expect(contents).not.toContain("51c574e8-2109-4065-92e0-66523c206fe8");
  });

  test("finds a registered control center by portable name or folder leaf", () => {
    for (const leaf of ["AgentsToZ-Control", "AgentsToZ-OPS"]) {
      const expected = { id: "control", name: "renamed", folderPath: `C:\\work\\${leaf}\\` };
      expect(resolveControlCenterProject([{ id: "other", name: "other" }, expected])).toBe(expected);
      expect(resolveControlCenterProject([{ id: "control", aiName: leaf }])).toEqual({ id: "control", aiName: leaf });
    }
    expect(resolveControlCenterProject([{ id: "other", name: "Control experiment" }])).toBeNull();
  });

  test("golden OPS names resolve locally exactly when they name the OPS folder", () => {
    for (const row of golden) {
      const project = { id: "p", name: row.name, aiName: row.aiName ?? undefined, folderPath: `/Users/me/product/${row.leaf}` };
      expect({ case: row.case, found: resolveControlCenterProject([project]) !== null })
        .toEqual({ case: row.case, found: row.expectedRole === "ops" });
    }
  });

  test("one OPS: the bound profile project, then an ops role, then either name — never a worktree", () => {
    const listed = [
      { projectId: "wt", projectName: "AgentsToZ-OPS · feature", role: "ops", scope: "worktree" },
      { projectId: "legacy", projectName: "AgentsToZ-Control", role: "managed", scope: "main" },
      { projectId: "renamed", projectName: "운영본부", role: "ops", scope: "main" },
      { projectId: "bound", projectName: "My operations", role: "managed", scope: "main" },
    ];
    expect(findExistingOpsProject(listed, "bound")?.projectId).toBe("bound");
    expect(findExistingOpsProject(listed, "missing")?.projectId).toBe("renamed");
    expect(findExistingOpsProject(listed.filter(p => p.projectId !== "renamed"))?.projectId).toBe("legacy");
    expect(findExistingOpsProject([{ projectId: "new", projectName: "agentstoz-ops", role: "managed", scope: "main" }])?.projectId).toBe("new");
    expect(findExistingOpsProject([listed[0]!, { projectId: "other", projectName: "AgentsToZ OPS", role: "managed", scope: "main" }])).toBeNull();
  });

  test("the desktop tools area exposes a permanent control shortcut", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain('data-testid="control-center-project-shortcut"');
    expect(app).toContain("AgentsToZ OPS 운영 폴더 열기");
    expect(app).toContain("setV4SelectedId(controlCenterProject.id)");
  });
});
