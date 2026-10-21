import { describe, expect, test } from 'bun:test';
import { buildDeveloperErrorReport, DEVELOPER_ERROR_REPORT_URL } from '../src/voc/developerReportContent';

describe('developer report review boundary', () => {
  test('the public tracker URL carries no report body or local configuration', () => {
    const url = new URL(DEVELOPER_ERROR_REPORT_URL);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/intenet1001-commits/AgentsToZ-public/issues/new');
    expect(url.search).toBe(''); expect(url.hash).toBe('');
  });
  test('preview includes the question and version while scrubbing incidental paths and token shapes', () => {
    const text = buildDeveloperErrorReport({ comment: '버튼 실패 /Users/alice/private/report.txt sk-abcdefghij1234567890abcdefghij1234567890', tab: 'workroom', appVersion: 'v1149' });
    expect(text).toContain('버튼 실패'); expect(text).toContain('v1149'); expect(text).toContain('재현 순서');
    expect(text).not.toContain('/Users/alice'); expect(text).not.toContain('sk-abcdefghij');
    expect(text).toContain('[path]'); expect(text).toContain('[redacted]');
  });
  test('untrusted context and a long input stay bounded and no files are read', () => {
    const text = buildDeveloperErrorReport({ comment: '가'.repeat(100_000), tab: '/home/alice/private', appVersion: '/Users/alice/private-version' });
    expect(text.length).toBeLessThan(7000); expect(text).not.toContain('/home/alice'); expect(text).not.toContain('/Users/alice');
  });
});
