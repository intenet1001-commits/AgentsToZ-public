import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('orphaned workspace lease prevention on shutdown', () => {
  test('shutdown closes lease admission first and drains held leases before exiting', () => {
    const shutdown = section(api, 'function shutdownRemoteControlApi(', "process.once('SIGINT'");
    const closeAt = shutdown.indexOf('closeManagedWorkspaceLeaseAdmission()');
    const settleAt = shutdown.indexOf('settleLocalApiShutdown(');
    const drainAt = shutdown.indexOf('waitForHeldWorkspaceLeases(');
    const finalExitAt = shutdown.lastIndexOf('process.exit(exitCode)');
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeLessThan(settleAt);
    expect(drainAt).toBeGreaterThan(settleAt);
    expect(drainAt).toBeLessThan(finalExitAt);
    // The drain shares the one hard ceiling native shutdown already budgets for.
    expect(shutdown).toContain('LOCAL_API_SHUTDOWN_HARD_CEILING_MS');
  });

  test('every managed acquisition refuses a new lease once shutdown has begun', () => {
    for (const [start, end] of [
      ['async function acquireManagedWorkspaceLease(', 'async function acquireManagedWorkspaceDirectoryLease('],
      ['async function acquireManagedWorkspaceDirectoryLease(', 'async function promoteManagedWorkspaceDirectoryLease('],
      ['async function promoteManagedWorkspaceDirectoryLease(', 'function releaseManagedWorkspaceLease('],
    ] as const) {
      expect(section(api, start, end)).toContain('assertManagedWorkspaceLeaseAdmission()');
    }
  });
});

describe('in-app workspace lease recovery', () => {
  test('the API lists and recovers through the recovery module only', () => {
    const list = section(api, 'url.pathname === "/api/workspace-leases/orphans"', 'url.pathname === "/api/workspace-leases/recover"');
    expect(list).toContain('req.method === "GET"');
    expect(list).toContain('listOrphanedWorkspaceLeases(');
    expect(list).toContain('APP_DATA_DIR');
    const recover = section(api, 'url.pathname === "/api/workspace-leases/recover"', 'return new Response');
    expect(recover).toContain('req.method === "POST"');
    expect(api).toContain('recoverOrphanedWorkspaceLeases({');
  });

  test('the tools popover opens the recovery dialog', () => {
    expect(app).toContain('data-testid="btn-workspace-lease-recovery"');
    expect(app).toContain('<WorkspaceLeaseRecoveryDialog');
  });
});
