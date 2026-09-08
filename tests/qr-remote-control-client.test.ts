import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { qrRemoteControlApi } from '../src/qrRemoteControlClient';

const clientSource = readFileSync(new URL('../src/qrRemoteControlClient.ts', import.meta.url), 'utf8');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('QR remote-control browser development client', () => {
  test('uses only the dedicated POST management routes and structured request bodies', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ path, method: init?.method ?? 'GET', body });
      const payload = path.endsWith('/interfaces')
        ? { interfaces: [{ address: '192.168.1.12', name: 'Wi-Fi' }] }
        : path.endsWith('/pairing/rotate')
          ? {
              pairingUrl: `http://192.168.1.12:3210/remote/#pair=${'A'.repeat(43)}`,
              expiresAt: '2026-08-30T11:05:00.000Z',
            }
          : path.endsWith('/disable')
            ? { enabled: false }
            : { enabled: true, listener: { host: '192.168.1.12', port: 3210 }, pairing: null, sessions: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await qrRemoteControlApi.status();
    await qrRemoteControlApi.interfaces();
    await qrRemoteControlApi.enable('192.168.1.12');
    await qrRemoteControlApi.rotatePairing();
    await qrRemoteControlApi.revokeSession('session_12345678');
    await qrRemoteControlApi.revokeAllSessions();
    await qrRemoteControlApi.disable();

    expect(calls).toEqual([
      { path: '/api/remote-control/status', method: 'POST', body: {} },
      { path: '/api/remote-control/interfaces', method: 'POST', body: {} },
      { path: '/api/remote-control/enable', method: 'POST', body: { interfaceAddress: '192.168.1.12' } },
      { path: '/api/remote-control/pairing/rotate', method: 'POST', body: {} },
      { path: '/api/remote-control/sessions/revoke', method: 'POST', body: { sessionId: 'session_12345678' } },
      { path: '/api/remote-control/status', method: 'POST', body: {} },
      { path: '/api/remote-control/sessions/revoke', method: 'POST', body: { all: true } },
      { path: '/api/remote-control/status', method: 'POST', body: {} },
      { path: '/api/remote-control/disable', method: 'POST', body: {} },
    ]);
    expect(calls.every(call => !call.path.includes('token=') && !call.path.includes('#pair='))).toBe(true);
  });

  test('preserves server errors instead of converting an unknown state into disabled', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'REMOTE_CONTROL_STATUS_UNAVAILABLE',
      error: '상태를 확인하지 못했습니다.',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    await expect(qrRemoteControlApi.status()).rejects.toMatchObject({
      message: '상태를 확인하지 못했습니다.',
      code: 'REMOTE_CONTROL_STATUS_UNAVAILABLE',
    });
  });
});

describe('installed Tauri management boundary', () => {
  test('uses its own authenticated invoke command without receiving or sharing a capability secret', () => {
    expect(clientSource).toContain("invoke<unknown>('remote_control_management_request'");
    expect(clientSource).toContain("isTauri() && String(import.meta.env.DEV) !== 'true'");
    expect(clientSource).toContain("Vite's same-origin /api proxy");
    expect(clientSource).toContain("method: 'POST'");
    expect(clientSource).not.toContain("invoke<unknown>('what_i_said_management_request'");
    expect(clientSource).not.toContain('/api/what-i-said');
    expect(clientSource).not.toContain('X-AgentsToZ-What-I-Said-Capability');
    expect(clientSource).not.toContain('remote_control_management_capability');
  });
});
