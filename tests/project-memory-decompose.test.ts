import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  detectProjectMemory,
  initializeProjectMemory,
  markProjectMemoryRemembered,
  readMemoryDocument,
  writeMemoryDocument,
  extractSessionNarrative,
} from "../project-memory-server";
import { MEMORY_DECOMPOSE_THRESHOLD_BYTES } from "../src/projectMemoryDocument";
import { canCreateFileSymlinks, directorySymlinkType } from "./fs-test-capabilities";

setDefaultTimeout(30_000);

const fileSymlinkTest = canCreateFileSymlinks ? test : test.skip;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): { root: string; memoryPath: string } {
  const root = mkdtempSync(join(tmpdir(), "memory-decompose-"));
  temps.push(root);
  const status = initializeProjectMemory({ folderPath: root, projectName: "demo" });
  return { root: status.projectRoot, memoryPath: status.memoryPath! };
}

/** A document comfortably over the split threshold, with real section structure. */
function bigDocument(marker = "x"): string {
  const filler = `${marker.repeat(90)}\n`.repeat(110);
  return [
    "# Project Core Memory",
    "",
    "**Project**: demo",
    "",
    "## Key Decisions",
    "",
    "### First decision",
    filler,
    "### Second decision",
    filler,
    "## Recurring Issues",
    "",
    "### A repeated failure",
    filler,
  ].join("\n");
}

test("a small memory stays a single file", () => {
  const { root, memoryPath } = project();
  const doc = "# Project Core Memory\n\n## Key Decisions\n\n### One\nbody\n";
  writeMemoryDocument(root, memoryPath, doc);

  expect(existsSync(join(root, ".agent-memory/notes"))).toBe(false);
  expect(readFileSync(memoryPath, "utf8")).toBe(doc);
  expect(readMemoryDocument(root, memoryPath)).toBe(doc);
});

test("crossing the threshold splits into notes and leaves an index behind", () => {
  const { root, memoryPath } = project();
  const doc = bigDocument();
  expect(Buffer.byteLength(doc, "utf8")).toBeGreaterThan(MEMORY_DECOMPOSE_THRESHOLD_BYTES);

  writeMemoryDocument(root, memoryPath, doc);

  const notes = join(root, ".agent-memory/notes");
  expect(existsSync(join(notes, "manifest.json"))).toBe(true);
  expect(existsSync(join(notes, "01-key-decisions.md"))).toBe(true);
  expect(existsSync(join(notes, "02-recurring-issues.md"))).toBe(true);

  // The always-loaded file carries the titles but not the bodies.
  const index = readFileSync(memoryPath, "utf8");
  expect(index).toContain("- First decision");
  expect(index).toContain("- A repeated failure");
  expect(index).not.toContain("xxxxxxxx");
  expect(Buffer.byteLength(index, "utf8")).toBeLessThan(Buffer.byteLength(doc, "utf8") / 4);

  // …and the document is still readable as one unit, unchanged.
  expect(readMemoryDocument(root, memoryPath)).toBe(doc);
});

test("decomposition does not move the content hash sync decisions depend on", () => {
  const { root, memoryPath } = project();
  const doc = bigDocument();
  const expected = createHash("sha256").update(doc, "utf8").digest("hex");

  writeMemoryDocument(root, memoryPath, doc);
  const status = detectProjectMemory(root);

  expect(status.contentHash).toBe(expected);
  expect(status.size).toBe(Buffer.byteLength(doc, "utf8"));
});

test("a later save rewrites the notes and drops ones that no longer exist", () => {
  const { root, memoryPath } = project();
  writeMemoryDocument(root, memoryPath, bigDocument());
  expect(existsSync(join(root, ".agent-memory/notes/02-recurring-issues.md"))).toBe(true);

  // Same project, one section merged away. A stale note left on disk would be read
  // by anyone browsing the folder and contradict the index.
  const shrunk = "# Project Core Memory\n\n## Key Decisions\n\n### Only one left\nbody\n";
  writeMemoryDocument(root, memoryPath, shrunk);

  expect(existsSync(join(root, ".agent-memory/notes/02-recurring-issues.md"))).toBe(false);
  expect(readMemoryDocument(root, memoryPath)).toBe(shrunk);
});

test("a missing note is refused, never silently returned as a shorter document", () => {
  const { root, memoryPath } = project();
  writeMemoryDocument(root, memoryPath, bigDocument());
  unlinkSync(join(root, ".agent-memory/notes/01-key-decisions.md"));

  // Returning the remaining notes would push the truncation to Supabase on the
  // next backup, which is exactly the loss this layer exists to prevent.
  expect(() => readMemoryDocument(root, memoryPath)).toThrow(/notes\/01-key-decisions\.md/);
});

test("an unrelated file in notes/ is left alone", () => {
  const { root, memoryPath } = project();
  writeMemoryDocument(root, memoryPath, bigDocument());
  const keep = join(root, ".agent-memory/notes/README.txt");
  mkdirSync(join(root, ".agent-memory/notes"), { recursive: true });
  writeFileSync(keep, "hand-written");
  writeMemoryDocument(root, memoryPath, bigDocument("y"));
  expect(existsSync(keep)).toBe(true);
});

test("remembering rebuilds the index from whatever the notes now say", () => {
  const { root, memoryPath } = project();
  writeMemoryDocument(root, memoryPath, bigDocument());
  expect(readFileSync(memoryPath, "utf8")).not.toContain("- Added by the agent");

  // The skill tells an agent to edit the note, not the index. Nothing else rebuilds
  // the index from the notes, so without this the always-loaded file keeps
  // advertising the titles the memory had before the session.
  const note = join(root, ".agent-memory/notes/01-key-decisions.md");
  writeFileSync(note, `${readFileSync(note, "utf8")}\n### Added by the agent\nbody\n`);

  markProjectMemoryRemembered({ folderPath: root });

  const index = readFileSync(memoryPath, "utf8");
  expect(index).toContain("- Added by the agent");
  expect(readMemoryDocument(root, memoryPath)).toContain("### Added by the agent");
});

test("a broken note does not stop the session from being remembered", () => {
  const { root, memoryPath } = project();
  writeMemoryDocument(root, memoryPath, bigDocument());
  unlinkSync(join(root, ".agent-memory/notes/02-recurring-issues.md"));

  // Losing the session record over a derived file would be the worse failure.
  expect(() => markProjectMemoryRemembered({ folderPath: root })).not.toThrow();
});

test("nothing reads or writes the memory file behind the layout layer", () => {
  // A direct read returns only the index once a project is split, and pushing that
  // replaces the remote memory with a table of contents.
  const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
  const offenders = source
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /readFileSync\((local\.)?memoryPath|atomicWrite\((local\.)?memoryPath/.test(line))
    // The layout layer itself, and the one-time creation of a brand-new memory.
    .filter(({ line }) => !line.startsWith("if (!manifest) return readFileSync(memoryPath"))
    .filter(({ line }) => !line.startsWith("atomicWrite(memoryPath, content)"))
    .filter(({ line }) => !line.startsWith("atomicWrite(memoryPath, renderMemoryIndex"))
    .filter(({ line }) => !line.includes("initialMemory("));
  expect(offenders).toEqual([]);
});

test("the session narrative is read from the preamble only", () => {
  expect(extractSessionNarrative("SESSION: 노트 분해를 도입했다\n# Project Core Memory\nbody"))
    .toBe("노트 분해를 도입했다");
  expect(extractSessionNarrative("# Project Core Memory\n\nSESSION: this is content\n")).toBeNull();
  expect(extractSessionNarrative("# Project Core Memory\nbody")).toBeNull();
  expect(extractSessionNarrative("SESSION:   \n# Project Core Memory")).toBeNull();
});

fileSymlinkTest("a symlinked sourcePath cannot read or overwrite a file outside the project", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "memory-symlink-outside-"));
  temps.push(root, outside);
  const outsideFile = join(outside, "secret.md");
  writeFileSync(outsideFile, "DO NOT TOUCH");
  mkdirSync(join(root, ".agent-memory"), { recursive: true });
  const memoryPath = join(root, ".agent-memory/CORE.md");
  symlinkSync(outsideFile, memoryPath);

  expect(() => readMemoryDocument(root, memoryPath)).toThrow(/심볼릭 링크/);
  expect(() => writeMemoryDocument(root, memoryPath, "attacker write")).toThrow(/심볼릭 링크/);
  expect(readFileSync(outsideFile, "utf8")).toBe("DO NOT TOUCH");
});

fileSymlinkTest("a symlinked split note cannot exfiltrate an outside file", () => {
  const { root, memoryPath } = project();
  const outside = mkdtempSync(join(tmpdir(), "memory-note-outside-"));
  temps.push(outside);
  const outsideFile = join(outside, "secret.md");
  writeFileSync(outsideFile, "PRIVATE");
  writeMemoryDocument(root, memoryPath, bigDocument());
  const note = join(root, ".agent-memory/notes/01-key-decisions.md");
  unlinkSync(note);
  symlinkSync(outsideFile, note);

  expect(() => readMemoryDocument(root, memoryPath)).toThrow(/심볼릭 링크/);
});

test("a symlinked notes directory cannot redirect decomposition writes", () => {
  const { root, memoryPath } = project();
  const outside = mkdtempSync(join(tmpdir(), "memory-notes-outside-"));
  temps.push(outside);
  symlinkSync(outside, join(root, ".agent-memory/notes"), directorySymlinkType);

  expect(() => writeMemoryDocument(root, memoryPath, bigDocument())).toThrow(/심볼릭 링크/);
  expect(existsSync(join(outside, "manifest.json"))).toBe(false);
});
