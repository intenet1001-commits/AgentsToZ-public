import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PROJECT_MEMORY_JOURNAL_EXCERPT_CHARS,
  MAX_PROJECT_MEMORY_JOURNAL_RECALL_LIMIT,
  recallProjectMemoryJournal,
  synchronizeProjectMemoryJournalRecallIndex,
  type ProjectMemoryJournalRecallEntry,
} from "../src/projectMemoryJournalRecall";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-journal-recall-"));
  roots.push(root);
  return root;
}

function journalEntry(
  index: number,
  summary: string,
  body: string,
  overrides: Partial<ProjectMemoryJournalRecallEntry> = {},
): ProjectMemoryJournalRecallEntry {
  return {
    entryHash: index.toString(16).padStart(16, "0"),
    recordedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
    agent: index % 2 ? "claude" : "codex",
    headCommit: index.toString(16).padStart(8, "0"),
    summary,
    body,
    ...overrides,
  };
}

describe("project-memory journal recall index", () => {
  test("uses a contentless trigram index and returns journal only as cautious historical evidence", () => {
    const root = temporaryRoot();
    const cachePath = join(root, "cache", "journal-recall.sqlite");
    const entries = [
      journalEntry(1, "Supabase 동기화 원칙", "원격 변경은 content hash로 비교한다."),
      journalEntry(2, "색상 토큰", "기본 강조색은 teal이다."),
    ];

    const result = recallProjectMemoryJournal({
      cachePath,
      identity: "/project/demo\nmemory-1",
      entries,
      query: "Supabase 동기화",
    });

    expect(result.mode).toBe("fts");
    expect(result.complete).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      source: "journal",
      authority: "historical-evidence",
      entryHash: entries[0]!.entryHash,
      caution: true,
      integrity: "verified",
    });

    const db = new Database(cachePath, { readonly: true });
    try {
      // A contentless FTS table retains tokens, not another plaintext journal.
      expect(db.query("SELECT summary, body FROM journal_recall_fts LIMIT 1").get()).toEqual({
        summary: null,
        body: null,
      });
    } finally {
      db.close();
    }
  });

  test("falls back to a complete scan for two-codepoint Korean terms", () => {
    const root = temporaryRoot();
    const entries = [
      journalEntry(1, "원격 병합", "두 기기의 충돌은 자동으로 덮어쓰지 않는다."),
      journalEntry(2, "다른 기록", "색상만 변경했다."),
    ];
    const result = recallProjectMemoryJournal({
      cachePath: join(root, "journal.sqlite"),
      identity: "memory-short-term",
      entries,
      query: "충돌",
    });

    expect(result.mode).toBe("scan-fallback");
    expect(result.complete).toBe(true);
    expect(result.hits.map(hit => hit.entryHash)).toEqual([entries[0]!.entryHash]);

    // The English alias must not bypass the short Korean variant and thereby
    // lose a Korean-only historical record.
    const alias = recallProjectMemoryJournal({
      cachePath: join(root, "journal.sqlite"),
      identity: "memory-short-term",
      entries,
      query: "conflict",
    });
    expect(alias.mode).toBe("scan-fallback");
    expect(alias.hits.map(hit => hit.entryHash)).toEqual([entries[0]!.entryHash]);
  });

  test("bounds result count, summaries, and excerpts", () => {
    const root = temporaryRoot();
    const longBody = `${"앞부분 ".repeat(180)}phoenixledger ${"뒷부분 ".repeat(180)}`;
    const entries = Array.from({ length: 20 }, (_, index) => journalEntry(
      index + 1,
      `phoenixledger ${"s".repeat(500)} ${index}`,
      longBody,
    ));
    const result = recallProjectMemoryJournal({
      cachePath: join(root, "journal.sqlite"),
      identity: "memory-bounds",
      entries,
      query: "phoenixledger",
      limit: 999,
    });

    expect(result.hits).toHaveLength(MAX_PROJECT_MEMORY_JOURNAL_RECALL_LIMIT);
    expect(result.hits.every(hit => Array.from(hit.summary).length <= 300)).toBe(true);
    expect(result.hits.every(hit => Array.from(hit.excerpt).length <= MAX_PROJECT_MEMORY_JOURNAL_EXCERPT_CHARS)).toBe(true);
    expect(result.hits.every(hit => hit.excerpt.includes("phoenixledger"))).toBe(true);
  });

  test("increments for appended hashes and rebuilds for removal or identity changes", () => {
    const root = temporaryRoot();
    const cachePath = join(root, "journal.sqlite");
    const first = journalEntry(1, "alpha history", "first durable result");
    const second = journalEntry(2, "beta history", "second durable result");
    const third = journalEntry(3, "gamma history", "third durable result");

    expect(synchronizeProjectMemoryJournalRecallIndex({
      cachePath,
      identity: "memory-a",
      entries: [first, second],
    })).toMatchObject({ indexedEntries: 2, addedEntries: 2, rebuilt: true, recovered: false });

    expect(synchronizeProjectMemoryJournalRecallIndex({
      cachePath,
      identity: "memory-a",
      entries: [first, second, third],
    })).toEqual({ indexedEntries: 3, addedEntries: 1, rebuilt: false, recovered: false });

    expect(synchronizeProjectMemoryJournalRecallIndex({
      cachePath,
      identity: "memory-a",
      entries: [second, third],
    })).toMatchObject({ indexedEntries: 2, rebuilt: true });

    expect(synchronizeProjectMemoryJournalRecallIndex({
      cachePath,
      identity: "memory-b",
      entries: [third],
    })).toMatchObject({ indexedEntries: 1, addedEntries: 1, rebuilt: true });

    const oldIdentityResult = recallProjectMemoryJournal({
      cachePath,
      identity: "memory-b",
      entries: [third],
      query: "alpha",
    });
    expect(oldIdentityResult.hits).toEqual([]);
  });

  test("deletes and recreates a corrupt disposable cache", () => {
    const root = temporaryRoot();
    const cachePath = join(root, "journal.sqlite");
    const entries = [journalEntry(1, "phoenixledger recovery", "corrupt caches are disposable")];
    synchronizeProjectMemoryJournalRecallIndex({ cachePath, identity: "memory-corrupt", entries });
    writeFileSync(cachePath, "not a sqlite database", "utf8");

    const result = recallProjectMemoryJournal({
      cachePath,
      identity: "memory-corrupt",
      entries,
      query: "phoenixledger",
    });

    expect(result.mode).toBe("fts");
    expect(result.indexRecovered).toBe(true);
    expect(result.hits[0]?.entryHash).toBe(entries[0]!.entryHash);
    const db = new Database(cachePath, { readonly: true });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
  });

  test("never follows a cache symlink and still recalls from authoritative input", () => {
    const root = temporaryRoot();
    const victim = join(root, "victim.txt");
    const cachePath = join(root, "journal.sqlite");
    writeFileSync(victim, "do-not-touch", "utf8");
    symlinkSync(victim, cachePath);
    const entries = [journalEntry(1, "phoenixledger evidence", "authoritative journal survives")];

    const result = recallProjectMemoryJournal({
      cachePath,
      identity: "memory-symlink",
      entries,
      query: "phoenixledger",
    });

    expect(result.mode).toBe("scan-fallback");
    expect(result.indexWarning).toBe("CACHE_UNAVAILABLE");
    expect(result.hits[0]?.entryHash).toBe(entries[0]!.entryHash);
    expect(readFileSync(victim, "utf8")).toBe("do-not-touch");
    expect(lstatSync(cachePath).isSymbolicLink()).toBe(true);
  });

  test("keeps the SQLite cache private on Unix", () => {
    if (process.platform === "win32") return;
    const root = temporaryRoot();
    const cachePath = join(root, "journal.sqlite");
    synchronizeProjectMemoryJournalRecallIndex({
      cachePath,
      identity: "memory-permissions",
      entries: [journalEntry(1, "permission check", "local derived cache")],
    });
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  test("isolates FTS syntax characters instead of interpreting the query", () => {
    const root = temporaryRoot();
    const entries = [journalEntry(1, "phoenixledger safety", "quotes OR stars are plain query input")];
    const result = recallProjectMemoryJournal({
      cachePath: join(root, "journal.sqlite"),
      identity: "memory-query-safety",
      entries,
      query: `phoenixledger\"maliciousstar*`,
    });
    expect(result.complete).toBe(true);
    expect(result.mode).toBe("fts");
    expect(result.hits[0]?.entryHash).toBe(entries[0]!.entryHash);
  });
});

describe("project-memory journal recall scale", () => {
  test("indexes and searches 25,000 entries within a deliberately generous CI budget", () => {
    const root = temporaryRoot();
    const cachePath = join(root, "journal.sqlite");
    const entries = Array.from({ length: 25_000 }, (_, index) => journalEntry(
      index + 1,
      index === 0 ? "동기화" : `세션 ${index} 장기기억 동기화 결정`,
      `프로젝트 장기기억의 안전한 동기화와 복구를 검토했다. src/module-${index % 500}.ts. ${index === 24_993 ? "phoenixledger 최종 결론" : ""}`,
    ));

    const buildStarted = performance.now();
    const first = recallProjectMemoryJournal({
      cachePath,
      identity: "memory-scale-25000",
      entries,
      query: "phoenixledger",
    });
    const buildMs = performance.now() - buildStarted;
    expect(first.mode).toBe("fts");
    expect(first.indexedEntries).toBe(25_000);
    expect(first.hits[0]?.entryHash).toBe(entries[24_993]!.entryHash);
    expect(buildMs).toBeLessThan(15_000);

    const warmStarted = performance.now();
    const warm = recallProjectMemoryJournal({
      cachePath,
      identity: "memory-scale-25000",
      entries,
      query: "phoenixledger",
    });
    const warmMs = performance.now() - warmStarted;
    expect(warm.mode).toBe("fts");
    expect(warm.indexRebuilt).toBe(false);
    expect(warm.indexedEntries).toBe(25_000);
    expect(warmMs).toBeLessThan(2_500);

    // An exact old summary must not disappear behind the bounded candidate
    // window when tens of thousands of newer rows contain the same common term.
    const common = recallProjectMemoryJournal({
      cachePath,
      identity: "memory-scale-25000",
      entries,
      query: "동기화",
    });
    expect(common.mode).toBe("fts");
    expect(common.complete).toBe(false);
    expect(common.truncated).toBe(true);
    expect(common.hits[0]?.entryHash).toBe(entries[0]!.entryHash);
  }, 30_000);
});
