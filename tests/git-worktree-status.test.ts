import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIT_VOLATILE_ARTIFACT_PATHSPECS,
  isGitHubRemoteUrl,
  parseGitStatusPorcelainV2,
} from '../git-worktree-status';

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.toString();
}

describe('parseGitStatusPorcelainV2', () => {
  test('recognizes GitHub HTTPS and SSH remotes without accepting other hosts', () => {
    expect(isGitHubRemoteUrl('https://github.com/example/project.git')).toBe(true);
    expect(isGitHubRemoteUrl('git@github.com:example/project.git')).toBe(true);
    expect(isGitHubRemoteUrl('ssh://git@github.com/example/project.git')).toBe(true);
    expect(isGitHubRemoteUrl('https://gitlab.com/example/project.git')).toBe(false);
    expect(isGitHubRemoteUrl('')).toBe(false);
  });

  test('reads a clean branch that is synchronized with its upstream', () => {
    expect(parseGitStatusPorcelainV2([
      '# branch.oid 0123456789abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n'))).toEqual({
      changedFiles: 0,
      stagedFiles: 0,
      untrackedFiles: 0,
      conflictedFiles: 0,
      hasCommits: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
    });
  });

  test('counts staged, unstaged, renamed, untracked, and conflicted files once each', () => {
    const result = parseGitStatusPorcelainV2([
      '# branch.oid 0123456789abcdef',
      '# branch.head feature',
      '# branch.upstream origin/feature',
      '# branch.ab +3 -2',
      '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb staged.ts',
      '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb modified.ts',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.ts',
      '? new-file.ts',
    ].join('\n'));

    expect(result).toMatchObject({
      changedFiles: 5,
      stagedFiles: 2,
      untrackedFiles: 1,
      conflictedFiles: 1,
      ahead: 3,
      behind: 2,
    });
  });

  test('recognizes a repository with no first commit', () => {
    const result = parseGitStatusPorcelainV2([
      '# branch.oid (initial)',
      '# branch.head main',
      '? README.md',
    ].join('\n'));

    expect(result.hasCommits).toBe(false);
    expect(result.changedFiles).toBe(1);
    expect(result.untrackedFiles).toBe(1);
  });

  test('ignores continuously changing Playwright artifacts in status and automatic staging', () => {
    const root = mkdtempSync(join(tmpdir(), 'portmanager-git-status-'));
    try {
      git(root, ['init', '-b', 'main']);
      git(root, ['config', 'user.name', 'Worktree Status Test']);
      git(root, ['config', 'user.email', 'worktree-status@example.test']);
      mkdirSync(join(root, '.playwright-cli'), { recursive: true });
      mkdirSync(join(root, 'output/playwright'), { recursive: true });
      mkdirSync(join(root, '.claude/worktrees/task-1'), { recursive: true });
      writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
      writeFileSync(join(root, '.gitignore'), 'worktrees\n');
      writeFileSync(join(root, '.claude/worktrees/task-1/.git'), 'gitdir: placeholder\n');
      writeFileSync(join(root, '.playwright-cli/runtime.log'), 'initial\n');
      writeFileSync(join(root, 'output/playwright/state.png'), 'initial\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'initial']);

      writeFileSync(join(root, 'source.ts'), 'export const value = 2;\n');
      writeFileSync(join(root, '.playwright-cli/runtime.log'), 'initial\nruntime update\n');
      writeFileSync(join(root, 'output/playwright/state.png'), 'updated\n');

      const status = git(root, [
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=normal',
        '--',
        '.',
        ...GIT_VOLATILE_ARTIFACT_PATHSPECS,
      ]);
      expect(status).toContain('source.ts');
      expect(status).not.toContain('.playwright-cli');
      expect(status).not.toContain('output/playwright');
      expect(status).not.toContain('.claude/worktrees');

      git(root, ['add', '-A', '--', '.', ...GIT_VOLATILE_ARTIFACT_PATHSPECS]);
      expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('source.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
