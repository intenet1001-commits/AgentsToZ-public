import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProjectGitSync } from '../project-memory-server';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe('단말별 Git 스냅샷', () => {
  test('HEAD·브랜치·upstream 차이·dirty를 네트워크 없이 수집한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-git-device-'));
    const bare = mkdtempSync(join(tmpdir(), 'agentstoz-git-remote-'));
    roots.push(root, bare);
    git(bare, 'init', '--bare', '-q');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'README.md'), 'one\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'initial');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-qu', 'origin', 'HEAD');

    const clean = inspectProjectGitSync(root)!;
    expect(clean.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.upstreamSha).toBe(clean.headSha);
    expect(clean.ahead).toBe(0);
    expect(clean.behind).toBe(0);
    expect(clean.dirty).toBe(false);
    expect(clean.remoteUrl).toBe(bare);
    expect(clean.commitAt).toBeTruthy();

    writeFileSync(join(root, 'README.md'), 'two\n');
    expect(inspectProjectGitSync(root)?.dirty).toBe(true);
  });

  test('Git 저장소가 아니면 상태를 꾸며내지 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-no-git-'));
    roots.push(root);
    expect(inspectProjectGitSync(root)).toBeNull();
  });
});
