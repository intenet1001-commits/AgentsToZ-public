import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

test('root agent instructions do not contain unresolved merge markers', () => {
  const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  expect(instructions).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)(?: |$)/m);
});

test('machine-local E2E repositories are ignored and not tracked as broken gitlinks', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  expect(ignore).toContain('agentstoz-e2e-project/');
  expect(ignore).toContain('.e2e-remotes/');

  // Source archives do not carry .git; the ignore contract is the available
  // evidence there. A real checkout additionally proves that neither local
  // repository is part of the published index.
  if (!existsSync(join(root, '.git'))) return;
  const result = Bun.spawnSync({
    cmd: ['git', 'ls-files', '--stage', '--', 'agentstoz-e2e-project', '.e2e-remotes'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe('');
});
