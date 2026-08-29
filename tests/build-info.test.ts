import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildInfo } from '../build-info';
import { buildTimeLabel, formatBuildTime } from '../src/buildInfo';

describe('build information', () => {
  test('uses the version source and exact Vite build-start timestamp', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentstoz-build-info-'));
    try {
      mkdirSync(join(fixtureRoot, 'src-tauri'));
      writeFileSync(join(fixtureRoot, 'build-number.json'), '{"buildNumber":130}\n');
      writeFileSync(join(fixtureRoot, 'src-tauri', 'tauri.conf.json'), '{"version":"130.0.0"}\n');

      expect(createBuildInfo({
        root: fixtureRoot,
        command: 'build',
        now: new Date('2026-08-07T06:42:04.000Z'),
      })).toEqual({
        buildNumber: 130,
        version: '130.0.0',
        builtAt: '2026-08-07T06:42:04.000Z',
        mode: 'production',
      });
      expect(createBuildInfo({ root: fixtureRoot, command: 'serve', now: new Date(0) }).mode).toBe('development');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('refuses an artifact when the app and displayed versions differ', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentstoz-build-info-'));
    try {
      mkdirSync(join(fixtureRoot, 'src-tauri'));
      writeFileSync(join(fixtureRoot, 'build-number.json'), '{"buildNumber":130}\n');
      writeFileSync(join(fixtureRoot, 'src-tauri', 'tauri.conf.json'), '{"version":"129.0.0"}\n');
      expect(() => createBuildInfo({ root: fixtureRoot })).toThrow('Build version mismatch');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('allows only the standalone portal to omit an excluded Tauri config', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentstoz-build-info-'));
    try {
      writeFileSync(join(fixtureRoot, 'build-number.json'), '{"buildNumber":130}\n');

      expect(() => createBuildInfo({ root: fixtureRoot })).toThrow('Missing required Tauri version source');
      expect(createBuildInfo({
        root: fixtureRoot,
        tauriVersionPolicy: 'if-present',
        now: new Date('2026-08-07T06:42:04.000Z'),
      })).toMatchObject({ buildNumber: 130, version: '130.0.0', mode: 'production' });

      mkdirSync(join(fixtureRoot, 'src-tauri'));
      writeFileSync(join(fixtureRoot, 'src-tauri', 'tauri.conf.json'), '{"version":"129.0.0"}\n');
      expect(() => createBuildInfo({
        root: fixtureRoot,
        tauriVersionPolicy: 'if-present',
      })).toThrow('Build version mismatch');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('formats visible KST time and distinguishes development mode', () => {
    expect(formatBuildTime('2026-08-07T06:42:04.000Z')).toBe('2026.08.07 15:42:04');
    expect(formatBuildTime('2026-08-07T06:42:04.000Z', false)).toBe('08.07 15:42:04');
    expect(formatBuildTime('not-a-date')).toBe('');
    expect(buildTimeLabel({ buildNumber: 1, version: '1.0.0', builtAt: '', mode: 'development' })).toBe('개발 서버 시작');
    expect(buildTimeLabel({ buildNumber: 1, version: '1.0.0', builtAt: '', mode: 'production' })).toBe('빌드');
  });

  test('injects shared metadata and renders both public headers', () => {
    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    const portalViteConfig = readFileSync(new URL('../vite.portal.config.ts', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const portalSource = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
    const badgeSource = readFileSync(new URL('../src/components/BuildInfoBadge.tsx', import.meta.url), 'utf8');

    expect(viteConfig).toContain('createBuildInfo({ command })');
    expect(portalViteConfig).toContain("createBuildInfo({ command, tauriVersionPolicy: 'if-present' })");
    expect(viteConfig).not.toContain("tauriVersionPolicy: 'if-present'");
    expect(viteConfig).toContain('__BUILD_INFO__');
    expect(portalViteConfig).toContain('__BUILD_INFO__');
    expect(appSource).toContain('<BuildInfoBadge className="ml-auto" />');
    expect(portalSource.match(/<BuildInfoBadge\s*\/>/g)?.length).toBe(2);
    expect(badgeSource).toContain('data-testid="build-info"');
    expect(badgeSource).toContain('aria-label={accessibleLabel}');
  });
});
