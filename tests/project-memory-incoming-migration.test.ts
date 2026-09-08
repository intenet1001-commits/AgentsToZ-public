import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '..', 'project-memory-server.ts'), 'utf8');

function functionBody(start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('incoming project-memory v11 migration coverage', () => {
  const restore = functionBody('export async function restoreProjectMemoryRevision', '\n/**\n * Backs up the journal');
  const pull = functionBody('export async function pullProjectMemory', '\n/**\n * Resolve a previously displayed memory conflict');
  const resolve = functionBody('export async function resolveProjectMemoryConflict', '\nexport async function sessionEndProjectMemory');

  test('historical restore migrates before install and exposes the required follow-up Push', () => {
    expect(restore).toContain('installIncomingProjectMemoryContent');
    expect(restore).toContain('...incomingMigration');
    expect(restore).not.toContain('writeMemoryDocument(root, local.memoryPath!, remoteContent)');
  });

  test('both equal-hash and replacement Pull paths migrate incoming legacy bytes', () => {
    expect(pull.match(/installIncomingProjectMemoryContent/g)?.length).toBe(2);
    expect(pull).toContain('migrationRequiredPush');
    expect(pull).not.toContain('writeMemoryDocument(root, local.memoryPath!, remoteContent)');
  });

  test('use-remote conflict resolution migrates before reporting v11', () => {
    expect(resolve).toContain('installIncomingProjectMemoryContent');
    expect(resolve).toContain('...incomingMigration');
    expect(resolve).not.toContain('writeMemoryDocument(root, local.memoryPath, remoteContent)');
  });
});
