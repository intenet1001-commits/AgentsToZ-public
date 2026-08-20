import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  splitMemoryDocument,
  composeMemoryDocument,
  buildMemoryNoteManifest,
  renderMemoryIndex,
  memoryNoteFileName,
  selectMemoryNoteToCompact,
  MEMORY_NOTE_BUDGET_BYTES,
} from "../src/projectMemoryDocument";

const roundTrip = (doc: string) => composeMemoryDocument(splitMemoryDocument(doc).map(s => s.text));

test("split is a partition: rejoining the parts reproduces the document byte-for-byte", () => {
  const doc = [
    "# Project Core Memory",
    "",
    "**Project**: demo",
    "",
    "## Key Decisions",
    "",
    "### Use hashes",
    "body",
    "",
    "## Recurring Issues",
    "",
    "### lsof needs -sTCP:LISTEN",
    "body",
    "",
  ].join("\n");
  expect(roundTrip(doc)).toBe(doc);

  const sections = splitMemoryDocument(doc);
  expect(sections.map(s => s.title)).toEqual([null, "Key Decisions", "Recurring Issues"]);
  expect(sections[1]!.entries).toEqual(["Use hashes"]);
});

test("round-trips documents with no preamble, no headings, and empty content", () => {
  expect(roundTrip("## Only\nbody\n")).toBe("## Only\nbody\n");
  expect(roundTrip("no headings at all\n")).toBe("no headings at all\n");
  expect(roundTrip("")).toBe("");
  expect(splitMemoryDocument("## Only\nbody\n").map(s => s.title)).toEqual(["Only"]);
});

test("a '## ' line inside a code fence is content, not a section boundary", () => {
  const doc = [
    "# Head",
    "",
    "## Real",
    "",
    "```md",
    "## Not a section",
    "### Not an entry",
    "```",
    "",
    "### Real entry",
    "",
  ].join("\n");
  const sections = splitMemoryDocument(doc);
  expect(sections.map(s => s.title)).toEqual([null, "Real"]);
  expect(sections[1]!.entries).toEqual(["Real entry"]);
  expect(roundTrip(doc)).toBe(doc);
});

test("'####' is not a section and '####' is not an entry", () => {
  const doc = "## S\n\n#### deeper\n\n### entry\n";
  const sections = splitMemoryDocument(doc);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.entries).toEqual(["entry"]);
});

test("note file names are stable, ordered, and collision-free", () => {
  const taken = new Set<string>();
  expect(memoryNoteFileName(null, 0, taken)).toBe("00-header.md");
  expect(memoryNoteFileName("Key Decisions", 1, taken)).toBe("01-key-decisions.md");
  expect(memoryNoteFileName("Key Decisions", 1, taken)).toBe("01-key-decisions-2.md");
  // A non-Latin title slugs to nothing; position keeps it addressable.
  expect(memoryNoteFileName("결정 사항", 2, taken)).toBe("02-section-2.md");
});

test("the index lists every entry title and points at exactly one note per section", () => {
  const doc = "# Head\n\nintro\n\n## Key Decisions\n\n### A\nx\n\n### B\ny\n";
  const sections = splitMemoryDocument(doc);
  const { manifest } = buildMemoryNoteManifest(sections);
  const index = renderMemoryIndex(manifest, sections[0]!.text);

  expect(index).toContain("# Head");
  expect(index).toContain(".agent-memory/notes/01-key-decisions.md");
  expect(index).toContain("- A");
  expect(index).toContain("- B");
  // The bodies stay out of the always-loaded file.
  expect(index).not.toContain("\nx\n");
});

test("compaction targets the single largest over-budget note, never the header", () => {
  const manifest = {
    version: 1 as const,
    parts: [
      { file: "00-header.md", title: null, entries: [], bytes: 999_999 },
      { file: "01-a.md", title: "A", entries: [], bytes: MEMORY_NOTE_BUDGET_BYTES + 1 },
      { file: "02-b.md", title: "B", entries: [], bytes: MEMORY_NOTE_BUDGET_BYTES + 500 },
      { file: "03-c.md", title: "C", entries: [], bytes: MEMORY_NOTE_BUDGET_BYTES },
    ],
  };
  expect(selectMemoryNoteToCompact(manifest)?.file).toBe("02-b.md");
  expect(selectMemoryNoteToCompact({ version: 1, parts: [manifest.parts[3]!] })).toBeNull();
});

test("the repository's own memory round-trips byte-for-byte", () => {
  // A synthetic fixture cannot prove this: the failure mode being guarded against
  // is a real document containing something the splitter mishandles.
  // `.agent-memory/` is gitignored, so a linked worktree has none — read the main
  // checkout's copy rather than letting the assertions silently no-op there.
  const here = join(import.meta.dir, "..", ".agent-memory");
  const main = join(import.meta.dir, "..", "..", "..", "..", ".agent-memory");
  const dir = existsSync(join(here, "CORE.md")) ? here : main;
  if (!existsSync(join(dir, "CORE.md"))) return;

  // Once this project is itself decomposed, CORE.md is an index — the document to
  // round-trip is the notes rejoined, which is exactly what the server reads.
  const manifestPath = join(dir, "notes", "manifest.json");
  const doc = existsSync(manifestPath)
    ? composeMemoryDocument(
        (JSON.parse(readFileSync(manifestPath, "utf8")).parts as Array<{ file: string }>)
          .map(part => readFileSync(join(dir, "notes", part.file), "utf8")),
      )
    : readFileSync(join(dir, "CORE.md"), "utf8");
  const sections = splitMemoryDocument(doc);
  expect(sections.length).toBeGreaterThan(3);
  expect(roundTrip(doc)).toBe(doc);
  // The repository may legitimately have only the initialized template. This
  // regression protects parsing/serialization, not a particular amount of
  // mutable local memory content.
  expect(sections.map(section => section.title)).toContain("Key Decisions");
});
