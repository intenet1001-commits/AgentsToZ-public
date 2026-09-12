import { describe, expect, test } from 'bun:test';
import { selectMatchingDroppedPath } from '../src/dropped-path';

describe('macOS drag pasteboard path selection', () => {
  const kinds = new Map<string, 'file' | 'folder'>([
    ['/Users/demo/docs/MANUAL.md', 'file'],
    ['/Users/demo/project', 'folder'],
  ]);
  const kindOf = (path: string) => kinds.get(path) ?? null;

  test('accepts only a candidate whose basename and kind match the browser drop', () => {
    expect(selectMatchingDroppedPath(
      ['/Users/demo/docs/MANUAL.md'],
      ['MANUAL.md'],
      'file',
      kindOf,
    )).toBe('/Users/demo/docs/MANUAL.md');

    expect(selectMatchingDroppedPath(
      ['/Users/demo/project'],
      ['project'],
      'folder',
      kindOf,
    )).toBe('/Users/demo/project');
  });

  test('rejects stale pasteboard paths and file-folder mismatches', () => {
    expect(selectMatchingDroppedPath(
      ['/Users/demo/docs/MANUAL.md'],
      ['different.md'],
      'file',
      kindOf,
    )).toBeNull();

    expect(selectMatchingDroppedPath(
      ['/Users/demo/project'],
      ['project'],
      'file',
      kindOf,
    )).toBeNull();
  });
});
