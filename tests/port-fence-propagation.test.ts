import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { withoutLocallyDeletedRemotePorts } from '../src/portLocalDeletion';
import {
  isPortFenceDeletedError,
  portFenceMarkerIdsAddedThisAttempt,
  portFenceReferences,
  queryDeletedPortFencePropagation,
} from '../src/portFencePropagation';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiServerSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

function appSection(start: string, end: string): string {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`missing App section: ${start}`);
  return appSource.slice(from, to);
}

function fakeFenceClient(
  rows: Array<{ port_id: string; state: string }>,
  calls: string[][] = [],
) {
  return {
    from(table: string) {
      expect(table).toBe('portmgr_port_fences');
      return {
        select(columns: string) {
          expect(columns).toBe('port_id,state');
          return {
            async in(column: string, ids: readonly string[]) {
              expect(column).toBe('port_id');
              calls.push([...ids]);
              return { data: rows.filter(row => ids.includes(row.port_id)), error: null };
            },
          };
        },
      };
    },
  };
}

describe('cross-Mac deleted port fence propagation', () => {
  test('maps a deleted source row to both its source ID and every local clone ID', async () => {
    const local = [
      { id: 'local-clone', sourcePortId: 'remote-original' },
      { id: 'ordinary-local' },
    ];
    const result = await queryDeletedPortFencePropagation(fakeFenceClient([
      { port_id: 'remote-original', state: 'deleted' },
      { port_id: 'ordinary-local', state: 'active' },
    ]), local);

    expect(result).toEqual({
      available: true,
      queriedIds: ['local-clone', 'ordinary-local', 'remote-original'],
      activeFenceIds: ['ordinary-local'],
      deletedFenceIds: ['remote-original'],
      markerIds: ['local-clone', 'remote-original'],
    });
    expect(withoutLocallyDeletedRemotePorts(local, result.markerIds)).toEqual([
      { id: 'ordinary-local' },
    ]);
  });

  test('queries bounded chunks and strictly rejects forged, duplicate, or future states', async () => {
    const local = Array.from({ length: 205 }, (_, index) => ({ id: `port-${String(index).padStart(3, '0')}` }));
    const calls: string[][] = [];
    const result = await queryDeletedPortFencePropagation(fakeFenceClient([
      { port_id: 'port-204', state: 'deleted' },
    ], calls), local, 100);
    expect(calls.map(call => call.length)).toEqual([100, 100, 5]);
    expect(result.markerIds).toEqual(['port-204']);

    const invalid = fakeFenceClient([{ port_id: 'port-a', state: 'future' }]);
    await expect(queryDeletedPortFencePropagation(invalid, [{ id: 'port-a' }]))
      .rejects.toThrow('RESPONSE_INVALID');
    expect(() => portFenceReferences([{ id: 'local', sourcePortId: '' }]))
      .toThrow('SOURCE_ID_INVALID');
  });

  test('degrades only when the old database truly lacks the fence table', async () => {
    const missing = {
      from: () => ({
        select: () => ({
          in: async () => ({
            data: null,
            error: { code: '42P01', message: 'relation "public.portmgr_port_fences" does not exist' },
          }),
        }),
      }),
    };
    await expect(queryDeletedPortFencePropagation(missing, [{ id: 'port-a' }]))
      .resolves.toMatchObject({ available: false, markerIds: [] });

    const network = {
      from: () => ({ select: () => ({ in: async () => ({
        data: null, error: { message: 'network timeout' },
      }) }) }),
    };
    await expect(queryDeletedPortFencePropagation(network, [{ id: 'port-a' }]))
      .rejects.toThrow('QUERY_FAILED');
  });

  test('recognizes a nested durable RPC deleted-state race and nothing broader', () => {
    expect(isPortFenceDeletedError({
      message: 'PORT_DURABLE_FENCE_RPC_REJECTED',
      rpcError: { code: '55000', message: 'PORT_FENCE_DELETED', details: 'port-a' },
    })).toBe(true);
    expect(isPortFenceDeletedError({ code: '40001', message: 'PORT_FENCE_GENERATION_MISMATCH' }))
      .toBe(false);
  });

  test('a failed attempt rolls back only markers it added, preserving prior cross-Mac evidence', () => {
    const permanentMarkers = new Set(['deleted-on-other-mac', 'older-local-delete']);
    const rollbackIds = portFenceMarkerIdsAddedThisAttempt(
      ['deleted-on-other-mac', 'new-attempt', 'new-attempt'],
      [...permanentMarkers],
    );
    expect(rollbackIds).toEqual(['new-attempt']);

    for (const id of ['deleted-on-other-mac', 'new-attempt']) permanentMarkers.add(id);
    for (const id of rollbackIds) permanentMarkers.delete(id);
    expect([...permanentMarkers].sort()).toEqual([
      'deleted-on-other-mac',
      'older-local-delete',
    ]);
  });

  test('an active-check/remove race immediately restores a marker from the canonical deleted fence', async () => {
    const markers = new Set(['racing-port']);
    const before = await queryDeletedPortFencePropagation(
      fakeFenceClient([{ port_id: 'racing-port', state: 'active' }]),
      [{ id: 'racing-port' }],
    );
    expect(before.activeFenceIds).toEqual(['racing-port']);
    for (const id of before.activeFenceIds) markers.delete(id);

    // Another Mac commits deletion immediately after the active observation.
    const after = await queryDeletedPortFencePropagation(
      fakeFenceClient([{ port_id: 'racing-port', state: 'deleted' }]),
      [{ id: 'racing-port' }],
    );
    for (const id of after.markerIds) markers.add(id);
    expect([...markers]).toEqual(['racing-port']);
  });

  test('App propagates before Pull merge and before both Push RPCs without direct delete', () => {
    const startup = appSection('// Supabase 자동 Pull', '// workspace_roots 자동 Pull');
    const manualPull = appSection('const handleRestoreFromSupabase = async () =>', 'async function openPortsHistory()');
    const autoPush = appSection('// 자동 Push:', '// 포트 목록이 변경될 때마다 파일에 저장');
    const manualPush = appSection('const handlePushToSupabase = async () =>', '// 동시 실행 수 제한 풀');

    for (const pull of [startup, manualPull]) {
      expect(pull).toContain('discoverAndPersistDeletedPortFences');
      expect(pull).toContain('mergePortsForUpload(');
      expect(pull.indexOf('discoverAndPersistDeletedPortFences'))
        .toBeLessThan(pull.indexOf('mergePortsForUpload('));
    }
    for (const push of [autoPush, manualPush]) {
      expect(push).toContain('discoverAndPersistDeletedPortFences');
      expect(push.indexOf('discoverAndPersistDeletedPortFences'))
        .toBeLessThan(push.indexOf('upsertPortsWithDurableFence'));
      expect(push).not.toContain("from('portmgr_ports').delete(");
    }
    expect(autoPush).toContain('isPortFenceDeletedError');
    expect(manualPush).toContain('isPortFenceDeletedError');
  });

  test('startup treats fence discovery as remote Pull so an offline service does not hide local projects', () => {
    const startup = appSection('// Supabase 자동 Pull', '// 앱 시작 시 포트 상태 자동 확인');
    const remoteTry = startup.indexOf('try {', startup.indexOf('const supabase ='));
    const discovery = startup.indexOf('discoverAndPersistDeletedPortFences(');
    const remoteCatch = startup.indexOf('} catch (pullErr)', discovery);
    const localApply = startup.indexOf('const applied = await withPortalSafetyLease', remoteCatch);
    const stateApply = startup.indexOf('setPorts(updatedData)', localApply);

    expect(remoteTry).toBeGreaterThan(-1);
    expect(remoteTry).toBeLessThan(discovery);
    expect(discovery).toBeLessThan(remoteCatch);
    expect(startup.slice(remoteTry, remoteCatch)).toContain(
      'withTimeout(\n                discoverAndPersistDeletedPortFences(',
    );
    expect(startup.slice(remoteTry, remoteCatch)).toContain(
      "supabase.from('portmgr_workspace_roots').select('*').eq('device_id', deviceId)",
    );
    expect(remoteCatch).toBeLessThan(localApply);
    expect(startup.slice(remoteCatch, localApply)).toContain('supabaseAutoSyncReady = false');
    expect(localApply).toBeLessThan(stateApply);
    expect(startup.slice(localApply, stateApply)).toContain('withoutPortalDeletedPorts(');
  });

  test('App never rolls back preexisting permanent markers in orphan or snapshot failures', () => {
    const orphan = appSection('const deleteOrphanGroup = async', '// Quick-add project modal');
    const snapshot = appSection('async function restorePortsSnapshot', 'const handlePushToSupabase');

    expect(orphan.indexOf('loadAuthoritativePortalConfig()'))
      .toBeLessThan(orphan.indexOf("persistRemoteDeletedPortIds(ids, 'add')"));
    expect(orphan).toContain('portFenceMarkerIdsAddedThisAttempt(');
    expect(orphan).toContain('rollbackRejectedRemoteDeletionMarkers(markerIdsAddedThisAttempt)');
    expect(orphan).not.toContain("persistRemoteDeletedPortIds(ids, 'remove')");

    expect(snapshot.indexOf('loadAuthoritativePortalConfig()'))
      .toBeLessThan(snapshot.indexOf("persistRemoteDeletedPortIds(plannedDeleteIds, 'add')"));
    expect(snapshot).toContain('portFenceMarkerIdsAddedThisAttempt(');
    expect(snapshot).toContain('rollbackRejectedRemoteDeletionMarkers(plannedDeleteMarkerIdsAddedThisAttempt)');
    expect(snapshot).not.toContain("persistRemoteDeletedPortIds(plannedDeleteIds, 'remove')");
  });

  test('rejected deletion rollback requires active DB state then immediately re-discovers', () => {
    const rollback = appSection(
      'const rollbackRejectedRemoteDeletionMarkers = useCallback',
      '// A genuinely new local profile',
    );
    expect(rollback.indexOf('queryDeletedPortFencePropagation('))
      .toBeLessThan(rollback.indexOf("persistRemoteDeletedPortIds(rollbackIds, 'remove')"));
    expect(rollback).toContain('const activeIds = new Set(beforeRemove.activeFenceIds)');
    expect(rollback).toContain('const rollbackIds = uniqueAttemptIds.filter(id => activeIds.has(id))');
    expect(rollback.indexOf("persistRemoteDeletedPortIds(rollbackIds, 'remove')"))
      .toBeLessThan(rollback.indexOf('discoverAndPersistDeletedPortFences('));
    expect(rollback).not.toContain('withPortalSafetyLease');
  });

  test('local marker writes and DB mutations share the same cross-process portal lock ordering', () => {
    const acquire = apiServerSource.slice(
      apiServerSource.indexOf('async function acquirePortalSafetyLease()'),
      apiServerSource.indexOf('function portalDataFileSignature', apiServerSource.indexOf('async function acquirePortalSafetyLease()')),
    );
    const metadataMutation = apiServerSource.slice(
      apiServerSource.indexOf('if (url.pathname === "/api/portal/local-metadata"'),
      apiServerSource.indexOf('// Port visits:', apiServerSource.indexOf('if (url.pathname === "/api/portal/local-metadata"')),
    );
    expect(acquire).toContain('acquireOwnedFileLock(PORTAL_LOCK_FILE');
    expect(metadataMutation).toContain('withPortalFileLock(() => {');
    // Thus B either commits while owning the lock before A removes, or B sees
    // A's removal when it acquires later and fails its in-lease marker check.
    // Cross-Mac commits use the immediate second DB read and 30s poll backstop.
  });

  test('poll and RPC-race convergence add markers outside the lease and never auto-remove them', () => {
    const discovery = appSection(
      'const discoverAndPersistDeletedPortFences = useCallback',
      'const rollbackRejectedRemoteDeletionMarkers = useCallback',
    );
    const reconcile = appSection(
      'const reconcilePropagatedDeletedPorts = useCallback',
      '// A different Mac can delete a project',
    );
    const poll = appSection(
      '// A different Mac can delete a project',
      '// 30초 간격 워크트리 자동 폴링',
    );
    const autoPush = appSection('// 자동 Push:', '// 포트 목록이 변경될 때마다 파일에 저장');
    const manualPush = appSection('const handlePushToSupabase = async () =>', '// 동시 실행 수 제한 풀');

    expect(discovery).toContain("persistRemoteDeletedPortIds(newlyDiscovered.slice(index, index + 2_048), 'add')");
    expect(discovery).not.toContain("'remove'");
    expect(discovery).not.toContain('withPortalSafetyLease');
    expect(reconcile).toContain('withPortalSafetyLease');
    expect(reconcile).not.toContain('persistRemoteDeletedPortIds');
    expect(poll).toContain('setInterval(() => { void poll(); }, 30_000)');
    expect(poll.indexOf('discoverAndPersistDeletedPortFences('))
      .toBeLessThan(poll.indexOf('reconcilePropagatedDeletedPorts(config)'));

    for (const push of [autoPush, manualPush]) {
      const catchAt = push.indexOf('isPortFenceDeletedError');
      expect(catchAt).toBeGreaterThan(push.indexOf('withPortalSafetyLease'));
      expect(push.indexOf('discoverAndPersistDeletedPortFences', catchAt)).toBeGreaterThan(catchAt);
    }
  });
});
