import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const buildScript = readFileSync(new URL('../build-macos.ts', import.meta.url), 'utf8');
const sidecarBuildScript = readFileSync(new URL('../build-sidecar.ts', import.meta.url), 'utf8');
const xattrShim = readFileSync(new URL('../scripts/macos-bin/xattr', import.meta.url), 'utf8');
const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('macOS app bundle', () => {
  test('seals the complete local-development bundle with an ad-hoc signature', () => {
    expect(config.bundle.macOS.signingIdentity).toBe('-');
  });

  test('uses a unique permission identity without moving established app data', () => {
    expect(config.identifier).toBe('com.intenet.agentstozbycs');
    expect(tauriSource).toContain('fn legacy_app_data_dir()');
    expect(tauriSource).toContain('.join("com.portmanager.portmanager")');
    expect(tauriSource).toContain('let data_dir = legacy_app_data_dir()?;');
    expect(buildScript).toContain('designated => identifier "com.intenet.agentstozbycs"');
    expect(buildScript).toContain('codesign --verify --deep --strict');
  });

  test('uses the recursive xattr compatibility shim while bundling', () => {
    expect(buildScript).toContain('scripts", "macos-bin');
    expect(xattrShim).toContain('/usr/bin/find');
    expect(xattrShim).toContain('/usr/bin/xattr -c');
  });

  test('bundles project-memory installer templates beside the compiled sidecar', () => {
    expect(config.bundle.resources).toContain('resources/templates/');
    expect(sidecarBuildScript).toContain('cpSync');
    expect(sidecarBuildScript).toContain('["hermes", "hermes-plugin"]');
    expect(sidecarBuildScript).toContain('join(projectRoot, "templates", name)');
  });
});
