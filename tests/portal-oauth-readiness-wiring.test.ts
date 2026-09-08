import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const portal = readFileSync(join(root, 'src', 'portal-main.tsx'), 'utf8');
const memory = readFileSync(join(root, 'src', 'PortalMemoryDirectory.tsx'), 'utf8');
const remote = readFileSync(join(root, 'src', 'remote-control-portal-main.tsx'), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('recoverable hosted Google login', () => {
  test('main portal proves Auth readiness and validates PKCE before leaving the page', () => {
    const login = between(portal, 'async function handleLogin()', '\n  function resetStoredLogin');
    expect(login).toContain('await preflightPortalGoogleOAuth');
    expect(login).toContain('await createPortalGoogleOAuthUrl');
    expect(login).toContain('window.location.assign(authorizeUrl)');
    expect(login).toContain('portalOAuthStartErrorMessage(loginError)');
  });

  test('remote control preserves both the sealed QR and denied account until Auth is ready', () => {
    const login = between(remote, 'const login = async', '\n  const resetStoredLogin');
    expect(login.indexOf('vaultRef.current?.seal')).toBeLessThan(login.indexOf('await preflightPortalGoogleOAuth'));
    expect(login.indexOf('await preflightPortalGoogleOAuth')).toBeLessThan(login.indexOf("supabase.auth.signOut({ scope: 'local' })"));
    expect(login).toContain('await createPortalGoogleOAuthUrl');
    expect(login).toContain('window.location.assign(authorizeUrl)');
  });

  test('memory-directory retry cannot start overlapping PKCE flows', () => {
    const login = between(memory, 'const signIn = async', '\n\n  useEffect(() => { void load();');
    expect(login).toContain('if (!requiresUserSession || loginBusy) return');
    expect(login).toContain('await preflightPortalGoogleOAuth');
    expect(login).toContain('await createPortalGoogleOAuthUrl');
    expect(memory).toContain('disabled={loginBusy}');
  });
});
