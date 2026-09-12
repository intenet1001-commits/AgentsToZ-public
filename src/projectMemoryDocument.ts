/**
 * Splits the curated memory into per-section notes with a generated index.
 *
 * The single-file design made every save regenerate the whole document, so its
 * runtime grew with its size and the size budget could only be enforced by
 * asking a model to count its own output bytes — which failed three runs in a
 * row (43,290 → 43,799 against a 42,000 budget). Decomposed, the always-loaded
 * file is an index of titles and a save can rewrite one note instead of all of
 * them, so "how big is the memory" stops being a per-run cost at all.
 *
 * The split is a pure partition of the original string: every byte lands in
 * exactly one part, in order. `composeMemoryDocument(splitMemoryDocument(x))`
 * is therefore `x` byte-for-byte, which is what lets Supabase push/pull,
 * revisions, conflict resolution and content hashing keep operating on the
 * whole document without knowing the layout changed.
 */

export interface MemoryDocumentSection {
  /** Section heading text, or null for the preamble above the first heading. */
  title: string | null;
  /** Verbatim slice of the source document, including its heading line. */
  text: string;
  /** `###` entry titles inside this section, for the index. */
  entries: string[];
}

export interface MemoryNotePart {
  file: string;
  title: string | null;
  entries: string[];
  bytes: number;
}

export interface MemoryNoteManifest {
  version: 1;
  parts: MemoryNotePart[];
}

export const MEMORY_NOTES_DIR_REL = ".agent-memory/notes";
export const MEMORY_MANIFEST_FILE = "manifest.json";

/** Below this the single file is cheaper to keep whole than to navigate. */
export const MEMORY_DECOMPOSE_THRESHOLD_BYTES = 24_000;
/** A note past this size is the one a save is asked to compact — never the whole file. */
export const MEMORY_NOTE_BUDGET_BYTES = 12_000;

const HEADER_PART_FILE = "00-header.md";

/** Line offsets of `## ` headings, ignoring fenced code blocks. */
function headingOffsets(content: string): number[] {
  const offsets: number[] = [];
  let fenced = false;
  let offset = 0;
  for (const line of content.split("\n")) {
    const fence = /^\s{0,3}(?:```|~~~)/.test(line);
    if (fence) fenced = !fenced;
    else if (!fenced && /^## (?!#)/.test(line)) offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function entryTitles(sectionText: string): string[] {
  const titles: string[] = [];
  let fenced = false;
  for (const line of sectionText.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = line.match(/^### (?!#)(.*)$/);
    if (match) titles.push(match[1]!.trim());
  }
  return titles;
}

/**
 * Partitions a memory document into its `##` sections.
 *
 * Contiguous by construction: part boundaries are the heading offsets, so the
 * slices rejoin into the original string with no separator of our own.
 */
export function splitMemoryDocument(content: string): MemoryDocumentSection[] {
  const offsets = headingOffsets(content);
  if (offsets.length === 0) {
    return [{ title: null, text: content, entries: entryTitles(content) }];
  }
  const sections: MemoryDocumentSection[] = [];
  if (offsets[0]! > 0) {
    const text = content.slice(0, offsets[0]);
    sections.push({ title: null, text, entries: entryTitles(text) });
  }
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]!;
    const end = i + 1 < offsets.length ? offsets[i + 1]! : content.length;
    const text = content.slice(start, end);
    const title = text.split("\n")[0]!.replace(/^## /, "").trim();
    sections.push({ title, text, entries: entryTitles(text) });
  }
  return sections;
}

export function composeMemoryDocument(parts: string[]): string {
  return parts.join("");
}

/** ASCII slug for a section title; non-Latin titles fall back to their position. */
export function memoryNoteFileName(title: string | null, index: number, taken: Set<string>): string {
  if (title === null) return HEADER_PART_FILE;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const base = slug || `section-${index}`;
  const prefix = String(index).padStart(2, "0");
  let file = `${prefix}-${base}.md`;
  let suffix = 2;
  while (taken.has(file)) {
    file = `${prefix}-${base}-${suffix}.md`;
    suffix += 1;
  }
  taken.add(file);
  return file;
}

export function buildMemoryNoteManifest(sections: MemoryDocumentSection[]): {
  manifest: MemoryNoteManifest;
  files: Array<{ file: string; text: string }>;
} {
  const taken = new Set<string>();
  const parts: MemoryNotePart[] = [];
  const files: Array<{ file: string; text: string }> = [];
  sections.forEach((section, index) => {
    const file = memoryNoteFileName(section.title, index, taken);
    parts.push({
      file,
      title: section.title,
      entries: section.entries,
      bytes: Buffer.byteLength(section.text, "utf8"),
    });
    files.push({ file, text: section.text });
  });
  return { manifest: { version: 1, parts }, files };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/**
 * The always-loaded view: the preamble verbatim, then every entry title with the
 * note that holds it. An agent can tell from this alone whether the answer it
 * needs exists and which single file to open for it.
 */
export function renderMemoryIndex(manifest: MemoryNoteManifest, headerText: string): string {
  const lines: string[] = [];
  lines.push(headerText.trimEnd(), "");
  lines.push(
    "<!-- 이 파일은 생성됩니다. 내용을 고치려면 .agent-memory/notes/ 안의 노트를 고치세요. -->",
    "",
    "## 목차",
    "",
    "필요한 항목이 보이면 해당 노트 **한 개만** 읽으세요. 전체를 읽을 필요는 없습니다.",
    "",
  );
  for (const part of manifest.parts) {
    if (part.title === null) continue;
    lines.push(`### ${part.title}`, "");
    lines.push(`\`${MEMORY_NOTES_DIR_REL}/${part.file}\` · ${part.entries.length}항목 · ${formatBytes(part.bytes)}`, "");
    for (const entry of part.entries) lines.push(`- ${entry}`);
    if (part.entries.length === 0) lines.push("- (비어 있음)");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** True when the section is large enough that the next save should compact it. */
export function selectMemoryNoteToCompact(manifest: MemoryNoteManifest): MemoryNotePart | null {
  let worst: MemoryNotePart | null = null;
  for (const part of manifest.parts) {
    if (part.title === null) continue;
    if (part.bytes <= MEMORY_NOTE_BUDGET_BYTES) continue;
    if (!worst || part.bytes > worst.bytes) worst = part;
  }
  return worst;
}
