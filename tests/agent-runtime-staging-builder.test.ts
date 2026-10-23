import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENT_RUNTIME_GIT_TREE_MANIFEST_VERSION,
  AGENT_RUNTIME_STAGING_BUILD_REQUEST_VERSION,
  AGENT_RUNTIME_STAGING_BUILD_RESULT_VERSION,
  AGENT_RUNTIME_STAGING_BUILDER_MAX_BLOB_CHUNK_BYTES,
  AGENT_RUNTIME_STAGING_BUILDER_MAX_TIMEOUT_MS,
  AGENT_RUNTIME_STAGING_PROTECTED_OMISSION_POLICY,
  AgentRuntimeStagingBuilderError,
  materializeAgentRuntimeStaging,
  normalizeAgentRuntimeGitTreeManifest,
  type AgentRuntimeGitFileMode,
  type AgentRuntimeGitTreeManifest,
  type AgentRuntimeGitTreeManifestEntry,
  type AgentRuntimeStagingBlobSource,
} from '../src/agentRuntimeStagingBuilder';
import {
  AGENT_RUNTIME_STAGING_MAX_ENTRIES,
  AGENT_RUNTIME_STAGING_MAX_FILE_BYTES,
  AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH,
  AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES,
} from '../src/agentRuntimeStagingResult';

const SHA1_COMMIT = 'a'.repeat(40);
const SHA256_COMMIT = 'b'.repeat(64);

function bytes(value: string): Uint8Array {
  return Buffer.from(value, 'utf8');
}

function gitBlobOid(content: Uint8Array, algorithm: 'sha1' | 'sha256' = 'sha1'): string {
  return createHash(algorithm)
    .update(`blob ${content.byteLength}\0`, 'utf8')
    .update(content)
    .digest('hex');
}

function manifestEntry(
  path: string,
  content: Uint8Array,
  mode: AgentRuntimeGitFileMode = '100644',
  algorithm: 'sha1' | 'sha256' = 'sha1',
): AgentRuntimeGitTreeManifestEntry {
  return {
    path,
    oid: gitBlobOid(content, algorithm),
    mode,
    sizeBytes: content.byteLength,
  };
}

function manifest(
  entries: readonly AgentRuntimeGitTreeManifestEntry[],
  commit = SHA1_COMMIT,
): AgentRuntimeGitTreeManifest {
  return {
    version: AGENT_RUNTIME_GIT_TREE_MANIFEST_VERSION,
    commit,
    entries,
  };
}

function request(root: string, taskName: string, tree: AgentRuntimeGitTreeManifest) {
  return {
    version: AGENT_RUNTIME_STAGING_BUILD_REQUEST_VERSION,
    privateStagingRoot: root,
    stagingPath: join(root, taskName),
    manifest: tree,
  };
}

function sourceFor(
  values: ReadonlyMap<string, Uint8Array>,
  calls: Array<Record<string, unknown>> = [],
): AgentRuntimeStagingBlobSource {
  return (blobRequest) => {
    calls.push({ ...blobRequest });
    const value = values.get(blobRequest.oid);
    if (value === undefined) throw new Error('test blob missing');
    const midpoint = Math.floor(value.byteLength / 2);
    return value.byteLength === 0
      ? []
      : value.byteLength === 1
        ? [value]
      : [value.subarray(0, midpoint), value.subarray(midpoint)];
  };
}

async function withPrivateRoot<T>(
  run: (root: string, parent: string) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), 'agentstoz-staging-builder-'));
  const root = join(parent, 'private');
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  try {
    return await run(await realpath(root), parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function expectCode(
  run: () => unknown | Promise<unknown>,
  code: AgentRuntimeStagingBuilderError['code'],
  cleanupRequired?: boolean,
): Promise<AgentRuntimeStagingBuilderError> {
  try {
    await run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeStagingBuilderError);
    const typed = error as AgentRuntimeStagingBuilderError;
    expect(typed.code).toBe(code);
    expect(typed.message).toBe(code);
    if (cleanupRequired !== undefined) expect(typed.cleanupRequired).toBe(cleanupRequired);
    return typed;
  }
}

describe('Agent Runtime immutable Git staging builder', () => {
  test('materializes only regular tracked blobs and deterministically omits control paths', async () => {
    await withPrivateRoot(async (root) => {
      const readme = bytes('hello staging\n');
      const executable = bytes('#!/bin/sh\nprintf safe\n');
      const protectedValue = bytes('must not enter the guest');
      const entries = [
        manifestEntry('z.txt', readme),
        manifestEntry('src/run.sh', executable, '100755'),
        manifestEntry('.git/config', protectedValue),
        manifestEntry('nested/.agent-memory/CORE.md', protectedValue),
        manifestEntry('.agents/skills/x/SKILL.md', protectedValue),
        manifestEntry('.agentstozAnything/private.json', protectedValue),
        manifestEntry('.claude/settings.json', protectedValue),
        manifestEntry('.codex/config.toml', protectedValue),
        manifestEntry('AGENTS.md', protectedValue),
        manifestEntry('nested/CLAUDE.md', protectedValue),
      ];
      const values = new Map(entries.map((entry, index) => [
        entry.oid,
        index < 2 ? (index === 0 ? readme : executable) : protectedValue,
      ]));
      const calls: Array<Record<string, unknown>> = [];
      const task = request(root, 'task-valid-01', manifest(entries));

      const result = await materializeAgentRuntimeStaging(task, sourceFor(values, calls));

      expect(result.version).toBe(AGENT_RUNTIME_STAGING_BUILD_RESULT_VERSION);
      expect(result.gitCommit).toBe(SHA1_COMMIT);
      expect(result.omissionPolicy).toBe(AGENT_RUNTIME_STAGING_PROTECTED_OMISSION_POLICY);
      expect(result.includedEntryCount).toBe(2);
      expect(result.omittedProtectedEntryCount).toBe(8);
      expect(result.totalFileBytes).toBe(readme.byteLength + executable.byteLength);
      expect(result.stagingIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(result.snapshotIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(result.cleanupRequired).toBe(true);
      expect(calls).toHaveLength(2);
      expect(Object.keys(calls[0] ?? {})).toEqual(['commit', 'oid', 'sizeBytes']);
      expect(calls.every((call) => call.commit === SHA1_COMMIT)).toBe(true);

      expect(await readFile(join(task.stagingPath, 'z.txt'), 'utf8')).toBe('hello staging\n');
      expect(await readFile(join(task.stagingPath, 'src/run.sh'), 'utf8')).toContain('printf safe');
      expect((await stat(join(task.stagingPath, 'z.txt'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(task.stagingPath, 'src/run.sh'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(task.stagingPath, 'src'))).mode & 0o777).toBe(0o700);
      expect((await stat(task.stagingPath)).mode & 0o777).toBe(0o700);
      for (const omitted of [
        '.git/config',
        'nested/.agent-memory/CORE.md',
        '.agents/skills/x/SKILL.md',
        '.agentstozAnything/private.json',
        '.claude/settings.json',
        '.codex/config.toml',
        'AGENTS.md',
        'nested/CLAUDE.md',
      ]) {
        expect(await lstat(join(task.stagingPath, ...omitted.split('/'))).then(
          () => true,
          (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
        )).toBe(false);
      }

      expect(result.baselineSnapshot.entryCount).toBe(3);
      expect(result.baselineSnapshot.totalFileBytes).toBe(result.totalFileBytes);
      expect(Object.keys(result)).toEqual([
        'version',
        'gitCommit',
        'omissionPolicy',
        'stagingIdentity',
        'snapshotIdentity',
        'includedEntryCount',
        'omittedProtectedEntryCount',
        'totalFileBytes',
        'cleanupRequired',
      ]);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(() => JSON.stringify(result.baselineSnapshot)).toThrow();

      const second = request(root, 'task-valid-02', manifest([...entries].reverse()));
      const secondResult = await materializeAgentRuntimeStaging(second, sourceFor(values));
      expect(secondResult.snapshotIdentity).toBe(result.snapshotIdentity);
      expect(secondResult.stagingIdentity).not.toBe(result.stagingIdentity);
    });
  });

  test('normalizes an exact frozen manifest and rejects unknown fields, modes, and OID formats', async () => {
    const a = bytes('a');
    const b = bytes('b');
    const normalized = normalizeAgentRuntimeGitTreeManifest(manifest([
      manifestEntry('z.txt', b),
      manifestEntry('a.txt', a),
    ]));
    expect(normalized.entries.map((entry) => entry.path)).toEqual(['a.txt', 'z.txt']);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.entries)).toBe(true);
    expect(Object.isFrozen(normalized.entries[0])).toBe(true);

    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest({ ...manifest([]), future: true }),
      'AGENT_RUNTIME_STAGING_BUILDER_INVALID_MANIFEST',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest({ ...manifest([]), version: 'future' }),
      'AGENT_RUNTIME_STAGING_BUILDER_SCHEMA_UNSUPPORTED',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([{
        ...manifestEntry('file', a),
        mode: '120000',
      } as unknown as AgentRuntimeGitTreeManifestEntry])),
      'AGENT_RUNTIME_STAGING_BUILDER_INVALID_ENTRY',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([{
        ...manifestEntry('gitlink', a),
        mode: '160000',
      } as unknown as AgentRuntimeGitTreeManifestEntry])),
      'AGENT_RUNTIME_STAGING_BUILDER_INVALID_ENTRY',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([{
        ...manifestEntry('extra', a),
        command: 'run',
      } as unknown as AgentRuntimeGitTreeManifestEntry])),
      'AGENT_RUNTIME_STAGING_BUILDER_INVALID_ENTRY',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest({ ...manifest([]), commit: '0'.repeat(40) }),
      'AGENT_RUNTIME_STAGING_BUILDER_INVALID_GIT_OID',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([{
        ...manifestEntry('wrong-oid', a),
        oid: 'c'.repeat(64),
      }])),
      'AGENT_RUNTIME_STAGING_BUILDER_INVALID_GIT_OID',
      false,
    );
  });

  test('rejects unsafe, ambiguous, and file-shaped manifest paths before filesystem creation', async () => {
    const content = bytes('safe');
    for (const path of [
      '', '/absolute', '../escape', 'src/../escape', './file', 'src//file',
      'src\\file', 'C:/drive', 'line\nbreak', `cafe\u0301.txt`, 'bad\ud800name',
      'file.', ' file', 'file ', 'stream:name', '．．/escape', 'safe／escape',
    ]) {
      await expectCode(
        () => normalizeAgentRuntimeGitTreeManifest(manifest([manifestEntry(path, content)])),
        'AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_PATH',
        false,
      );
    }
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([
        manifestEntry('Source/a', content),
        manifestEntry('source/b', content),
      ])),
      'AGENT_RUNTIME_STAGING_BUILDER_PATH_COLLISION',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([
        manifestEntry('Ａ/file', content),
        manifestEntry('A/file', content),
      ])),
      'AGENT_RUNTIME_STAGING_BUILDER_PATH_COLLISION',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([
        manifestEntry('file', content),
        manifestEntry('file/child', content),
      ])),
      'AGENT_RUNTIME_STAGING_BUILDER_PATH_SHAPE_COLLISION',
      false,
    );
  });

  test('requires a canonical owner-only root and a fresh direct task child', async () => {
    await withPrivateRoot(async (root, parent) => {
      const tree = manifest([]);
      await chmod(root, 0o755);
      await expectCode(
        () => materializeAgentRuntimeStaging(request(root, 'task-mode-01', tree), sourceFor(new Map())),
        'AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_STAGING_ROOT',
        false,
      );
      await chmod(root, 0o700);

      const existing = join(root, 'task-existing');
      await mkdir(existing, { mode: 0o700 });
      await expectCode(
        () => materializeAgentRuntimeStaging(request(root, 'task-existing', tree), sourceFor(new Map())),
        'AGENT_RUNTIME_STAGING_BUILDER_STAGING_PATH_NOT_FRESH',
        false,
      );
      expect((await stat(existing)).isDirectory()).toBe(true);

      await expectCode(
        () => materializeAgentRuntimeStaging({
          ...request(root, 'ignored', tree),
          stagingPath: join(root, 'nested', 'task'),
        }, sourceFor(new Map())),
        'AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST',
        false,
      );

      const linkPath = join(parent, 'private-link');
      await symlink(root, linkPath);
      await expectCode(
        () => materializeAgentRuntimeStaging(request(linkPath, 'task-link-01', tree), sourceFor(new Map())),
        'AGENT_RUNTIME_STAGING_BUILDER_UNSAFE_STAGING_ROOT',
        false,
      );
      await expectCode(
        () => materializeAgentRuntimeStaging({
          ...request(root, 'task-extra-01', tree),
          shellCommand: 'git archive',
        }, sourceFor(new Map())),
        'AGENT_RUNTIME_STAGING_BUILDER_INVALID_REQUEST',
        false,
      );
    });
  });

  test('verifies streamed byte count, Git OID, chunks, and source errors with cleanup required', async () => {
    await withPrivateRoot(async (root, parent) => {
      const baseTarget = join(parent, 'actual-project');
      await mkdir(baseTarget);
      await writeFile(join(baseTarget, 'important.txt'), 'untouched');
      const expected = bytes('expected');
      const tree = manifest([manifestEntry('file.txt', expected)]);

      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-wrong-oid', tree),
          () => [bytes('wrongxxx')],
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_BLOB_OID_MISMATCH',
        true,
      );
      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-short', tree),
          () => [bytes('short')],
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_BLOB_SIZE_MISMATCH',
        true,
      );
      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-source-error', tree),
          () => { throw new Error('sensitive source detail'); },
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_BLOB_SOURCE_FAILED',
        true,
      );

      const large = new Uint8Array(AGENT_RUNTIME_STAGING_BUILDER_MAX_BLOB_CHUNK_BYTES + 1);
      const largeTree = manifest([manifestEntry('large.bin', large)]);
      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-large-chunk', largeTree),
          () => [large],
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID',
        true,
      );
      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-invalid-stream', tree),
          () => ({
            [Symbol.asyncIterator]() { return this; },
            async next() { return { value: expected, done: undefined }; },
          } as unknown as AsyncIterable<Uint8Array>),
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_BLOB_STREAM_INVALID',
        true,
      );

      expect(await readFile(join(baseTarget, 'important.txt'), 'utf8')).toBe('untouched');
      for (const taskName of [
        'task-wrong-oid', 'task-short', 'task-source-error',
        'task-large-chunk', 'task-invalid-stream',
      ]) {
        expect((await stat(join(root, taskName))).isDirectory()).toBe(true);
      }
    });
  });

  test('detects a source that creates a hardlink or replaces the pinned leaf', async () => {
    await withPrivateRoot(async (root, parent) => {
      const content = bytes('adversarial');
      const tree = manifest([manifestEntry('file.txt', content)]);
      const hardlinkTask = request(root, 'task-hardlink', tree);
      await expectCode(
        () => materializeAgentRuntimeStaging(hardlinkTask, async () => {
          await link(join(hardlinkTask.stagingPath, 'file.txt'), join(parent, 'outside-hardlink'));
          return [content];
        }),
        'AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED',
        true,
      );

      const replacementTask = request(root, 'task-replacement', tree);
      const outside = join(parent, 'outside-target');
      await writeFile(outside, 'outside');
      await expectCode(
        () => materializeAgentRuntimeStaging(replacementTask, async () => {
          const target = join(replacementTask.stagingPath, 'file.txt');
          await rm(target);
          await symlink(outside, target);
          return [content];
        }),
        'AGENT_RUNTIME_STAGING_BUILDER_STAGING_IDENTITY_CHANGED',
        true,
      );
      expect(await readFile(outside, 'utf8')).toBe('outside');
    });
  });

  test('enforces manifest, materialized-node, file, total, depth, abort, and wall-clock bounds', async () => {
    const emptyOid = gitBlobOid(bytes(''));
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest(Array.from(
        { length: AGENT_RUNTIME_STAGING_MAX_ENTRIES + 1 },
        (_, index) => ({
          path: `file-${index}`,
          oid: emptyOid,
          mode: '100644' as const,
          sizeBytes: 0,
        }),
      ))),
      'AGENT_RUNTIME_STAGING_BUILDER_ENTRY_LIMIT_EXCEEDED',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([
        {
          path: 'large',
          oid: 'c'.repeat(40),
          mode: '100644',
          sizeBytes: AGENT_RUNTIME_STAGING_MAX_FILE_BYTES + 1,
        },
      ])),
      'AGENT_RUNTIME_STAGING_BUILDER_FILE_SIZE_LIMIT_EXCEEDED',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([
        ...Array.from({ length: AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES / AGENT_RUNTIME_STAGING_MAX_FILE_BYTES }, (_, index) => ({
          path: `full-${index}`,
          oid: 'c'.repeat(40),
          mode: '100644' as const,
          sizeBytes: AGENT_RUNTIME_STAGING_MAX_FILE_BYTES,
        })),
        { path: 'overflow', oid: 'd'.repeat(40), mode: '100644', sizeBytes: 1 },
      ])),
      'AGENT_RUNTIME_STAGING_BUILDER_TOTAL_SIZE_LIMIT_EXCEEDED',
      false,
    );
    await expectCode(
      () => normalizeAgentRuntimeGitTreeManifest(manifest([manifestEntry(
        Array.from({ length: AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH + 1 }, () => 'd').join('/'),
        bytes('deep'),
      )])),
      'AGENT_RUNTIME_STAGING_BUILDER_PATH_LIMIT_EXCEEDED',
      false,
    );

    await withPrivateRoot(async (root) => {
      const tooManyNodes = manifest(Array.from({ length: 2_049 }, (_, index) => ({
        path: `d-${index}/file`,
        oid: emptyOid,
        mode: '100644' as const,
        sizeBytes: 0,
      })));
      const tooManyTask = request(root, 'task-too-many-nodes', tooManyNodes);
      await expectCode(
        () => materializeAgentRuntimeStaging(tooManyTask, () => []),
        'AGENT_RUNTIME_STAGING_BUILDER_ENTRY_LIMIT_EXCEEDED',
        false,
      );
      expect(await lstat(tooManyTask.stagingPath).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
      )).toBe(false);

      const abortController = new AbortController();
      abortController.abort();
      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-aborted', manifest([])),
          () => [],
          { signal: abortController.signal },
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_ABORTED',
        false,
      );
      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-invalid-timeout', manifest([])),
          () => [],
          { timeoutMs: AGENT_RUNTIME_STAGING_BUILDER_MAX_TIMEOUT_MS + 1 },
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT',
        false,
      );

      const waiting = bytes('waiting');
      const neverEnding: AsyncIterableIterator<Uint8Array> = {
        [Symbol.asyncIterator]() { return this; },
        next() { return new Promise<IteratorResult<Uint8Array>>(() => undefined); },
      };
      await expectCode(
        () => materializeAgentRuntimeStaging(
          request(root, 'task-timeout', manifest([manifestEntry('wait', waiting)])),
          () => neverEnding,
          { timeoutMs: 50 },
        ),
        'AGENT_RUNTIME_STAGING_BUILDER_TIMED_OUT',
        true,
      );
    });
  });

  test('supports SHA-256 Git object format while retaining an independent SHA-256 snapshot identity', async () => {
    await withPrivateRoot(async (root) => {
      const content = bytes('sha256 repository');
      const entry = manifestEntry('sha256.txt', content, '100644', 'sha256');
      const empty = bytes('');
      const emptyEntry = manifestEntry('empty.txt', empty, '100644', 'sha256');
      const tree = manifest([entry, emptyEntry], SHA256_COMMIT);
      const result = await materializeAgentRuntimeStaging(
        request(root, 'task-sha256', tree),
        sourceFor(new Map([[entry.oid, content], [emptyEntry.oid, empty]])),
      );
      expect(result.gitCommit).toBe(SHA256_COMMIT);
      expect(result.stagingIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(result.snapshotIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(join(root, 'task-sha256', 'sha256.txt'), 'utf8')).toBe('sha256 repository');
      expect((await stat(join(root, 'task-sha256', 'empty.txt'))).size).toBe(0);
    });
  });
});
