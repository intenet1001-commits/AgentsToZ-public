import { describe, expect, test } from 'bun:test';
import {
  REMOTE_CONTROL_RELAY_AAD_DOMAIN,
  REMOTE_CONTROL_RELAY_MAX_ENVELOPE_BYTES,
  REMOTE_CONTROL_RELAY_PAIRING_TTL_MS,
  REMOTE_CONTROL_RELAY_PROTOCOL_VERSION,
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  RemoteControlRelayContractError,
  acceptRemoteControlRelayEnvelope,
  buildRemoteControlRelayPairingUrl,
  canonicalRemoteControlRelayAadText,
  createRemoteControlRelayReceiveCursor,
  decodeRemoteControlRelayBase64Url,
  encodeRemoteControlRelayBase64Url,
  isRemoteControlRelayExpired,
  parseRemoteControlRelayEnvelope,
  parseRemoteControlRelayEnvelopeJson,
  parseRemoteControlRelayPairingUrl,
  serializeRemoteControlRelayEnvelope,
  type RemoteControlRelayEnvelope,
  type RemoteControlRelayPairingBootstrap,
} from '../src/remoteControlRelayContract';

const future = '2099-08-30T12:34:56.789Z';

function encoded(length: number, firstByte = 0): string {
  const bytes = new Uint8Array(length);
  bytes[0] = firstByte;
  for (let index = 1; index < bytes.length; index += 1) bytes[index] = index & 0xff;
  return encodeRemoteControlRelayBase64Url(bytes);
}

function envelope(overrides: Partial<RemoteControlRelayEnvelope> = {}): RemoteControlRelayEnvelope {
  return {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    messageId: 'message_123456789',
    sessionId: 'session_123456789',
    controllerId: 'controller_123456',
    sequence: 1,
    expiresAt: future,
    nonce: encoded(12),
    ciphertext: encoded(16),
    ...overrides,
  };
}

function bootstrap(overrides: Partial<RemoteControlRelayPairingBootstrap> = {}): RemoteControlRelayPairingBootstrap {
  return {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    hostId: 'host_123456789012',
    pairingId: 'pairing_123456789',
    pairingSecret: encoded(32),
    hostPublicKey: encoded(65, 0x04),
    expiresAt: future,
    ...overrides,
  };
}

describe('external remote-control relay envelope contract', () => {
  test('uses one exact relay-visible v1 shape and a stable canonical AAD', () => {
    const parsed = parseRemoteControlRelayEnvelope(envelope());
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion', 'messageId', 'sessionId', 'controllerId',
      'sequence', 'expiresAt', 'nonce', 'ciphertext',
    ]);
    expect(REMOTE_CONTROL_RELAY_PROTOCOL_VERSION).toBe('agentstoz-relay-v1');
    expect(canonicalRemoteControlRelayAadText(parsed)).toBe(
      `${REMOTE_CONTROL_RELAY_AAD_DOMAIN}\n`
      + '{"schemaVersion":1,"messageId":"message_123456789","sessionId":"session_123456789",'
      + '"controllerId":"controller_123456","sequence":1,"expiresAt":"2099-08-30T12:34:56.789Z"}',
    );
    expect(serializeRemoteControlRelayEnvelope(parsed)).toBe(
      '{"schemaVersion":1,"messageId":"message_123456789","sessionId":"session_123456789",'
      + '"controllerId":"controller_123456","sequence":1,"expiresAt":"2099-08-30T12:34:56.789Z",'
      + `"nonce":"${encoded(12)}","ciphertext":"${encoded(16)}"}`,
    );
  });

  test('never permits plaintext project, action, path, command, key, or token fields at the relay boundary', () => {
    for (const field of [
      'action', 'project', 'projectName', 'controlId', 'folderPath', 'command',
      'sessionToken', 'pairingSecret', 'privateKey',
    ]) {
      expect(() => parseRemoteControlRelayEnvelope({
        ...envelope(),
        [field]: 'must-remain-inside-ciphertext',
      })).toThrow(RemoteControlRelayContractError);
    }
    const serialized = serializeRemoteControlRelayEnvelope(envelope());
    expect(serialized).not.toContain('start');
    expect(serialized).not.toContain('folderPath');
    expect(serialized).not.toContain('sessionToken');
  });

  test('rejects schema drift, ambiguous values, malformed AEAD fields, and non-canonical dates', () => {
    const malformed: unknown[] = [
      { ...envelope(), schemaVersion: 2 },
      { ...envelope(), messageId: 'short' },
      { ...envelope(), sessionId: ' session_123456789' },
      { ...envelope(), sequence: 0 },
      { ...envelope(), sequence: 1.5 },
      { ...envelope(), sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...envelope(), expiresAt: '2099-08-30T12:34:56Z' },
      { ...envelope(), nonce: encoded(11) },
      { ...envelope(), ciphertext: encoded(15) },
      // 16 decoded bytes, but non-zero unused trailing bits make this non-canonical.
      { ...envelope(), ciphertext: `${'A'.repeat(21)}B` },
      { ...envelope(), nonce: `${encoded(12)}=` },
      { ...envelope(), ciphertext: 'not+base64' },
    ];
    for (const value of malformed) {
      expect(() => parseRemoteControlRelayEnvelope(value)).toThrow(RemoteControlRelayContractError);
    }
  });

  test('enforces the 16KiB bound before JSON parsing and after object normalization', () => {
    const canonical = serializeRemoteControlRelayEnvelope(envelope());
    expect(parseRemoteControlRelayEnvelopeJson(` \n${canonical}\n `)).toEqual(envelope());
    expect(() => parseRemoteControlRelayEnvelopeJson(
      `${' '.repeat(REMOTE_CONTROL_RELAY_MAX_ENVELOPE_BYTES)}${canonical}`,
    )).toThrow(RemoteControlRelayContractError);
    expect(() => parseRemoteControlRelayEnvelope({
      ...envelope(),
      ciphertext: 'A'.repeat(REMOTE_CONTROL_RELAY_MAX_ENVELOPE_BYTES),
    })).toThrow(RemoteControlRelayContractError);
    expect(() => parseRemoteControlRelayEnvelopeJson('{bad json')).toThrow(RemoteControlRelayContractError);
  });

  test('base64url helpers accept only a canonical unpadded representation', () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const value = encodeRemoteControlRelayBase64Url(bytes);
    expect(value).toBe('AAEC_f7_');
    expect(decodeRemoteControlRelayBase64Url(value)).toEqual(bytes);
    for (const malformed of ['', 'A', 'AA=', 'AA+/', 'AB']) {
      expect(() => decodeRemoteControlRelayBase64Url(malformed)).toThrow(RemoteControlRelayContractError);
    }
  });
});

describe('fragment-only one-use pairing bootstrap', () => {
  test('keeps the one-use bootstrap valid for one full day', () => {
    expect(REMOTE_CONTROL_RELAY_PAIRING_TTL_MS).toBe(30 * 24 * 60 * 60_000);
  });

  test('keeps host routing, secret, and public key entirely out of the HTTPS request URL', () => {
    const value = bootstrap();
    const pairingUrl = buildRemoteControlRelayPairingUrl('https://controller.example/remote/', value);
    const requestUrl = pairingUrl.split('#')[0]!;
    expect(requestUrl).toBe('https://controller.example/remote/');
    expect(requestUrl).not.toContain(value.pairingSecret);
    expect(requestUrl).not.toContain(value.hostPublicKey);
    expect(new URL(pairingUrl).search).toBe('');
    expect(new URL(pairingUrl).hash.startsWith('#pair=')).toBe(true);
    expect(parseRemoteControlRelayPairingUrl(pairingUrl)).toEqual({
      controllerUrl: 'https://controller.example/remote/',
      bootstrap: value,
    });
  });

  test('rejects non-HTTPS, credentials, query secrets, wrong routes, extra fragments, and malformed key material', () => {
    for (const url of [
      'http://controller.example/remote/',
      'https://user:pass@controller.example/remote/',
      'https://controller.example/remote/?token=secret',
      'https://controller.example/other/',
      'javascript:alert(1)',
    ]) {
      expect(() => buildRemoteControlRelayPairingUrl(url, bootstrap())).toThrow(RemoteControlRelayContractError);
    }
    expect(() => buildRemoteControlRelayPairingUrl(
      'https://controller.example/remote/',
      bootstrap({ pairingSecret: encoded(31) }),
    )).toThrow(RemoteControlRelayContractError);
    expect(() => buildRemoteControlRelayPairingUrl(
      'https://controller.example/remote/',
      bootstrap({ hostPublicKey: encoded(64, 0x04) }),
    )).toThrow(RemoteControlRelayContractError);

    const valid = buildRemoteControlRelayPairingUrl('https://controller.example/remote/', bootstrap());
    expect(() => parseRemoteControlRelayPairingUrl(`${valid}&token=second`)).toThrow(RemoteControlRelayContractError);
  });
});

describe('pure expiry, replay, and contiguous sequence fence', () => {
  test('advances immutably once and rejects replay, stale, gap, cross-session, and expired delivery', () => {
    const now = Date.parse('2099-08-30T12:00:00.000Z');
    const initial = createRemoteControlRelayReceiveCursor('session_123456789', 'controller_123456');
    const first = acceptRemoteControlRelayEnvelope(envelope(), initial, now);
    expect(first.ok).toBe(true);
    expect(initial).toEqual({
      sessionId: 'session_123456789',
      controllerId: 'controller_123456',
      highestSequence: 0,
      recentMessageIds: [],
    });
    if (!first.ok) throw new Error('expected first relay delivery to pass');
    expect(first.cursor.highestSequence).toBe(1);
    expect(acceptRemoteControlRelayEnvelope(envelope(), first.cursor, now))
      .toEqual({ ok: false, reason: 'message-replay' });
    expect(acceptRemoteControlRelayEnvelope(envelope({ messageId: 'message_987654321' }), first.cursor, now))
      .toEqual({ ok: false, reason: 'stale-sequence' });
    expect(acceptRemoteControlRelayEnvelope(envelope({ messageId: 'message_222222222', sequence: 3 }), first.cursor, now))
      .toEqual({ ok: false, reason: 'sequence-gap' });
    expect(acceptRemoteControlRelayEnvelope(envelope({
      messageId: 'message_333333333', sessionId: 'other_session_1234', sequence: 2,
    }), first.cursor, now)).toEqual({ ok: false, reason: 'identity-mismatch' });
    expect(acceptRemoteControlRelayEnvelope(envelope({
      messageId: 'message_444444444', sequence: 2, expiresAt: '2099-08-30T12:00:00.000Z',
    }), first.cursor, now)).toEqual({ ok: false, reason: 'expired' });
    expect(isRemoteControlRelayExpired(envelope(), now)).toBe(false);
  });
});
