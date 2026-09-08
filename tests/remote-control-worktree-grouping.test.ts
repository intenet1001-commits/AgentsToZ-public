import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  groupRemoteControlCards,
  remoteControlWorktreeGroupLabel,
} from '../src/remoteControlWorktreeGrouping';

const mobilePageSource = readFileSync(new URL('../src/remoteControlMobilePage.ts', import.meta.url), 'utf8');
const portalSource = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');

const main = (name: string) => ({ kind: 'main' as const, name });
const worktree = (name: string) => ({ kind: 'worktree' as const, name });

describe('remote control worktree grouping', () => {
  test('collects each run of worktrees under the project card in front of it', () => {
    const rows = groupRemoteControlCards([
      main('a'), worktree('a-1'), worktree('a-2'),
      main('b'),
      main('c'), worktree('c-1'),
    ]);
    expect(rows).toEqual([
      { type: 'project', card: main('a') },
      { type: 'worktrees', parent: main('a'), cards: [worktree('a-1'), worktree('a-2')] },
      { type: 'project', card: main('b') },
      { type: 'project', card: main('c') },
      { type: 'worktrees', parent: main('c'), cards: [worktree('c-1')] },
    ]);
  });

  test('keeps worktrees whose parent is missing instead of dropping them', () => {
    // 검색으로 부모가 걸러졌거나, 부모가 아직 안 불러와진 페이지에 있는 경우다.
    const rows = groupRemoteControlCards([worktree('x-1'), worktree('x-2'), main('y')]);
    expect(rows).toEqual([
      { type: 'worktrees', parent: null, cards: [worktree('x-1'), worktree('x-2')] },
      { type: 'project', card: main('y') },
    ]);
  });

  test('never loses or duplicates a card', () => {
    const cards = [main('a'), worktree('a-1'), main('b'), worktree('b-1'), worktree('b-2'), main('c')];
    const flattened = groupRemoteControlCards(cards)
      .flatMap(row => (row.type === 'project' ? [row.card] : row.cards));
    expect(flattened).toEqual(cards);
  });

  test('an empty list produces no rows', () => {
    expect(groupRemoteControlCards([])).toEqual([]);
  });

  test('labels a group by its count', () => {
    expect(remoteControlWorktreeGroupLabel(1)).toBe('워크트리 1개');
    expect(remoteControlWorktreeGroupLabel(3)).toBe('워크트리 3개');
  });

  // ⚠️ 모바일 렌더러가 두 벌이라, 한쪽에만 넣으면 그 화면에서는 기능이 조용히
  // 없는 것이 된다 (Git·워크트리 액션이 실제로 그렇게 갈렸다).
  test('both mobile surfaces render the worktree group, not a flat list', () => {
    expect(portalSource).toContain("import { groupRemoteControlCards, remoteControlWorktreeGroupLabel } from './remoteControlWorktreeGrouping';");
    expect(portalSource).toContain('remote-worktree-group');
    expect(portalSource).toContain("data-testid=\"remote-worktree-group\"");

    expect(mobilePageSource).toContain('worktree-group');
    expect(mobilePageSource).toContain('\\uC6CC\\uD06C\\uD2B8\\uB9AC ');
  });

  test('both mobile surfaces can be searched with the same normalization as the desktop', () => {
    // 데스크톱은 VOC 2026-08-24-1402 이후 NFKC 정규화를 쓴다. 휴대폰만 raw
    // toLocaleLowerCase 를 쓰면 macOS 파일명의 분해형 한글이 검색되지 않는다.
    expect(portalSource).toContain("import { normalizeSearchText } from './searchText';");
    expect(portalSource).toContain('normalizeSearchText(query.trim())');
    expect(portalSource).not.toContain('query.trim().toLocaleLowerCase()');

    expect(mobilePageSource).toContain('project-search');
    expect(mobilePageSource).toContain('normalize("NFKC")');
  });
});
