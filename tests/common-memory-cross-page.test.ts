import {expect, test} from 'bun:test';
import {clearCommonMemoryServiceCaches, createCommonMemoryService} from '../common-memory-server';
import {CommonCloud} from './fixtures/common-memory/cloud';
import {COMMON_MEMORY_INDEX_LIMITS, CommonMemoryDiscoveryIndex, relatedDiscoveryMemories} from '../src/commonMemoryDiscoveryIndex';
import type {CommonMemorySourceEntry} from '../src/commonMemory';

const id = (n: number) => `0a000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const first = '### Bun environment isolation\n<!-- memory-entry-id:aaaaaaaaaaaaaaaaaaaaaaaa -->\nBun loads .env files automatically. The --no-env-file flag does not exist in Bun. Use --env-file=/dev/null and launch from a neutral working directory so project secrets are never loaded.';
const last = '### Keep Bun from loading project secrets\n<!-- memory-entry-id:bbbbbbbbbbbbbbbbbbbbbbbb -->\nBun automatically loads .env and has no --no-env-file option. Use --env-file=/dev/null and start from a neutral working directory so project secrets are never loaded.';
function fixture() {
  const cloud = Object.assign(new CommonCloud(), {commonMemoryScope: 'a'.repeat(64)});
  cloud.tables.portmgr_project_memory_heads = [];
  cloud.tables.portmgr_project_memory_revisions = [];
  for (let n = 1; n <= 18; n++) cloud.source(id(n), n === 1 ? first : n === 18 ? last : `### 메모 ${n}\n짧은 메모`);
  // Each HTTP request may build a new service; the index must follow the cloud partition, not this instance.
  return {cloud, service: () => createCommonMemoryService(() => cloud)};
}

test('lessons on separate catalog pages meet with fresh evidence and no cloud writes', async () => {
  const {cloud, service} = fixture(), before = JSON.stringify(cloud.tables);
  const a = await service().topicCandidates();
  const b = await service().topicCandidates(a.nextAfter);
  const c = await service().topicCandidates(b.nextAfter);
  expect(c.method).toBe('cross-memory-lesson-cluster');
  expect(c.candidates).toHaveLength(1);
  expect(c.candidates[0]!.sourceMemoryIds).toEqual([id(1), id(18)]);
  expect(c.checkedMemoryIds).toContain(id(1));
  expect(c.scanComplete).toBe(true);
  for (const evidence of c.candidates[0]!.evidence) {
    const head = cloud.tables.portmgr_project_memory_heads!.find(h => h.memory_id === evidence.memoryId)!;
    expect(evidence.revisionId).toBe(head.head_revision_id);
  }
  expect(JSON.stringify(cloud.tables)).toBe(before);
});

test('explicitly selected memories stay within that selection despite previous discovery', async () => {
  const {service} = fixture();
  await service().topicCandidates();
  const result = await service().topicCandidates(null, [id(18)]);
  expect(result.checkedMemoryIds).toEqual([id(18)]);
  expect(result.candidates).toEqual([]);
});

for (const change of ['revision', 'archive', 'alias'] as const) test(`a cached lesson cannot survive a source ${change}`, async () => {
  const {cloud, service} = fixture();
  await service().topicCandidates();
  if (change === 'revision') cloud.source(id(1), '### Completely different decision\nNo relation to the previous lesson.');
  if (change === 'archive') cloud.tables.portmgr_project_memory_trash!.push({memory_id: id(1)});
  if (change === 'alias') cloud.aliases.set(id(1), id(2));
  const result = await service().topicCandidates(id(16));
  expect(result.candidates.filter(c => c.method === 'cross-memory-lesson-cluster')).toEqual([]);
  if (change !== 'revision') expect(result.warnings.some(w => w.memoryId === id(1))).toBe(true);
});

test('discovery does not cross cloud partitions or silently claim completion after a cleared index', async () => {
  const a = fixture(), b = fixture();
  await a.service().topicCandidates();
  const isolated = await b.service().topicCandidates(id(16));
  expect(isolated.candidates.filter(c => c.method === 'cross-memory-lesson-cluster')).toEqual([]);
  expect(isolated.scanComplete).toBe(false);
  expect(isolated.warnings.length).toBeGreaterThan(0);
  clearCommonMemoryServiceCaches();
  const cleared = await a.service().topicCandidates(id(16));
  expect(cleared.scanComplete).toBe(false);
});

test('three matching memories at positions 15, 57 and 98 meet during a 103-memory scan', async () => {
  const {cloud, service} = fixture();
  cloud.tables.portmgr_project_memory_heads = [];
  cloud.tables.portmgr_project_memory_revisions = [];
  let seed = 17;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 1000) / 1000;
  const syllables = [...'가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후기니디리미비시이지치키티피히'];
  for (let n = 1; n <= 103; n++) {
    const notes = Array.from({length: 10}, (_, k) => `### 경험 ${k}\n${Array.from({length: 80}, () => syllables[Math.floor(random() * syllables.length)]).join('')}`).join('\n\n');
    cloud.source(id(n), notes + ([15, 57, 98].includes(n) ? '\n\n' + (n === 15 ? first : last) : ''));
  }
  let after: string | null = null, found = false;
  const started = performance.now();
  do {
    const result = await service().topicCandidates(after);
    found ||= result.candidates.some(c => [id(15), id(57), id(98)].every(m => c.sourceMemoryIds.includes(m)));
    expect(result.warnings).toEqual([]);
    after = result.nextAfter;
    if (!after) expect(result.scanComplete).toBe(true);
  } while (after);
  expect(found).toBe(true);
  expect(performance.now() - started).toBeLessThan(5_000);
});

test('a matched old source is read again and returns its new revision when the lesson is still valid', async () => {
  const {cloud, service} = fixture();
  await service().topicCandidates();
  const revision = cloud.source(id(1), first + '\nVerified again.');
  const result = await service().topicCandidates(id(16));
  expect(result.candidates[0]!.evidence.find(e => e.memoryId === id(1))!.revisionId).toBe(revision);
});

test('clearing caches during an in-flight discovery cannot resurrect its old index', async () => {
  const {cloud, service} = fixture(), answer = cloud.answer.bind(cloud);
  let cleared = false;
  cloud.answer = async (signal, compute) => {
    const result = await answer(signal, compute);
    if (!cleared) { cleared = true; clearCommonMemoryServiceCaches(); }
    return result;
  };
  await service().topicCandidates();
  const result = await service().topicCandidates(id(16));
  expect(result.candidates.filter(c => c.method === 'cross-memory-lesson-cluster')).toEqual([]);
  expect(result.scanComplete).toBe(false);
});

test('an empty continuation page still discloses missing coverage', async () => {
  const {service} = fixture();
  const result = await service().topicCandidates(id(40));
  expect(result.checkedMemoryIds).toEqual([]);
  expect(result.scanComplete).toBe(false);
  expect(result.warnings.length).toBeGreaterThan(0);
});

const hint = (n: number): CommonMemorySourceEntry => ({memoryId: id(n), entryId: 'a'.repeat(24), revisionId: id(100 + n),
  contentHash: 'b'.repeat(32), title: 'Bun environment isolation', excerpt: first, section: 'Decisions'});

test('index expiry, entry and byte caps are visible; source replacement removes old signatures', () => {
  let now = 0;
  const index = new CommonMemoryDiscoveryIndex(() => now, {entries: 2, bytes: 8_000, scopes: 2, ttlMs: 10});
  index.remember('one', new Map([[id(1), [hint(1)]]]), null, id(8), false);
  expect(relatedDiscoveryMemories(index.snapshot('one', id(8)), [hint(18)]).memoryIds).toEqual([id(1)]);
  index.remember('one', new Map([[id(1), []]]), id(8), id(16), false);
  expect(index.snapshot('one', id(16)).hints).toEqual([]);
  index.remember('one', new Map([[id(1), [hint(1)]], [id(2), [hint(2)]], [id(3), [hint(3)]]]), null, id(8), false);
  expect(index.snapshot('one', id(8)).hints).toHaveLength(2);
  expect(index.snapshot('one', id(8)).incomplete).toBe(true);
  now = 11;
  expect(index.snapshot('one', id(8)).canContinue).toBe(false);
  expect(index.snapshot('one', id(8)).hints).toEqual([]);
  const tiny = new CommonMemoryDiscoveryIndex(() => now, {entries: 2, bytes: 50, scopes: 1, ttlMs: 10});
  tiny.remember('one', new Map([[id(1), [hint(1)]]]), null, id(8), false);
  expect(tiny.snapshot('one', id(8)).hints).toEqual([]);
  expect(tiny.snapshot('one', id(8)).incomplete).toBe(true);
});

test('index partitions, scope cap, continuation order and generated instructions stay isolated', () => {
  const index = new CommonMemoryDiscoveryIndex(Date.now, {entries: 20, bytes: 8_000, scopes: 1, ttlMs: 10_000});
  index.remember('one', new Map([[id(1), [hint(1)]]]), null, id(8), false);
  expect(index.snapshot('two', id(8)).hints).toEqual([]);
  expect(index.snapshot('one', id(16)).canContinue).toBe(false);
  const generated = {...hint(2), title: 'Project memory integration'};
  index.remember('two', new Map([[id(2), [generated]]]), null, id(8), false);
  expect(index.snapshot('one', id(8)).canContinue).toBe(false);
  expect(index.snapshot('two', id(8)).hints).toEqual([]);
});

test('transient comparison work and the number of older source reads are bounded and disclosed', () => {
  const index = new CommonMemoryDiscoveryIndex();
  index.remember('one', new Map(Array.from({length: 10}, (_, n) => [id(n + 1), [hint(n + 1)]])), null, id(16), false);
  const related = relatedDiscoveryMemories(index.snapshot('one', id(16)), [hint(18)]);
  expect(related.memoryIds.length).toBeLessThanOrEqual(COMMON_MEMORY_INDEX_LIMITS.relatedMemories);
  // Many copies of a generated paragraph are not offered as a shared lesson.
  expect(related.memoryIds).toEqual([]);
  const snapshot = index.snapshot('one', id(16));
  const long = snapshot.hints[0]!;
  const huge = {...snapshot, hints: Array.from({length: 400}, (_, n) => ({...long, memoryId: id(n + 1), text: 'abcdefghijklmnop'.repeat(50)}))};
  const result = relatedDiscoveryMemories(huge, [hint(500)]);
  expect(result.truncated).toBe(true);
  expect(result.memoryIds.length).toBeLessThanOrEqual(COMMON_MEMORY_INDEX_LIMITS.relatedMemories);
});
