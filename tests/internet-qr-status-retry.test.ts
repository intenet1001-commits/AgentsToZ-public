import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { internetRemoteStatusView } from '../src/internetRemoteControlPairingState';

const source = readFileSync(new URL('../src/InternetQrRemoteControlDialog.tsx', import.meta.url), 'utf8');

describe('internet QR dialog: a failed status check is a state, not an endless spinner', () => {
  test('the view is loading only while a check is actually running', () => {
    expect(internetRemoteStatusView({ initialLoading: true, hasStatus: false, loadFailed: false })).toBe('loading');
    // Before the first effect runs nothing has failed yet — keep the spinner.
    expect(internetRemoteStatusView({ initialLoading: false, hasStatus: false, loadFailed: false })).toBe('loading');
    // The bug: after one failed check the spinner stayed forever with no retry.
    expect(internetRemoteStatusView({ initialLoading: false, hasStatus: false, loadFailed: true })).toBe('unavailable');
    expect(internetRemoteStatusView({ initialLoading: false, hasStatus: true, loadFailed: true })).toBe('ready');
  });

  test('the unavailable state offers a retry that re-runs the check', () => {
    expect(source).toContain('internetRemoteStatusView(');
    expect(source).toContain('data-testid="internet-qr-status-retry"');
    expect(source).toContain('현재 상태를 확인하지 못했습니다.');
    expect(source).toMatch(/data-testid="internet-qr-status-retry"[^>]*onClick=\{\(\) => void refresh\(true\)\}/);
    // Both the first load and a manual refresh must record the failure.
    expect(source.match(/setLoadFailed\(true\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
