import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  groupOrphanedWorkspaceLeases,
  WorkspaceLeaseRecoveryList,
} from '../src/components/WorkspaceLeaseRecoveryDialog';
import type { OrphanedWorkspaceLease } from '../src/workspaceLeaseRecoveryContract';

const lock = (overrides: Partial<OrphanedWorkspaceLease>): OrphanedWorkspaceLease => ({
  key: 'a'.repeat(64),
  pid: 93505,
  lockedAt: '2026-09-06T09:32:43.000Z',
  kind: 'directory',
  workspacePath: '/Users/me/product/song-app',
  ...overrides,
});

describe('grouping orphaned workspace leases', () => {
  test('keeps a project directory lock and its Git family lock together', () => {
    const groups = groupOrphanedWorkspaceLeases([
      lock({ key: '1'.repeat(64), workspacePath: '/p/song-app', kind: 'directory' }),
      lock({ key: '2'.repeat(64), workspacePath: '/p/freeparking-1', kind: 'directory', pid: 55145 }),
      lock({ key: '3'.repeat(64), workspacePath: '/p/song-app', kind: 'git-family' }),
    ]);

    expect(groups.map(group => group.workspacePath)).toEqual(['/p/freeparking-1', '/p/song-app']);
    expect(groups[1]!.locks.map(entry => entry.key)).toEqual(['1'.repeat(64), '3'.repeat(64)]);
    expect(groups[0]!.pids).toEqual([55145]);
  });

  test('gives each unmapped lock its own group after the named projects', () => {
    const groups = groupOrphanedWorkspaceLeases([
      lock({ key: 'b'.repeat(64), workspacePath: null, kind: 'unknown' }),
      lock({ key: 'c'.repeat(64), workspacePath: '/p/ShadowLoop' }),
      lock({ key: 'd'.repeat(64), workspacePath: null, kind: 'unknown' }),
    ]);

    expect(groups.map(group => group.workspacePath)).toEqual(['/p/ShadowLoop', null, null]);
    expect(groups[1]!.locks).toHaveLength(1);
  });
});

describe('workspace lease recovery list', () => {
  const groups = groupOrphanedWorkspaceLeases([
    lock({ workspacePath: '/Users/me/product/song-app', pid: 93505 }),
  ]);

  test('names the project, its path, and the process that died', () => {
    const html = renderToStaticMarkup(
      <WorkspaceLeaseRecoveryList groups={groups} confirmed={false} busyKey={null}
        onConfirmedChange={() => {}} onRecover={() => {}} />,
    );
    expect(html).toContain('song-app');
    expect(html).toContain('/Users/me/product/song-app');
    expect(html).toContain('PID 93505');
  });

  test('keeps recovery disabled until the user confirms related work has ended', () => {
    const locked = renderToStaticMarkup(
      <WorkspaceLeaseRecoveryList groups={groups} confirmed={false} busyKey={null}
        onConfirmedChange={() => {}} onRecover={() => {}} />,
    );
    const confirmed = renderToStaticMarkup(
      <WorkspaceLeaseRecoveryList groups={groups} confirmed busyKey={null}
        onConfirmedChange={() => {}} onRecover={() => {}} />,
    );
    expect(locked).toMatch(/data-testid="workspace-lease-recover-0"[^>]*disabled=""/);
    expect(confirmed).not.toMatch(/data-testid="workspace-lease-recover-0"[^>]*disabled=""/);
  });

  test('says plainly when nothing is left to recover', () => {
    const html = renderToStaticMarkup(
      <WorkspaceLeaseRecoveryList groups={[]} confirmed={false} busyKey={null}
        onConfirmedChange={() => {}} onRecover={() => {}} />,
    );
    expect(html).toContain('남아 있는 잠금이 없습니다');
  });
});
