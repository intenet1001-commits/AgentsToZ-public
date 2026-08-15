import { describe, expect, test } from 'bun:test';
import {
  mergeWorkspaceRootsPreservingLocalOrder,
  reorderWorkspaceRoots,
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
});
