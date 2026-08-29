import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRemoteVocAccess,
  configuredVocEndpoint,
  isVocReceiverProject,
  normalizeVocEndpoint,
  readOrCreateVocInstallationId,
  submitRemoteVoc,
  submitUnlimitedVoc,
  updateVocAdminSettings,
  verifyVocAdminContext,
} from '../voc-remote';

const roots: string[] = [];
const endpoint = 'https://example-ref.supabase.co/functions/v1/submit-voc';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-voc-'));
  roots.push(root);
  return root;
};

describe('public VOC receiver boundary', () => {
  test('accepts only the exact HTTPS Supabase Edge Function URL', () => {
    expect(normalizeVocEndpoint(endpoint)).toBe(endpoint);
    expect(normalizeVocEndpoint(`${endpoint}/`)).toBe(endpoint);
    expect(normalizeVocEndpoint('http://example-ref.supabase.co/functions/v1/submit-voc')).toBeNull();
    expect(normalizeVocEndpoint('https://evil.example/functions/v1/submit-voc')).toBeNull();
    expect(normalizeVocEndpoint(`${endpoint}?redirect=https://evil.example`)).toBeNull();
    expect(configuredVocEndpoint({ VITE_VOC_ENDPOINT: endpoint })).toBe(endpoint);
    expect(configuredVocEndpoint({ AGENTSTOZ_VOC_ENDPOINT: endpoint })).toBe(endpoint);
    expect(configuredVocEndpoint({})).toBeNull();
    expect(configuredVocEndpoint({ VITE_VOC_ENDPOINT: 'off' })).toBeNull();
  });

  test('does not call a remote receiver when no endpoint is explicitly configured', async () => {
    const root = tempRoot();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ accepted: true });
    }) as unknown as typeof fetch;
    const result = await submitRemoteVoc({
      appDataDir: root,
      env: {},
      fetchImpl,
      record: {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        appVersion: 'v208',
        tab: 'ports',
        anchor: { tag: 'button', text: '저장', path: [] },
        comment: '로컬 전용',
        status: 'open',
      },
    });
    expect(result).toEqual({ status: 'unconfigured' });
    expect(calls).toBe(0);
  });

  test('creates one private installation identity and reuses it', () => {
    const root = tempRoot();
    const first = readOrCreateVocInstallationId(root);
    const second = readOrCreateVocInstallationId(root);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'voc-installation.json')).mode & 0o777).toBe(0o600);
    }
  });

  test('submits only the installation id and bounded VOC record to the public endpoint', async () => {
    const root = tempRoot();
    let sent: any = null;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ accepted: true, dailyLimit: 10, remaining: 9 }), { status: 201 });
    }) as typeof fetch;
    const result = await submitRemoteVoc({
      appDataDir: root,
      env: { VITE_VOC_ENDPOINT: endpoint },
      fetchImpl,
      record: {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        appVersion: 'v208',
        tab: 'ports',
        anchor: { tag: 'button', text: '저장', path: [] },
        comment: '개선 요청',
        status: 'open',
      },
    });
    expect(result).toEqual({ status: 'sent', dailyLimit: 10, remaining: 9 });
    expect(sent.installationId).toBe(readOrCreateVocInstallationId(root));
    expect(sent.record.comment).toBe('개선 요청');
    expect(JSON.stringify(sent)).not.toContain('serviceRole');
  });

  test('access check is explicit and preserves app/voc scope', async () => {
    const root = tempRoot();
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.action).toBe('check');
      return Response.json({ blocked: true, scope: 'app', expiresAt: '2026-09-01T00:00:00.000Z' });
    }) as typeof fetch;
    await expect(checkRemoteVocAccess({
      appDataDir: root,
      env: { VITE_VOC_ENDPOINT: endpoint },
      fetchImpl,
    })).resolves.toEqual({
      configured: true,
      blocked: true,
      scope: 'app',
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
  });

  test('administrator daily limit remains bounded to 1..100', async () => {
    const fetchImpl = (async () => Response.json([{ accepting: true, daily_device_limit: 25 }])) as unknown as typeof fetch;
    await expect(updateVocAdminSettings({
      serviceRoleKey: 'server-only', accepting: true, dailyLimit: 0,
      env: { VITE_VOC_ENDPOINT: endpoint }, fetchImpl,
    })).rejects.toThrow('1~100');
    await expect(updateVocAdminSettings({
      serviceRoleKey: 'server-only', accepting: true, dailyLimit: 101,
      env: { VITE_VOC_ENDPOINT: endpoint }, fetchImpl,
    })).rejects.toThrow('1~100');
  });

  test('unlimited identity requires the exact receiver Supabase project', () => {
    const env = { VITE_VOC_ENDPOINT: endpoint };
    expect(isVocReceiverProject('https://example-ref.supabase.co', env)).toBeTrue();
    expect(isVocReceiverProject('https://other-ref.supabase.co', env)).toBeFalse();
    expect(isVocReceiverProject('https://example-ref.supabase.co.evil.example', env)).toBeFalse();
    expect(isVocReceiverProject('https://example-ref.supabase.co/rest/v1', env)).toBeFalse();
  });

  test('administrator context also proves the receiver service-role access', async () => {
    const env = { VITE_VOC_ENDPOINT: endpoint };
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls += 1;
      expect(String(url)).toContain('/rest/v1/portmgr_voc_settings');
      return Response.json([{ accepting: true, daily_device_limit: 10 }]);
    }) as typeof fetch;
    await expect(verifyVocAdminContext({
      portalSupabaseUrl: 'https://example-ref.supabase.co',
      serviceRoleKey: 'receiver-service-role',
      env,
      fetchImpl,
    })).resolves.toBeTrue();
    await expect(verifyVocAdminContext({
      portalSupabaseUrl: 'https://other-ref.supabase.co',
      serviceRoleKey: 'receiver-service-role',
      env,
      fetchImpl,
    })).resolves.toBeFalse();
    expect(calls).toBe(1);
  });

  test('verified local administrator submits through the service-role-only unlimited RPC', async () => {
    const root = tempRoot();
    let calledUrl = '';
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      sent = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBe('receiver-service-role');
      expect(headers.get('authorization')).toBe('Bearer receiver-service-role');
      return Response.json([{ accepted: true, reason: null }]);
    }) as typeof fetch;
    const result = await submitUnlimitedVoc({
      appDataDir: root,
      serviceRoleKey: 'receiver-service-role',
      env: { VITE_VOC_ENDPOINT: endpoint },
      fetchImpl,
      record: {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        appVersion: 'v242',
        tab: 'ports',
        anchor: { tag: 'button', text: 'VOC', path: [] },
        comment: '관리자 개선 요청',
        status: 'open',
      },
    });
    expect(result).toEqual({ status: 'sent', unlimited: true });
    expect(calledUrl).toBe('https://example-ref.supabase.co/rest/v1/rpc/portmgr_submit_voc_admin');
    expect(sent.p_device_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).not.toHaveProperty('installationId');
  });
});

describe('public VOC security contracts', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20260820010000_public_voc_inbox.sql', import.meta.url), 'utf8');
  const adminMigration = readFileSync(new URL('../supabase/migrations/20260824030000_voc_receiver_admin_unlimited.sql', import.meta.url), 'utf8');
  const edge = readFileSync(new URL('../supabase/functions/submit-voc/index.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');

  test('rate limit increment and inbox insert are one database function', () => {
    expect(migration).toContain('create or replace function public.portmgr_submit_voc');
    expect(migration).toContain('submission_count < v_daily_limit');
    expect(migration).toContain('insert into public.portmgr_voc_inbox');
  });

  test('all VOC tables and RPCs deny public, anon, and authenticated clients', () => {
    expect(migration).toContain('revoke all privileges on table public.portmgr_voc_inbox from public, anon, authenticated');
    expect(migration).toContain('revoke all on function public.portmgr_submit_voc');
    expect(migration).toContain('to service_role');
  });

  test('administrator RPC bypasses only the daily counter and remains service-role-only', () => {
    expect(adminMigration).toContain('create or replace function public.portmgr_submit_voc_admin');
    expect(adminMigration).toContain('insert into public.portmgr_voc_inbox');
    expect(adminMigration).not.toContain('insert into public.portmgr_voc_daily_usage');
    expect(adminMigration).toContain('from public, anon, authenticated');
    expect(adminMigration).toContain('to service_role');
  });

  test('edge receiver hashes installation id and never returns the hash', () => {
    expect(edge).toContain("crypto.subtle.digest('SHA-256'");
    expect(edge).toContain('p_device_hash: deviceHash');
    expect(edge).not.toContain('deviceHash,\n    dailyLimit');
  });

  test('app blocking is explicit and fail-open on access-check failure', () => {
    expect(app).toContain('setVocAppBlock(null)');
    expect(app).toContain('data-testid="voc-app-blocked"');
    expect(settings).toContain('VOC 전송만 차단');
    expect(settings).toContain('앱 사용 차단');
  });

  test('app exposes verified unlimited status without removing the repeat-copy action', () => {
    expect(app).toContain("data.identity === 'receiver_admin'");
    expect(app).toContain('관리자 VOC로 전송했습니다 · 한도 없음');
    const overlay = readFileSync(new URL('../src/voc/VocOverlay.tsx', import.meta.url), 'utf8');
    expect(overlay).toContain('관리자 전송 · 한도 없음');
    expect(overlay).toContain('data-testid="voc-copy-prompt"');
  });
});
