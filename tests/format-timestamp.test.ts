import { describe, expect, test } from 'bun:test';
import { formatAbsoluteTimestamp } from '../src/formatTimestamp';

describe('formatAbsoluteTimestamp', () => {
  // 로컬 생성자로 만들어 실행 환경 타임존과 무관하게 결과가 고정된다.
  test('renders local time as YYYY.MM.DD HH:mm:ss', () => {
    expect(formatAbsoluteTimestamp(new Date(2026, 7, 2, 23, 9, 59))).toBe('2026.08.02 23:09:59');
  });

  test('zero-pads every field', () => {
    expect(formatAbsoluteTimestamp(new Date(2026, 0, 3, 4, 5, 6))).toBe('2026.01.03 04:05:06');
  });

  test('keeps midnight as 00, not 24', () => {
    expect(formatAbsoluteTimestamp(new Date(2026, 7, 2, 0, 0, 0))).toBe('2026.08.02 00:00:00');
  });

  test('accepts the ISO strings the worktree API returns', () => {
    const iso = new Date(2026, 7, 2, 23, 7, 49).toISOString();
    expect(formatAbsoluteTimestamp(iso)).toBe('2026.08.02 23:07:49');
  });

  test('accepts epoch milliseconds', () => {
    expect(formatAbsoluteTimestamp(new Date(2026, 7, 2, 23, 9, 59).getTime())).toBe('2026.08.02 23:09:59');
  });

  test('returns an empty string for missing or unparsable input', () => {
    expect(formatAbsoluteTimestamp(undefined)).toBe('');
    expect(formatAbsoluteTimestamp(null)).toBe('');
    expect(formatAbsoluteTimestamp('')).toBe('');
    expect(formatAbsoluteTimestamp('not a date')).toBe('');
  });
});
