import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectMemoryJournalCache } from '../src/projectMemoryJournalCache';
import {
  appendProjectMemoryJournal,
  buildProjectMemoryJournalEntry,
  projectMemoryJournalCacheUsage,
  readProjectMemoryJournal,
  renderProjectMemoryJournalEntry,
  resetProjectMemoryJournalCache,
} from '../project-memory-server';

const roots: string[] = [];
afterEach(() => { resetProjectMemoryJournalCache(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryRoot() { const root = mkdtempSync(join(tmpdir(), 'agentstoz-journal-cache-')); roots.push(root); return root; }
function entry(text: string) { return buildProjectMemoryJournalEntry({ recordedAt: '2026-09-07T00:00:00Z', narrative: text }); }
function journal(root: string, entries: ReturnType<typeof entry>[]) {
  const directory = join(root, '.agent-memory/journal'); mkdirSync(directory, { recursive: true });
  const path = join(directory, '2026-09.md'); writeFileSync(path, entries.map(renderProjectMemoryJournalEntry).join('\n') + '\n'); return path;
}

test('journal LRU accounts for replacement, access order, root count and oversized snapshots', () => {
  const cache = new ProjectMemoryJournalCache<object>(100, 2);
  const a = {}, b = {}, c = {};
  cache.set('a', a, 40); cache.set('b', b, 40); expect(cache.get('a')).toBe(a);
  cache.set('c', c, 40); expect(cache.get('b')).toBeUndefined(); expect(cache.estimatedBytes).toBe(80);
  cache.set('a', a, 90); expect(cache.get('c')).toBeUndefined(); expect(cache.estimatedBytes).toBe(90);
  cache.set('huge', {}, 101); expect(cache.get('huge')).toBeUndefined(); expect(cache.get('a')).toBe(a);
  cache.set('a', {}, 101); expect(cache.estimatedBytes).toBe(0);
  cache.set('a', {}, 1); cache.set('b', {}, 1); cache.set('c', {}, 1); expect(cache.size).toBe(2);
  cache.clear(); expect(cache.size).toBe(0); expect(cache.estimatedBytes).toBe(0);
});

test('the real journal cache stays within its process budget and rereads evicted roots without changing history', () => {
  resetProjectMemoryJournalCache();
  const parent = temporaryRoot();
  const locations: Array<{ root: string; path: string; source: string }> = [];
  for (let i = 0; i < 10; i++) {
    const root = join(parent, `project-${i}`); mkdirSync(root);
    const entries = Array.from({ length: 60 }, (_, n) => entry(`${i}:${n} ` + 'x'.repeat(8_000)));
    const path = journal(root, entries), source = readFileSync(path, 'utf8'); locations.push({ root, path, source });
    expect(readProjectMemoryJournal(root)).toHaveLength(60);
    const usage = projectMemoryJournalCacheUsage();
    expect(usage.estimatedBytes).toBeLessThanOrEqual(usage.maxBytes);
  }
  expect(projectMemoryJournalCacheUsage().roots).toBeLessThan(locations.length);
  for (const location of locations) {
    expect(readProjectMemoryJournal(location.root)).toHaveLength(60);
    expect(readFileSync(location.path, 'utf8')).toBe(location.source);
  }
});

test('oversized journals stay fully readable while stamp changes and durable appends invalidate or refresh the cache', () => {
  const root = temporaryRoot();
  const entries = Array.from({ length: 550 }, (_, n) => entry(`${n} ` + 'y'.repeat(8_000)));
  const path = journal(root, entries); resetProjectMemoryJournalCache();
  expect(readProjectMemoryJournal(root)).toHaveLength(550);
  expect(projectMemoryJournalCacheUsage().roots).toBe(0);
  const added = entry('a durable additional entry');
  appendProjectMemoryJournal(root, added); appendProjectMemoryJournal(root, added);
  expect(readProjectMemoryJournal(root)).toHaveLength(551);
  expect(projectMemoryJournalCacheUsage().roots).toBe(0);
  const small = temporaryRoot(), first = entry('first'), next = entry('externally appended second');
  const smallPath = journal(small, [first]); expect(readProjectMemoryJournal(small)).toHaveLength(1);
  appendFileSync(smallPath, renderProjectMemoryJournalEntry(next) + '\n');
  expect(readProjectMemoryJournal(small).map(item => item.entryHash)).toEqual([first, next].map(item => item.entryHash).sort());
  expect(readFileSync(path, 'utf8')).toContain(renderProjectMemoryJournalEntry(added));
});
