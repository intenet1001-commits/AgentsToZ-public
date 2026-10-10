import { phoneIsOnline, phoneOfflineNotice } from './phoneNetwork';

const TRANSIENT_TEXT = /Load failed|Failed to fetch|NetworkError|network connection was lost|Internet connection appears to be offline/i;

/**
 * A dropped fetch — the phone slept, Wi-Fi changed, the app came back from the background. WebKit
 * reports it as "TypeError: Load failed" and supabase-js passes that through as the RPC error, so it
 * reached the screen verbatim under RELAY_REQUEST_FAILED (2026-10-07, iPhone after hours idle).
 *
 * A thrown invoker becomes RELAY_CONNECTION_FAILED with a generic Korean message; the fetch error is
 * then only in `detail`, so that one level is read too (2026-10-10).
 */
export function isTransientNetworkError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const {code, message, detail} = value as {code?: unknown; message?: unknown; detail?: unknown};
  const text = typeof message === 'string' ? message : '';
  if (typeof code === 'string' && code && !/^RELAY_(?:REQUEST|CONNECTION)_FAILED$/.test(code)) return false;
  if (TRANSIENT_TEXT.test(text)) return true;
  if (code === 'RELAY_CONNECTION_FAILED' && detail && typeof detail === 'object') {
    const inner = (detail as {message?: unknown}).message;
    return typeof inner === 'string' && TRANSIENT_TEXT.test(inner);
  }
  return false;
}

export const TRANSIENT_NETWORK_ERROR_MESSAGE = '네트워크가 잠시 끊겼습니다. 휴대폰이 잠자기 상태였거나 Wi‑Fi가 바뀌었을 수 있습니다. Mac이 다시 응답하면 이 안내는 저절로 사라집니다.';

/** The banner for a dropped request: when the phone itself has no network, say so instead. */
export function transientNetworkErrorMessage(online = phoneIsOnline()): string {
  return online ? TRANSIENT_NETWORK_ERROR_MESSAGE : phoneOfflineNotice();
}
