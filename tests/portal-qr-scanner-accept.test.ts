import { expect, test } from 'bun:test';
import { PortalRemoteQrError } from '../src/portalRemoteQr';
import { PORTAL_QR_RETRY_AFTER_MS, portalQrAcceptFailureMessage } from '../src/PortalRemoteQrScanner';

/**
 * Why a decoded QR was not accepted (audit 2026-10-16). Every failure that was not a refusal of the QR itself — the
 * app's own 「연결 준비 중입니다…」, an IndexedDB seal that failed — was shown as 「…새로 발급한 QR을 사용하세요」,
 * which sent the user back to the Mac for a new QR when the QR was fine. The live-camera half of that finding is
 * checked in a browser: tests/portal-qr-scanner-camera.e2e.mjs (steps 4–5).
 */
test('a refusal of the QR itself says why', () => {
  expect(portalQrAcceptFailureMessage(new PortalRemoteQrError('WRONG_PORTAL', '다른 배포본에서 발급한 QR은 이 포털에서 열 수 없습니다.')))
    .toBe('다른 배포본에서 발급한 QR은 이 포털에서 열 수 없습니다.');
});

test('the app\'s own reason passes through, and nothing else sends the user to the Mac first', () => {
  expect(portalQrAcceptFailureMessage(new Error('연결 준비 중입니다. 잠시 후 다시 시도하세요.'))).toBe('연결 준비 중입니다. 잠시 후 다시 시도하세요.');
  for (const other of [new DOMException('The transaction was aborted', 'AbortError'), new Error('QuotaExceededError'), 'x', null]) {
    const text = portalQrAcceptFailureMessage(other);
    expect(text).toContain('다시 스캔');
    expect(text.indexOf('다시 스캔')).toBeLessThan(text.indexOf('새 QR'));
    expect(text).not.toContain('새로 발급한 QR을 사용하세요');
  }
});

test('a not-ready refusal is tried again after a short wait, not on every decode', () => {
  expect(PORTAL_QR_RETRY_AFTER_MS).toBeGreaterThanOrEqual(1_000);
  expect(PORTAL_QR_RETRY_AFTER_MS).toBeLessThanOrEqual(5_000);
});
