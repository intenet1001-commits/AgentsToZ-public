import { describe, expect, test } from 'bun:test';
import { resolveContextProjectTarget } from '../src/contextProjectNavigation';

describe('context project navigation', () => {
  const candidates = [
    { projectId: 'main', path: '/Users/gwanli/work/product', priority: 1 },
    { projectId: 'worktree-parent', path: '/Users/gwanli/work/product/worktrees/fix-memory', priority: 3 },
    { projectId: 'other', path: '/Users/gwanli/work/productivity', priority: 1 },
  ];

  test('selects the deepest matching project or known worktree parent', () => {
    expect(resolveContextProjectTarget(candidates, '/Users/gwanli/work/product/worktrees/fix-memory/src'))
      .toMatchObject({ projectId: 'worktree-parent' });
    expect(resolveContextProjectTarget(candidates, '/Users/gwanli/work/product/packages/ui'))
      .toMatchObject({ projectId: 'main' });
  });

  test('uses exact path matching before ancestry and respects Windows casing', () => {
    expect(resolveContextProjectTarget(candidates, '/Users/gwanli/work/productivity'))
      .toMatchObject({ projectId: 'other' });
    expect(resolveContextProjectTarget([
      { projectId: 'windows', path: 'C:\\Work\\Meeting' },
    ], 'c:/work/meeting/src')).toMatchObject({ projectId: 'windows' });
  });

  test('does not make prefix-only false matches', () => {
    expect(resolveContextProjectTarget([{ projectId: 'app', path: '/work/app' }], '/work/application')).toBeNull();
  });

  test('external apps can record decomposed Korean paths for the same Mac folder', () => {
    const path = '/Users/cs-work/forcs/work/해외주식의결권';
    expect(resolveContextProjectTarget([{projectId:'korean',path}], `${path.normalize('NFD')}/src`))
      .toMatchObject({projectId:'korean'});
    // The folder name alone cannot bind an unrelated path to a registered project.
    expect(resolveContextProjectTarget([{projectId:'korean',path}], '/elsewhere/해외주식의결권')).toBeNull();
  });
});
