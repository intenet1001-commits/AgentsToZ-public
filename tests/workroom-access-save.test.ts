import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveWorkroomAccess, workroomHistoryDropNotice } from '../src/workroomAccessSave';
import { remoteTerminalHistoryGrantScope, type RemoteTerminalGrant } from '../src/remoteTerminalGrant';

// H4: the grant store replaces a grant whole. The Mac project panel's «워크룸 작업 허용» save does not edit history
// permission, so it must carry the one the Mac holds now — read fresh at save time — and drop it (fail-closed) when that
// cannot be read. Before, the save omitted `historyScopes` and silently turned the phone's history off.
const OWNER = 'internet:session-0001';
function mac(listing: (() => unknown) | null) {
  const bodies: Record<string, unknown>[] = [];
  const request = async (body: Record<string, unknown>) => {
    bodies.push(body);
    if (Object.keys(body).length === 0) { if (!listing) throw new Error('읽지 못했습니다.'); return listing(); }
    return { connections: [] };
  };
  return { request, bodies, saves: () => bodies.filter(b => Object.keys(b).length > 0) };
}
const save = { owner: OWNER, enabled: true, workspaceScopes: ['voice.use' as const], scope: { targetIds: ['target-0001'] } };
// The listing also names the scope the history permission was granted for (`historyGrantScope`, local listing only).
const connection = (historyScopes?: unknown, historyGrantScope: unknown = { targetIds: ['target-0001'] }) => ({ connections: [{ id: 'internet:other', historyScopes: ['history.read'], historyGrantScope: { targetIds: ['target-0001'] } }, { id: OWNER, ...(historyScopes === undefined ? {} : { historyScopes }), historyGrantScope }] });

describe('Mac project panel: Workroom access save keeps the phone history permission', () => {
  test('the saved history scopes are read fresh right before the save and carried unchanged', async () => {
    const m = mac(() => connection(['history.read', 'history.resume']));
    const { historyCarried } = await saveWorkroomAccess(m.request, save);
    expect(m.bodies[0]).toEqual({});
    expect(m.saves()).toEqual([{ owner: OWNER, enabled: true, rememberDevice: true, workspaceScopes: ['voice.use'], historyScopes: ['history.read', 'history.resume'], targetIds: ['target-0001'] }]);
    expect(historyCarried).toEqual(['history.read', 'history.resume']);
  });
  test('a device whose history is off now (another window just turned it off) gets none — the fresh read wins', async () => {
    const m = mac(() => connection([]));
    const { historyCarried } = await saveWorkroomAccess(m.request, { ...save, scope: { workspaceRootIds: ['root-0001'] } });
    expect(m.saves()).toEqual([{ owner: OWNER, enabled: true, rememberDevice: true, workspaceScopes: ['voice.use'], workspaceRootIds: ['root-0001'] }]);
    expect(historyCarried).toEqual([]);
  });
  test('fail-closed: an unreadable, absent or malformed current grant carries no history', async () => {
    for (const listing of [null, () => connection(undefined), () => connection(['history.resume']), () => connection(['history.read', 'records.read']),
      () => connection('history.read'), () => ({ connections: [] }), () => null]) {
      const m = mac(listing);
      const { historyCarried } = await saveWorkroomAccess(m.request, save);
      expect(m.saves()).toHaveLength(1);
      expect('historyScopes' in m.saves()[0]!).toBe(false);
      expect(historyCarried).toBeNull();
    }
  });
  test('when fail-closed drops a history permission the panel last saw, the person is told; otherwise nothing is said', () => {
    expect(workroomHistoryDropNotice(['history.read'], null)).toContain('대화 기록');
    for (const [previous, carried] of [[['history.read'], ['history.read']], [[], null], [undefined, null], [['history.read'], []]] as const)
      expect(workroomHistoryDropNotice(previous as any, carried as any)).toBeNull();
  });
  test('turning access off reads nothing and sends no history', async () => {
    const m = mac(() => connection(['history.read']));
    await saveWorkroomAccess(m.request, { ...save, enabled: false });
    expect(m.bodies).toEqual([{ owner: OWNER, enabled: false, rememberDevice: true, workspaceScopes: ['voice.use'], targetIds: ['target-0001'] }]);
  });
  test('the panel saves through this path only', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'AiTerminalPanel.tsx'), 'utf8');
    expect(source).not.toContain('rememberDevice:true');
    expect(source.split('saveWorkroomAccess(accessRequest,').length - 1).toBe(2);
  });
});

// Review F2: the QR dialog grants history inside a per-scope form. The panel's save replaces the scope with the panel's
// own project or folder, so carrying history there would hand it to a project nobody approved it for.
describe('Mac project panel: history is carried only within the scope it was granted for', () => {
  const read = ['history.read', 'history.resume'] as const;
  const carried = async (granted: unknown, scope: { targetIds: string[] } | { workspaceRootIds: string[] }) => {
    const m = mac(() => connection([...read], granted));
    const out = await saveWorkroomAccess(m.request, { ...save, scope });
    return { body: m.saves()[0]!, ...out };
  };
  test('another project: the history permission is not carried and the save says why', async () => {
    const out = await carried({ targetIds: ['target-A'] }, { targetIds: ['target-B'] });
    expect('historyScopes' in out.body).toBe(false);
    expect(out.historyCarried).toEqual([]);
    expect(out.historyScopeChanged).toBe(true);
    expect(workroomHistoryDropNotice(undefined, out.historyCarried, out.historyScopeChanged)).toContain('범위');
  });
  test('the same scope, or a narrower one of the same kind, keeps it', async () => {
    for (const [granted, scope] of [
      [{ targetIds: ['target-A'] }, { targetIds: ['target-A'] }],
      [{ targetIds: ['target-A', 'target-B'] }, { targetIds: ['target-B'] }],
      [{ workspaceRootIds: ['root-1'] }, { workspaceRootIds: ['root-1'] }],
    ] as const) {
      const out = await carried(granted, scope as any);
      expect(out.body.historyScopes).toEqual([...read]);
      expect(out.historyScopeChanged).toBe(false);
    }
  });
  test('a different kind, another folder, or an empty scope: not carried', async () => {
    for (const [granted, scope] of [
      [{ workspaceRootIds: ['root-1'] }, { targetIds: ['target-A'] }],
      [{ targetIds: ['target-A'] }, { workspaceRootIds: ['root-1'] }],
      [{ workspaceRootIds: ['root-1'] }, { workspaceRootIds: ['root-2'] }],
      [{ workspaceRootIds: [] }, { workspaceRootIds: ['root-1'] }],
      [{ targetIds: ['target-A'] }, { targetIds: [] }],
    ] as const) {
      const out = await carried(granted, scope as any);
      expect('historyScopes' in out.body).toBe(false);
      expect(out.historyScopeChanged).toBe(true);
    }
  });
  test('a listing that does not name the granted scope (a sidecar before it) is fail-closed', async () => {
    for (const granted of [undefined, null, 'target-A', { targetIds: 'target-A' }, { targetIds: ['target-A'], workspaceRootIds: ['root-1'] }]) {
      const m = mac(() => ({ connections: [{ id: OWNER, historyScopes: [...read], ...(granted === undefined ? {} : { historyGrantScope: granted }) }] }));
      const out = await saveWorkroomAccess(m.request, save);
      expect('historyScopes' in m.saves()[0]!).toBe(false);
      expect(out.historyCarried).toBeNull();
    }
  });
  test('the Mac names the granted scope from the stored grant; a folder whose identity changed is left out', () => {
    const base: RemoteTerminalGrant = { hostId: 'h', controllerId: 'internet:c', grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: 1, revokedAt: null,
      historyScopes: ['history.read'], scope: { kind: 'targets', targetIds: ['target-A'] } };
    const roots = [{ workspaceRootId: 'root-1', path: '/r1' }, { workspaceRootId: 'root-2', path: '/r2' }];
    const identity = (path: string) => { if (path === '/r2') throw new Error('gone'); return 'id:' + path; };
    expect(remoteTerminalHistoryGrantScope(base, roots, identity)).toEqual({ targetIds: ['target-A'] });
    expect(remoteTerminalHistoryGrantScope({ ...base, scope: { kind: 'controller-created-projects', workspaceRoots: [
      { workspaceRootId: 'root-1', identityHash: 'id:/r1' }, { workspaceRootId: 'root-2', identityHash: 'id:/r2' }, { workspaceRootId: 'root-3', identityHash: 'id:/r3' },
      { workspaceRootId: 'root-1b', identityHash: 'id:/other' }] } }, [...roots, { workspaceRootId: 'root-1b', path: '/r1' }], identity)).toEqual({ workspaceRootIds: ['root-1'] });
    // Nothing to carry, nothing named.
    expect(remoteTerminalHistoryGrantScope({ ...base, historyScopes: [] }, roots, identity)).toBeNull();
    expect(remoteTerminalHistoryGrantScope({ ...base, historyScopes: undefined }, roots, identity)).toBeNull();
  });
  test('the sidecar listing carries it (local management listing only)', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'api-server.ts'), 'utf8');
    expect(source).toContain('historyGrantScope:durable?remoteTerminalHistoryGrantScope(');
  });
});
