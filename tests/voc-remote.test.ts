import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRemoteVocAccess,
  configuredVocEndpoint,
  normalizeVocEndpoint,
  OFFICIAL_VOC_ENDPOINT,
  readOrCreateVocInstallationId,
  submitRemoteVoc,
  updateVocAdminSettings,
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
    expect(configuredVocEndpoint({})).toBe(OFFICIAL_VOC_ENDPOINT);
    expect(configuredVocEndpoint({ VITE_VOC_ENDPOINT: 'off' })).toBeNull();
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
});

describe('public VOC security contracts', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20260820010000_public_voc_inbox.sql', import.meta.url), 'utf8');
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
});
