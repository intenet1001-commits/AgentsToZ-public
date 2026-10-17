import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveContextProjectTarget } from '../src/contextProjectNavigation';
import { buildWorktreeContextCandidates } from '../src/worktreeContextCandidates';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('worktree context ownership candidates', () => {
  test('Git discovery keeps canonical parent ownership over a manual rich alias', () => {
    const external = '/Users/me/orca/workspaces/demo-task';
    const candidates = buildWorktreeContextCandidates([
      { id: 'parent', name: 'Demo', folderPath: '/Users/me/projects/demo' },
      { id: 'manual-alias', name: 'Manual alias', folderPath: external },
    ], {
      parent: [
        { path: '/Users/me/projects/demo', branch: 'main' },
        { path: external, branch: 'task/external' },
      ],
      'manual-alias': [],
    }, {
      'manual-alias': [
        { path: '/Users/me/projects/demo', branch: 'main' },
        { path: external, branch: 'task/external' },
      ],
    });
    expect(resolveContextProjectTarget(candidates, `${external}/src/index.tsx`))
      .toMatchObject({ projectId: 'parent', priority: 3 });
  });

  test('removed project IDs cannot survive through stale rich state', () => {
    const candidates = buildWorktreeContextCandidates([
      { id: 'remaining', name: 'Remaining', folderPath: '/repo/remaining' },
    ], {}, {
      removed: [{ path: '/repo/removed', branch: 'main' }],
    });
    expect(resolveContextProjectTarget(candidates, '/repo/removed/src')).toBeNull();
  });

  test('generated worktree rows never become cwd owners without their canonical parent', () => {
    const generatedPath = '/Users/me/.codex/worktrees/demo-feature';
    const candidates = buildWorktreeContextCandidates([
      {
        id: 'deleted-parent_wt_feature',
        name: 'Generated feature',
        folderPath: generatedPath,
        worktreePath: generatedPath,
        worktreeParentId: 'deleted-parent',
      },
    ], {
      'deleted-parent_wt_feature': [{ path: generatedPath, branch: 'feature' }],
    }, {
      'deleted-parent_wt_feature': [{ path: generatedPath, branch: 'feature' }],
    });

    expect(resolveContextProjectTarget(candidates, `${generatedPath}/src/index.ts`)).toBeNull();
  });

  test('a manual project ID containing _wt_ remains a cwd owner without provenance', () => {
    const path = '/Users/me/projects/manual_wt_dashboard';
    const candidates = buildWorktreeContextCandidates([
      { id: 'manual_wt_dashboard', name: 'Manual', folderPath: path },
    ], {
      manual_wt_dashboard: [{ path, branch: 'main' }],
    });
    expect(resolveContextProjectTarget(candidates, `${path}/src/index.ts`))
      .toMatchObject({ projectId: 'manual_wt_dashboard' });
  });

  test('one visible-background poll drains bounded server pages instead of waiting one tick per page', () => {
    const start = appSource.indexOf('const refreshRegisteredWorktreeDiscovery = useCallback');
    const end = appSource.indexOf('// 작업 루트 초기 로드', start);
    const discovery = appSource.slice(start, end);
    expect(discovery).toContain('for (let page = 0; page < 64; page += 1)');
    expect(discovery).toContain('cursor = result.nextCursor');
    expect(discovery).toContain('registeredWorktreeDiscoveryCursorRef.current = 0');
  });
});
