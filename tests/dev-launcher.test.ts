import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const launcher = readFileSync(new URL('../실행.command', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

describe('macOS development launcher', () => {
  test('delegates API and Vite lifecycle management to the supervised runner', () => {
    expect(launcher).toContain('bun dev.ts');
    expect(launcher).not.toContain('bun api-server.ts &');
    expect(launcher).not.toContain('./node_modules/.bin/vite &');
  });

  test('checks the effective overridden ports instead of hard-coded ports', () => {
    expect(launcher).toContain('API_PORT_VALUE="${API_PORT:-3001}"');
    expect(launcher).toContain('VITE_PORT_VALUE="${PORT:-9000}"');
    expect(launcher).not.toMatch(/lsof -ti:\$port(?![^\n]*-sTCP:LISTEN)/);
  });

  test('serves the UI on the IPv4 loopback used by embedded browsers', () => {
    expect(viteConfig).toContain("host: '127.0.0.1'");
  });
});
