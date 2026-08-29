import { describe, expect, test } from 'bun:test';
import { buildLogWindowDelta } from '../src/buildLogWindow';

describe('bounded build log windows', () => {
  test('continues after the server drops old entries', () => {
    const first = buildLogWindowDelta({
      output: ['a', 'b', 'c'],
      outputBase: 10,
      outputCursor: 13,
    }, 0);
    expect(first).toEqual({ entries: ['a', 'b', 'c'], cursor: 13 });

    const next = buildLogWindowDelta({
      output: ['b', 'c', 'd'],
      outputBase: 11,
      outputCursor: 14,
    }, first.cursor);
    expect(next).toEqual({ entries: ['d'], cursor: 14 });
  });

  test('recovers when a new build resets the server cursor', () => {
    expect(buildLogWindowDelta({
      output: ['new build'],
      outputBase: 0,
      outputCursor: 1,
    }, 2000)).toEqual({ entries: ['new build'], cursor: 1 });
  });

  test('supports legacy responses and rejects malformed metadata', () => {
    expect(buildLogWindowDelta({ output: ['a', 'b'] }, 1))
      .toEqual({ entries: ['b'], cursor: 2 });
    expect(buildLogWindowDelta({
      output: ['safe'],
      outputBase: 4,
      outputCursor: 999,
    }, 4)).toEqual({ entries: ['safe'], cursor: 5 });
  });
});
