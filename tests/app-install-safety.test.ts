import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('macOS app installation safety', () => {
  test('stages and verifies the new bundle before preserving the old app as a backup', () => {
    expect(apiSource).toContain("'/usr/bin/ditto', sourcePath, stagedPath");
    expect(apiSource).toContain("'/usr/bin/codesign', '--verify', '--deep', '--strict', stagedPath");
    expect(apiSource).toContain('/bin/mv "$destination_path" "$backup_path"');
    expect(apiSource).toContain('/bin/mv "$staged_path" "$destination_path"');
    expect(apiSource).toContain('Rollback complete.');
    expect(apiSource).not.toContain('cmd: ["rm", "-rf", destPath]');
  });

  test('uses one detached sidecar installer instead of an obsolete in-process Rust copy', () => {
    expect(appSource).toContain("const baseUrl = isTauri() ? 'http://localhost:3001' : ''");
    expect(appSource).toContain('`${baseUrl}/api/install-app`');
    expect(apiSource).toContain('detached: true');
    expect(apiSource).toContain('AGENTSTOZ_APP_EXECUTABLE_SUFFIX');
    expect(rustSource).not.toContain('install_app_to_applications');
    expect(rustSource).not.toContain('CS_Manager.app');
  });
});
