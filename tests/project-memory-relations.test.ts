import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {recallCuratedProjectMemory} from '../project-memory-server';
import {MEMORY_RELATION_LIMITS} from '../src/projectMemoryRelations';
import {parseProjectMemoryEntries} from '../src/projectMemoryRecall';

const memoryId = '0a000000-0000-4000-8000-000000000001';
const id = (n: number) => n.toString(16).padStart(24, '0');
const note = (n: number, title: string, body: string) => `### ${title}\n<!-- memory-entry-id:${id(n)} -->\n${body}\n`;
const document = '# Memory\n## Decisions\n' + note(1, 'Reconnect failure', 'Investigate [[socket epoch]].')
  + note(2, 'Keep identity durable', 'Persist [[socket epoch]] across a restart. See [receipt](memory-entry:' + id(3) + ').')
  + note(3, 'A distant note', 'A second hop must never be expanded automatically.')
  + note(4, 'Separate approval', 'Approval is [[human consent]].');
const recall = (doc = document, query = 'Reconnect', options: Record<string, unknown> = {}) =>
  recallCuratedProjectMemory({memoryId, document: doc, query, ledger: [], ...options});

test('relation retrieval is opt-in and preserves the default hits and exact response keys', () => {
  const base = recall(), expanded = recall(document, 'Reconnect', {includeRelations: true});
  expect(Object.keys(base).sort()).toEqual(['correctionSearch', 'corrections', 'hits']);
  expect(expanded.hits).toEqual(base.hits);
  expect(expanded.relations!.hits.map(h => h.entryId)).toEqual([id(2)]);
  expect(expanded.relations!.hits[0]!.via).toEqual({fromEntryId: id(1), kind: 'shared-concept', concepts: ['socket epoch']});
  expect(expanded.relations!.documentHash).toBe(createHash('sha256').update(document).digest('hex'));
  expect(expanded.relations!.grantsAuthority).toBe(false);
});

test('explicit entry references and backlinks preserve exact target versions, and never traverse two hops', () => {
  const result = recall(document, 'durable', {includeRelations: true}).relations!;
  expect(result.hits.map(h => h.entryId)).toContain(id(3));
  const target = result.hits.find(h => h.entryId === id(3))!;
  expect(target.via.kind).toBe('references');
  expect(target.contentVersionHash).toBe(parseProjectMemoryEntries(document)[2]!.contentVersionHash);
  expect(recall(document, 'distant', {includeRelations: true}).relations!.hits.find(h => h.entryId === id(2))!.via.kind).toBe('referenced-by');
  expect(recall().hits.map(h => h.entryId)).not.toContain(id(3));
});

test('withdrawn entries cannot be results, query seeds or intermediary bridges, even under a matching annotation', () => {
  const entry = parseProjectMemoryEntries(document)[1]!;
  const ledger = [{id: 'report', memoryId, entryKey: entry.entryKey, contentVersionHash: entry.contentVersionHash,
    kind: 'corrected' as const, recordedAt: '2026-11-02T00:00:00.000Z', evidence: 'This rule failed.'}];
  const result = recallCuratedProjectMemory({memoryId, document, query: 'Reconnect', ledger, includeRelations: true});
  expect(result.relations!.hits).toEqual([]);
  const noProof = recall(document, 'Reconnect', {includeRelations: true, correctionSearchComplete: false});
  expect(noProof.relations).toMatchObject({state: 'unavailable', reason: 'correction-proof-unavailable', hits: [], questions: []});
  expect(noProof.hits).toEqual([]);
});

test('the same concept in another document cannot be read, and a changed version is returned with its own hash', () => {
  const changed = document.replace('Persist [[socket epoch]]', 'Review [[socket epoch]]');
  const current = recall(changed, 'Reconnect', {includeRelations: true}).relations!;
  expect(current.hits[0]!.contentVersionHash).not.toBe(recall(document, 'Reconnect', {includeRelations: true}).relations!.hits[0]!.contentVersionHash);
  expect(recall('# Memory\n## Decisions\n' + note(1, 'Reconnect failure', 'Investigate [[socket epoch]].'), 'Reconnect', {includeRelations: true}).relations!.hits).toEqual([]);
});

test('comments, fenced code, generic identifiers and ambiguous entry IDs do not manufacture links', () => {
  const doc = '# Memory\n## Decisions\n' + note(1, 'Query seed', 'Use `memoryId`. <!-- [[hidden concept]] -->\n```md\n[[fenced concept]]\n```')
    + note(2, 'Other rule', '`memoryId` [[hidden concept]] [[fenced concept]]')
    + note(3, 'Ambiguous', '[[socket epoch]]') + note(3, 'Duplicate', '[[socket epoch]]');
  const result = recall(doc, 'Query', {includeRelations: true}).relations!;
  expect(result.hits).toEqual([]);
  expect(result.complete).toBe(false);
});

test('questions are review prompts for visible matches, never factual gaps or task creation', () => {
  const result = recall(document, 'approval Reconnect', {includeRelations: true}).relations!;
  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]!.entryIds.sort()).toEqual([id(1), id(4)]);
  expect(result.questions[0]!.question.endsWith('?')).toBe(true);
  expect(result.authority).toBe('association-only');
});

test('entry, body, high-degree and total response budgets remain explicit and UTF-8 safe', () => {
  const doc = '# Memory\n## Decisions\n' + note(1, 'Query seed', '[[specific concept]]')
    + Array.from({length: 20}, (_, n) => note(n + 2, 'Rule ' + n, '[[specific concept]] ' + '한'.repeat(1_000))).join('\n');
  const result = recall(doc, 'Query', {includeRelations: true}).relations!;
  expect(result.hits).toEqual([]);
  expect(result.complete).toBe(false);
  const pair = '# Memory\n## Decisions\n' + note(1, 'Query seed', '[[specific concept]]') + note(2, 'Rule', '[[specific concept]] ' + '한'.repeat(1_000));
  const selected = recall(pair, 'Query', {includeRelations: true}).relations!;
  expect(selected.hits[0]!.bodyTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(MEMORY_RELATION_LIMITS.bytes);
  const tooBig = recall(pair + '한'.repeat(700_000), 'Query', {includeRelations: true}).relations!;
  expect(tooBig).toMatchObject({complete: false, reason: 'document-budget', hits: []});
});
