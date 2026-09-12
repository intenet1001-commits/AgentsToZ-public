import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiSource = readFileSync(join(import.meta.dir, '..', 'api-server.ts'), 'utf8');
const rustSource = readFileSync(join(import.meta.dir, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');

function bounded(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Orca worktree removal keeps the final dirty-file guard', () => {
  test('browser API never force-removes an existing Orca worktree', () => {
    const route = bounded(
      apiSource,
      'url.pathname === "/api/git-worktree-remove"',
      'url.pathname === "/api/git-merge-preview"',
    );
    expect(route).toContain("['worktree', 'rm', '--worktree', `path:${target.path}`]");
    expect(route).not.toContain("`path:${target.path}`, '--force'");
  });

  test('native command never force-removes an existing Orca worktree', () => {
    const command = bounded(
      rustSource,
      'fn git_worktree_remove(',
      '\n#[tauri::command(async)]\nfn git_merge_branch',
    );
    expect(command).toContain('&["worktree", "rm", "--worktree", &selector]');
    expect(command).not.toContain('&selector, "--force"');
  });

  test('failed-visibility rollback also refuses to discard newly created files', () => {
    const apiCreate = bounded(
      apiSource,
      'url.pathname === "/api/git-worktree-add"',
      'url.pathname === "/api/git-worktree-remove"',
    );
    const rustCreate = bounded(
      rustSource,
      'fn git_worktree_add(',
      '\n#[tauri::command(async)]\nfn git_worktree_remove',
    );
    expect(apiCreate).toContain("['worktree', 'rm', '--worktree', `path:${createdPath}`]");
    expect(apiCreate).not.toContain("`path:${createdPath}`, '--force'");
    expect(rustCreate).toContain('&["worktree", "rm", "--worktree", &selector]');
    expect(rustCreate).not.toContain('&selector, "--force"');
  });
});
