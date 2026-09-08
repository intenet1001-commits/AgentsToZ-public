import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  deleteOrTombstonePortsWithDurableFence,
  PORT_DELETE_OR_TOMBSTONE_FENCE_RPC,
} from '../src/portDurableFence';
import { PORT_DURABLE_FENCE_SQL } from '../src/schemaSql';

const RPC_NAME = 'portmgr_delete_or_tombstone_ports_if_identity_matches';
const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

function functionDefinition(sql: string): string {
  const start = sql.toLowerCase().indexOf(`create or replace function public.${RPC_NAME}`);
  if (start < 0) throw new Error(`missing SQL function ${RPC_NAME}`);
  const end = sql.indexOf('$$;', start);
  if (end < 0) throw new Error(`unterminated SQL function ${RPC_NAME}`);
  return compact(sql.slice(start, end + 3));
}

describe('atomic mixed port delete/tombstone', () => {
  test('calls exactly one fail-closed RPC with the complete sorted identity batch', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await deleteOrTombstonePortsWithDurableFence({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return {
          data: [
            { id: 'absent', generation: '3' },
            { id: 'present', generation: '8' },
          ],
          error: null,
        };
      },
    }, [
      { id: 'present', device_id: 'device-a', name: 'Present', sync_generation: '7' },
      { id: 'absent', device_id: 'device-a', name: 'Absent', sync_generation: '2' },
    ], OPERATION_ID);

    expect(result).toEqual([
      { id: 'absent', generation: '3' },
      { id: 'present', generation: '8' },
    ]);
    expect(calls).toEqual([{
      name: RPC_NAME,
      args: {
        p_expected_rows: [
          { id: 'absent', device_id: 'device-a', name: 'Absent', sync_generation: '2' },
          { id: 'present', device_id: 'device-a', name: 'Present', sync_generation: '7' },
        ],
        p_deletion_op_id: OPERATION_ID,
      },
    }]);
  });

  test('missing mixed RPC is a hard stop with no direct or second-RPC fallback', async () => {
    let calls = 0;
    const pending = deleteOrTombstonePortsWithDurableFence({
      rpc: async name => {
        calls += 1;
        return {
          data: null,
          error: { code: 'PGRST202', message: `Could not find the function public.${name}` },
        };
      },
    }, [{ id: 'a', device_id: 'device-a', name: 'A', sync_generation: '0' }], OPERATION_ID);

    await expect(pending).rejects.toMatchObject({
      failure: 'unavailable',
      rpcName: RPC_NAME,
      mutationMayHaveCommitted: false,
    });
    expect(calls).toBe(1);
  });

  test('installer and migration use the same prevalidated mixed transaction', () => {
    const canonical = functionDefinition(PORT_DURABLE_FENCE_SQL);
    expect(canonical).toBe(functionDefinition(migration));

    const lock = canonical.indexOf('for v_port_id in select expected.id');
    const validate = canonical.indexOf('for v_expected in select expected.id');
    const remove = canonical.indexOf('delete from public.portmgr_ports port');
    const synthesize = canonical.indexOf('insert into public.portmgr_port_fences');
    expect(lock).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(lock);
    expect(remove).toBeGreaterThan(validate);
    expect(synthesize).toBeGreaterThan(validate);
    expect(canonical).toContain('order by expected.id');
    expect(canonical).toContain("v_fence.state<>'active'");
    expect(canonical).toContain('v_port.device_id is distinct from v_expected.device_id');
    expect(canonical).toContain('v_port.name is distinct from v_expected.name');
    expect(canonical).toContain('v_port.sync_generation is distinct from v_expected.sync_generation');
    expect(canonical).toContain('coalesce(v_fence.operation_base_generation,v_fence.generation - 1) is distinct from v_expected.sync_generation');
    expect(canonical).toContain('port_fence_active_without_port');
    expect(canonical).not.toContain('port_fence_delete_mixed_replay');
  });

  test('cleanup issues the mixed mutation once and has no partial/direct fallback', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const cleanup = app.slice(app.indexOf('const cleanupProject = async'), app.indexOf('const handleSaveMemo'));
    expect(cleanup.match(/deleteOrTombstonePortsWithDurableFence\(/g)).toHaveLength(1);
    expect(cleanup).not.toContain('tombstoneAbsentPortsWithDurableFence');
    expect(cleanup).not.toContain('deletePortsWithDurableFence');
    expect(cleanup).not.toMatch(/\.from\(['"]portmgr_ports['"]\)[\s\S]*?\.delete\(/);
  });

  test('exports the exact RPC contract name', () => {
    expect(PORT_DELETE_OR_TOMBSTONE_FENCE_RPC).toBe(RPC_NAME);
  });
});
