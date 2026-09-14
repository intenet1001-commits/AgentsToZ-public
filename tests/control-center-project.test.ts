import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTROL_CENTER_PROJECT_NAME, controlCenterTemplateFiles, resolveControlCenterProject } from "../src/controlCenterProject";

describe("AgentsToZ control-center template", () => {
  test("keeps Git, project memory, and live mission state as separate sync layers", () => {
    const files = controlCenterTemplateFiles();
    const byPath = new Map(files.map(file => [file.relativePath, file.content]));

    expect(CONTROL_CENTER_PROJECT_NAME).toBe("AgentsToZ-Control");
    expect([...byPath.keys()]).toEqual([
      "README.md",
      "CONTROL.md",
      "PROJECTS.md",
      ".agents/rules/agentstoz-control.md",
    ]);
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
    const expected = { id: "control", name: "renamed", folderPath: "C:\\work\\AgentsToZ-Control\\" };
    expect(resolveControlCenterProject([{ id: "other", name: "other" }, expected])).toBe(expected);
    expect(resolveControlCenterProject([{ id: "control", aiName: "AgentsToZ-Control" }])).toEqual({ id: "control", aiName: "AgentsToZ-Control" });
    expect(resolveControlCenterProject([{ id: "other", name: "Control experiment" }])).toBeNull();
  });

  test("the desktop tools area exposes a permanent control shortcut", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain('data-testid="control-center-project-shortcut"');
    expect(app).toContain("Control 바로 열기");
    expect(app).toContain("setV4SelectedId(controlCenterProject.id)");
  });
});
