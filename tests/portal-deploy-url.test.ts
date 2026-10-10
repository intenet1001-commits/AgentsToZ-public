import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  normalizeHttpsExactOrigin,
  normalizeHttpsPortalBaseUrl,
  normalizeVercelPortalDeployUrl,
  portalUrlWithParams,
  selectVercelProductionPortalUrl,
} from '../src/portalDeployUrl';

describe('personal portal deployment URL', () => {
  test('accepts only a root Vercel HTTPS origin for auto-deploy persistence', () => {
    expect(normalizeVercelPortalDeployUrl('https://my-agents.vercel.app/')).toBe('https://my-agents.vercel.app');
    expect(normalizeVercelPortalDeployUrl('https://my-agents.vercel.app/path')).toBeNull();
    expect(normalizeVercelPortalDeployUrl('https://my-agents.vercel.app/?token=leak')).toBeNull();
    expect(normalizeVercelPortalDeployUrl('http://my-agents.vercel.app')).toBeNull();
    expect(normalizeVercelPortalDeployUrl('https://vercel.app')).toBeNull();
    expect(normalizeVercelPortalDeployUrl('https://portal.example.invalid')).toBeNull();
  });

  test('normalizes only credential-free exact HTTPS origins for localhost integration', () => {
    expect(normalizeHttpsExactOrigin(' https://portal.example.invalid/ ')).toBe('https://portal.example.invalid');
    expect(normalizeHttpsExactOrigin('https://portal.example.invalid:8443')).toBe('https://portal.example.invalid:8443');
    expect(normalizeHttpsExactOrigin('null')).toBeNull();
    expect(normalizeHttpsExactOrigin('https://user:secret@portal.example.invalid')).toBeNull();
    expect(normalizeHttpsExactOrigin('https://portal.example.invalid/local-api')).toBeNull();
    expect(normalizeHttpsExactOrigin('https://portal.example.invalid/.')).toBeNull();
    expect(normalizeHttpsExactOrigin('https://portal.example.invalid/?token=value')).toBeNull();
    expect(normalizeHttpsExactOrigin('https://portal.example.invalid/#fragment')).toBeNull();
    expect(normalizeHttpsExactOrigin('http://portal.example.invalid')).toBeNull();
  });

  test('selects the stable production alias instead of the first preview-like URL', () => {
    const output = selectVercelProductionPortalUrl(
      'https://my-portal-preview-abc.vercel.app\n',
      [
        'Inspect: https://vercel.com/team/project/deployment',
        'Production: https://my-portal-production-xyz.vercel.app',
        'Aliased: https://my-portal.vercel.app',
      ].join('\n'),
    );
    expect(output).toBe('https://my-portal.vercel.app');
  });

  test('falls back only to an exact Vercel deployment URL line from production stdout', () => {
    expect(selectVercelProductionPortalUrl(
      '\u001b[32mhttps://my-portal-build-abc.vercel.app\u001b[0m\n',
      'Inspect: https://vercel.com/team/project/deployment',
    )).toBe('https://my-portal-build-abc.vercel.app');
    expect(selectVercelProductionPortalUrl(
      'log mentions https://untrusted.vercel.app but is not deployment stdout',
      '',
    )).toBeNull();
  });

  test('allows an explicit HTTPS custom portal env and appends invite parameters safely', () => {
    const base = normalizeHttpsPortalBaseUrl('https://portal.example.invalid/private?old=1#fragment');
    expect(base).toBe('https://portal.example.invalid/private');
    const params = new URLSearchParams({ url: 'https://project.supabase.co', key: 'anon-public' });
    expect(portalUrlWithParams(base!, params)).toBe(
      'https://portal.example.invalid/private?url=https%3A%2F%2Fproject.supabase.co&key=anon-public',
    );
  });

  test('keeps the former private portal host out of tracked runtime sources', () => {
    const portalManager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    expect(portalManager).toContain('resolvePersonalPortalUrl(fresh)');
    expect(portalManager).toContain('import.meta.env.VITE_PORTAL_URL');
    expect(api).toContain('persistPortalDeployUrl(productionUrl)');
    expect(api).toContain("req.headers.get('access-control-request-method')?.toUpperCase() !== 'POST'");
    const portalGate = api.slice(
      api.indexOf('function isAllowedPortalLocalIntegration'),
      api.indexOf('const server = Bun.serve'),
    );
    expect(portalGate.indexOf('PORTAL_LOCAL_INTEGRATION_ROUTES.has')).toBeLessThan(
      portalGate.indexOf('storedPortalIntegrationOrigin()'),
    );
    expect(api).toContain('storedPortalIntegrationOrigin() === origin');
    expect(`${portalManager}\n${api}`).not.toContain([
      ['portmanager', 'portal'].join('-'),
      'vercel',
      'app',
    ].join('.'));
  });
});
