import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  PROJECT_MEMORY_ARCHIVE_BRANCH,
  PROJECT_MEMORY_ARCHIVE_LOCAL_REF,
  PROJECT_MEMORY_ARCHIVE_PUSH_REFSPEC,
  PROJECT_MEMORY_ARCHIVE_REMOTE_REF,
  archiveProjectMemoryToPrivateGitHub,
  bunPrivateGitHubArchiveCommandRunner,
  projectMemoryPrivateGitHubNamespace,
  projectMemoryPrivateGitHubStagingPath,
  type PrivateGitHubArchiveCommandResult,
  type PrivateGitHubArchiveCommandRunner,
  type ProjectMemoryPrivateGitHubArchiveInput,
  type VerifiedPrivateArchiveJournalEntry,
} from "../src/projectMemoryPrivateGitHubArchive";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function filesBelow(root: string, skipGit = false): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (skipGit && item.name === ".git" && dir === root) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) visit(full);
      else files.push(relative(root, full).split("\\").join("/"));
    }
  };
  visit(root);
  return files.sort();
}

function snapshotFiles(root: string): Record<string, string> {
  return Object.fromEntries(filesBelow(root).map(path => [path, readFileSync(join(root, path), "utf8")]));
}

function journalEntry(overrides: Partial<VerifiedPrivateArchiveJournalEntry> = {}): VerifiedPrivateArchiveJournalEntry {
  const source = {
    recordedAt: "2026-08-28T12:00:00.000Z",
    agent: "codex" as const,
    headCommit: "abcdef0123456789",
    summary: "증분 동기화와 private archive를 확정했다.",
    body: "검증된 journal 항목만 고정 branch에 보관한다.",
    ...overrides,
  };
  const entryHash = createHash("sha256")
    .update([source.headCommit ?? "", source.summary, source.body].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return { ...source, entryHash };
}

interface FakeCall {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

class FakeArchiveRunner implements PrivateGitHubArchiveCommandRunner {
  calls: FakeCall[] = [];
  tracked = new Set<string>();
  committed = new Set<string>();
  remoteExists = false;
  localExists = false;
  visibility = "PRIVATE";
  viewerPermission = "WRITE";
  nameWithOwner = "example/private-memory";
  repositoryId = "R_kgDOPrivateMemory";
  pushExitCode = 0;
  pushExitCodes: number[] = [];
  diffExitCode = 1;
  coreWorktree: string | null = null;

  async run(command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }): Promise<PrivateGitHubArchiveCommandResult> {
    const argv = [...args];
    this.calls.push({ command, args: argv, cwd: options.cwd, timeoutMs: options.timeoutMs });
    if (command === "gh") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          id: this.repositoryId,
          nameWithOwner: this.nameWithOwner,
          visibility: this.visibility,
          viewerPermission: this.viewerPermission,
        }),
        stderr: "",
      };
    }
    if (command !== "git") return { exitCode: 127, stdout: "", stderr: "unknown command" };

    if (argv[0] === "init") {
      mkdirSync(join(options.cwd, ".git"), { recursive: true });
      return ok();
    }
    if (argv[0] === "config" && argv[1] === "--local" && argv[2] === "--get") {
      if (argv[3] === "core.worktree" && this.coreWorktree !== null) return ok(`${this.coreWorktree}\n`);
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (argv[0] === "config" && argv[1] === "--local" && argv[2] === "--get-regexp") {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (argv[0] === "rev-parse" && argv[1] === "--is-bare-repository") return ok("false\n");
    if (argv[0] === "rev-parse" && argv[1] === "--show-toplevel") return ok(`${options.cwd}\n`);
    if (argv.length === 1 && argv[0] === "remote") return ok("");
    if (argv[0] === "remote" && argv[1] === "get-url") return ok("https://github.com/example/private-memory.git\n");
    if (argv[0] === "ls-remote") return this.remoteExists ? ok("remote-head\n") : { exitCode: 2, stdout: "", stderr: "" };
    if (argv[0] === "rev-parse" && argv.at(-1) === PROJECT_MEMORY_ARCHIVE_LOCAL_REF) {
      return this.localExists ? ok("1111111111111111111111111111111111111111\n") : { exitCode: 128, stdout: "", stderr: "missing" };
    }
    if (argv[0] === "ls-files") return ok(`${[...this.tracked].sort().join("\0")}${this.tracked.size ? "\0" : ""}`);
    if (argv[0] === "add") {
      for (const path of argv.slice(argv.indexOf("--") + 1)) {
        if (existsSync(join(options.cwd, path))) this.tracked.add(path);
        else this.tracked.delete(path);
      }
      return ok();
    }
    if (argv[0] === "diff") return { exitCode: this.diffExitCode, stdout: "", stderr: "" };
    if (argv.includes("commit")) {
      this.committed = new Set(this.tracked);
      this.localExists = true;
      return ok();
    }
    if (argv[0] === "rev-parse" && argv.at(-1) === "HEAD") {
      return ok("0123456789abcdef0123456789abcdef01234567\n");
    }
    if (argv[0] === "ls-tree") {
      const tree = this.committed.size ? this.committed : this.tracked;
      return ok(`${[...tree].sort().join("\0")}${tree.size ? "\0" : ""}`);
    }
    if (argv[0] === "push") {
      const exitCode = this.pushExitCodes.length > 0 ? this.pushExitCodes.shift()! : this.pushExitCode;
      return { exitCode, stdout: "", stderr: exitCode ? "rejected" : "" };
    }
    return ok();
  }
}

class BlockingInitArchiveRunner extends FakeArchiveRunner {
  private startedResolve!: () => void;
  private releaseResolve!: () => void;
  readonly started = new Promise<void>(resolve => { this.startedResolve = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releaseResolve = resolve; });
  private blocked = false;

  release(): void {
    this.releaseResolve();
  }

  override async run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<PrivateGitHubArchiveCommandResult> {
    if (!this.blocked && command === "git" && args[0] === "init") {
      this.blocked = true;
      const result = await super.run(command, args, options);
      this.startedResolve();
      await this.released;
      return result;
    }
    return super.run(command, args, options);
  }
}

function ok(stdout = ""): PrivateGitHubArchiveCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fixture(runner = new FakeArchiveRunner()): {
  root: string;
  project: string;
  appData: string;
  runner: FakeArchiveRunner;
  input: ProjectMemoryPrivateGitHubArchiveInput;
} {
  const root = temporaryRoot("agentstoz-private-archive-");
  const project = join(root, "project");
  const appData = join(root, "app-data");
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(project, ".agent-memory", "backups"), { recursive: true });
  mkdirSync(join(project, ".agent-memory", "cache"), { recursive: true });
  mkdirSync(join(project, ".agents", "hooks"), { recursive: true });
  writeFileSync(join(project, ".env"), "SECRET=never-export\n");
  writeFileSync(join(project, ".agent-memory", "config.json"), "{\"private\":true}\n");
  writeFileSync(join(project, ".agent-memory", "activity.json"), "{\"prompt\":1}\n");
  writeFileSync(join(project, ".agent-memory", "backups", "CORE-old.md"), "old backup\n");
  writeFileSync(join(project, ".agent-memory", "cache", "recall.sqlite"), "cache\n");
  writeFileSync(join(project, ".agents", "hooks", "prompt.sh"), "echo unsafe\n");

  const noteName = "01-key-decisions.md";
  const input: ProjectMemoryPrivateGitHubArchiveInput = {
    projectRoot: project,
    appDataDir: appData,
    memoryId: "884575df-63c4-407c-8b43-860d1295e663",
    repositoryUrl: "https://github.com/example/private-memory.git",
    core: "# Project Core Memory\n\n분해된 기억 index\n",
    notes: [{ fileName: noteName, content: "## Key Decisions\n\n### Private archive\n검증됨.\n" }],
    notesManifest: `${JSON.stringify({ version: 1, parts: [{ title: "Key Decisions", file: noteName }] }, null, 2)}\n`,
    verifiedJournalEntries: [journalEntry()],
    runner,
  };
  return { root, project, appData, runner, input };
}

describe("Private GitHub project-memory archive", () => {
  test("production commands are asynchronous and timeout without blocking the event loop", async () => {
    const cwd = temporaryRoot("agentstoz-private-archive-runner-");
    let timerAdvanced = false;
    setTimeout(() => { timerAdvanced = true; }, 0);
    const result = await bunPrivateGitHubArchiveCommandRunner.run(
      process.execPath,
      ["-e", "await Bun.sleep(1000)"],
      { cwd, timeoutMs: 25 },
    );
    expect(timerAdvanced).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  test("production commands ignore inherited Git transport config while preserving gh auth storage", async () => {
    const cwd = temporaryRoot("agentstoz-private-archive-env-");
    const maliciousConfig = join(cwd, "malicious.gitconfig");
    writeFileSync(maliciousConfig, [
      '[url "https://attacker.invalid/"]',
      "\tinsteadOf = https://github.com/",
      "",
    ].join("\n"));
    const names = ["GIT_CONFIG_GLOBAL", "GIT_DIR", "GIT_SSH_COMMAND", "GH_HOST", "GH_REPO", "GH_CONFIG_DIR"] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
      process.env.GIT_CONFIG_GLOBAL = maliciousConfig;
      process.env.GIT_DIR = join(cwd, "attacker-git-dir");
      process.env.GIT_SSH_COMMAND = "attacker-ssh";
      process.env.GH_HOST = "attacker.invalid";
      process.env.GH_REPO = "attacker/repository";
      process.env.GH_CONFIG_DIR = cwd;
      const probe = await bunPrivateGitHubArchiveCommandRunner.run(
        process.execPath,
        ["-e", `console.log(JSON.stringify({
          global: process.env.GIT_CONFIG_GLOBAL,
          noSystem: process.env.GIT_CONFIG_NOSYSTEM,
          gitDir: process.env.GIT_DIR ?? null,
          ssh: process.env.GIT_SSH_COMMAND ?? null,
          ghHost: process.env.GH_HOST,
          ghRepo: process.env.GH_REPO ?? null,
          ghConfigDir: process.env.GH_CONFIG_DIR,
        }))`],
        { cwd, timeoutMs: 5_000 },
      );
      expect(probe.exitCode).toBe(0);
      expect(JSON.parse(probe.stdout.trim())).toEqual({
        global: process.platform === "win32" ? "NUL" : "/dev/null",
        noSystem: "1",
        gitDir: null,
        ssh: null,
        ghHost: "github.com",
        ghRepo: null,
        ghConfigDir: cwd,
      });
      const git = Bun.which("git");
      expect(git).toBeTruthy();
      const rewrite = await bunPrivateGitHubArchiveCommandRunner.run(
        git!,
        ["config", "--global", "--get", "url.https://attacker.invalid/.insteadOf"],
        { cwd, timeoutMs: 5_000 },
      );
      expect(rewrite.exitCode).not.toBe(0);
      expect(rewrite.stdout.trim()).toBe("");
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("exports only the allowlist from app-data staging and pushes one exact branch refspec", async () => {
    const { project, runner, input } = fixture();
    const before = snapshotFiles(project);
    const result = await archiveProjectMemoryToPrivateGitHub(input);

    expect(result).toMatchObject({
      success: true,
      status: "pushed",
      repository: "example/private-memory",
      repositoryId: "R_kgDOPrivateMemory",
      branch: PROJECT_MEMORY_ARCHIVE_BRANCH,
      attemptedPush: true,
      localMemoryChanged: false,
      supabaseChanged: false,
    });
    expect(snapshotFiles(project)).toEqual(before);
    expect(result.stagingPath?.startsWith(realpathSync(input.appDataDir))).toBe(true);
    expect(result.stagingPath?.startsWith(realpathSync(project))).toBe(false);
    const namespace = projectMemoryPrivateGitHubNamespace(input.memoryId);
    const prefix = `memories/${namespace}`;
    expect(result.memoryNamespace).toBe(namespace);

    const staged = filesBelow(result.stagingPath!, true);
    expect(staged).toEqual([
      `${prefix}/CORE.md`,
      `${prefix}/SHA256SUMS`,
      `${prefix}/archive-manifest.json`,
      `${prefix}/journal/2026/08/${journalEntry().entryHash}.json`,
      `${prefix}/notes/01-key-decisions.md`,
      `${prefix}/notes/manifest.json`,
    ].sort());
    expect(staged).not.toContain(".env");
    expect(staged.every(path => !/(?:config|activity|backup|hook|cache)/i.test(path))).toBe(true);
    const allArchiveText = staged.map(path => readFileSync(join(result.stagingPath!, path), "utf8")).join("\n");
    expect(allArchiveText).not.toContain("never-export");
    expect(allArchiveText).not.toContain("old backup");

    const manifest = JSON.parse(readFileSync(join(result.stagingPath!, prefix, "archive-manifest.json"), "utf8"));
    expect(manifest.branch).toBe(PROJECT_MEMORY_ARCHIVE_BRANCH);
    expect(manifest.memoryNamespace).toBe(namespace);
    expect(manifest.files.map((file: any) => file.path)).toEqual([
      `${prefix}/CORE.md`,
      `${prefix}/notes/01-key-decisions.md`,
      `${prefix}/notes/manifest.json`,
    ].sort((a, b) => a.localeCompare(b)));
    expect(manifest.journal).toMatchObject({ layout: "verified-entry-v2", count: 1 });
    expect(manifest.journal.setSha256).toMatch(/^[0-9a-f]{64}$/);
    const checksum = readFileSync(join(result.stagingPath!, prefix, "SHA256SUMS"), "utf8");
    expect(checksum).toContain(`${prefix}/archive-manifest.json`);
    expect(checksum).not.toContain("SHA256SUMS");
    expect(checksum).toContain("JOURNAL_SET");
    expect(checksum).not.toContain(`${journalEntry().entryHash}.json`);

    const push = runner.calls.find(call => call.args[0] === "push")!;
    expect(push.args).toEqual(["push", "origin", PROJECT_MEMORY_ARCHIVE_PUSH_REFSPEC]);
    expect(push.args.join(" ")).not.toMatch(/--mirror|--all|--force|force-with-lease|(?:^|\s)-f(?:\s|$)|\s\+/);
    expect(runner.calls.every(call => call.cwd === result.stagingPath)).toBe(true);
    const pushIndex = runner.calls.indexOf(push);
    expect(runner.calls[pushIndex - 1]?.command).toBe("gh");
    expect(runner.calls[pushIndex - 1]?.args).toEqual([
      "repo", "view", "example/private-memory", "--json", "id,nameWithOwner,visibility,viewerPermission",
    ]);
    expect(runner.calls.some(call => (
      call.args[0] === "config"
      && call.args[1] === "--local"
      && call.args[2] === "--add"
      && call.args[3] === "credential.https://github.com.helper"
      && call.args[4] === "!'gh' auth git-credential"
    ))).toBe(true);
  });

  test("stores each verified journal entry as an immutable content-addressed file", async () => {
    const { input } = fixture();
    const first = journalEntry();
    const second = journalEntry({
      recordedAt: "2026-08-28T13:00:00.000Z",
      summary: "같은 달의 다음 결정도 별도 파일로 보관한다.",
      body: "월 누적 blob을 다시 쓰지 않는다.",
    });
    input.verifiedJournalEntries = [first, second];

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.success).toBe(true);
    const prefix = join(result.stagingPath!, "memories", result.memoryNamespace!, "journal", "2026", "08");
    expect(filesBelow(prefix)).toEqual([`${first.entryHash}.json`, `${second.entryHash}.json`].sort());
    expect(existsSync(join(result.stagingPath!, "memories", result.memoryNamespace!, "journal", "2026-08.md"))).toBe(false);
  });

  test("unions an incomplete new journal snapshot with verified history already in the same namespace", async () => {
    const { runner, input } = fixture();
    const historical = journalEntry();
    input.verifiedJournalEntries = [historical];
    const first = await archiveProjectMemoryToPrivateGitHub(input);
    expect(first.success).toBe(true);

    runner.remoteExists = true;
    const recent = journalEntry({
      recordedAt: "2026-08-29T01:00:00.000Z",
      summary: "새 단말은 증분 항목만 전달했다.",
      body: "원격의 검증된 과거 항목과 합쳐야 한다.",
    });
    input.verifiedJournalEntries = [recent];
    const second = await archiveProjectMemoryToPrivateGitHub(input);
    expect(second.success).toBe(true);
    const journalRoot = join(second.stagingPath!, "memories", second.memoryNamespace!, "journal", "2026", "08");
    expect(filesBelow(journalRoot)).toEqual([`${historical.entryHash}.json`, `${recent.entryHash}.json`].sort());
    const manifest = JSON.parse(readFileSync(
      join(second.stagingPath!, "memories", second.memoryNamespace!, "archive-manifest.json"),
      "utf8",
    ));
    expect(manifest.journal.count).toBe(2);
  });

  test("archives 25,000 verified journal entries within a generous long-term budget", async () => {
    const { runner, input } = fixture();
    input.verifiedJournalEntries = Array.from({ length: 25_000 }, (_, index) => journalEntry({
      summary: `장기 보관 결정 ${index}`,
      body: `검증된 합성 journal 본문 ${index}`,
    }));
    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    const elapsedMs = performance.now() - startedAt;
    const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);
    expect(result.success).toBe(true);
    expect(elapsedMs).toBeLessThan(45_000);
    expect(rssGrowth).toBeLessThan(768 * 1024 * 1024);
    expect(runner.committed.size).toBe(25_005);
    const manifest = JSON.parse(readFileSync(
      join(result.stagingPath!, "memories", result.memoryNamespace!, "archive-manifest.json"),
      "utf8",
    ));
    expect(manifest.journal.count).toBe(25_000);
  }, 60_000);

  test("requires PRIVATE visibility and WRITE, MAINTAIN, or ADMIN immediately before every push", async () => {
    for (const permission of ["WRITE", "MAINTAIN", "ADMIN"]) {
      const runner = new FakeArchiveRunner();
      runner.viewerPermission = permission;
      const { input } = fixture(runner);
      expect((await archiveProjectMemoryToPrivateGitHub(input)).success).toBe(true);
      expect(runner.calls.filter(call => call.command === "gh")).toHaveLength(1);
      expect(runner.calls.filter(call => call.args[0] === "push")).toHaveLength(1);
    }

    const publicRunner = new FakeArchiveRunner();
    publicRunner.visibility = "PUBLIC";
    const publicFixture = fixture(publicRunner);
    const publicResult = await archiveProjectMemoryToPrivateGitHub(publicFixture.input);
    expect(publicResult).toMatchObject({
      success: false,
      errorCode: "REPOSITORY_NOT_PRIVATE",
      attemptedPush: false,
      localMemoryChanged: false,
      supabaseChanged: false,
    });
    expect(publicRunner.calls.some(call => call.args[0] === "push")).toBe(false);

    const readRunner = new FakeArchiveRunner();
    readRunner.viewerPermission = "READ";
    const readFixture = fixture(readRunner);
    const readResult = await archiveProjectMemoryToPrivateGitHub(readFixture.input);
    expect(readResult.errorCode).toBe("REPOSITORY_PERMISSION_DENIED");
    expect(readRunner.calls.some(call => call.args[0] === "push")).toBe(false);

    const renamedRunner = new FakeArchiveRunner();
    renamedRunner.nameWithOwner = "example/reused-old-name";
    const renamedFixture = fixture(renamedRunner);
    const renamedResult = await archiveProjectMemoryToPrivateGitHub(renamedFixture.input);
    expect(renamedResult.errorCode).toBe("REPOSITORY_IDENTITY_MISMATCH");
    expect(renamedRunner.calls.some(call => call.args[0] === "push")).toBe(false);

    const replacedRunner = new FakeArchiveRunner();
    replacedRunner.repositoryId = "R_recreatedRepository";
    const replacedFixture = fixture(replacedRunner);
    replacedFixture.input.expectedRepositoryId = "R_originalRepository";
    const replacedResult = await archiveProjectMemoryToPrivateGitHub(replacedFixture.input);
    expect(replacedResult.errorCode).toBe("REPOSITORY_IDENTITY_MISMATCH");
    expect(replacedResult.repositoryId).toBeNull();
    expect(replacedRunner.calls.some(call => call.args[0] === "push")).toBe(false);
  });

  test("rejects credential-bearing repository URLs before staging or commands", async () => {
    for (const repositoryUrl of [
      "https://token@github.com/example/private-memory.git",
      "https://user:password@github.com/example/private-memory.git",
      "https://github.com/example/private-memory.git?token=secret",
      "ssh://token@github.com/example/private-memory.git",
    ]) {
      const { runner, input } = fixture();
      input.repositoryUrl = repositoryUrl;
      const result = await archiveProjectMemoryToPrivateGitHub(input);
      expect(result.errorCode).toBe("REPOSITORY_URL_INVALID");
      expect(result.attemptedPush).toBe(false);
      expect(runner.calls).toEqual([]);
      expect(result.stagingPath).toBeNull();
    }
  });

  test("accepts standard credential-free SSH but always stores a canonical HTTPS remote", async () => {
    const { runner, input } = fixture();
    input.repositoryUrl = "git@github.com:example/private-memory.git";
    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.success).toBe(true);
    const remote = runner.calls.find(call => call.args[0] === "remote" && call.args[1] === "add")!;
    expect(remote.args).toEqual(["remote", "add", "origin", "https://github.com/example/private-memory.git"]);
  });

  test("cryptographically rejects unverified journal input and high-confidence secrets", async () => {
    const invalid = fixture();
    invalid.input.verifiedJournalEntries = [{ ...journalEntry(), entryHash: "0".repeat(16) }];
    const invalidResult = await archiveProjectMemoryToPrivateGitHub(invalid.input);
    expect(invalidResult.errorCode).toBe("JOURNAL_NOT_VERIFIED");
    expect(invalid.runner.calls).toEqual([]);

    const secret = fixture();
    secret.input.core = `# Memory\n\n${["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_")}\n`;
    const secretResult = await archiveProjectMemoryToPrivateGitHub(secret.input);
    expect(secretResult.errorCode).toBe("SECRET_DETECTED");
    expect(secret.runner.calls).toEqual([]);

    for (const credential of [
      "sk-" + "ant-" + "a".repeat(30),
      "xoxz-1234567890-abcdefghij",
      "AIzaSyabcdefghijklmnopqrstuvwxyz123456",
      "SUPABASE_SERVICE_ROLE_KEY=service-role-secret-value",
      "GITHUB_TOKEN=github-secret-value",
    ]) {
      const candidate = fixture();
      candidate.input.core = `# Memory\n\n${credential}\n`;
      expect((await archiveProjectMemoryToPrivateGitHub(candidate.input)).errorCode).toBe("SECRET_DETECTED");
      expect(candidate.runner.calls).toEqual([]);
    }
  });

  test("rejects unsafe notes and staging overlap without touching the worktree", async () => {
    const unsafeNote = fixture();
    unsafeNote.input.notes = [{ fileName: "../../.env.md", content: "no" }];
    unsafeNote.input.notesManifest = JSON.stringify({ version: 1, parts: [{ file: "../../.env.md" }] });
    expect((await archiveProjectMemoryToPrivateGitHub(unsafeNote.input)).errorCode).toBe("SNAPSHOT_INVALID");
    expect(unsafeNote.runner.calls).toEqual([]);

    const overlap = fixture();
    const before = snapshotFiles(overlap.project);
    overlap.input.appDataDir = join(overlap.project, ".agent-memory", "app-data");
    const result = await archiveProjectMemoryToPrivateGitHub(overlap.input);
    expect(result.errorCode).toBe("STAGING_OVERLAPS_PROJECT");
    expect(overlap.runner.calls).toEqual([]);
    expect(existsSync(overlap.input.appDataDir)).toBe(false);
    expect(snapshotFiles(overlap.project)).toEqual(before);
  });

  test("rejects a symlinked staging Git directory before running any command", async () => {
    if (process.platform === "win32") return;
    const { root, project, appData, runner, input } = fixture();
    const stage = projectMemoryPrivateGitHubStagingPath({
      appDataDir: appData,
      projectRoot: project,
      repository: "example/private-memory",
    });
    const outside = join(root, "outside-git");
    mkdirSync(stage, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(stage, ".git"));

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.errorCode).toBe("STAGING_UNSAFE");
    expect(result.attemptedPush).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  test("rejects the staging directory itself when it is an existing symlink", async () => {
    if (process.platform === "win32") return;
    const { root, project, appData, runner, input } = fixture();
    const stage = projectMemoryPrivateGitHubStagingPath({
      appDataDir: appData,
      projectRoot: project,
      repository: "example/private-memory",
    });
    const outside = join(root, "outside-stage");
    mkdirSync(dirname(stage), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, stage);

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.errorCode).toBe("STAGING_UNSAFE");
    expect(runner.calls).toEqual([]);
    expect(filesBelow(outside)).toEqual([]);
  });

  test("rejects core.worktree before checkout or any tracked-file removal", async () => {
    const runner = new FakeArchiveRunner();
    const { input } = fixture(runner);
    runner.coreWorktree = "/tmp/not-the-app-data-stage";

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.errorCode).toBe("STAGING_UNSAFE");
    expect(runner.calls.some(call => call.args[0] === "checkout")).toBe(false);
    expect(runner.calls.some(call => call.args[0] === "ls-files")).toBe(false);
    expect(runner.calls.some(call => call.args[0] === "push")).toBe(false);
  });

  test("rejects inherited local pushurl and insteadOf transport rewrites before Git init", async () => {
    for (const config of [
      '[remote "origin"]\n\turl = https://github.com/example/private-memory.git\n\tpushurl = https://attacker.invalid/memory.git\n',
      '[url "https://attacker.invalid/"]\n\tinsteadOf = https://github.com/\n',
    ]) {
      const { project, appData, runner, input } = fixture();
      const stage = projectMemoryPrivateGitHubStagingPath({
        appDataDir: appData,
        projectRoot: project,
        repository: "example/private-memory",
      });
      mkdirSync(join(stage, ".git"), { recursive: true });
      writeFileSync(join(stage, ".git", "config"), config);

      const result = await archiveProjectMemoryToPrivateGitHub(input);
      expect(result.errorCode).toBe("STAGING_UNSAFE");
      expect(result.attemptedPush).toBe(false);
      expect(runner.calls).toEqual([]);
    }
  });

  test("removes previously tracked non-allowlisted files before commit", async () => {
    const { project, appData, runner, input } = fixture();
    const stage = projectMemoryPrivateGitHubStagingPath({
      appDataDir: appData,
      projectRoot: project,
      repository: "example/private-memory",
    });
    mkdirSync(join(stage, ".git"), { recursive: true });
    writeFileSync(join(stage, ".env"), "LEAK=old\n");
    runner.tracked = new Set([".env"]);

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.success).toBe(true);
    expect(existsSync(join(stage, ".env"))).toBe(false);
    expect([...runner.committed].sort()).toEqual(filesBelow(stage, true));
    expect([...runner.committed]).not.toContain(".env");
  });

  test("preserves complete allowlisted namespaces for other memories in the same private repository", async () => {
    const { runner, input } = fixture();
    const otherMemoryId = "another-long-lived-memory";
    const other = { ...input, memoryId: otherMemoryId, core: "# Other Memory\n\n보존할 기억\n" };
    const first = await archiveProjectMemoryToPrivateGitHub(other);
    expect(first.success).toBe(true);
    const otherPrefix = `memories/${projectMemoryPrivateGitHubNamespace(otherMemoryId)}/`;
    const before = Object.fromEntries(
      filesBelow(first.stagingPath!, true)
        .filter(path => path.startsWith(otherPrefix))
        .map(path => [path, readFileSync(join(first.stagingPath!, path), "utf8")]),
    );

    const second = await archiveProjectMemoryToPrivateGitHub(input);
    expect(second.success).toBe(true);
    const after = Object.fromEntries(
      filesBelow(second.stagingPath!, true)
        .filter(path => path.startsWith(otherPrefix))
        .map(path => [path, readFileSync(join(second.stagingPath!, path), "utf8")]),
    );
    expect(after).toEqual(before);
    expect([...runner.committed].some(path => path.startsWith(otherPrefix))).toBe(true);
    expect([...runner.committed].some(path => path.startsWith(`memories/${second.memoryNamespace}/`))).toBe(true);
  });

  test("refuses to carry a tampered preserved namespace into a new push", async () => {
    const { runner, input } = fixture();
    const otherMemoryId = "tamper-evidence-memory";
    const first = await archiveProjectMemoryToPrivateGitHub({
      ...input,
      memoryId: otherMemoryId,
      core: "# Other Memory\n\n원본\n",
    });
    expect(first.success).toBe(true);
    const otherCore = join(
      first.stagingPath!,
      "memories",
      projectMemoryPrivateGitHubNamespace(otherMemoryId),
      "CORE.md",
    );
    writeFileSync(otherCore, "# Other Memory\n\nmanifest와 다른 변조\n");
    const pushCountBefore = runner.calls.filter(call => call.args[0] === "push").length;

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.errorCode).toBe("STAGING_TREE_UNSAFE");
    expect(result.attemptedPush).toBe(false);
    expect(runner.calls.filter(call => call.args[0] === "push")).toHaveLength(pushCountBefore);
  });

  test("fetches only the fixed remote branch without force when it exists", async () => {
    const runner = new FakeArchiveRunner();
    runner.remoteExists = true;
    const { input } = fixture(runner);
    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.success).toBe(true);
    const fetch = runner.calls.find(call => call.args[0] === "fetch")!;
    expect(fetch.args).toEqual([
      "fetch",
      "--no-tags",
      "origin",
      `${PROJECT_MEMORY_ARCHIVE_LOCAL_REF}:${PROJECT_MEMORY_ARCHIVE_REMOTE_REF}`,
    ]);
    expect(fetch.args.join(" ")).not.toMatch(/--all|--mirror|--force|\s\+/);
    expect(runner.calls.some(call => call.args[0] === "checkout" && call.args[1] === "-b")).toBe(true);
  });

  test("rebases the disposable staging tree on a concurrent remote advance and retries once without force", async () => {
    const runner = new FakeArchiveRunner();
    runner.remoteExists = true;
    runner.localExists = true;
    runner.pushExitCodes = [1, 0];
    const { input } = fixture(runner);

    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.success).toBe(true);
    const pushes = runner.calls.filter(call => call.args[0] === "push");
    expect(pushes).toHaveLength(2);
    expect(pushes.every(call => (
      JSON.stringify(call.args) === JSON.stringify(["push", "origin", PROJECT_MEMORY_ARCHIVE_PUSH_REFSPEC])
    ))).toBe(true);
    expect(runner.calls.filter(call => call.command === "gh")).toHaveLength(2);
    expect(runner.calls.filter(call => call.args[0] === "fetch")).toHaveLength(2);
    expect(runner.calls.filter(call => call.args[0] === "branch" && call.args[1] === "-f").length).toBeGreaterThanOrEqual(2);
    expect(runner.calls.some(call => call.args[0] === "merge")).toBe(false);
    expect(runner.calls.flatMap(call => call.args)).not.toContain("--force");
  });

  test("fails concurrent use of one staging repository closed and allows a clean retry", async () => {
    const blocking = new BlockingInitArchiveRunner();
    const { input } = fixture(blocking);
    const firstPromise = archiveProjectMemoryToPrivateGitHub(input);
    await blocking.started;

    const concurrentRunner = new FakeArchiveRunner();
    const concurrent = await archiveProjectMemoryToPrivateGitHub({ ...input, runner: concurrentRunner });
    expect(concurrent).toMatchObject({ success: false, errorCode: "STAGING_BUSY", attemptedPush: false });
    expect(concurrentRunner.calls).toEqual([]);

    blocking.release();
    expect((await firstPromise).success).toBe(true);
    const retry = await archiveProjectMemoryToPrivateGitHub({ ...input, runner: new FakeArchiveRunner() });
    expect(retry.success).toBe(true);
  });

  test("push failure is reported without any local-memory or Supabase rollback contract", async () => {
    const runner = new FakeArchiveRunner();
    runner.pushExitCode = 1;
    const { project, input } = fixture(runner);
    const before = snapshotFiles(project);
    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result).toMatchObject({
      success: false,
      status: "failed",
      errorCode: "PUSH_FAILED",
      attemptedPush: true,
      localMemoryChanged: false,
      supabaseChanged: false,
    });
    expect(snapshotFiles(project)).toEqual(before);
    runner.pushExitCode = 0;
    const retry = await archiveProjectMemoryToPrivateGitHub(input);
    expect(retry.success).toBe(true);
    expect(snapshotFiles(project)).toEqual(before);
  });

  test("staging files and directories are private on Unix", async () => {
    if (process.platform === "win32") return;
    const { input } = fixture();
    const result = await archiveProjectMemoryToPrivateGitHub(input);
    expect(result.success).toBe(true);
    expect(statSync(result.stagingPath!).mode & 0o777).toBe(0o700);
    expect(statSync(join(
      result.stagingPath!,
      "memories",
      projectMemoryPrivateGitHubNamespace(input.memoryId),
      "CORE.md",
    )).mode & 0o777).toBe(0o600);
  });
});
