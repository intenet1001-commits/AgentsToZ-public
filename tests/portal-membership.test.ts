import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  authEventCountsAfterSessionFailure,
  isPortalNetworkFailure,
  keepVerifiedThroughFailure,
  sessionReadFailure,
  portalMembershipCardBody,
  portalMembershipFailureMessage,
  verifyPortalMembership,
  type PortalMembershipRpcClient,
} from '../src/portalMembership';
import { PortalAuthRequestTimeoutError } from '../src/portalAuth';

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

// 2026-10-10: an iPhone with Wi‑Fi off was told to check database migrations, and its portal locked
// itself (verification-error stops polling) because auth-js re-emitted SIGNED_IN while offline.
describe('a membership check the network could not answer', () => {
  const offlineFetch = { message: 'TypeError: Load failed', details: '', hint: '', code: '' };

  test('a dropped fetch or a phone with no network is a network error — never membership, never migrations', async () => {
    const network = await verifyPortalMembership(client(null, offlineFetch));
    expect(network).toEqual({ state: 'error', message: 'TypeError: Load failed', network: true });
    const offline = await verifyPortalMembership({ rpc: async () => { throw new Error('anything'); } }, undefined, () => false);
    expect(offline).toMatchObject({ state: 'error', network: true });
    const failed = network as Exclude<typeof network, { state: 'member' }>;
    const text = portalMembershipFailureMessage(failed, '', false);
    expect(text).toContain('네트워크에 연결되지 않아');
    expect(text).not.toContain('마이그레이션');
    // navigator says online but the fetch failed: no 'online' event will come — the page retries on a bounded
    // timer, then 「다시 확인」 is the way; it does not ask to turn Wi‑Fi on.
    const onlineText = portalMembershipFailureMessage(failed, '', true);
    expect(onlineText).toContain('「다시 확인」');
    expect(onlineText).toContain('잠시 뒤 저절로');
    expect(onlineText).not.toContain('Wi‑Fi나 셀룰러 데이터를 켜면');
    expect(onlineText).not.toContain('마이그레이션');
  });

  test('the network cannot turn a real answer into anything else', async () => {
    // Offline or not, false is a denial and true is the only admission.
    expect(await verifyPortalMembership(client(false), undefined, () => false)).toEqual({ state: 'denied' });
    expect(await verifyPortalMembership(client(true), undefined, () => false)).toEqual({ state: 'member' });
    // A missing RPC on a working network keeps the migration advice.
    const missing = await verifyPortalMembership(client(null, { code: 'PGRST202', message: 'Could not find the function' }), undefined, () => true);
    expect(missing).not.toHaveProperty('network');
    expect(portalMembershipFailureMessage(missing as Exclude<typeof missing, { state: 'member' }>)).toContain('마이그레이션');
    expect(isPortalNetworkFailure(new Error('x'), true)).toBe(false);
    expect(isPortalNetworkFailure(new Error('x'), false)).toBe(true);
  });

  test('only an account this page verified survives a network failure — never a denial or another account', () => {
    const network = { state: 'error', message: 'Load failed', network: true } as const;
    expect(keepVerifiedThroughFailure('owner@example.com', 'owner@example.com', network)).toBe(true);
    // A cold load has verified nobody: it must show the network message, not the app.
    expect(keepVerifiedThroughFailure('', 'owner@example.com', network)).toBe(false);
    expect(keepVerifiedThroughFailure('owner@example.com', 'other@example.com', network)).toBe(false);
    expect(keepVerifiedThroughFailure('owner@example.com', 'owner@example.com', { state: 'denied' })).toBe(false);
    expect(keepVerifiedThroughFailure('owner@example.com', 'owner@example.com', { state: 'error', message: 'PGRST202' })).toBe(false);
  });

  test('the portal keeps a verified account through an offline re-check and re-checks when the network returns', () => {
    const remote = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    expect(remote).toContain('if (keepVerifiedThroughFailure(verifiedEmailRef.current, sessionEmail, membership)) {');
    expect(remote).toContain("if (verifiedEmailRef.current !== sessionEmail) setAuthState('checking');");
    expect(remote).toContain("window.addEventListener('online', retry);");
    expect(remote).toContain("data-testid={membershipNetwork ? 'remote-membership-network' : 'remote-membership-error'}");
    // The card's sentence follows the phone's current network, not the one it had when the check failed.
    expect(remote).toContain('portalNetworkFailureMessage(membershipNetworkSubject, phoneOnline)');
  });
});

// Review 2026-10-10: a getSession failure. Ignoring every auth event after it left a signed-in screen after a
// sign-out and a cold load that never noticed the refresh that finally worked; a non-network failure kept the page's
// verified account, so a later network failure brought the app back without reading any session.
describe('a stored-session read that failed', () => {
  test('the network keeps a verified page, shows the network card on a cold load; anything else locks', () => {
    expect(sessionReadFailure('owner@example.com', true)).toBe('keep');
    expect(sessionReadFailure('', true)).toBe('network');
    expect(sessionReadFailure('owner@example.com', false)).toBe('error');
    expect(sessionReadFailure('', false)).toBe('error');
  });

  test('after a network failure every auth event still counts except auth-js\'s INITIAL_SESSION(null)', () => {
    for (const failure of ['keep', 'network'] as const) {
      expect(authEventCountsAfterSessionFailure(failure, 'INITIAL_SESSION', false)).toBe(false);
      expect(authEventCountsAfterSessionFailure(failure, 'SIGNED_OUT', false)).toBe(true);
      expect(authEventCountsAfterSessionFailure(failure, 'SIGNED_IN', true)).toBe(true);
      expect(authEventCountsAfterSessionFailure(failure, 'TOKEN_REFRESHED', true)).toBe(true);
      expect(authEventCountsAfterSessionFailure(failure, 'INITIAL_SESSION', true)).toBe(true);
    }
    // The locked card waits for 「다시 확인」.
    for (const event of ['SIGNED_OUT', 'SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION']) {
      expect(authEventCountsAfterSessionFailure('error', event, true)).toBe(false);
    }
    expect(authEventCountsAfterSessionFailure(null, 'INITIAL_SESSION', false)).toBe(true);
  });

  test('the portal routes both getSession failure branches and the listener through these rules', () => {
    const remote = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    expect(remote.match(/if \(sessionReadFailed\(sessionError\)\) return;/g)).toHaveLength(2);
    expect(remote).toContain('sessionFailure = sessionReadFailure(verifiedEmailRef.current, isPortalNetworkFailure(sessionError));');
    expect(remote).toContain('if (cancelled || !authEventCountsAfterSessionFailure(sessionFailure, event, !!session)) return;');
    // The non-network branch ends what the page verified.
    const failed = remote.slice(remote.indexOf('const sessionReadFailed ='), remote.indexOf('const observeSession ='));
    expect(failed).toContain("verifiedEmailRef.current = '';");
    expect(remote).not.toMatch(/\bstalled\b/);
    // Online-but-failing retries on a bounded timer that survives the effect re-running.
    expect(remote).toContain('if (networkRetriesRef.current >= MEMBERSHIP_NETWORK_RETRIES) { window.clearInterval(timer); return; }');
  });
});

// Production audit 2026-10-16: a membership RPC slower than 10 s on a weak but connected network showed
// 「DB 회원 권한을 확인하지 못했습니다」 twice, 「최신 Supabase 마이그레이션과 네트워크를 확인하세요. (PORTAL_AUTH_MEMBERSHIP_TIMEOUT)」,
// never retried, and threw an already verified page out to the same card on the next SIGNED_IN.
describe('a membership check that did not answer in time', () => {
  test('is the network\'s: the network card, no raw code, no migrations, and a verified page keeps going', async () => {
    const slow = await verifyPortalMembership({ rpc: () => new Promise(() => {}) }, 5, () => true);
    expect(slow).toMatchObject({ state: 'error', network: true });
    const failed = slow as Exclude<typeof slow, { state: 'member' }>;
    for (const online of [true, false]) {
      const text = portalMembershipFailureMessage(failed, '', online);
      expect(text).not.toMatch(/PORTAL_AUTH_|마이그레이션/);
    }
    expect(keepVerifiedThroughFailure('owner@example.com', 'owner@example.com', slow)).toBe(true);
    // A cold load still verified nobody: the network card, never the app.
    expect(keepVerifiedThroughFailure('', 'owner@example.com', slow)).toBe(false);
    expect(isPortalNetworkFailure(new PortalAuthRequestTimeoutError('MEMBERSHIP'), true)).toBe(true);
  });

  test('a stored-session read that hangs keeps its own card: an auth-js lock is not the network, and 「이 기기 로그인 초기화」 is its way out', () => {
    expect(isPortalNetworkFailure(new PortalAuthRequestTimeoutError('SESSION'), true)).toBe(false);
    expect(sessionReadFailure('', isPortalNetworkFailure(new PortalAuthRequestTimeoutError('SESSION'), true))).toBe('error');
  });

  test('a real refusal still locks, and the card says it once with the server\'s words apart', async () => {
    const missing = await verifyPortalMembership(client(null, { code: 'PGRST202', message: 'Could not find the function' }), undefined, () => true);
    expect(missing).not.toHaveProperty('network');
    const body = portalMembershipCardBody(missing as { message: string });
    expect(body.text).not.toContain('DB 회원 권한을 확인하지 못했습니다');
    expect(body.text).toContain('마이그레이션');
    expect(body.text).not.toContain('PGRST202');
    expect(body.detail).toContain('PGRST202');
    expect(await verifyPortalMembership(client(false), undefined, () => true)).toEqual({ state: 'denied' });
  });

  test('the portal shows codes on their own line and asks before clearing the stored login', () => {
    const remote = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    expect(remote).toContain('data-testid="remote-membership-detail"');
    expect(remote).not.toContain('주세요. (${portalAuthErrorMessage(sessionError)})');
    const reset = remote.slice(remote.indexOf('const resetStoredLogin = () => {'), remote.indexOf('const runAction ='));
    expect(reset).toContain('window.confirm(');
    expect(reset.indexOf('window.confirm(')).toBeLessThan(reset.indexOf('clearStoredPortalAuth('));
  });
});

// Review of the 2026-10-16 fixes. (1) A membership timeout is the network's now, and the desktop web portal
// (portal-main.tsx) showed the phone's sentence for it: 「잠시 뒤 저절로 다시 확인합니다 — 계속되면 … 「다시 확인」」 — but
// it has no automatic re-check and its button is 「로그인 상태 다시 확인」. (2) The phone's locked card told a member to
// check Supabase migrations for any server error (a 5xx, an expired JWT), not only for a missing function or schema.
describe('membership copy says only what the screen really does', () => {
  test('the desktop portal names its own button and promises no re-check it does not run', async () => {
    const slow = await verifyPortalMembership({ rpc: () => new Promise(() => {}) }, 5, () => true);
    const dropped = await verifyPortalMembership(client(null, { message: 'TypeError: Load failed', code: '' }), undefined, () => true);
    for (const result of [slow, dropped]) {
      const failed = result as Exclude<typeof result, { state: 'member' }>;
      for (const online of [true, false]) {
        const text = portalMembershipFailureMessage(failed, '', online, 'button');
        expect(text).not.toContain('저절로');
        expect(text).toContain('「로그인 상태 다시 확인」');
        expect(text).not.toMatch(/PORTAL_AUTH_|마이그레이션|「다시 확인」/);
      }
    }
    const main = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
    expect(main).toContain("portalMembershipFailureMessage(membership, email, undefined, 'button')");
    // The button the sentence names is the one the card renders (the same constant).
    expect(main).toContain("'로그인 다시 시도' : PORTAL_RECHECK_BUTTON_LABEL}");
    // The phone keeps its sentence: it does re-check by itself.
    const phone = portalMembershipFailureMessage(slow as Exclude<typeof slow, { state: 'member' }>, '', true);
    expect(phone).toContain('잠시 뒤 저절로');
  });

  test('the phone\'s locked card advises migrations only for a missing function or schema', async () => {
    const card = async (error: { code: string; message: string } | null, data: unknown = null) =>
      portalMembershipCardBody(await verifyPortalMembership(client(data, error), undefined, () => true) as { message: string });
    for (const error of [{ code: 'PGRST202', message: 'Could not find the function public.portmgr_is_member' },
      { code: '42883', message: 'function public.portmgr_is_member() does not exist' },
      { code: 'PGRST205', message: 'Could not find the table' }]) {
      const body = await card(error);
      expect(body.text).toContain('마이그레이션');
      expect(body.detail).toContain(error.code);
    }
    // A function that answers something other than a boolean is an older schema too.
    expect((await card(null, 'yes')).text).toContain('마이그레이션');
    for (const error of [{ code: '', message: 'Internal Server Error' }, { code: '503', message: 'Service Unavailable' },
      { code: 'PGRST301', message: 'JWT expired' }]) {
      const body = await card(error);
      expect(body.text).not.toContain('마이그레이션');
      expect(body.text).toContain('「다시 확인」');
      expect(body.detail).toContain(error.message);
    }
  });
});
