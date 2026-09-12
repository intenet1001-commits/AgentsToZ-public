import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireWorkspaceDirectoryLease,
  acquireWorkspaceLease,
} from '../src/workspaceLease';
import {
  listOrphanedWorkspaceLeases,
  recoverOrphanedWorkspaceLeases,
} from '../src/workspaceLeaseRecovery';

// macOS never hands out PIDs above 99_999, and Linux defaults stay far below this.
const DEAD_PID = 999_991;
const deadManualOwner = (pid = DEAD_PID) => `v3:${pid}:${'4'.repeat(32)}:manual`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; appData: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-lease-recovery-'));
  roots.push(root);
  const appData = join(root, 'app-data');
  mkdirSync(appData);
  return { root, appData };
}

function mustGit(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repositoryWithLinkedWorktree(root: string): { main: string; linked: string } {
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  mkdirSync(main);
  mustGit(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'recovery fixture\n');
  mustGit(main, 'add', 'README.md');
  mustGit(main, '-c', 'user.name=Lease Recovery', '-c', 'user.email=lease@example.invalid',
    'commit', '-qm', 'initial');
  mustGit(main, 'worktree', 'add', '-q', '-b', 'linked', linked);
  return { main, linked };
}

/** Acquire the real lock, then leave it behind exactly as a killed sidecar would. */
async function orphanDirectoryLock(appData: string, workspace: string, owner = deadManualOwner()): Promise<string> {
  const lease = await acquireWorkspaceDirectoryLease({ workspacePath: workspace, appDataDir: appData });
  const lockPath = lease.lockPath;
  expect(lease.release()).toBe(true);
  writeFileSync(lockPath, owner, { mode: 0o600 });
  return lockPath;
}

function keyOf(lockPath: string): string {
  return lockPath.split('/').pop()!.replace(/\.lock$/, '');
}

describe('listing orphaned workspace leases', () => {
  test('lists a dead manual owner and names the directory it locks', async () => {
    const { root, appData } = fixture();
    const workspace = join(root, 'freeparking-1');
    mkdirSync(workspace);
    const lockPath = await orphanDirectoryLock(appData, workspace);

    const orphans = listOrphanedWorkspaceLeases({ appDataDir: appData, candidatePaths: [workspace] });

    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      key: keyOf(lockPath),
      pid: DEAD_PID,
      kind: 'directory',
      workspacePath: realpathSync(workspace),
    });
    expect(Number.isNaN(Date.parse(orphans[0]!.lockedAt))).toBe(false);
  });

  test('maps a Git family lock from a linked worktree candidate', async () => {
    const { root, appData } = fixture();
    const { linked } = repositoryWithLinkedWorktree(root);
    const lease = await acquireWorkspaceLease({ workspacePath: linked, appDataDir: appData });
    const familyLockPath = lease.lockPath;
    expect(lease.identity.kind).toBe('git-family');
    expect(lease.release()).toBe(true);
    writeFileSync(familyLockPath, deadManualOwner(), { mode: 0o600 });

    const orphans = listOrphanedWorkspaceLeases({ appDataDir: appData, candidatePaths: [linked] });

    expect(orphans).toEqual([expect.objectContaining({
      key: keyOf(familyLockPath),
      kind: 'git-family',
      workspacePath: realpathSync(linked),
    })]);
  });

  test('ignores live, legacy, and guarded owners', async () => {
    const { root, appData } = fixture();
    const owners = [
      `v3:${process.pid}:${'1'.repeat(32)}:manual`,
      `v2:${DEAD_PID}:${'2'.repeat(32)}`,
      `v3:${DEAD_PID}:${'3'.repeat(32)}:guarded`,
    ];
    const candidates: string[] = [];
    for (const [index, owner] of owners.entries()) {
      const workspace = join(root, `workspace-${index}`);
      mkdirSync(workspace);
      candidates.push(workspace);
      await orphanDirectoryLock(appData, workspace, owner);
    }

    expect(listOrphanedWorkspaceLeases({ appDataDir: appData, candidatePaths: candidates })).toEqual([]);
  });

  test('reports an unmapped dead manual lock instead of hiding it', async () => {
    const { root, appData } = fixture();
    const workspace = join(root, 'deleted-project');
    mkdirSync(workspace);
    const lockPath = await orphanDirectoryLock(appData, workspace);
    rmSync(workspace, { recursive: true });

    expect(listOrphanedWorkspaceLeases({ appDataDir: appData, candidatePaths: [workspace] })).toEqual([
      expect.objectContaining({ key: keyOf(lockPath), kind: 'unknown', workspacePath: null }),
    ]);
  });

  test('returns nothing when no lease directory exists yet', () => {
    const { appData } = fixture();
    expect(listOrphanedWorkspaceLeases({ appDataDir: appData, candidatePaths: [] })).toEqual([]);
  });
});

describe('recovering orphaned workspace leases', () => {
  test('recovers a dead manual lock so the workspace can be acquired again', async () => {
    const { root, appData } = fixture();
    const workspace = join(root, 'song-app');
    mkdirSync(workspace);
    const lockPath = await orphanDirectoryLock(appData, workspace);
    await expect(acquireWorkspaceLease({
      workspacePath: workspace, appDataDir: appData, attempts: 1, retryMs: 1,
      deadOwnerRecoveryClass: 'manual',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LEASE_RECOVERY_REQUIRED' });

    const results = recoverOrphanedWorkspaceLeases({
      appDataDir: appData,
      locks: [{ key: keyOf(lockPath), pid: DEAD_PID }],
    });

    expect(results).toEqual([{ key: keyOf(lockPath), outcome: 'recovered' }]);
    expect(existsSync(lockPath)).toBe(false);
    const lease = await acquireWorkspaceLease({ workspacePath: workspace, appDataDir: appData, attempts: 1 });
    expect(lease.release()).toBe(true);
  });

  test('refuses to delete when the owner changed, is alive, or is not manual', async () => {
    const { root, appData } = fixture();
    const cases = [
      { owner: deadManualOwner(DEAD_PID + 1), outcome: 'owner-changed' },
      { owner: `v3:${process.pid}:${'5'.repeat(32)}:manual`, outcome: 'owner-alive', pid: process.pid },
      { owner: `v3:${DEAD_PID}:${'6'.repeat(32)}:guarded`, outcome: 'not-manual' },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      const workspace = join(root, `refused-${index}`);
      mkdirSync(workspace);
      const lockPath = await orphanDirectoryLock(appData, workspace, entry.owner);
      const pid = 'pid' in entry ? entry.pid : DEAD_PID;

      expect(recoverOrphanedWorkspaceLeases({ appDataDir: appData, locks: [{ key: keyOf(lockPath), pid }] }))
        .toEqual([{ key: keyOf(lockPath), outcome: entry.outcome }]);
      expect(existsSync(lockPath)).toBe(true);
    }
  });

  test('reports missing when the lock is already gone', () => {
    const { appData } = fixture();
    const key = 'a'.repeat(64);
    expect(recoverOrphanedWorkspaceLeases({ appDataDir: appData, locks: [{ key, pid: DEAD_PID }] }))
      .toEqual([{ key, outcome: 'missing' }]);
  });

  test('rejects malformed keys and PIDs without touching the filesystem', async () => {
    const { root, appData } = fixture();
    const workspace = join(root, 'victim');
    mkdirSync(workspace);
    const lockPath = await orphanDirectoryLock(appData, workspace);
    const key = keyOf(lockPath);

    const results = recoverOrphanedWorkspaceLeases({
      appDataDir: appData,
      locks: [
        { key: `../${key}`, pid: DEAD_PID },
        { key: key.toUpperCase(), pid: DEAD_PID },
        { key, pid: String(DEAD_PID) },
        { key, pid: 0 },
        { key: 42, pid: DEAD_PID },
      ],
    });

    expect(results.map(result => result.outcome)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    expect(existsSync(lockPath)).toBe(true);
  });
});
