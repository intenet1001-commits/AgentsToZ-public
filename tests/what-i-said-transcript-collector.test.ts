import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug } from "../src/sessionTranscript";
import {
  collectWhatISaidTranscripts,
  exactWhatISaidWorktreeRoots,
} from "../src/whatISaidTranscriptCollector";
import {
  advanceWhatISaidScan,
  enableWhatISaidCapture,
  listWhatISaidEntries,
  purgeWhatISaidEntries,
  readWhatISaidStatus,
  readWhatISaidTranscriptClassifications,
} from "../src/whatISaidStore";

const temporaryRoots: string[] = [];
const KEY = Buffer.alloc(32, 0x51);

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function line(value: unknown): string {
  return JSON.stringify(value);
}

function setup() {
  const parent = mkdtempSync(join(tmpdir(), "agentstoz-what-i-said-collector-"));
  temporaryRoots.push(parent);
  const projectRoot = join(parent, "main");
  const worktreeRoot = join(parent, "external-worktree");
  const unrelatedRoot = join(parent, "unrelated");
  const appDataDir = join(parent, "app-data");
  const claudeProjectsDir = join(parent, "claude-projects");
  const codexSessionsDir = join(parent, "codex-sessions");
  for (const path of [projectRoot, worktreeRoot, unrelatedRoot, appDataDir, claudeProjectsDir, codexSessionsDir]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    projectRoot,
    worktreeRoot,
    unrelatedRoot,
    appDataDir,
    claudeProjectsDir,
    codexSessionsDir,
    memoryId: "collector-memory",
    key: KEY,
  };
}

function writeClaude(base: string, root: string, file: string, records: unknown[]): string {
  const directory = join(base, claudeProjectSlug(root));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, file);
  writeFileSync(path, `${records.map(record => {
    if (record && typeof record === "object" && !Array.isArray(record)
      && ((record as any).type === "user" || (record as any).type === "assistant")
      && typeof (record as any).cwd !== "string") {
      return line({ ...(record as Record<string, unknown>), cwd: root });
    }
    return line(record);
  }).join("\n")}\n`);
  const fresh = new Date("2026-08-30T12:05:00Z");
  utimesSync(path, fresh, fresh);
  return path;
}

function writeCodex(base: string, file: string, cwd: string, records: unknown[]): string {
  const directory = join(base, "2026", "08", "30");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, file);
  writeFileSync(path, `${[
    line({ type: "session_meta", timestamp: "2026-08-30T11:50:00Z", payload: { cwd } }),
    ...records.map(line),
  ].join("\n")}\n`);
  const fresh = new Date("2026-08-30T12:05:00Z");
  utimesSync(path, fresh, fresh);
  return path;
}

describe("What-I-said transcript collector", () => {
  test('captures completed Codex UserMessage items once, withholding malformed items and excluding injected context', () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    writeCodex(input.codexSessionsDir, 'current-cli.jsonl', input.projectRoot, [
      { type: 'response_item', timestamp: '2026-08-30T12:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'system context' }] } },
      { type: 'event_msg', timestamp: '2026-08-30T12:00:01Z', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '실제 사용자가 한 말' }] } } },
      { type: 'event_msg', timestamp: '2026-08-30T12:00:02Z', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: null }] } } },
    ]);
    const collect = () => collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:20:00Z' });
    expect(collect()).toMatchObject({ stored: 1, withheld: 1 });
    expect(collect()).toMatchObject({ stored: 0, withheld: 0 });
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:21:00Z' }).items.map(item => item.text)).toEqual(['실제 사용자가 한 말']);
  });

  test('finds current Claude folders for Korean paths while rejecting colliding foreign cwd records', () => {
    const base = setup();
    const projectRoot = join(base.projectRoot, '한글');
    const foreignRoot = join(base.projectRoot, '다름');
    mkdirSync(projectRoot); mkdirSync(foreignRoot);
    const input = { ...base, projectRoot };
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    const modernSlug = projectRoot.replace(/[^a-zA-Z0-9-]/g, '-');
    expect(foreignRoot.replace(/[^a-zA-Z0-9-]/g, '-')).toBe(modernSlug);
    const dir = join(input.claudeProjectsDir, modernSlug); mkdirSync(dir);
    writeFileSync(join(dir, 'session.jsonl'), [projectRoot, foreignRoot].map(cwd => line({
      type: 'user', cwd, timestamp: '2026-08-30T12:00:00Z', message: { role: 'user', content: cwd === projectRoot ? '우리 프로젝트 요구사항' : '다른 프로젝트 비공개 말' },
    })).join('\n') + '\n');
    expect(collectWhatISaidTranscripts({ ...input, worktreeRoots: [projectRoot], now: '2026-08-30T12:20:00Z' }))
      .toMatchObject({ stored: 1, ownershipRejected: 1, unreadable: 0 });
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:21:00Z' }).items.map(item => item.text))
      .toEqual(['우리 프로젝트 요구사항']);
  });

  test('Codex ownership discovery stops at each header instead of spending the budget on unrelated bodies', () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    for (let index = 0; index < 40; index++) {
      const path = writeCodex(input.codexSessionsDir, `foreign-large-${index}.jsonl`, input.unrelatedRoot, []);
      appendFileSync(path, 'x'.repeat(300_000) + '\n');
    }
    writeCodex(input.codexSessionsDir, 'owned-small.jsonl', input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-30T12:00:00Z', payload: { type: 'user_message', message: '지금 워크룸에서 입력한 말' },
    }]);
    const result = collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:20:00Z' });
    expect(result).toMatchObject({ stored: 1, budgetExhausted: false, scanAdvanced: true });
    expect(result.bytesRead).toBeLessThan(200_000);
  });

  test("classifies over 10,000 transcripts in bounded batches and reuses the durable cache", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    for (let index = 0; index < 10_001; index += 1) {
      writeCodex(input.codexSessionsDir, `foreign-${index}.jsonl`, input.unrelatedRoot, []);
    }
    const owned = writeCodex(input.codexSessionsDir, "owned.jsonl", input.projectRoot, [{
      type: "event_msg", timestamp: "2026-08-30T12:01:00Z",
      payload: { type: "user_message", message: "배치 수집에도 보존되는 말" },
    }]);
    const collect = (now: string) => collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], gitTopLevel: () => null, now,
    });
    const started = performance.now();
    expect(collect("2026-08-30T12:20:00Z"))
      .toMatchObject({ stored: 1, unreadable: 0, hasMore: false, scanAdvanced: true });
    expect(Object.keys(readWhatISaidTranscriptClassifications(input))).toHaveLength(10_002);
    const coldMs = performance.now() - started;
    const warmStarted = performance.now();
    expect(collect("2026-08-30T12:21:00Z"))
      .toMatchObject({ bytesRead: 0, stored: 0, unreadable: 0, hasMore: false, scanAdvanced: true });
    const warmMs = performance.now() - warmStarted;
    // Actual fixture timings remain visible, but correctness does not depend
    // on a developer's filesystem speed or other running build processes.
    console.info(`[resource] transcript discovery: 10002 files; cold=${Math.round(coldMs)}ms warm=${Math.round(warmMs)}ms`);
    appendFileSync(owned, `${line({
      type: "event_msg", timestamp: "2026-08-30T12:22:00Z",
      payload: { type: "user_message", message: "캐시 이후 추가된 말" },
    })}\n`);
    utimesSync(owned, new Date("2026-08-30T12:22:00Z"), new Date("2026-08-30T12:22:00Z"));
    expect(collect("2026-08-30T12:23:00Z")).toMatchObject({ stored: 1, unreadable: 0 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T12:24:00Z" }).items.map(item => item.text))
      .toEqual(["배치 수집에도 보존되는 말", "캐시 이후 추가된 말"]);
  }, 30_000);

  test("collects user-only Claude and Codex events from exact git-listed roots", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });

    writeClaude(input.claudeProjectsDir, input.projectRoot, "main.jsonl", [
      { type: "user", timestamp: "2026-08-30T09:59:00Z", message: { content: "retroactive prompt" } },
      { type: "assistant", timestamp: "2026-08-30T11:57:00Z", message: { content: "assistant answer" } },
      { type: "user", timestamp: "2026-08-30T11:58:00Z", message: { content: "같은 사용자 말" } },
    ]);
    writeClaude(input.claudeProjectsDir, input.worktreeRoot, "worktree.jsonl", [
      { type: "user", timestamp: "2026-08-30T11:58:01Z", message: { content: "같은 사용자 말" } },
    ]);
    writeClaude(input.claudeProjectsDir, input.unrelatedRoot, "unrelated.jsonl", [
      { type: "user", timestamp: "2026-08-30T11:58:02Z", message: { content: "다른 저장소" } },
    ]);

    writeCodex(input.codexSessionsDir, "rollout-main.jsonl", join(input.projectRoot, "src"), [
      { type: "event_msg", timestamp: "2026-08-30T11:58:03Z", payload: { type: "user_message", message: "같은 사용자 말" } },
      { type: "event_msg", timestamp: "2026-08-30T11:58:04Z", payload: { type: "agent_message", message: "agent answer" } },
    ]);
    writeCodex(input.codexSessionsDir, "rollout-worktree.jsonl", input.worktreeRoot, [
      { type: "event_msg", timestamp: "2026-08-30T11:58:05Z", payload: { type: "user_message", message: "같은 사용자 말" } },
    ]);
    writeCodex(input.codexSessionsDir, "rollout-unrelated.jsonl", input.unrelatedRoot, [
      { type: "event_msg", timestamp: "2026-08-30T11:58:06Z", payload: { type: "user_message", message: "다른 저장소" } },
    ]);

    const first = collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot, input.worktreeRoot],
      promptOrigin: text => text === "같은 사용자 말" ? "agentstoz" : "human",
      now: "2026-08-30T12:00:00Z",
    });
    expect(first).toMatchObject({
      enabled: true,
      worktreeRoots: 2,
      claudeFiles: 2,
      codexFiles: 2,
      userEvents: 4,
      stored: 4,
      duplicates: 0,
      unreadable: 0,
      scannedFrom: "2026-08-30T10:00:00.000Z",
      scannedThrough: "2026-08-30T12:00:00.000Z",
      scanAdvanced: true,
    });
    const entries = listWhatISaidEntries({ ...input, now: "2026-08-30T12:00:01Z" }).items;
    expect(entries).toHaveLength(4);
    expect(entries.every(entry => entry.text === "같은 사용자 말")).toBe(true);
    expect(entries.every(entry => entry.agent === "claude" || entry.agent === "codex")).toBe(true);
    expect(entries.every(entry => entry.promptOrigin === "agentstoz")).toBe(true);

    // Five-minute overlap replays the 11:58 events. Stable source IDs make all
    // four retries no-ops while still protecting an event written just before a
    // prior scan checkpoint.
    const retry = collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot, input.worktreeRoot],
      now: "2026-08-30T12:02:00Z",
    });
    expect(retry).toMatchObject({
      stored: 0,
      duplicates: 0,
      userEvents: 0,
      scannedFrom: "2026-08-30T11:55:00.000Z",
      scanAdvanced: true,
    });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T12:02:01Z" }).items).toHaveLength(4);
  });

  test("quarantines permanent record failures and still captures the following prompt", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const path = writeClaude(input.claudeProjectsDir, input.projectRoot, "broken.jsonl", [
      { type: "user", timestamp: "2026-08-30T10:01:00Z", message: { content: "valid before broken row" } },
    ]);
    appendFileSync(path, [
      "not-json",
      line({
        type: "user",
        cwd: input.projectRoot,
        timestamp: "not-a-timestamp",
        message: { content: "invalid schema must not enter the store" },
      }),
      line({
        type: "user",
        cwd: input.projectRoot,
        timestamp: "2026-08-30T10:03:00Z",
        message: { content: "valid after broken rows" },
      }),
      "",
    ].join("\n"));
    const fresh = new Date("2026-08-30T12:05:00Z");
    utimesSync(path, fresh, fresh);

    const result = collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot],
      now: "2026-08-30T10:10:00Z",
    });
    expect(result).toMatchObject({
      stored: 2,
      withheld: 2,
      unreadable: 0,
      pendingFiles: 0,
      scanAdvanced: true,
    });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:10:01Z" }).items.map(item => item.text))
      .toEqual(["valid before broken row", "valid after broken rows"]);
    expect(readWhatISaidStatus(input).lastScanAt).toBe("2026-08-30T10:10:00.000Z");

    expect(collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot],
      now: "2026-08-30T10:11:00Z",
    })).toMatchObject({ stored: 0, withheld: 0, unreadable: 0, scanAdvanced: true });
  });

  test("skips a whole stale JSONL before reading historical content", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    advanceForFixture(input, "2026-08-30T12:00:00Z");
    const path = writeClaude(input.claudeProjectsDir, input.projectRoot, "stale.jsonl", [
      // Deliberately newer record metadata in an older file: mtime is the
      // authority for append-only skip, so this proves the file wasn't parsed.
      { type: "user", timestamp: "2026-08-30T12:01:00Z", message: { content: "must not be read" } },
    ]);
    const stale = new Date("2026-08-30T11:00:00Z");
    utimesSync(path, stale, stale);

    const result = collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot],
      now: "2026-08-30T12:02:00Z",
    });
    expect(result).toMatchObject({ scannedFrom: "2026-08-30T11:55:00.000Z", stored: 0, userEvents: 0 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T12:02:01Z" }).items).toEqual([]);
  });

  test("resumes from the durable byte cursor and captures only an appended prompt", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const path = writeCodex(input.codexSessionsDir, "append.jsonl", input.projectRoot, [
      { type: "event_msg", timestamp: "2026-08-30T10:01:00Z", payload: { type: "user_message", message: "first" } },
    ]);
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:02:00Z",
    })).toMatchObject({ stored: 1, duplicates: 0 });
    appendFileSync(path, `${line({
      type: "event_msg",
      timestamp: "2026-08-30T10:03:00Z",
      payload: { type: "user_message", message: "second" },
    })}\n`);
    const fresh = new Date("2026-08-30T12:06:00Z");
    utimesSync(path, fresh, fresh);
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:04:00Z",
    })).toMatchObject({ stored: 1, duplicates: 0, userEvents: 1 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:05:00Z" }).items.map(item => item.text))
      .toEqual(["first", "second"]);
  });

  test("revalidates cached Codex ownership after a same-inode truncate and regrow", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const path = writeCodex(input.codexSessionsDir, "rewritten.jsonl", input.projectRoot, [
      { type: "event_msg", timestamp: "2026-08-30T10:01:00Z", payload: { type: "user_message", message: "original owned" } },
    ]);
    const original = statSync(path);
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:02:00Z",
    })).toMatchObject({ stored: 1, unreadable: 0 });

    writeFileSync(path, `${[
      line({
        type: "session_meta",
        timestamp: "2026-08-30T10:02:30Z",
        payload: { cwd: input.unrelatedRoot, padding: "x".repeat(original.size + 128) },
      }),
      line({
        type: "event_msg",
        timestamp: "2026-08-30T10:03:00Z",
        payload: { type: "user_message", message: "foreign rewrite must stay out" },
      }),
    ].join("\n")}\n`);
    utimesSync(path, new Date("2026-08-30T12:07:00Z"), new Date("2026-08-30T12:07:00Z"));
    const foreign = statSync(path);
    expect(foreign.ino).toBe(original.ino);
    expect(foreign.size).toBeGreaterThanOrEqual(original.size);
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:04:00Z",
    })).toMatchObject({ stored: 0, unreadable: 0 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:04:01Z" }).items.map(item => item.text))
      .toEqual(["original owned"]);

    writeFileSync(path, `${[
      line({
        type: "session_meta",
        timestamp: "2026-08-30T10:04:30Z",
        payload: { cwd: input.projectRoot, padding: "y".repeat(foreign.size + 128) },
      }),
      line({
        type: "event_msg",
        timestamp: "2026-08-30T10:05:00Z",
        payload: { type: "user_message", message: "owned rewrite is collected" },
      }),
    ].join("\n")}\n`);
    utimesSync(path, new Date("2026-08-30T12:08:00Z"), new Date("2026-08-30T12:08:00Z"));
    const ownedAgain = statSync(path);
    expect(ownedAgain.ino).toBe(original.ino);
    expect(ownedAgain.size).toBeGreaterThanOrEqual(foreign.size);
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:06:00Z",
    })).toMatchObject({ stored: 1, unreadable: 0 });
    const texts = listWhatISaidEntries({ ...input, now: "2026-08-30T10:06:01Z" }).items.map(item => item.text);
    expect(texts).toContain("original owned");
    expect(texts).toContain("owned rewrite is collected");
    expect(texts).not.toContain("foreign rewrite must stay out");
  });

  test("does not revive a purged prompt when the transcript file generation is replaced", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const path = writeCodex(input.codexSessionsDir, "rotated.jsonl", input.projectRoot, [{
      type: "event_msg",
      timestamp: "2026-08-30T10:01:00Z",
      payload: { type: "user_message", message: "purged rotation prompt" },
    }]);
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:02:00Z",
    }).stored).toBe(1);
    const first = listWhatISaidEntries({ ...input, now: "2026-08-30T10:03:00Z" }).items[0]!;
    purgeWhatISaidEntries({ ...input, ids: [first.id], now: "2026-08-30T10:04:00Z" });

    const original = readFileSync(path);
    renameSync(path, `${path}.rotated`);
    writeFileSync(path, original);
    utimesSync(path, new Date("2026-08-30T12:07:00Z"), new Date("2026-08-30T12:07:00Z"));
    const replay = collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:05:00Z",
    });
    expect(replay).toMatchObject({ stored: 0, duplicates: 1, unreadable: 0 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:06:00Z" }).items).toEqual([]);
  });

  test("keeps a partial tail pending, then completes it without losing the next prompt", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const path = writeCodex(input.codexSessionsDir, "partial.jsonl", input.projectRoot, []);
    const record = line({
      type: "event_msg",
      timestamp: "2026-08-30T10:01:00Z",
      payload: { type: "user_message", message: "completed later" },
    });
    appendFileSync(path, record.slice(0, 25));
    utimesSync(path, new Date("2026-08-30T12:06:00Z"), new Date("2026-08-30T12:06:00Z"));
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:02:00Z",
    })).toMatchObject({ stored: 0, pendingFiles: 1, scanAdvanced: false });
    appendFileSync(path, `${record.slice(25)}\n${line({
      type: "event_msg",
      timestamp: "2026-08-30T10:03:00Z",
      payload: { type: "user_message", message: "next" },
    })}\n`);
    utimesSync(path, new Date("2026-08-30T12:07:00Z"), new Date("2026-08-30T12:07:00Z"));
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:04:00Z",
    })).toMatchObject({ stored: 2, pendingFiles: 0, unreadable: 0 });
  });

  test("round-robins Codex discovery so unrelated early candidates cannot starve the owned session", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    for (let index = 0; index < 12; index += 1) {
      const path = writeCodex(input.codexSessionsDir, `unrelated-${index}.jsonl`, input.unrelatedRoot, []);
      const header = line({
        type: "session_meta",
        timestamp: "2026-08-30T11:50:00Z",
        payload: { cwd: input.unrelatedRoot, padding: "x".repeat(520) },
      });
      writeFileSync(path, `${header}\n`);
      utimesSync(path, new Date("2026-08-30T12:05:00Z"), new Date("2026-08-30T12:05:00Z"));
    }
    writeCodex(input.codexSessionsDir, "owned.jsonl", input.projectRoot, [
      { type: "event_msg", timestamp: "2026-08-30T10:01:00Z", payload: { type: "user_message", message: "eventually owned" } },
    ]);

    let stored = false;
    for (let attempt = 0; attempt < 30 && !stored; attempt += 1) {
      const result = collectWhatISaidTranscripts({
        ...input,
        worktreeRoots: [input.projectRoot],
        scanByteBudget: 700,
        now: new Date(Date.parse("2026-08-30T10:02:00Z") + attempt * 1_000).toISOString(),
      });
      stored = result.stored === 1;
    }
    expect(stored).toBe(true);
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:40:00Z" }).items.map(item => item.text))
      .toEqual(["eventually owned"]);
  });

  test("receipts an oversized completed record and continues to the following prompt", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const path = writeCodex(input.codexSessionsDir, "oversized.jsonl", input.projectRoot, []);
    appendFileSync(path, `${"x".repeat(4 * 1024 * 1024 + 1)}\n${line({
      type: "event_msg",
      timestamp: "2026-08-30T10:01:00Z",
      payload: { type: "user_message", message: "after huge" },
    })}\n`);
    utimesSync(path, new Date("2026-08-30T12:06:00Z"), new Date("2026-08-30T12:06:00Z"));
    const result = collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:02:00Z",
    });
    expect(result).toMatchObject({ stored: 1, withheld: 1, unreadable: 0, pendingFiles: 0 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:03:00Z" }).items.map(item => item.text))
      .toEqual(["after huge"]);
  });

  test("persists discard state for an oversized partial record and resumes after its newline", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const path = writeCodex(input.codexSessionsDir, "oversized-partial.jsonl", input.projectRoot, []);
    appendFileSync(path, "x".repeat(4 * 1024 * 1024 + 1));
    utimesSync(path, new Date("2026-08-30T12:06:00Z"), new Date("2026-08-30T12:06:00Z"));
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:02:00Z",
    })).toMatchObject({ stored: 0, withheld: 1, unreadable: 0, pendingFiles: 0 });
    appendFileSync(path, `tail\n${line({
      type: "event_msg",
      timestamp: "2026-08-30T10:03:00Z",
      payload: { type: "user_message", message: "after partial huge" },
    })}\n`);
    utimesSync(path, new Date("2026-08-30T12:07:00Z"), new Date("2026-08-30T12:07:00Z"));
    expect(collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T10:04:00Z",
    })).toMatchObject({ stored: 1, unreadable: 0 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:05:00Z" }).items.map(item => item.text))
      .toEqual(["after partial huge"]);
  });

  test("uses each Claude row cwd to reject a lossy-slug collision", () => {
    const input = setup();
    const ownedRoot = join(input.projectRoot, "a-b");
    const collidingRoot = join(input.projectRoot, "a", "b");
    mkdirSync(ownedRoot, { recursive: true });
    mkdirSync(collidingRoot, { recursive: true });
    expect(claudeProjectSlug(ownedRoot)).toBe(claudeProjectSlug(collidingRoot));
    const scoped = { ...input, projectRoot: ownedRoot };
    enableWhatISaidCapture({ ...scoped, retention: "forever", now: "2026-08-30T10:00:00Z" });
    writeClaude(input.claudeProjectsDir, ownedRoot, "owned.jsonl", [
      { type: "user", cwd: ownedRoot, timestamp: "2026-08-30T10:01:00Z", message: { content: "owned" } },
    ]);
    writeClaude(input.claudeProjectsDir, collidingRoot, "collision.jsonl", [
      { type: "user", cwd: collidingRoot, timestamp: "2026-08-30T10:01:01Z", message: { content: "must stay out" } },
    ]);
    const result = collectWhatISaidTranscripts({
      ...scoped, worktreeRoots: [ownedRoot], now: "2026-08-30T10:02:00Z",
    });
    expect(result).toMatchObject({ stored: 1, ownershipRejected: 1, unreadable: 0 });
    expect(listWhatISaidEntries({ ...scoped, now: "2026-08-30T10:03:00Z" }).items.map(item => item.text))
      .toEqual(["owned"]);
  });

  test("parses exact worktree roots from the injected git porcelain result", () => {
    const input = setup();
    const roots = exactWhatISaidWorktreeRoots({
      projectRoot: input.projectRoot,
      gitWorktreeList: () => [
        `worktree ${input.projectRoot}`,
        "HEAD abc",
        "",
        `worktree ${input.worktreeRoot}`,
        "HEAD def",
        "",
      ].join("\n"),
    });
    expect(new Set(roots)).toEqual(new Set([input.projectRoot, input.worktreeRoot]));
    expect(roots).not.toContain(input.unrelatedRoot);
  });

  test("maps a monorepo memory to the same subpath in every worktree", () => {
    const input = setup();
    const mainProject = join(input.projectRoot, "apps", "product");
    const worktreeProject = join(input.worktreeRoot, "apps", "product");
    const mainOther = join(input.projectRoot, "apps", "other");
    const worktreeOther = join(input.worktreeRoot, "apps", "other");
    for (const path of [mainProject, worktreeProject, mainOther, worktreeOther]) {
      mkdirSync(path, { recursive: true });
    }
    const nested = { ...input, projectRoot: mainProject };
    enableWhatISaidCapture({ ...nested, retention: "forever", now: "2026-08-30T10:00:00Z" });

    writeClaude(input.claudeProjectsDir, mainProject, "main-product.jsonl", [
      { type: "user", timestamp: "2026-08-30T11:58:00Z", message: { content: "main product" } },
    ]);
    writeClaude(input.claudeProjectsDir, worktreeProject, "wt-product.jsonl", [
      { type: "user", timestamp: "2026-08-30T11:58:01Z", message: { content: "worktree product" } },
    ]);
    writeClaude(input.claudeProjectsDir, input.projectRoot, "broad-root.jsonl", [
      { type: "user", timestamp: "2026-08-30T11:58:02Z", message: { content: "whole repo must stay out" } },
    ]);
    writeCodex(input.codexSessionsDir, "main-product.jsonl", mainProject, [
      { type: "event_msg", timestamp: "2026-08-30T11:58:03Z", payload: { type: "user_message", message: "main product codex" } },
    ]);
    writeCodex(input.codexSessionsDir, "wt-product.jsonl", worktreeProject, [
      { type: "event_msg", timestamp: "2026-08-30T11:58:04Z", payload: { type: "user_message", message: "worktree product codex" } },
    ]);
    writeCodex(input.codexSessionsDir, "main-other.jsonl", mainOther, [
      { type: "event_msg", timestamp: "2026-08-30T11:58:05Z", payload: { type: "user_message", message: "main other must stay out" } },
    ]);
    writeCodex(input.codexSessionsDir, "wt-other.jsonl", worktreeOther, [
      { type: "event_msg", timestamp: "2026-08-30T11:58:06Z", payload: { type: "user_message", message: "worktree other must stay out" } },
    ]);

    const roots = exactWhatISaidWorktreeRoots({
      projectRoot: mainProject,
      worktreeRoots: [input.projectRoot, input.worktreeRoot],
      gitTopLevel: () => input.projectRoot,
    });
    expect(new Set(roots)).toEqual(new Set([mainProject, worktreeProject]));
    const collected = collectWhatISaidTranscripts({
      ...nested,
      worktreeRoots: [input.projectRoot, input.worktreeRoot],
      gitTopLevel: () => input.projectRoot,
      now: "2026-08-30T12:00:00Z",
    });
    expect(collected).toMatchObject({ worktreeRoots: 2, claudeFiles: 2, codexFiles: 2, stored: 4 });
    expect(listWhatISaidEntries({ ...nested, now: "2026-08-30T12:00:01Z" }).items.map(item => item.text).sort())
      .toEqual(["main product", "main product codex", "worktree product", "worktree product codex"]);
  });

  test("does not broaden a nested project when its lexical path uses an intermediate symlink", () => {
    if (process.platform === "win32") return;
    const input = setup();
    const realProject = join(input.projectRoot, "packages", "a");
    const worktreeProject = join(input.worktreeRoot, "packages", "a");
    mkdirSync(realProject, { recursive: true });
    mkdirSync(worktreeProject, { recursive: true });
    const aliasRoot = join(input.projectRoot, "..", "main-alias");
    symlinkSync(input.projectRoot, aliasRoot, "dir");
    const lexicalProject = join(aliasRoot, "packages", "a");

    const roots = exactWhatISaidWorktreeRoots({
      projectRoot: lexicalProject,
      worktreeRoots: [input.projectRoot, input.worktreeRoot],
      gitTopLevel: () => input.projectRoot,
    });
    expect(new Set(roots)).toEqual(new Set([lexicalProject, worktreeProject]));
    expect(roots).not.toContain(input.projectRoot);
    expect(roots).not.toContain(input.worktreeRoot);
  });
  test("an explicit backfill reaches past the consent instant; ordinary capture never does", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", [
      { type: "user", timestamp: "2026-08-29T08:00:00Z", message: { content: "어제 한 말" } },
      { type: "user", timestamp: "2026-08-30T09:59:00Z", message: { content: "켜기 직전에 한 말" } },
      { type: "user", timestamp: "2026-08-30T11:00:00Z", message: { content: "켠 뒤에 한 말" } },
    ]);

    // Turning capture on records the instant of consent, so the automatic pass
    // stores only what came after it. That is why 전체 저장 leaves a project
    // looking empty until its next session save.
    const automatic = collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot],
      now: "2026-08-30T12:00:00Z",
    });
    expect(automatic.stored).toBe(1);
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T12:00:01Z" }).items.map(entry => entry.text))
      .toEqual(["켠 뒤에 한 말"]);

    // The explicit 「지금까지의 기록 가져오기」 button, and only that, reaches back.
    const backfilled = collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot],
      backfill: true,
      now: "2026-08-30T12:05:00Z",
    });
    expect(backfilled.scannedFrom).toBe(new Date(0).toISOString());
    expect(backfilled.stored).toBe(2);
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T12:05:01Z" }).items.map(entry => entry.text).sort())
      .toEqual(["어제 한 말", "켜기 직전에 한 말", "켠 뒤에 한 말"].sort());

    // Idempotent: pressing it again stores nothing new.
    const again = collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot],
      backfill: true,
      now: "2026-08-30T12:06:00Z",
    });
    expect(again.stored).toBe(0);
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T12:06:01Z" }).items).toHaveLength(3);
  });
});

function advanceForFixture(input: ReturnType<typeof setup>, scannedThrough: string): void {
  advanceWhatISaidScan({ ...input, scannedThrough });
}
