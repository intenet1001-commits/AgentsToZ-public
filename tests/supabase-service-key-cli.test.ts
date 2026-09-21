import { describe, expect, test } from 'bun:test';
import {
  describeSupabaseCliFailure,
  selectServiceRoleKey,
  supabaseProjectRefFromUrl,
} from '../src/supabaseServiceKeyCli';

describe('project ref from the configured Supabase URL', () => {
  test('reads the ref the CLI needs without embedding a real project fixture', () => {
    const projectRef = ['example', 'project', 'ref', '1234'].join('');
    const projectUrl = `https://${projectRef}.supabase.co`;
    expect(supabaseProjectRefFromUrl(projectUrl)).toBe(projectRef);
    expect(supabaseProjectRefFromUrl(`${projectUrl}/`)).toBe(projectRef);
  });

  test('refuses anything that is not a Supabase project URL', () => {
    for (const bad of ['', '   ', 'not-a-url', 'https://example.com', 'https://short.supabase.co']) {
      expect(supabaseProjectRefFromUrl(bad)).toBeNull();
    }
  });
});

describe('picking the key the local server may use', () => {
  // The CLI returns anon and publishable keys in the same list. Grabbing the
  // wrong one stores a key that keeps failing with 401 while the user believes
  // the credential is in place — the exact confusion this feature removes.
  const rows = [
    { name: 'anon', api_key: 'eyJ-anon' },
    { name: 'service_role', api_key: 'eyJ-service' },
    { name: 'default', api_key: 'sb_publishable_abc' },
    { name: 'default', api_key: 'sb_secret_xyz' },
  ];

  test('prefers the legacy service_role JWT', () => {
    expect(selectServiceRoleKey(rows)).toBe('eyJ-service');
  });

  test('falls back to the new-style secret key when there is no service_role row', () => {
    expect(selectServiceRoleKey(rows.filter(r => r.name !== 'service_role'))).toBe('sb_secret_xyz');
  });

  test('never returns a publishable or anon key', () => {
    expect(selectServiceRoleKey([{ name: 'anon', api_key: 'eyJ-anon' }])).toBeNull();
    expect(selectServiceRoleKey([{ name: 'default', api_key: 'sb_publishable_abc' }])).toBeNull();
  });

  test('survives shapes the CLI might change to', () => {
    expect(selectServiceRoleKey(null)).toBeNull();
    expect(selectServiceRoleKey([])).toBeNull();
    expect(selectServiceRoleKey(['nope', 42, null])).toBeNull();
    expect(selectServiceRoleKey([{ name: 'service_role', apiKey: 'eyJ-camel' }])).toBe('eyJ-camel');
    expect(selectServiceRoleKey([{ name: 'service_role', api_key: '   ' }])).toBeNull();
  });
});

describe('CLI failure messages tell the user what to do next', () => {
  test('names the login step when the CLI has no token', () => {
    expect(describeSupabaseCliFailure('You are not logged in', 1)).toContain('supabase login');
  });

  test('keeps the original text for permission failures', () => {
    expect(describeSupabaseCliFailure('403 Forbidden for project', 1)).toContain('403 Forbidden');
  });

  test('still says something useful with an empty stderr', () => {
    expect(describeSupabaseCliFailure('', 2)).toContain('2');
  });
});
