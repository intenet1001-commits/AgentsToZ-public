import { describe, expect, test } from 'bun:test';
import { isWorktreePortCandidate } from '../src/worktreePortScheme';

describe('isWorktreePortCandidate', () => {
  test('accepts the slot scheme for a 9000 main port', () => {
    for (const port of [19000, 29000, 39000, 49000, 59000]) {
      expect(isWorktreePortCandidate(port, 9000)).toBe(true);
    }
  });

  test('rejects the Serena MCP port that used to be misdetected', () => {
    // cwd가 워크트리와 같아도 24285는 어떤 배정 규칙에도 맞지 않는다.
    expect(isWorktreePortCandidate(24285, 9000)).toBe(false);
  });

  test('rejects ports that share the slot but not the main port', () => {
    expect(isWorktreePortCandidate(19001, 9000)).toBe(false);
    expect(isWorktreePortCandidate(13001, 9000)).toBe(false);
  });

  test('rejects slots outside 1-5', () => {
    expect(isWorktreePortCandidate(9000, 9000)).toBe(false);
    expect(isWorktreePortCandidate(69000, 9000)).toBe(false);
  });

  test('accepts the legacy path-hash range regardless of main port', () => {
    expect(isWorktreePortCandidate(10001, 9000)).toBe(true);
    expect(isWorktreePortCandidate(10499, undefined)).toBe(true);
    expect(isWorktreePortCandidate(10500, undefined)).toBe(false);
    expect(isWorktreePortCandidate(10000, undefined)).toBe(false);
  });

  test('without a main port only the legacy range is trusted', () => {
    expect(isWorktreePortCandidate(19000, undefined)).toBe(false);
    expect(isWorktreePortCandidate(19000, null)).toBe(false);
  });

  test('mirrors worktreePortForMain by ignoring out-of-range main ports', () => {
    // worktreePortForMain은 mainPort<1000 또는 >9999면 해시 방식으로 폴백한다.
    expect(isWorktreePortCandidate(10800, 800)).toBe(false);
    expect(isWorktreePortCandidate(70000, 60000)).toBe(false);
  });

  test('rejects non-integer and out-of-range ports', () => {
    expect(isWorktreePortCandidate(1.5, 9000)).toBe(false);
    expect(isWorktreePortCandidate(0, 9000)).toBe(false);
    expect(isWorktreePortCandidate(70001, 9000)).toBe(false);
  });
});
