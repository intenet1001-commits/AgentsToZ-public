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
    expect(buildScript).toContain('bun run build:macos-runtime-native');
    expect(buildScript).toContain('stageMacOSRuntimeDevelopmentBundle');
    expect(buildScript.indexOf('stageMacOSRuntimeDevelopmentBundle({'))
      .toBeLessThan(buildScript.indexOf('codesign --force --deep --sign -'));
  });

  test('uses the recursive xattr compatibility shim while bundling', () => {
    expect(buildScript).toContain('scripts", "macos-bin');
    expect(xattrShim).toContain('/usr/bin/find');
    expect(xattrShim).toContain('/usr/bin/xattr -c');
  });

  test('rejects unknown and premature production-runtime flags before build mutation', () => {
    const argumentGate = buildScript.indexOf('const rejectedBuildArguments');
    const versionUpdate = buildScript.indexOf('await $`bun update-version.ts`');
    expect(argumentGate).toBeGreaterThan(-1);
    expect(argumentGate).toBeLessThan(versionUpdate);
    expect(buildScript).toContain('rejectedBuildArguments.includes("--production-runtime")');
    expect(buildScript).toContain('ad-hoc 빌드로 대체하지 않습니다.');
    expect(buildScript).toContain('process.exit(64)');
  });

  test('bundles project-memory installer templates beside the compiled sidecar', () => {
    expect(config.bundle.resources).toContain('resources/templates/');
    expect(sidecarBuildScript).toContain('cpSync');
    expect(sidecarBuildScript).toContain('["hermes", "hermes-plugin"]');
    expect(sidecarBuildScript).toContain('join(projectRoot, "templates", name)');
  });

  test('bundles the bounded AgentsToZ USE MCP bridge beside the API sidecar', () => {
    expect(config.bundle.resources).toContain('resources/agentstoz-use-mcp*');
    expect(sidecarBuildScript).toContain('agentstoz-use-mcp-server.ts');
    expect(sidecarBuildScript).toContain('agentstoz-use-mcp');
  });

  test('builds the Agent Runtime guard without target dotenv or bunfig autoload', () => {
    expect(config.bundle.resources).toContain('resources/agentstoz-agent-runtime-guard*');
    expect(sidecarBuildScript).toContain('agent-runtime-process-guard.ts');
    expect(sidecarBuildScript).toContain('--no-compile-autoload-dotenv');
    expect(sidecarBuildScript).toContain('--no-compile-autoload-bunfig');
  });
});
