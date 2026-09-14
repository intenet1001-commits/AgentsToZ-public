import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildPortSnapshotRestoreRpcArgs,
  freezePortSnapshotRestorePreflight,
  parsePortSnapshotRestoreResults,
  PORT_SNAPSHOT_RESTORE_FENCE_RPC,
  PortDurableFenceError,
  restorePortsSnapshotWithDurableFence,
} from '../src/portDurableFence';
import { PORT_DURABLE_FENCE_SQL } from '../src/schemaSql';

const UPSERT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DELETE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const migration = readFileSync(new URL(
  '../supabase/migrations/20260830020000_port_durable_fence.sql',
  import.meta.url,
), 'utf8');

function compact(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\(/g, '(')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*(\|\||<>|>=|<=|:=|!~|::|=|>|<)\s*/g, '$1')
    .trim()
    .toLowerCase();
}

function definition(sql: string): string {
  const name = 'portmgr_restore_ports_snapshot_if_preflight_matches';
  const start = sql.toLowerCase().indexOf(`create or replace function public.${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = sql.indexOf('$$;', start);
  if (end < 0) throw new Error(`unterminated ${name}`);
  return compact(sql.slice(start, end + 3));
}

const operationIds = {
  upsert: UPSERT_ID,
  delete: DELETE_ID,
};

describe('atomic durable snapshot restore contract', () => {
  test('freezes current generations, exact extras, deleted fences, and device ownership', () => {
    const frozen = freezePortSnapshotRestorePreflight('device-a', [
      'restore-existing',
      'restore-absent',
      'restore-deleted',
    ], [
      {
        id: 'restore-existing', device_id: 'device-a', name: 'Current', sync_generation: 7,
      },
      { id: 'extra', device_id: 'device-a', name: 'Extra', sync_generation: '3' },
    ], [
      {
        port_id: 'restore-existing', generation: '7', state: 'active', owner_device_id: 'device-a',
      },
      { port_id: 'extra', generation: 3, state: 'active', owner_device_id: 'device-a' },
      {
        port_id: 'restore-deleted', generation: '11', state: 'deleted', owner_device_id: 'device-a',
      },
    ]);

    expect([...frozen.expectedGenerationById]).toEqual([
      ['restore-existing', '7'],
      ['restore-absent', null],
      ['restore-deleted', null],
    ]);
    expect(frozen.exactExtraRows).toEqual([
      { id: 'extra', device_id: 'device-a', name: 'Extra', sync_generation: '3' },
    ]);
    expect(frozen.deletedSnapshotIds).toEqual(['restore-deleted']);

    expect(() => freezePortSnapshotRestorePreflight('device-a', ['missing'], [], [{
      port_id: 'missing', generation: '0', state: 'active', owner_device_id: 'device-a',
    }])).toThrow('ACTIVE_FENCE_WITHOUT_CURRENT:missing');
    expect(() => freezePortSnapshotRestorePreflight('device-a', ['gone'], [], [{
      port_id: 'gone', generation: '2', state: 'deleted', owner_device_id: 'device-b',
    }])).toThrow('OWNER_MISMATCH:gone');
    expect(() => freezePortSnapshotRestorePreflight('device-a', ['current'], [{
      id: 'current', device_id: 'device-a', name: 'Current', sync_generation: '4',
    }], [{
      port_id: 'current', generation: '5', state: 'active', owner_device_id: 'device-a',
    }])).toThrow('CURRENT_GENERATION_MISMATCH:current');
  });

  test('keeps historical bytes separate from current generation authority', () => {
    expect(buildPortSnapshotRestoreRpcArgs('device-a', [
      {
        row: { id: 'z', device_id: 'device-a', name: 'Old Z', memo: 'snapshot' },
        expected_generation: 7,
      },
      {
        row: { id: 'a', device_id: 'device-a', name: 'Old A' },
        expected_generation: null,
      },
    ], [
      { id: 'm', device_id: 'device-a', name: 'Extra', sync_generation: 9n },
    ], operationIds)).toEqual({
      p_device_id: 'device-a',
      p_restore_rows: [
        {
          row: { id: 'a', device_id: 'device-a', name: 'Old A' },
          expected_generation: null,
        },
        {
          row: { id: 'z', device_id: 'device-a', name: 'Old Z', memo: 'snapshot' },
          expected_generation: '7',
        },
      ],
      p_exact_extra_rows: [
        { id: 'm', device_id: 'device-a', name: 'Extra', sync_generation: '9' },
      ],
      p_upsert_op_id: UPSERT_ID,
      p_delete_op_id: DELETE_ID,
    });

    expect(() => buildPortSnapshotRestoreRpcArgs('device-a', [{
      row: {
        id: 'a', device_id: 'device-a', name: 'A', sync_generation: '2',
      },
      expected_generation: '7',
    }], [], operationIds)).toThrow('STORED_GENERATION_FORBIDDEN');
  });

  test('rejects cross-scope IDs, overlap, and operation UUID reuse before the network', () => {
    expect(() => buildPortSnapshotRestoreRpcArgs('device-a', [{
      row: { id: 'a', device_id: 'device-b', name: 'A' }, expected_generation: null,
    }], [], operationIds)).toThrow('DEVICE_SCOPE_MISMATCH');

    expect(() => buildPortSnapshotRestoreRpcArgs('device-a', [{
      row: { id: 'a', device_id: 'device-a', name: 'A' }, expected_generation: null,
    }], [{
      id: 'a', device_id: 'device-a', name: 'A', sync_generation: '0',
    }], operationIds)).toThrow('DUPLICATE_ID:a');

    expect(() => buildPortSnapshotRestoreRpcArgs('device-a', [], [], {
      upsert: UPSERT_ID,
      delete: UPSERT_ID,
    })).toThrow('OPERATION_IDS_NOT_DISTINCT');
  });

  test('uses exactly one RPC and validates result membership and outcomes', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await restorePortsSnapshotWithDurableFence({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return {
          data: [
            { id: 'restore', generation: '8', outcome: 'restored' },
            { id: 'gone', generation: '5', outcome: 'skipped_deleted' },
            { id: 'extra', generation: '3', outcome: 'deleted_extra' },
          ],
          error: null,
        };
      },
    }, 'device-a', [
      {
        row: { id: 'restore', device_id: 'device-a', name: 'Restore' },
        expected_generation: '7',
      },
      {
        row: { id: 'gone', device_id: 'device-a', name: 'Gone' },
        expected_generation: null,
      },
    ], [
      { id: 'extra', device_id: 'device-a', name: 'Extra', sync_generation: '2' },
    ], operationIds);

    expect(result).toEqual([
      { id: 'restore', generation: '8', outcome: 'restored' },
      { id: 'gone', generation: '5', outcome: 'skipped_deleted' },
      { id: 'extra', generation: '3', outcome: 'deleted_extra' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(PORT_SNAPSHOT_RESTORE_FENCE_RPC);

    expect(() => parsePortSnapshotRestoreResults([
      { id: 'restore', generation: '8', outcome: 'deleted_extra' },
    ], ['restore'], [])).toThrow('INVALID_SNAPSHOT_RPC_RESULT');
    expect(() => parsePortSnapshotRestoreResults([], ['restore'], []))
      .toThrow('INVALID_SNAPSHOT_RPC_RESULT');
  });

  test('missing or malformed wrapper results fail closed without a split fallback', async () => {
    let calls = 0;
    const request = [{
      row: { id: 'a', device_id: 'device-a', name: 'A' }, expected_generation: null,
    }] as const;
    const missing = restorePortsSnapshotWithDurableFence({
      rpc: async name => {
        calls += 1;
        return {
          data: null,
          error: { code: 'PGRST202', message: `Could not find the function public.${name}` },
        };
      },
    }, 'device-a', request, [], operationIds);
    await expect(missing).rejects.toMatchObject({
      failure: 'unavailable',
      rpcName: PORT_SNAPSHOT_RESTORE_FENCE_RPC,
      mutationMayHaveCommitted: false,
    });
    expect(calls).toBe(1);

    const malformed = restorePortsSnapshotWithDurableFence({
      rpc: async () => ({ data: [], error: null }),
    }, 'device-a', request, [], operationIds);
    await expect(malformed).rejects.toBeInstanceOf(PortDurableFenceError);
    await expect(malformed).rejects.toMatchObject({ mutationMayHaveCommitted: true });
  });

  test('installer and migration share one scoped transaction wrapper', () => {
    const canonical = definition(PORT_DURABLE_FENCE_SQL);
    expect(canonical).toBe(definition(migration));
    expect(canonical).toContain('portmgr_is_member()');
    expect(canonical).toContain('port_fence_snapshot_operation_ids_not_distinct');
    expect(canonical).toContain("jsonb_typeof(v_item ->'expected_generation') not in('string','null')");
    expect(canonical).toContain("where supplied.field_name not in('id','device_id','device_name'");

    const lock = canonical.indexOf("pg_advisory_xact_lock(hashtextextended('portmgr-port-fence:'||v_port_id,0))");
    const classify = canonical.indexOf("v_fence.state='deleted'");
    const upsert = canonical.indexOf('from public.portmgr_upsert_ports_if_generation_matches(');
    const remove = canonical.indexOf('from public.portmgr_delete_or_tombstone_ports_if_identity_matches(');
    expect(lock).toBeGreaterThan(-1);
    expect(classify).toBeGreaterThan(lock);
    expect(upsert).toBeGreaterThan(classify);
    expect(remove).toBeGreaterThan(upsert);
    expect(canonical).not.toContain('delete from public.portmgr_ports');
    expect(canonical).not.toContain('insert into public.portmgr_ports');
    expect(canonical).not.toContain('commit');
    expect(canonical).not.toContain('exception when');

    // expected-absent is not equivalent to active generation zero. Only this
    // child operation's exact bounded replay metadata may pass after a lost response.
    expect(canonical).toContain('v_fence.operation_id=p_upsert_op_id');
    expect(canonical).toContain('v_fence.operation_base_generation is not distinct from coalesce(v_expected_generation,0)');
    expect(canonical).toContain('v_fence.operation_payload_sha256 is not distinct from v_payload_sha256');
    expect(canonical).toContain('port_fence_snapshot_concurrent_appearance');
    expect(canonical).toContain("'skipped_deleted'::text");
    expect(canonical).toContain("'deleted_extra'::text");
    expect(canonical).toContain("'restored'::text");

    // No device/global membership scan means unrelated rows created after
    // preflight are outside this request and therefore preserved.
    expect(canonical).not.toContain("'portmgr-device-scope:");
    expect(canonical).not.toContain('portmgr_snapshot_restore_operations');
  });

  test('wrapper execute privilege is explicit and direct fallback is absent', () => {
    const signature = 'portmgr_restore_ports_snapshot_if_preflight_matches(text, jsonb, jsonb, uuid, uuid)';
    expect(PORT_DURABLE_FENCE_SQL).toContain(
      `revoke all on function public.${signature}\n  from public, anon, authenticated, service_role`,
    );
    expect(PORT_DURABLE_FENCE_SQL).toContain(
      `grant execute on function public.${signature}\n  to authenticated, service_role`,
    );
    expect(PORT_SNAPSHOT_RESTORE_FENCE_RPC)
      .toBe('portmgr_restore_ports_snapshot_if_preflight_matches');
  });

  test('App freezes one request, retries the same child UUIDs, then Pulls', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const restore = source.slice(
      source.indexOf('async function restorePortsSnapshot'),
      source.indexOf('const handlePushToSupabase'),
    );
    const firstLease = restore.indexOf('withPortalSafetyLease(cfg');
    const marker = restore.indexOf("persistRemoteDeletedPortIds(plannedDeleteIds, 'add')");
    const secondLease = restore.indexOf('withPortalSafetyLease(cfg', firstLease + 1);
    const operationIds = restore.indexOf('const snapshotOperationIds = {');
    const retry = restore.indexOf('retryPortFenceMutationAfterCommitUnknown');
    const wrapper = restore.indexOf('restorePortsSnapshotWithDurableFence(');
    const pull = restore.indexOf('await handleRestoreFromSupabase()');

    expect(restore).toContain(".select('port_id,generation,state,owner_device_id')");
    expect(restore).toContain('freezePortSnapshotRestorePreflight(');
    expect(firstLease).toBeLessThan(marker);
    expect(marker).toBeLessThan(secondLease);
    expect(operationIds).toBeLessThan(retry);
    expect(retry).toBeLessThan(wrapper);
    expect(wrapper).toBeLessThan(pull);
    expect(restore).toContain('snapshotOperationIds,');
    expect(restore).toContain('error.mutationMayHaveCommitted');
    expect(restore).toContain("result.outcome === 'skipped_deleted'");
    expect(restore).toContain('persistRemoteDeletedPortIds(restoreResult.transactionSkippedDeletedIds');
    expect(restore).not.toContain('await upsertPortsWithDurableFence(');
    expect(restore).not.toContain('await deletePortsWithDurableFence(');
    expect(restore).not.toContain(".from('portmgr_ports')\n            .delete()");
  });
});
