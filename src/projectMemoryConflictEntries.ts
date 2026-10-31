/**
 * Entry-level view of a project-memory conflict — what differs between the local memory and the Supabase head, entry by
 * entry — and the one merge that needs no judgement: each side only added entries the other side does not have.
 *
 * Pure (no IO). The host still guards every write: resolve-conflict re-checks the shown hashes and revision, appends
 * through the revision CAS, backs up the local document and refuses ambiguous entry IDs. This module only decides what
 * to show and whether a merge is safe; a merge it cannot prove safe says why and is not offered.
 *
 * The base is the revision both sides last agreed on (this device's last Pull/Push). Without it an entry present on one
 * side only could be a new entry there or one deleted on the other side, so no automatic merge is offered.
 */
import { projectMemoryConflictIdentityIssues } from './projectMemoryConflict';

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,3})\s+(.+?)\s*$/;
const ENTRY_ID = /^<!--\s*memory-entry-id:([0-9a-f]{24})\s*-->$/;
/** Same ceiling as the host (`MAX_MEMORY_BYTES`); a larger merge would be refused there. */
const MAX_MEMORY_BYTES = 1_000_000;
const DOCUMENT_HEADING = '# Project Core Memory';

interface Block {
  kind: 'context' | 'entry';
  /** Stable comparison key: entry ID, else section + title + occurrence; context: heading + occurrence. */
  key: string;
  /** Key of the `#`/`##` context block this block belongs to ('' before the first heading). */
  section: string;
  title: string | null;
  entryId: string | null;
  start: number;
  end: number;
  text: string;
}

interface ParsedDocument { lines: string[]; blocks: Block[] }

const normalizeNewlines = (content: string) => content.replace(/\r\n?/g, '\n');

/** Same boundaries as the conflict module's parser: `#`–`###` headings outside code fences; `###` starts an entry. */
function parseDocument(content: string): ParsedDocument {
  const lines = normalizeNewlines(content).split('\n');
  const blocks: Block[] = [];
  const seen = new Map<string, number>();
  const occurrence = (key: string) => { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return `${key}\u0000${n}`; };
  let fence: { marker: string; length: number } | null = null;
  let section = '';
  let current: Omit<Block, 'end' | 'text' | 'entryId'> = { kind: 'context', key: '', section: '', title: null, start: 0 };
  const close = (end: number) => {
    const blockLines = lines.slice(current.start, end);
    let entryId: string | null = null;
    if (current.kind === 'entry') {
      const marker = blockLines.slice(1).find(line => line.trim())?.trim().match(ENTRY_ID);
      entryId = marker?.[1] ?? null;
    }
    const key = current.kind === 'entry'
      ? (entryId ? `id:${entryId}` : occurrence(`title:${current.section}\u0000${current.title}`))
      : current.key;
    blocks.push({ ...current, key, entryId, end, text: blockLines.join('\n').trim() });
  };
  lines.forEach((line, index) => {
    const boundary = line.match(FENCE);
    if (boundary) {
      const run = boundary[1]!;
      if (!fence) fence = { marker: run[0]!, length: run.length };
      else if (run[0] === fence.marker && run.length >= fence.length && !boundary[2]!.trim()) fence = null;
      return;
    }
    if (fence) return;
    const heading = line.match(HEADING);
    if (!heading) return;
    close(index);
    if (heading[1] === '###') {
      current = { kind: 'entry', key: '', section, title: heading[2]!, start: index };
    } else {
      section = occurrence(`${heading[1]} ${heading[2]}`);
      current = { kind: 'context', key: section, section, title: heading[2]!, start: index };
    }
  });
  close(lines.length);
  return { lines, blocks };
}

export type MemoryEntryChange =
  /** Base known. */
  | 'local-added' | 'remote-added' | 'local-changed' | 'remote-changed' | 'local-deleted' | 'remote-deleted' | 'both-changed'
  /** Base unknown: which side changed cannot be told. */
  | 'local-only' | 'remote-only' | 'differs';

export interface MemoryEntryDifference { key: string; title: string; change: MemoryEntryChange }

export type ProjectMemorySafeMerge =
  | { ok: true; content: string; addedFromLocal: number; addedFromRemote: number }
  | { ok: false; reason: string };

export interface ProjectMemoryEntryComparison {
  baseKnown: boolean;
  /** Entries identical on both sides. */
  same: number;
  differences: MemoryEntryDifference[];
  /** Text outside entries (document header, section introductions) that differs and is not a newly added section. */
  contextChanged: boolean;
  identityIssue: boolean;
  merge: ProjectMemorySafeMerge;
}

const ADDITIONS: readonly MemoryEntryChange[] = ['local-added', 'remote-added'];

function classify(local: string | undefined, remote: string | undefined, base: string | undefined, baseKnown: boolean): MemoryEntryChange | 'same' | null {
  if (local === undefined && remote === undefined) return null;
  if (local !== undefined && remote !== undefined) {
    if (local === remote) return 'same';
    if (!baseKnown) return 'differs';
    if (base === local) return 'remote-changed';
    if (base === remote) return 'local-changed';
    return 'both-changed';
  }
  if (local !== undefined) {
    if (!baseKnown) return 'local-only';
    if (base === undefined) return 'local-added';
    return base === local ? 'remote-deleted' : 'both-changed';
  }
  if (!baseKnown) return 'remote-only';
  if (base === undefined) return 'remote-added';
  return base === remote ? 'local-deleted' : 'both-changed';
}

const textByKey = (doc: ParsedDocument, kind: Block['kind']) =>
  new Map(doc.blocks.filter(block => block.kind === kind).map(block => [block.key, block.text]));

export function compareProjectMemoryEntries(input: {
  localContent: string;
  remoteContent: string;
  baseContent?: string | null;
}): ProjectMemoryEntryComparison {
  const local = parseDocument(input.localContent), remote = parseDocument(input.remoteContent);
  const baseKnown = typeof input.baseContent === 'string';
  const base = baseKnown ? parseDocument(input.baseContent!) : null;
  const identityIssue = [input.localContent, input.remoteContent].some(content => {
    const issues = projectMemoryConflictIdentityIssues(content);
    return issues.duplicateIds.length > 0 || issues.malformedIds > 0;
  });

  const localEntries = textByKey(local, 'entry'), remoteEntries = textByKey(remote, 'entry');
  const baseEntries = base ? textByKey(base, 'entry') : new Map<string, string>();
  const titles = new Map<string, string>();
  for (const doc of [remote, local]) for (const block of doc.blocks) if (block.kind === 'entry') titles.set(block.key, block.title ?? '');
  const keys = [...new Set([...local.blocks, ...remote.blocks].filter(block => block.kind === 'entry').map(block => block.key))];
  let same = 0;
  const differences: MemoryEntryDifference[] = [];
  for (const key of keys) {
    const change = classify(localEntries.get(key), remoteEntries.get(key), baseEntries.get(key), baseKnown);
    if (change === 'same') same += 1;
    else if (change) differences.push({ key, title: titles.get(key) ?? '', change });
  }

  // Context: identical on both sides, or a section only one side added since the base.
  const localContext = textByKey(local, 'context'), remoteContext = textByKey(remote, 'context');
  const baseContext = base ? textByKey(base, 'context') : new Map<string, string>();
  let contextChanged = false;
  for (const key of new Set([...localContext.keys(), ...remoteContext.keys()])) {
    const change = classify(localContext.get(key), remoteContext.get(key), baseContext.get(key), baseKnown);
    if (change !== 'same' && change !== null && !ADDITIONS.includes(change)) contextChanged = true;
  }

  const merge = safeMerge({ local, remote, baseKnown, identityIssue, contextChanged, differences, localContent: input.localContent });
  return { baseKnown, same, differences, contextChanged, identityIssue, merge };
}

function safeMerge(input: {
  local: ParsedDocument; remote: ParsedDocument; baseKnown: boolean; identityIssue: boolean; contextChanged: boolean;
  differences: MemoryEntryDifference[]; localContent: string;
}): ProjectMemorySafeMerge {
  if (input.identityIssue) return { ok: false, reason: '항목 ID가 중복되거나 잘못돼 자동으로 합칠 수 없습니다. 두 원본은 그대로 둡니다.' };
  if (!input.baseKnown) return { ok: false, reason: '마지막으로 맞춘 기준 리비전을 확인하지 못해, 한쪽에만 있는 항목이 새로 추가된 것인지 다른 쪽에서 지운 것인지 구분할 수 없습니다. 자동으로 합치지 않습니다.' };
  const edited = input.differences.filter(difference => !ADDITIONS.includes(difference.change));
  if (edited.length) return { ok: false, reason: `양쪽 모두 새 항목만 더한 경우에만 자동으로 합칩니다. 고치거나 지운 항목이 ${edited.length}개 있습니다.` };
  if (input.contextChanged) return { ok: false, reason: '항목 밖의 머리말·섹션 설명이 바뀌어 자동으로 합칠 수 없습니다.' };
  if (!normalizeNewlines(input.localContent).startsWith(DOCUMENT_HEADING)) return { ok: false, reason: '로컬 문서가 「# Project Core Memory」로 시작하지 않아 합치지 않습니다.' };

  const remoteAdded = new Set(input.differences.filter(d => d.change === 'remote-added').map(d => d.key));
  const localSections = new Set(input.local.blocks.filter(block => block.kind === 'context').map(block => block.key));
  // Remote additions grouped by the local section they join; sections Supabase added go at the end, in remote order.
  const intoSection = new Map<string, Block[]>();
  const newSections: { context: Block; entries: Block[] }[] = [];
  for (const block of input.remote.blocks) {
    if (block.kind === 'context' && !localSections.has(block.key)) newSections.push({ context: block, entries: [] });
    if (block.kind !== 'entry' || !remoteAdded.has(block.key)) continue;
    if (localSections.has(block.section)) intoSection.set(block.section, [...(intoSection.get(block.section) ?? []), block]);
    else {
      const target = newSections.find(group => group.context.key === block.section);
      if (!target) return { ok: false, reason: 'Supabase 항목이 들어갈 섹션을 찾지 못해 합치지 않습니다.' };
      target.entries.push(block);
    }
  }
  const raw = (doc: ParsedDocument, block: Block) => {
    const lines = doc.lines.slice(block.start, block.end);
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    return lines;
  };
  const out: string[] = [];
  const append = (lines: string[], more: boolean) => {
    let trailing = 0;
    while (out.length && !out[out.length - 1]!.trim()) { out.pop(); trailing += 1; }
    if (out.length) out.push('');
    out.push(...lines);
    for (let i = 0; i < Math.max(trailing, more ? 1 : 0); i += 1) out.push('');
  };
  const lastOfSection = new Map<string, number>();
  input.local.blocks.forEach((block, index) => lastOfSection.set(block.section, index));
  input.local.blocks.forEach((block, index) => {
    out.push(...input.local.lines.slice(block.start, block.end));
    if (lastOfSection.get(block.section) !== index) return;
    const more = index < input.local.blocks.length - 1 || newSections.length > 0;
    for (const entry of intoSection.get(block.section) ?? []) append(raw(input.remote, entry), more);
  });
  for (const group of newSections) {
    append(raw(input.remote, group.context), true);
    for (const entry of group.entries) append(raw(input.remote, entry), true);
  }
  // Nothing to bring over from Supabase: the merge is the local document, byte for byte.
  const content = remoteAdded.size ? out.join('\n') : normalizeNewlines(input.localContent);

  // Prove the result instead of trusting the construction: every local entry and context is unchanged, every Supabase
  // addition is present verbatim, nothing else appeared, and the entry IDs stay unique.
  const merged = parseDocument(content);
  const mergedEntries = textByKey(merged, 'entry'), mergedContext = textByKey(merged, 'context');
  const localEntries = textByKey(input.local, 'entry'), remoteEntries = textByKey(input.remote, 'entry');
  const expectedEntries = localEntries.size + remoteAdded.size;
  const proven = merged.blocks.filter(block => block.kind === 'entry').length === expectedEntries
    && [...localEntries].every(([key, text]) => mergedEntries.get(key) === text)
    && [...remoteAdded].every(key => mergedEntries.get(key) === remoteEntries.get(key))
    && [...textByKey(input.local, 'context')].every(([key, text]) => mergedContext.get(key) === text)
    && newSections.every(group => mergedContext.get(group.context.key) === group.context.text)
    && !projectMemoryConflictIdentityIssues(content).duplicateIds.length;
  if (!proven) return { ok: false, reason: '합친 결과를 검증하지 못해 합치지 않았습니다.' };
  if (new TextEncoder().encode(content).length > MAX_MEMORY_BYTES) return { ok: false, reason: '합친 문서가 1MB 한도를 넘어 합치지 않습니다.' };
  return {
    ok: true,
    content,
    addedFromLocal: input.differences.filter(d => d.change === 'local-added').length,
    addedFromRemote: remoteAdded.size,
  };
}

/**
 * How many differing entries each one-sided choice leaves out of the new current version, so its confirmation can say
 * so. 「로컬 유지」 drops what only Supabase has or changed (it stays in the Supabase revision history); 「Supabase 받기」
 * drops what only local has or changed (it stays in the local backup). A deletion the chosen side made is not a loss.
 */
export function projectMemoryChoiceLosses(comparison: Pick<ProjectMemoryEntryComparison, 'differences'>): { keepLocal: number; useRemote: number } {
  const count = (changes: readonly MemoryEntryChange[]) => comparison.differences.filter(d => changes.includes(d.change)).length;
  return {
    keepLocal: count(['remote-added', 'remote-changed', 'both-changed', 'remote-only', 'differs']),
    useRemote: count(['local-added', 'local-changed', 'both-changed', 'local-only', 'differs']),
  };
}

/** Short Korean label for one difference, for the dock's list. */
export const MEMORY_ENTRY_CHANGE_LABEL: Record<MemoryEntryChange, string> = {
  'local-added': '로컬에서 추가',
  'remote-added': 'Supabase에서 추가',
  'local-changed': '로컬에서 고침',
  'remote-changed': 'Supabase에서 고침',
  'local-deleted': '로컬에서 지움',
  'remote-deleted': 'Supabase에서 지움',
  'both-changed': '양쪽에서 다르게 고침',
  'local-only': '로컬에만 있음',
  'remote-only': 'Supabase에만 있음',
  differs: '양쪽 내용이 다름',
};
