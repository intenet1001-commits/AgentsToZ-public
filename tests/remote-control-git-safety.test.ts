import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeRemoteControlSafeMerge,
  executeRemoteControlSafePull,
  executeRemoteControlSafePush,
  type RemoteControlGitCommandResult,
} from '../src/remoteControlGitSafety';

const tempRoots: string[] = [];

function git(cwd: string, args: string[]): RemoteControlGitCommandResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.file.allow',
      GIT_CONFIG_VALUE_0: 'always',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    timedOut: false,
  };
}

function mustGit(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const runGit = async (cwd: string, args: string[]): Promise<RemoteControlGitCommandResult> => git(cwd, args);
const isTrustedRemote = () => true;

function configureIdentity(path: string) {
  mustGit(path, ['config', 'user.name', 'Remote Control Test']);
  mustGit(path, ['config', 'user.email', 'remote-control@example.test']);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-remote-git-'));
  tempRoots.push(root);
  const bare = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const primary = join(root, 'primary');
  const peer = join(root, 'peer');

  mustGit(root, ['init', '--bare', bare]);
  mustGit(root, ['init', '--initial-branch=trunk', seed]);
  configureIdentity(seed);
  writeFileSync(join(seed, 'shared.txt'), 'base\n');
  mustGit(seed, ['add', 'shared.txt']);
  mustGit(seed, ['commit', '-m', 'initial']);
  mustGit(seed, ['remote', 'add', 'origin', bare]);
  mustGit(seed, ['push', '--set-upstream', 'origin', 'trunk']);
  mustGit(bare, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  mustGit(root, ['clone', bare, primary]);
  mustGit(root, ['clone', bare, peer]);
  configureIdentity(primary);
  configureIdentity(peer);
  return { root, bare, primary, peer };
}

function commitFile(path: string, content: string, message: string) {
  writeFileSync(join(path, 'shared.txt'), content);
  mustGit(path, ['add', 'shared.txt']);
  mustGit(path, ['commit', '-m', message]);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('remote Git safety against real repositories', () => {
  test('fast-forwards a clean branch and preserves dirty or diverged repositories', async () => {
    const fixture = makeFixture();
    commitFile(fixture.peer, 'remote one\n', 'remote one');
    mustGit(fixture.peer, ['push']);

    await executeRemoteControlSafePull({
      workingPath: fixture.primary,
      runGit,
      isTrustedRemote,
    });
    expect(mustGit(fixture.primary, ['rev-parse', 'HEAD'])).toBe(mustGit(fixture.bare, ['rev-parse', 'trunk']));

    const dirtyPath = join(fixture.primary, 'dirty.txt');
    writeFileSync(dirtyPath, 'not committed\n');
    const dirtyHead = mustGit(fixture.primary, ['rev-parse', 'HEAD']);
    await expect(executeRemoteControlSafePull({
      workingPath: fixture.primary,
      runGit,
      isTrustedRemote,
    })).rejects.toMatchObject({ code: 'GIT_WORKTREE_DIRTY' });
    expect(mustGit(fixture.primary, ['rev-parse', 'HEAD'])).toBe(dirtyHead);
    unlinkSync(dirtyPath);

    commitFile(fixture.primary, 'local branch\n', 'local branch');
    commitFile(fixture.peer, 'remote branch\n', 'remote branch');
    mustGit(fixture.peer, ['push']);
    const divergedHead = mustGit(fixture.primary, ['rev-parse', 'HEAD']);
    await expect(executeRemoteControlSafePull({
      workingPath: fixture.primary,
      runGit,
      isTrustedRemote,
    })).rejects.toMatchObject({ code: 'GIT_BRANCH_DIVERGED' });
    expect(mustGit(fixture.primary, ['rev-parse', 'HEAD'])).toBe(divergedHead);
  });

  test('pushes only the attached branch and rejects a detached HEAD', async () => {
    const fixture = makeFixture();
    mustGit(fixture.primary, ['switch', '-c', 'feature']);
    commitFile(fixture.primary, 'feature\n', 'feature');
    await executeRemoteControlSafePush({
      workingPath: fixture.primary,
      runGit,
      isTrustedRemote,
    });
    expect(mustGit(fixture.bare, ['rev-parse', 'feature'])).toBe(mustGit(fixture.primary, ['rev-parse', 'HEAD']));

    mustGit(fixture.primary, ['switch', '--detach']);
    await expect(executeRemoteControlSafePush({
      workingPath: fixture.primary,
      runGit,
      isTrustedRemote,
    })).rejects.toMatchObject({ code: 'DETACHED_HEAD' });
  });

  test('merges an exactly-pushed linked worktree locally without pushing the default branch', async () => {
    const fixture = makeFixture();
    const worktree = join(fixture.root, 'feature-worktree');
    mustGit(fixture.primary, ['worktree', 'add', '-b', 'feature', worktree]);
    configureIdentity(worktree);
    commitFile(worktree, 'feature\n', 'feature');
    mustGit(worktree, ['push', '--set-upstream', 'origin', 'feature']);
    const remoteDefaultBefore = mustGit(fixture.bare, ['rev-parse', 'trunk']);

    await executeRemoteControlSafeMerge({
      worktreePath: worktree,
      runGit,
      isTrustedRemote,
    });

    expect(mustGit(fixture.primary, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/)).toHaveLength(3);
    expect(mustGit(fixture.bare, ['rev-parse', 'trunk'])).toBe(remoteDefaultBefore);

    // Merging the same branch again is a no-op: `git merge` exits 0 with
    // "Already up to date." and the phone was told the merge had happened.
    // Say nothing-to-do instead of reporting work that did not occur.
    // (Push the merge first, otherwise the diverged-default guard stops it
    // earlier and this case never becomes reachable.)
    mustGit(fixture.primary, ['push', 'origin', 'trunk']);
    await expect(executeRemoteControlSafeMerge({
      worktreePath: worktree,
      runGit,
      isTrustedRemote,
    })).rejects.toMatchObject({ code: 'GIT_MERGE_NOTHING_TO_DO' });

    writeFileSync(join(worktree, 'dirty.txt'), 'not committed\n');
    await expect(executeRemoteControlSafeMerge({
      worktreePath: worktree,
      runGit,
      isTrustedRemote,
    })).rejects.toMatchObject({ code: 'GIT_WORKTREE_DIRTY' });
  });

  test('preflights conflicts without leaving an active merge', async () => {
    const fixture = makeFixture();
    const worktree = join(fixture.root, 'conflicting-worktree');
    mustGit(fixture.primary, ['worktree', 'add', '-b', 'conflict-feature', worktree]);
    configureIdentity(worktree);
    commitFile(worktree, 'feature side\n', 'feature side');
    mustGit(worktree, ['push', '--set-upstream', 'origin', 'conflict-feature']);
    commitFile(fixture.peer, 'default side\n', 'default side');
    mustGit(fixture.peer, ['push']);

    await expect(executeRemoteControlSafeMerge({
      worktreePath: worktree,
      runGit,
      isTrustedRemote,
    })).rejects.toMatchObject({ code: 'GIT_MERGE_CONFLICT' });
    expect(mustGit(fixture.primary, ['rev-parse', 'HEAD'])).toBe(mustGit(fixture.bare, ['rev-parse', 'trunk']));
    expect(git(fixture.primary, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok).toBe(false);
  });

  test('rejects an untrusted origin before pull, push, or merge can contact it', async () => {
    const fixture = makeFixture();
    const worktree = join(fixture.root, 'untrusted-worktree');
    mustGit(fixture.primary, ['worktree', 'add', '-b', 'untrusted-feature', worktree]);
    configureIdentity(worktree);
    const remoteDefaultBefore = mustGit(fixture.bare, ['rev-parse', 'trunk']);

    await expect(executeRemoteControlSafePull({
      workingPath: fixture.primary,
      runGit,
      isTrustedRemote: () => false,
    })).rejects.toMatchObject({ code: 'GITHUB_REMOTE_REQUIRED' });
    await expect(executeRemoteControlSafePush({
      workingPath: worktree,
      runGit,
      isTrustedRemote: () => false,
    })).rejects.toMatchObject({ code: 'GITHUB_REMOTE_REQUIRED' });
    await expect(executeRemoteControlSafeMerge({
      worktreePath: worktree,
      runGit,
      isTrustedRemote: () => false,
    })).rejects.toMatchObject({ code: 'GITHUB_REMOTE_REQUIRED' });
    expect(mustGit(fixture.bare, ['rev-parse', 'trunk'])).toBe(remoteDefaultBefore);
    expect(git(fixture.bare, ['show-ref', '--verify', '--quiet', 'refs/heads/untrusted-feature']).ok).toBe(false);
  });

  test('refuses to merge a linked branch until its exact commit is pushed', async () => {
    const fixture = makeFixture();
    const worktree = join(fixture.root, 'local-only-worktree');
    mustGit(fixture.primary, ['worktree', 'add', '-b', 'local-only', worktree]);
    configureIdentity(worktree);
    commitFile(worktree, 'local only\n', 'local only');
    const primaryBefore = mustGit(fixture.primary, ['rev-parse', 'HEAD']);

    await expect(executeRemoteControlSafeMerge({
      worktreePath: worktree,
      runGit,
      isTrustedRemote,
    })).rejects.toMatchObject({ code: 'FEATURE_BRANCH_NOT_PUSHED' });
    expect(mustGit(fixture.primary, ['rev-parse', 'HEAD'])).toBe(primaryBefore);
    expect(git(fixture.primary, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok).toBe(false);
  });

  test('validates every pushurl instead of trusting a GitHub fetch or first push URL', async () => {
    const fixture = makeFixture();
    mustGit(fixture.primary, ['switch', '-c', 'blocked-push']);
    commitFile(fixture.primary, 'blocked push\n', 'blocked push');
    mustGit(fixture.primary, ['remote', 'set-url', 'origin', 'https://github.com/example/allowed-fetch.git']);
    mustGit(fixture.primary, ['remote', 'set-url', '--push', 'origin', 'https://github.com/example/allowed-push.git']);
    mustGit(fixture.primary, ['remote', 'set-url', '--add', '--push', 'origin', fixture.bare]);
    const commands: string[] = [];
    const recordingRunner = async (cwd: string, args: string[]) => {
      commands.push(args.join(' '));
      return git(cwd, args);
    };

    await expect(executeRemoteControlSafePush({
      workingPath: fixture.primary,
      runGit: recordingRunner,
      isTrustedRemote: value => value.trim().startsWith('https://github.com/'),
    })).rejects.toMatchObject({ code: 'GITHUB_REMOTE_REQUIRED' });
    expect(commands).toContain('remote get-url --push --all origin');
    expect(commands.some(command => command.startsWith('push '))).toBe(false);
    expect(git(fixture.bare, ['show-ref', '--verify', '--quiet', 'refs/heads/blocked-push']).ok).toBe(false);
  });
});
