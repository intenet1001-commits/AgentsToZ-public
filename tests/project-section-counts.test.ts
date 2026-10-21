import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildCurrentWorktreeOverview,
  filterCurrentWorktreeParentIds,
  getProjectSectionCounts,
  shouldShowWorktreeSection,
} from '../project-section-counts';

describe('project sidebar section counts', () => {
  test('counts persisted worktree projects independently from the active section', () => {
    const counts = getProjectSectionCounts([
      { id: 'main', isRunning: false, favorite: true },
      { id: 'main_wt_feature', worktreePath: '/repo-feature', isRunning: true },
    ]);

    expect(counts).toEqual({
      all: 1,
      running: 1,
      starred: 1,
      worktrees: 1,
    });
  });

  test('hides an unused worktree filter but keeps an active empty state navigable', () => {
    expect(shouldShowWorktreeSection(0, 'all')).toBe(false);
    expect(shouldShowWorktreeSection(0, 'wt')).toBe(true);
    expect(shouldShowWorktreeSection(2, 'all')).toBe(true);
  });

  test('counts Git-discovered worktrees and groups them under their registered parent', () => {
    const overview = buildCurrentWorktreeOverview([
      { id: 'main', favorite: true },
      { id: 'other' },
      { id: 'main_wt_old', worktreePath: '/repo/worktrees/old', worktreeParentId: 'main' },
    ], {
      main: [
        { path: '/repo', branch: 'main', is_main: true },
        { path: '/repo/worktrees/feature-a', branch: 'feature-a', is_main: false },
        { path: '/repo/worktrees/feature-b/', branch: 'feature-b', is_main: false },
        { path: '/repo/worktrees/feature-b', branch: 'duplicate', is_main: false },
      ],
      other: [{ path: '/other', branch: 'main', is_main: true }],
    });

    expect(overview.worktreeCount).toBe(2);
    expect(overview.parentProjectIds).toEqual(['main']);
    expect(overview.countByParentId).toEqual({ main: 2 });
    expect(overview.worktreesByParentId.main?.map(worktree => worktree.branch)).toEqual([
      'feature-a',
      'feature-b',
    ]);
  });

  test('never presents a persisted launch alias as a current Git worktree', () => {
    const projects = [
      { id: 'main' },
      { id: 'main_wt_old', worktreePath: '/repo/worktrees/old', worktreeParentId: 'main' },
    ];
    expect(buildCurrentWorktreeOverview(projects, {}).worktreeCount).toBe(0);
    expect(buildCurrentWorktreeOverview(projects, { main: [] }).worktreeCount).toBe(0);
    expect(buildCurrentWorktreeOverview(projects, {}, {
      main: [{ path: '/repo/worktrees/live', branch: 'live', is_main: false }],
    }).worktreeCount).toBe(1);
  });

  test('finds the parent card by an actual worktree branch or path', () => {
    const overview = buildCurrentWorktreeOverview([{ id: 'main' }, { id: 'other' }], {
      main: [
        { path: '/repo', branch: 'main', is_main: true },
        { path: '/repo/worktrees/remote-ux', branch: 'codex/remote-ux', is_main: false },
      ],
      other: [{ path: '/other', branch: 'main', is_main: true }],
    });
    expect(filterCurrentWorktreeParentIds(overview, 'REMOTE-UX', () => false)).toEqual(['main']);
    expect(filterCurrentWorktreeParentIds(overview, '/repo/worktrees/remote', () => false)).toEqual(['main']);
    expect(filterCurrentWorktreeParentIds(overview, 'registered name', id => id === 'main')).toEqual(['main']);
  });

  test('wires the Git-authoritative overview into count, parent filtering, and visible badges', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('buildCurrentWorktreeOverview(ports, discoveredWorktreeLists, worktreeLists)');
    expect(app).toContain('filterCurrentWorktreeParentIds(currentWorktreeOverview, searchQuery');
    expect(app).toContain('worktrees: filteredCurrentWorktreeCount');
    expect(app).toContain('const parentIds = new Set(filteredCurrentWorktreeParentIds)');
    expect(app).toContain('data-testid="sidebar-current-worktree-count"');
    expect(app).toContain('data-testid="current-git-worktree-count"');
    expect(app).toContain('setDiscoveredWorktreeLists(prev => mergeDiscoveredWorktreeFamilies');
    expect(app).not.toContain('한 번 이상 실행해 프로젝트 목록에 등록된 워크트리');
  });
});
