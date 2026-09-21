import { describe, expect, test } from 'bun:test';
import {
  parseGitWorktreePorcelain,
  resolvePrimaryWorktreeBranch,
} from '../git-worktree-list';

describe('git worktree porcelain parsing', () => {
  test('keeps named branches, nested names, locks, and the primary record', () => {
    const worktrees = parseGitWorktreePorcelain([
      'worktree /repo/main',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/worktrees/feature',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/refresh-safe',
      'locked active Claude session',
      '',
    ].join('\n'));

    expect(worktrees).toEqual([
      {
        path: '/repo/main',
        head: '1111111111111111111111111111111111111111',
        branch: 'main',
        detached: false,
        isMain: true,
        locked: false,
      },
      {
        path: '/repo/worktrees/feature',
        head: '2222222222222222222222222222222222222222',
        branch: 'feature/refresh-safe',
        detached: false,
        isMain: false,
        locked: true,
        lockedReason: 'active Claude session',
      },
    ]);
  });

  test('preserves detached HEAD rather than inventing a branch after refresh', () => {
    const [worktree] = parseGitWorktreePorcelain([
      'worktree /repo/worktrees/review',
      'HEAD abcdef1234567890abcdef1234567890abcdef12',
      'detached',
      '',
    ].join('\r\n'));

    expect(worktree).toMatchObject({
      path: '/repo/worktrees/review',
      head: 'abcdef1234567890abcdef1234567890abcdef12',
      branch: undefined,
      detached: true,
    });
  });

  test('uses the porcelain primary record as the comparison base even with stale records', () => {
    const worktrees = parseGitWorktreePorcelain([
      'worktree /removed-primary',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /repo/worktrees/active',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/current',
      '',
    ].join('\n'));

    expect(resolvePrimaryWorktreeBranch(worktrees)).toBe('main');
    expect(resolvePrimaryWorktreeBranch([
      { isMain: true, branch: undefined },
      { isMain: false, branch: 'feature/current' },
    ])).toBeUndefined();
  });
});
