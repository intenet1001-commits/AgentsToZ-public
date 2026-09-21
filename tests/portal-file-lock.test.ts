import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireOwnedFileLock,
  portalFileLockOwnerProcessAlive,
  releasePortalFileLockIfOwned,
  withOwnedPortalFileLock,
} from '../src/portalFileLock';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-portal-file-lock-'));
  roots.push(root);
  return join(root, 'portal.json.lock');
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('owned portal file lock', () => {
  test('an old owner cannot unlink a replacement lock', () => {
    const lockPath = fixture();
    writeFileSync(lockPath, 'replacement-owner');
    expect(releasePortalFileLockIfOwned(lockPath, 'old-owner')).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe('replacement-owner');
    expect(releasePortalFileLockIfOwned(lockPath, 'replacement-owner')).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a stale takeover remains owned when the old guard releases late', async () => {
    const lockPath = fixture();
    const oldOwner = 'old-owner';
    writeFileSync(lockPath, oldOwner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    await withOwnedPortalFileLock(lockPath, async () => {
      const replacementOwner = readFileSync(lockPath, 'utf8');
      expect(replacementOwner).not.toBe(oldOwner);
      expect(releasePortalFileLockIfOwned(lockPath, oldOwner)).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(replacementOwner);
    }, { attempts: 10, retryMs: 1, staleAfterMs: 10 });
    expect(existsSync(lockPath)).toBe(false);
  });

  test('serializes stale release and replacement acquire through one crash-safe coordinator', async () => {
    const lockPath = fixture();
    const root = dirname(lockPath);
    const oldOwner = `v2:999997:${'d'.repeat(32)}`;
    const releaseReady = join(root, 'release-ready');
    const releaseResult = join(root, 'release-result');
    const acquireReady = join(root, 'acquire-ready');
    const acquireResult = join(root, 'acquire-result');
    const letAcquirerRelease = join(root, 'let-acquirer-release');
    const coordinatorPath = `${lockPath}.coordinator-v1.sqlite`;
    const moduleUrl = new URL('../src/portalFileLock.ts', import.meta.url).href;
    writeFileSync(lockPath, oldOwner);

    const coordinator = new Database(coordinatorPath, { create: true });
    coordinator.exec('PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE;');
    let coordinatorOpen = true;
    const childEnvironment = {
      ...process.env,
      LOCK_PATH: lockPath,
      OLD_OWNER: oldOwner,
      RELEASE_READY: releaseReady,
      RELEASE_RESULT: releaseResult,
      ACQUIRE_READY: acquireReady,
      ACQUIRE_RESULT: acquireResult,
      LET_ACQUIRER_RELEASE: letAcquirerRelease,
    };
    const staleReleaser = Bun.spawn([process.execPath, '-e', `
      import { writeFileSync } from 'node:fs';
      import { releasePortalFileLockIfOwned } from ${JSON.stringify(moduleUrl)};
      writeFileSync(process.env.RELEASE_READY, 'ready');
      const released = releasePortalFileLockIfOwned(process.env.LOCK_PATH, process.env.OLD_OWNER);
      writeFileSync(process.env.RELEASE_RESULT, String(released));
    `], { env: childEnvironment, stdout: 'pipe', stderr: 'pipe' });
    const replacementAcquirer = Bun.spawn([process.execPath, '-e', `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { acquireOwnedFileLock } from ${JSON.stringify(moduleUrl)};
      writeFileSync(process.env.ACQUIRE_READY, 'ready');
      const release = await acquireOwnedFileLock(process.env.LOCK_PATH, {
        attempts: 200,
        retryMs: 5,
        staleAfterMs: 10,
        deadOwnerGraceMs: 0,
      });
      writeFileSync(process.env.ACQUIRE_RESULT, readFileSync(process.env.LOCK_PATH, 'utf8'));
      while (!existsSync(process.env.LET_ACQUIRER_RELEASE)) await Bun.sleep(5);
      release();
    `], { env: childEnvironment, stdout: 'pipe', stderr: 'pipe' });

    try {
      await Promise.all([waitForPath(releaseReady), waitForPath(acquireReady)]);
      await Bun.sleep(50);
      // Both operations have reached the shared coordinator. Neither may use
      // a pre-lock owner observation to mutate the pathname while it is held.
      expect(readFileSync(lockPath, 'utf8')).toBe(oldOwner);
      expect(existsSync(releaseResult)).toBe(false);
      expect(existsSync(acquireResult)).toBe(false);

      coordinator.exec('COMMIT');
      coordinatorOpen = false;
      await Promise.all([waitForPath(releaseResult), waitForPath(acquireResult)]);
      const replacementOwner = readFileSync(acquireResult, 'utf8');
      expect(replacementOwner).not.toBe(oldOwner);
      expect(readFileSync(lockPath, 'utf8')).toBe(replacementOwner);
      expect(['true', 'false']).toContain(readFileSync(releaseResult, 'utf8'));
      writeFileSync(letAcquirerRelease, 'release');
      const exitCodes = await Promise.all([staleReleaser.exited, replacementAcquirer.exited]);
      expect(exitCodes).toEqual([0, 0]);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (coordinatorOpen) {
        try { coordinator.exec('ROLLBACK'); } catch {}
      }
      try { coordinator.close(); } catch {}
      try { writeFileSync(letAcquirerRelease, 'release'); } catch {}
      try { staleReleaser.kill(); } catch {}
      try { replacementAcquirer.kill(); } catch {}
      await Promise.allSettled([staleReleaser.exited, replacementAcquirer.exited]);
    }
  });

  test('rejects a symlink coordinator without touching its target or the owned lock', async () => {
    if (process.platform === 'win32') return;
    const lockPath = fixture();
    const owner = 'replacement-owner';
    const targetPath = join(dirname(lockPath), 'coordinator-target');
    writeFileSync(lockPath, owner);
    writeFileSync(targetPath, 'do-not-touch');
    symlinkSync(targetPath, `${lockPath}.coordinator-v1.sqlite`);

    expect(() => releasePortalFileLockIfOwned(lockPath, owner)).toThrow(
      '잠금 조정 파일이 안전하지 않습니다',
    );
    expect(readFileSync(targetPath, 'utf8')).toBe('do-not-touch');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);
    await expect(acquireOwnedFileLock(lockPath, { attempts: 1, retryMs: 0 })).rejects.toThrow(
      'portal.json 잠금 생성 실패: 잠금 조정 파일이 안전하지 않습니다',
    );
  });

  test('tightens an existing coordinator to owner-only permissions', () => {
    if (process.platform === 'win32') return;
    const lockPath = fixture();
    const owner = 'replacement-owner';
    const coordinatorPath = `${lockPath}.coordinator-v1.sqlite`;
    writeFileSync(lockPath, owner);
    writeFileSync(coordinatorPath, '');
    chmodSync(coordinatorPath, 0o666);

    expect(releasePortalFileLockIfOwned(lockPath, owner)).toBe(true);
    expect(statSync(coordinatorPath).mode & 0o777).toBe(0o600);
  });

  test('never steals a stale-looking lock from a process that is still alive', async () => {
    const lockPath = fixture();
    const owner = `v2:${process.pid}:${'a'.repeat(32)}`;
    writeFileSync(lockPath, owner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    expect(portalFileLockOwnerProcessAlive(owner)).toBe(true);
    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      staleAfterMs: 10,
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);
  });

  test('recovers a fresh v2 lock immediately once its PID is definitely gone', async () => {
    const lockPath = fixture();
    const owner = `v2:999999:${'b'.repeat(32)}`;
    writeFileSync(lockPath, owner);

    expect(portalFileLockOwnerProcessAlive(owner)).toBe(false);
    const release = await acquireOwnedFileLock(lockPath, {
      attempts: 3,
      retryMs: 1,
      staleAfterMs: 60_000,
    });
    const replacementOwner = readFileSync(lockPath, 'utf8');
    expect(replacementOwner).not.toBe(owner);
    expect(replacementOwner).toMatch(new RegExp(`^v2:${process.pid}:[0-9a-f]{32}$`));
    expect(release()).toBe(true);
  });

  test('writes bounded v3 owners when a dead-owner recovery class is selected', async () => {
    for (const recoveryClass of ['guarded', 'manual'] as const) {
      const lockPath = fixture();
      const release = await acquireOwnedFileLock(lockPath, {
        attempts: 2,
        retryMs: 1,
        deadOwnerRecoveryClass: recoveryClass,
      });
      const owner = readFileSync(lockPath, 'utf8');
      expect(owner).toMatch(new RegExp(
        `^v3:${process.pid}:[0-9a-f]{32}:${recoveryClass}$`,
      ));
      expect(portalFileLockOwnerProcessAlive(owner)).toBe(true);
      expect(release()).toBe(true);
    }
  });

  test('rejects an unknown dead-owner recovery class before creating a lock', async () => {
    const lockPath = fixture();
    await expect(acquireOwnedFileLock(lockPath, {
      deadOwnerRecoveryClass: 'automatic' as unknown as 'guarded',
    })).rejects.toThrow('잠금 설정이 올바르지 않습니다');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('requires an exact positive recovery proof for a dead v3 guarded owner', async () => {
    const lockPath = fixture();
    const owner = `v3:999992:${'3'.repeat(32)}:guarded`;
    writeFileSync(lockPath, owner);

    expect(portalFileLockOwnerProcessAlive(owner)).toBe(false);
    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      deadOwnerGraceMs: 0,
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);

    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      deadOwnerGraceMs: 0,
      canRecoverDeadOwner: () => false,
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);

    const observedOwners: string[] = [];
    const release = await acquireOwnedFileLock(lockPath, {
      attempts: 3,
      retryMs: 1,
      deadOwnerGraceMs: 0,
      canRecoverDeadOwner: observedOwner => {
        observedOwners.push(observedOwner);
        return true;
      },
    });
    expect(observedOwners).toEqual([owner]);
    expect(release()).toBe(true);
  });

  test('never auto-recovers a dead v3 manual owner', async () => {
    const lockPath = fixture();
    const owner = `v3:999991:${'4'.repeat(32)}:manual`;
    let callbackCalls = 0;
    writeFileSync(lockPath, owner);

    expect(portalFileLockOwnerProcessAlive(owner)).toBe(false);
    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      deadOwnerGraceMs: 0,
      canRecoverDeadOwner: () => {
        callbackCalls += 1;
        return true;
      },
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    await expect(acquireOwnedFileLock(lockPath, { attempts: 2, retryMs: 1, deadOwnerGraceMs: 0 }))
      .rejects.toMatchObject({ code: 'FILE_LOCK_RECOVERY_REQUIRED' });
    expect(callbackCalls).toBe(0);
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);
  });

  test('does not recover a dead v2 owner when the recovery gate returns false', async () => {
    const lockPath = fixture();
    const owner = `v2:999996:${'e'.repeat(32)}`;
    writeFileSync(lockPath, owner);

    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      staleAfterMs: 60_000,
      deadOwnerGraceMs: 0,
      canRecoverDeadOwner: () => false,
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);
  });

  test('recovers a dead v2 owner when the recovery gate returns true', async () => {
    const lockPath = fixture();
    const owner = `v2:999995:${'f'.repeat(32)}`;
    writeFileSync(lockPath, owner);

    const release = await acquireOwnedFileLock(lockPath, {
      attempts: 3,
      retryMs: 1,
      staleAfterMs: 60_000,
      deadOwnerGraceMs: 0,
      canRecoverDeadOwner: () => true,
    });
    expect(readFileSync(lockPath, 'utf8')).not.toBe(owner);
    expect(release()).toBe(true);
  });

  test('passes the exact observed dead owner to the recovery gate', async () => {
    const lockPath = fixture();
    const owner = `v2:999994:${'1'.repeat(32)}`;
    const observedOwners: string[] = [];
    writeFileSync(lockPath, owner);

    const release = await acquireOwnedFileLock(lockPath, {
      attempts: 3,
      retryMs: 1,
      staleAfterMs: 60_000,
      deadOwnerGraceMs: 0,
      canRecoverDeadOwner: observedOwner => {
        observedOwners.push(observedOwner);
        return true;
      },
    });
    expect(observedOwners).toEqual([owner]);
    expect(release()).toBe(true);
  });

  test('keeps the dead owner and preserves lock error wrapping when the gate throws', async () => {
    const lockPath = fixture();
    const owner = `v2:999993:${'2'.repeat(32)}`;
    writeFileSync(lockPath, owner);

    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 1,
      retryMs: 0,
      staleAfterMs: 60_000,
      deadOwnerGraceMs: 0,
      label: 'runtime registry',
      canRecoverDeadOwner: () => {
        throw new Error('recovery proof unavailable');
      },
    })).rejects.toThrow(
      'runtime registry 잠금 생성 실패: recovery proof unavailable',
    );
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);
  });

  test('does not recover a malformed stale owner when the recovery gate returns false', async () => {
    const lockPath = fixture();
    const owner = 'v2:not-a-valid-owner';
    writeFileSync(lockPath, owner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      staleAfterMs: 10,
      canRecoverDeadOwner: () => false,
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);
  });

  test('recovers a malformed stale owner only after passing its exact value to the gate', async () => {
    const lockPath = fixture();
    const owner = 'malformed legacy owner';
    const observedOwners: string[] = [];
    writeFileSync(lockPath, owner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const release = await acquireOwnedFileLock(lockPath, {
      attempts: 3,
      retryMs: 1,
      staleAfterMs: 10,
      canRecoverDeadOwner: observedOwner => {
        observedOwners.push(observedOwner);
        return true;
      },
    });
    expect(observedOwners).toEqual([owner]);
    expect(readFileSync(lockPath, 'utf8')).not.toBe(owner);
    expect(release()).toBe(true);
  });

  test('keeps a malformed stale owner when its recovery gate throws', async () => {
    const lockPath = fixture();
    const owner = 'legacy-owner-without-pid';
    writeFileSync(lockPath, owner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 1,
      retryMs: 0,
      staleAfterMs: 10,
      label: 'runtime registry',
      canRecoverDeadOwner: observedOwner => {
        expect(observedOwner).toBe(owner);
        throw new Error('malformed owner proof unavailable');
      },
    })).rejects.toThrow(
      'runtime registry 잠금 생성 실패: malformed owner proof unavailable',
    );
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);
  });

  test('can hold a runtime-specific grace before reclaiming a dead owner', async () => {
    const lockPath = fixture();
    const owner = `v2:999998:${'c'.repeat(32)}`;
    writeFileSync(lockPath, owner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      staleAfterMs: 10,
      deadOwnerGraceMs: 50,
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);

    // A previous acquisition and an old mtime are not grace credit. Each new
    // acquisition must observe this dead owner for its own complete window.
    await Bun.sleep(60);
    await expect(acquireOwnedFileLock(lockPath, {
      attempts: 2,
      retryMs: 1,
      staleAfterMs: 10,
      deadOwnerGraceMs: 50,
    })).rejects.toThrow('잠금을 2ms 안에 획득하지 못했습니다');
    expect(readFileSync(lockPath, 'utf8')).toBe(owner);

    const startedAtMs = performance.now();
    const release = await acquireOwnedFileLock(lockPath, {
      attempts: 20,
      retryMs: 5,
      staleAfterMs: 10,
      deadOwnerGraceMs: 50,
    });
    expect(performance.now() - startedAtMs).toBeGreaterThanOrEqual(45);
    expect(readFileSync(lockPath, 'utf8')).not.toBe(owner);
    expect(release()).toBe(true);
  });

  test('a long operation refreshes only its still-owned inode', async () => {
    const lockPath = fixture();
    const release = await acquireOwnedFileLock(lockPath, { attempts: 2, retryMs: 1 });
    const before = statSync(lockPath).mtimeMs;
    await Bun.sleep(5);
    expect(release.refresh()).toBe(true);
    expect(statSync(lockPath).mtimeMs).toBeGreaterThanOrEqual(before);
    expect(release()).toBe(true);
    expect(release.refresh()).toBe(false);
  });
});
