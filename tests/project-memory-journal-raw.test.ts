import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectMemoryJournal,
  buildProjectMemoryJournalEntry,
  readProjectMemoryJournal,
  CURRENT_MEMORY_AGENT_VERSION,
} from "../project-memory-server";

const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
const api = readFileSync(join(import.meta.dir, "..", "api-server.ts"), "utf8");

describe("a journal body may contain anything", () => {
  let root = "";
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "agentstoz-journal-raw-")); });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  // The body is agent-written prose once narratives exist. A markdown heading in
  // it used to be read as the start of a new entry, so everything after it was
  // dropped on read — and since the reader also feeds Push, the truncation
  // reached Supabase. Silent loss inside the layer that exists not to lose.
  const trickyBody = [
    "## Key Decisions 정리",
    "",
    "<!-- entry:deadbeef -->",
    "## 2099-01-01T00:00:00.000Z · claude · badcafe",
    "delimiter처럼 보이는 두 줄도 본문이어야 한다",
    "",
    "```md",
    "## 코드블록 안의 제목",
    "```",
    "마지막 줄까지 남아야 한다",
  ].join("\n");

  test("a heading inside the body does not split the entry", () => {
    const entry = buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-09T10:00:00.000Z",
      narrative: trickyBody,
      commits: ["abc1234 fix: x"],
    });
    appendProjectMemoryJournal(root, entry);

    const read = readProjectMemoryJournal(root);
    expect(read.length).toBe(1);
    expect(read[0]!.body).toContain("delimiter처럼 보이는 두 줄도 본문이어야 한다");
    expect(read[0]!.body).toContain("<!-- entry:deadbeef -->");
    expect(read[0]!.body).toContain("마지막 줄까지 남아야 한다");
    expect(read[0]!.body).toContain("코드블록 안의 제목");
    expect(read[0]!.entryHash).toBe(entry.entryHash);
  });

  test("two such entries stay two entries", () => {
    appendProjectMemoryJournal(root, buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-09T11:00:00.000Z",
      narrative: "## 또 다른 제목\n본문",
    }));
    expect(readProjectMemoryJournal(root).length).toBe(2);
  });

  test("new records encode the full entry in one inert v2 frame", () => {
    const render = source.slice(source.indexOf("export function renderProjectMemoryJournalEntry"));
    expect(render).toContain("entry-v2:");
    expect(render).toContain('toString("base64url")');
    const reader = source.slice(source.indexOf("export function readProjectMemoryJournal"));
    expect(reader).toContain("JOURNAL_V2_FRAME");
    expect(reader).not.toContain("text.split(/^## /m)");
  });
});

describe("only new journal entries are uploaded", () => {
  const helper = source.slice(
    source.indexOf("async function pushProjectMemoryJournal"),
    source.indexOf("export async function pushProjectMemory(input: {"),
  );

  // Which entries are new is a set question. A positional "last pushed" marker
  // assumed the file only grows at the end — true until history reconstructed
  // from old revisions was inserted before it, at which point every backfilled
  // entry sorted ahead of the marker and was skipped forever, silently.
  test("new entries are decided by comparing hashes, not file position", () => {
    expect(helper).toContain('.select("entry_hash")');
    expect(helper).toContain("all.filter(entry => !remote.has(entry.entryHash))");
    expect(helper).not.toContain("all.slice(at + 1)");
  });

  // Guessing "already uploaded" loses history; a redundant send only wastes work.
  test("a failed lookup sends everything rather than assuming", () => {
    expect(helper).toContain("knownLookupError ? all :");
  });

  test("the payload carries hashes on the way in, never bodies", () => {
    expect(helper).toContain('.select("entry_hash")');
    expect(helper).not.toContain('.select("*")');
  });
});

describe("the session narrative reaches the journal", () => {
  test("the endpoint accepts it from body or query", () => {
    expect(api).toContain('const narrative = body.narrative ?? url.searchParams.get("narrative");');
    expect(api).toContain("markProjectMemoryRemembered({ folderPath, narrative })");
  });

  // Git already records what changed; only the session knows what was learned.
  test("the generated skill asks for what was learned, not what changed", () => {
    const skill = source.slice(source.indexOf("function rememberSessionSkillTemplate"));
    expect(skill).toContain("narrative");
    expect(skill).toContain("what was learned or decided");
    expect(skill).toContain('--data-urlencode "narrative=');
  });

  // A skill-template change never reaches installed projects without a bump.
  test("the agent version was bumped so installed projects pick it up", () => {
    expect(CURRENT_MEMORY_AGENT_VERSION).toBeGreaterThanOrEqual(6);
  });
});

describe("entries written before the marker moved still parse", () => {
  let legacyRoot = "";
  beforeAll(() => {
    legacyRoot = mkdtempSync(join(tmpdir(), "agentstoz-journal-legacy-"));
    mkdirSync(join(legacyRoot, ".agent-memory/journal"), { recursive: true });
    // Exactly what v149–v151 wrote: heading first, marker second.
    writeFileSync(join(legacyRoot, ".agent-memory/journal/2026-08.md"), [
      "# 세션 일지 2026-08",
      "",
      "## 2026-08-09T03:56:49.858Z · claude · ff90421",
      "<!-- entry:055af4bc147c2b5d -->",
      "",
      "기록할 변경 내역이 감지되지 않았습니다.",
      "",
      "## 2026-08-09T05:19:09.050Z · claude · 6aa2495",
      "<!-- entry:1f868d94e3100208 -->",
      "",
      "커밋:",
      "- 6aa2495 chore: bump to v151",
      "",
    ].join("\n"));
  });
  afterAll(() => { if (legacyRoot) rmSync(legacyRoot, { recursive: true, force: true }); });

  // Live failure on v152: every legacy entry parsed with an empty recordedAt,
  // Postgres rejected the batch, and one bad row blocked the whole upload.
  test("the timestamp survives the old layout", () => {
    const entries = readProjectMemoryJournal(legacyRoot);
    expect(entries.length).toBe(2);
    expect(entries[0]!.recordedAt).toBe("2026-08-09T03:56:49.858Z");
    expect(entries[1]!.recordedAt).toBe("2026-08-09T05:19:09.050Z");
    expect(entries.every(e => !Number.isNaN(Date.parse(e.recordedAt)))).toBe(true);
  });

  test("agent and head commit survive too", () => {
    const [first] = readProjectMemoryJournal(legacyRoot);
    expect(first!.agent).toBe("claude");
    expect(first!.headCommit).toBe("ff90421");
    expect(first!.body).toContain("기록할 변경 내역이");
  });

  test("an unparseable entry is skipped instead of blocking the batch", () => {
    const helper = source.slice(source.indexOf("async function pushProjectMemoryJournal"));
    expect(helper).toContain("Number.isNaN(Date.parse(entry.recordedAt))");
    expect(helper).toContain("건너뜀");
  });
});
