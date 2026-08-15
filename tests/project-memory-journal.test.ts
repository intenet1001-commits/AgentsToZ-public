import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectMemoryJournal,
  buildProjectMemoryJournalEntry,
  readProjectMemoryJournal,
  initializeProjectMemory,
  markProjectMemoryRemembered,
  readProjectMemoryDeviceState,
} from "../project-memory-server";
import { canCreateFileSymlinks, directorySymlinkType } from "./fs-test-capabilities";

const fileSymlinkTest = canCreateFileSymlinks ? test : test.skip;

setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git ${args.join(" ")}`);
  return result.stdout.toString().trim();
}

describe("journal entry construction", () => {
  // The journal must cost nothing: if writing it required a model call it would
  // be skipped exactly when sessions are busy, which is when it matters.
  test("an entry is built from git alone, with no narrative", () => {
    const entry = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-09T10:00:00.000Z",
      agent: "claude",
      headCommit: "abc1234",
      commits: ["abc1234 fix: something real"],
      churn: 42,
      evidencePaths: ["src/a.ts", "src/b.ts"],
    });
    expect(entry.summary).toBe("abc1234 fix: something real");
    expect(entry.body).toContain("abc1234 fix: something real");
    expect(entry.body).toContain("src/a.ts");
    expect(entry.body).toContain("churn: 42");
  });

  test("a narrative, when present, becomes the summary", () => {
    const entry = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-09T10:00:00.000Z",
      commits: ["abc1234 chore: noise"],
      narrative: "해시 기반 동기화 판정으로 교체",
    });
    expect(entry.summary).toBe("해시 기반 동기화 판정으로 교체");
    expect(entry.body.startsWith("해시 기반")).toBe(true);
  });

  test("a session with nothing detectable still produces a record", () => {
    const entry = buildProjectMemoryJournalEntry({ recordedAt: "2026-08-09T10:00:00.000Z" });
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
  });

  // Hashing content rather than time keeps a retried remember from creating a
  // second record of the same session.
  test("the same session content hashes the same regardless of timestamp", () => {
    const a = buildProjectMemoryJournalEntry({ recordedAt: "2026-08-09T10:00:00.000Z", headCommit: "abc", commits: ["abc x"] });
    const b = buildProjectMemoryJournalEntry({ recordedAt: "2026-08-09T11:30:00.000Z", headCommit: "abc", commits: ["abc x"] });
    expect(a.entryHash).toBe(b.entryHash);
  });
});

describe("journal file is append-only", () => {
  let root = "";
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "agentstoz-journal-")); });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const entry = (summary: string, recordedAt = "2026-08-09T10:00:00.000Z") =>
    buildProjectMemoryJournalEntry({ recordedAt, narrative: summary, commits: [`abc ${summary}`] });

  test("entries accumulate and earlier text is never rewritten", () => {
    const first = appendProjectMemoryJournal(root, entry("첫 세션"));
    expect(first.appended).toBe(true);
    const afterFirst = readFileSync(first.path, "utf8");

    appendProjectMemoryJournal(root, entry("둘째 세션"));
    const afterSecond = readFileSync(first.path, "utf8");
    // The whole earlier file must still be a prefix of the new one.
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(readProjectMemoryJournal(root).map(item => item.summary)).toEqual(["첫 세션", "둘째 세션"]);
  });

  test("re-appending the same entry is a no-op", () => {
    const duplicate = entry("첫 세션");
    const before = readFileSync(journalPath(root), "utf8");
    const result = appendProjectMemoryJournal(root, duplicate);
    expect(result.appended).toBe(false);
    expect(readFileSync(journalPath(root), "utf8")).toBe(before);
  });

  test("entries round-trip summary as well as body", () => {
    const entries = readProjectMemoryJournal(root);
    expect(entries.length).toBe(2);
    expect(entries.map(e => e.body).join("\n")).toContain("첫 세션");
    expect(entries.map(e => e.body).join("\n")).toContain("둘째 세션");
    expect(entries.map(e => e.summary)).toEqual(["첫 세션", "둘째 세션"]);
    expect(new Set(entries.map(e => e.entryHash)).size).toBe(2);
  });

  test("commit-only summary survives file round-trip", () => {
    const isolated = mkdtempSync(join(tmpdir(), "agentstoz-journal-summary-"));
    try {
      const original = buildProjectMemoryJournalEntry({
        recordedAt: "2026-08-10T10:00:00.000Z",
        headCommit: "abc1234",
        commits: ["abc1234 fix: preserve this summary"],
      });
      appendProjectMemoryJournal(isolated, original);
      const [restored] = readProjectMemoryJournal(isolated);
      expect(restored?.summary).toBe(original.summary);
      expect(restored?.summary).not.toBe("커밋:");
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("months are separate files, so one file cannot grow without bound", () => {
    appendProjectMemoryJournal(root, entry("다음 달", "2026-09-01T00:00:00.000Z"));
    expect(existsSync(join(root, ".agent-memory/journal/2026-08.md"))).toBe(true);
    expect(existsSync(join(root, ".agent-memory/journal/2026-09.md"))).toBe(true);
  });

  test("rejects a journal directory symlink instead of appending outside the project", () => {
    const isolated = mkdtempSync(join(tmpdir(), "agentstoz-journal-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "agentstoz-journal-outside-"));
    try {
      mkdirSync(join(isolated, ".agent-memory"), { recursive: true });
      symlinkSync(outside, join(isolated, ".agent-memory", "journal"), directorySymlinkType);

      expect(() => appendProjectMemoryJournal(isolated, entry("escape attempt")))
        .toThrow(/심볼릭 링크/);
      expect(readdirSync(outside)).toHaveLength(0);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  fileSymlinkTest("rejects each journal file symlink instead of reading another project's history", () => {
    const isolated = mkdtempSync(join(tmpdir(), "agentstoz-journal-file-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "agentstoz-journal-file-outside-"));
    try {
      const outsideJournal = appendProjectMemoryJournal(outside, entry("outside project secret")).path;
      mkdirSync(join(isolated, ".agent-memory", "journal"), { recursive: true });
      symlinkSync(outsideJournal, join(isolated, ".agent-memory", "journal", "2026-08.md"), "file");

      expect(() => readProjectMemoryJournal(isolated)).toThrow(/심볼릭 링크/);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects dangling journal symlinks and a symlink project root", () => {
    const isolated = mkdtempSync(join(tmpdir(), "agentstoz-journal-dangling-"));
    const aliasParent = mkdtempSync(join(tmpdir(), "agentstoz-journal-root-alias-"));
    const alias = join(aliasParent, "project");
    try {
      mkdirSync(join(isolated, ".agent-memory"), { recursive: true });
      symlinkSync(join(isolated, "missing-outside"), join(isolated, ".agent-memory", "journal"), directorySymlinkType);
      expect(() => appendProjectMemoryJournal(isolated, entry("dangling escape"))).toThrow(/심볼릭 링크/);

      symlinkSync(isolated, alias, directorySymlinkType);
      expect(() => appendProjectMemoryJournal(alias, entry("root alias escape"))).toThrow(/심볼릭 링크/);
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

function journalPath(root: string) {
  return join(root, ".agent-memory/journal/2026-08.md");
}

describe("remember writes a journal entry", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agentstoz-journal-remember-"));
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "AgentsToZ Test");
    writeFileSync(join(root, "app.txt"), "initial\n");
    git(root, "add", "app.txt");
    git(root, "commit", "-m", "initial");
    initializeProjectMemory({ folderPath: root, projectName: "journal-test", agent: "claude", autoBackup: false });
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("initialization is journalled as initialization, not as a session", () => {
    const entries = readProjectMemoryJournal(root);
    expect(entries.length).toBe(1);
    expect(entries[0]!.body).toContain("장기기억 초기화");
  });

  test("marking remembered records the session and the HEAD it covered", () => {
    const result = markProjectMemoryRemembered({ folderPath: root, narrative: "첫 정리" });
    expect(result.markedRemembered).toBe(true);
    expect(result.journalPath).toBeTruthy();
    const entries = readProjectMemoryJournal(root);
    expect(entries.length).toBe(2);
    expect(entries[entries.length - 1]!.body).toContain("첫 정리");
    const state = JSON.parse(readFileSync(join(root, ".agent-memory/state.json"), "utf8"));
    expect(state.lastRememberedHead).toBe(git(root, "rev-parse", "HEAD"));
  });

  test("the next entry lists exactly the commits since the last remember", () => {
    writeFileSync(join(root, "app.txt"), "changed\n");
    git(root, "commit", "-am", "feat: the second thing");
    markProjectMemoryRemembered({ folderPath: root });
    const entries = readProjectMemoryJournal(root);
    expect(entries.length).toBe(3);
    const newest = entries[entries.length - 1]!;
    expect(newest.body).toContain("feat: the second thing");
    expect(newest.body).not.toContain("initial");
  });

  // A failed evidence append must leave the baseline retryable. Curated memory may
  // already be on disk, but calling the whole operation "remembered" would lose
  // the only point from which the session journal can be reconstructed.
  test("a journal failure refuses to advance the remembered baseline", () => {
    const before = readProjectMemoryDeviceState(root);
    rmSync(join(root, ".agent-memory/journal"), { recursive: true, force: true });
    writeFileSync(join(root, ".agent-memory/journal"), "not a directory");

    expect(() => markProjectMemoryRemembered({ folderPath: root, narrative: "반드시 남아야 할 교훈" }))
      .toThrow(/세션 일지/);

    const after = readProjectMemoryDeviceState(root);
    expect(after.lastRememberedAt).toBe(before.lastRememberedAt);
    expect(after.lastRememberedActivityFingerprint).toBe(before.lastRememberedActivityFingerprint);
    expect(after.lastRememberedHead).toBe(before.lastRememberedHead);
  });
});
