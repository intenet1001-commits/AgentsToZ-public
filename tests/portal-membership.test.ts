import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  portalMembershipFailureMessage,
  verifyPortalMembership,
  type PortalMembershipRpcClient,
} from '../src/portalMembership';

function client(data: unknown, error: unknown = null): PortalMembershipRpcClient {
  return { rpc: async name => {
    expect(name).toBe('portmgr_is_member');
    return { data, error };
  } };
}

describe('hosted portal membership authority', () => {
  test('admits only an explicit true from the server-authoritative RPC', async () => {
    expect(await verifyPortalMembership(client(true))).toEqual({ state: 'member' });
    expect(await verifyPortalMembership(client(false))).toEqual({ state: 'denied' });
  });

  test('fails closed on missing RPC, network failure, and malformed responses', async () => {
    expect(await verifyPortalMembership(client(null, {
      code: 'PGRST202',
      message: 'Could not find the function public.portmgr_is_member',
    }))).toEqual({
      state: 'error',
      message: 'Could not find the function public.portmgr_is_member (PGRST202)',
    });
    expect((await verifyPortalMembership(client('true'))).state).toBe('error');
    expect((await verifyPortalMembership({ rpc: async () => { throw new Error('offline'); } })).state).toBe('error');
  });

  test('explains denial separately from an unavailable authority', () => {
    expect(portalMembershipFailureMessage({ state: 'denied' }, 'owner@example.com'))
      .toContain('DB 허용 회원이 아닙니다');
    expect(portalMembershipFailureMessage({ state: 'error', message: 'offline' }))
      .toContain('최신 Supabase 마이그레이션');
  });

  test('both portal shells use the RPC helper without a build-time or cached bypass', () => {
    const main = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
    const remote = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    for (const source of [main, remote]) {
      expect(source).toContain('verifyPortalMembership');
      expect(source).not.toContain('VITE_ALLOWED_EMAIL');
      expect(source).not.toContain('ALLOWED_EMAILS');
      expect(source).not.toContain("localStorage.getItem('portal_google_verified')");
    }
    expect(main).toContain('useState(false)');
    expect(main).toContain("withPortalAuthTimeout(\n          sb.auth.getSession(),\n          'SESSION',");
    expect(main).toContain('clearStoredPortalAuth(window.localStorage)');
    expect(main).toContain('이 기기 로그인 초기화');
    expect(remote).toContain("'verification-error'");
    expect(remote).toContain("supabase.auth.getSession(),\n          'SESSION',");
    expect(remote).toContain('clearStoredPortalAuth(window.localStorage)');
    expect(remote).toContain('이 기기 로그인 초기화');
  });

  test('hosted credentials cannot be replaced through URL params or localStorage', () => {
    const main = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('if (!isLocalWeb())');
    expect(main).toContain('if (isDeployedWeb()) return null;');
    expect(main.indexOf('if (!isLocalWeb())')).toBeLessThan(main.indexOf('localStorage.setItem(PORTAL_WEB_KEY'));
  });
});
