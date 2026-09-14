import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppDataDir } from "../src/appDataDir";
import { startTestApiServer } from "./startTestApiServer";

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

test("discovers Git-linked external worktrees for unopened registered projects", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentstoz-worktree-discovery-"));
  roots.push(home);
  const project = join(home, "projects", "demo");
  const external = join(home, "orca", "workspaces", "demo-task");
  const externalSecond = join(home, "orca", "workspaces", "demo-task-two");
  const plainFolder = join(home, "projects", "notes-only");
  mkdirSync(project, { recursive: true });
  mkdirSync(plainFolder, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  writeFileSync(join(project, "README.md"), "demo\n");
  git(project, "add", "README.md");
  git(project, "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "init");
  mkdirSync(join(home, "orca", "workspaces"), { recursive: true });
  git(project, "worktree", "add", "-q", "-b", "task/external", external);

  const apiEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    PORTMGR_ALLOWED_ORIGINS: "",
  };
  const appData = resolveAppDataDir(process.platform, apiEnv, home);
  mkdirSync(appData, { recursive: true });
  const noteRows = Array.from({ length: 15 }, (_, index) => {
    const folderPath = index === 0 ? plainFolder : join(home, "projects", `notes-${index}`);
    mkdirSync(folderPath, { recursive: true });
    return { id: `notes-${index}`, name: `Notes ${index}`, folderPath };
  });
  const ports = [
    { id: "demo-id", name: "Demo", folderPath: project },
    ...noteRows,
    // Kept outside the first 16-candidate page. Scanning the parent must still
    // invalidate this alias immediately.
    { id: "manual-external", name: "Manual", folderPath: external },
    // A generated child card and a manual external row must not steal the
    // porcelain family's ownership from demo-id.
    { id: "demo-id_wt_task", name: "Generated", folderPath: external, worktreePath: external },
    { id: "demo-id_wt_branch", name: "Legacy branch", folderPath: external, worktreePath: "task/external" },
    { id: "demo-id_wt_missing", name: "Legacy missing", folderPath: join(home, "missing-generated") },
  ];
  const portsPath = join(appData, "ports.json");
  writeFileSync(portsPath, JSON.stringify(ports));

  const { baseUrl, child } = await startTestApiServer({
    cwd: join(import.meta.dir, ".."),
    env: apiEnv,
  });
  children.push(child);
  const response = await fetch(`${baseUrl}/api/discover-registered-git-worktrees`);
  const body = await response.json() as any;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(body.registeredProjectIds).toEqual([
    "demo-id",
    ...noteRows.map(row => row.id),
    "manual-external",
    "demo-id_wt_missing",
  ]);
  expect(body.registeredProjectIds).not.toContain("demo-id_wt_task");
  expect(body.registeredProjectIds).not.toContain("demo-id_wt_branch");
  // A name pattern without positive worktree provenance remains a legitimate
  // manual/missing project and must never be silently hidden or deleted.
  expect(body.registeredProjectIds).toContain("demo-id_wt_missing");
  const demoFamily = body.families.find((family: any) => family.projectId === "demo-id");
  expect(demoFamily.worktrees.map((worktree: any) => worktree.path)).toEqual([
    realpathSync(project),
    realpathSync(external),
  ]);
  expect(demoFamily.worktrees[1]).toMatchObject({
    branch: "task/external",
    is_main: false,
  });
  expect(body.families.find((family: any) => family.projectId === "manual-external")?.worktrees).toEqual([]);
  expect(body.families.find((family: any) => family.projectId === "notes-0")?.worktrees).toEqual([]);
  expect(body.failedProjectIds).toEqual([]);
  expect(body.nextCursor).toBe(16);
  expect(body.truncated).toBe(true);

  // Git common-dir metadata invalidates an otherwise long-lived completion
  // cache, so a worktree created by Orca/Codex is visible on the next poll.
  git(project, "worktree", "add", "-q", "-b", "task/external-two", externalSecond);
  const metadataRefreshed = await (await fetch(`${baseUrl}/api/discover-registered-git-worktrees`)).json() as any;
  expect(metadataRefreshed.families.find((family: any) => family.projectId === "demo-id").worktrees
    .some((worktree: any) => worktree.path === realpathSync(externalSecond))).toBe(true);

  // A ports signature change invalidates that cache immediately.
  writeFileSync(portsPath, `${JSON.stringify(ports)}\n`);
  const refreshed = await (await fetch(`${baseUrl}/api/discover-registered-git-worktrees`)).json() as any;
  expect(refreshed.families.find((family: any) => family.projectId === "demo-id").worktrees
    .some((worktree: any) => worktree.path === realpathSync(externalSecond))).toBe(true);
});

test("maps registered monorepo subfolders into every linked worktree without cross-ownership", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentstoz-worktree-subfolder-"));
  roots.push(home);
  const repository = join(home, "repo");
  const packageA = join(repository, "packages", "a");
  const packageB = join(repository, "packages", "b");
  const external = join(home, "external");
  const externalSecond = join(home, "external-second");
  mkdirSync(packageA, { recursive: true });
  mkdirSync(packageB, { recursive: true });
  git(repository, "init", "-q", "-b", "main");
  writeFileSync(join(packageA, "README.md"), "a\n");
  writeFileSync(join(packageB, "README.md"), "b\n");
  git(repository, "add", ".");
  git(repository, "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "init");
  git(repository, "worktree", "add", "-q", "-b", "task/subfolders", external);

  const apiEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    PORTMGR_ALLOWED_ORIGINS: "",
  };
  const appData = resolveAppDataDir(process.platform, apiEnv, home);
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(appData, "ports.json"), JSON.stringify([
    { id: "package-a", name: "Package A", folderPath: packageA },
    { id: "package-b", name: "Package B", folderPath: packageB },
  ]));

  const { baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, ".."), env: apiEnv });
  children.push(child);
  const response = await fetch(`${baseUrl}/api/discover-registered-git-worktrees`);
  const body = await response.json() as any;
  expect(response.status).toBe(200);
  const familyA = body.families.find((family: any) => family.projectId === "package-a");
  const familyB = body.families.find((family: any) => family.projectId === "package-b");
  expect(familyA.worktrees.map((worktree: any) => worktree.path)).toEqual([
    realpathSync(packageA),
    realpathSync(join(external, "packages", "a")),
  ]);
  expect(familyB.worktrees.map((worktree: any) => worktree.path)).toEqual([
    realpathSync(packageB),
    realpathSync(join(external, "packages", "b")),
  ]);
  expect(familyA.worktrees.some((worktree: any) => worktree.path === realpathSync(external))).toBe(false);
  expect(familyB.worktrees.some((worktree: any) => worktree.path === realpathSync(external))).toBe(false);

  // A subfolder has no `.git` entry of its own. Its cache stamp still has to
  // follow the repository's common Git directory so an externally-created
  // worktree becomes visible on the very next poll.
  git(repository, "worktree", "add", "-q", "-b", "task/subfolders-two", externalSecond);
  const refreshed = await (await fetch(`${baseUrl}/api/discover-registered-git-worktrees`)).json() as any;
  expect(refreshed.families.find((family: any) => family.projectId === "package-a").worktrees
    .some((worktree: any) => worktree.path === realpathSync(join(externalSecond, "packages", "a")))).toBe(true);
});

test("keeps a registered monorepo subproject more specific than its registered repository root", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentstoz-worktree-specific-subfolder-"));
  roots.push(home);
  const repository = join(home, "repo");
  const packageA = join(repository, "packages", "a");
  const external = join(home, "external");
  mkdirSync(packageA, { recursive: true });
  git(repository, "init", "-q", "-b", "main");
  writeFileSync(join(packageA, "README.md"), "a\n");
  git(repository, "add", ".");
  git(repository, "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "init");
  git(repository, "worktree", "add", "-q", "-b", "task/specific-subfolder", external);

  const apiEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    PORTMGR_ALLOWED_ORIGINS: "",
  };
  const appData = resolveAppDataDir(process.platform, apiEnv, home);
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(appData, "ports.json"), JSON.stringify([
    { id: "repository", name: "Repository", folderPath: repository },
    { id: "package-a", name: "Package A", folderPath: packageA },
  ]));

  const { baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, ".."), env: apiEnv });
  children.push(child);
  const response = await fetch(`${baseUrl}/api/discover-registered-git-worktrees`);
  const body = await response.json() as any;
  expect(response.status).toBe(200);
  expect(body.families.find((family: any) => family.projectId === "repository").worktrees
    .map((worktree: any) => worktree.path)).toEqual([realpathSync(repository), realpathSync(external)]);
  expect(body.families.find((family: any) => family.projectId === "package-a").worktrees
    .map((worktree: any) => worktree.path)).toEqual([
      realpathSync(packageA),
      realpathSync(join(external, "packages", "a")),
    ]);
});
