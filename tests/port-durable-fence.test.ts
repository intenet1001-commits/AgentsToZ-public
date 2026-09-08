import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildPortDeletionRpcArgs,
  buildPortRestoreRpcArgs,
  buildPortUpsertRpcArgs,
  deletePortsWithDurableFence,
  parsePortFenceResults,
  portFenceGeneration,
  PORT_DELETE_FENCE_RPC,
  PORT_RESTORE_FENCE_RPC,
  PORT_TOMBSTONE_ABSENT_FENCE_RPC,
  PORT_UPSERT_FENCE_RPC,
  PortDurableFenceError,
  restorePortWithDurableFence,
  tombstoneAbsentPortsWithDurableFence,
  upsertPortsWithDurableFence,
} from '../src/portDurableFence';
import {
  MIGRATION_SQL,
  PORT_DURABLE_FENCE_SQL,
  PORT_DURABLE_FENCE_TABLES,
  PORTMGR_TABLES,
} from '../src/schemaSql';

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

function functionDefinition(sql: string, name: string): string {
  const start = sql.toLowerCase().indexOf(`create or replace function public.${name.toLowerCase()}`);
  if (start < 0) throw new Error(`missing SQL function ${name}`);
  const end = sql.indexOf('$$;', start);
  if (end < 0) throw new Error(`unterminated SQL function ${name}`);
  return compact(sql.slice(start, end + 3));
}

function body(name: string): string {
  return functionDefinition(PORT_DURABLE_FENCE_SQL, name);
}

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('durable Supabase port fence SQL', () => {
  test('keeps the installer and versioned migration function contracts identical', () => {
    for (const name of [
      'portmgr_enforce_port_fence_write',
      'portmgr_tombstone_port_fence_on_delete',
      'portmgr_upsert_ports_if_generation_matches',
      'portmgr_delete_ports_if_identity_matches',
      'portmgr_delete_or_tombstone_ports_if_identity_matches',
      'portmgr_tombstone_absent_ports',
      'portmgr_restore_port_if_generation_matches',
    ]) {
      expect(functionDefinition(PORT_DURABLE_FENCE_SQL, name))
        .toBe(functionDefinition(migration, name));
    }
    expect(MIGRATION_SQL).toContain(PORT_DURABLE_FENCE_SQL);
    expect(PORT_DURABLE_FENCE_TABLES).toEqual(['portmgr_port_fences']);
    expect(PORTMGR_TABLES).toContain('portmgr_port_fences');
  });

  test('creates a permanent active/deleted generation fence and seeds existing rows at zero', () => {
    const sql = compact(PORT_DURABLE_FENCE_SQL);
    expect(MIGRATION_SQL).toContain('sync_generation bigint not null default 0');
    expect(MIGRATION_SQL).toContain('memory_id text');
    expect(PORT_DURABLE_FENCE_SQL)
      .toContain('alter table public.portmgr_ports add column if not exists memory_id text');
    expect(sql).toContain('create table if not exists public.portmgr_port_fences(port_id text primary key,generation bigint not null default 0 check(generation>=0),state text not null default \'active\' check(state in(\'active\',\'deleted\')),owner_device_id text,deleted_name text,operation_id uuid,operation_base_generation bigint');
    expect(sql).toContain('operation_payload_sha256 text');
    expect(sql).toContain('add column if not exists operation_base_generation bigint');
    expect(sql).toContain('add column if not exists operation_payload_sha256 text');
    expect(sql).toContain('drop column if exists operation_payload');
    expect(sql).not.toContain('operation_payload jsonb');
    expect(sql).not.toContain('portmgr_port_upsert_operations');
    expect(sql).not.toContain('pgcrypto');
    expect(sql).not.toContain('extensions.digest');
    expect(sql).toContain("select port.id,port.sync_generation,'active',port.device_id,null,null,now() from public.portmgr_ports port on conflict(port_id) do nothing");
    expect(sql).not.toMatch(/delete from public\.portmgr_port_fences/);
  });

  test('allows only a transaction-proven RPC to advance a row generation', () => {
    const write = body('portmgr_enforce_port_fence_write');
    const remove = body('portmgr_tombstone_port_fence_on_delete');
    for (const source of [write, remove]) {
      expect(source).toContain("pg_advisory_xact_lock(hashtextextended('portmgr-port-fence:'||");
      expect(source).toContain('security definer');
      expect(source).toContain('set search_path=public,pg_temp');
    }
    expect(write).toContain("v_fence.state<>'active'");
    expect(write).toContain('new.sync_generation is distinct from v_fence.generation');
    expect(write).toContain('new.sync_generation is distinct from old.sync_generation + 1');
    expect(write).toContain('port_fence_upsert_rpc_required');
    expect(write).toContain('port_fence_generation_advance_unauthorized');
    expect(write).toContain("current_setting('portmgr.port_upsert_operation_id',true)");
    expect(write).toContain('v_fence.operation_base_generation is distinct from old.sync_generation');
    expect(write).toContain('v_upsert_target_generation is distinct from new.sync_generation::text');
    expect(write).toContain('port_fence_owner_immutable');
    expect(PORT_DURABLE_FENCE_SQL).toMatch(/before insert or update on public\.portmgr_ports/i);
    expect(PORT_DURABLE_FENCE_SQL).toMatch(/before delete on public\.portmgr_ports/i);
  });

  test('legacy privileged DELETE tombstones identity and fails explicitly before bigint overflow', () => {
    const remove = body('portmgr_tombstone_port_fence_on_delete');
    expect(remove).toContain('v_fence.generation=9223372036854775807');
    expect(remove).toContain('port_fence_generation_exhausted');
    expect(remove.indexOf('port_fence_generation_exhausted'))
      .toBeLessThan(remove.indexOf('set generation=fence.generation + 1'));
    expect(remove).toContain("state='deleted'");
    expect(remove).toContain('deleted_name=old.name');
    expect(remove).toContain('operation_id=v_operation_id');
  });

  test('upserts partial patches and advances only actual existing-row changes', () => {
    const upsert = body('portmgr_upsert_ports_if_generation_matches');
    expect(upsert).toContain('returns table(id text,generation bigint)');
    expect(upsert).toContain("order by item ->>'id'");
    expect(upsert).toContain("pg_advisory_xact_lock(hashtextextended('portmgr-port-fence:'||v_port_id,0))");
    expect(upsert).toContain('jsonb_populate_record(v_existing,v_item)');
    expect(upsert).toContain("if not(v_item ? 'created_at') then v_row.created_at:=now()");
    expect(upsert).toContain("if not(v_item ? 'favorite') then v_row.favorite:=false");
    expect(upsert).toContain('v_fence.generation is distinct from v_row.sync_generation');
    expect(upsert).toContain('port_fence_upsert_mixed_replay');
    expect(upsert).toContain('when v_row_changed then fence.generation + 1');
    expect(upsert).toContain('v_row.sync_generation:=v_new_generation');
    expect(upsert).toContain('operation_base_generation=v_row.sync_generation');
    expect(upsert).toContain('operation_payload_sha256=v_payload_sha256');
    expect(upsert).toContain("sha256(convert_to(v_payload::text,'utf8'))");
    expect(upsert).toContain('port_fence_owner_immutable');
    expect(upsert).toContain('v_row_changed and v_fence.generation=9223372036854775807');
    expect(upsert).not.toContain('on conflict on constraint portmgr_ports_pkey');
  });

  test('records a no-op digest without advancing or rewriting the port row', () => {
    const upsert = body('portmgr_upsert_ports_if_generation_matches');
    const conditionalGeneration = upsert.indexOf('set generation=case when v_row_changed then fence.generation + 1 else fence.generation end');
    const guardedPortUpdate = upsert.indexOf('if v_row_changed then v_row.sync_generation:=v_new_generation');
    expect(conditionalGeneration).toBeGreaterThan(-1);
    expect(guardedPortUpdate).toBeGreaterThan(conditionalGeneration);
    expect(upsert).toContain("(to_jsonb(v_existing) - 'sync_generation') is distinct from(to_jsonb(v_row) - 'sync_generation')");
    expect(upsert).toContain('returning fence.generation into v_new_generation');
  });

  test('same-op replay matches the original base and canonical supplied-key payload', () => {
    const upsert = body('portmgr_upsert_ports_if_generation_matches');
    const replay = upsert.indexOf('elsif v_fence.operation_id=p_upsert_op_id');
    const staleNewOperation = upsert.indexOf('elsif not v_existing_found', replay);
    const mutation = upsert.indexOf('when v_row_changed then fence.generation + 1');
    expect(replay).toBeGreaterThan(-1);
    expect(staleNewOperation).toBeGreaterThan(replay);
    expect(mutation).toBeGreaterThan(staleNewOperation);
    expect(upsert).toContain('v_fence.operation_base_generation is distinct from v_row.sync_generation');
    expect(upsert).toContain('v_fence.operation_payload_sha256 is distinct from v_payload_sha256');
    expect(upsert).toContain("jsonb_set(v_item,'{sync_generation}',to_jsonb(((v_item ->>'sync_generation')::bigint)::text),true)");
    expect(upsert).toContain("fence.operation_base_generation=(item ->>'sync_generation')::bigint");
    expect(upsert).toContain("fence.operation_payload_sha256=encode(sha256(convert_to(jsonb_set(item,'{sync_generation}'");
  });

  test('fresh UUID catch-up requires proof of the immediately preceding exact operation', () => {
    const upsert = body('portmgr_upsert_ports_if_generation_matches');
    const staleBranch = upsert.indexOf('elsif not v_existing_found or v_fence.generation is distinct from v_row.sync_generation');
    const catchUp = upsert.indexOf('and v_fence.generation is not distinct from v_existing.sync_generation', staleBranch);
    const mismatch = upsert.indexOf("message='port_fence_upsert_generation_mismatch'", catchUp);
    expect(staleBranch).toBeGreaterThan(-1);
    expect(catchUp).toBeGreaterThan(staleBranch);
    expect(mismatch).toBeGreaterThan(catchUp);
    const guardedCatchUp = upsert.slice(catchUp, mismatch);
    expect(guardedCatchUp).toContain('v_existing.sync_generation>v_row.sync_generation');
    expect(guardedCatchUp).toContain('and not v_row_changed');
    expect(guardedCatchUp).toContain('v_existing.device_id is not distinct from v_row.device_id');
    expect(guardedCatchUp).toContain('v_fence.owner_device_id is not distinct from v_existing.device_id');
    expect(guardedCatchUp).toContain('v_fence.operation_base_generation is not distinct from v_row.sync_generation');
    expect(guardedCatchUp).toContain('v_fence.operation_payload_sha256 is not distinct from v_payload_sha256');
    expect(guardedCatchUp).toContain('v_mutation_count:=v_mutation_count + 1');

    // The supplied base is retained in latest-operation metadata so the new
    // UUID is itself replayable and the result query can return current gen.
    expect(upsert).toContain('operation_base_generation=v_row.sync_generation');
    expect(upsert).toContain("fence.operation_base_generation=(item ->>'sync_generation')::bigint");
  });

  test('locks and validates the complete batch before generation CAS mutations', () => {
    const upsert = body('portmgr_upsert_ports_if_generation_matches');
    const lock = upsert.indexOf("for v_port_id in select item ->>'id'");
    const inspect = upsert.indexOf('for v_item in select item', lock);
    const mutation = upsert.indexOf('when v_row_changed then fence.generation + 1');
    expect(lock).toBeGreaterThan(-1);
    expect(inspect).toBeGreaterThan(lock);
    expect(mutation).toBeGreaterThan(inspect);
    expect(upsert).toContain("order by item ->>'id'");
    expect(upsert.indexOf('port_fence_generation_exhausted'))
      .toBeLessThan(mutation);
  });

  test('delete RPC verifies the whole identity batch before one atomic physical delete', () => {
    const remove = body('portmgr_delete_ports_if_identity_matches');
    const lock = remove.indexOf('for v_port_id in select expected.id');
    const inspect = remove.indexOf('for v_expected in select expected.id');
    const mutation = remove.indexOf('delete from public.portmgr_ports port');
    expect(lock).toBeGreaterThan(-1);
    expect(inspect).toBeGreaterThan(lock);
    expect(mutation).toBeGreaterThan(inspect);
    expect(remove).toContain('order by expected.id');
    expect(remove).toContain('v_port.device_id is distinct from v_expected.device_id');
    expect(remove).toContain('v_port.name is distinct from v_expected.name');
    expect(remove).toContain('v_port.sync_generation is distinct from v_expected.sync_generation');
    expect(remove).toContain('v_fence.deleted_name is distinct from v_expected.name');
    expect(remove).toContain('v_fence.operation_id=p_deletion_op_id');
    expect(remove).toContain('port_fence_delete_mixed_replay');
    expect(remove).toContain('v_deleted_count<>jsonb_array_length(p_expected_rows)');
  });

  test('separately tombstones proven-absent IDs and never gains authority over a present row', () => {
    const absent = body('portmgr_tombstone_absent_ports');
    const lock = absent.indexOf('for v_port_id in select expected.id');
    const absenceCheck = absent.indexOf('perform 1 from public.portmgr_ports port');
    const insertFence = absent.indexOf('insert into public.portmgr_port_fences');
    expect(lock).toBeGreaterThan(-1);
    expect(absenceCheck).toBeGreaterThan(lock);
    expect(insertFence).toBeGreaterThan(absenceCheck);
    expect(absent).toContain('order by expected.id');
    expect(absent).toContain('port_fence_absent_row_present');
    expect(absent).toContain('port_fence_absent_identity_mismatch');
    expect(absent).toContain('v_fence.generation - 1 is distinct from v_expected.sync_generation');
    expect(absent).toContain('v_fence.owner_device_id is distinct from v_expected.device_id');
    expect(absent).toContain('v_fence.deleted_name is distinct from v_expected.name');
    expect(absent).toContain("v_expected.sync_generation + 1,'deleted'");
    expect(absent).not.toContain('delete from public.portmgr_ports');
  });

  test('restore requires the exact deleted generation, advances twice across delete/restore, and is replayable', () => {
    const restore = body('portmgr_restore_port_if_generation_matches');
    expect(restore).toContain('v_row.sync_generation is distinct from p_deleted_generation - 1');
    expect(restore).toContain("v_fence.state<>'deleted'");
    expect(restore).toContain('v_fence.generation is distinct from p_deleted_generation');
    expect(restore).toContain('v_fence.deleted_name is distinct from v_row.name');
    expect(restore).toContain('v_fence.generation=p_deleted_generation + 1');
    expect(restore).toContain('set generation=fence.generation + 1');
    expect(restore).toContain('v_row.sync_generation:=v_new_generation');
    expect(restore).toContain('operation_id=p_restore_op_id');
    expect(restore).toContain('deleted_name=null');
    expect(restore).toContain("supplied.field_name not in('id','sync_generation'");
  });

  test('exposes only SELECT on tables and authenticated/service-role mutation RPCs', () => {
    const sql = compact(PORT_DURABLE_FENCE_SQL);
    expect(sql).toContain('revoke all privileges on table public.portmgr_port_fences from public,anon,authenticated,service_role');
    expect(sql).toContain('grant select on table public.portmgr_port_fences to authenticated,service_role');
    expect(sql).toContain('revoke all privileges on table public.portmgr_ports from authenticated,service_role');
    expect(sql).toContain('grant select on table public.portmgr_ports to authenticated,service_role');
    expect(sql).not.toMatch(/grant (?:insert|update|delete)[^;]*portmgr_port_fences/);
    expect(sql).toContain('revoke all on function public.portmgr_enforce_port_fence_write() from public,anon,authenticated,service_role');
    expect(sql).toContain('revoke all on function public.portmgr_tombstone_port_fence_on_delete() from public,anon,authenticated,service_role');
    for (const signature of [
      'portmgr_upsert_ports_if_generation_matches(jsonb,uuid)',
      'portmgr_delete_ports_if_identity_matches(jsonb,uuid)',
      'portmgr_delete_or_tombstone_ports_if_identity_matches(jsonb,uuid)',
      'portmgr_tombstone_absent_ports(jsonb,uuid)',
      'portmgr_restore_port_if_generation_matches(jsonb,bigint,uuid)',
    ]) {
      expect(sql).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated,service_role`);
    }
  });
});

describe('durable port fence client helper', () => {
  test('canonicalizes bigint generations and rejects imprecise or overflowing values', () => {
    expect(portFenceGeneration(0)).toBe('0');
    expect(portFenceGeneration(42n)).toBe('42');
    expect(portFenceGeneration('9223372036854775807')).toBe('9223372036854775807');
    expect(() => portFenceGeneration(Number.MAX_SAFE_INTEGER + 1)).toThrow('INVALID_GENERATION');
    expect(() => portFenceGeneration('9223372036854775808')).toThrow('INVALID_GENERATION');
    expect(() => portFenceGeneration('01')).toThrow('INVALID_GENERATION');
  });

  test('builds sorted exact delete identities and partial upsert patches', () => {
    const deletion = buildPortDeletionRpcArgs([
      { id: 'z', device_id: null, name: '', sync_generation: 4n },
      { id: 'a', device_id: 'device-a', name: 'A', sync_generation: '2' },
    ], UUID_A);
    expect(deletion).toEqual({
      p_expected_rows: [
        { id: 'a', device_id: 'device-a', name: 'A', sync_generation: '2' },
        { id: 'z', device_id: null, name: '', sync_generation: '4' },
      ],
      p_deletion_op_id: UUID_A,
    });

    const upsert = buildPortUpsertRpcArgs([{
      id: 'port-a',
      device_id: 'device-a',
      name: 'Renamed',
      sync_generation: 7,
      memo: 'patch only',
      memory_id: 'memory-a',
    }], UUID_B);
    expect(upsert).toEqual({
      p_rows: [{
        id: 'port-a',
        device_id: 'device-a',
        name: 'Renamed',
        sync_generation: '7',
        memo: 'patch only',
        memory_id: 'memory-a',
      }],
      p_upsert_op_id: UUID_B,
    });
    expect(() => buildPortUpsertRpcArgs([{
      id: 'port-a', device_id: 'device-a', name: 'A', sync_generation: 0,
      unknown_future_column: true,
    }], UUID_A)).toThrow('UNKNOWN_UPSERT_COLUMN:unknown_future_column');
  });

  test('requires restore bytes from exactly one generation before the tombstone', () => {
    expect(buildPortRestoreRpcArgs({
      id: 'port-a', device_id: 'device-a', name: 'A', sync_generation: '6',
      memo: 'saved', memory_id: 'memory-a',
    }, '7', UUID_B)).toEqual({
      p_row: {
        id: 'port-a', device_id: 'device-a', name: 'A', sync_generation: '6',
        memo: 'saved', memory_id: 'memory-a',
      },
      p_deleted_generation: '7',
      p_restore_op_id: UUID_B,
    });
    expect(() => buildPortRestoreRpcArgs({
      id: 'port-a', device_id: 'device-a', name: 'A', sync_generation: '5',
    }, '7', UUID_B)).toThrow('RESTORE_SOURCE_GENERATION_MISMATCH');
    expect(() => buildPortRestoreRpcArgs({
      id: 'port-a', device_id: 'device-a', name: 'A', sync_generation: '6',
      unknown_future_column: true,
    }, '7', UUID_B)).toThrow('UNKNOWN_RESTORE_COLUMN:unknown_future_column');
  });

  test('parses RPC generations without losing bigint precision', () => {
    expect(parsePortFenceResults([
      { id: 'a', generation: 2 },
      { id: 'b', generation: '9223372036854775807' },
    ])).toEqual([
      { id: 'a', generation: '2' },
      { id: 'b', generation: '9223372036854775807' },
    ]);
    expect(() => parsePortFenceResults([{ id: 'a', generation: 1 }, { id: 'a', generation: 1 }]))
      .toThrow('DUPLICATE_RESULT_ID');
  });

  test('calls partial upsert without inventing omitted columns', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const results = await upsertPortsWithDurableFence({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: [{ id: 'a', generation: '4' }], error: null };
      },
    }, [{
      id: 'a', device_id: 'device-a', name: 'A', sync_generation: '3', memo: 'only this',
    }], UUID_A);
    expect(results).toEqual([{ id: 'a', generation: '4' }]);
    expect(calls).toEqual([{
      name: PORT_UPSERT_FENCE_RPC,
      args: {
        p_rows: [{
          id: 'a', device_id: 'device-a', name: 'A', sync_generation: '3', memo: 'only this',
        }],
        p_upsert_op_id: UUID_A,
      },
    }]);
  });

  test('fails closed when an old database lacks the mutation RPC', async () => {
    let calls = 0;
    const deleting = deletePortsWithDurableFence({
      rpc: async name => {
        calls += 1;
        return {
          data: null,
          error: { code: 'PGRST202', message: `Could not find the function public.${name}` },
        };
      },
    }, [{ id: 'a', device_id: 'device-a', name: 'A', sync_generation: 0 }], UUID_A);
    await expect(deleting).rejects.toMatchObject({
      failure: 'unavailable',
      rpcName: PORT_DELETE_FENCE_RPC,
      mutationMayHaveCommitted: false,
    });
    expect(calls).toBe(1);
  });

  test('calls the absent-only tombstone RPC with the same exact identity envelope', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await tombstoneAbsentPortsWithDurableFence({
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: [{ id: 'gone', generation: '1' }], error: null };
      },
    }, [{
      id: 'gone', device_id: 'device-a', name: 'Gone', sync_generation: '0',
    }], UUID_B);
    expect(result).toEqual([{ id: 'gone', generation: '1' }]);
    expect(calls).toEqual([{
      name: PORT_TOMBSTONE_ABSENT_FENCE_RPC,
      args: {
        p_expected_rows: [{
          id: 'gone', device_id: 'device-a', name: 'Gone', sync_generation: '0',
        }],
        p_deletion_op_id: UUID_B,
      },
    }]);
  });

  test('distinguishes rejected transactions from lost-response ambiguity', async () => {
    const rejected = restorePortWithDurableFence({
      rpc: async () => ({ data: null, error: { code: '40001', message: 'generation mismatch' } }),
    }, { id: 'a', device_id: 'device-a', name: 'A', sync_generation: '0' }, '1', UUID_A);
    await expect(rejected).rejects.toMatchObject({
      failure: 'rejected',
      mutationMayHaveCommitted: false,
    });

    const unknown = upsertPortsWithDurableFence({
      rpc: async () => { throw new TypeError('fetch failed'); },
    }, [{ id: 'a', device_id: 'device-a', name: 'A', sync_generation: '0' }], UUID_A);
    await expect(unknown).rejects.toMatchObject({
      failure: 'invalid-response',
      mutationMayHaveCommitted: true,
    });

    const malformed = deletePortsWithDurableFence({
      rpc: async () => ({ data: [], error: null }),
    }, [{ id: 'a', device_id: 'device-a', name: 'A', sync_generation: 0 }], UUID_A);
    await expect(malformed).rejects.toBeInstanceOf(PortDurableFenceError);
    await expect(malformed).rejects.toMatchObject({ mutationMayHaveCommitted: true });
  });

  test('uses only the named RPC contracts', () => {
    expect(PORT_UPSERT_FENCE_RPC).toBe('portmgr_upsert_ports_if_generation_matches');
    expect(PORT_DELETE_FENCE_RPC).toBe('portmgr_delete_ports_if_identity_matches');
    expect(PORT_TOMBSTONE_ABSENT_FENCE_RPC).toBe('portmgr_tombstone_absent_ports');
    expect(PORT_RESTORE_FENCE_RPC).toBe('portmgr_restore_port_if_generation_matches');
  });
});
