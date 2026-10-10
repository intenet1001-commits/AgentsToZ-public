import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectMemoryJournalEntry,
  projectMemoryLedgerCursorStatus,
  pullProjectMemoryLedgerDelta,
  readProjectMemoryJournal,
} from "../project-memory-server";
import { canCreateFileSymlinks, directorySymlinkType } from "./fs-test-capabilities";
import { __setProjectMemoryDurabilityFaultForTests } from "../src/projectMemoryDurability";
import { readProjectMemoryFeedback } from "../src/projectMemoryFeedback";
import { readProjectMemoryLedgerState, countProjectMemoryLedgerAcknowledgements } from '../src/projectMemoryLedgerState';

const symlinkTest = canCreateFileSymlinks ? test : test.skip;

const roots: string[] = [];
afterEach(() => {
  __setProjectMemoryDurabilityFaultForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "agentstoz-ledger-delta-"));
  roots.push(value);
  return value;
}

function journalRow(memoryId: string, seq: number, summary: string, recordedAt: string) {
  const entry = buildProjectMemoryJournalEntry({ recordedAt, narrative: summary });
  return {
    seq: String(seq),
    layer: "journal",
    row_id: `${memoryId}:${entry.entryHash}`,
    payload: {
      memory_id: memoryId,
      entry_hash: entry.entryHash,
      recorded_at: entry.recordedAt,
      agent: entry.agent,
      head_commit: entry.headCommit,
      summary: entry.summary,
      body: entry.body,
    },
  };
}

describe("project-memory ledger delta", () => {
  test('durable pages survive an interrupted catch-up and ACKs do not accumulate in the result', async () => {
    const dir = root(), memoryId = 'paged-durable', appDataDir = join(root(), 'app-data');
    const location = { root: dir, memoryId, appDataDir };
    const rows = Array.from({ length: 1_001 }, (_, n) => journalRow(memoryId, n + 1, `durable-${n}`, '2026-01-01T00:00:00Z'));
    const interrupted = await pullProjectMemoryLedgerDelta({ rpc: async (_name: string, args: any) => {
      if (args.p_after_seq === '1000') {
        // Before the second network call, the first page must already be recoverable.
        expect(readProjectMemoryLedgerState(location).remoteCursor).toBe('1000');
        expect(countProjectMemoryLedgerAcknowledgements({ ...location, layer: 'journal' })).toBe(1_000);
        throw new Error('connection interrupted');
      }
      return { data: rows.slice(0, 1_000), error: null };
    } }, location);
    expect(interrupted.ledgerPullError).toContain('connection interrupted');
    expect(interrupted.acknowledgedJournal).toEqual([]);
    const saved = readProjectMemoryLedgerState(location);
    const resumed = await pullProjectMemoryLedgerDelta({ rpc: async (_name: string, args: any) => {
      expect(args.p_after_seq).toBe('1000');
      return { data: rows.slice(1_000), error: null };
    } }, { ...location, afterSeq: saved.remoteCursor, afterAnchor: saved.remoteAnchor });
    expect(resumed).toMatchObject({ journalPulled: 1, ledgerCursor: '1001', acknowledgedJournal: [] });
    expect(readProjectMemoryLedgerState(location).remoteCursor).toBe('1001');
    expect(readProjectMemoryJournal(dir)).toHaveLength(1_001);
  });

  test('a full page stops at a bounded checkpoint without claiming catch-up completion', async () => {
    const dir = root(), memoryId = 'page-budget', appDataDir = join(root(), 'app-data');
    const rows = Array.from({ length: 1_000 }, (_, n) => journalRow(memoryId, n + 1, `budget-${n}`, '2026-01-01T00:00:00Z'));
    let calls = 0;
    const result = await pullProjectMemoryLedgerDelta({ rpc: async () => {
      calls++; return { data: rows, error: null };
    } }, { root: dir, memoryId, appDataDir, maxPages: 1 });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ledgerCursor: '1000', ledgerHasMore: true, acknowledgedJournal: [] });
    expect(result.ledgerPullError).toContain('다음 동기화');
    expect(readProjectMemoryLedgerState({ root: dir, memoryId, appDataDir }).remoteCursor).toBe('1000');
  });

  test('oversized remote pages cannot move the durable cursor or ACKs', async () => {
    const dir = root(), memoryId = 'oversized-page', appDataDir = join(root(), 'app-data');
    const huge = journalRow(memoryId, 1, 'normal', '2026-01-01T00:00:00Z');
    huge.payload.body = 'x'.repeat(16 * 1024 * 1024);
    const result = await pullProjectMemoryLedgerDelta({ rpc: async () => ({ data: [huge], error: null }) }, { root: dir, memoryId, appDataDir });
    expect(result.ledgerPullError).toContain('크기 제한');
    expect(readProjectMemoryLedgerState({ root: dir, memoryId, appDataDir }).remoteCursor).toBeNull();
    expect(readProjectMemoryJournal(dir)).toEqual([]);
  });

  test("persists feedback catch-up once per page and retries an uncertain page without losing evidence", async () => {
    const dir = root(), memoryId = "memory-feedback-pages";
    const rows = Array.from({ length: 1_001 }, (_, i) => ({
      seq: String(i + 1), layer: "feedback", row_id: `feedback-${i}`,
      payload: { id: `feedback-${i}`, memory_id: memoryId, entry_key: "a".repeat(24),
        kind: "confirmed", evidence: "historical evidence", device_id: null,
        recorded_at: "2026-01-01T00:00:00.000Z" },
    }));
    const sb = { rpc: async (_name: string, args: any) => ({ data: rows.slice(Number(args.p_after_seq), Number(args.p_after_seq) + 1_000), error: null }) };
    let flushes = 0;
    __setProjectMemoryDurabilityFaultForTests((phase, path) => {
      if (phase === "file" && path.endsWith("events.jsonl")) flushes++;
    });
    const first = await pullProjectMemoryLedgerDelta(sb, { root: dir, memoryId });
    expect(first).toMatchObject({ feedbackPulled: 1_001, ledgerCursor: "1001" });
    expect(flushes).toBe(2);
    flushes = 0;
    __setProjectMemoryDurabilityFaultForTests((phase, path) => {
      if (phase === "file" && path.endsWith("events.jsonl") && ++flushes === 2) throw new Error("second page fsync failed");
    });
    const prefix = await pullProjectMemoryLedgerDelta(sb, { root: dir, memoryId, afterSeq: "0" });
    expect(prefix.ledgerCursor).toBe("1000");
    expect(prefix.acknowledgedFeedback).toHaveLength(1_000);
    expect(prefix.acknowledgedFeedback).not.toContain('feedback-1000');
    __setProjectMemoryDurabilityFaultForTests((phase, path) => {
      if (phase === "file" && path.endsWith("events.jsonl")) throw new Error("feedback fsync failed");
    });
    const uncertain = await pullProjectMemoryLedgerDelta(sb, { root: dir, memoryId, afterSeq: "0" });
    expect(uncertain.ledgerCursor).toBe("0");
    expect(uncertain.acknowledgedFeedback).toEqual([]);
    expect(uncertain.ledgerPullError).toContain("feedback fsync failed");
    __setProjectMemoryDurabilityFaultForTests(null);
    const retry = await pullProjectMemoryLedgerDelta(sb, { root: dir, memoryId, afterSeq: "0" });
    expect(retry).toMatchObject({ feedbackPulled: 0, ledgerCursor: "1001" });
    expect(readProjectMemoryFeedback(dir)).toHaveLength(1_001);
  });

  test("flushes both ledgers only through the supported prefix before a future row", async () => {
    const dir = root(), memoryId = 'mixed-prefix';
    const journal = journalRow(memoryId, 2, 'known journal evidence', '2026-01-01T00:00:00.000Z');
    const result = await pullProjectMemoryLedgerDelta({ rpc: async () => ({ error: null, data: [
      { seq: '1', layer: 'feedback', row_id: 'feedback-prefix', payload: {
        id: 'feedback-prefix', memory_id: memoryId, entry_key: 'a'.repeat(24), kind: 'confirmed',
        recorded_at: '2026-01-01T00:00:00.000Z', evidence: null, device_id: null,
      } },
      journal,
      { seq: '3', layer: 'future-layer', row_id: 'future', payload: { memory_id: memoryId } },
      journalRow(memoryId, 4, 'must not be consumed', '2026-01-01T00:00:00.000Z'),
    ] }) }, { root: dir, memoryId });
    expect(result).toMatchObject({ journalPulled: 1, feedbackPulled: 1, ledgerCursor: '2', quarantined: 1 });
    expect(result.acknowledgedFeedback).toEqual(['feedback-prefix']);
    expect(result.acknowledgedJournal).toEqual([journal.payload.entry_hash]);
    expect(readProjectMemoryJournal(dir)).toHaveLength(1);
    expect(readProjectMemoryFeedback(dir)).toHaveLength(1);
  });

  test("validates the exact bigint cursor anchor instead of trusting max(seq) alone", async () => {
    let captured: any = null;
    const valid = await projectMemoryLedgerCursorStatus({
      rpc: async (_name: string, args: any) => {
        captured = args;
        return { data: [{ cursor_valid: true, max_seq: "9223372036854775807" }], error: null };
      },
    }, {
      memoryId: "memory-anchor",
      cursor: "9223372036854775806",
      anchor: { seq: "9223372036854775806", layer: "feedback", rowId: "event-anchor" },
    });
    expect(valid).toEqual({ available: true, valid: true, maxSeq: "9223372036854775807" });
    expect(captured).toEqual({
      p_memory_id: "memory-anchor",
      p_cursor: "9223372036854775806",
      p_layer: "feedback",
      p_row_id: "event-anchor",
    });

    const reused = await projectMemoryLedgerCursorStatus({
      rpc: async () => ({ data: [{ cursor_valid: false, max_seq: "999" }], error: null }),
    }, {
      memoryId: "memory-anchor",
      cursor: "42",
      anchor: { seq: "42", layer: "journal", rowId: "memory-anchor:aaaaaaaaaaaaaaaa" },
    });
    expect(reused).toEqual({ available: true, valid: false, maxSeq: "999" });
  });

  test("receives a late historical row by ingestion sequence, not recorded_at", async () => {
    const memoryId = "memory-delta";
    const sb = {
      rpc: async (_name: string, args: any) => ({
        data: args.p_after_seq === "10"
          ? [journalRow(memoryId, 11, "늦게 발견한 2020년 기록", "2020-01-01T00:00:00.000Z")]
          : [],
        error: null,
      }),
    };
    const result = await pullProjectMemoryLedgerDelta(sb, {
      root: root(),
      memoryId,
      afterSeq: "10",
    });
    expect(result).toMatchObject({ available: true, journalPulled: 1, ledgerCursor: "11" });
  });

  test("paginates more than 1,000 rows and appends each month in batches", async () => {
    const dir = root();
    const memoryId = "memory-pages";
    const rows = Array.from({ length: 1_001 }, (_, index) => journalRow(
      memoryId,
      index + 1,
      `session-${index}`,
      `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    ));
    let calls = 0;
    const sb = {
      rpc: async (_name: string, args: any) => {
        calls += 1;
        const after = Number(args.p_after_seq);
        return { data: rows.filter(row => Number(row.seq) > after).slice(0, args.p_limit), error: null };
      },
    };
    const result = await pullProjectMemoryLedgerDelta(sb, { root: dir, memoryId, afterSeq: "0" });
    expect(result).toMatchObject({ available: true, journalPulled: 1_001, ledgerCursor: "1001" });
    expect(calls).toBe(2);
    expect(readProjectMemoryJournal(dir)).toHaveLength(1_001);
  });

  test("falls back only for the exact missing RPC and keeps auth errors visible", async () => {
    const missing = await pullProjectMemoryLedgerDelta({
      rpc: async () => ({
        data: null,
        error: { code: "PGRST202", message: "Could not find the function portmgr_project_memory_ledger_delta" },
      }),
    }, { root: root(), memoryId: "memory-missing" });
    expect(missing.available).toBe(false);

    const denied = await pullProjectMemoryLedgerDelta({
      rpc: async () => ({ data: null, error: { code: "42501", message: "permission denied" } }),
    }, { root: root(), memoryId: "memory-denied" });
    expect(denied.available).toBe(true);
    expect(denied.ledgerPullError).toContain("permission denied");
  });

  test("quarantines forged or future rows without advancing past them", async () => {
    const memoryId = "memory-quarantine";
    const forged = journalRow(memoryId, 1, "forged", "2026-01-01T00:00:00.000Z");
    forged.row_id = "another-memory:deadbeefdeadbeef";
    const result = await pullProjectMemoryLedgerDelta({
      rpc: async () => ({ data: [forged], error: null }),
    }, { root: root(), memoryId });
    expect(result).toMatchObject({ journalPulled: 0, quarantined: 1, ledgerCursor: "0" });
    expect(result.ledgerAnchor).toBeNull();
    expect(result.ledgerPullError).toContain("seq 1");
  });

  test("commits only the durable prefix before an unsupported future payload", async () => {
    const dir = root();
    const memoryId = "memory-future-prefix";
    const first = journalRow(memoryId, 1, "known row", "2026-01-01T00:00:00.000Z");
    const future = {
      seq: "2",
      layer: "journal-v3",
      row_id: "future-row",
      payload: { version: 3, memory_id: memoryId },
    };
    const third = journalRow(memoryId, 3, "must not pass future row", "2026-01-03T00:00:00.000Z");
    const result = await pullProjectMemoryLedgerDelta({
      rpc: async () => ({ data: [first, future, third], error: null }),
    }, { root: dir, memoryId, afterSeq: "0" });

    expect(result).toMatchObject({ journalPulled: 1, quarantined: 1, ledgerCursor: "1" });
    expect(result.ledgerAnchor).toEqual({ seq: "1", layer: "journal", rowId: first.row_id });
    expect(result.ledgerPullError).toContain("seq 2");
    expect(readProjectMemoryJournal(dir).map(entry => entry.entryHash)).toEqual([first.payload.entry_hash]);
  });

  symlinkTest("does not advance past a valid feedback row when the local append fails", async () => {
    const dir = root();
    const outside = root();
    mkdirSync(join(dir, ".agent-memory"), { recursive: true });
    symlinkSync(outside, join(dir, ".agent-memory", "feedback"), directorySymlinkType);
    const memoryId = "memory-feedback-io";
    const result = await pullProjectMemoryLedgerDelta({
      rpc: async () => ({
        data: [{
          seq: "1",
          layer: "feedback",
          row_id: "feedback-1",
          payload: {
            id: "feedback-1",
            memory_id: memoryId,
            entry_key: `${"a".repeat(24)}:${"b".repeat(32)}`,
            kind: "confirmed",
            evidence: "valid remote evidence",
            device_id: "device-1",
            recorded_at: "2026-08-28T00:00:00.000Z",
          },
        }],
        error: null,
      }),
    }, { root: dir, memoryId, afterSeq: "0" });

    expect(result.ledgerCursor).toBe("0");
    expect(result.quarantined).toBe(0);
    expect(result.ledgerPullError).toContain("심볼릭 링크");
  });

  test("does not advance a cursor until journal fsync succeeds, then safely re-fsyncs the retry", async () => {
    const dir = root();
    const memoryId = "memory-fsync";
    const row = journalRow(memoryId, 1, "durable before cursor", "2026-08-28T00:00:00.000Z");
    const sb = { rpc: async () => ({ data: [row], error: null }) };
    let failed = false;
    __setProjectMemoryDurabilityFaultForTests((phase, path) => {
      if (!failed && phase === "file" && path.includes(".agent-memory/journal/")) {
        failed = true;
        throw new Error("injected journal fsync failure");
      }
    });
    const first = await pullProjectMemoryLedgerDelta(sb, { root: dir, memoryId, afterSeq: "0" });
    expect(first.ledgerCursor).toBe("0");
    expect(first.ledgerAnchor).toBeNull();
    expect(first.ledgerPullError).toContain("injected journal fsync failure");

    __setProjectMemoryDurabilityFaultForTests(null);
    const retry = await pullProjectMemoryLedgerDelta(sb, { root: dir, memoryId, afterSeq: "0" });
    expect(retry).toMatchObject({ ledgerCursor: "1", journalPulled: 0 });
    expect(retry.ledgerAnchor).toEqual({ seq: "1", layer: "journal", rowId: row.row_id });
    expect(readProjectMemoryJournal(dir)).toHaveLength(1);
  });
});
