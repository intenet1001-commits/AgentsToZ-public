import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApiServer } from './startTestApiServer';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function tools(baseUrl: string, refresh = false) {
  const response = await fetch(`${baseUrl}/api/onboarding/tools${refresh ? '?refresh=1' : ''}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    diagnostics: Array<{ id: string; state: string; installed?: boolean; version?: string }>;
  }>;
}

describe('onboarding tool refresh', () => {
  test('rediscovers Hermes after installation instead of keeping the startup miss', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-onboarding-tools-'));
    roots.push(home);
    const localBin = join(home, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    // This test covers refresh of a newly installed binary, not host login-shell
    // configuration. Keep absent-tool probes isolated from the developer's shell.
    const shell = join(localBin, 'zsh');
    writeFileSync(shell, '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(shell, 0o755);

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: join(home, '.config'),
        PATH: `${localBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        AGENTSTOZ_SKIP_HERMES_SYNC: '1',
      },
    });
    children.push(child);

    const before = await tools(baseUrl, true);
    expect(before.diagnostics.find(item => item.id === 'hermes')).toMatchObject({
      state: 'missing',
      installed: false,
    });

    const hermes = join(localBin, 'hermes');
    writeFileSync(hermes, '#!/bin/sh\necho "hermes 9.9.9"\n', 'utf8');
    chmodSync(hermes, 0o755);

    const cached = await tools(baseUrl);
    expect(cached.diagnostics.find(item => item.id === 'hermes')?.state).toBe('missing');

    const refreshed = await tools(baseUrl, true);
    expect(refreshed.diagnostics.find(item => item.id === 'hermes')).toMatchObject({
      state: 'ready',
      installed: true,
      version: '9.9.9',
    });
    // Two full diagnostics plus server startup probe unrelated installed CLIs.
    // Their individual production deadlines remain unchanged; this is not a
    // latency benchmark, and the refresh/cache assertions above stay mandatory.
  }, 90_000);
});
