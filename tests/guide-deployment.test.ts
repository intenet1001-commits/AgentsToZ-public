import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('public guide deployment', () => {
  test('uses an isolated guide-only Vite entry and output directory', () => {
    const vite = source('vite.guide.config.ts');

    expect(vite).toContain("outDir: 'dist-guide'");
    expect(vite).toContain("publicDir: 'public'");
    expect(vite).toContain("input: { guide: 'guide.html' }");
    expect(vite).not.toContain("portal.html'");
    expect(vite).not.toContain("setup.html'");
  });

  test('keeps personal portal deployment files out of the guide contract', () => {
    const packageJson = JSON.parse(source('package.json')) as { scripts: Record<string, string> };
    const vercel = JSON.parse(source('vercel.guide.json')) as {
      rewrites: Array<{ source: string; destination: string }>;
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };

    expect(packageJson.scripts['build:guide']).toBe('vite build --config vite.guide.config.ts');
    expect(packageJson.scripts['deploy:guide']).toBe('bun scripts/deploy-public-guide.ts');
    expect(packageJson.scripts['deploy:guide:dry-run']).toBe('bun scripts/deploy-public-guide.ts --dry-run');
    expect(source('.gitignore')).toContain('.vercel-guide-identity.json');
    expect(Object.keys(vercel).sort()).toEqual(['headers', 'rewrites']);
    expect(vercel.rewrites).toEqual([
      { source: '/', destination: '/guide.html' },
      { source: '/guide', destination: '/guide.html' },
    ]);
    expect(vercel.headers[0]?.headers.some(header => header.key === 'Content-Security-Policy')).toBe(true);
  });

  test('ships the public downloads and real screenshots used by the guide', () => {
    const guide = source('src/onboarding-guide-main.tsx');

    expect(source('public/favicon.svg').length).toBeGreaterThan(0);
    expect(source('public/agentstoz-remote-device.sh')).toContain('#!/');
    for (const image of [
      'agents-toz-overview.png',
      'setup-wizard-current.png',
      'onboarding-dashboard.png',
      'portal.png',
      'ai-usage-panel.png',
    ]) {
      expect(guide).toContain(`../docs/images/${image}`);
      expect(readFileSync(new URL(`../docs/images/${image}`, import.meta.url)).length).toBeGreaterThan(0);
    }
  });
});
