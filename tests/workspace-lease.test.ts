import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  acquireWorkspaceDirectoryLease,
  acquireWorkspaceLease,
  promoteWorkspaceDirectoryLease,
  WorkspaceLeaseError,
} from '../src/workspaceLease';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(prefix = 'agentstoz-workspace-lease-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function mustGit(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function createRepositoryWithLinkedWorktree(root: string): { main: string; linked: string } {
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  mkdirSync(main);
  mustGit(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'lease fixture\n');
  mustGit(main, 'add', 'README.md');
  mustGit(
    main,
    '-c',
    'user.name=Workspace Lease Tests',
    '-c',
    'user.email=workspace-lease@example.invalid',
    'commit',
    '-qm',
    'initial',
  );
  mustGit(main, 'worktree', 'add', '-q', '-b', 'task/linked', linked);
  return { main, linked };
}

async function childAcquire(
  workspacePath: string,
  appDataDir: string,
  attempts: number,
): Promise<Record<string, unknown>> {
  const moduleUrl = new URL('../src/workspaceLease.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '-e', `
    import { acquireWorkspaceLease, WorkspaceLeaseError } from ${JSON.stringify(moduleUrl)};
    try {
      const lease = await acquireWorkspaceLease({
        workspacePath: process.env.WORKSPACE_PATH,
        appDataDir: process.env.APP_DATA_DIR,
        attempts: Number(process.env.ATTEMPTS),
        retryMs: 5,
      });
      const refreshed = lease.refresh();
      const released = lease.release();
      process.stdout.write(JSON.stringify({
        acquired: true,
        kind: lease.identity.kind,
        key: lease.identity.key,
        refreshed,
        released,
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        acquired: false,
        code: error instanceof WorkspaceLeaseError ? error.code : 'UNKNOWN',
      }));
    }
  `], {
    env: {
      ...process.env,
      WORKSPACE_PATH: workspacePath,
      APP_DATA_DIR: appDataDir,
      ATTEMPTS: String(attempts),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  const output = await new Response(child.stdout).text();
  const errorOutput = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  children.splice(children.indexOf(child), 1);
  if (exitCode !== 0) throw new Error(errorOutput || `child exited ${exitCode}`);
  return JSON.parse(output) as Record<string, unknown>;
}

describe('workspace lease identity', () => {
  test('canonical aliases of one non-Git directory use one opaque app-data lock', async () => {
    const root = fixture();
    const workspace = join(root, 'plain-workspace');
    const alias = join(root, 'plain-alias');
    const appData = join(root, 'app-data');
    mkdirSync(workspace);
    if (process.platform !== 'win32') symlinkSync(workspace, alias, 'dir');

    const first = await acquireWorkspaceLease({ workspacePath: workspace, appDataDir: appData });
    const firstKey = first.identity.key;
    const firstPath = first.lockPath;
    expect(first.identity.kind).toBe('directory');
    expect(basename(firstPath)).toMatch(/^[0-9a-f]{64}\.lock$/);
    expect(basename(firstPath)).not.toContain('plain-workspace');
    expect(dirname(firstPath)).toBe(join(realpathSync(appData), 'workspace-leases-v1'));
    expect(first.release()).toBe(true);

    const alternatePath = process.platform === 'win32' ? join(workspace, '.') : alias;
    const second = await acquireWorkspaceLease({ workspacePath: alternatePath, appDataDir: appData });
    expect(second.identity.key).toBe(firstKey);
    expect(second.lockPath).toBe(firstPath);
    expect(second.refresh()).toBe(true);
    expect(second.release()).toBe(true);
    expect(second.release()).toBe(false);
    expect(second.refresh()).toBe(false);
  });

  test('different non-Git directories do not share an authority', async () => {
    const root = fixture();
    const firstDirectory = join(root, 'first');
    const secondDirectory = join(root, 'second');
    const appData = join(root, 'app-data');
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);

    const first = await acquireWorkspaceLease({ workspacePath: firstDirectory, appDataDir: appData });
    const second = await acquireWorkspaceLease({ workspacePath: secondDirectory, appDataDir: appData });
    expect(first.identity.kind).toBe('directory');
    expect(second.identity.kind).toBe('directory');
    expect(first.identity.key).not.toBe(second.identity.key);
    expect(first.lockPath).not.toBe(second.lockPath);
    expect(first.release()).toBe(true);
    expect(second.release()).toBe(true);
  });

  test('a main checkout and linked worktree share their Git family authority', async () => {
    const root = fixture();
    const { main, linked } = createRepositoryWithLinkedWorktree(root);
    const appData = join(root, 'app-data');

    const mainLease = await acquireWorkspaceLease({ workspacePath: main, appDataDir: appData });
    const key = mainLease.identity.key;
    const lockPath = mainLease.lockPath;
    expect(mainLease.identity.kind).toBe('git-family');
    expect(mainLease.release()).toBe(true);

    const linkedLease = await acquireWorkspaceLease({ workspacePath: linked, appDataDir: appData });
    expect(linkedLease.identity.kind).toBe('git-family');
    expect(linkedLease.identity.key).toBe(key);
    expect(linkedLease.lockPath).toBe(lockPath);
    expect(linkedLease.release()).toBe(true);
  });
});

describe('workspace lease ownership and failures', () => {
  test('encodes the selected crash-recovery class in each workspace owner', async () => {
    const root = fixture();
    const workspace = join(root, 'workspace');
    const appData = join(root, 'app-data');
    mkdirSync(workspace);

    for (const recoveryClass of ['manual', 'guarded'] as const) {
      const lease = await acquireWorkspaceLease({
        workspacePath: workspace,
        appDataDir: appData,
        deadOwnerRecoveryClass: recoveryClass,
      });
      expect(readFileSync(lease.lockPath, 'utf8')).toMatch(new RegExp(
        `^v3:${process.pid}:[0-9a-f]{32}:${recoveryClass}$`,
      ));
      expect(lease.release()).toBe(true);
    }
  });

  test('promotes a new nested child without releasing or reacquiring its directory lock', async () => {
    const root = fixture();
    const repository = join(root, 'outer-repository');
    const child = join(repository, 'new-project');
    const appData = join(root, 'app-data');
    mkdirSync(repository);
    mustGit(repository, 'init', '-q', '-b', 'main');
    const parentLease = await acquireWorkspaceLease({ workspacePath: repository, appDataDir: appData });

    mkdirSync(child);
    const childReservation = await acquireWorkspaceDirectoryLease({
      workspacePath: child,
      appDataDir: appData,
    });
    mustGit(child, 'init', '-q', '-b', 'main');

    const promoted = await promoteWorkspaceDirectoryLease(childReservation, {
      gitExecutable: 'git',
      attempts: 20,
      retryMs: 1,
    });
    expect(promoted).toBe(childReservation);
    expect(promoted.identity.kind).toBe('git-family');
    expect(childReservation.identity.kind).toBe('git-family');

    const blocked = await childAcquire(child, appData, 2);
    expect(blocked).toEqual({ acquired: false, code: 'WORKSPACE_LEASE_BUSY' });
    expect(promoted.refresh()).toBe(true);
    expect(promoted.release()).toBe(true);
    expect(parentLease.release()).toBe(true);
  });

  test('keeps the directory reservation after failed promotion and serializes promotion lifecycle', async () => {
    const root = fixture();
    const repository = join(root, 'repository');
    const linked = join(root, 'linked');
    const appData = join(root, 'app-data');
    mkdirSync(repository);
    mustGit(repository, 'init', '-q', '-b', 'main');
    writeFileSync(join(repository, 'README.md'), 'promotion fixture\n');
    mustGit(repository, 'add', 'README.md');
    mustGit(
      repository,
      '-c',
      'user.name=Workspace Lease Tests',
      '-c',
      'user.email=workspace-lease@example.invalid',
      'commit',
      '-qm',
      'initial',
    );
    mustGit(repository, 'worktree', 'add', '-q', '-b', 'task/promotion', linked);

    const directoryReservation = await acquireWorkspaceDirectoryLease({
      workspacePath: repository,
      appDataDir: appData,
    });
    const linkedLease = await acquireWorkspaceLease({ workspacePath: linked, appDataDir: appData });

    try {
      await directoryReservation.promote({ attempts: 2, retryMs: 1 });
      throw new Error('expected promotion to contend on the family lock');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLeaseError);
      expect((error as WorkspaceLeaseError).code).toBe('WORKSPACE_LEASE_BUSY');
    }

    // A failed family acquisition must not consume or release the directory.
    try {
      await acquireWorkspaceDirectoryLease({
        workspacePath: repository,
        appDataDir: appData,
        attempts: 2,
        retryMs: 1,
      });
      throw new Error('expected the retained directory reservation to contend');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLeaseError);
      expect((error as WorkspaceLeaseError).code).toBe('WORKSPACE_LEASE_BUSY');
    }

    const pendingPromotion = directoryReservation.promote({ attempts: 100, retryMs: 2 });
    expect(() => directoryReservation.release()).toThrow(WorkspaceLeaseError);
    expect(linkedLease.release()).toBe(true);
    const promoted = await pendingPromotion;
    expect(promoted).toBe(directoryReservation);
    expect(promoted.identity.kind).toBe('git-family');

    try {
      await directoryReservation.promote({ attempts: 1, retryMs: 0 });
      throw new Error('expected a consumed promotion to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLeaseError);
      expect((error as WorkspaceLeaseError).code).toBe('WORKSPACE_LEASE_UNSAFE');
    }
    expect(promoted.release()).toBe(true);
  });

  test('a Git parent directory reservation allows a new child lease but excludes the same root', async () => {
    const root = fixture();
    const repository = join(root, 'repository');
    const child = join(repository, 'new-child');
    const appData = join(root, 'app-data');
    mkdirSync(repository);
    mustGit(repository, 'init', '-q', '-b', 'main');

    const parentReservation = await acquireWorkspaceDirectoryLease({
      workspacePath: repository,
      appDataDir: appData,
    });
    expect(parentReservation.identity.kind).toBe('directory');

    mkdirSync(child);
    const childLease = await acquireWorkspaceLease({ workspacePath: child, appDataDir: appData });
    expect(childLease.identity.kind).toBe('git-family');

    try {
      await acquireWorkspaceDirectoryLease({
        workspacePath: repository,
        appDataDir: appData,
        attempts: 2,
        retryMs: 1,
      });
      throw new Error('expected duplicate parent reservation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLeaseError);
      expect((error as WorkspaceLeaseError).code).toBe('WORKSPACE_LEASE_BUSY');
    }

    expect(childLease.release()).toBe(true);
    expect(parentReservation.release()).toBe(true);
  });

  test('contends across processes and sibling linked worktrees', async () => {
    const root = fixture();
    const { main, linked } = createRepositoryWithLinkedWorktree(root);
    const appData = join(root, 'app-data');
    const mainLease = await acquireWorkspaceLease({ workspacePath: main, appDataDir: appData });

    const blocked = await childAcquire(linked, appData, 2);
    expect(blocked).toEqual({ acquired: false, code: 'WORKSPACE_LEASE_BUSY' });
    // The blocked child acquired its own linked-directory guard before it met
    // the shared family guard. That partial acquisition must be gone exactly;
    // only the holder's directory + family owner files may remain.
    expect(readdirSync(join(realpathSync(appData), 'workspace-leases-v1'))
      .filter(name => name.endsWith('.lock'))).toHaveLength(2);
    expect(mainLease.refresh()).toBe(true);
    expect(mainLease.release()).toBe(true);

    const acquired = await childAcquire(linked, appData, 20);
    expect(acquired).toMatchObject({
      acquired: true,
      kind: 'git-family',
      key: mainLease.identity.key,
      refreshed: true,
      released: true,
    });
  });

  test('a plain-directory holder blocks acquisition after Git is initialized', async () => {
    const root = fixture();
    const workspace = join(root, 'workspace');
    const appData = join(root, 'app-data');
    mkdirSync(workspace);
    const plainLease = await acquireWorkspaceLease({ workspacePath: workspace, appDataDir: appData });
    expect(plainLease.identity.kind).toBe('directory');

    // Model a Git-init mutator that already owns the directory lease.
    mustGit(workspace, 'init', '-q', '-b', 'main');
    const blocked = await childAcquire(workspace, appData, 2);
    expect(blocked).toEqual({ acquired: false, code: 'WORKSPACE_LEASE_BUSY' });
    expect(plainLease.release()).toBe(true);

    const acquired = await childAcquire(workspace, appData, 20);
    expect(acquired).toMatchObject({
      acquired: true,
      kind: 'git-family',
      refreshed: true,
      released: true,
    });
  });

  test('a Git composite holder blocks plain acquisition after .git is moved', async () => {
    const root = fixture();
    const workspace = join(root, 'workspace');
    const movedGitDirectory = join(root, 'moved-git-directory');
    const appData = join(root, 'app-data');
    mkdirSync(workspace);
    mustGit(workspace, 'init', '-q', '-b', 'main');
    const gitLease = await acquireWorkspaceLease({ workspacePath: workspace, appDataDir: appData });
    expect(gitLease.identity.kind).toBe('git-family');

    // Model a repository-removal mutator that already owns the composite.
    renameSync(join(workspace, '.git'), movedGitDirectory);
    const blocked = await childAcquire(workspace, appData, 2);
    expect(blocked).toEqual({ acquired: false, code: 'WORKSPACE_LEASE_BUSY' });
    expect(gitLease.refresh()).toBe(true);
    expect(gitLease.release()).toBe(true);

    const acquired = await childAcquire(workspace, appData, 20);
    expect(acquired).toMatchObject({
      acquired: true,
      kind: 'directory',
      refreshed: true,
      released: true,
    });
  });

  test('classifies invalid workspace targets as unsafe', async () => {
    const root = fixture();
    const appData = join(root, 'app-data');
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'file');

    for (const workspacePath of ['relative/path', join(root, 'missing'), file]) {
      try {
        await acquireWorkspaceLease({ workspacePath, appDataDir: appData, attempts: 1 });
        throw new Error('expected workspace lease acquisition to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceLeaseError);
        expect((error as WorkspaceLeaseError).code).toBe('WORKSPACE_LEASE_UNSAFE');
      }
    }
  });

  test('fails closed with a typed I/O error when Git identity cannot be probed', async () => {
    const root = fixture();
    const { main } = createRepositoryWithLinkedWorktree(root);
    const appData = join(root, 'app-data');

    try {
      await acquireWorkspaceLease({
        workspacePath: main,
        appDataDir: appData,
        gitExecutable: join(root, 'missing-git'),
        attempts: 1,
      });
      throw new Error('expected workspace lease acquisition to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLeaseError);
      expect((error as WorkspaceLeaseError).code).toBe('WORKSPACE_LEASE_IO');
    }
  });

  test('rejects a symlinked lease directory instead of locking outside app-data', async () => {
    if (process.platform === 'win32') return;
    const root = fixture();
    const workspace = join(root, 'workspace');
    const appData = join(root, 'app-data');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(appData);
    mkdirSync(outside);
    symlinkSync(outside, join(appData, 'workspace-leases-v1'), 'dir');

    try {
      await acquireWorkspaceLease({ workspacePath: workspace, appDataDir: appData, attempts: 1 });
      throw new Error('expected workspace lease acquisition to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLeaseError);
      expect((error as WorkspaceLeaseError).code).toBe('WORKSPACE_LEASE_UNSAFE');
    }
    expect(existsSync(join(outside, `${'0'.repeat(64)}.lock`))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });
});
