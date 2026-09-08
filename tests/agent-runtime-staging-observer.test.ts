import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENT_RUNTIME_STAGING_OBSERVER_VERSION,
  AgentRuntimeStagingObserverError,
  buildAgentRuntimeStagingResult,
  observeAgentRuntimeStagingTree,
  type AgentRuntimeStagingTreeSnapshot,
} from '../src/agentRuntimeStagingObserver';
import {
  AGENT_RUNTIME_STAGING_MAX_ENTRIES,
  AGENT_RUNTIME_STAGING_MAX_FILE_BYTES,
  AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES,
  AGENT_RUNTIME_STAGING_RESULT_VERSION,
} from '../src/agentRuntimeStagingResult';

async function withTempRoot<T>(
  run: (root: string) => Promise<T>,
): Promise<T> {
  const createdRoot = await mkdtemp(join(tmpdir(), 'agentstoz-staging-observer-'));
  try {
    const canonicalRoot = await realpath(createdRoot);
    return await run(canonicalRoot);
  } finally {
    await rm(createdRoot, { recursive: true, force: true });
  }
}

async function expectCode(
  operation: Promise<unknown> | (() => unknown),
  code: string,
): Promise<void> {
  try {
    if (typeof operation === 'function') operation();
    else await operation;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe('Agent Runtime staging observer', () => {
  test('builds deterministic writes/deletes from bytes and ignores mtime-only changes', async () => {
    await withTempRoot(async (root) => {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'changed.txt'), 'before');
      await writeFile(join(root, 'src', 'same.txt'), 'same bytes');
      await writeFile(join(root, 'removed.txt'), 'remove me');
      const base = await observeAgentRuntimeStagingTree(root);

      await writeFile(join(root, 'src', 'changed.txt'), 'after');
      await writeFile(join(root, 'src', 'new.txt'), 'new');
      await rm(join(root, 'removed.txt'));
      await utimes(join(root, 'src', 'same.txt'), new Date(1_900_000_000_000), new Date(1_900_000_000_000));
      const final = await observeAgentRuntimeStagingTree(root);

      const result = buildAgentRuntimeStagingResult(base, final);
      expect(result.manifest).toEqual({
        version: AGENT_RUNTIME_STAGING_RESULT_VERSION,
        entries: [
          { operation: 'delete', path: 'removed.txt' },
          {
            operation: 'write',
            path: 'src/changed.txt',
            fileType: 'regular-file',
            sizeBytes: 5,
            linkCount: 1,
          },
          {
            operation: 'write',
            path: 'src/new.txt',
            fileType: 'regular-file',
            sizeBytes: 3,
            linkCount: 1,
          },
        ],
      });
      expect(result.manifest.entries.some((entry) => entry.path === 'src/same.txt')).toBe(false);

      const changed = result.trusted.getFinalNode('src/changed.txt');
      expect(changed?.kind).toBe('regular-file');
      expect(changed?.linkCount).toBe('1');
      expect(changed?.sha256).toBe(createHash('sha256').update('after').digest('hex'));
      expect(Object.isFrozen(changed)).toBe(true);
      expect(result.trusted.getFinalChain('src/changed.txt').map((node) => node.path)).toEqual([
        '',
        'src',
        'src/changed.txt',
      ]);
      expect(result.trusted.writeCount).toBe(2);

      expect(Object.keys(result)).toEqual(['manifest']);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain(AGENT_RUNTIME_STAGING_RESULT_VERSION);
      expect(serialized).not.toContain(root);
      expect(() => JSON.stringify(result.trusted)).toThrow(AgentRuntimeStagingObserverError);
      expect(() => JSON.stringify(base)).toThrow(AgentRuntimeStagingObserverError);
    });
  });

  test('rejects protected control paths before descending, including every .agentstoz prefix', async () => {
    for (const protectedPath of [
      '.git/config',
      '.agent-memory/CORE.md',
      '.agents/skills/x/SKILL.md',
      '.agentstoz-private/evidence',
      '.agentstozAnything/evidence',
      '.claude/settings.json',
      '.codex/config.toml',
      'nested/AGENTS.md',
      'nested/CLAUDE.md',
    ]) {
      await withTempRoot(async (root) => {
        const components = protectedPath.split('/');
        if (components.length > 1) {
          await mkdir(join(root, ...components.slice(0, -1)), { recursive: true });
        }
        await writeFile(join(root, ...components), 'protected');
        await expectCode(observeAgentRuntimeStagingTree(root), 'PROTECTED_PATH');
      });
    }
  });

  test('never accepts symlinks, hardlinks, or Unix sockets', async () => {
    await withTempRoot(async (root) => {
      const outside = join(root, '..', `agentstoz-outside-${crypto.randomUUID()}`);
      await writeFile(outside, 'outside');
      try {
        await symlink(outside, join(root, 'escape'));
        await expectCode(observeAgentRuntimeStagingTree(root), 'UNSAFE_NODE_TYPE');
      } finally {
        await rm(outside, { force: true });
      }
    });

    await withTempRoot(async (root) => {
      await writeFile(join(root, 'first'), 'same inode');
      await link(join(root, 'first'), join(root, 'second'));
      await expectCode(observeAgentRuntimeStagingTree(root), 'HARDLINK_AMBIGUOUS');
    });

    await withTempRoot(async (root) => {
      const socketPath = join(root, 'runtime.sock');
      const server = createServer();
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(socketPath, resolveListen);
      });
      try {
        await expectCode(observeAgentRuntimeStagingTree(root), 'UNSAFE_NODE_TYPE');
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    });
  });

  test('enforces canonical roots, individual file bounds, abort, and timeout', async () => {
    await expectCode(observeAgentRuntimeStagingTree('relative/staging'), 'ROOT_NOT_CANONICAL');

    await withTempRoot(async (root) => {
      await writeFile(join(root, 'too-large.bin'), '');
      await truncate(join(root, 'too-large.bin'), AGENT_RUNTIME_STAGING_MAX_FILE_BYTES + 1);
      await expectCode(observeAgentRuntimeStagingTree(root), 'FILE_SIZE_LIMIT_EXCEEDED');
    });

    await withTempRoot(async (root) => {
      const controller = new AbortController();
      controller.abort();
      await expectCode(
        observeAgentRuntimeStagingTree(root, { signal: controller.signal }),
        'OBSERVATION_ABORTED',
      );
      await expectCode(
        observeAgentRuntimeStagingTree(root, { timeoutMs: 0 }),
        'OBSERVATION_TIMED_OUT',
      );
    });
  });

  test('bounds streamed directory entry count and aggregate bytes', async () => {
    await withTempRoot(async (root) => {
      for (let offset = 0; offset <= AGENT_RUNTIME_STAGING_MAX_ENTRIES; offset += 256) {
        const count = Math.min(256, AGENT_RUNTIME_STAGING_MAX_ENTRIES + 1 - offset);
        await Promise.all(Array.from({ length: count }, (_, index) => (
          writeFile(join(root, `${String(offset + index).padStart(5, '0')}.txt`), '')
        )));
      }
      await expectCode(observeAgentRuntimeStagingTree(root), 'ENTRY_LIMIT_EXCEEDED');
    });

    await withTempRoot(async (root) => {
      const fullFileCount = AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES
        / AGENT_RUNTIME_STAGING_MAX_FILE_BYTES;
      for (let index = 0; index < fullFileCount; index += 1) {
        const path = join(root, `${String(index).padStart(2, '0')}.bin`);
        await writeFile(path, '');
        await truncate(path, AGENT_RUNTIME_STAGING_MAX_FILE_BYTES);
      }
      await writeFile(join(root, '99-overflow.bin'), 'x');
      await expectCode(
        observeAgentRuntimeStagingTree(root, { timeoutMs: 60_000 }),
        'TOTAL_SIZE_LIMIT_EXCEEDED',
      );
    });
    // Fixture creation and cleanup are separate from the observer's own deadline.
  }, 90_000);

  test('detects a mutation between pathname and pinned-handle checkpoints', async () => {
    await withTempRoot(async (root) => {
      const target = join(root, 'changing.txt');
      await writeFile(target, 'initial');
      let checkpoints = 0;
      let flip = false;
      const adversarialSignal = {
        get aborted() {
          checkpoints += 1;
          if (checkpoints >= 12) {
            flip = !flip;
            writeFileSync(target, flip ? 'changed-a' : 'changed-b');
          }
          return false;
        },
      } as unknown as AbortSignal;

      await expectCode(
        observeAgentRuntimeStagingTree(root, { signal: adversarialSignal }),
        'TREE_MUTATED_DURING_OBSERVATION',
      );
      expect(checkpoints).toBeGreaterThanOrEqual(12);
    });
  });

  test('rejects forged snapshots and snapshots from a different root', async () => {
    const forged = {
      version: AGENT_RUNTIME_STAGING_OBSERVER_VERSION,
      entryCount: 0,
      totalFileBytes: 0,
      toJSON(): never {
        throw new Error('forged');
      },
    } as AgentRuntimeStagingTreeSnapshot;
    await expectCode(
      () => buildAgentRuntimeStagingResult(forged, forged),
      'SNAPSHOT_INVALID',
    );

    await withTempRoot(async (firstRoot) => {
      await withTempRoot(async (secondRoot) => {
        const first = await observeAgentRuntimeStagingTree(firstRoot);
        const second = await observeAgentRuntimeStagingTree(secondRoot);
        await expectCode(
          () => buildAgentRuntimeStagingResult(first, second),
          'SNAPSHOT_ROOT_MISMATCH',
        );
      });
    });
  });
});
