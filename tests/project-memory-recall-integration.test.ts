import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectMemoryJournal,
  buildProjectMemoryJournalEntry,
  initializeProjectMemory,
  recallProjectMemory,
} from "../project-memory-server";

describe("project-memory recall integration", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("keeps curated hits compatible and exposes journal only as historical evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-recall-project-"));
    const appDataDir = mkdtempSync(join(tmpdir(), "agentstoz-recall-appdata-"));
    roots.push(root, appDataDir);
    initializeProjectMemory({ folderPath: root, projectName: "Recall scale test", agent: "codex" });
    appendProjectMemoryJournal(root, buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-28T01:02:03.000Z",
      agent: "codex",
      narrative: "ledger delta cursor는 recorded_at 대신 ingestion sequence를 사용한다",
    }));

    const result = recallProjectMemory({
      folderPath: root,
      query: "ingestion sequence",
      limit: 5,
      appDataDir,
    });

    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.journalHits).toHaveLength(1);
    expect(result.journalHits[0]).toMatchObject({
      source: "journal",
      authority: "historical-evidence",
      caution: true,
      integrity: "verified",
      recordedAt: "2026-08-28T01:02:03.000Z",
    });
    expect(result.journalSearch.complete).toBe(true);
    // Initialization itself is durable journal evidence, followed by our entry.
    expect(result.journalSearch.indexedEntries).toBeGreaterThanOrEqual(2);
  });
});
