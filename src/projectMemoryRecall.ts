import { createHash } from "node:crypto";
import { projectMemoryFeedbackScopeKey, projectMemoryPromotionState } from "./projectMemoryFeedback";

export interface ProjectMemoryEntry {
  /** Stable logical identity. Explicit markers survive title/section changes. */
  entryId: string;
  /** Backward-compatible alias used by the v1 feedback/storage contract. */
  entryKey: string;
  /** Hash of normalized body content, deliberately separate from logical identity. */
  contentVersionHash: string;
  identitySource: "explicit" | "legacy";
  section: string;
  title: string;
  body: string;
  ordinal: number;
}

export interface ProjectMemoryFeedbackSummary {
  applied: number;
  confirmed: number;
  corrected: number;
  contradicted: number;
}

export interface ProjectMemoryRecallHit extends ProjectMemoryEntry {
  score: number;
  matchedTerms: string[];
  feedback: ProjectMemoryFeedbackSummary;
  feedbackBoost: number;
  promotionState: "candidate" | "active" | "contested" | "superseded";
  caution: boolean;
}

export interface ProjectMemoryQualityReport {
  score: number;
  entryCount: number;
  duplicateTitles: string[];
  emptyEntries: string[];
  oversizedEntries: Array<{ title: string; bytes: number }>;
  contestedEntries: number;
}

const EMPTY_FEEDBACK: ProjectMemoryFeedbackSummary = {
  applied: 0,
  confirmed: 0,
  corrected: 0,
  contradicted: 0,
};

const GENERIC_TERMS = new Set([
  "project", "memory", "work", "task", "session", "remember",
  "프로젝트", "기억", "작업", "세션", "내용", "관련", "장기기억",
]);

// Project memories commonly mix Korean prose with English identifiers and Git
// vocabulary. Keep this deliberately small and domain-specific: a general
// thesaurus would manufacture weak matches and defeat bounded recall.
const TERM_ALIASES: Record<string, string[]> = {
  "충돌": ["conflict"],
  "conflict": ["충돌"],
  "동기화": ["sync"],
  "sync": ["동기화"],
  "백업": ["backup"],
  "backup": ["백업"],
  "복원": ["restore"],
  "restore": ["복원"],
  "제약": ["constraint"],
  "constraint": ["제약"],
};

const CONSTRAINT_SECTION = /constraint|제약|규칙|원칙/i;
const CONTESTED_SECTION = /contest|논쟁|충돌|미확정|검토/i;
const CAUTION_TEXT = /미확정|검증되지|주의|금지|위험|충돌|사용자 검토/i;
const ENTRY_ID_MARKER = /^<!--\s*memory-entry-id:([0-9a-f]{24})\s*-->$/i;

interface MarkdownFence {
  marker: "`" | "~";
  openingLength: number;
}

function advanceMarkdownFence(
  line: string,
  fence: MarkdownFence | null,
): { fence: MarkdownFence | null; fenceLine: boolean } {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) return { fence, fenceLine: false };
  const sequence = match[1]!;
  const marker = sequence[0] as MarkdownFence["marker"];
  if (fence === null) {
    return { fence: { marker, openingLength: sequence.length }, fenceLine: true };
  }
  const closes = marker === fence.marker
    && sequence.length >= fence.openingLength
    && match[2]!.trim().length === 0;
  return { fence: closes ? null : fence, fenceLine: true };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function hashIdentity(value: string): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function legacyEntryId(section: string, title: string, occurrence: number): string {
  const base = `${normalize(section)}\n${normalize(title)}`;
  // Preserve the v1 key for the first occurrence so existing feedback remains
  // attributable. Only otherwise-colliding duplicate headings receive a suffix.
  return hashIdentity(occurrence === 0 ? base : `${base}\nduplicate:${occurrence}`);
}

function contentVersionHash(body: string): string {
  // Fail closed: normalize only platform line endings and canonical Unicode
  // composition. Case, compatibility characters, punctuation, paths, env names,
  // and trailing spaces in Markdown/code can all change meaning.
  const canonicalBody = body
    .normalize("NFC")
    .replace(/\r\n?/g, "\n");
  return createHash("sha256")
    .update(canonicalBody, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Gives legacy headings a stored identity exactly once. Existing markers are
 * preserved, duplicate legacy titles get distinct deterministic IDs, and code
 * examples are left byte-for-byte alone. When an AI drops a marker, the previous
 * document can recover it by location or exact content; explicit markers in the
 * new document always win. Body edits advance contentVersionHash.
 */
export function stabilizeProjectMemoryEntryIds(markdown: string, previousMarkdown?: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const nextEntries = parseProjectMemoryEntries(markdown);
  const reservedExplicitIds = new Set(
    nextEntries
      .filter(entry => entry.identitySource === "explicit")
      .map(entry => entry.entryId),
  );
  const previousEntries = previousMarkdown ? parseProjectMemoryEntries(previousMarkdown) : [];
  const previousByLocation = new Map<string, ProjectMemoryEntry[]>();
  const previousByContent = new Map<string, ProjectMemoryEntry[]>();
  for (const entry of previousEntries) {
    const location = `${normalize(entry.section)}\n${normalize(entry.title)}`;
    previousByLocation.set(location, [...(previousByLocation.get(location) ?? []), entry]);
    previousByContent.set(
      entry.contentVersionHash,
      [...(previousByContent.get(entry.contentVersionHash) ?? []), entry],
    );
  }
  const output: string[] = [];
  const occurrences = new Map<string, number>();
  const seenEntryIds = new Set<string>();
  const usedPreviousIds = new Set<string>();
  let section = "Unsectioned";
  let fence: MarkdownFence | null = null;
  let entryOrdinal = 0;

  const claimPrevious = (candidates: ProjectMemoryEntry[] | undefined): string | null => {
    const match = candidates?.find(entry => (
      !usedPreviousIds.has(entry.entryId)
      && !seenEntryIds.has(entry.entryId)
      && !reservedExplicitIds.has(entry.entryId)
    ));
    if (!match) return null;
    usedPreviousIds.add(match.entryId);
    return match.entryId;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    output.push(line);
    const fenceState = advanceMarkdownFence(line, fence);
    fence = fenceState.fence;
    if (fenceState.fenceLine) {
      continue;
    }
    if (fence !== null) continue;

    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    const titleMatch = line.match(/^###\s+(.+?)\s*$/);
    if (!titleMatch) continue;

    const title = titleMatch[1]!.trim();
    const nextEntry = nextEntries[entryOrdinal++];
    const legacyKey = `${normalize(section)}\n${normalize(title)}`;
    const occurrence = occurrences.get(legacyKey) ?? 0;
    occurrences.set(legacyKey, occurrence + 1);
    let nextContent = index + 1;
    while (nextContent < lines.length && !lines[nextContent]!.trim()) nextContent += 1;
    const marker = nextContent < lines.length
      ? lines[nextContent]!.trim().match(ENTRY_ID_MARKER)
      : null;
    if (marker) {
      const explicitId = marker[1]!.toLowerCase();
      if (!seenEntryIds.has(explicitId)) {
        seenEntryIds.add(explicitId);
        usedPreviousIds.add(explicitId);
        lines[nextContent] = `<!-- memory-entry-id:${explicitId} -->`;
        continue;
      }
    }

    let collision = occurrence;
    let nextEntryId = claimPrevious(previousByLocation.get(legacyKey))
      ?? claimPrevious(nextEntry ? previousByContent.get(nextEntry.contentVersionHash) : undefined)
      ?? legacyEntryId(section, title, collision);
    while (seenEntryIds.has(nextEntryId) || reservedExplicitIds.has(nextEntryId)) {
      collision += 1;
      nextEntryId = hashIdentity(`${legacyKey}\nidentity-collision:${collision}`);
    }
    seenEntryIds.add(nextEntryId);
    if (marker) lines[nextContent] = `<!-- memory-entry-id:${nextEntryId} -->`;
    else output.push(`<!-- memory-entry-id:${nextEntryId} -->`);
  }
  return output.join("\n");
}

function queryTerms(query: string): string[] {
  const terms = normalize(query)
    .split(/[\s,.;:!?()[\]{}"'`/\\|+=*&^%$#@~<>]+/)
    .map(term => term.trim())
    .filter(term => term.length >= 2 && !GENERIC_TERMS.has(term));
  return Array.from(new Set(terms)).slice(0, 24);
}

function termVariants(term: string): string[] {
  return [term, ...(TERM_ALIASES[term] ?? [])];
}

function containsTerm(text: string, term: string): boolean {
  return termVariants(term).some(variant => text.includes(variant));
}

/**
 * Parses level-2 sections and level-3 durable entries without treating headings
 * inside fenced code examples as real memory. Text before the first entry is not
 * an entry: metadata/preambles cannot accidentally become recall results.
 */
export function parseProjectMemoryEntries(markdown: string): ProjectMemoryEntry[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const entries: ProjectMemoryEntry[] = [];
  let section = "Unsectioned";
  let title: string | null = null;
  let body: string[] = [];
  let fence: MarkdownFence | null = null;
  const legacyOccurrences = new Map<string, number>();

  const flush = () => {
    if (title === null) return;
    const bodyLines = [...body];
    const firstContent = bodyLines.findIndex(line => line.trim().length > 0);
    const marker = firstContent >= 0 ? bodyLines[firstContent]!.trim().match(ENTRY_ID_MARKER) : null;
    if (marker && firstContent >= 0) bodyLines.splice(firstContent, 1);
    // Discard only structural blank lines around an entry. String.trim() would
    // erase indentation and trailing spaces that are meaningful in Markdown/code
    // and must therefore advance contentVersionHash.
    while (bodyLines.length > 0 && bodyLines[0]!.trim().length === 0) bodyLines.shift();
    while (bodyLines.length > 0 && bodyLines.at(-1)!.trim().length === 0) bodyLines.pop();
    const text = bodyLines.join("\n");
    const legacyKey = `${normalize(section)}\n${normalize(title)}`;
    const occurrence = legacyOccurrences.get(legacyKey) ?? 0;
    legacyOccurrences.set(legacyKey, occurrence + 1);
    const entryId = marker?.[1]?.toLowerCase() ?? legacyEntryId(section, title, occurrence);
    entries.push({
      entryId,
      entryKey: entryId,
      contentVersionHash: contentVersionHash(text),
      identitySource: marker ? "explicit" : "legacy",
      section,
      title,
      body: text,
      ordinal: entries.length,
    });
    title = null;
    body = [];
  };

  for (const line of lines) {
    const fenceState = advanceMarkdownFence(line, fence);
    fence = fenceState.fence;
    if (fenceState.fenceLine) {
      if (title !== null) body.push(line);
      continue;
    }
    if (fence !== null) {
      if (title !== null) body.push(line);
      continue;
    }
    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1]!.trim();
      continue;
    }
    const titleMatch = line.match(/^###\s+(.+?)\s*$/);
    if (titleMatch) {
      flush();
      title = titleMatch[1]!.trim();
      continue;
    }
    if (title !== null) body.push(line);
  }
  flush();
  return entries;
}

function boundedFeedbackBoost(feedback: ProjectMemoryFeedbackSummary): number {
  // Logarithmic evidence: the 500th confirmation must not matter as much as the
  // first. Corrections and contradictions outweigh confirmations because stale
  // confidence is more dangerous than missing a small positive boost.
  const positive = Math.log2(1 + Math.max(0, feedback.confirmed)) * 3
    + Math.log2(1 + Math.max(0, feedback.applied)) * 1.2;
  const negative = Math.log2(1 + Math.max(0, feedback.corrected)) * 5
    + Math.log2(1 + Math.max(0, feedback.contradicted)) * 9;
  return Math.max(-24, Math.min(24, positive - negative));
}

export function recallProjectMemoryEntries(
  markdown: string,
  query: string,
  options: {
    limit?: number;
    feedback?: Record<string, ProjectMemoryFeedbackSummary>;
  } = {},
): ProjectMemoryRecallHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const normalizedQuery = normalize(query);
  const limit = Math.max(1, Math.min(20, options.limit ?? 8));

  return parseProjectMemoryEntries(markdown)
    .map(entry => {
      const title = normalize(entry.title);
      const section = normalize(entry.section);
      const body = normalize(entry.body);
      const matchedTerms = terms.filter(term => containsTerm(title, term) || containsTerm(section, term) || containsTerm(body, term));
      if (matchedTerms.length === 0) return null;

      let score = 0;
      if (title === normalizedQuery) score += 80;
      else if (title.includes(normalizedQuery) || normalizedQuery.includes(title)) score += 45;
      for (const term of matchedTerms) {
        if (containsTerm(title, term)) score += 18;
        if (containsTerm(section, term)) score += 8;
        if (containsTerm(body, term)) score += 3;
      }
      if (CONSTRAINT_SECTION.test(entry.section)) score += 10;
      const feedback = options.feedback?.[
        projectMemoryFeedbackScopeKey(entry.entryKey, entry.contentVersionHash)
      ] ?? EMPTY_FEEDBACK;
      const feedbackBoost = boundedFeedbackBoost(feedback);
      const promotionState = projectMemoryPromotionState(feedback);
      score += feedbackBoost;
      const caution = CONTESTED_SECTION.test(entry.section)
        || CAUTION_TEXT.test(`${entry.title}\n${entry.body}`)
        || promotionState === "contested"
        || promotionState === "superseded";
      if (caution) score -= 5;
      return { ...entry, score, matchedTerms, feedback, feedbackBoost, promotionState, caution };
    })
    .filter((entry): entry is ProjectMemoryRecallHit => entry !== null)
    .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
    .slice(0, limit);
}

export function inspectProjectMemoryQuality(markdown: string): ProjectMemoryQualityReport {
  const entries = parseProjectMemoryEntries(markdown);
  const titleCounts = new Map<string, { title: string; count: number }>();
  for (const entry of entries) {
    const key = normalize(entry.title);
    const previous = titleCounts.get(key);
    titleCounts.set(key, { title: previous?.title ?? entry.title, count: (previous?.count ?? 0) + 1 });
  }
  const duplicateTitles = Array.from(titleCounts.values())
    .filter(item => item.count > 1)
    .map(item => item.title)
    .sort((a, b) => a.localeCompare(b));
  const emptyEntries = entries.filter(entry => entry.body.trim().length === 0).map(entry => entry.title);
  const oversizedEntries = entries
    .map(entry => ({ title: entry.title, bytes: Buffer.byteLength(entry.body, "utf8") }))
    .filter(entry => entry.bytes > 4_000)
    .sort((a, b) => b.bytes - a.bytes);
  const contestedEntries = entries.filter(entry => CONTESTED_SECTION.test(entry.section)).length;
  const deductions = duplicateTitles.length * 12 + emptyEntries.length * 8 + oversizedEntries.length * 10;
  return {
    score: Math.max(0, 100 - deductions),
    entryCount: entries.length,
    duplicateTitles,
    emptyEntries,
    oversizedEntries,
    contestedEntries,
  };
}
