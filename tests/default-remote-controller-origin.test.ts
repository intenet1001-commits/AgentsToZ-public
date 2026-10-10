import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_REMOTE_CONTROLLER_ORIGIN,
  isDefaultRemoteControllerOrigin,
  resolveRemoteControllerOrigin,
} from '../src/defaultRemoteControllerOrigin';
import { buildPhoneConnectLink, parsePhoneConnectLink } from '../src/phoneConnectLink';
import { buildRemoteControlRelayPairingUrl, parseRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract';

const root = join(import.meta.dir, '..');
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const key = new Uint8Array(65); key[0] = 4;
const pairingUrl = (supabaseUrl: string) => buildRemoteControlRelayPairingUrl(`${DEFAULT_REMOTE_CONTROLLER_ORIGIN}/remote/`, {
  schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: 'host_abcdefghijklmnop', pairingId: 'pair_abcdefghijklmnop',
  pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey: Buffer.from(key).toString('base64url'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), supabase: { url: supabaseUrl, anonKey: anon },
});

describe('default remote controller origin (앱으로만 원격제어)', () => {
  test('is one exact public HTTPS origin', () => {
    // The value differs between the private build and the public snapshot (scripts/publish.ts),
    // so only its shape is fixed here.
    expect(new URL(DEFAULT_REMOTE_CONTROLLER_ORIGIN).protocol).toBe('https:');
    expect(new URL(DEFAULT_REMOTE_CONTROLLER_ORIGIN).origin).toBe(DEFAULT_REMOTE_CONTROLLER_ORIGIN);
    expect(isDefaultRemoteControllerOrigin(DEFAULT_REMOTE_CONTROLLER_ORIGIN)).toBe(true);
    expect(isDefaultRemoteControllerOrigin(`${DEFAULT_REMOTE_CONTROLLER_ORIGIN}/`)).toBe(true);
    expect(isDefaultRemoteControllerOrigin('https://my-portal.vercel.app')).toBe(false);
    expect(isDefaultRemoteControllerOrigin(null)).toBe(false);
  });

  test('enable resolves: typed → configured portal → public default; invalid typed stays invalid', () => {
    expect(resolveRemoteControllerOrigin(undefined, null)).toBe(DEFAULT_REMOTE_CONTROLLER_ORIGIN);
    expect(resolveRemoteControllerOrigin('', null)).toBe(DEFAULT_REMOTE_CONTROLLER_ORIGIN);
    expect(resolveRemoteControllerOrigin('   ', null)).toBe(DEFAULT_REMOTE_CONTROLLER_ORIGIN);
    expect(resolveRemoteControllerOrigin(null, 'https://mine.example')).toBe('https://mine.example');
    expect(resolveRemoteControllerOrigin('https://typed.example/', 'https://mine.example')).toBe('https://typed.example');
    // A supplied but malformed value is rejected, never silently swapped for the default.
    expect(resolveRemoteControllerOrigin('http://typed.example', null)).toBeNull();
    expect(resolveRemoteControllerOrigin('https://typed.example/remote/', null)).toBeNull();
    expect(resolveRemoteControllerOrigin(42, null)).toBeNull();
  });

  test('two Macs on the same default origin still carry their own Supabase in QR and link', () => {
    for (const supabaseUrl of ['https://project-a.supabase.co', 'https://project-b.supabase.co']) {
      const parsed = parseRemoteControlRelayPairingUrl(pairingUrl(supabaseUrl));
      expect(new URL(parsed.controllerUrl).origin).toBe(DEFAULT_REMOTE_CONTROLLER_ORIGIN);
      expect(parsed.bootstrap.supabase?.url).toBe(supabaseUrl);
      const link = parsePhoneConnectLink(buildPhoneConnectLink({
        portalOrigin: new URL(parsed.controllerUrl).origin, supabaseUrl, anonKey: anon, hostName: 'Mac',
      }));
      // The bundled portal's portalOrigin/store key is the default for both; the project comes from the link.
      expect(link.portalOrigin).toBe(DEFAULT_REMOTE_CONTROLLER_ORIGIN);
      expect(link.supabaseUrl).toBe(supabaseUrl);
    }
  });

  test('the literal lives only in the default-origin module among app sources', () => {
    // The public snapshot uses the public guide origin, which the onboarding module also names.
    const host = new URL(DEFAULT_REMOTE_CONTROLLER_ORIGIN).host;
    const allowed = ['src/defaultRemoteControllerOrigin.ts', 'src/onboardingInfrastructure.ts'];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(path, 'utf8').includes(host)) hits.push(path.slice(root.length + 1));
      }
    };
    walk(join(root, 'src'));
    if (readFileSync(join(root, 'api-server.ts'), 'utf8').includes(host)) hits.push('api-server.ts');
    expect(hits).toContain('src/defaultRemoteControllerOrigin.ts');
    expect(hits.filter(hit => !allowed.includes(hit))).toEqual([]);
  });
});
