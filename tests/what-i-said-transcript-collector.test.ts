import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug } from "../src/sessionTranscript";
import { runWhatISaidExplicitBackfill } from "../src/whatISaidExplicitBackfill";
import {
  collectWhatISaidTranscripts,
  exactWhatISaidWorktreeRoots,
  whatISaidCollectionScope,
} from "../src/whatISaidTranscriptCollector";
import {
  advanceWhatISaidScan,
  deriveWhatISaidTranscriptSourceId,
  enableWhatISaidCapture,
  listWhatISaidEntries,
  probeWhatISaidCollectionReadOnly,
  purgeWhatISaidEntries,
  readWhatISaidStatus,
  readWhatISaidTranscriptClassifications,
  readWhatISaidTranscriptCursor,
  setWhatISaidRetention,
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

  test("does not receipt Claude tool results or injected skill context, so an active session's scan stays complete", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const toolResult = (at: string, id: string) => ({
      type: "user", timestamp: at, toolUseResult: { stdout: "ok" },
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    });
    const skillBody = (at: string) => ({
      type: "user", isMeta: true, timestamp: at,
      message: { content: [{ type: "text", text: "Base directory for this skill: /tmp/skill" }] },
    });
    const path = writeClaude(input.claudeProjectsDir, input.projectRoot, "tools.jsonl", [
      { type: "user", timestamp: "2026-08-30T10:01:00Z", message: { content: "실제 요청" } },
      { type: "assistant", timestamp: "2026-08-30T10:01:10Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      toolResult("2026-08-30T10:01:20Z", "t1"),
      skillBody("2026-08-30T10:01:30Z"),
      // A pasted image keeps the person's words in an array. It may be a request, so it stays a receipt.
      { type: "user", timestamp: "2026-08-30T10:01:40Z", message: { content: [
        { type: "text", text: "이 화면 봐줘" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ] } },
      // A tool result without a valid timestamp is still malformed.
      toolResult("not-a-timestamp", "t2"),
    ]);
    const collect = (now: string) => collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now });
    const receipt = () => probeWhatISaidCollectionReadOnly({
      ...input, scope: whatISaidCollectionScope({ ...input, worktreeRoots: [input.projectRoot] }),
    });

    expect(collect("2026-08-30T10:10:00Z")).toMatchObject({ stored: 1, withheld: 2, unreadable: 0, pendingFiles: 0, scanAdvanced: true });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:10:01Z" }).items.map(item => item.text)).toEqual(["실제 요청"]);
    expect(receipt()?.complete).toBe(false);

    // The session keeps working: only tool and injected rows arrive before the next scan.
    appendFileSync(path, `${[
      line({ ...toolResult("2026-08-30T10:11:00Z", "t3"), cwd: input.projectRoot }),
      line({ ...skillBody("2026-08-30T10:11:10Z"), cwd: input.projectRoot }),
    ].join("\n")}\n`);
    utimesSync(path, new Date("2026-08-30T12:06:00Z"), new Date("2026-08-30T12:06:00Z"));
    expect(collect("2026-08-30T10:12:00Z")).toMatchObject({ stored: 0, withheld: 0, unreadable: 0, pendingFiles: 0, scanAdvanced: true });
    expect(receipt()?.complete).toBe(true);
  });

  test("keeps the words of a typed Claude slash command but not bare, host or model-invoked commands", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const user = (at: string, content: string, extra: Record<string, unknown> = {}) => ({ type: "user", timestamp: at, message: { content }, ...extra });
    writeClaude(input.claudeProjectsDir, input.projectRoot, "commands.jsonl", [
      user("2026-08-30T10:01:00Z", "<command-message>agentstoz-unfinished-work</command-message>\n<command-name>/agentstoz-unfinished-work</command-name>\n<command-args>핸드오프 확인하고 진행하자</command-args>"),
      user("2026-08-30T10:02:00Z", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
      user("2026-08-30T10:03:00Z", "<command-message>remember-session</command-message>\n<command-name>/remember-session</command-name>"),
      user("2026-08-30T10:04:00Z", "<command-message>workflow-authoring</command-message>\n<command-name>workflow-authoring</command-name>\n<command-args>model words</command-args>", { isMeta: true }),
      user("2026-08-30T10:05:00Z", "<command-name>/review</command-name><command-args>a</command-args> trailing text"),
      user("2026-08-30T10:06:00Z", "<command-name>/review</command-name><command-args>a</command-args><command-args>b</command-args>"),
      user("2026-08-30T10:07:00Z", "<local-command-stdout>output</local-command-stdout>"),
      user("2026-08-30T10:08:00Z", "<command-name>/figma:figma-use</command-name>\n<command-args>버튼 만들어줘</command-args>", { isSidechain: true }),
    ]);
    const collect = (now: string) => collectWhatISaidTranscripts({
      ...input,
      worktreeRoots: [input.projectRoot],
      promptOrigin: (_text, _recordedAt, delivery) => delivery === "user-message" ? "human" : "unknown",
      now,
    });

    expect(collect("2026-08-30T10:10:00Z")).toMatchObject({ stored: 1, withheld: 0, unreadable: 0, pendingFiles: 0 });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T10:10:01Z" }).items.map(item => [item.text, item.promptOrigin]))
      .toEqual([["/agentstoz-unfinished-work 핸드오프 확인하고 진행하자", "human"]]);
    expect(collect("2026-08-30T10:11:00Z")).toMatchObject({ stored: 0, withheld: 0 });
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

  test("backfill resumes over multiple budgets without moving ordinary capture or duplicating records", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const file = writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", Array.from({ length: 120 }, (_, index) => ({
      type: "user", timestamp: "2026-08-29T08:00:00Z", message: { content: `old-${index}-${"x".repeat(500)}` },
    })));
    const common = { ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T12:10:00Z" };
    expect(collectWhatISaidTranscripts(common).stored).toBe(0);
    let remaining = true;
    let passes = 0;
    let stored = 0;
    while (remaining && passes++ < 30) {
      const result = collectWhatISaidTranscripts({ ...common, backfill: true, scanByteBudget: 8192 });
      remaining = result.hasMore;
      stored += result.stored;
      expect(result.unreadable).toBe(0);
    }
    expect(remaining).toBe(false);
    expect(passes).toBeGreaterThan(1);
    expect(stored).toBe(120);
    appendFileSync(file, line({ type: "user", cwd: input.projectRoot, timestamp: "2026-08-30T11:00:00Z", message: { content: "new prompt" } }) + "\n");
    expect(collectWhatISaidTranscripts(common).stored).toBe(1);
    expect(collectWhatISaidTranscripts({ ...common, backfill: true }).stored).toBe(0);
  });

  test("a single explicit request completes multiple actual backfill scan budgets", async () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", Array.from({ length: 30 }, (_, index) => ({
      type: "user", timestamp: "2026-08-29T08:00:00Z", message: { content: `single-${index}-${"x".repeat(500)}` },
    })));
    let passes = 0;
    const scan = await runWhatISaidExplicitBackfill(async () => {
      passes++;
      return collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T12:10:00Z", backfill: true, scanByteBudget: 4096 });
    }, { yieldControl: async () => {} });
    expect(passes).toBeGreaterThan(1);
    expect(scan).toMatchObject({ stored: 30, scanAdvanced: true, hasMore: false });
  });

  test("cooperative scan stop commits processed records and resumes without duplicates", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", Array.from({ length: 30 }, (_, index) => ({
      type: "user", timestamp: "2026-08-29T08:00:00Z", message: { content: `stop-${index}` },
    })));
    const common = { ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T12:10:00Z", backfill: true };
    let checks = 0;
    const partial = collectWhatISaidTranscripts({ ...common, scanShouldStop: () => ++checks > 9 });
    expect(partial.stored).toBeGreaterThan(0);
    expect(partial).toMatchObject({ hasMore: true, budgetExhausted: true, scanAdvanced: false });
    const completed = collectWhatISaidTranscripts(common);
    expect(completed).toMatchObject({ hasMore: false, scanAdvanced: true, duplicates: 0 });
    expect(partial.stored + completed.stored).toBe(30);
  });

  test("repeated bounded backfills advance past early Claude files and eventually reach Codex", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    for (let index = 0; index < 5; index++) writeClaude(input.claudeProjectsDir, input.projectRoot, `history-${index}.jsonl`, [{
      type: 'user', timestamp: '2026-08-29T08:00:00Z', message: { content: `claude-${index}` },
    }]);
    writeCodex(input.codexSessionsDir, 'codex.jsonl', input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: 'codex-history' },
    }]);
    let more = true;
    let passes = 0;
    while (more && passes++ < 30) {
      let checks = 0;
      const allCaptured = listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.length === 5;
      const result = collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z',
        backfill: true, scanShouldStop: () => !allCaptured && ++checks > 7 });
      expect(result.unreadable).toBe(0);
      more = result.hasMore;
    }
    expect(more).toBe(false);
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.map(item => item.text).sort())
      .toEqual(['claude-0', 'claude-1', 'claude-2', 'claude-3', 'claude-4', 'codex-history']);
  });

  test("repeated bounded backfills complete across many Codex files", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    for (let index = 0; index < 5; index++) writeCodex(input.codexSessionsDir, `history-${index}.jsonl`, input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `codex-${index}` },
    }]);
    let more = true;
    let passes = 0;
    while (more && passes++ < 30) {
      let checks = 0;
      const allCaptured = listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.length === 5;
      const result = collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z',
        backfill: true, scanShouldStop: () => !allCaptured && ++checks > 7 });
      expect(result.unreadable).toBe(0);
      more = result.hasMore;
    }
    expect(more).toBe(false);
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items).toHaveLength(5);
  });

  test("actively changing files, including foreign Codex sessions, do not starve other files", () => {
    for (const source of ['claude', 'codex'] as const) {
      const input = setup();
      enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
      const paths: string[] = [];
      for (let index = 0; index < 5; index++) {
        paths.push(source === 'claude'
          ? writeClaude(input.claudeProjectsDir, input.projectRoot, `active-${index}.jsonl`, [{ type: 'user', timestamp: '2026-08-29T08:00:00Z', message: { content: `baseline-${index}` } }])
          : writeCodex(input.codexSessionsDir, `active-${index}.jsonl`, input.projectRoot, [{ type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `baseline-${index}` } }]));
      }
      const foreign = source === 'codex' ? writeCodex(input.codexSessionsDir, 'foreign.jsonl', input.unrelatedRoot, []) : null;
      for (let pass = 0; pass < 150; pass++) {
        appendFileSync(paths[0]!, '\n');
        if (foreign) appendFileSync(foreign, '\n');
        let checks = 0;
        collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true, scanShouldStop: () => ++checks > 7 });
        if (listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.length === 5) break;
      }
      expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.map(item => item.text).sort())
        .toEqual(['baseline-0', 'baseline-1', 'baseline-2', 'baseline-3', 'baseline-4']);
    }
  });

  test("foreign Codex appends do not block completion, while changed ownership is rescanned", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    for (let index = 0; index < 5; index++) writeCodex(input.codexSessionsDir, `owned-${index}.jsonl`, input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `ours-${index}` },
    }]);
    const foreign = writeCodex(input.codexSessionsDir, 'foreign-active.jsonl', input.unrelatedRoot, []);
    const foreignId = deriveWhatISaidTranscriptSourceId({ ...input, agent: 'codex', sourceIdentity: realpathSync(foreign) });
    const common = { ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true };
    let changedOwnership = false;
    let complete = false;
    for (let pass = 0; pass < 100; pass++) {
      if (pass && !changedOwnership) appendFileSync(foreign, '\n');
      let checks = 0;
      const allCaptured = listWhatISaidEntries(common).items.some(item => item.text === 'newly-owned');
      const result = collectWhatISaidTranscripts({ ...common, scanShouldStop: () => !allCaptured && ++checks > 7 });
      if (!changedOwnership && readWhatISaidTranscriptClassifications({ ...input, sourceIds: [foreignId] })[foreignId]?.owned === false) {
        writeCodex(input.codexSessionsDir, 'foreign-active.jsonl', input.projectRoot, [{
          type: 'event_msg', timestamp: '2026-08-29T08:01:00Z', payload: { type: 'user_message', message: 'newly-owned' },
        }]);
        changedOwnership = true;
        continue;
      }
      if (!result.hasMore) { complete = true; break; }
    }
    expect(changedOwnership).toBe(true);
    expect(complete).toBe(true);
    expect(listWhatISaidEntries(common).items.map(item => item.text)).toContain('newly-owned');
  });

  test("continuous foreign Codex appends do not postpone completion", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    for (let index = 0; index < 5; index++) writeCodex(input.codexSessionsDir, `owned-${index}.jsonl`, input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `ours-${index}` },
    }]);
    const foreign = writeCodex(input.codexSessionsDir, 'foreign-active.jsonl', input.unrelatedRoot, []);
    let complete = false;
    for (let pass = 0; pass < 100; pass++) {
      appendFileSync(foreign, '\n');
      let checks = 0;
      const allCaptured = listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.length === 5;
      const result = collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true, scanShouldStop: () => !allCaptured && ++checks > 7 });
      if (!result.hasMore) { complete = true; break; }
    }
    expect(complete).toBe(true);
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items).toHaveLength(5);
  });

  test("Codex header snapshot and verification resume when their aggregate exceeds each byte budget", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    for (let index = 0; index < 15; index++) writeCodex(input.codexSessionsDir, `owned-budget-${index}.jsonl`, input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `budget-${index}` },
    }]);
    writeCodex(input.codexSessionsDir, 'foreign-budget.jsonl', input.unrelatedRoot, []);
    // Each call is a separate request: the verification must resume its saved
    // page instead of restarting, or a budget smaller than all headers never
    // reaches completion (2026-10-28: every request ended 'uncertain').
    let complete = false;
    const verified: number[] = [];
    for (let pass = 0; pass < 60; pass++) {
      const result = collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true, scanByteBudget: 1024 });
      expect(result.bytesRead).toBeLessThanOrEqual(1024);
      expect(result.bytesRead).toBeGreaterThan(0);
      expect(result.unreadable).toBe(0);
      expect(result.verificationUncertain).toBeUndefined();
      const cursor = readWhatISaidTranscriptCursor({ ...input, agent: 'codex', sourceIdentity: 'what-i-said-backfill-codex-snapshot-v1' });
      if (cursor?.fileIdentity.split(':')[1] === 'v') verified.push(cursor.lineNumber);
      if (!result.hasMore) { complete = result.scanAdvanced; break; }
    }
    expect(complete).toBe(true);
    expect(verified.length).toBeGreaterThan(1);
    expect(verified).toEqual([...verified].sort((left, right) => left - right));
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.map(item => item.text).sort())
      .toEqual(Array.from({ length: 15 }, (_, index) => `budget-${index}`).sort());
  });

  test("Codex header snapshot checks cooperative stop and resumes its saved page", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    for (let index = 0; index < 5; index++) writeCodex(input.codexSessionsDir, `deadline-${index}.jsonl`, input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `deadline-${index}` },
    }]);
    let complete = false;
    const verified: number[] = [];
    for (let pass = 0; pass < 50; pass++) {
      let checks = 0;
      const result = collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true, scanShouldStop: () => ++checks > 7 });
      expect(result.unreadable).toBe(0);
      expect(result.verificationUncertain).toBeUndefined();
      const cursor = readWhatISaidTranscriptCursor({ ...input, agent: 'codex', sourceIdentity: 'what-i-said-backfill-codex-snapshot-v1' });
      if (cursor?.fileIdentity.split(':')[1] === 'v') verified.push(cursor.lineNumber);
      if (!result.hasMore) { complete = result.scanAdvanced; break; }
    }
    expect(complete).toBe(true);
    expect(verified.length).toBeGreaterThan(1);
    expect(verified).toEqual([...verified].sort((left, right) => left - right));
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items).toHaveLength(5);
  });

  test("a change after a verification page cannot be reported as complete", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    const files = Array.from({ length: 8 }, (_, index) => writeCodex(input.codexSessionsDir, `race-${index}.jsonl`, input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `race-${index}` },
    }]));
    const sorted = files.map(file => ({ file, id: deriveWhatISaidTranscriptSourceId({ ...input, agent: 'codex', sourceIdentity: realpathSync(file) }) }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const common = { ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true };
    let observed = false;
    for (let pass = 0; pass < 100; pass++) {
      const result = collectWhatISaidTranscripts({ ...common, scanByteBudget: 512 });
      const cursor = readWhatISaidTranscriptCursor({ ...input, agent: 'codex', sourceIdentity: 'what-i-said-backfill-codex-snapshot-v1' });
      if (cursor?.fileIdentity.split(':')[1] === 'v' && cursor.lineNumber > 0) {
        expect(result).toMatchObject({ hasMore: true, scanAdvanced: false });
        appendFileSync(sorted[0]!.file, `${line({ type: 'event_msg', timestamp: '2026-08-29T08:01:00Z', payload: { type: 'user_message', message: 'after-page-check' } })}\n`);
        observed = true;
        break;
      }
    }
    expect(observed).toBe(true);
    // A new request may resume a verification only if the files it already
    // checked are unchanged. This one changed, so every file is re-verified
    // against the baseline and the mismatch restarts the cycle.
    const resuming = collectWhatISaidTranscripts(common);
    expect(resuming).toMatchObject({ snapshotChanged: true, hasMore: true, scanAdvanced: false });
    let complete = false;
    for (let pass = 0; pass < 5; pass++) {
      const result = collectWhatISaidTranscripts(common);
      if (!result.hasMore) { complete = true; break; }
    }
    expect(complete).toBe(true);
    expect(listWhatISaidEntries(common).items.map(item => item.text)).toContain('after-page-check');
  });

  test("too-small scan budget is reported while a long record fits the default budget", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    const text = 'long-message-' + 'x'.repeat(50_000);
    writeCodex(input.codexSessionsDir, 'long-record.jsonl', input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: text },
    }]);
    const common = { ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true };
    const tooSmall = collectWhatISaidTranscripts({ ...common, scanByteBudget: 32 });
    expect(tooSmall).toMatchObject({ minimumBudgetInsufficient: true, hasMore: true, scanAdvanced: false });
    const normal = collectWhatISaidTranscripts(common);
    expect(normal).toMatchObject({ stored: 1, hasMore: false, scanAdvanced: true });
    expect(listWhatISaidEntries(common).items[0]?.text).toBe(text);
  });

  test("too-small scan budget is reported for a Claude record as well", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    const text = 'long-claude-message-' + 'x'.repeat(50_000);
    writeClaude(input.claudeProjectsDir, input.projectRoot, 'long-record.jsonl', [
      { type: 'user', timestamp: '2026-08-29T08:00:00Z', message: { content: text } },
    ]);
    const common = { ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true };
    const tooSmall = collectWhatISaidTranscripts({ ...common, scanByteBudget: 32 });
    expect(tooSmall).toMatchObject({ minimumBudgetInsufficient: true, hasMore: true, scanAdvanced: false, stored: 0 });
    const normal = collectWhatISaidTranscripts(common);
    expect(normal).toMatchObject({ stored: 1, hasMore: false, scanAdvanced: true });
    expect(normal.minimumBudgetInsufficient).toBeUndefined();
    expect(listWhatISaidEntries(common).items[0]?.text).toBe(text);
  });

  test("a later pass of the same request resumes verification while a checked foreign file keeps growing", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    for (let index = 0; index < 3; index++) writeCodex(input.codexSessionsDir, `owned-active-${index}.jsonl`, input.projectRoot, [{
      type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `active-${index}` },
    }]);
    // Other projects' live Codex sessions sit in every verification page.
    const foreign = Array.from({ length: 13 }, (_, index) => writeCodex(input.codexSessionsDir, `foreign-growing-${index}.jsonl`, input.unrelatedRoot, []));
    let complete = false;
    for (let pass = 0; pass < 60; pass++) {
      for (const file of foreign) appendFileSync(file, '\n');
      const result = collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z',
        backfill: true, backfillContinuation: pass > 0, scanByteBudget: 1024 });
      expect(result.unreadable).toBe(0);
      if (!result.hasMore) { complete = result.scanAdvanced; break; }
    }
    expect(complete).toBe(true);
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items).toHaveLength(3);
  });

  test("an old-dated message appended after its file was visited prevents false completion", () => {
    for (const source of ['claude', 'codex'] as const) {
      const input = setup();
      enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
      const paths = new Map<string, string>();
      for (let index = 0; index < 5; index++) {
        const name = `first-${index}`;
        paths.set(name, source === 'claude'
          ? writeClaude(input.claudeProjectsDir, input.projectRoot, `${name}.jsonl`, [{ type: 'user', timestamp: '2026-08-29T08:00:00Z', message: { content: name } }])
          : writeCodex(input.codexSessionsDir, `${name}.jsonl`, input.projectRoot, [{ type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: name } }]));
      }
      const common = { ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true };
      let checks = 0;
      let alreadyVisited: string | undefined;
      for (let pass = 0; pass < 30 && !alreadyVisited; pass++) {
        checks = 0;
        expect(collectWhatISaidTranscripts({ ...common, scanShouldStop: () => ++checks > 7 }).hasMore).toBe(true);
        alreadyVisited = listWhatISaidEntries(common).items[0]?.text;
      }
      expect(alreadyVisited).toBeDefined();
      const late = source === 'claude'
        ? { type: 'user', cwd: input.projectRoot, timestamp: '2026-08-29T08:01:00Z', message: { content: 'late-old-message' } }
        : { type: 'event_msg', timestamp: '2026-08-29T08:01:00Z', payload: { type: 'user_message', message: 'late-old-message' } };
      appendFileSync(paths.get(alreadyVisited!)!, `${line(late)}\n`);
      let complete = false;
      for (let pass = 0; pass < 30; pass++) {
        checks = 0;
        const lateCaptured = listWhatISaidEntries(common).items.some(item => item.text === 'late-old-message');
        const result = collectWhatISaidTranscripts({ ...common, scanShouldStop: () => !lateCaptured && ++checks > 7 });
        if (!result.hasMore) { complete = true; break; }
      }
      expect(complete).toBe(true);
      expect(listWhatISaidEntries(common).items.map(item => item.text)).toContain('late-old-message');
    }
  });

  test("new files do not reset the rotating start and existing files resume when additions settle", () => {
    for (const source of ['claude', 'codex'] as const) {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
    for (let index = 0; index < 5; index++) {
      if (source === 'claude') writeClaude(input.claudeProjectsDir, input.projectRoot, `original-${index}.jsonl`, [{
        type: 'user', timestamp: '2026-08-29T08:00:00Z', message: { content: `original-${index}` },
      }]);
      else writeCodex(input.codexSessionsDir, `original-${index}.jsonl`, input.projectRoot, [{
        type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message: `original-${index}` },
      }]);
    }
    const originals = ['original-0', 'original-1', 'original-2', 'original-3', 'original-4'];
    const collected = () => listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items.map(item => item.text).sort();
    let settledAt = -1;
    for (let pass = 0; pass < 100; pass++) {
      if (pass < 5 && source === 'claude') writeClaude(input.claudeProjectsDir, input.projectRoot, `new-${pass}.jsonl`, [{ type: 'assistant', message: { content: 'no user message' } }]);
      else if (pass < 5) writeCodex(input.codexSessionsDir, `new-${pass}.jsonl`, input.unrelatedRoot, []);
      let checks = 0;
      collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: '2026-08-30T12:10:00Z', backfill: true, scanShouldStop: () => ++checks > 7 });
      // Still at most 100 budget-7 passes, but stop once the fifth new file is in and every original was collected.
      if (pass >= 4 && JSON.stringify(collected()) === JSON.stringify(originals)) { settledAt = pass; break; }
    }
    expect(settledAt).toBeGreaterThanOrEqual(4);
    expect(collected()).toEqual(originals);
    }
  });

  test("explicit backfill revisits expired transcript entries after retention expands", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: 30, now: "2026-08-30T10:00:00Z" });
    writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", [{
      type: "user", timestamp: "2026-06-01T08:00:00Z", message: { content: "old request" },
    }]);
    const common = { ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T12:10:00Z" };
    expect(collectWhatISaidTranscripts({ ...common, backfill: true })).toMatchObject({ stored: 0, skippedExpired: 1, hasMore: false });
    setWhatISaidRetention({ ...input, retention: "forever", now: "2026-08-30T12:11:00Z" });
    expect(collectWhatISaidTranscripts({ ...common, now: "2026-08-30T12:12:00Z", backfill: true })).toMatchObject({ stored: 1, hasMore: false });
    expect(listWhatISaidEntries({ ...input, now: "2026-08-30T12:13:00Z" }).items.map(item => item.text)).toEqual(["old request"]);
  });

  test("backfill tracks file replacement with the same generation as ordinary capture", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const record = (text: string, timestamp = "2026-08-29T08:00:00Z") => ({ type: "user", timestamp, message: { content: text } });
    const file = writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", [record("original")]);
    const common = { ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T12:10:00Z" };
    expect(collectWhatISaidTranscripts({ ...common, backfill: true }).stored).toBe(1);
    renameSync(file, `${file}.old`);
    writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", [record("replacement", "2026-08-30T11:00:00Z")]);
    expect(collectWhatISaidTranscripts({ ...common, backfill: true }).stored).toBe(1);
    expect(collectWhatISaidTranscripts(common).stored).toBe(0);
    expect(listWhatISaidEntries(common).items.map(item => item.text).sort()).toEqual(["original", "replacement"]);
  });

  test("backfill detects same-inode rewriting even when regular capture has not advanced", () => {
    const input = setup();
    enableWhatISaidCapture({ ...input, retention: "forever", now: "2026-08-30T10:00:00Z" });
    const record = (text: string, timestamp = "2026-08-29T08:00:00Z") => ({ type: "user", timestamp, message: { content: text } });
    const file = writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", [record("first-old-value")]);
    const common = { ...input, worktreeRoots: [input.projectRoot], now: "2026-08-30T12:10:00Z" };
    expect(collectWhatISaidTranscripts({ ...common, backfill: true }).stored).toBe(1);
    const inode = statSync(file).ino;
    writeClaude(input.claudeProjectsDir, input.projectRoot, "history.jsonl", [record("other-old-value", "2026-08-30T11:00:00Z")]);
    expect(statSync(file).ino).toBe(inode);
    expect(collectWhatISaidTranscripts({ ...common, backfill: true }).stored).toBe(1);
    expect(collectWhatISaidTranscripts(common).stored).toBe(0);
    expect(listWhatISaidEntries(common).items.map(item => item.text).sort()).toEqual(["first-old-value", "other-old-value"]);
  });
});

function advanceForFixture(input: ReturnType<typeof setup>, scannedThrough: string): void {
  advanceWhatISaidScan({ ...input, scannedThrough });
}
