import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeUpgradeStatus } from "../src/components/BulkUpgradeButton";

const root = join(import.meta.dir, "..");
const apiServer = readFileSync(join(root, "api-server.ts"), "utf8");
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const button = readFileSync(join(root, "src", "components", "BulkUpgradeButton.tsx"), "utf8");
const memoryPanel = readFileSync(join(root, "src", "ProjectMemoryPanel.tsx"), "utf8");

function sliceFrom(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to > from ? to : undefined);
}

describe("upgrade backlog summary", () => {
  test("counts each target separately and keeps the folder list", () => {
    const state = summarizeUpgradeStatus({
      memory: [
        { folderPath: "/a", installedVersion: 3, currentVersion: 5 },
        { folderPath: "/b", installedVersion: 4, currentVersion: 5 },
      ],
      workflow: [{ folderPath: "/c", installedVersion: 1, currentVersion: 2 }],
      missing: ["/gone"],
      checked: 4,
    });
    expect(state.memory.folderPaths).toEqual(["/a", "/b"]);
    expect(state.workflow.folderPaths).toEqual(["/c"]);
    expect(state.missing).toEqual(["/gone"]);
  });

  // Projects sit on different old versions. The headline must be the oldest one
  // actually installed somewhere, not an average that matches no real project.
  test("reports the oldest installed version, not an average", () => {
    const state = summarizeUpgradeStatus({
      memory: [
        { folderPath: "/a", installedVersion: 3, currentVersion: 5 },
        { folderPath: "/b", installedVersion: 4, currentVersion: 5 },
      ],
    });
    expect(state.memory.installedVersion).toBe(3);
    expect(state.memory.currentVersion).toBe(5);
  });

  test("an empty backlog reports no versions rather than zero", () => {
    const state = summarizeUpgradeStatus({});
    expect(state.memory.folderPaths).toEqual([]);
    expect(state.memory.installedVersion).toBeNull();
  });
});

describe("batch endpoints", () => {
  const status = sliceFrom(apiServer, '"/api/upgrade-status"', '"/api/upgrade-batch"');
  const batch = sliceFrom(apiServer, '"/api/upgrade-batch"', '"/api/project-memory/preferred-agent"');

  test("status checks both versioned features in one server-side sweep", () => {
    expect(status).toContain("detectProjectMemory(folderPath)");
    expect(status).toContain("detectRepositoryWorkflow(folderPath)");
    expect(status).toContain("memoryAgent?.updateAvailable");
    expect(status).toContain("status.isGit && status.updateAvailable");
  });

  // A count the user cannot reconcile against their project list reads as a bug,
  // so deleted folders are reported rather than quietly dropped.
  test("status reports folders that no longer exist", () => {
    expect(status).toContain("missing.push(folderPath)");
    expect(status).toContain("checked: folderPaths.length");
  });

  test("one failing project does not abort the sweep", () => {
    expect(status).toContain("catch { /* 이 폴더의 기억 상태만 건너뛴다 */ }");
    expect(status).toContain("catch { /* 이 폴더의 워크플로 상태만 건너뛴다 */ }");
  });

  test("batch requires an explicit target and rejects anything else", () => {
    expect(batch).toContain(`body.target === "workflow"`);
    expect(batch).toContain(`body.target === "memory"`);
    expect(batch).toContain(`body.target === "hermes"`);
    expect(batch).toContain("여야 합니다.");
  });

  // The Hermes gateway adapter is one per device, not one per project, so it
  // takes no folderPaths — but it still has to be swept and upgraded here, or
  // the backlog badge silently omits it.
  test("the device-wide Hermes adapter is swept and upgraded alongside projects", () => {
    // 존재 판정이 실행 파일까지 보게 된 뒤로 두 호출은 리졸버 결과를 인자로 받는다.
    expect(status).toContain("detectHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() })");
    expect(status).toContain("hermes, github, missing");
    expect(batch).toContain("installHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() })");
  });

  test("batch reports per-project outcomes instead of a single boolean", () => {
    expect(batch).toContain("results.push({ folderPath, ok: true })");
    expect(batch).toContain("results.push({ folderPath, ok: false, error");
    expect(batch).toContain("upgraded: results.length - failed.length");
  });

  test("both endpoints only accept absolute paths", () => {
    expect(status).toContain("isAbsolute(p)");
    expect(batch).toContain("isAbsolute(p)");
  });
});

describe("header entry point", () => {
  test("memory panel compares installed state with the bundled feature version", () => {
    expect(memoryPanel).toContain("Math.max(");
    expect(memoryPanel).toContain("CURRENT_PROJECT_MEMORY_VERSION");
    expect(memoryPanel).toContain("memoryAgentInstalledVersion < memoryAgentCurrentVersion");
  });

  test("the button is mounted in the main header", () => {
    expect(app).toContain("<BulkUpgradeButton");
    expect(app).toContain("folderPaths={upgradeScanFolderPaths}");
    expect(app).toContain("onToast={showToast}");
    expect(app).toContain("import BulkUpgradeButton from './components/BulkUpgradeButton'");
  });

  // The same sweep already visits every project folder, so the empty-GitHub
  // scan rides along instead of adding a second pass over the filesystem.
  test("the GitHub backfill rides the existing sweep and never overwrites", () => {
    expect(app).toContain("githubMissingPaths={githubMissingFolderPaths}");
    expect(app).toContain("onApplyGithubUrls={applyDetectedGithubUrls}");
    const candidates = sliceFrom(app, "const githubMissingFolderPaths", "const applyDetectedGithubUrls");
    // Only projects whose field is empty become candidates, so a value the user
    // typed can never be a target in the first place.
    expect(candidates).toContain("githubRepositoryUrls(p).length === 0");
    const apply = sliceFrom(app, "const applyDetectedGithubUrls", "const v3Ports");
    // Re-checked at apply time too: the user may have filled it since the scan.
    expect(apply).toContain("githubRepositoryUrls(port).length > 0");
  });

  // The backlog belongs to every registered project; scanning only the visible
  // section would hide work behind whatever filter happens to be selected.
  test("the scan reads the unfiltered project list", () => {
    const memo = sliceFrom(app, "const upgradeScanFolderPaths", "const v3Ports");
    expect(memo).toContain("ports.map(p => p.folderPath)");
    expect(memo).not.toContain("v3Ports");
    expect(memo).not.toContain("searchFilteredPorts");
  });

  test("nothing is shown when there is no backlog", () => {
    expect(button).toContain("if (isDeployedWeb() || pending === 0) return null");
  });

  // Scanning every registered folder is real filesystem work; a timer would pay
  // it forever for a backlog that changes only when the app itself is upgraded.
  test("the scan is not polled", () => {
    expect(button).not.toContain("setInterval");
  });

  test("partial failure is reported as partial", () => {
    expect(button).toContain("failures.length === 0");
    expect(button).toContain("개 갱신 완료,");
  });

  // A failed scan must not render as "everything is up to date".
  test("a failed scan keeps the previous counts", () => {
    const refresh = sliceFrom(button, "const refresh = useCallback", "useEffect(() => { void refresh(); }");
    expect(refresh).not.toContain("setState(summarizeUpgradeStatus({}))");
    expect(refresh).toContain("// A failed scan must not claim");
  });
});
