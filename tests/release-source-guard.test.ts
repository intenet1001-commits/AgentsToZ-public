import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRemoteDefaultHead,
  verifyReleaseSource,
  type GitCommandResult,
} from '../releaseSourceGuard';

const localSha = '1111111111111111111111111111111111111111';
const otherSha = '2222222222222222222222222222222222222222';

function runner(overrides: Record<string, GitCommandResult> = {}) {
  return (args: string[]): GitCommandResult => {
    const key = args.join(' ');
    if (overrides[key]) return overrides[key];
    if (key === 'status --porcelain=v1 --untracked-files=all') return { exitCode: 0, stdout: '', stderr: '' };
    if (key === 'rev-parse HEAD') return { exitCode: 0, stdout: `${localSha}\n`, stderr: '' };
    if (key === 'symbolic-ref --quiet --short HEAD') return { exitCode: 0, stdout: 'codex/safe-build\n', stderr: '' };
    if (key === 'remote get-url origin') return { exitCode: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' };
    if (key === 'ls-remote --symref origin HEAD') {
      return { exitCode: 0, stdout: `ref: refs/heads/trunk\tHEAD\n${localSha}\tHEAD\n`, stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${key}` };
  };
}

describe('macOS release source guard', () => {
  test('discovers the actual remote default branch instead of assuming main', () => {
    expect(parseRemoteDefaultHead(`ref: refs/heads/release\tHEAD\n${localSha}\tHEAD\n`)).toEqual({
      defaultBranch: 'release',
      remoteHeadSha: localSha,
    });
    const result = verifyReleaseSource({ runGit: runner() });
    expect(result.defaultBranch).toBe('trunk');
    expect(result.headSha).toBe(result.remoteHeadSha);
  });

  test('rejects an unmerged feature branch before version files can change', () => {
    expect(() => verifyReleaseSource({
      runGit: runner({
        'ls-remote --symref origin HEAD': {
          exitCode: 0,
          stdout: `ref: refs/heads/trunk\tHEAD\n${otherSha}\tHEAD\n`,
          stderr: '',
        },
      }),
    })).toThrow('미병합·미푸시 소스');
  });

  test('rejects tracked and untracked worktree changes', () => {
    expect(() => verifyReleaseSource({
      runGit: runner({
        'status --porcelain=v1 --untracked-files=all': {
          exitCode: 0,
          stdout: ' M src/App.tsx\n?? local-output.txt\n',
          stderr: '',
        },
      }),
    })).toThrow('worktree가 깨끗해야');
  });

  test('fails closed when the live remote default cannot be queried', () => {
    expect(() => verifyReleaseSource({
      runGit: runner({
        'ls-remote --symref origin HEAD': { exitCode: 128, stdout: '', stderr: 'network unavailable' },
      }),
    })).toThrow('network unavailable');
  });

  test('explicit unpublished override still requires a clean worktree', () => {
    const result = verifyReleaseSource({ runGit: runner(), allowUnpublishedSource: true });
    expect(result.unpublishedOverride).toBe(true);
    expect(result.remoteHeadSha).toBe('');

    expect(() => verifyReleaseSource({
      allowUnpublishedSource: true,
      runGit: runner({
        'status --porcelain=v1 --untracked-files=all': { exitCode: 0, stdout: ' M src/App.tsx\n', stderr: '' },
      }),
    })).toThrow('worktree가 깨끗해야');
  });

  test('works against a real non-main remote and blocks the next unpushed commit', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'agentstoz-release-source-'));
    const remotePath = join(fixture, 'remote.git');
    const checkout = join(fixture, 'checkout');
    const git = (cwd: string, args: string[]): GitCommandResult => {
      const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    const mustGit = (cwd: string, args: string[]) => {
      const result = git(cwd, args);
      if (result.exitCode !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
    };

    try {
      mustGit(fixture, ['init', '--bare', remotePath]);
      mustGit(fixture, ['clone', remotePath, checkout]);
      mustGit(checkout, ['config', 'user.name', 'Release Guard Test']);
      mustGit(checkout, ['config', 'user.email', 'release-guard@example.invalid']);
      writeFileSync(join(checkout, 'tracked.txt'), 'published\n');
      mustGit(checkout, ['add', 'tracked.txt']);
      mustGit(checkout, ['commit', '-m', 'published']);
      mustGit(checkout, ['branch', '-M', 'release']);
      mustGit(checkout, ['push', '-u', 'origin', 'release']);
      mustGit(fixture, ['--git-dir', remotePath, 'symbolic-ref', 'HEAD', 'refs/heads/release']);

      const published = verifyReleaseSource({ runGit: args => git(checkout, args) });
      expect(published.defaultBranch).toBe('release');
      expect(published.headSha).toBe(published.remoteHeadSha);

      writeFileSync(join(checkout, 'tracked.txt'), 'unpublished\n');
      mustGit(checkout, ['add', 'tracked.txt']);
      mustGit(checkout, ['commit', '-m', 'not pushed']);
      expect(() => verifyReleaseSource({ runGit: args => git(checkout, args) })).toThrow('미병합·미푸시 소스');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
