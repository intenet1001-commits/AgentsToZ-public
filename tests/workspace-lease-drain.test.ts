import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireWorkspaceLease,
  heldWorkspaceLeaseLockCount,
  waitForHeldWorkspaceLeases,
  type WorkspaceLease,
} from '../src/workspaceLease';

const roots: string[] = [];
const leases: WorkspaceLease[] = [];

afterEach(() => {
  for (const lease of leases.splice(0)) {
    try { lease.release(); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { workspace: string; appData: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-lease-drain-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return { workspace, appData: join(root, 'app-data') };
}

function gitRepository(): { workspace: string; appData: string } {
  const paths = fixture();
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: paths.workspace, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  run('init', '-q', '-b', 'main');
  writeFileSync(join(paths.workspace, 'README.md'), 'drain fixture\n');
  return paths;
}

async function hold(workspace: string, appData: string): Promise<WorkspaceLease> {
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, appDataDir: appData, attempts: 1 });
  leases.push(lease);
  return lease;
}

describe('held workspace lease drain', () => {
  test('reports nothing to wait for when no lease is held', async () => {
    expect(heldWorkspaceLeaseLockCount()).toBe(0);
    expect(await waitForHeldWorkspaceLeases(0)).toBe(true);
  });

  test('waits until an in-flight lease is released', async () => {
    const { workspace, appData } = fixture();
    const lease = await hold(workspace, appData);
    expect(heldWorkspaceLeaseLockCount()).toBe(1);

    const drained = waitForHeldWorkspaceLeases(2_000);
    setTimeout(() => lease.release(), 20);

    expect(await drained).toBe(true);
    expect(heldWorkspaceLeaseLockCount()).toBe(0);
  });

  test('gives up at the deadline while a lease is still held', async () => {
    const { workspace, appData } = fixture();
    await hold(workspace, appData);

    const startedAt = performance.now();
    expect(await waitForHeldWorkspaceLeases(20)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(heldWorkspaceLeaseLockCount()).toBe(1);
  });

  test('counts both parts of a Git composite lease and clears them on release', async () => {
    const { workspace, appData } = gitRepository();
    const lease = await hold(workspace, appData);
    expect(heldWorkspaceLeaseLockCount()).toBe(2);

    expect(lease.release()).toBe(true);
    expect(heldWorkspaceLeaseLockCount()).toBe(0);
  });

  test('a contended acquisition leaves no phantom held lock behind', async () => {
    const { workspace, appData } = gitRepository();
    await hold(workspace, appData);
    expect(heldWorkspaceLeaseLockCount()).toBe(2);

    await expect(acquireWorkspaceLease({
      workspacePath: workspace, appDataDir: appData, attempts: 1, retryMs: 1,
    })).rejects.toMatchObject({ code: 'WORKSPACE_LEASE_BUSY' });

    expect(heldWorkspaceLeaseLockCount()).toBe(2);
  });
});
