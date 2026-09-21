import { describe, expect, test } from 'bun:test';
import {
  eligibleRemoteControlRows,
  groupWorktreesUnderParents,
  loadRemoteControlWorktreeDiscoveryFailClosed,
  publicRemoteControlProject,
  registeredRemoteControlTarget,
  sortRemoteControlTargetsByName,
} from '../src/remoteControlProcessGateway';

describe('remote control registered-project gateway', () => {
  test('keeps main cards but removes persisted worktree authority when Git discovery throws', async () => {
    const main = { internalId: 'main', name: 'Main', worktreePath: undefined };
    const stale = { internalId: 'stale', name: 'Stale', worktreePath: '/still-existing/stale' };
    const result = await loadRemoteControlWorktreeDiscoveryFailClosed(
      [main, stale],
      async () => { throw new Error('forced discovery failure'); },
    );
    expect(result).toEqual({ targets: [main], discovery: null });
  });

  test('deletion fences, unverified generated rows, other-device rows, and portless rows stay out', () => {
    const rows = [
      { id: 'main', name: 'Main', port: 9000, sourceDeviceId: 'this-device' },
      { id: 'local-hidden', name: 'Hidden', port: 9001 },
      { id: 'remote-deleted', name: 'Deleted', port: 9002 },
      { id: 'legacy-generated', name: 'Old worktree', port: 9003 },
      { id: 'other-device', name: 'Other', port: 9004, sourceDeviceId: 'another-device' },
      { id: 'portless', name: 'No listener' },
    ];
    expect(eligibleRemoteControlRows(rows, {
      deviceId: 'this-device',
      localOnlyDeletedPortIds: ['local-hidden'],
      remoteDeletedPortIds: ['remote-deleted'],
      verifiedLegacyGeneratedWorktreeIds: ['legacy-generated'],
    }).map(row => row.id)).toEqual(['main']);
  });

  test('a provenance-marked row fails closed when this installation has no device identity', () => {
    expect(eligibleRemoteControlRows([
      { id: 'legacy-local', name: 'Legacy local', port: 9000 },
      { id: 'owned-somewhere', name: 'Unproven owner', port: 9001, sourceDeviceId: 'unknown-device' },
    ], {}).map(row => row.id)).toEqual(['legacy-local']);
  });

  test('an explicitly linked previous installation ID retains local process authority', () => {
    expect(eligibleRemoteControlRows([
      { id: 'current', name: 'Current', port: 9000, sourceDeviceId: 'current-device' },
      { id: 'linked-old', name: 'Linked old install', port: 9001, sourceDeviceId: 'old-device' },
      { id: 'other', name: 'Another Mac', port: 9002, sourceDeviceId: 'other-device' },
    ], {
      deviceId: 'current-device',
      deviceIdentityAliases: ['old-device'],
    }).map(row => row.id)).toEqual(['current', 'linked-old']);
  });

  test('a registered folder without a port remains remotely openable', async () => {
    const rows = [{ id: 'folder-only', name: 'Folder only', folderPath: '/private/project' }];
    expect(eligibleRemoteControlRows(rows, {}).map(row => row.id)).toEqual(['folder-only']);
    const target = await registeredRemoteControlTarget({
      row: rows[0]!,
      observedRunning: null,
      detectStart: async () => ({ command: null, framework: 'other' }),
    });
    expect(target).toMatchObject({
      port: null,
      kind: 'main',
      status: 'unknown',
      actions: [
        'folder.open',
        'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
        'app.codex', 'app.hermes',
        'codex.thread.start',
      ],
    });
  });

  test('worktree command is detected in its own folder and pinned to its registered port', async () => {
    const target = await registeredRemoteControlTarget({
      row: {
        id: 'internal-real-id',
        name: 'Linked tree',
        port: 19_042,
        folderPath: '/private/worktree',
        worktreePath: '/private/worktree',
        commandPath: '/private/main/start.command',
      },
      observedRunning: false,
      detectStart: async folder => {
        expect(folder).toBe('/private/worktree');
        return { command: 'bun run dev', framework: 'vite' };
      },
    });
    expect(target?.command).toBe('bunx vite --port 19042');
    expect(target?.actions).toEqual([
      'start', 'folder.open',
      'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
      'app.codex', 'app.hermes',
      'codex.thread.start',
      'localhost.open', 'orca.open',
    ]);
  });

  test('LAN projection is allowlisted and never serializes internal authority fields', async () => {
    const target = await registeredRemoteControlTarget({
      row: {
        id: 'internal-real-id',
        name: 'Safe project',
        port: 9010,
        folderPath: '/secret/path',
        terminalCommand: 'bun run dev --token secret',
      },
      observedRunning: true,
      detectStart: async () => ({ command: null, framework: 'other' }),
    });
    expect(target).not.toBeNull();
    const json = JSON.stringify(publicRemoteControlProject(target!, 'opaque-control-id'));
    expect(JSON.parse(json)).toEqual({
      controlId: 'opaque-control-id',
      name: 'Safe project',
      alias: null,
      workspaceRoot: null,
      branch: null,
      port: 9010,
      kind: 'main',
      status: 'running',
      actions: [
        'stop', 'restart', 'folder.open',
        'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
        'app.codex', 'app.hermes',
        'codex.thread.start',
        'localhost.open', 'orca.open',
      ],
    });
    for (const secret of ['internal-real-id', '/secret/path', 'bun run dev', 'folderPath', 'command']) {
      expect(json).not.toContain(secret);
    }
  });
  test('titles a card by its saved name and carries aiName only as the secondary alias', async () => {
    // The desktop project card titles rows by `name` and shows `aiName` as a
    // smaller "별명" line. Titling the phone card by aiName instead made 117 of
    // this Mac's 138 rows read as projects that do not exist locally.
    const target = await registeredRemoteControlTarget({
      row: { id: 'row-1', name: '헤르메스', aiName: 'Claude Agent Config', folderPath: '/projects/hermes' },
      observedRunning: null,
      detectStart: async () => ({ command: null, framework: 'other' }),
    });
    expect(target!.name).toBe('헤르메스');
    expect(target!.alias).toBe('Claude Agent Config');
    expect(publicRemoteControlProject(target!, 'opaque-control-id')).toMatchObject({
      name: '헤르메스',
      alias: 'Claude Agent Config',
    });
  });

  test('an aiName equal to the name, or a row with no name at all, produces no alias line', async () => {
    const same = await registeredRemoteControlTarget({
      row: { id: 'row-2', name: 'AgentsToZ_byCS', aiName: 'AgentsToZ_byCS', folderPath: '/projects/a' },
      observedRunning: null,
      detectStart: async () => ({ command: null, framework: 'other' }),
    });
    expect(same!.name).toBe('AgentsToZ_byCS');
    expect(same!.alias).toBeUndefined();

    // A row with only an aiName still needs a title, so the alias becomes it
    // rather than falling through to the generic placeholder.
    const aliasOnly = await registeredRemoteControlTarget({
      row: { id: 'row-3', aiName: 'Data Workflow Orchestration', folderPath: '/projects/b' },
      observedRunning: null,
      detectStart: async () => ({ command: null, framework: 'other' }),
    });
    expect(aliasOnly!.name).toBe('Data Workflow Orchestration');
    expect(aliasOnly!.alias).toBeUndefined();
  });

  test('publishes only the bounded workspace-root label and sorts names before pagination', async () => {
    const target = await registeredRemoteControlTarget({
      row: { id: 'row-root', name: '프로젝트 10', folderPath: '/private/product/app' },
      workspaceRootName: '제품 작업',
      observedRunning: null,
      detectStart: async () => ({ command: null, framework: 'other' }),
    });
    expect(publicRemoteControlProject(target!, 'opaque-control-id')).toMatchObject({
      name: '프로젝트 10',
      workspaceRoot: '제품 작업',
    });
    const serialized = JSON.stringify(publicRemoteControlProject(target!, 'opaque-control-id'));
    expect(serialized).not.toContain('/private/product');

    expect(sortRemoteControlTargetsByName([
      { internalId: 'ten', name: '프로젝트 10' },
      { internalId: 'two', name: '프로젝트 2' },
      { internalId: 'alpha', name: 'Alpha' },
    ]).map(target => target.internalId)).toEqual(['two', 'ten', 'alpha']);
  });
  test('orders every worktree card immediately after the project it belongs to', () => {
    // Discovered children are built after all main rows. Appended, they landed
    // past page 4 of the phone's 20-per-page list on a Mac with ~100 projects,
    // so the user saw no worktrees at all.
    const targets = [
      { internalId: 'a' }, { internalId: 'b' }, { internalId: 'c' },
      { internalId: 'a-wt1' }, { internalId: 'c-wt1' }, { internalId: 'a-wt2' },
    ];
    const parents = new Map([['a-wt1', 'a'], ['a-wt2', 'a'], ['c-wt1', 'c']]);
    expect(groupWorktreesUnderParents(targets, parents).map(t => t.internalId))
      .toEqual(['a', 'a-wt1', 'a-wt2', 'b', 'c', 'c-wt1']);
  });

  test('keeps a child whose parent is absent, and cannot lose or duplicate a card', () => {
    const targets = [{ internalId: 'a' }, { internalId: 'orphan' }, { internalId: 'a-wt' }];
    const parents = new Map([['orphan', 'gone'], ['a-wt', 'a']]);
    const ordered = groupWorktreesUnderParents(targets, parents);
    // A filtered-out parent must not take its child down with it.
    expect(ordered.map(t => t.internalId)).toEqual(['a', 'a-wt', 'orphan']);
    expect(ordered).toHaveLength(targets.length);

    // A self-referencing or cyclic link must terminate rather than recurse.
    const cyclic = groupWorktreesUnderParents(
      [{ internalId: 'x' }, { internalId: 'y' }],
      new Map([['x', 'y'], ['y', 'x']]),
    );
    expect(cyclic).toHaveLength(2);
    expect(new Set(cyclic.map(t => t.internalId))).toEqual(new Set(['x', 'y']));
  });
});
