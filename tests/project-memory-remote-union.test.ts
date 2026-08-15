import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendProjectMemoryJournal,
  buildProjectMemoryJournalEntry,
  pullProjectMemoryJournal,
  pushProjectMemoryJournal,
  readProjectMemoryJournal,
  syncProjectMemoryFeedback,
} from "../project-memory-server";
import {
  appendProjectMemoryFeedback,
  feedbackFile,
  projectMemoryFeedbackScopeKey,
  readProjectMemoryFeedback,
  type ProjectMemoryFeedbackEvent,
} from "../src/projectMemoryFeedback";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(join(tmpdir(), "agentstoz-union-"));
  roots.push(value);
  return value;
}

class FakeSupabase {
  tables: Record<string, any[]>;
  ranges: Array<{ table: string; from: number; to: number }> = [];
  upserts: Array<{ table: string; rows: any[]; options: any }> = [];

  constructor(tables: Record<string, any[]> = {}) {
    this.tables = Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, [...rows]]));
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private db: FakeSupabase, private table: string) {}
  select(_columns: string) { return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  order(_column: string, _options: unknown) { return this; }
  range(from: number, to: number) {
    this.db.ranges.push({ table: this.table, from, to });
    const rows = (this.db.tables[this.table] ?? [])
      .filter(row => this.filters.every(([column, value]) => row[column] === value))
      .slice(from, to + 1);
    return Promise.resolve({ data: rows, error: null });
  }
  upsert(rows: any[], options: any) {
    const batch = rows.map(row => ({ ...row }));
    this.db.upserts.push({ table: this.table, rows: batch, options });
    const existing = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);
    const keys = String(options?.onConflict ?? "id").split(",");
    for (const row of batch) {
      if (!existing.some(item => keys.every(key => item[key] === row[key]))) existing.push(row);
    }
    return Promise.resolve({ data: batch, error: null });
  }
}

const recordedAt = "2026-08-12T00:00:00.000Z";

function journalRow(memoryId: string, seed: string) {
  const entry = buildProjectMemoryJournalEntry({
    recordedAt,
    agent: "claude",
    narrative: `summary-${seed}`,
  });
  return {
    memory_id: memoryId,
    entry_hash: entry.entryHash,
    recorded_at: entry.recordedAt,
    agent: entry.agent,
    head_commit: entry.headCommit,
    summary: entry.summary,
    body: entry.body,
  };
}

describe("remote append-only project-memory union", () => {
  test("journal pull paginates, isolates malformed rows, and is idempotent", async () => {
    const dir = root();
    const memoryId = "memory-1";
    const malformed = Array.from({ length: 1_000 }, (_, index) => ({
      ...journalRow(memoryId, `bad-${index}`),
      entry_hash: `not-hex-${index}`,
    }));
    const valid = journalRow(memoryId, "abcdef0123456789");
    const db = new FakeSupabase({
      portmgr_project_memory_journal: [...malformed, valid],
    });

    expect(await pullProjectMemoryJournal(db, { root: dir, memoryId })).toEqual({ journalPulled: 1 });
    expect(db.ranges.map(({ from, to }) => [from, to])).toEqual([[0, 999], [1000, 1999]]);
    expect(readProjectMemoryJournal(dir).map(entry => entry.entryHash)).toEqual([valid.entry_hash]);

    db.ranges.length = 0;
    expect(await pullProjectMemoryJournal(db, { root: dir, memoryId })).toEqual({ journalPulled: 0 });
    expect(readProjectMemoryJournal(dir)).toHaveLength(1);
  });

  test("journal push sees known hashes beyond Supabase's first page", async () => {
    const dir = root();
    const memoryId = "memory-2";
    const first = journalRow(memoryId, "a".repeat(16));
    const last = journalRow(memoryId, "f".repeat(16));
    appendProjectMemoryJournal(dir, {
      entryHash: first.entry_hash,
      recordedAt,
      agent: "claude",
      headCommit: null,
      summary: first.summary,
      body: first.body,
    });
    appendProjectMemoryJournal(dir, {
      entryHash: last.entry_hash,
      recordedAt: "2026-08-12T00:00:01.000Z",
      agent: "claude",
      headCommit: null,
      summary: last.summary,
      body: last.body,
    });
    const known = [
      first,
      ...Array.from({ length: 999 }, (_, index) => journalRow(memoryId, (index + 10).toString(16).padStart(16, "0"))),
      last,
    ];
    const db = new FakeSupabase({ portmgr_project_memory_journal: known });

    const result = await pushProjectMemoryJournal(db, {
      root: dir,
      memoryId,
      projectName: "demo",
      deviceId: null,
      deviceName: null,
    });
    expect(result).toEqual({ journalPushed: 0, journalRemote: 1001 });
    expect(db.ranges.map(({ from, to }) => [from, to])).toEqual([[0, 999], [1000, 1999]]);
    expect(db.upserts).toHaveLength(0);
  });

  test("malformed remote feedback cannot suppress a valid local event with the same id", async () => {
    const dir = root();
    const memoryId = "memory-3";
    appendProjectMemoryFeedback(dir, {
      id: "shared-id",
      memoryId,
      entryKey: "a".repeat(24),
      kind: "applied",
      recordedAt,
    });
    const malformed = Array.from({ length: 1_000 }, (_, index) => ({
      id: index === 0 ? "shared-id" : `bad-${index}`,
      memory_id: memoryId,
      entry_key: "invalid",
      kind: "confirmed",
      recorded_at: recordedAt,
    }));
    const remoteContentVersion = "c".repeat(32);
    const validRemote = {
      id: "remote-valid",
      memory_id: memoryId,
      entry_key: projectMemoryFeedbackScopeKey("b".repeat(24), remoteContentVersion),
      kind: "confirmed",
      evidence: null,
      device_id: "mac",
      recorded_at: "2026-08-12T00:00:01.000Z",
    };
    const db = new FakeSupabase({
      portmgr_project_memory_feedback: [...malformed, validRemote],
    });

    const result = await syncProjectMemoryFeedback(db, { root: dir, memoryId, deviceId: "aws" });
    expect(result).toEqual({ feedbackPushed: 1, feedbackPulled: 1 });
    expect(db.ranges.map(({ from, to }) => [from, to])).toEqual([[0, 999], [1000, 1999]]);
    expect(db.upserts.flatMap(item => item.rows).map(row => row.id)).toEqual(["shared-id"]);
    const feedback = readProjectMemoryFeedback(dir);
    expect(feedback.map(event => event.id).sort()).toEqual(["remote-valid", "shared-id"]);
    expect(feedback.find(event => event.id === "remote-valid")?.contentVersionHash).toBe(remoteContentVersion);
  });

  test("large feedback catch-up is written in bounded batches", async () => {
    const dir = root();
    const memoryId = "memory-4";
    const events: ProjectMemoryFeedbackEvent[] = Array.from({ length: 401 }, (_, index) => ({
      id: `event-${String(index).padStart(4, "0")}`,
      memoryId,
      entryKey: index.toString(16).padStart(24, "0"),
      contentVersionHash: index.toString(16).padStart(32, "0"),
      kind: "applied",
      recordedAt: new Date(Date.parse(recordedAt) + index * 1000).toISOString(),
      evidence: null,
      deviceId: "aws",
    }));
    const path = feedbackFile(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${events.map(event => JSON.stringify(event)).join("\n")}\n`);
    const db = new FakeSupabase({ portmgr_project_memory_feedback: [] });

    expect(await syncProjectMemoryFeedback(db, { root: dir, memoryId, deviceId: "aws" }))
      .toEqual({ feedbackPushed: 401, feedbackPulled: 0 });
    expect(db.upserts.map(item => item.rows.length)).toEqual([200, 200, 1]);
    expect(db.upserts[0]?.rows[0]?.entry_key).toBe(projectMemoryFeedbackScopeKey(
      events[0]!.entryKey,
      events[0]!.contentVersionHash!,
    ));
  });
});
