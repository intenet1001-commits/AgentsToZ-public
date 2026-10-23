import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjectMemoryIdentity } from '../project-memory-server';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
};
function memory(root: string, id: string) {
  mkdirSync(join(root, '.agent-memory'), { recursive: true });
  writeFileSync(join(root, '.agent-memory/config.json'), JSON.stringify({ schemaVersion: 1, memoryId: id, sourcePath: '.agent-memory/CORE.md', agent: 'codex', autoBackup: false }));
  writeFileSync(join(root, '.agent-memory/CORE.md'), '# memory');
}
describe('identity-only source enumeration', () => {
  test('reads a standalone initialized folder without requiring Git or activity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-identity-')); roots.push(root);
    memory(root, 'standalone');
    const status = await detectProjectMemoryIdentity(root);
    expect(status.exists).toBe(true); expect(status.config?.memoryId).toBe('standalone');
    expect(Object.keys(status).sort()).toEqual(['config', 'exists', 'projectRoot']);
  });
  test('uses the primary worktree and never promotes a linked stale copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-identity-')); roots.push(root);
    const main = join(root, 'main'); const linked = join(root, 'linked'); mkdirSync(main);
    git(main, 'init'); git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-b', 'linked', linked);
    memory(main, 'canonical'); memory(linked, 'stale');
    expect((await detectProjectMemoryIdentity(linked)).config?.memoryId).toBe('canonical');
    rmSync(join(main, '.agent-memory'), { recursive: true });
    expect((await detectProjectMemoryIdentity(linked)).config).toBeNull();
    expect((await detectProjectMemoryIdentity(linked)).exists).toBe(false);
  });
  test('does not block the event loop while Git resolves concurrent sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-identity-')); roots.push(root); git(root, 'init'); memory(root, 'one');
    let ticks = 0; const timer = setInterval(() => ticks++, 1);
    try { await Promise.all(Array.from({ length: 20 }, () => detectProjectMemoryIdentity(root))); }
    finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0);
  });
});
