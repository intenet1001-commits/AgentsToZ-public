import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const memorySource = readFileSync(new URL('../src/ProjectMemoryPanel.tsx', import.meta.url), 'utf8');

describe('missing project folder recovery', () => {
  test('worktree API reports a stable missing-root error', () => {
    expect(apiSource).toContain("code: 'PROJECT_ROOT_MISSING'");
    expect(apiSource).toContain('프로젝트 폴더가 없습니다');
  });

  test('worktree panel preserves the API code and offers path repair', () => {
    expect(appSource).toContain('(failure as Error & { code?: string }).code = data.code');
    expect(appSource).toContain('data-testid="worktree-load-error"');
    expect(appSource).toContain('data-testid="worktree-fix-folder-path"');
  });

  test('memory panel distinguishes a missing folder from unused memory', () => {
    expect(memorySource).toContain("errorCode === 'PROJECT_ROOT_MISSING'");
    expect(memorySource).toContain('data-testid="project-memory-missing-root"');
    expect(memorySource).toContain('프로젝트 폴더 없음');
  });
});
