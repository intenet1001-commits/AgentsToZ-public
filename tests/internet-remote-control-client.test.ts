import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { internetRemoteControlApi } from '../src/internetRemoteControlClient';
import type { InternetRemoteControlStatus } from '../src/internetRemoteControlContract';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  buildRemoteControlRelayPairingUrl,
  encodeRemoteControlRelayBase64Url,
} from '../src/remoteControlRelayContract';

const source = readFileSync(new URL('../src/internetRemoteControlClient.ts', import.meta.url), 'utf8');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const encoded = (length: number, first = 0) => encodeRemoteControlRelayBase64Url(
  Uint8Array.from({ length }, (_, index) => index === 0 ? first : index & 0xff),
);

function status(overrides: Partial<InternetRemoteControlStatus> = {}): InternetRemoteControlStatus {
  return {
    enabled: true,
    state: 'pairing',
    controllerUrl: 'https://controller.example/remote/',
    hostExpiresAt: '2099-08-30T12:30:00.000Z',
    pairingExpiresAt: '2099-08-30T12:05:00.000Z',
    lastRelayContactAt: '2099-08-30T12:00:00.000Z',
    sessions: [],
    error: null,
    ...overrides,
  };
}

function pairingUrl(): string {
  return buildRemoteControlRelayPairingUrl('https://controller.example/remote/', {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    hostId: 'host_123456789012',
    pairingId: 'pairing_123456789',
    pairingSecret: encoded(32),
    hostPublicKey: encoded(65, 0x04),
    expiresAt: '2099-08-30T12:05:00.000Z',
  });
}

describe('external internet QR sidecar client', () => {
  test('calls only exact POST management routes and exact structured bodies', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ path, method: init?.method ?? 'GET', body });
      const responseStatus = path.endsWith('/disable')
        ? status({
            enabled: false,
            state: 'disabled',
            controllerUrl: null,
            hostExpiresAt: null,
            pairingExpiresAt: null,
            sessions: [],
          })
        : path.endsWith('/sessions/approve')
          ? status({ state: 'online' })
          : status();
      const payload = path.endsWith('/enable')
        ? {
            status: responseStatus,
            pairing: { pairingUrl: pairingUrl(), expiresAt: '2099-08-30T12:05:00.000Z' },
          }
        : { status: responseStatus };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await internetRemoteControlApi.status();
    await internetRemoteControlApi.enable('https://controller.example/');
    await internetRemoteControlApi.approveSession('22222222-2222-4222-8222-222222222222', '314159', true);
    await internetRemoteControlApi.updateSessionScopes('22222222-2222-4222-8222-222222222222', false, true);
    await internetRemoteControlApi.revokeSession('22222222-2222-4222-8222-222222222222');
    await internetRemoteControlApi.disable();

    expect(calls).toEqual([
      { path: '/api/remote-control/internet/status', method: 'POST', body: {} },
      { path: '/api/remote-control/internet/enable', method: 'POST', body: { controllerOrigin: 'https://controller.example' } },
      { path: '/api/remote-control/internet/sessions/approve', method: 'POST', body: { sessionId: '22222222-2222-4222-8222-222222222222', expectedSasCode: '314159', grantTaskScope: true, grantConversationScope: false } },
      { path: '/api/remote-control/internet/sessions/scopes', method: 'POST', body: { sessionId: '22222222-2222-4222-8222-222222222222', grantTaskScope: false, grantConversationScope: true } },
      { path: '/api/remote-control/internet/sessions/revoke', method: 'POST', body: { sessionId: '22222222-2222-4222-8222-222222222222' } },
      { path: '/api/remote-control/internet/disable', method: 'POST', body: {} },
    ]);
    expect(calls.every(call => !call.path.includes('?') && !call.path.includes('#'))).toBe(true);
  });

  test('rejects a non-origin or malformed approval before contacting the sidecar', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    await expect(internetRemoteControlApi.enable('https://controller.example/remote/')).rejects.toThrow();
    await expect(internetRemoteControlApi.approveSession('22222222-2222-4222-8222-222222222222', '12345', false)).rejects.toThrow();
    await expect(internetRemoteControlApi.updateSessionScopes('short', true, false)).rejects.toThrow();
    await expect(internetRemoteControlApi.updateSessionScopes('22222222-2222-4222-8222-222222222222', true, 'yes' as never)).rejects.toThrow();
    await expect(internetRemoteControlApi.revokeSession('short')).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('preserves sanitized server errors instead of fabricating a disabled state', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'INTERNET_REMOTE_UNAVAILABLE',
      error: '암호화 릴레이에 연결하지 못했습니다.',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    await expect(internetRemoteControlApi.status()).rejects.toMatchObject({
      code: 'INTERNET_REMOTE_UNAVAILABLE',
      message: '암호화 릴레이에 연결하지 못했습니다.',
    });
  });
});

describe('installed app management boundary', () => {
  test('uses the dedicated remote-control sidecar command without storing secrets or sharing What I Said', () => {
    expect(source).toContain("invoke<unknown>('remote_control_management_request'");
    expect(source).toContain("isTauri() && String(import.meta.env.DEV) !== 'true'");
    expect(source).toContain("development uses Vite's same-origin /api proxy");
    expect(source).toContain("method: 'POST'");
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).not.toContain('what_i_said_management_request');
    expect(source).not.toContain('/api/what-i-said');
    expect(source).not.toContain('service_role');
    expect(source).not.toContain('hostSecret');
    expect(source).not.toContain('pairingSecret');
  });
});
