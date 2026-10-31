/**
 * Finds the same lesson written down in more than one long-term memory.
 *
 * Pure and deterministic: no provider, network, clock or randomness. Same input, same clusters in the same order.
 * Each entry's title and body are normalized (markdown, paths, URLs, dates, ids and digits removed), cut into
 * character n-grams over the text with spaces removed (Korean spacing varies and particles attach to words, so
 * word tokens split one lesson apart): 3-grams for Hangul, 5 characters from a Latin letter. Entries are compared
 * by Jaccard similarity of those sets. Entries from different memories whose
 * similarity reaches the threshold are linked; linked entries form a cluster, and only a cluster that spans at
 * least two memories is a candidate. Every member keeps its exact memoryId/revisionId/entryId/contentHash so a
 * later step can propose it with evidence. A cluster is a discovery hint for a person to read, never accepted
 * knowledge.
 */
import type {CommonMemorySourceEntry} from './commonMemory';

/** One discovery scan reads at most this many source entries (the scan stops adding memories past it). */
export const COMMON_MEMORY_DISCOVERY_MAX_ENTRIES = 500;
/** ...and at most this much JSON of source entries. */
export const COMMON_MEMORY_DISCOVERY_MAX_BYTES = 2_000_000;
/**
 * Jaccard similarity at which two entries from different memories count as the same lesson.
 * Calibrated 2026-11-01 on read-only live memories (1,038 entries in 48 memories, every cross-memory pair):
 * unrelated pairs stayed under 0.08; between 0.07 and 0.1 the same lesson in two projects (0.069-0.096) was mixed
 * with pairs that only share a topic (up to 0.093); the only pairs at or above 0.1 were one procedure written down
 * in different projects. 0.1 therefore favours precision: a person reads every candidate. Paraphrased fixture
 * lessons score 0.19-0.32, lightly edited copies 0.5 or more. With plain 3-grams the same data put unrelated English
 * pairs at 0.20-0.25, level with the real shared lessons (0.22-0.23), so no threshold separated them; that is why
 * Latin text uses longer grams (LESSON_LATIN_GRAM).
 */
export const LESSON_CLUSTER_THRESHOLD = 0.1;
export const LESSON_GRAM = 3;
export const LESSON_LATIN_GRAM = 5;
/** Normalized characters compared per entry: the title and the start of the body carry the lesson. */
export const LESSON_TEXT_MAX_CHARS = 800;
/** Fewer distinct n-grams than this (after boilerplate removal) is too little text to call two entries the same. */
export const LESSON_MIN_GRAMS = 16;
/** An n-gram present in this share of the scanned memories (and in at least BOILERPLATE_MIN_MEMORIES) is boilerplate. */
export const BOILERPLATE_MEMORY_SHARE = 0.75;
export const BOILERPLATE_MIN_MEMORIES = 4;
/** An entry that loses this share of its n-grams to boilerplate is generated or template text and is left out. */
export const BOILERPLATE_ENTRY_SHARE = 0.6;
/** Members per cluster (the evidence a later proposal can carry is 16 sources). */
export const LESSON_CLUSTER_MAX_MEMBERS = 16;

/**
 * Headings of text the app itself generates into instruction files and memories (instruction blocks, conflict
 * review copies). An agent that copies one into a memory has not learned a lesson.
 */
const GENERATED_HEADINGS = [
  'shared output style',
  'task-aware model and reasoning advice',
  'project test sets used by every agent',
  'project memory integration',
  'agentstoz project tester',
  'agentstoz conversational control',
  'cross-agent @ calls and # references',
  "when a user's earlier instructions or operating decisions would help",
  'resolve the canonical memory root',
  'pull first when the project is shared across machines',
].map(heading => headingKey(heading));
const GENERATED_HEADING_PREFIXES = ['review remote version'].map(heading => headingKey(heading));

function headingKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** True for an entry whose heading is one the app generates. */
export function isGeneratedLessonHeading(title: string): boolean {
  const key = headingKey(title);
  return GENERATED_HEADINGS.includes(key) || GENERATED_HEADING_PREFIXES.some(prefix => key === prefix || key.startsWith(prefix + ' '));
}

const FILE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|md|rs|py|swift|css|html?|sh|toml|ya?ml|command|plist|sql|lock|log|txt)$/;
/** A slash token is a path when it is rooted (/, ~/, ./, ../), has two or more slashes, or ends in a file name. */
function isPathToken(token: string): boolean {
  return /^(?:~|\.{1,2})?[\\/]/.test(token) || (token.match(/[\\/]/g)?.length ?? 0) >= 2 || FILE_EXTENSION.test(token);
}
/** Lines outside fenced code: fences hold one project's commands and paths, not the lesson's wording. */
function withoutFencedCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence === null && marker) { fence = marker; continue; }
    if (fence !== null) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
    kept.push(line);
  }
  return kept.join('\n');
}

/** Title and body reduced to the words of the lesson: lowercase letters separated by single spaces. */
export function lessonClusterText(title: string, body: string, maxChars = LESSON_TEXT_MAX_CHARS): string {
  const text = withoutFencedCode(`${title}\n${body}`.normalize('NFKC').toLowerCase().replace(/\r\n?/g, '\n'))
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, ' ')
    .replace(/[\w@.~\\/-]*[\\/][\w@.~\\/-]*/g, token => isPathToken(token) ? ' ' : token)
    .replace(/\b[\w-]+\.(?:[cm]?[jt]sx?|json|md|rs|py|swift|css|html?|sh|toml|ya?ml|command|plist|sql|lock|log|txt)\b/g, ' ')
    // Ids, hashes and versions: UUIDs, hex runs with both digits and letters (commit SHAs, entry ids), v1.2.3.
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, ' ')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g, ' ')
    .replace(/\bv\d[\w.-]*/g, ' ')
    // Dates, versions, counts and the rest of the digits.
    .replace(/\p{N}+/gu, ' ')
    .replace(/[^\p{L}\p{M}]+/gu, ' ')
    .trim();
  return [...text].slice(0, maxChars).join('').trim();
}

/**
 * Distinct character n-grams of the normalized text with its spaces removed, in code points: 3 characters from a
 * Hangul (or any non-Latin) character, LESSON_LATIN_GRAM from a Latin letter. A Hangul 3-gram is about a word; an
 * English 3-gram ("ing", "the", "ion") is in nearly every entry, and on live memories it made unrelated English
 * entries as similar as real shared lessons (2026-11-01 calibration, see LESSON_CLUSTER_THRESHOLD).
 */
export function lessonGrams(text: string): string[] {
  const chars = [...text.replace(/\s+/g, '')], grams = new Set<string>();
  for (let index = 0; index < chars.length; index++) {
    const length = /[a-z]/.test(chars[index]!) ? LESSON_LATIN_GRAM : LESSON_GRAM;
    if (index + length <= chars.length) grams.add(chars.slice(index, index + length).join(''));
  }
  return [...grams].sort();
}

/** Jaccard similarity of two texts' n-gram sets (0 when either is empty). For tests and calibration. */
export function lessonSimilarity(a: string, b: string): number {
  const left = new Set(lessonGrams(a)), right = lessonGrams(b);
  if (!left.size || !right.length) return 0;
  let shared = 0;
  for (const gram of right) if (left.has(gram)) shared++;
  return shared / (left.size + right.length - shared);
}

export type LessonClusterMember = {entry: CommonMemorySourceEntry; similarity: number};
export type LessonCluster = {
  /** Stable for the same member references: `lesson-` + FNV-1a of the sorted memoryId:entryId:contentHash list. */
  key: string;
  /** Short title taken from the representative member's heading. */
  title: string;
  representative: CommonMemorySourceEntry;
  /** Representative first, then by similarity to it. similarity is to the representative (1 for itself). */
  members: LessonClusterMember[];
  memoryIds: string[];
  /** Mean similarity of the linked cross-memory pairs inside the cluster. */
  cohesion: number;
};
export type LessonClusterOptions = {threshold?: number; maxChars?: number};

type Prepared = {entry: CommonMemorySourceEntry; grams: Int32Array; memory: number};

/** Clusters near-duplicate lessons across memories. Entries beyond the discovery bound are ignored. */
export function clusterCrossMemoryLessons(input: readonly CommonMemorySourceEntry[], options: LessonClusterOptions = {}): LessonCluster[] {
  const threshold = options.threshold ?? LESSON_CLUSTER_THRESHOLD, maxChars = options.maxChars ?? LESSON_TEXT_MAX_CHARS;
  // Bounded like the scan that feeds it; also skip exact repeats of one entry reference.
  const seen = new Set<string>(), entries: CommonMemorySourceEntry[] = [], encoder = new TextEncoder();
  let bytes = 0;
  for (const entry of input) {
    const ref = `${entry.memoryId}:${entry.entryId}`;
    if (seen.has(ref)) continue;
    bytes += encoder.encode(JSON.stringify(entry)).length;
    if (entries.length >= COMMON_MEMORY_DISCOVERY_MAX_ENTRIES || bytes > COMMON_MEMORY_DISCOVERY_MAX_BYTES) break;
    seen.add(ref);
    entries.push(entry);
  }
  const raw = entries
    .filter(entry => !isGeneratedLessonHeading(entry.title))
    .map(entry => ({entry, grams: lessonGrams(lessonClusterText(entry.title, entry.excerpt, maxChars))}))
    .filter(item => item.grams.length >= LESSON_MIN_GRAMS);
  const memoryIds = [...new Set(raw.map(item => item.entry.memoryId))].sort();
  if (memoryIds.length < 2) return [];
  const memoryIndex = new Map(memoryIds.map((id, index) => [id, index]));

  // Boilerplate: an n-gram that most scanned memories contain says nothing about any one lesson.
  const gramMemories = new Map<string, Set<number>>();
  for (const item of raw) {
    const memory = memoryIndex.get(item.entry.memoryId)!;
    for (const gram of item.grams) {
      let holders = gramMemories.get(gram);
      if (!holders) gramMemories.set(gram, holders = new Set());
      holders.add(memory);
    }
  }
  const boilerplateAt = Math.max(BOILERPLATE_MIN_MEMORIES, Math.ceil(BOILERPLATE_MEMORY_SHARE * memoryIds.length));
  const gramIds = new Map<string, number>();
  const prepared: Prepared[] = [];
  for (const item of raw) {
    const kept = item.grams.filter(gram => gramMemories.get(gram)!.size < boilerplateAt);
    if (kept.length < LESSON_MIN_GRAMS || kept.length <= item.grams.length * (1 - BOILERPLATE_ENTRY_SHARE)) continue;
    const ids = kept.map(gram => {
      let id = gramIds.get(gram);
      if (id === undefined) gramIds.set(gram, id = gramIds.size);
      return id;
    });
    prepared.push({entry: item.entry, grams: Int32Array.from(ids).sort(), memory: memoryIndex.get(item.entry.memoryId)!});
  }
  // Stable order regardless of how the scan listed them.
  prepared.sort((a, b) => compareRef(a.entry, b.entry));

  // Cross-memory pairs only: one project repeating itself is not a shared lesson.
  const edges: Array<{a: number; b: number; similarity: number}> = [];
  for (let a = 0; a < prepared.length; a++) {
    const left = prepared[a]!;
    for (let b = a + 1; b < prepared.length; b++) {
      const right = prepared[b]!;
      if (left.memory === right.memory) continue;
      const small = Math.min(left.grams.length, right.grams.length), large = Math.max(left.grams.length, right.grams.length);
      if (small / large < threshold) continue; // Jaccard can be at most small/large.
      const similarity = jaccard(left.grams, right.grams);
      if (similarity >= threshold) edges.push({a, b, similarity});
    }
  }
  edges.sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b);

  // Single link, strongest pairs first, capped at the evidence a proposal can carry.
  const parent = prepared.map((_, index) => index), size = prepared.map(() => 1);
  const root = (index: number): number => { while (parent[index] !== index) index = parent[index] = parent[parent[index]!]!; return index; };
  const linked: typeof edges = [];
  for (const edge of edges) {
    const x = root(edge.a), y = root(edge.b);
    if (x !== y) {
      if (size[x]! + size[y]! > LESSON_CLUSTER_MAX_MEMBERS) continue;
      const [big, small] = size[x]! >= size[y]! ? [x, y] : [y, x];
      parent[small] = big;
      size[big]! += size[small]!;
    }
    linked.push(edge);
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < prepared.length; index++) {
    const group = root(index);
    if (size[group]! < 2) continue;
    const members = groups.get(group);
    if (members) members.push(index); else groups.set(group, [index]);
  }
  const similarityOf = new Map<string, number>();
  for (const edge of edges) similarityOf.set(`${edge.a}:${edge.b}`, edge.similarity);
  const pair = (a: number, b: number) => a === b ? 1 : similarityOf.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? jaccard(prepared[a]!.grams, prepared[b]!.grams);

  const clusters: LessonCluster[] = [];
  for (const indexes of groups.values()) {
    const memories = [...new Set(indexes.map(index => prepared[index]!.entry.memoryId))].sort();
    if (memories.length < 2) continue;
    // The member closest to all the others stands for the cluster.
    const scored = indexes.map(index => ({index, total: indexes.reduce((sum, other) => other === index ? sum : sum + pair(index, other), 0)}));
    scored.sort((x, y) => y.total - x.total || x.index - y.index);
    const center = scored[0]!.index, representative = prepared[center]!.entry;
    const members = indexes
      .map(index => ({entry: prepared[index]!.entry, similarity: round(pair(center, index)), index}))
      .sort((x, y) => (x.index === center ? -1 : y.index === center ? 1 : 0) || y.similarity - x.similarity || compareRef(x.entry, y.entry))
      .map(({entry, similarity}) => ({entry, similarity}));
    const inside = new Set(indexes), internal = linked.filter(edge => inside.has(edge.a) && inside.has(edge.b));
    const cohesion = round(internal.reduce((sum, edge) => sum + edge.similarity, 0) / Math.max(1, internal.length));
    const key = 'lesson-' + fnv1a(members.map(({entry}) => `${entry.memoryId}:${entry.entryId}:${entry.contentHash}`).sort().join('\n'));
    clusters.push({key, title: lessonTitle(representative.title), representative, members, memoryIds: memories, cohesion});
  }
  return clusters.sort((x, y) => y.memoryIds.length - x.memoryIds.length || y.cohesion - x.cohesion || x.key.localeCompare(y.key));
}

/** A heading made safe and short for a topic name (the name field takes 240 bytes; no control characters). */
export function lessonTitle(title: string): string {
  const clean = title.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[*_`#>[\]]+/g, '').replace(/\s+/g, ' ').trim() || '공통 교훈';
  const chars = [...clean];
  let text = chars.length > 60 ? chars.slice(0, 59).join('').trimEnd() + '…' : clean;
  while (new TextEncoder().encode(text).length > 200) text = [...text].slice(0, -2).join('').trimEnd() + '…';
  return text;
}

function jaccard(a: Int32Array, b: Int32Array): number {
  let i = 0, j = 0, shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i]! === b[j]!) { shared++; i++; j++; } else if (a[i]! < b[j]!) i++; else j++;
  }
  return shared / (a.length + b.length - shared);
}
function compareRef(a: CommonMemorySourceEntry, b: CommonMemorySourceEntry): number {
  return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
