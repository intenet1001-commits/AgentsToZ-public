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
  test('AI 터미널의 플로팅 판정은 기존대로 유지한다', () => {
    expect(shouldUseOrcaFloatingTerminal('/repo/worktrees/a', 'floating')).toBe(true);
    expect(shouldUseOrcaFloatingTerminal('/repo/worktrees/a', 'worktree')).toBe(false);
    expect(shouldUseOrcaFloatingTerminal(undefined, 'worktree')).toBe(true);
  });

  test('브라우저 미리보기는 터미널 전용 global-floating selector를 쓰지 않는다', () => {
    const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const apiHandler = apiSource.slice(
      apiSource.indexOf('if (url.pathname === "/api/open-orca-localhost"'),
      apiSource.indexOf('// Orca app endpoint'),
    );
    const tauriHandler = tauriSource.slice(
      tauriSource.indexOf('fn open_orca_localhost('),
      tauriSource.indexOf('fn open_orca_app('),
    );
    const appCaller = appSource.slice(
      appSource.indexOf('const callOrcaLocalhost = async'),
      appSource.indexOf('const showOrcaActionSuccess ='),
    );

    expect(appCaller).toContain('const floating = false;');
    expect(apiHandler).toContain('const worktreeSelector = `path:${cdPath}`;');
    expect(apiHandler).toContain('const reg = await orcaEnsureRepo(');
    expect(apiHandler).not.toContain('ORCA_FLOATING_WORKTREE_SELECTOR');
    expect(tauriHandler).toContain('let worktree_sel = format!("path:{}", cd_path);');
    expect(tauriHandler).toContain('&["repo", "add", "--path", reg_target]');
    expect(tauriHandler).not.toContain('"id:global-floating-terminal"');
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
