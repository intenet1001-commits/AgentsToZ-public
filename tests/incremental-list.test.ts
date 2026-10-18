import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  INCREMENTAL_LIST_PAGE,
  incrementalRenderLimit,
  nextIncrementalLimit,
  sliceAcrossGroups,
} from '../src/incrementalList';

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

describe('incremental list primitive', () => {
  test('first page is bounded and grows one page at a time up to the total', () => {
    expect(INCREMENTAL_LIST_PAGE).toBeGreaterThan(0);
    expect(incrementalRenderLimit(2000, INCREMENTAL_LIST_PAGE)).toBe(INCREMENTAL_LIST_PAGE);
    expect(incrementalRenderLimit(3, INCREMENTAL_LIST_PAGE)).toBe(3);
    expect(nextIncrementalLimit(40, 2000, 40)).toBe(80);
    expect(nextIncrementalLimit(1990, 2000, 40)).toBe(2000);
    expect(nextIncrementalLimit(0, 0, 40)).toBe(0);
  });

  test('a grouped list spends one budget across groups in order and keeps each group total', () => {
    const groups = [
      { key: 'pinned', items: [1, 2] },
      { key: 'a', items: [3, 4, 5] },
      { key: 'empty', items: [] as number[] },
      { key: 'b', items: [6, 7] },
    ];
    const sliced = sliceAcrossGroups(groups, 4);
    expect(sliced.map(g => [g.key, g.items, g.total])).toEqual([
      ['pinned', [1, 2], 2],
      ['a', [3, 4], 3],
    ]);
    // Everything visible: groups keep their order, empty groups are dropped.
    expect(sliceAcrossGroups(groups, 100).map(g => g.key)).toEqual(['pinned', 'a', 'b']);
  });
});

describe('long lists render in pages, not all at once', () => {
  test('bookmarks, 내가 한 말, cleanup review and the archive use the shared primitive', () => {
    for (const file of ['PortalManager.tsx', 'WhatISaidPanel.tsx', 'App.tsx', 'memory/MemoryArchivePanel.tsx']) {
      const source = read(file);
      expect(source).toContain('useIncrementalRender(');
      expect(source).toContain('<IncrementalListMore');
    }
    // Every bookmark map now goes through the budget instead of the raw arrays.
    const portal = read('PortalManager.tsx');
    expect(portal).not.toContain('{unpinnedItems.map(item =>');
    expect(portal).not.toContain('{catItems.map(item =>');
    // Search typing must not re-filter 2000 cards per keystroke.
    expect(portal).toContain('useDeferredValue(search)');
    expect(read('memory/MemoryArchivePanel.tsx')).not.toContain('{filtered.map(item =>');
    expect(read('App.tsx')).not.toContain('{v3IdleStale.map(item =>');
    expect(read('WhatISaidPanel.tsx')).not.toContain('{listState.items.map(item =>');
  });
});

test('내가 한 말 clamps only prompts longer than four lines', async () => {
  const { isLongWhatISaidPrompt } = await import('../src/WhatISaidPanel');
  expect(isLongWhatISaidPrompt('짧은 요청')).toBe(false);
  expect(isLongWhatISaidPrompt('1\n2\n3\n4')).toBe(false);
  expect(isLongWhatISaidPrompt('1\n2\n3\n4\n5')).toBe(true);
  expect(isLongWhatISaidPrompt('가'.repeat(400))).toBe(true);
});
