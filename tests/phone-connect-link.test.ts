import {describe, expect, test} from 'bun:test';
import golden from './fixtures/phone-connect-link-golden.json';
import {buildPhoneConnectLink, bundledQrSupabaseMismatch, extractPhoneConnectLink, parsePhoneConnectLink, phoneConnectHostLabel, PHONE_CONNECT_LINK_PREFIX} from '../src/phoneConnectLink';
import {pairingSupabaseConfig} from '../src/remoteControlPairingSupabase';

// The iPhone parser (AgentsToZCore/PhoneConnectLink.swift) reads the same golden table.
describe('phone connect link — golden table shared with Swift', () => {
  for (const row of golden.build) {
    test(`build: ${row.name}`, () => {
      expect(buildPhoneConnectLink(row.input as never) as string).toBe(row.link);
    });
  }
  for (const row of golden.buildRejects) {
    test(`build refuses: ${row.name}`, () => {
      expect(() => buildPhoneConnectLink(row.input as never)).toThrow();
    });
  }
  for (const row of golden.parse) {
    test(`parse: ${row.name}`, () => {
      const link = extractPhoneConnectLink(row.text);
      let value: ReturnType<typeof parsePhoneConnectLink> | null = null;
      try { if (link) value = parsePhoneConnectLink(link); } catch { value = null; }
      if (row.expect.ok) expect(value).toEqual({portalOrigin: row.expect.portalOrigin, supabaseUrl: row.expect.supabaseUrl, anonKey: row.expect.anonKey, hostName: row.expect.hostName} as never);
      else expect(value).toBeNull();
    });
  }
});

describe('phone connect link — guards', () => {
  const anon = golden.build[0]!.input.anonKey;
  const input = {portalOrigin: 'https://portal.example.com', supabaseUrl: 'https://example-ref.supabase.co', anonKey: anon, hostName: 'Mac'};

  test('a key equal to the service_role key is refused even if it looks public', () => {
    expect(() => buildPhoneConnectLink(input, anon)).toThrow(/service_role/);
    expect(buildPhoneConnectLink(input, 'some-other-service-key')).toStartWith(PHONE_CONNECT_LINK_PREFIX);
  });

  test('never carries pairing secrets: exactly the five public fields', () => {
    const link = buildPhoneConnectLink(input);
    const json = JSON.parse(Buffer.from(link.slice(PHONE_CONNECT_LINK_PREFIX.length), 'base64url').toString('utf8'));
    expect(Object.keys(json).sort()).toEqual(['anonKey', 'hostName', 'portal', 'supabaseUrl', 'v']);
  });

  test('works with what pairingSupabaseConfig lets out of the Mac', () => {
    const config = pairingSupabaseConfig({supabaseUrl: 'https://example-ref.supabase.co/', supabaseAnonKey: anon}, null, raw => raw);
    expect(config).not.toBeNull();
    const parsed = parsePhoneConnectLink(buildPhoneConnectLink({portalOrigin: input.portalOrigin, supabaseUrl: config!.url, anonKey: config!.anonKey, hostName: 'Mac'}));
    expect(parsed.supabaseUrl).toBe('https://example-ref.supabase.co');
  });

  test('malformed input is rejected with a readable message', () => {
    for (const bad of [null, 42, '', 'agentstoz://connect#', 'agentstoz://connect#!!', 'https://example.com']) {
      expect(() => parsePhoneConnectLink(bad)).toThrow();
    }
    expect(extractPhoneConnectLink('no link here')).toBeNull();
    expect(extractPhoneConnectLink('x'.repeat(20_000))).toBeNull();
  });

  test('labels are cleaned, shortened and never empty', () => {
    expect(phoneConnectHostLabel('  ')).toBe('Mac');
    expect(phoneConnectHostLabel(undefined)).toBe('Mac');
    expect(phoneConnectHostLabel('A‮B\nC')).toBe('ABC');
    expect(Array.from(phoneConnectHostLabel('가'.repeat(100))).length).toBe(40);
  });
});

describe('bundled portal: a QR for another Supabase project', () => {
  test('matching or absent project is fine; another project is refused with how to switch', () => {
    expect(bundledQrSupabaseMismatch('https://a.supabase.co', 'https://a.supabase.co')).toBeNull();
    expect(bundledQrSupabaseMismatch(undefined, 'https://a.supabase.co')).toBeNull();
    const message = bundledQrSupabaseMismatch('https://b.supabase.co', 'https://a.supabase.co');
    expect(message).toContain('b.supabase.co');
    expect(message).toContain('기기 연결 · QR 스캔');
  });
});
