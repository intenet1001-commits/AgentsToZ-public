import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {isTransientNetworkError,TRANSIENT_NETWORK_ERROR_MESSAGE,transientNetworkErrorMessage} from '../src/remoteTransientNetworkError';
import {RemoteControlRelayRpcError} from '../src/remoteControlRelayRpcClient';

const PORTAL = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');

// 2026-10-07 iPhone: after hours idle the workroom showed «TypeError: Load failed» / RELAY_REQUEST_FAILED
// verbatim, and the box stayed after the Mac was answering again.
describe('a dropped network request is a transient, self-clearing error', () => {
  test('WebKit, Chromium and Firefox fetch failures are recognised under the relay codes', () => {
    expect(isTransientNetworkError(Object.assign(new Error('TypeError: Load failed'), {code: 'RELAY_REQUEST_FAILED'}))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('Failed to fetch'), {code: 'RELAY_CONNECTION_FAILED'}))).toBe(true);
    expect(isTransientNetworkError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isTransientNetworkError(new TypeError('Load failed'))).toBe(true);
  });

  test('a real refusal is never treated as a network blip', () => {
    expect(isTransientNetworkError(Object.assign(new Error('REMOTE_CONTROL_SESSION_REVOKED'), {code: 'REMOTE_CONTROL_SESSION_REVOKED'}))).toBe(false);
    expect(isTransientNetworkError(Object.assign(new Error('Load failed'), {code: 'REMOTE_CONTROL_SESSION_ACCESS_DENIED'}))).toBe(false);
    expect(isTransientNetworkError(new Error('권한이 없습니다'))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
  });

  test('the portal shows the Korean sentence and clears it once the Mac is seen again', () => {
    // 2026-10-10: the sentence names the phone when the phone itself has no network.
    expect(PORTAL).toContain('if (isTransientNetworkError(value)) return transientNetworkErrorMessage();');
    expect(PORTAL).toMatch(/status\.hostLastSeenAt === transient\.seen\) return;/);
  });
});

describe('the phone offline says so (2026-10-10, iPhone with Wi‑Fi off)', () => {
  test('the banner sentence is the phone-offline one only while the phone is offline', () => {
    expect(transientNetworkErrorMessage(true)).toBe(TRANSIENT_NETWORK_ERROR_MESSAGE);
    expect(transientNetworkErrorMessage(false)).toContain('휴대폰이 인터넷에 연결되어 있지 않습니다');
    expect(transientNetworkErrorMessage(false)).not.toContain('Mac이 다시 응답하면');
  });

  test('a thrown invoker keeps its fetch failure in detail and is still recognised', () => {
    const wrapped = new RemoteControlRelayRpcError('RELAY_CONNECTION_FAILED', undefined, new TypeError('Load failed'));
    expect(wrapped.message).not.toContain('Load failed');
    expect(isTransientNetworkError(wrapped)).toBe(true);
    expect(isTransientNetworkError(new RemoteControlRelayRpcError('RELAY_CONNECTION_FAILED', undefined, new Error('boom')))).toBe(false);
    // Only the connection code looks one level down; a relay refusal with a fetch-looking detail is not a blip.
    expect(isTransientNetworkError(new RemoteControlRelayRpcError('RELAY_RESPONSE_INVALID', undefined, new TypeError('Load failed')))).toBe(false);
  });
});
