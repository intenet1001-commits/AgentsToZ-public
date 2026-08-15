import { describe, expect, test } from 'bun:test';
import {
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
});
