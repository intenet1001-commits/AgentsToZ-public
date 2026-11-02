import {createHash} from 'node:crypto';
import type {ProjectMemoryEntry, ProjectMemoryRecallHit} from './projectMemoryRecall';
import {parseProjectMemoryEntries} from './projectMemoryRecall';

export const MEMORY_RELATION_LIMITS = {entries: 512, documentBytes: 2_000_000, concepts: 16, references: 16, degree: 16, hits: 8, bytes: 8_000, bodyBytes: 1_200} as const;
export type MemoryRelationPath = {fromEntryId: string; kind: 'references' | 'referenced-by' | 'shared-concept'; concepts: string[]};
export type MemoryRelationResult = {
  state: 'ready' | 'unavailable'; memoryId: string; documentHash: string | null;
  method: 'one-hop-annotations'; maxDepth: 1;
  authority: 'association-only'; grantsAuthority: false; complete: boolean; indexedEntries: number;
  hits: Array<{entryId: string; contentVersionHash: string; title: string; body: string; bodyTruncated: boolean; caution: true; via: MemoryRelationPath}>;
  questions: Array<{entryIds: [string, string]; question: string}>;
  reason?: 'correction-proof-unavailable' | 'document-budget' | 'bounded-scan';
};
const generic = new Set(['id', 'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean', 'memoryid', 'entryid', 'requestid', 'profileid', 'portid', 'status', 'state', 'project', 'memory', '작업', '기억', '프로젝트']);
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function clip(value: string, maxBytes: number) {
  let size = 0, text = '';
  for (const char of value) { const bytes = Buffer.byteLength(char); if (size + bytes > maxBytes) return {text, truncated: true}; size += bytes; text += char; }
  return {text, truncated: false};
}
function content(entry: ProjectMemoryEntry) {
  // Fenced examples and comments are not relational annotations. Never resolve a file, URL or another memory.
  const lines: string[] = []; let fence: string | null = null;
  for (const line of `${entry.title}\n${entry.body}`.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (!fence && marker) { fence = marker; continue; }
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
    lines.push(line);
  }
  return lines.join('\n').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
}
function annotations(entry: ProjectMemoryEntry) {
  const text = content(entry), concepts = new Set<string>();
  let complete = true;
  for (const match of text.matchAll(/\[\[([^\]\n]{3,120})\]\]|(?<!`)`([^`\n]{3,120})`(?!`)/g)) {
    const concept = normalize(match[1] ?? match[2]!);
    if (generic.has(concept) || !/[\p{L}]/u.test(concept)) continue;
    if (concept.length > 120 || Buffer.byteLength(concept) > 240) { complete = false; continue; }
    if (concepts.size >= MEMORY_RELATION_LIMITS.concepts && !concepts.has(concept)) { complete = false; continue; }
    concepts.add(concept);
  }
  const references = new Set<string>();
  for (const match of text.matchAll(/\bmemory-entry:([a-f0-9]{24})\b/gi)) {
    const id = match[1]!.toLowerCase();
    if (references.size >= MEMORY_RELATION_LIMITS.references && !references.has(id)) { complete = false; continue; }
    references.add(id);
  }
  return {concepts, references, complete};
}

/** One hop inside an already authorized, current curated document. Filtered entries cannot act as bridges. */
export function recallMemoryRelations(input: {
  memoryId: string; document: string; entries?: readonly ProjectMemoryEntry[]; seeds: readonly ProjectMemoryRecallHit[];
  eligible: (entry: ProjectMemoryEntry) => boolean; correctionSearchComplete: boolean;
}): MemoryRelationResult {
  const result: MemoryRelationResult = {state: 'ready', memoryId: input.memoryId, documentHash: null, authority: 'association-only',
    method: 'one-hop-annotations', maxDepth: 1,
    grantsAuthority: false, complete: true, indexedEntries: 0, hits: [], questions: []};
  if (!input.correctionSearchComplete) return {...result, state: 'unavailable', complete: false, reason: 'correction-proof-unavailable'};
  if (Buffer.byteLength(input.document) > MEMORY_RELATION_LIMITS.documentBytes) return {...result, complete: false, reason: 'document-budget'};
  result.documentHash = createHash('sha256').update(input.document).digest('hex');
  const sourceEntries = input.entries ?? parseProjectMemoryEntries(input.document);
  const counts = new Map<string, number>();
  for (const entry of sourceEntries) counts.set(entry.entryId, (counts.get(entry.entryId) ?? 0) + 1);
  const unique = sourceEntries.filter(entry => counts.get(entry.entryId) === 1 && input.eligible(entry));
  result.complete = counts.size === sourceEntries.length && unique.length <= MEMORY_RELATION_LIMITS.entries;
  const entries = unique.slice(0, MEMORY_RELATION_LIMITS.entries), byId = new Map(entries.map(e => [e.entryId, e]));
  const data = new Map(entries.map(entry => [entry.entryId, annotations(entry)]));
  result.complete &&= [...data.values()].every(d => d.complete);
  result.indexedEntries = entries.length;
  const index = new Map<string, Set<string>>();
  for (const [id, item] of data) for (const concept of item.concepts) {
    const ids = index.get(concept); if (ids) ids.add(id); else index.set(concept, new Set([id]));
  }
  // Frequent concepts stay inspectable in the originals but cannot fan out into every note.
  for (const [concept, ids] of index) if (ids.size > MEMORY_RELATION_LIMITS.degree) { index.delete(concept); result.complete = false; }
  const seeds = input.seeds.filter(s => byId.get(s.entryId)?.contentVersionHash === s.contentVersionHash).slice(0, 8);
  const seedIds = new Set(seeds.map(s => s.entryId)), paths = new Map<string, MemoryRelationPath>();
  const add = (id: string, path: MemoryRelationPath) => { if (byId.has(id) && !seedIds.has(id) && !paths.has(id)) paths.set(id, path); };
  for (const seed of seeds) {
    const own = data.get(seed.entryId)!;
    for (const id of own.references) add(id, {fromEntryId: seed.entryId, kind: 'references', concepts: []});
    for (const [id, other] of data) if (other.references.has(seed.entryId)) add(id, {fromEntryId: seed.entryId, kind: 'referenced-by', concepts: []});
    for (const concept of [...own.concepts].sort()) for (const id of index.get(concept) ?? [])
      add(id, {fromEntryId: seed.entryId, kind: 'shared-concept', concepts: [concept]});
  }
  for (const [id, via] of paths) {
    const entry = byId.get(id)!, body = clip(entry.body, MEMORY_RELATION_LIMITS.bodyBytes);
    const hit = {entryId: id, contentVersionHash: entry.contentVersionHash, title: clip(entry.title, 240).text,
      body: body.text, bodyTruncated: body.truncated, caution: true as const, via};
    if (result.hits.length >= MEMORY_RELATION_LIMITS.hits || Buffer.byteLength(JSON.stringify({...result, hits: [...result.hits, hit]})) > MEMORY_RELATION_LIMITS.bytes - 1200) {
      result.complete = false; continue;
    }
    result.hits.push(hit);
  }
  // Questions concern two visible direct matches only. A missing edge is never a task or a proven knowledge gap.
  for (let a = 0; a < seeds.length && result.questions.length < 3; a++) for (let b = a + 1; b < seeds.length && result.questions.length < 3; b++) {
    const left = seeds[a]!, right = seeds[b]!, x = data.get(left.entryId)!, y = data.get(right.entryId)!;
    if (x.references.has(right.entryId) || y.references.has(left.entryId) || [...x.concepts].some(c => y.concepts.has(c))) continue;
    const item = {entryIds: [left.entryId, right.entryId] as [string, string], question: `「${clip(left.title, 90).text}」와 「${clip(right.title, 90).text}」의 적용 조건을 함께 검토할 필요가 있나요?`};
    if (Buffer.byteLength(JSON.stringify({...result, questions: [...result.questions, item]})) <= MEMORY_RELATION_LIMITS.bytes - 40) result.questions.push(item);
    else result.complete = false;
  }
  if (!result.complete) result.reason = 'bounded-scan';
  return result;
}
