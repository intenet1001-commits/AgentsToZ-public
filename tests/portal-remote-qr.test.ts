import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  buildRemoteControlRelayPairingUrl,
  encodeRemoteControlRelayBase64Url,
} from '../src/remoteControlRelayContract';
import { PortalRemoteQrError, normalizePortalRemoteQr } from '../src/portalRemoteQr';

const portalOrigin = 'https://example-portal.vercel.app';

function encoded(length: number, firstByte = 0): string {
  const bytes = new Uint8Array(length);
  bytes[0] = firstByte;
  for (let index = 1; index < bytes.length; index += 1) bytes[index] = index & 0xff;
  return encodeRemoteControlRelayBase64Url(bytes);
}

function pairingUrl(origin = portalOrigin, expiresAt = '2099-08-31T12:34:56.789Z'): string {
  return buildRemoteControlRelayPairingUrl(`${origin}/remote/`, {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    hostId: 'host_123456789012',
    pairingId: 'pairing_123456789',
    pairingSecret: encoded(32),
    hostPublicKey: encoded(65, 0x04),
    expiresAt,
  });
}

describe('portal PWA remote-control QR intake', () => {
  test('keeps a valid same-origin one-use QR intact for the in-app /remote/ handoff', () => {
    const value = pairingUrl();
    expect(normalizePortalRemoteQr(`\n${value}\n`, portalOrigin, Date.parse('2026-08-31T00:00:00.000Z'))).toBe(value);
  });

  test('rejects arbitrary links, malformed payloads, and another personal deployment', () => {
    for (const value of [
      'https://example.com/',
      `${portalOrigin}/remote/#pair=not-a-bootstrap`,
      pairingUrl('https://another-portal.example'),
    ]) {
      expect(() => normalizePortalRemoteQr(value, portalOrigin)).toThrow(PortalRemoteQrError);
    }
    try {
      normalizePortalRemoteQr(pairingUrl('https://another-portal.example'), portalOrigin);
    } catch (error) {
      expect(error).toBeInstanceOf(PortalRemoteQrError);
      expect((error as PortalRemoteQrError).failure).toBe('WRONG_PORTAL');
    }
  });

  test('rejects an expired QR before navigation and bounds scanner input', () => {
    expect(() => normalizePortalRemoteQr(
      pairingUrl(portalOrigin, '2026-08-31T00:04:59.999Z'),
      portalOrigin,
      Date.parse('2026-08-31T00:05:00.000Z'),
    )).toThrow('만료');
    expect(() => normalizePortalRemoteQr('x'.repeat(4097), portalOrigin)).toThrow('크기');
    expect(() => normalizePortalRemoteQr('   ', portalOrigin)).toThrow('연결 주소');
  });

  test('allows camera and local photo blobs only on the signed-in portal shell', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const header = (source: string, key: string) => config.headers
      .find(entry => entry.source === source)?.headers
      .find(entry => entry.key.toLowerCase() === key.toLowerCase())?.value ?? '';

    expect(header('/(.*)', 'Permissions-Policy')).toContain('camera=(self)');
    expect(header('/(.*)', 'Content-Security-Policy')).toContain("img-src 'self' data: blob: https://www.google.com");
    expect(header('/remote/(.*)', 'Permissions-Policy')).toContain('camera=()');
  });
});
