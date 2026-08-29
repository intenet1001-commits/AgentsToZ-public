import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PortLaunchOwnership } from '../src/portLaunchOwnership';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('port launch ownership', () => {
  test('allows only one in-flight launch per port id and releases after completion', () => {
    const ownership = new PortLaunchOwnership();
    expect(ownership.tryClaim('project-a')).toBe(true);
    expect(ownership.tryClaim('project-a')).toBe(false);
    expect(ownership.tryClaim('project-b')).toBe(true);
    ownership.release('project-a');
    expect(ownership.tryClaim('project-a')).toBe(true);
  });

  test('guards execute and force-restart until every return path completes', () => {
    const executeStart = apiSource.indexOf('if (url.pathname === "/api/execute-command"');
    const stopStart = apiSource.indexOf('if (url.pathname === "/api/stop-command"');
    const restartStart = apiSource.indexOf('if (url.pathname === "/api/force-restart-command"');
    const statusStart = apiSource.indexOf('if (url.pathname === "/api/check-port-status"');
    const execute = apiSource.slice(executeStart, restartStart);
    const stop = apiSource.slice(stopStart, restartStart);
    const restart = apiSource.slice(restartStart, statusStart);
    for (const route of [execute, stop, restart]) {
      expect(route).toContain('if (!portLaunchOwnership.tryClaim(portId))');
      expect(route).toContain('portLaunchOwnership.release(claimedPortId);');
    }
  });
});
