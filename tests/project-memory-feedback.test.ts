import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectMemoryFeedback,
  feedbackFile,
  parseProjectMemoryFeedbackStorageKey,
  projectMemoryFeedbackScopeKey,
  projectMemoryFeedbackStorageKey,
  projectMemoryPromotionState,
  readProjectMemoryFeedback,
  summarizeProjectMemoryFeedback,
} from "../src/projectMemoryFeedback";
import { canCreateFileSymlinks, directorySymlinkType } from "./fs-test-capabilities";

const fileSymlinkTest = canCreateFileSymlinks ? test : test.skip;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(join(tmpdir(), "agentstoz-feedback-"));
  roots.push(value);
  return value;
}

const base = {
  memoryId: "memory-1",
  entryKey: "0123456789abcdef01234567",
  recordedAt: "2026-08-12T00:00:00.000Z",
};

describe("project memory feedback ledger", () => {
  test("appends immutable events and deduplicates retries by event id", () => {
    const dir = root();
    const first = appendProjectMemoryFeedback(dir, { ...base, id: "event-1", kind: "applied", evidence: "  테스트   통과  " });
    const retry = appendProjectMemoryFeedback(dir, { ...base, id: "event-1", kind: "applied", evidence: "테스트 통과" });
    expect(first.appended).toBe(true);
    expect(retry.appended).toBe(false);
    expect(readProjectMemoryFeedback(dir)).toHaveLength(1);
    expect(readProjectMemoryFeedback(dir)[0]?.evidence).toBe("테스트 통과");
  });

  test("a corrupt trailing line does not erase prior evidence", () => {
    const dir = root();
    appendProjectMemoryFeedback(dir, { ...base, id: "event-1", kind: "confirmed" });
    appendFileSync(feedbackFile(dir), "{interrupted\n");
    expect(readProjectMemoryFeedback(dir).map(event => event.id)).toEqual(["event-1"]);
  });

  test("summaries are event-idempotent and feed promotion states", () => {
    const events = [
      { ...base, id: "a1", kind: "applied" as const },
      { ...base, id: "a2", kind: "applied" as const },
      { ...base, id: "c1", kind: "confirmed" as const },
      { ...base, id: "c2", kind: "confirmed" as const },
      { ...base, id: "c2", kind: "confirmed" as const },
    ];
    const summary = summarizeProjectMemoryFeedback(events)[base.entryKey]!;
    expect(summary).toEqual({ applied: 2, confirmed: 2, corrected: 0, contradicted: 0 });
    expect(projectMemoryPromotionState(summary)).toBe("active");
  });

  test("scopes new evidence to one content version while retaining legacy events as history", () => {
    const dir = root();
    const contentVersionHash = "a".repeat(32);
    const versioned = appendProjectMemoryFeedback(dir, {
      ...base,
      id: "versioned",
      kind: "confirmed",
      contentVersionHash,
    }).event;
    const legacy = appendProjectMemoryFeedback(dir, {
      ...base,
      id: "legacy",
      kind: "confirmed",
    }).event;
    const summaries = summarizeProjectMemoryFeedback([versioned, legacy]);
    const scope = projectMemoryFeedbackScopeKey(base.entryKey, contentVersionHash);

    expect(projectMemoryFeedbackStorageKey(versioned)).toBe(scope);
    expect(parseProjectMemoryFeedbackStorageKey(scope)).toEqual({ entryKey: base.entryKey, contentVersionHash });
    expect(summaries[scope]?.confirmed).toBe(1);
    expect(summaries[base.entryKey]?.confirmed).toBe(1);
  });

  test("negative evidence prevents silent promotion", () => {
    expect(projectMemoryPromotionState({ applied: 5, confirmed: 5, corrected: 0, contradicted: 1 })).toBe("contested");
    expect(projectMemoryPromotionState({ applied: 5, confirmed: 5, corrected: 1, contradicted: 1 })).toBe("superseded");
  });

  test("rejects malformed entry keys and kinds", () => {
    const dir = root();
    expect(() => appendProjectMemoryFeedback(dir, { ...base, entryKey: "bad", kind: "applied" })).toThrow(/항목 키/);
    expect(() => appendProjectMemoryFeedback(dir, { ...base, contentVersionHash: "bad", kind: "applied" })).toThrow(/본문 버전/);
    expect(() => appendProjectMemoryFeedback(dir, { ...base, kind: "wrong" as any })).toThrow(/피드백 종류/);
  });

  test("rejects a feedback directory symlink instead of consuming another project", () => {
    const dir = root();
    const outside = root();
    mkdirSync(join(dir, ".agent-memory"), { recursive: true });
    mkdirSync(join(outside, "feedback"), { recursive: true });
    writeFileSync(join(outside, "feedback", "events.jsonl"), `${JSON.stringify({
      ...base,
      id: "outside-event",
      kind: "confirmed",
    })}\n`);
    symlinkSync(join(outside, "feedback"), join(dir, ".agent-memory", "feedback"), directorySymlinkType);

    expect(() => readProjectMemoryFeedback(dir)).toThrow(/심볼릭 링크/);
    expect(() => appendProjectMemoryFeedback(dir, { ...base, id: "victim", kind: "applied" }))
      .toThrow(/심볼릭 링크/);
  });

  fileSymlinkTest("rejects a feedback file symlink before reading or appending", () => {
    const dir = root();
    const outside = root();
    mkdirSync(join(dir, ".agent-memory", "feedback"), { recursive: true });
    const outsideFile = join(outside, "outside.jsonl");
    writeFileSync(outsideFile, "");
    symlinkSync(outsideFile, join(dir, ".agent-memory", "feedback", "events.jsonl"), "file");

    expect(() => readProjectMemoryFeedback(dir)).toThrow(/심볼릭 링크/);
    expect(() => appendProjectMemoryFeedback(dir, { ...base, id: "victim", kind: "applied" }))
      .toThrow(/심볼릭 링크/);
  });

  test("rejects a symlink project root", () => {
    const dir = root();
    const aliasParent = root();
    const alias = join(aliasParent, "project");
    symlinkSync(dir, alias, directorySymlinkType);
    expect(() => readProjectMemoryFeedback(alias)).toThrow(/심볼릭 링크/);
    expect(() => appendProjectMemoryFeedback(alias, { ...base, id: "root-alias", kind: "applied" }))
      .toThrow(/심볼릭 링크/);
  });
});
