import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUNTIME_STAGING_MAX_ENTRIES,
  AGENT_RUNTIME_STAGING_MAX_FILE_BYTES,
  AGENT_RUNTIME_STAGING_MAX_PATH_BYTES,
  AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH,
  AGENT_RUNTIME_STAGING_MAX_SEGMENT_BYTES,
  AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES,
  AGENT_RUNTIME_STAGING_RESULT_VERSION,
  AgentRuntimeStagingResultError,
  normalizeAgentRuntimeStagingPath,
  normalizeAgentRuntimeStagingResult,
} from '../src/agentRuntimeStagingResult';

const write = (path: string, sizeBytes = 12, extra: Record<string, unknown> = {}) => ({
  operation: 'write',
  path,
  fileType: 'regular-file',
  sizeBytes,
  linkCount: 1,
  ...extra,
});

const manifest = (entries: unknown[]) => ({
  version: AGENT_RUNTIME_STAGING_RESULT_VERSION,
  entries,
});

function expectCode(run: () => unknown, code: AgentRuntimeStagingResultError['code']): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeStagingResultError);
    expect((error as AgentRuntimeStagingResultError).code).toBe(code);
  }
}

describe('Agent Runtime staging result validation', () => {
  test('accepts only bounded regular-file writes and explicit leaf deletions', () => {
    const result = normalizeAgentRuntimeStagingResult(manifest([
      write('src/기능.ts', 37),
      { operation: 'delete', path: 'src/old.ts' },
    ]));
    expect(result.version).toBe(AGENT_RUNTIME_STAGING_RESULT_VERSION);
    expect(result.entries).toEqual([
      {
        operation: 'write',
        path: 'src/기능.ts',
        fileType: 'regular-file',
        sizeBytes: 37,
        linkCount: 1,
      },
      { operation: 'delete', path: 'src/old.ts' },
    ]);
    expect(normalizeAgentRuntimeStagingResult(manifest([])).entries).toEqual([]);
  });

  test('rejects unknown manifest versions, entry operations, and extra fields', () => {
    expectCode(() => normalizeAgentRuntimeStagingResult({ version: 'future', entries: [] }), 'INVALID_MANIFEST');
    expectCode(() => normalizeAgentRuntimeStagingResult({ ...manifest([]), command: 'apply' }), 'INVALID_MANIFEST');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      { operation: 'rename', path: 'from', destination: 'to' },
    ])), 'INVALID_ENTRY');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      { operation: 'delete', path: 'old.ts', recursive: true },
    ])), 'INVALID_ENTRY');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('new.ts', 1, { mode: 0o755 }),
    ])), 'INVALID_ENTRY');
  });

  test('requires canonical bounded relative POSIX paths', () => {
    for (const path of [
      '', '/tmp/escape', 'C:/escape', '\\\\server\\share', 'src\\file.ts',
      '.', '..', '../escape', 'src/../escape', './src/file.ts', 'src//file.ts',
      'src/file.ts/', 'src/\0file.ts', 'src/line\nbreak.ts', ' src/file.ts',
      'src/file.ts ', 'src/file.', 'src/file:stream', `caf\u0065\u0301.txt`,
      `bad\ud800name`, '．．/escape', 'safe／escape',
    ]) {
      expectCode(() => normalizeAgentRuntimeStagingPath(path), 'UNSAFE_PATH');
    }

    expectCode(
      () => normalizeAgentRuntimeStagingPath('a'.repeat(AGENT_RUNTIME_STAGING_MAX_PATH_BYTES + 1)),
      'PATH_LIMIT_EXCEEDED',
    );
    expectCode(
      () => normalizeAgentRuntimeStagingPath(`${'한'.repeat(Math.floor(AGENT_RUNTIME_STAGING_MAX_PATH_BYTES / 3))}/한`),
      'PATH_LIMIT_EXCEEDED',
    );
    expectCode(
      () => normalizeAgentRuntimeStagingPath(`${'a'.repeat(AGENT_RUNTIME_STAGING_MAX_SEGMENT_BYTES + 1)}/x`),
      'PATH_LIMIT_EXCEEDED',
    );
    expectCode(
      () => normalizeAgentRuntimeStagingPath(Array.from({ length: AGENT_RUNTIME_STAGING_MAX_PATH_DEPTH + 1 }, () => 'a').join('/')),
      'PATH_LIMIT_EXCEEDED',
    );
  });

  test('protects Git, long-term-memory, skills, provider, and AgentsToZ control paths', () => {
    for (const path of [
      '.git/config', 'nested/.GIT/index', '.agent-memory/CORE.md',
      'nested/.Agent-Memory/config.json', '.agents/skills/x/SKILL.md',
      '.agentstoz/control.json', '.agentstoz-staging/result.json',
      '.agentstoz_task/nonce', '.codex/config.toml', '.claude/settings.json',
      'AGENTS.md', 'nested/agents.MD', 'CLAUDE.md',
    ]) {
      expectCode(() => normalizeAgentRuntimeStagingPath(path), 'PROTECTED_PATH');
    }
  });

  test('rejects duplicate, case, Unicode compatibility, and prefix spelling collisions', () => {
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('src/a.ts'),
      { operation: 'delete', path: 'src/a.ts' },
    ])), 'DUPLICATE_PATH');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('src/File.ts'), write('src/file.ts'),
    ])), 'PATH_COLLISION');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('Ａ/file.ts'), write('A/file.ts'),
    ])), 'PATH_COLLISION');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('straße.ts'), write('STRASSE.ts'),
    ])), 'PATH_COLLISION');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('Source/a.ts'), write('source/b.ts'),
    ])), 'PATH_COLLISION');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('file'), write('file/child'),
    ])), 'PATH_SHAPE_COLLISION');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('file'), write('file-child'), write('file/child'),
    ])), 'PATH_SHAPE_COLLISION');
  });

  test('rejects symlinks, hardlinks, special files, and incomplete observations', () => {
    for (const fileType of ['symlink', 'directory', 'fifo', 'socket', 'block-device', 'character-device']) {
      expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
        { ...write('unsafe'), fileType },
      ])), 'NON_REGULAR_FILE');
    }
    for (const linkCount of [0, 2, 3, null, undefined]) {
      expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
        { ...write('ambiguous'), linkCount },
      ])), 'HARDLINK_AMBIGUOUS');
    }
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      { operation: 'write', path: 'missing-stat', fileType: 'regular-file', sizeBytes: 1 },
    ])), 'INVALID_ENTRY');
  });

  test('bounds entry count, individual bytes, total bytes, and integer validity', () => {
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest(
      Array.from({ length: AGENT_RUNTIME_STAGING_MAX_ENTRIES + 1 }, (_, index) => (
        { operation: 'delete', path: `old/${index}` }
      )),
    )), 'ENTRY_LIMIT_EXCEEDED');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('large.bin', AGENT_RUNTIME_STAGING_MAX_FILE_BYTES + 1),
    ])), 'FILE_SIZE_LIMIT_EXCEEDED');
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      write('a.bin', AGENT_RUNTIME_STAGING_MAX_FILE_BYTES),
      write('b.bin', AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES - AGENT_RUNTIME_STAGING_MAX_FILE_BYTES + 1),
    ])), 'FILE_SIZE_LIMIT_EXCEEDED');

    const fullFiles = AGENT_RUNTIME_STAGING_MAX_TOTAL_BYTES / AGENT_RUNTIME_STAGING_MAX_FILE_BYTES;
    expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
      ...Array.from({ length: fullFiles }, (_, index) => write(`${index}.bin`, AGENT_RUNTIME_STAGING_MAX_FILE_BYTES)),
      write('overflow.bin', 1),
    ])), 'TOTAL_SIZE_LIMIT_EXCEEDED');

    for (const sizeBytes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => normalizeAgentRuntimeStagingResult(manifest([
        write('invalid-size', sizeBytes),
      ])), 'INVALID_ENTRY');
    }
  });
});
