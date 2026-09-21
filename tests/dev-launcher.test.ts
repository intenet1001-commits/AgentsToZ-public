import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { terminatePosixApiProcessGroup } from '../dev';

const launcher = readFileSync(new URL('../실행.command', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const devRunner = readFileSync(new URL('../dev.ts', import.meta.url), 'utf8');

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

  test('isolates the API in a POSIX process group and reaps it before restart', () => {
    expect(devRunner).toContain('detached: process.platform !== "win32"');
    expect(devRunner).toContain('else if (!apiGroupConfirmedGone) process.kill(-apiServer.pid, "SIGKILL")');
    expect(devRunner).toContain('if (process.platform !== "win32" && apiAlreadyReaped)');
    const supervisor = devRunner.slice(devRunner.indexOf('async function superviseApiServer()'));
    expect(supervisor.indexOf('await terminatePosixApiProcessGroup(apiServer.pid)')).toBeGreaterThanOrEqual(0);
    expect(supervisor.indexOf('apiServer = spawnApiServer()')).toBeGreaterThan(
      supervisor.indexOf('await terminatePosixApiProcessGroup(apiServer.pid)'),
    );
  });

  test('opts only the source API child into local runtime testing', () => {
    expect(devRunner).toContain('AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE: "1"');
    expect(devRunner).toContain('env: {');
  });

  test.skipIf(process.platform === 'win32')(
    'confirms an old API group is gone even when a child survives the leader',
    async () => {
      const oldApi = Bun.spawn([
        '/bin/sh',
        '-c',
        'trap "" TERM; /bin/sh -c \'trap "" TERM; while :; do sleep 1; done\' & exit 23',
      ], {
        detached: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const oldProcessGroupId = oldApi.pid;
      try {
        expect(await oldApi.exited).toBe(23);
        expect(() => process.kill(-oldProcessGroupId, 0)).not.toThrow();

        const startedAt = Date.now();
        await terminatePosixApiProcessGroup(oldProcessGroupId, {
          termGraceMs: 75,
          confirmMs: 3_000,
        });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);

        let missing = false;
        try {
          process.kill(-oldProcessGroupId, 0);
        } catch (error: any) {
          missing = error?.code === 'ESRCH';
        }
        expect(missing).toBe(true);
      } finally {
        try { process.kill(-oldProcessGroupId, 'SIGKILL'); } catch { /* already gone */ }
      }
    },
  );
});
