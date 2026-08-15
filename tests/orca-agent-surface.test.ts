import { describe, expect, test } from 'bun:test';
import {
  verifyOrcaBrowserPage,
  verifyOrcaManagedWorktree,
} from '../src/orcaResultVerification';
import { shouldUseOrcaFloatingTerminal } from '../src/orcaFloatingTerminal';
import { readFileSync } from 'node:fs';

describe('Orca result verification', () => {
  test('accepts an exact browser page and normalizes one trailing slash', () => {
    expect(verifyOrcaBrowserPage(
      { browserPageId: 'page-1' },
      { tab: { browserPageId: 'page-1', url: 'http://localhost:9000/' } },
      'http://localhost:9000',
    )).toEqual({ browserPageId: 'page-1', url: 'http://localhost:9000/' });
  });

  test('rejects fake browser success when the page is missing, mismatched, or on another URL', () => {
    expect(verifyOrcaBrowserPage({}, {}, 'http://localhost:9000')).toBeNull();
    expect(verifyOrcaBrowserPage(
      { browserPageId: 'page-1' },
      { tab: { browserPageId: 'page-2', url: 'http://localhost:9000' } },
      'http://localhost:9000',
    )).toBeNull();
    expect(verifyOrcaBrowserPage(
      { browserPageId: 'page-1' },
      { tab: { browserPageId: 'page-1', url: 'http://localhost:9001' } },
      'http://localhost:9000',
    )).toBeNull();
  });

  test('accepts only an Orca-created worktree that is present in the Orca list', () => {
    expect(verifyOrcaManagedWorktree(
      { worktree: { path: '/tmp/orca/demo/', branch: 'refs/heads/demo' } },
      { worktrees: [{ path: '/tmp/orca/demo' }] },
    )).toEqual({ path: '/tmp/orca/demo/', branch: 'demo' });
    expect(verifyOrcaManagedWorktree(
      { worktree: { path: '/tmp/orca/demo', branch: 'demo' } },
      { worktrees: [{ path: '/tmp/orca/other' }] },
    )).toBeNull();
  });
});

describe('Orca localhost 탭 표면', () => {
  test('로컬 미리보기는 AI 실행과 같은 규칙(플로팅/워크트리 내부)을 따른다', () => {
    // 회귀 방지: 탭은 항상 `path:<worktree>`로 열려서, 플로팅을 골라도 워크트리가
    // Orca 사이드바에 없으면 미리보기가 뜨지 않았다.
    expect(shouldUseOrcaFloatingTerminal('/repo/worktrees/a', 'floating')).toBe(true);
    expect(shouldUseOrcaFloatingTerminal('/repo/worktrees/a', 'worktree')).toBe(false);
    // 경로가 아예 없으면(전역 바로가기) 항상 플로팅
    expect(shouldUseOrcaFloatingTerminal(undefined, 'worktree')).toBe(true);
  });

  test('사이드바 모드는 심볼릭 링크의 실체 경로를 Orca selector로 사용한다', () => {
    const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

    expect(apiSource).toContain('function resolveOrcaProjectPath');
    expect(apiSource).toContain('realpathSync(pathValue)');
    expect(tauriSource).toContain('fn resolve_orca_project_path');
    expect(appSource).toContain("['worktree', '사이드바']");
  });
});
