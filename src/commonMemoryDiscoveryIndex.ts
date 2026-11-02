import type {CommonMemorySourceEntry} from './commonMemory';
import {isGeneratedLessonHeading, lessonClusterText, lessonGrams, LESSON_CLUSTER_THRESHOLD, LESSON_MIN_GRAMS,
  BOILERPLATE_MEMORY_SHARE, BOILERPLATE_MIN_MEMORIES, BOILERPLATE_ENTRY_SHARE} from './commonMemoryLessonClusters';

/** Disposable hints only. Evidence always comes from another current, authorized source read. */
export const COMMON_MEMORY_INDEX_LIMITS = {entries: 2048, bytes: 8_000_000, scopes: 8, ttlMs: 10 * 60_000, relatedMemories: 8, comparisonChars: 250_000} as const;
type Hint = Pick<CommonMemorySourceEntry, 'memoryId' | 'revisionId' | 'entryId' | 'contentHash'> & {text: string};
type MemoryHints = {at: number; bytes: number; hints: Hint[]};
type Partition = {at: number; memories: Map<string, MemoryHints>; frontier: string | null | undefined; incomplete: boolean};
export type DiscoveryIndexSnapshot = {hints: readonly Hint[]; canContinue: boolean; incomplete: boolean};

export class CommonMemoryDiscoveryIndex {
  private partitions = new Map<string, Partition>();
  private count = 0;
  private bytes = 0;
  constructor(private now = Date.now, private limits: {entries: number; bytes: number; scopes: number; ttlMs: number} = COMMON_MEMORY_INDEX_LIMITS) {}

  clear() { this.partitions.clear(); this.count = 0; this.bytes = 0; }

  private removeMemory(partition: Partition, id: string) {
    const memory = partition.memories.get(id);
    if (!memory) return;
    this.count -= memory.hints.length;
    this.bytes -= memory.bytes;
    partition.memories.delete(id);
  }

  private removePartition(key: string) {
    const partition = this.partitions.get(key)!;
    for (const id of partition.memories.keys()) this.removeMemory(partition, id);
    this.partitions.delete(key);
  }

  private prune() {
    const now = this.now();
    for (const [key, partition] of this.partitions) {
      if (now - partition.at >= this.limits.ttlMs) { this.removePartition(key); continue; }
      for (const [id, memory] of partition.memories) if (now - memory.at >= this.limits.ttlMs) {
        this.removeMemory(partition, id);
        partition.incomplete = true;
      }
    }
  }

  snapshot(key: string | null, after: string | null): DiscoveryIndexSnapshot {
    this.prune();
    const partition = key ? this.partitions.get(key) : undefined;
    return {hints: partition ? [...partition.memories.values()].flatMap(m => m.hints) : [],
      canContinue: after === null || partition?.frontier === after, incomplete: !!partition?.incomplete};
  }

  /** A failed source replaces its hints with nothing; replacement is by memory, never append-by-revision. */
  remember(key: string | null, updates: ReadonlyMap<string, readonly CommonMemorySourceEntry[]>, after: string | null, nextAfter: string | null, incomplete: boolean) {
    if (!key) return;
    this.prune();
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = {at: this.now(), memories: new Map(), frontier: undefined, incomplete: false};
      this.partitions.set(key, partition);
    }
    const continues = after === null || partition.frontier === after;
    if (after === null) partition.incomplete = false;
    partition.incomplete ||= incomplete || !continues;
    if (continues) partition.frontier = nextAfter;
    partition.at = this.now();
    this.partitions.delete(key);
    this.partitions.set(key, partition);
    for (const [id, entries] of updates) {
      this.removeMemory(partition, id);
      const hints = entries.filter(e => !isGeneratedLessonHeading(e.title)).map(e => ({memoryId: e.memoryId,
        revisionId: e.revisionId, entryId: e.entryId, contentHash: e.contentHash, text: lessonClusterText(e.title, e.excerpt)}))
        .filter(h => lessonGrams(h.text).length >= LESSON_MIN_GRAMS);
      const bytes = new TextEncoder().encode(JSON.stringify(hints)).length;
      if (hints.length > this.limits.entries || bytes > this.limits.bytes) { partition.incomplete = true; continue; }
      if (!hints.length) continue;
      partition.memories.set(id, {at: this.now(), bytes, hints});
      this.count += hints.length;
      this.bytes += bytes;
    }
    while (this.partitions.size > this.limits.scopes) this.removePartition(this.partitions.keys().next().value!);
    // Evict the least recently indexed memory, retaining no originals or pending work here.
    while (this.count > this.limits.entries || this.bytes > this.limits.bytes) {
      let oldest: {partition: Partition; id: string; at: number} | undefined;
      for (const p of this.partitions.values()) for (const [id, memory] of p.memories)
        if (!oldest || memory.at < oldest.at) oldest = {partition: p, id, at: memory.at};
      if (!oldest) break;
      this.removeMemory(oldest.partition, oldest.id);
      oldest.partition.incomplete = true;
    }
  }
}

/** Exact n-gram overlap selects at most eight older memories to re-read, not facts to return. */
export function relatedDiscoveryMemories(snapshot: DiscoveryIndexSnapshot, current: readonly CommonMemorySourceEntry[]) {
  const currentIds = new Set(current.map(e => e.memoryId));
  const previous = snapshot.hints.filter(h => !currentIds.has(h.memoryId));
  const usable = current.filter(e => !isGeneratedLessonHeading(e.title));
  if (!previous.length || !usable.length) return {memoryIds: [] as string[], truncated: false};
  // Bound transient n-gram/posting allocations too. Prefer this page and the most recently indexed older memories.
  let remaining: number = COMMON_MEMORY_INDEX_LIMITS.comparisonChars, truncated = false;
  const take = <T extends {text: string}>(rows: readonly T[]): T[] => rows.filter(row => {
    if (row.text.length > remaining) { truncated = true; return false; }
    remaining -= row.text.length;
    return true;
  });
  const queries = take(usable.map(e => ({memoryId: e.memoryId, text: lessonClusterText(e.title, e.excerpt)})));
  const hints = take(previous.reverse());
  const records = [...hints, ...queries].map(h => ({memoryId: h.memoryId, grams: lessonGrams(h.text)}));
  const memories = new Set(records.map(r => r.memoryId)), frequency = new Map<string, Set<string>>();
  for (const record of records) for (const gram of record.grams) {
    const found = frequency.get(gram); if (found) found.add(record.memoryId); else frequency.set(gram, new Set([record.memoryId]));
  }
  const boilerplateAt = Math.max(BOILERPLATE_MIN_MEMORIES, Math.ceil(memories.size * BOILERPLATE_MEMORY_SHARE));
  const filtered = records.map(record => {
    const grams = record.grams.filter(g => frequency.get(g)!.size < boilerplateAt);
    return grams.length < LESSON_MIN_GRAMS || 1 - grams.length / record.grams.length >= BOILERPLATE_ENTRY_SHARE ? [] : grams;
  });
  const postings = new Map<string, number[]>(), sizes: number[] = [];
  hints.forEach((_, index) => {
    const grams = filtered[index]!;
    sizes.push(grams.length);
    for (const gram of grams) { const list = postings.get(gram); if (list) list.push(index); else postings.set(gram, [index]); }
  });
  const scores = new Map<string, number>();
  for (const grams of filtered.slice(hints.length)) {
    const shared = new Map<number, number>();
    for (const gram of grams) for (const index of postings.get(gram) ?? []) shared.set(index, (shared.get(index) ?? 0) + 1);
    for (const [index, count] of shared) {
      const score = count / (grams.length + sizes[index]! - count), id = hints[index]!.memoryId;
      if (score >= LESSON_CLUSTER_THRESHOLD && score > (scores.get(id) ?? 0)) scores.set(id, score);
    }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {memoryIds: ranked.slice(0, COMMON_MEMORY_INDEX_LIMITS.relatedMemories).map(([id]) => id),
    truncated: truncated || ranked.length > COMMON_MEMORY_INDEX_LIMITS.relatedMemories};
}
