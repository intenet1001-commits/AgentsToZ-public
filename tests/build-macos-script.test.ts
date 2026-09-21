import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../build-macos.ts', import.meta.url), 'utf8');

describe('macOS build wrapper', () => {
  test('uses the project-local Tauri CLI instead of relying on GUI shell PATH', () => {
    expect(source).toContain('"node_modules", ".bin"');
    expect(source).toContain('`${tauriBin} build`');
    expect(source).toContain('`${tauriBin} build --bundles dmg`');
    expect(source).toContain('bun install --frozen-lockfile');
  });

  test('never reports an old app or DMG as a recovered current build', () => {
    expect(source).toContain('const tauriBuildStartedAt = Date.now()');
    expect(source).toContain('const hasFreshApp');
    expect(source).toContain('const hasFreshDmg');
    expect(source).toContain('이전 번들을 성공으로 재사용하지 않습니다');
  });

  test('commits every version file changed by the build', () => {
    expect(source).toContain('src-tauri/Cargo.toml');
    expect(source).toContain('src-tauri/Cargo.lock');
  });

  test('verifies published release provenance before increasing the version', () => {
    expect(source).toContain('verifyReleaseSource');
    expect(source).toContain('AGENTSTOZ_RELEASE_SOURCE_SHA');
    expect(source.indexOf('const releaseSource = verifyReleaseSource')).toBeLessThan(source.indexOf('if (!existsSync(tauriBin))'));
    expect(source.indexOf('const releaseSource = verifyReleaseSource')).toBeLessThan(source.indexOf('bun update-version.ts'));
    expect(source).toContain('--allow-unpublished-source');
  });
});
