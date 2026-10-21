import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { portalForeignPairing, PORTAL_FOREIGN_PAIRING_TITLE } from '../src/portalForeignPairing';
import { buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const key = new Uint8Array(65); key[0] = 4;
const PAGE = 'https://portal.example.com';
const fragment = (supabaseUrl: string | null) => new URL(buildRemoteControlRelayPairingUrl(`${PAGE}/remote/`, {
  schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: 'host_abcdefghijklmnop', pairingId: 'pair_abcdefghijklmnop',
  pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey: Buffer.from(key).toString('base64url'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...(supabaseUrl ? { supabase: { url: supabaseUrl, anonKey: anon } } : {}),
})).hash.slice(1);
const OWN = 'https://own-project.supabase.co';
const OTHER = 'https://friend-project.supabase.co';
const check = (frag: string, extra: Partial<Parameters<typeof portalForeignPairing>[0]> = {}) =>
  portalForeignPairing({ fragment: frag, isBundled: false, portalSupabaseUrl: OWN, pageOrigin: PAGE, ...extra });

describe('web portal refuses a QR for another Supabase project', () => {
  test('foreign project → guard page', () => {
    expect(check(fragment(OTHER))).toEqual({ qrSupabaseUrl: OTHER });
  });
  test('same project (even with a trailing slash in the build value) → normal page', () => {
    expect(check(fragment(OWN))).toBeNull();
    expect(check(fragment(OWN), { portalSupabaseUrl: `${OWN}/` })).toBeNull();
  });
  test('older QR without supabase, no fragment, garbage, or the bundled app portal → today\'s behaviour', () => {
    expect(check(fragment(null))).toBeNull();
    expect(check('')).toBeNull();
    expect(check('pair=@@@')).toBeNull();
    expect(check(fragment(OTHER), { isBundled: true })).toBeNull();
  });
  test('the /remote/ page renders the guard instead of the app, before any client work', () => {
    const main = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('root.render(FOREIGN_PAIRING');
    expect(main).toContain('<ForeignPairingPage qrSupabaseUrl={FOREIGN_PAIRING.qrSupabaseUrl} />');
    expect(main).toContain('isBundled: PORTAL_IS_BUNDLED');
    expect(PORTAL_FOREIGN_PAIRING_TITLE).toBe('이 QR은 다른 사용자의 AgentsToZ(자기 Supabase)용입니다. iPhone의 AgentsToZ 앱으로 스캔하세요.');
  });
});
