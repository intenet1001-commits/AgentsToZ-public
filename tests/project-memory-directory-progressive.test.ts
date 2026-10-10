import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  loadAllMemoryHeadRows,
  loadMemoryDirectory,
  MEMORY_HEAD_PAGE_SIZE,
  resetMemoryDirectoryCache,
  type MemoryDirectoryLoad,
  type MemoryRevisionRow,
} from '../src/projectMemoryDirectory';

const head = (index: number): MemoryRevisionRow => ({
  id: `rev-${index}`,
  memory_id: `m-${String(index).padStart(5, '0')}`,
  created_at: '2026-09-01T00:00:00Z',
  project_name: `프로젝트 ${index}`,
  github_url: null,
  device_id: 'device-a',
  device_name: 'MacBook',
  content_hash: `hash-${index}`,
});

function pagedSource(total: number) {
  const source = Array.from({ length: total }, (_, index) => head(index));
  const gates: Array<() => void> = [];
  let calls = 0;
  const query = async (afterMemoryId: string | null, limit: number) => {
    calls += 1;
    // Every page after the first waits until the test releases it.
    if (afterMemoryId !== null) await new Promise<void>(resolve => gates.push(resolve));
    return {
      data: source.filter(item => afterMemoryId === null || item.memory_id! > afterMemoryId).slice(0, limit),
      error: null,
    };
  };
  const releaseAll = async () => {
    for (let spins = 0; spins < 50; spins += 1) {
      while (gates.length) gates.shift()!();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  return { query, releaseAll, calls: () => calls };
}

describe('장기기억 탭 첫 화면은 head 페이지를 끝까지 기다리지 않는다', () => {
  test('loadAllMemoryHeadRows reports each page as it arrives', async () => {
    const source = pagedSource(5);
    const pages: Array<{ rows: number; done: boolean }> = [];
    const loading = loadAllMemoryHeadRows(source.query, 2, (rows, done) => pages.push({ rows: rows.length, done }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pages).toEqual([{ rows: 2, done: false }]);
    await source.releaseAll();
    expect(await loading).toHaveLength(5);
    expect(pages.at(-1)).toEqual({ rows: 5, done: true });
  });

  test('the first head page is painted as a partial directory while the rest keeps loading', async () => {
    resetMemoryDirectoryCache();
    const total = MEMORY_HEAD_PAGE_SIZE * 2 + 10;
    const source = pagedSource(total);
    const progress: MemoryDirectoryLoad[] = [];
    let settled = false;
    const loading = loadMemoryDirectory('progressive', async () => ({ data: [], error: null }), {
      headPageQuery: source.query,
      onProgress: partial => progress.push(partial),
    }).then(value => { settled = true; return value; });

    for (let spins = 0; spins < 20 && progress.length === 0; spins += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(settled).toBe(false);
    expect(progress).toHaveLength(1);
    expect(progress[0]!.complete).toBe(false);
    expect(progress[0]!.entries).toHaveLength(MEMORY_HEAD_PAGE_SIZE);

    await source.releaseAll();
    const loaded = await loading;
    expect(loaded.complete).toBe(true);
    expect(loaded.entries).toHaveLength(total);
    // The partial is never served as the cached value.
    expect(await loadMemoryDirectory('progressive', async () => ({ data: [], error: null }))).toBe(loaded);
  });

  test('a directory that fits in one page reports no partial state', async () => {
    resetMemoryDirectoryCache();
    const source = pagedSource(12);
    const progress: MemoryDirectoryLoad[] = [];
    const loaded = await loadMemoryDirectory('one-page', async () => ({ data: [], error: null }), {
      headPageQuery: source.query,
      onProgress: partial => progress.push(partial),
    });
    expect(progress).toEqual([]);
    expect(loaded.complete).toBe(true);
    expect(loaded.entries).toHaveLength(12);
  });

  test('the tab paints the partial directory but never replaces a complete one with it', () => {
    const tab = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
    expect(tab.includes('onProgress: partial => setLoaded(previous =>')).toBe(true);
    expect(tab.includes("previous && previous.complete !== false ? previous : partial")).toBe(true);
    expect(tab.includes('data-testid="portal-memory-progressive-loading"')).toBe(true);
  });
});
