import { describe, test, expect } from 'bun:test';
import { buildClientErrorReport, MAX_CLIENT_ERROR_FIELD } from '../src/clientErrorReport';

/**
 * The report the phone writes to `portmgr_client_errors`.
 *
 * It exists so a failure that happens away from the Mac survives long enough to
 * be read back there. That makes what it must NOT carry as important as what it
 * does: this row is written by a browser and read by the desktop app, so a
 * local path or a token leaking into it would cross a boundary the rest of the
 * remote-control design is careful about.
 */
describe('client error report', () => {
  test('carries the code and message the user saw', () => {
    const report = buildClientErrorReport({
      deviceId: '11111111-1111-4111-8111-111111111111',
      deviceName: '회사에서받은맥북',
      surface: 'remote-control',
      code: 'RELAY_POLL_TIMEOUT',
      message: '외부 원격제어 연결을 처리하지 못했습니다.',
      detail: 'state: approval-required',
      appVersion: '354',
    });
    expect(report.code).toBe('RELAY_POLL_TIMEOUT');
    expect(report.message).toContain('처리하지 못했습니다');
    expect(report.surface).toBe('remote-control');
    expect(report.device_id).toBe('11111111-1111-4111-8111-111111111111');
  });

  test('generates an id and timestamp so retries do not collide', () => {
    const first = buildClientErrorReport({ code: 'X', message: 'y' });
    const second = buildClientErrorReport({ code: 'X', message: 'y' });
    expect(first.id).not.toBe(second.id);
    expect(Date.parse(first.created_at)).not.toBeNaN();
  });

  test('drops an absolute filesystem path instead of storing it', () => {
    const report = buildClientErrorReport({
      code: 'GIT_WORKTREE_DIRTY',
      message: '커밋이 필요합니다',
      detail: '/Users/someone/secret-project 에서 실패',
    });
    expect(report.detail).not.toContain('/Users/someone');
    expect(report.detail).toContain('[path]');
  });

  test('redacts anything that looks like a token or key', () => {
    const report = buildClientErrorReport({
      code: 'X',
      message: 'failed',
      detail: 'authorization: Bearer abcdef0123456789abcdef0123456789',
    });
    expect(report.detail).not.toContain('abcdef0123456789abcdef0123456789');
    expect(report.detail).toContain('[redacted]');
  });

  test('keeps a long server error code intact — it is not a secret', () => {
    // The secret redactor matches 32+ char alphanumeric runs, which swallowed
    // REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED whole: the one field that exists
    // to identify the fault came back as "[redacted]". Server codes are a
    // fixed vocabulary, not free text, so they are bounded but never scrubbed.
    const report = buildClientErrorReport({
      code: 'REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED',
      message: 'y',
    });
    expect(report.code).toBe('REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED');
  });

  test('bounds every field so one report cannot fill the table', () => {
    const long = 'x'.repeat(MAX_CLIENT_ERROR_FIELD * 4);
    const report = buildClientErrorReport({ code: long, message: long, detail: long });
    expect(report.code.length).toBeLessThanOrEqual(MAX_CLIENT_ERROR_FIELD);
    expect(report.message.length).toBeLessThanOrEqual(MAX_CLIENT_ERROR_FIELD);
    expect((report.detail ?? '').length).toBeLessThanOrEqual(MAX_CLIENT_ERROR_FIELD);
  });

  test('omits an empty optional rather than writing a blank string', () => {
    const report = buildClientErrorReport({ code: 'X', message: 'y' });
    expect(report.detail).toBeNull();
    expect(report.device_id).toBeNull();
  });
});
