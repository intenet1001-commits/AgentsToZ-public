import {expect, test} from 'bun:test';
import {normalizeUserProfileRecallRequest, selectUserProfileRecall, type UserProfileEntry, type UserProfileSnapshot} from '../src/userProfileContract';

const project = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const entry = (n: number, patch: Partial<UserProfileEntry> = {}): UserProfileEntry => ({id: `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: 'Writing style', body: 'Use short paragraphs.', scope: 'all-projects', projectMemoryId: null, state: 'active',
  updatedAt: '2026-11-02T00:00:00.000Z', origin: 'user-confirmed', ...patch});
const snapshot = (entries: UserProfileEntry[]): UserProfileSnapshot => ({revision: project, entries});

test('explanations are opt-in, preserve ordinary selection, and describe only active in-scope returned preferences', () => {
  const source = snapshot([entry(1), entry(2, {scope: 'project', projectMemoryId: project}),
    entry(3, {state: 'inactive'}), entry(4, {scope: 'project', projectMemoryId: other})]);
  const base = selectUserProfileRecall(source, {projectMemoryId: project, query: 'writing'});
  expect(Object.keys(base).sort()).toEqual(['entries', 'revision', 'truncated']);
  const explained = selectUserProfileRecall(source, {projectMemoryId: project, query: 'writing', includeExplanation: true});
  expect(explained.entries).toEqual(base.entries);
  expect(explained.explanation!.selections).toEqual(base.entries.map(e => ({entryId: e.id, scope: e.scope, matchedTerms: ['writing'], fields: ['title'], reason: 'query-match'})));
  expect(JSON.stringify(explained)).not.toContain(entry(3).id);
  expect(JSON.stringify(explained)).not.toContain(entry(4).id);
  expect(source.entries).toHaveLength(4);
});

test('a same-title overlap asks for review and never picks a winner or changes scope', () => {
  const a = entry(1), b = entry(2, {body: 'Include detailed explanations.', scope: 'project', projectMemoryId: project});
  const result = selectUserProfileRecall(snapshot([a, b]), {projectMemoryId: project, query: 'writing', includeExplanation: true});
  expect(result.entries).toEqual([a, b]);
  expect(result.explanation!.overlaps).toEqual([{entryIds: [a.id, b.id], reason: 'same-title-different-content'}]);
  expect(selectUserProfileRecall(snapshot([a, b]), {projectMemoryId: other, query: 'writing', includeExplanation: true}).explanation!.overlaps).toEqual([]);
  expect(selectUserProfileRecall(snapshot([a, {...b, body: a.body}]), {projectMemoryId: project, includeExplanation: true}).explanation!.overlaps).toEqual([]);
});

test('a global-only preview never borrows a project identity, and blank-query matches are explained as scope selection', () => {
  const source = snapshot([entry(1), entry(2, {scope: 'project', projectMemoryId: project})]);
  const result = selectUserProfileRecall(source, {projectMemoryId: null, includeExplanation: true});
  expect(result.entries).toEqual([source.entries[0]!]);
  expect(result.explanation!.selections[0]).toMatchObject({reason: 'active-in-scope', matchedTerms: [], fields: []});
  expect(result.explanation!.comparisonScope).toBe('returned-entries');
});

test('explanation flags are strict booleans and the complete preference response stays within 8,000 UTF-8 bytes', () => {
  for (const includeExplanation of ['true', 1, null, {}]) expect(() => normalizeUserProfileRecallRequest({projectMemoryId: project, includeExplanation})).toThrow();
  const source = snapshot(Array.from({length: 64}, (_, n) => entry(n + 1, {body: '한'.repeat(1_300)})));
  for (const includeExplanation of [false, true]) {
    const result = selectUserProfileRecall(source, {projectMemoryId: project, includeExplanation});
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8_000);
    expect(result.entries.length).toBeGreaterThan(0);
    if (includeExplanation) expect(result.explanation!.selections.map(s => s.entryId)).toEqual(result.entries.map(e => e.id));
  }
});
