import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const apiSource = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf8");
const route = apiSource.slice(
  apiSource.indexOf('url.pathname === "/api/cleanup-stale-worktrees"'),
  apiSource.indexOf('url.pathname === "/api/git-merge-preview"'),
);
const useProjectList = apiSource.slice(
  apiSource.indexOf("async function listAgentsToZUseProjects()"),
  apiSource.indexOf("type AgentsToZUseWorkspaceRoot"),
);

describe("startup worktree cleanup responsiveness", () => {
  test("does not synchronously stat registered folders on the HTTP thread", () => {
    expect(route).toContain("await statAsync(folderPath)");
    expect(route).toContain("await statAsync(join(folderPath, '.git'))");
    expect(route).not.toContain("existsSync(folderPath)");
    expect(route).not.toContain("statSync(folderPath)");
  });

  test("bounds asynchronous USE project discovery for stale or unavailable folders", () => {
    expect(useProjectList).toContain("Promise.all(unique.map(async candidate =>");
    expect(useProjectList).toContain("Promise.race([");
    expect(useProjectList).toContain("realpathAsync(alias)");
    expect(useProjectList).toContain("readFileAsync(join(projectRoot, \".agent-memory\", \"config.json\")");
    expect(useProjectList).toContain("setTimeout(() => resolve(null), 500)");
    expect(useProjectList).not.toContain("detectProjectMemory(alias)");
  });
});
