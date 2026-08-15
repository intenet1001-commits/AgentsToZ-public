import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");

function bodyOf(start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to > from ? to : undefined);
}

describe("journal backup does not depend on the curated file changing", () => {
  const push = bodyOf("export async function pushProjectMemory(input: {", "\nexport async function pullProjectMemory");

  // Caught in live verification: Push returned alreadySynced with journalPushed
  // undefined. The journal gains an entry on every remember while CORE.md only
  // changes on a consolidation, so the common case never reached Supabase — the
  // history existed on one machine, which is the exact loss this layer prevents.
  test("the already-synced path still returns the common append-only sync result", () => {
    const syncAt = push.indexOf("const appendOnlySync = { ...journalPull, ...journal, ...feedback };");
    const syncedAt = push.indexOf("if (latest?.content_hash === contentHash)");
    expect(syncAt).toBeGreaterThan(-1);
    expect(syncAt).toBeLessThan(syncedAt);
    const early = push.slice(syncedAt, push.indexOf("if (\n    latest &&", syncedAt));
    expect(early).toContain("alreadySynced: true");
    expect(early).toContain("...appendOnlySync");
  });

  test("new revisions and both conflict exits return the same append-only result", () => {
    expect(push.match(/pushProjectMemoryJournal\(sb, \{/g)?.length).toBe(1);
    expect(push.match(/\.\.\.appendOnlySync/g)?.length).toBe(4);
    expect(push).toContain("concurrentWrite: true");
  });

  const helper = bodyOf("async function pushProjectMemoryJournal(sb: any, input: {", "\nexport async function pushProjectMemory");

  test("re-sending every entry is idempotent rather than duplicating history", () => {
    expect(helper).toContain('onConflict: "memory_id,entry_hash"');
    expect(helper).toContain("ignoreDuplicates: true");
  });

  // A backup that already succeeded must not be reported as a failure.
  test("a journal failure is reported, never thrown", () => {
    expect(helper).toContain("journalError: error.message");
    expect(helper).toContain("catch (error: any)");
    expect(helper).not.toContain("throw ");
  });

  test("an empty journal is not an error", () => {
    expect(helper).toContain("if (!all.length) return { journalPushed: 0 };");
  });
});
