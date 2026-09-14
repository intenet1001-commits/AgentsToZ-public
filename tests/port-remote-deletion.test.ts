import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  localDeletionTargetIds,
  remoteDeletionCandidates,
  verifiedRemoteDeletionIds,
} from '../src/portRemoteDeletion';

describe('remote port deletion authority', () => {
  test('maps a cross-device clone back to its original row and verifies server identity', () => {
    const candidates = remoteDeletionCandidates([{
      id: 'local-clone',
      name: 'Project',
      sourceDeviceId: 'device-b',
      syncGeneration: '0',
      sourcePortId: 'remote-original',
      sourcePortDeviceId: 'device-b',
      sourcePortSyncGeneration: '4',
    }], 'device-a');
    expect(candidates.map(item => item.id).sort()).toEqual(['local-clone', 'remote-original']);
    expect(verifiedRemoteDeletionIds(candidates, [{
      id: 'remote-original', device_id: 'device-b', name: 'Project', sync_generation: '4',
    }])).toEqual(['remote-original']);
  });

  test('a forged sourcePortId cannot delete a third-party row', () => {
    const candidates = remoteDeletionCandidates([{
      id: 'local',
      name: 'Expected',
      syncGeneration: '0',
      sourcePortId: 'victim',
      sourcePortDeviceId: 'device-source',
      sourcePortSyncGeneration: '3',
    }], 'device-local');
    expect(() => verifiedRemoteDeletionIds(candidates, [{
      id: 'victim', device_id: 'device-other', name: 'Victim', sync_generation: '3',
    }])).toThrow('REMOTE_PORT_DELETE_IDENTITY_MISMATCH:victim');
  });

  test('does not authorize a legacy source ID whose source device was never captured', () => {
    const candidates = remoteDeletionCandidates([{
      id: 'local', name: 'Project', sourceDeviceId: 'device-local', sourcePortId: 'unknown-source',
    }], 'device-local');
    expect(candidates.map(item => item.id)).toEqual(['local']);
  });

  test('fails closed for a legacy cross-device clone without its original row identity', () => {
    expect(() => localDeletionTargetIds([{
      id: 'local-random', name: 'Project', sourceDeviceId: 'device-b',
    }], 'device-a')).toThrow('REMOTE_PORT_DELETE_SOURCE_IDENTITY_INCOMPLETE:local-random');
  });

  test('tombstones both IDs only when a cross-device source identity is complete', () => {
    expect(localDeletionTargetIds([{
      id: 'local-random',
      name: 'Project',
      sourceDeviceId: 'device-b',
      sourcePortId: 'remote-original',
      sourcePortDeviceId: 'device-b',
      sourcePortSyncGeneration: '0',
    }], 'device-a')).toEqual(['local-random', 'remote-original']);
  });

  test('an old generated child cannot duplicate its parent source candidate', () => {
    const family = [{
      id: 'local-parent',
      name: 'Project',
      sourceDeviceId: 'device-b',
      sourcePortId: 'remote-original',
      sourcePortDeviceId: 'device-b',
      sourcePortSyncGeneration: '0',
    }, {
      id: 'local-parent_wt_feature',
      name: 'Project (feature)',
      worktreeParentId: 'local-parent',
      sourceDeviceId: 'device-b',
      sourcePortId: 'remote-original',
      sourcePortDeviceId: 'device-b',
      sourcePortSyncGeneration: '0',
    }];
    const candidates = remoteDeletionCandidates(family, 'device-a');
    expect(candidates.map(item => item.id).sort()).toEqual([
      'local-parent',
      'local-parent_wt_feature',
      'remote-original',
    ]);
    expect(localDeletionTargetIds(family, 'device-a')).toEqual([
      'local-parent',
      'remote-original',
      'local-parent_wt_feature',
    ]);
  });

  test('a stale pre-restore generation cannot authorize deletion of the restored row', () => {
    const candidates = remoteDeletionCandidates([{
      id: 'local-clone',
      name: 'Project',
      sourceDeviceId: 'device-b',
      sourcePortId: 'remote-original',
      sourcePortDeviceId: 'device-b',
      sourcePortSyncGeneration: '4',
    }], 'device-a');
    expect(() => verifiedRemoteDeletionIds(candidates, [{
      id: 'remote-original',
      device_id: 'device-b',
      name: 'Project',
      sync_generation: '6',
    }])).toThrow('REMOTE_PORT_DELETE_IDENTITY_MISMATCH:remote-original');
  });

  test('the destructive path uses one atomic mixed fence call without a partial or direct fallback', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const cleanup = source.slice(source.indexOf('const cleanupProject = async'), source.indexOf('const handleSaveMemo'));
    expect(cleanup).toContain('await withPortalSafetyLease(cfg, async lease => {');
    expect(cleanup).toContain('deletion.localDeletionIds.some(id => !tombstones.has(id))');
    expect(cleanup).toContain('device_id: candidate.expectedDeviceId');
    expect(cleanup).toContain('name: candidate.expectedName');
    expect(cleanup).toContain('sync_generation: candidate.expectedGeneration');
    expect(cleanup).toContain('const expectedRows = candidates.map(expected)');
    expect(cleanup.match(/deleteOrTombstonePortsWithDurableFence\(/g)).toHaveLength(1);
    expect(cleanup).toMatch(/deleteOrTombstonePortsWithDurableFence\(\s*supabase,\s*expectedRows,\s*operationId,?\s*\)/);
    expect(cleanup).toMatch(/error instanceof PortDurableFenceError\s*&&\s*error\.mutationMayHaveCommitted/);
    expect(cleanup).toContain('if (!remoteMutationMayHaveOccurred)');
    expect(cleanup.indexOf('const authoritativeBeforeMarker = await loadAuthoritativePortalConfig()'))
      .toBeLessThan(cleanup.indexOf("await persistDeletionMarker(deletion.localDeletionIds, 'add')"));
    expect(cleanup).toContain('remoteDeletionMarkerIdsAddedThisAttempt = portFenceMarkerIdsAddedThisAttempt(');
    expect(cleanup).toMatch(/rollbackRejectedRemoteDeletionMarkers\(\s*remoteDeletionMarkerIdsAddedThisAttempt,?\s*\)/);
    const rollback = source.slice(
      source.indexOf('const rollbackRejectedRemoteDeletionMarkers = useCallback'),
      source.indexOf('// A genuinely new local profile'),
    );
    expect(rollback).toContain('const activeIds = new Set(beforeRemove.activeFenceIds)');
    expect(rollback).toContain('const rollbackIds = uniqueAttemptIds.filter(id => activeIds.has(id))');
    expect(rollback.indexOf("persistRemoteDeletedPortIds(rollbackIds, 'remove')"))
      .toBeLessThan(rollback.indexOf('discoverAndPersistDeletedPortFences('));
    expect(rollback).not.toContain('withPortalSafetyLease');
    expect(cleanup).not.toContain("persistRemoteDeletedPortIds(remoteDeletionMarkerIdsAddedThisAttempt, 'remove')");
    expect(cleanup).not.toContain("persistRemoteDeletedPortIds(deletion.localDeletionIds, 'remove')");
    expect(cleanup).not.toContain('tombstoneAbsentPortsWithDurableFence');
    expect(cleanup).not.toContain('deletePortsWithDurableFence');
    expect(cleanup).not.toContain(".select('id,device_id,name,sync_generation')");
    expect(cleanup).not.toContain(".from('portmgr_ports')\n                .delete()");
  });
});
