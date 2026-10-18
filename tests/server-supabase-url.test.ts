import { describe, expect, test } from 'bun:test';
import { normalizeServerSupabaseUrl } from '../server-supabase-service';

describe('server Supabase target URL', () => {
  test('accepts HTTPS and exact loopback HTTP targets', () => {
    expect(normalizeServerSupabaseUrl('https://project.supabase.co/'))
      .toBe('https://project.supabase.co');
    expect(normalizeServerSupabaseUrl('http://127.0.0.1:54321/'))
      .toBe('http://127.0.0.1:54321');
    expect(normalizeServerSupabaseUrl('http://[::1]:54321/'))
      .toBe('http://[::1]:54321');
  });

  test('rejects plaintext remote hosts and URL credentials before key forwarding', () => {
    for (const value of [
      'http://example.com',
      'http://127.0.0.1.example.com',
      'ftp://127.0.0.1',
      'https://user:password@project.supabase.co',
      'http://user@127.0.0.1:54321',
    ]) {
      expect(() => normalizeServerSupabaseUrl(value)).toThrow();
    }
  });
});
