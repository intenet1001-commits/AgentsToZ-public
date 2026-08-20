import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const publishScript = resolve(import.meta.dir, '../scripts/publish.ts');
const roots: string[] = [];

function git(root: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public publisher integration', () => {
  test('dry-run excludes every private-only path and returns to main', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-publish-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'superpowers'), { recursive: true });
    mkdirSync(join(root, 'uploaded-commands'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'safe public file\n');
    writeFileSync(join(root, 'uploaded-commands', '실행.command'), '#!/bin/sh\necho safe\n');
    writeFileSync(join(root, 'CLAUDE.md'), 'private operator notes\n');
    writeFileSync(join(root, 'docs', 'PROJECT_MEMORY_V99_HANDOFF_private.md'), 'private handoff\n');
    writeFileSync(join(root, 'docs', 'superpowers', 'internal-plan.md'), 'private plan\n');

    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'AgentsToZ Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'fixture']);
    git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);

    const result = Bun.spawnSync({
      cmd: [process.execPath, publishScript, '--dry-run'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(git(root, ['branch', '--show-current'])).toBe('main');
    const publicTree = git(root, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'publish-clean']).split('\n').filter(Boolean);
    expect(publicTree).toEqual(['README.md', 'uploaded-commands/실행.command']);
  });
});
