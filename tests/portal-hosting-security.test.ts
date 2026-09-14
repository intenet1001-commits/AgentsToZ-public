import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type HeaderEntry = { source: string; headers: Array<{ key: string; value: string }> };

function cspFor(entries: HeaderEntry[], source: string): string {
  return entries.find(entry => entry.source === source)?.headers
    .find(header => header.key.toLowerCase() === 'content-security-policy')?.value ?? '';
}

function directive(csp: string, name: string): string[] {
  const value = csp.split(';').map(part => part.trim())
    .find(part => part === name || part.startsWith(`${name} `));
  return value ? value.split(/\s+/).slice(1) : [];
}

describe('personal portal hosting security', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    headers: HeaderEntry[];
  };

  test('main portal permits only its bundled scripts and exact required network families', () => {
    const csp = cspFor(config.headers, '/(.*)');
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
    expect(directive(csp, 'connect-src')).toEqual([
      "'self'",
      'https://*.supabase.co',
      'wss://*.supabase.co',
    ]);
    expect(directive(csp, 'img-src')).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://www.google.com',
    ]);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive(csp, 'default-src')).not.toContain('https:');
    expect(directive(csp, 'script-src')).not.toContain('https:');
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'none'"]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
  });

  test('does not weaken the separate remote controller policy', () => {
    const remote = cspFor(config.headers, '/remote/(.*)');
    const remoteExact = cspFor(config.headers, '/remote');
    expect(remoteExact).toBe(remote);
    expect(directive(remote, 'default-src')).toEqual(["'none'"]);
    expect(remote).not.toContain("'unsafe-eval'");
    expect(directive(remote, 'form-action')).toEqual(["'none'"]);
  });
});
