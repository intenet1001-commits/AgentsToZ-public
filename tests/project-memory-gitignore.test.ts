import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectMemory, markProjectMemoryRemembered, MEMORY_BUDGET_BYTES } from "../project-memory-server";

const GITIGNORE = ".agent-memory/.gitignore";

describe("what inside .agent-memory belongs in the repository", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agentstoz-memory-gitignore-"));
    initializeProjectMemory({ folderPath: root, projectName: "ignore-test", agent: "claude", autoBackup: false });
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  // The journal is the only copy of what happened if a consolidation drops
  // something, so it has to survive losing the machine.
  test("the journal is committed while volatile files are not", () => {
    const rules = readFileSync(join(root, GITIGNORE), "utf8");
    expect(rules).toContain("activity.json");
    expect(rules).not.toContain("activity-count");
    expect(rules).toContain("backups/");
    expect(rules).not.toMatch(/^journal\/?$/m);
    expect(rules).not.toMatch(/^CORE\.md$/m);
  });

  // Reaching into a repository's root .gitignore would edit a file the project
  // owns — and two of the user's projects have none, so it would mean creating
  // one. A nested file governs only this directory.
  test("the repository's own root .gitignore is left alone", () => {
    expect(() => readFileSync(join(root, ".gitignore"), "utf8")).toThrow();
  });

  // Found in live verification: mark-remembered creates the journal but does not
  // regenerate adapters, so the ignore rules were missing exactly when the first
  // committable file appeared. The user would have committed activity.json and
  // backups/ alongside their first journal entry.
  test("remembering alone is enough to get the ignore rules", () => {
    rmSync(join(root, GITIGNORE), { force: true });
    markProjectMemoryRemembered({ folderPath: root });
    expect(readFileSync(join(root, GITIGNORE), "utf8")).toContain("activity.json");
  });

  test("a user's own edits here are never overwritten", () => {
    const mine = "# 내가 직접 쓴 규칙\nsecret-notes.md\n";
    writeFileSync(join(root, GITIGNORE), mine);
    markProjectMemoryRemembered({ folderPath: root });
    expect(readFileSync(join(root, GITIGNORE), "utf8")).toBe(mine);
  });
});

describe("memory size budget", () => {
  // Merging two independently grown copies produced 39,270 bytes, and squeezing
  // below that would have meant deleting durable decisions — the one thing the
  // prompt forbids. A budget that can only be met by a forbidden action is the
  // wrong number, the same way 24,000 was.
  test("the budget is above the measured merged size", () => {
    expect(MEMORY_BUDGET_BYTES).toBeGreaterThanOrEqual(39_270);
  });

  // It still has to bound a full regeneration; the 1MB hard limit never did.
  test("the budget still bounds one regeneration", () => {
    expect(MEMORY_BUDGET_BYTES).toBeLessThan(100_000);
  });
});
