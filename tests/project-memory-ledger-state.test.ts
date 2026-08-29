import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  addProjectMemoryLedgerAcknowledgements,
  commitProjectMemoryLedgerState,
  compareLedgerCursor,
  countProjectMemoryLedgerAcknowledgements,
  hasProjectMemoryLedgerAcknowledgements,
  projectMemoryLedgerStatePath,
  readProjectMemoryLedgerState,
  withProjectMemoryLedgerLock,
} from "../src/projectMemoryLedgerState";
import { canCreateFileSymlinks, directorySymlinkType } from "./fs-test-capabilities";
import {
  appendProjectMemoryFeedback,
  readProjectMemoryFeedback,
} from "../src/projectMemoryFeedback";
import {
  appendProjectMemoryJournal,
  appendProjectMemoryJournalBatch,
  buildProjectMemoryJournalEntry,
  pushProjectMemoryJournal,
  readProjectMemoryJournal,
  resetProjectMemoryJournalCache,
  syncProjectMemoryAppendOnlyLayers,
} from "../project-memory-server";

const fileSymlinkTest = canCreateFileSymlinks ? test : test.skip;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetProjectMemoryJournalCache();
});

function fixture(memoryId = "memory-1") {
  const parent = mkdtempSync(join(tmpdir(), "agentstoz-ledger-state-"));
  roots.push(parent);
  const root = join(parent, "project");
  const appDataDir = join(parent, "app-data");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".keep"), "");
  return { root, appDataDir, memoryId };
}

function journalKeys(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => (index + offset).toString(16).padStart(16, "0"));
}

function feedbackKeys(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => `event-${index + offset}`);
}

function journalAnchor(seq: string, rowId = "aaaaaaaaaaaaaaaa") {
  return { seq, layer: "journal" as const, rowId };
}

describe("project memory SQLite ledger acceleration state", () => {
  test("a missing cache starts with O(1) cursor metadata and private permissions", () => {
    const input = fixture();
    expect(readProjectMemoryLedgerState(input)).toEqual({
      version: 3,
      memoryId: input.memoryId,
      remoteCursor: null,
      remoteAnchor: null,
    });

    const path = projectMemoryLedgerStatePath(input);
    expect(path.endsWith(".sqlite")).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
  });

  test("commits both acknowledgement layers atomically and keeps bigint cursors exact", () => {
    const input = fixture();
    const committed = commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "9223372036854775806",
      remoteAnchor: journalAnchor("9223372036854775806"),
      journalAcked: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"],
      feedbackAcked: ["event-b", "event-a", "event-b"],
    });
    expect(committed).toEqual({
      state: {
        version: 3,
        memoryId: input.memoryId,
        remoteCursor: "9223372036854775806",
        remoteAnchor: journalAnchor("9223372036854775806"),
      },
      added: { journal: 2, feedback: 2 },
    });
    expect(hasProjectMemoryLedgerAcknowledgements({
      ...input,
      layer: "journal",
      keys: ["aaaaaaaaaaaaaaaa", "cccccccccccccccc"],
    })).toEqual(new Set(["aaaaaaaaaaaaaaaa"]));
    expect(hasProjectMemoryLedgerAcknowledgements({
      ...input,
      layer: "feedback",
      keys: ["event-a", "event-missing"],
    })).toEqual(new Set(["event-a"]));
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "journal" })).toBe(2);
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "feedback" })).toBe(2);
    expect(compareLedgerCursor("9223372036854775806", "9223372036854775807")).toBe(-1);

    const retry = commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "41",
      remoteAnchor: journalAnchor("41"),
      journalAcked: ["aaaaaaaaaaaaaaaa"],
      feedbackAcked: ["event-a"],
    });
    expect(retry.added).toEqual({ journal: 0, feedback: 0 });
    expect(retry.state.remoteCursor).toBe("9223372036854775806");
  });

  test("validates the complete transaction before changing cursor or acknowledgements", () => {
    const input = fixture();
    expect(() => commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "9",
      remoteAnchor: journalAnchor("9"),
      journalAcked: ["aaaaaaaaaaaaaaaa"],
      feedbackAcked: [""],
    })).toThrow(/feedback acknowledgement is invalid/);
    expect(readProjectMemoryLedgerState(input).remoteCursor).toBeNull();
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "journal" })).toBe(0);
  });

  test("a cache for one project or memory identity cannot be adopted by another", () => {
    const input = fixture();
    commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "42",
      remoteAnchor: journalAnchor("42"),
      journalAcked: ["aaaaaaaaaaaaaaaa"],
    });
    const other = fixture("memory-1");
    expect(projectMemoryLedgerStatePath(other)).not.toBe(projectMemoryLedgerStatePath(input));
    expect(readProjectMemoryLedgerState({ ...input, memoryId: "memory-2" }).remoteCursor).toBeNull();

    const path = projectMemoryLedgerStatePath(input);
    const db = new Database(path);
    db.query("UPDATE ledger_state SET memory_id = ? WHERE singleton = 1").run("memory-tampered");
    db.close();
    expect(readProjectMemoryLedgerState(input).remoteCursor).toBeNull();
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "journal" })).toBe(0);
  });

  test("a corrupt disposable database rebuilds empty and can be repopulated", () => {
    const input = fixture();
    commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "7",
      remoteAnchor: journalAnchor("7"),
      journalAcked: ["aaaaaaaaaaaaaaaa"],
    });
    writeFileSync(projectMemoryLedgerStatePath(input), "not-a-sqlite-database");

    expect(readProjectMemoryLedgerState(input).remoteCursor).toBeNull();
    expect(addProjectMemoryLedgerAcknowledgements({
      ...input,
      layer: "journal",
      keys: ["bbbbbbbbbbbbbbbb"],
    })).toEqual({ added: 1 });
  });

  test("upgrades a cursor-only v2 cache by replaying instead of trusting an anchorless cursor", () => {
    const input = fixture();
    const path = projectMemoryLedgerStatePath(input);
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE ledger_state (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        identity_hash TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        remote_cursor TEXT
      );
      CREATE TABLE ledger_ack (
        layer TEXT NOT NULL,
        ack_key TEXT NOT NULL,
        PRIMARY KEY(layer, ack_key)
      ) WITHOUT ROWID;
      INSERT INTO ledger_state VALUES (1, 2, 'old-identity', '${input.memoryId}', '99');
      INSERT INTO ledger_ack VALUES ('journal', 'aaaaaaaaaaaaaaaa');
      PRAGMA user_version = 2;
    `);
    db.close();

    expect(readProjectMemoryLedgerState(input)).toEqual({
      version: 3,
      memoryId: input.memoryId,
      remoteCursor: null,
      remoteAnchor: null,
    });
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "journal" })).toBe(0);
  });

  fileSymlinkTest("rejects database and cache-directory symlinks before opening them", () => {
    const input = fixture();
    readProjectMemoryLedgerState(input);
    const path = projectMemoryLedgerStatePath(input);
    const victim = join(dirname(input.root), "victim.sqlite");
    writeFileSync(victim, "do-not-touch");
    unlinkSync(path);
    symlinkSync(victim, path, "file");
    expect(() => readProjectMemoryLedgerState(input)).toThrow(/symbolic link/);
    expect(readFileSync(victim, "utf8")).toBe("do-not-touch");

    const second = fixture();
    mkdirSync(second.appDataDir, { recursive: true });
    const outside = join(dirname(second.root), "outside-cache");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(second.appDataDir, "project-memory-ledger"), directorySymlinkType);
    expect(() => readProjectMemoryLedgerState(second)).toThrow(/real directory/);
  });

  test("cache loss produces an idempotent resend state instead of false acknowledgement", () => {
    const input = fixture();
    commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "88",
      remoteAnchor: journalAnchor("88"),
      journalAcked: ["aaaaaaaaaaaaaaaa"],
      feedbackAcked: ["event-a"],
    });
    unlinkSync(projectMemoryLedgerStatePath(input));

    expect(readProjectMemoryLedgerState(input).remoteCursor).toBeNull();
    expect(hasProjectMemoryLedgerAcknowledgements({
      ...input,
      layer: "journal",
      keys: ["aaaaaaaaaaaaaaaa"],
    }).size).toBe(0);
    expect(commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "88",
      remoteAnchor: journalAnchor("88"),
      journalAcked: ["aaaaaaaaaaaaaaaa"],
      feedbackAcked: ["event-a"],
    }).added).toEqual({ journal: 1, feedback: 1 });
  });

  test("server Push sends only new journal rows and safely replays after cache loss", async () => {
    const input = fixture();
    appendProjectMemoryJournal(input.root, buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-28T00:00:00.000Z",
      narrative: "first durable session",
    }));
    const batchSizes: number[] = [];
    const sb = {
      from: () => ({
        upsert: async (rows: unknown[]) => {
          batchSizes.push(rows.length);
          return { error: null };
        },
      }),
    };
    const push = () => pushProjectMemoryJournal(sb, {
      ...input,
      projectName: "test project",
      deviceId: "device-1",
      deviceName: "Test Mac",
    });

    expect(await push()).toMatchObject({ journalPushed: 1, journalRemote: 1 });
    expect(await push()).toMatchObject({ journalPushed: 0, journalRemote: 1 });
    expect(batchSizes).toEqual([1]);

    // The remote unique key makes this replay harmless; the successful upsert
    // repopulates the disposable local acknowledgement table.
    unlinkSync(projectMemoryLedgerStatePath(input));
    expect(await push()).toMatchObject({ journalPushed: 1, journalRemote: 1 });
    expect(batchSizes).toEqual([1, 1]);

    appendProjectMemoryJournal(input.root, buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-28T00:01:00.000Z",
      narrative: "one new session",
    }));
    expect(await push()).toMatchObject({ journalPushed: 1, journalRemote: 2 });
    expect(batchSizes).toEqual([1, 1, 1]);
  });

  test("repairs a same-cardinality local journal regression before using the surviving cursor", async () => {
    const input = fixture("memory-local-regression");
    const first = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-01T00:00:00.000Z",
      narrative: "first remote session",
    });
    const second = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-02T00:00:00.000Z",
      narrative: "second remote session",
    });
    const replacement = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-03T00:00:00.000Z",
      narrative: "new local session after accidental restore",
    });
    appendProjectMemoryJournalBatch(input.root, [first, second]);
    commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "2",
      remoteAnchor: {
        seq: "2",
        layer: "journal",
        rowId: `${input.memoryId}:${second.entryHash}`,
      },
      journalAcked: [first.entryHash, second.entryHash],
    });

    // Simulate restoring the project folder to an older/incomplete copy while
    // the app-data SQLite cursor survives. Keep the same number of local keys so
    // a cardinality-only detector would miss the deleted first entry.
    rmSync(join(input.root, ".agent-memory", "journal"), { recursive: true, force: true });
    resetProjectMemoryJournalCache(input.root);
    appendProjectMemoryJournalBatch(input.root, [second, replacement]);

    const remoteRows = [first, second].map((entry, index) => ({
      seq: String(index + 1),
      layer: "journal",
      row_id: `${input.memoryId}:${entry.entryHash}`,
      payload: {
        memory_id: input.memoryId,
        entry_hash: entry.entryHash,
        recorded_at: entry.recordedAt,
        agent: entry.agent,
        head_commit: entry.headCommit,
        summary: entry.summary,
        body: entry.body,
      },
    }));
    const pushed: unknown[][] = [];
    const sb = {
      rpc: async (name: string, args: any) => {
        if (name === "portmgr_project_memory_ledger_cursor_status") {
          throw new Error("regression must reset before trusting the stale cursor");
        }
        const after = BigInt(args.p_after_seq);
        return { data: remoteRows.filter(row => BigInt(row.seq) > after), error: null };
      },
      from: () => ({
        upsert: async (rows: unknown[]) => {
          pushed.push(rows);
          return { error: null };
        },
      }),
    };

    const result = await syncProjectMemoryAppendOnlyLayers(sb, {
      ...input,
      projectName: "Recovery fixture",
      deviceId: "device-recovery",
      deviceName: "Recovery Mac",
    });
    expect(result).toMatchObject({
      ledgerRecovered: true,
      ledgerRecoveryReasons: ["local-ledger-regressed"],
      ledgerCursor: "2",
      journalPulled: 1,
      journalPushed: 1,
    });
    expect(readProjectMemoryJournal(input.root).map(entry => entry.entryHash).sort()).toEqual(
      [first.entryHash, second.entryHash, replacement.entryHash].sort(),
    );
    expect(pushed.flat()).toHaveLength(1);
    expect(readProjectMemoryLedgerState(input).remoteAnchor).toEqual({
      seq: "2",
      layer: "journal",
      rowId: `${input.memoryId}:${second.entryHash}`,
    });
  });

  test("detects a rewound Supabase cursor anchor and idempotently re-sends missing remote rows", async () => {
    const input = fixture("memory-remote-rewind");
    const first = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-01T00:00:00.000Z",
      narrative: "survives remote restore",
    });
    const second = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-02T00:00:00.000Z",
      narrative: "lost from restored remote",
    });
    appendProjectMemoryJournalBatch(input.root, [first, second]);
    commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "2",
      remoteAnchor: { seq: "2", layer: "journal", rowId: `${input.memoryId}:${second.entryHash}` },
      journalAcked: [first.entryHash, second.entryHash],
    });
    const remoteFirst = {
      seq: "1",
      layer: "journal",
      row_id: `${input.memoryId}:${first.entryHash}`,
      payload: {
        memory_id: input.memoryId,
        entry_hash: first.entryHash,
        recorded_at: first.recordedAt,
        agent: first.agent,
        head_commit: first.headCommit,
        summary: first.summary,
        body: first.body,
      },
    };
    const pushed: any[][] = [];
    const sb = {
      rpc: async (name: string, args: any) => {
        if (name === "portmgr_project_memory_ledger_cursor_status") {
          return { data: [{ cursor_valid: false, max_seq: "1" }], error: null };
        }
        return { data: args.p_after_seq === "0" ? [remoteFirst] : [], error: null };
      },
      from: () => ({
        upsert: async (rows: any[]) => {
          pushed.push(rows);
          return { error: null };
        },
      }),
    };

    const result = await syncProjectMemoryAppendOnlyLayers(sb, {
      ...input,
      projectName: "Remote rewind fixture",
      deviceId: "device-rewind",
      deviceName: "Rewind Mac",
    });
    expect(result).toMatchObject({
      ledgerRecovered: true,
      ledgerRecoveryReasons: ["remote-ledger-rewound"],
      ledgerCursor: "1",
      journalPushed: 1,
    });
    expect(pushed.flat().map(row => row.entry_hash)).toEqual([second.entryHash]);
  });

  test("repeatedly full-replays safely when a legacy database lacks cursor-status RPC", async () => {
    const input = fixture("memory-no-cursor-status");
    const entry = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-01T00:00:00.000Z",
      narrative: "legacy schema replay remains lossless",
    });
    appendProjectMemoryJournalBatch(input.root, [entry]);
    const feedback = appendProjectMemoryFeedback(input.root, {
      id: "feedback-legacy",
      memoryId: input.memoryId,
      entryKey: "a".repeat(24),
      contentVersionHash: "b".repeat(32),
      kind: "confirmed",
      evidence: "legacy feedback replay remains lossless",
      recordedAt: "2026-08-01T00:00:01.000Z",
    }).event;
    commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "2",
      remoteAnchor: { seq: "2", layer: "feedback", rowId: feedback.id },
      journalAcked: [entry.entryHash],
      feedbackAcked: [feedback.id],
    });
    const remoteRows = [{
      seq: "1",
      layer: "journal",
      row_id: `${input.memoryId}:${entry.entryHash}`,
      payload: {
        memory_id: input.memoryId,
        entry_hash: entry.entryHash,
        recorded_at: entry.recordedAt,
        agent: entry.agent,
        head_commit: entry.headCommit,
        summary: entry.summary,
        body: entry.body,
      },
    }, {
      seq: "2",
      layer: "feedback",
      row_id: feedback.id,
      payload: {
        id: feedback.id,
        origin_event_id: feedback.originEventId,
        memory_id: input.memoryId,
        entry_key: `${feedback.entryKey}:${feedback.contentVersionHash}`,
        kind: feedback.kind,
        evidence: feedback.evidence,
        device_id: feedback.deviceId,
        recorded_at: feedback.recordedAt,
      },
    }];
    const deltaCursors: string[] = [];
    let statusCalls = 0;
    const sb = {
      rpc: async (name: string, args: any) => {
        if (name === "portmgr_project_memory_ledger_cursor_status") {
          statusCalls += 1;
          return {
            data: null,
            error: {
              code: "PGRST202",
              message: "Could not find the function public.portmgr_project_memory_ledger_cursor_status",
            },
          };
        }
        deltaCursors.push(args.p_after_seq);
        return {
          data: remoteRows.filter(row => BigInt(row.seq) > BigInt(args.p_after_seq)),
          error: null,
        };
      },
      from: () => ({
        upsert: async () => ({ error: null }),
      }),
    };
    const sync = () => syncProjectMemoryAppendOnlyLayers(sb, {
      ...input,
      projectName: "Legacy cursor-status fixture",
      deviceId: "legacy-device",
      deviceName: "Legacy Mac",
    });

    const first = await sync();
    const second = await sync();

    for (const result of [first, second]) {
      expect(result).toMatchObject({
        ledgerRecovered: true,
        ledgerRecoveryReasons: ["cursor-status-unavailable"],
        ledgerCursor: "2",
        journalPulled: 0,
        feedbackPulled: 0,
        journalPushed: 0,
        feedbackPushed: 0,
      });
      expect(result.journalPullError).toContain("cursor 복구 RPC가 없어 전체 재동기화");
    }
    expect(statusCalls).toBe(2);
    expect(deltaCursors).toEqual(["0", "0"]);
    expect(readProjectMemoryJournal(input.root).map(item => item.entryHash)).toEqual([entry.entryHash]);
    expect(readProjectMemoryFeedback(input.root).map(item => item.id)).toEqual([feedback.id]);
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "journal" })).toBe(1);
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "feedback" })).toBe(1);
    expect(readProjectMemoryLedgerState(input).remoteAnchor).toEqual({
      seq: "2",
      layer: "feedback",
      rowId: feedback.id,
    });
  });

  test("production Push keeps a 25k journal local and bounded on cold and no-change runs", async () => {
    const input = fixture("memory-push-scale");
    const entries = Array.from({ length: 25_000 }, (_, index) => buildProjectMemoryJournalEntry({
      recordedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      narrative: `durable session ${index}`,
    }));
    expect(appendProjectMemoryJournalBatch(input.root, entries).appended).toBe(25_000);
    resetProjectMemoryJournalCache(input.root);
    Bun.gc(true);

    let selectCalls = 0;
    let batches = 0;
    let rowsSent = 0;
    let peakHeap = 0;
    let peakRss = 0;
    const sampleMemory = () => {
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
    };
    const sb = {
      from: () => ({
        select: () => {
          selectCalls += 1;
          throw new Error("production outbox must not enumerate every remote hash");
        },
        upsert: async (rows: unknown[]) => {
          batches += 1;
          rowsSent += rows.length;
          sampleMemory();
          return { error: null };
        },
      }),
    };
    const push = () => pushProjectMemoryJournal(sb, {
      ...input,
      projectName: "25k scale project",
      deviceId: "device-scale",
      deviceName: "Scale Mac",
    });

    const memoryBeforeCold = process.memoryUsage();
    peakHeap = memoryBeforeCold.heapUsed;
    peakRss = memoryBeforeCold.rss;
    const coldStarted = performance.now();
    const cold = await push();
    sampleMemory();
    const coldMs = performance.now() - coldStarted;
    const coldHeapGrowth = Math.max(0, peakHeap - memoryBeforeCold.heapUsed);
    const coldRssGrowth = Math.max(0, peakRss - memoryBeforeCold.rss);
    expect(cold).toMatchObject({ journalPushed: 25_000, journalRemote: 25_000 });
    expect(selectCalls).toBe(0);
    expect(batches).toBe(125);
    expect(rowsSent).toBe(25_000);

    const warmStarted = performance.now();
    const warm = await push();
    const warmMs = performance.now() - warmStarted;
    expect(warm).toMatchObject({ journalPushed: 0, journalRemote: 25_000 });
    expect(batches).toBe(125);

    resetProjectMemoryJournalCache(input.root);
    const coldNoChangeStarted = performance.now();
    const coldNoChange = await push();
    const coldNoChangeMs = performance.now() - coldNoChangeStarted;
    expect(coldNoChange).toMatchObject({ journalPushed: 0, journalRemote: 25_000 });
    expect(selectCalls).toBe(0);
    expect(batches).toBe(125);

    if (process.env.AGENTSTOZ_PERF_LOG === "1") {
      console.error(JSON.stringify({
        journalEntries: entries.length,
        coldMs: Math.round(coldMs),
        warmNoChangeMs: Math.round(warmMs),
        coldNoChangeMs: Math.round(coldNoChangeMs),
        coldPeakHeapMiB: Math.round(peakHeap / 1024 / 1024),
        coldRssGrowthMiB: Math.round(coldRssGrowth / 1024 / 1024),
      }));
    }
    expect(coldMs).toBeLessThan(15_000);
    expect(warmMs).toBeLessThan(2_500);
    expect(coldNoChangeMs).toBeLessThan(5_000);
    expect(coldHeapGrowth).toBeLessThan(256 * 1024 * 1024);
    expect(coldRssGrowth).toBeLessThan(256 * 1024 * 1024);
  }, 30_000);

  test("serializes one project ledger while different projects remain concurrent", async () => {
    const input = fixture();
    const other = fixture();
    const order: string[] = [];
    const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
    const first = withProjectMemoryLedgerLock(input, async () => {
      order.push("first:start");
      await wait(25);
      order.push("first:end");
    });
    const second = withProjectMemoryLedgerLock(input, async () => {
      order.push("second:start");
      order.push("second:end");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);

    let active = 0;
    let maximum = 0;
    const operation = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await wait(25);
      active -= 1;
    };
    await Promise.all([
      withProjectMemoryLedgerLock(input, operation),
      withProjectMemoryLedgerLock(other, operation),
    ]);
    expect(maximum).toBe(2);
  });

  test("keeps 50k acknowledgements compact and bounded on a no-change rerun", () => {
    const input = fixture();
    const journal = journalKeys(25_000);
    const feedback = feedbackKeys(25_000);
    const started = performance.now();
    const first = commitProjectMemoryLedgerState({
      ...input,
      remoteCursor: "50000",
      remoteAnchor: journalAnchor("50000", journal[0]!),
      journalAcked: journal,
      feedbackAcked: feedback,
    });
    const firstElapsed = performance.now() - started;
    expect(first.added).toEqual({ journal: 25_000, feedback: 25_000 });
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "journal" })).toBe(25_000);
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "feedback" })).toBe(25_000);
    expect(statSync(projectMemoryLedgerStatePath(input)).size).toBeLessThan(12 * 1024 * 1024);

    const rerunStarted = performance.now();
    const known = hasProjectMemoryLedgerAcknowledgements({
      ...input,
      layer: "journal",
      keys: journal,
    });
    const missing = journal.filter(key => !known.has(key));
    const retry = addProjectMemoryLedgerAcknowledgements({
      ...input,
      layer: "journal",
      keys: missing,
    });
    const rerunElapsed = performance.now() - rerunStarted;
    expect(known.size).toBe(25_000);
    expect(missing).toHaveLength(0);
    expect(retry.added).toBe(0);
    expect(firstElapsed).toBeLessThan(15_000);
    expect(rerunElapsed).toBeLessThan(5_000);

    const delta = journalKeys(10, 25_000);
    expect(addProjectMemoryLedgerAcknowledgements({
      ...input,
      layer: "journal",
      keys: delta,
    })).toEqual({ added: 10 });
    expect(countProjectMemoryLedgerAcknowledgements({ ...input, layer: "journal" })).toBe(25_010);
  }, 30_000);
});
