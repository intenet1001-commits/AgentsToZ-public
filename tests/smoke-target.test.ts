import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { classifySmokeTarget } from './smoke-target.mjs';

const smokeSource = readFileSync(new URL('./smoke.mjs', import.meta.url), 'utf8');

describe('smoke target classification', () => {
  test.each([
    'http://localhost:9000',
    'http://127.0.0.1:9000',
    'http://[::1]:9000',
    'http://127.0.0.1:55333',
  ])('treats the local full app at %s as local', target => {
    expect(classifySmokeTarget(target)).toEqual({ isLocalFullApp: true, isPortalOnly: false });
  });

  test('keeps a local portal preview distinct from the full app', () => {
    expect(classifySmokeTarget('http://127.0.0.1:4173/portal.html')).toEqual({
      isLocalFullApp: false,
      isPortalOnly: true,
    });
  });

  test('checks the selected API instance against the shared context contract', () => {
    expect(smokeSource).toContain('process.env.API_PORT');
    expect(smokeSource).toContain('context-api-contract.json');
    expect(smokeSource).toContain('/api/health');
    expect(smokeSource).toContain('requiredCapabilities');
    expect(smokeSource).not.toContain("http://localhost:3001/api/ports");
  });

  test('never lets the workspace-root fixture write into the real local API', () => {
    const workspaceRootFixture = smokeSource
      .split('// smoke-workspace-roots:start')[1]
      ?.split('// smoke-workspace-roots:end')[0];

    expect(workspaceRootFixture).toBeTruthy();
    expect(workspaceRootFixture).toContain("route.request().method() === 'GET'");
    expect(workspaceRootFixture).toContain('JSON.stringify({ success: true })');
    expect(workspaceRootFixture).not.toContain('route.continue()');
  });
});
