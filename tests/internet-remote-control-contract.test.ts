import { describe, expect, test } from 'bun:test';
import {
  INTERNET_REMOTE_CONTROL_PATHS,
  InternetRemoteControlContractError,
  formatInternetRemoteControlRemaining,
  isInternetRemoteControlExpired,
  normalizeInternetRemoteControllerOrigin,
  normalizeInternetRemoteControlEnableResponse,
  normalizeInternetRemoteControlStatus,
  normalizeInternetRemoteControlStatusEnvelope,
  normalizeInternetRemoteControlStatusResponse,
  type InternetRemoteControlStatus,
} from '../src/internetRemoteControlContract';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  buildRemoteControlRelayPairingUrl,
  encodeRemoteControlRelayBase64Url,
} from '../src/remoteControlRelayContract';

const encoded = (length: number, first = 0): string => {
  const bytes = Uint8Array.from({ length }, (_, index) => index === 0 ? first : index & 0xff);
  return encodeRemoteControlRelayBase64Url(bytes);
};

function status(overrides: Partial<InternetRemoteControlStatus> = {}): InternetRemoteControlStatus {
  return {
    enabled: true,
    state: 'approval-required',
    controllerUrl: 'https://controller.example/remote/',
    hostExpiresAt: '2099-08-30T12:30:00.000Z',
    pairingExpiresAt: '2099-08-30T12:05:00.000Z',
    lastRelayContactAt: '2099-08-30T12:00:01.000Z',
    sessions: [{
      sessionId: '22222222-2222-4222-8222-222222222222',
      pairingId: '11111111-1111-4111-8111-111111111111',
      controllerId: '33333333-3333-4333-8333-333333333333',
      controllerName: '내 iPad',
      controllerKeyFingerprint: encoded(32),
      approvalState: 'pending',
      sasCode: '314159',
      createdAt: '2099-08-30T12:00:00.000Z',
      expiresAt: '2099-08-30T12:30:00.000Z',
      approvedAt: null,
      taskScopeGranted: false,
      conversationScopeGranted: false,
    }],
    error: null,
    ...overrides,
  };
}

function pairingUrl(expiresAt = '2099-08-30T12:05:00.000Z'): string {
  return buildRemoteControlRelayPairingUrl('https://controller.example/remote/', {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    hostId: 'host_123456789012',
    pairingId: 'pairing_123456789',
    pairingSecret: encoded(32),
    hostPublicKey: encoded(65, 0x04),
    expiresAt,
  });
}

describe('external internet QR management contract', () => {
  test('uses a separate exact POST-only namespace', () => {
    expect(Object.values(INTERNET_REMOTE_CONTROL_PATHS)).toEqual([
      '/api/remote-control/internet/status',
      '/api/remote-control/internet/enable',
      // Adding a device is a new pairing, not disable→enable (which revoked
      // every connected device). VOC 2026-08-31 23:42.
      '/api/remote-control/internet/pairing/issue',
      '/api/remote-control/internet/sessions/approve',
      '/api/remote-control/internet/sessions/scopes',
      '/api/remote-control/internet/sessions/revoke',
      '/api/remote-control/internet/disable',
    ]);
    expect(Object.values(INTERNET_REMOTE_CONTROL_PATHS).every(path => path.startsWith('/api/remote-control/internet/'))).toBe(true);
  });

  test('accepts any credential-free exact HTTPS origin without Vercel lock-in', () => {
    expect(normalizeInternetRemoteControllerOrigin(' https://agents.example/ ')).toBe('https://agents.example');
    expect(normalizeInternetRemoteControllerOrigin('https://custom-host.example:8443')).toBe('https://custom-host.example:8443');
    for (const invalid of [
      'http://agents.example',
      'https://user:secret@agents.example',
      'https://agents.example/remote/',
      'https://agents.example/?token=secret',
      'https://agents.example/#key=secret',
    ]) expect(() => normalizeInternetRemoteControllerOrigin(invalid)).toThrow(InternetRemoteControlContractError);
  });

  test('strictly normalizes only sanitized status and pending-only SAS', () => {
    expect(normalizeInternetRemoteControlStatusResponse({ status: status() })).toEqual(status());
    const legacySession: Partial<InternetRemoteControlStatus['sessions'][number]> = {
      ...status().sessions[0]!,
    };
    delete legacySession.pairingId;
    delete legacySession.conversationScopeGranted;
    expect(normalizeInternetRemoteControlStatus({
      ...status(),
      sessions: [legacySession],
    }).sessions[0]).toMatchObject({ pairingId: null, conversationScopeGranted: false });
    expect(() => normalizeInternetRemoteControlStatus({
      ...status(),
      sessions: [{ ...status().sessions[0]!, pairingId: 'not-a-uuid' }],
    })).toThrow(InternetRemoteControlContractError);
    expect(normalizeInternetRemoteControlStatus({
      ...status({
        state: 'online',
        sessions: [{
          ...status().sessions[0]!,
          approvalState: 'approved',
          sasCode: null,
          approvedAt: '2099-08-30T12:01:00.000Z',
        }],
      }),
    }).state).toBe('online');

    for (const secretField of [
      'hostSecret', 'pairingSecret', 'hostPublicKey', 'controllerPublicKey',
      'serviceRole', 'sessionToken', 'pairingUrl',
    ]) {
      expect(() => normalizeInternetRemoteControlStatus({
        ...status(),
        [secretField]: 'must-not-cross-management-status',
      })).toThrow(InternetRemoteControlContractError);
      expect(() => normalizeInternetRemoteControlStatus({
        ...status(),
        sessions: [{ ...status().sessions[0]!, [secretField]: 'must-not-cross-session' }],
      })).toThrow(InternetRemoteControlContractError);
    }
    expect(() => normalizeInternetRemoteControlStatus({
      ...status({ state: 'online' }),
      sessions: [{ ...status().sessions[0]!, approvalState: 'approved', sasCode: '314159' }],
    })).toThrow(InternetRemoteControlContractError);
  });

  test('accepts a one-shot enable pairing only when its fragment origin and expiry match status', () => {
    const result = normalizeInternetRemoteControlEnableResponse({
      status: status({ state: 'pairing', sessions: [] }),
      pairing: {
        pairingUrl: pairingUrl(),
        expiresAt: '2099-08-30T12:05:00.000Z',
      },
    });
    expect(result.pairing?.pairingUrl).toBe(pairingUrl());
    expect(result.status.controllerUrl).toBe('https://controller.example/remote/');

    expect(() => normalizeInternetRemoteControlEnableResponse({
      status: status({ state: 'pairing', sessions: [] }),
      pairing: { pairingUrl: pairingUrl(), expiresAt: '2099-08-30T12:04:00.000Z' },
    })).toThrow(InternetRemoteControlContractError);
    expect(() => normalizeInternetRemoteControlStatusResponse({
      status: status(),
      pairing: { pairingUrl: pairingUrl(), expiresAt: '2099-08-30T12:05:00.000Z' },
    })).toThrow(InternetRemoteControlContractError);
  });

  test('keeps countdown cosmetic while the sidecar remains authoritative', () => {
    const expiry = '2099-08-30T12:05:01.000Z';
    const now = Date.parse('2099-08-30T12:00:00.000Z');
    expect(formatInternetRemoteControlRemaining(expiry, now)).toBe('5:01');
    // 30일 QR을 '719시간 59분'으로 적으면 읽을 수 없어 일 단위 층을 앞에 둔다.
    expect(formatInternetRemoteControlRemaining('2099-08-31T12:00:00.000Z', now)).toBe('1일 0시간');
    expect(isInternetRemoteControlExpired(expiry, now)).toBe(false);
    expect(isInternetRemoteControlExpired(expiry, Date.parse(expiry))).toBe(true);
  });
});

describe('the address the panel offers when the field would be blank', () => {
  const disabled = {
    enabled: false,
    state: 'disabled',
    controllerUrl: null,
    hostExpiresAt: null,
    pairingExpiresAt: null,
    lastRelayContactAt: null,
    sessions: [],
    error: null,
  };

  test('carries an exact HTTPS origin and tolerates its absence', () => {
    expect(normalizeInternetRemoteControlStatusEnvelope({
      status: disabled,
      suggestedControllerOrigin: 'https://portal.example.test',
    })).toEqual({ status: disabled as never, suggestedControllerOrigin: 'https://portal.example.test' });
    // The old shape must keep working: the panel ships with the app, but a
    // stale sidecar can still be the one answering.
    expect(normalizeInternetRemoteControlStatusEnvelope({ status: disabled }).suggestedControllerOrigin).toBeNull();
  });

  test('a bad suggestion is dropped, never fatal — the panel still has to render', () => {
    for (const bad of [
      'http://portal.example.test',
      'https://portal.example.test/remote/',
      'https://portal.example.test?a=1',
      'not a url',
      42,
      null,
    ]) {
      const parsed = normalizeInternetRemoteControlStatusEnvelope({
        status: disabled,
        suggestedControllerOrigin: bad,
      });
      expect(parsed.suggestedControllerOrigin).toBeNull();
      expect(parsed.status.enabled).toBe(false);
    }
  });
});
