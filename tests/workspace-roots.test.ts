import { describe, expect, test } from 'bun:test';
import {
  groupProjectsByWorkspaceRoot,
  mergeWorkspaceRootsPreservingLocalOrder,
  reorderWorkspaceRoots,
  workspaceRootForProject,
} from '../src/workspace-roots';

describe('workspace root ordering', () => {
  test('moves a root one position and leaves invalid moves unchanged', () => {
    const roots = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(reorderWorkspaceRoots(roots, 'c', -1).map(root => root.id)).toEqual(['a', 'c', 'b']);
    expect(reorderWorkspaceRoots(roots, 'a', -1)).toBe(roots);
    expect(reorderWorkspaceRoots(roots, 'c', 1)).toBe(roots);
  });

  test('keeps local order during remote pull and appends remote-only roots', () => {
    const local = [
      { id: 'work', name: 'Work local' },
      { id: 'product', name: 'Product local' },
    ];
    const remote = [
      { id: 'product', name: 'Product remote' },
      { id: 'work', name: 'Work remote' },
      { id: 'new', name: 'New remote' },
    ];

    expect(mergeWorkspaceRootsPreservingLocalOrder(local, remote)).toEqual([
      { id: 'work', name: 'Work remote' },
      { id: 'product', name: 'Product remote' },
      { id: 'new', name: 'New remote' },
    ]);
  });

  test('assigns nested projects to the deepest matching root without prefix collisions', () => {
    const roots = [
      { id: 'work', name: 'Work', path: '/Users/cs/work' },
      { id: 'client', name: 'Client', path: '/Users/cs/work/client' },
    ];

    expect(workspaceRootForProject({ folderPath: '/Users/cs/work/client/app' }, roots)?.id).toBe('client');
    expect(workspaceRootForProject({ folderPath: '/Users/cs/workbench/app' }, roots)).toBeNull();
    expect(workspaceRootForProject({ folderPath: '/Users/cs/work' }, roots)?.id).toBe('work');
  });

  test('matches Windows paths case-insensitively across slash styles', () => {
    const roots = [{ id: 'win', name: 'Windows work', path: 'C:\\Users\\CS\\Work\\' }];
    expect(workspaceRootForProject({ folderPath: 'c:/users/cs/work/project' }, roots)?.id).toBe('win');
  });

  test('groups in saved root order, uses worktree path, and leaves unassigned projects last', () => {
    const roots = [
      { id: 'b', name: 'B', path: '/work/b' },
      { id: 'a', name: 'A', path: '/work/a' },
    ];
    const projects = [
      { id: 'a-main', folderPath: '/work/a/main' },
      { id: 'outside', folderPath: '/other/project' },
      { id: 'b-worktree', folderPath: '/work/a/main', worktreePath: '/work/b/feature' },
    ];

    const groups = groupProjectsByWorkspaceRoot(projects, roots);
    expect(groups.map(group => group.root?.id ?? null)).toEqual(['b', 'a', null]);
    expect(groups.map(group => group.items.map(item => item.id))).toEqual([
      ['b-worktree'],
      ['a-main'],
      ['outside'],
    ]);
  });
});
