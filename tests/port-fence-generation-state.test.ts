import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applyPortFenceResultGenerations,
  resolveHistoricalSnapshotRows,
  retryPortFenceMutationAfterCommitUnknown,
} from '../src/portFenceGenerationState';
import { PortDurableFenceError } from '../src/portDurableFence';

describe('response-time local port generation state', () => {
  test('updates only generation on the latest row and never reinserts an in-flight removal', () => {
    type TestPort = {
      id: string;
      name: string;
      memo?: string;
      syncGeneration: string;
    };
    const latestA: TestPort = {
      id: 'port-a',
      name: 'renamed while push was in flight',
      memo: 'latest UI edit',
      syncGeneration: '4',
    };
    const untouched: TestPort = { id: 'port-c', name: 'C', syncGeneration: '9' };
    const otherPlatform = [{ id: 'remote-a', name: 'Other Mac', syncGeneration: '22' }];

    const applied = applyPortFenceResultGenerations(
      [latestA, untouched],
      otherPlatform,
      ['port-a', 'port-removed-during-request'],
      [
        { id: 'port-removed-during-request', generation: '1' },
        { id: 'port-a', generation: '5' },
      ],
    );

    expect(applied.changed).toBe(true);
    expect(applied.ports).toEqual([
      {
        id: 'port-a',
        name: 'renamed while push was in flight',
        memo: 'latest UI edit',
        syncGeneration: '5',
      },
      untouched,
    ]);
    expect(applied.ports[0]).not.toBe(latestA);
    expect(applied.ports[1]).toBe(untouched);
    expect(applied.ports.some(row => row.id === 'port-removed-during-request')).toBe(false);
    expect(applied.otherPlatformPorts).toBe(otherPlatform);
    expect(applied.otherPlatformPorts[0]).toBe(otherPlatform[0]);
  });

  test('returns identical arrays and objects when canonical generations are unchanged', () => {
    const port = { id: 'port-a', name: 'A', syncGeneration: '5' };
    const ports = [port];
    const otherPlatform = [{ id: 'other-a', name: 'Other' }];

    const applied = applyPortFenceResultGenerations(
      ports,
      otherPlatform,
      ['port-a'],
      [{ id: 'port-a', generation: 5 }],
    );

    expect(applied).toEqual({ ports, otherPlatformPorts: otherPlatform, changed: false });
    expect(applied.ports).toBe(ports);
    expect(applied.ports[0]).toBe(port);
    expect(applied.otherPlatformPorts).toBe(otherPlatform);
  });

  test('fails closed on partial, unexpected, duplicated, or ambiguous results', () => {
    const ports = [{ id: 'port-a', syncGeneration: '1' }];
    expect(() => applyPortFenceResultGenerations(
      ports, [], ['port-a', 'port-b'], [{ id: 'port-a', generation: '2' }],
    )).toThrow('RESULT_SET_MISMATCH');
    expect(() => applyPortFenceResultGenerations(
      ports, [], ['port-a'], [{ id: 'port-b', generation: '2' }],
    )).toThrow('RESULT_SET_MISMATCH');
    expect(() => applyPortFenceResultGenerations(
      ports, [], ['port-a', 'port-b'], [
        { id: 'port-a', generation: '2' },
        { id: 'port-a', generation: '2' },
      ],
    )).toThrow('DUPLICATE_RESULT_ID:port-a');
    expect(() => applyPortFenceResultGenerations(
      [{ id: 'port-a', syncGeneration: '1' }, { id: 'port-a', syncGeneration: '1' }],
      [],
      ['port-a'],
      [{ id: 'port-a', generation: '2' }],
    )).toThrow('DUPLICATE_LOCAL_ID:port-a');
  });

  test('keeps PostgreSQL bigint generations exact', () => {
    const applied = applyPortFenceResultGenerations(
      [{ id: 'port-a', syncGeneration: '1' }],
      [],
      ['port-a'],
      [{ id: 'port-a', generation: '9223372036854775807' }],
    );
    expect(applied.ports[0]?.syncGeneration).toBe('9223372036854775807');
  });
});

describe('commit-unknown durable RPC retry', () => {
  test('retries once with the caller-owned operation after an ambiguous response', async () => {
    let calls = 0;
    const operationId = 'same-operation-id';
    const seenOperationIds: string[] = [];
    const result = await retryPortFenceMutationAfterCommitUnknown(async () => {
      calls += 1;
      seenOperationIds.push(operationId);
      if (calls === 1) {
        throw new PortDurableFenceError(
          'invalid-response',
          'portmgr_upsert_ports_if_generation_matches',
          'response lost',
          null,
          true,
        );
      }
      return [{ id: 'port-a', generation: '2' }];
    });

    expect(result).toEqual([{ id: 'port-a', generation: '2' }]);
    expect(calls).toBe(2);
    expect(seenOperationIds).toEqual([operationId, operationId]);
  });

  test('does not retry a known rejection and never makes a third attempt', async () => {
    let rejectedCalls = 0;
    const knownRejection = new PortDurableFenceError(
      'rejected',
      'portmgr_upsert_ports_if_generation_matches',
      'generation conflict',
      null,
      false,
    );
    await expect(retryPortFenceMutationAfterCommitUnknown(async () => {
      rejectedCalls += 1;
      throw knownRejection;
    })).rejects.toBe(knownRejection);
    expect(rejectedCalls).toBe(1);

    let ambiguousCalls = 0;
    const ambiguous = new PortDurableFenceError(
      'invalid-response',
      'portmgr_upsert_ports_if_generation_matches',
      'response lost twice',
      null,
      true,
    );
    await expect(retryPortFenceMutationAfterCommitUnknown(async () => {
      ambiguousCalls += 1;
      throw ambiguous;
    })).rejects.toBe(ambiguous);
    expect(ambiguousCalls).toBe(2);
  });
});

describe('historical snapshot generation resolution', () => {
  test('uses live active generation, initializes unseen IDs at zero, and skips deleted fences', () => {
    const snapshots = [
      { id: 'active', name: 'historical name', memo: 'keep bytes', sync_generation: '1' },
      { id: 'unseen', name: 'new from snapshot', sync_generation: '87' },
      { id: 'deleted', name: 'must stay gone', sync_generation: '2' },
    ];

    const resolved = resolveHistoricalSnapshotRows(
      snapshots,
      [{ id: 'active', sync_generation: '9' }],
      [
        { port_id: 'active', generation: '9', state: 'active' },
        { port_id: 'deleted', generation: '3', state: 'deleted' },
      ],
    );

    expect(resolved.rows).toEqual([
      { id: 'active', name: 'historical name', memo: 'keep bytes', sync_generation: '9' },
      { id: 'unseen', name: 'new from snapshot', sync_generation: '0' },
    ]);
    expect(resolved.skippedDeletedIds).toEqual(['deleted']);
    expect(resolved.rows.some(row => row.id === 'deleted')).toBe(false);
  });

  test('returns the original snapshot array on a true generation no-op', () => {
    const snapshots = [{ id: 'active', name: 'A', sync_generation: '9' }];
    const resolved = resolveHistoricalSnapshotRows(
      snapshots,
      [{ id: 'active', sync_generation: '9' }],
      [{ port_id: 'active', generation: '9', state: 'active' }],
    );
    expect(resolved.rows).toBe(snapshots);
    expect(resolved.rows[0]).toBe(snapshots[0]);
    expect(resolved.skippedDeletedIds).toEqual([]);
  });

  test('fails closed when remote row and fence state are inconsistent', () => {
    const snapshot = [{ id: 'port-a', name: 'A', sync_generation: '1' }];

    expect(() => resolveHistoricalSnapshotRows(
      snapshot,
      [],
      [{ port_id: 'port-a', generation: '2', state: 'active' }],
    )).toThrow('ACTIVE_FENCE_WITHOUT_REMOTE_ROW:port-a');

    expect(() => resolveHistoricalSnapshotRows(
      snapshot,
      [{ id: 'port-a', sync_generation: '2' }],
      [],
    )).toThrow('REMOTE_ROW_WITHOUT_FENCE:port-a');

    expect(() => resolveHistoricalSnapshotRows(
      snapshot,
      [{ id: 'port-a', sync_generation: '2' }],
      [{ port_id: 'port-a', generation: '3', state: 'active' }],
    )).toThrow('REMOTE_FENCE_GENERATION_MISMATCH:port-a');

    expect(() => resolveHistoricalSnapshotRows(
      snapshot,
      [{ id: 'port-a', sync_generation: '2' }],
      [{ port_id: 'port-a', generation: '3', state: 'deleted' }],
    )).toThrow('DELETED_FENCE_WITH_REMOTE_ROW:port-a');
  });

  test('rejects duplicate snapshot, remote, and fence identities before resolving', () => {
    expect(() => resolveHistoricalSnapshotRows(
      [{ id: 'a', sync_generation: '0' }, { id: 'a', sync_generation: '0' }],
      [],
      [],
    )).toThrow('DUPLICATE_SNAPSHOT_ID:a');
    expect(() => resolveHistoricalSnapshotRows(
      [{ id: 'a', sync_generation: '0' }],
      [{ id: 'a', sync_generation: '0' }, { id: 'a', sync_generation: '0' }],
      [{ port_id: 'a', generation: '0', state: 'active' }],
    )).toThrow('DUPLICATE_REMOTE_ID:a');
    expect(() => resolveHistoricalSnapshotRows(
      [{ id: 'a', sync_generation: '0' }],
      [{ id: 'a', sync_generation: '0' }],
      [
        { port_id: 'a', generation: '0', state: 'active' },
        { port_id: 'a', generation: '0', state: 'active' },
      ],
    )).toThrow('DUPLICATE_FENCE_ID:a');
  });
});

describe('App durable upsert generation wiring', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  test('persists generation-only state before synchronizing refs and React state', () => {
    const start = app.indexOf('const persistCommittedPortFenceGenerations = useCallback');
    const end = app.indexOf('const portStatusPollBusyRef', start);
    const body = app.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('applyPortFenceResultGenerations(');
    expect(body).toContain('if (!applied.changed) return;');
    expect(body.indexOf('await API.savePorts([')).toBeLessThan(body.indexOf('portsRef.current = nextPorts'));
    expect(body.indexOf('portsRef.current = nextPorts')).toBeLessThan(body.indexOf('setPorts(nextPorts)'));
    expect(body).toContain('otherPlatformPortsRef.current !== currentOtherPlatformPorts');
  });

  test('auto Push retries with one stable operation ID and applies the result', () => {
    const start = app.indexOf('// 자동 Push:');
    const end = app.indexOf('// 포트 목록이 변경될 때마다 파일에 저장', start);
    const body = app.slice(start, end);
    const operation = body.indexOf('const operationId = crypto.randomUUID()');
    const retry = body.indexOf('retryPortFenceMutationAfterCommitUnknown');
    const apply = body.indexOf('persistCommittedPortFenceGenerations');
    expect(operation).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(operation);
    expect(apply).toBeGreaterThan(retry);
    expect(body).toContain('rows as PortFenceUpsertRow[],\n              operationId');
  });

  test('manual Push snapshots only the post-commit generations', () => {
    const start = app.indexOf('const handlePushToSupabase = async');
    const end = app.indexOf('async function runWithLimit', start);
    const body = app.slice(start, end);
    const operation = body.indexOf('const operationId = crypto.randomUUID()');
    const retry = body.indexOf('retryPortFenceMutationAfterCommitUnknown');
    const apply = body.indexOf('await persistCommittedPortFenceGenerations');
    const snapshot = body.indexOf('await savePushSnapshot(');
    expect(operation).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(operation);
    expect(apply).toBeGreaterThan(retry);
    expect(snapshot).toBeGreaterThan(apply);
    expect(body.slice(apply, snapshot)).toContain('generationResults.map(result => [result.id, result.generation])');
    expect(body.slice(snapshot)).toContain('sync_generation: generationById.get(row.id)!');
  });
});
