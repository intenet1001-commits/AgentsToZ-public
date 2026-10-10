import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('browser worktree API isolation', () => {
  test('uses the current Vite proxy for worktree-port discovery', () => {
    const start = appSource.indexOf('const loadWorktrees = useCallback');
    const end = appSource.indexOf('const refreshWorktreeAfterGitAction', start);
    const body = appSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("const baseUrl = isTauri() ? 'http://localhost:3001' : '';");
    expect(body).not.toContain("'http://127.0.0.1:3001'");
  });
});
