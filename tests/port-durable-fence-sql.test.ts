import { PGlite } from '@electric-sql/pglite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PORT_DURABLE_FENCE_PREREQUISITES_SQL } from '../src/schemaSql';
import { mergePortUploadFields, portUploadMetadataFromRemote } from '../src/portUploadConflict';

const migration = readFileSync(new URL(
  '../supabase/migrations/20260830020000_port_durable_fence.sql', import.meta.url,
), 'utf8');
const prerequisiteRepair = readFileSync(new URL(
  '../supabase/migrations/20260908030000_port_fence_prerequisites.sql', import.meta.url,
), 'utf8');

// Each fixture is an in-memory PostgreSQL instance. Never resolve a connection
// string, load an app .env, or contact the user's Supabase/local PostgreSQL.
// SET ROLE tests the actual SQL grants/RLS; only PostgREST JWT claims are mocked.
const baseline = `
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
create function public.portmgr_is_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(auth.role() = 'service_role', false)
    or (coalesce(auth.role() = 'authenticated', false)
      and coalesce(auth.jwt() ->> 'email' = 'owner@example.test', false))
$$;
revoke all on function public.portmgr_is_member() from public, anon;
grant execute on function public.portmgr_is_member() to authenticated, service_role;
create table public.portmgr_ports (
  id text primary key,
  device_id text,
  device_name text,
  name text not null,
  port integer,
  command_path text,
  terminal_command text,
  folder_path text,
  worktree_parent_id text,
  deploy_url text,
  github_url text,
  github_urls text[],
  manual_path text,
  log_file_path text,
  favorite boolean default false,
  category text,
  description text,
  memo text,
  memo_updated_at timestamptz,
  memory_id text,
  created_at timestamptz default now()
);
alter table public.portmgr_ports enable row level security;
create policy portmgr_authenticated_all on public.portmgr_ports
  for all to authenticated
  using ((select public.portmgr_is_member()))
  with check ((select public.portmgr_is_member()));
revoke all on public.portmgr_ports from public, anon;
grant select, insert, update, delete on public.portmgr_ports to authenticated, service_role;
insert into public.portmgr_ports (
  id, device_id, device_name, name, port, folder_path, github_urls,
  favorite, memo, memory_id, created_at
) values
  ('legacy-a', 'mac-a', 'Mac A', '기존 프로젝트', null, '/fixture/project-a',
   array['https://github.com/example/fixture'], true, '보존할 메모', 'memory-a', '2026-01-01T00:00:00Z'),
  ('legacy-b', 'mac-b', 'Mac B', '다른 단말', 9002, '/fixture/project-b',
   null, false, null, 'memory-b', '2026-01-02T00:00:00Z');
`;

// Observed production columns are absent from CREATE TABLE itself, rather than
// DROP COLUMN slots in an already-compiled composite type. Keep legacy extras.
const legacyBaseline = baseline
  .replace('  worktree_parent_id text,\n', '')
  .replace('  category text,\n', '')
  .replace('  description text,\n', '')
  .replace('  created_at timestamptz default now()',
    '  is_running boolean default false,\n  updated_at timestamptz default now()')
  .replace('favorite, memo, memory_id, created_at', 'favorite, memo, memory_id, updated_at');

type Role = 'anon' | 'authenticated' | 'service_role';
type PortRow = Record<string, unknown> & { id: string; device_id: string; name: string };
const operation = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const patch = (overrides: Record<string, unknown> = {}) => ({
  id: 'legacy-a', device_id: 'mac-a', name: '기존 프로젝트', sync_generation: '0', ...overrides,
});

async function asRole(db: PGlite, role: Role, member = true): Promise<void> {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({
    role, email: member ? 'owner@example.test' : 'outsider@example.test',
  })]);
  await db.exec(`set role ${role}`);
}

async function upsert(db: PGlite, rows: Record<string, unknown>[], op = operation(1)) {
  return (await db.query<{ id: string; generation: string }>(
    `select id, generation::text from public.portmgr_upsert_ports_if_generation_matches($1::jsonb, $2::uuid)`,
    [JSON.stringify(rows), op],
  )).rows;
}

async function remove(db: PGlite, rows: Record<string, unknown>[], op = operation(2)) {
  return (await db.query<{ id: string; generation: string }>(
    `select id, generation::text from public.portmgr_delete_ports_if_identity_matches($1::jsonb, $2::uuid)`,
    [JSON.stringify(rows), op],
  )).rows;
}

async function restore(db: PGlite, row: Record<string, unknown>, generation: string, op = operation(3)) {
  return (await db.query<{ id: string; generation: string }>(
    `select id, generation::text from public.portmgr_restore_port_if_generation_matches($1::jsonb, $2::bigint, $3::uuid)`,
    [JSON.stringify(row), generation, op],
  )).rows;
}

async function state(db: PGlite) {
  await db.exec('reset role');
  const ports = (await db.query<{ row: Record<string, unknown> }>(
    'select to_jsonb(p) as row from public.portmgr_ports p order by id',
  )).rows.map(result => result.row);
  const fences = (await db.query<{ row: Record<string, unknown> }>(
    'select to_jsonb(fence) as row from public.portmgr_port_fences fence order by port_id',
  )).rows.map(result => result.row);
  return { ports, fences };
}

async function rejectsSql(action: () => Promise<unknown>, code: string, message?: string) {
  let failure: unknown;
  try { await action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { code?: string }).code).toBe(code);
  if (message) expect((failure as Error).message).toContain(message);
}

async function fixture(action: (db: PGlite) => Promise<void>, migrate = true, legacy = false) {
  const db = new PGlite();
  try {
    await db.exec(legacy ? legacyBaseline : baseline);
    if (migrate) await db.exec(migration);
    await action(db);
  } finally {
    await db.close();
  }
}

describe('port durable fence migration in PostgreSQL', () => {
  test('repairs the observed legacy schema without rewriting unknown creation times or legacy fields', async () => {
    await fixture(async db => {
      await db.exec(`
        update public.portmgr_ports set is_running = true, updated_at = '2026-01-03T00:00:00Z' where id = 'legacy-a';
      `);
      const before = (await db.query<{ row: Record<string, unknown> }>(
        'select to_jsonb(p) as row from public.portmgr_ports p order by id',
      )).rows.map(result => result.row);
      expect(prerequisiteRepair).toBe(PORT_DURABLE_FENCE_PREREQUISITES_SQL);
      await db.exec(migration);
      const migrated = await state(db);
      expect(migrated.ports.map(({ sync_generation, category, description, worktree_parent_id, created_at, ...row }) => row))
        .toEqual(before);
      expect(migrated.ports.every(row => row.created_at === null)).toBe(true);
      await db.exec(prerequisiteRepair);
      await db.exec(migration);
      expect(await state(db)).toEqual(migrated);
      await asRole(db, 'service_role');
      expect(await upsert(db, [patch({ memo: 'legacy update succeeds' })]))
        .toEqual([{ id: 'legacy-a', generation: '1' }]);
      expect(await upsert(db, [patch({ id: 'fresh', name: 'Fresh' })], operation(2)))
        .toEqual([{ id: 'fresh', generation: '0' }]);
      const result = await state(db);
      expect(result.ports.find(row => row.id === 'legacy-a')).toMatchObject({
        is_running: true, updated_at: before[0]?.updated_at, created_at: null,
        memory_id: 'memory-a', memo: 'legacy update succeeds',
      });
      expect(result.ports.find(row => row.id === 'fresh')?.created_at).toBeString();
    }, false, true);
  }, 30_000);

  test('forward repair fixes existing RPCs on a drifted table without resetting fence authority', async () => {
    await fixture(async db => {
      const oldMigration = migration.replace(prerequisiteRepair, '');
      expect(oldMigration).not.toBe(migration);
      await db.exec(oldMigration);
      const before = await state(db);
      await asRole(db, 'service_role');
      await rejectsSql(() => upsert(db, [patch({ memo: 'next change' })], operation(2)),
        '42703');
      const drifted = await state(db);
      expect(drifted).toEqual(before);
      await db.exec(prerequisiteRepair);
      await db.exec(prerequisiteRepair);
      const repaired = await state(db);
      expect(repaired.fences).toEqual(before.fences);
      expect(repaired.ports.map(({ category, description, worktree_parent_id, created_at, ...row }) => row))
        .toEqual(drifted.ports);
      expect(repaired.ports.every(row => row.created_at === null)).toBe(true);
      await asRole(db, 'service_role');
      expect(await upsert(db, [patch({ memo: 'next change' })], operation(2)))
        .toEqual([{ id: 'legacy-a', generation: '1' }]);
    }, false, true);
  }, 30_000);

  test('adds legacy columns, preserves rows, and reruns without changing active or deleted generations', async () => {
    await fixture(async db => {
      await db.exec('alter table public.portmgr_ports drop column memory_id');
      const before = (await db.query<{ row: Record<string, unknown> }>(
        'select to_jsonb(p) as row from public.portmgr_ports p order by id',
      )).rows.map(result => result.row);
      await db.exec(migration);
      const initial = await state(db);
      expect(initial.ports.map(({ sync_generation, memory_id, ...row }) => row)).toEqual(before);
      expect(initial.fences.map(({ port_id, generation, state, owner_device_id }) => ({
        port_id, generation, state, owner_device_id,
      }))).toEqual([
        { port_id: 'legacy-a', generation: 0, state: 'active', owner_device_id: 'mac-a' },
        { port_id: 'legacy-b', generation: 0, state: 'active', owner_device_id: 'mac-b' },
      ]);
      await asRole(db, 'service_role');
      await upsert(db, [patch({ memo: '첫 변경' })]);
      await remove(db, [{ id: 'legacy-b', device_id: 'mac-b', name: '다른 단말', sync_generation: '0' }]);
      const committed = await state(db);
      await db.exec(migration);
      await db.exec(migration);
      expect(await state(db)).toEqual(committed);
    }, false);
  }, 30_000);

  test('enforces real authenticated/service-role table grants while permitting their member RPCs', async () => {
    await fixture(async db => {
      for (const [index, role] of (['authenticated', 'service_role'] as const).entries()) {
        await asRole(db, role);
        expect((await db.query('select id from public.portmgr_ports')).rows).toHaveLength(2);
        for (const sql of [
          "insert into public.portmgr_ports(id, name, device_id) values ('forbidden', 'No', 'mac-a')",
          "update public.portmgr_ports set memo = 'forbidden' where id = 'legacy-a'",
          "delete from public.portmgr_ports where id = 'legacy-a'",
          "update public.portmgr_port_fences set generation = 100 where port_id = 'legacy-a'",
          "delete from public.portmgr_port_fences where port_id = 'legacy-a'",
        ]) await rejectsSql(() => db.exec(sql), '42501');
        expect(await upsert(db, [patch()], operation(10 + index))).toEqual([
          { id: 'legacy-a', generation: '0' },
        ]);
      }
      await asRole(db, 'authenticated', false);
      expect((await db.query('select id from public.portmgr_ports')).rows).toHaveLength(0);
      expect((await db.query('select port_id from public.portmgr_port_fences')).rows).toHaveLength(0);
      await rejectsSql(() => upsert(db, [patch()]), '42501', 'PORTMGR_MEMBER_REQUIRED');
      await asRole(db, 'anon');
      await rejectsSql(() => db.query('select id from public.portmgr_ports'), '42501');
      await rejectsSql(() => upsert(db, [patch()]), '42501');
      const after = await state(db);
      expect(after.ports).toHaveLength(2);
      expect(after.ports[0]?.memo).toBe('보존할 메모');
    });
  }, 30_000);

  test('inserts defaults, applies partial patches, and keeps exact no-op/replay generations stable', async () => {
    await fixture(async db => {
      await asRole(db, 'authenticated');
      const created = patch({ id: 'new', name: 'New', memo: 'new memo' });
      expect(await upsert(db, [created])).toEqual([{ id: 'new', generation: '0' }]);
      expect(await upsert(db, [created])).toEqual([{ id: 'new', generation: '0' }]);
      const changed = patch({ memo: 'changed' });
      expect(await upsert(db, [changed], operation(2))).toEqual([{ id: 'legacy-a', generation: '1' }]);
      expect(await upsert(db, [changed], operation(2))).toEqual([{ id: 'legacy-a', generation: '1' }]);
      expect(await upsert(db, [patch({ sync_generation: '1', memo: 'changed' })], operation(3)))
        .toEqual([{ id: 'legacy-a', generation: '1' }]);
      const after = await state(db);
      expect(after.ports.find(row => row.id === 'legacy-a')).toMatchObject({
        folder_path: '/fixture/project-a', favorite: true, memory_id: 'memory-a',
        github_urls: ['https://github.com/example/fixture'], memo: 'changed', sync_generation: 1,
      });
      expect(after.ports.find(row => row.id === 'new')).toMatchObject({ favorite: false, memo: 'new memo' });
      expect(after.ports.find(row => row.id === 'new')?.created_at).toBeString();
    });
  }, 30_000);

  test('rejects stale changes and reused operations, but permits exact lost-response catch-up', async () => {
    await fixture(async db => {
      await asRole(db, 'service_role');
      const changed = patch({ memo: 'committed' });
      await upsert(db, [changed]);
      await rejectsSql(() => upsert(db, [patch({ memo: 'different' })]), '40001', 'PORT_FENCE_UPSERT_OPERATION_REUSED');
      await rejectsSql(() => upsert(db, [patch({ memo: 'stale' })], operation(2)), '40001', 'PORT_FENCE_UPSERT_GENERATION_MISMATCH');
      expect(await upsert(db, [changed], operation(3))).toEqual([{ id: 'legacy-a', generation: '1' }]);
      expect(await upsert(db, [changed], operation(3))).toEqual([{ id: 'legacy-a', generation: '1' }]);
      await rejectsSql(() => upsert(db, [patch({ sync_generation: '1', device_id: 'mac-b' })], operation(4)), '22023', 'PORT_FENCE_OWNER_IMMUTABLE');
      expect((await state(db)).ports[0]).toMatchObject({ device_id: 'mac-a', memo: 'committed', sync_generation: 1 });
    });
  }, 30_000);

  test('rejects a partly stale batch atomically without modifying valid rows or fences', async () => {
    await fixture(async db => {
      const before = await state(db);
      await asRole(db, 'authenticated');
      await rejectsSql(() => upsert(db, [
        patch({ memo: 'must roll back' }),
        { id: 'legacy-b', device_id: 'mac-b', name: '다른 단말', sync_generation: '99', memo: 'stale' },
      ]), '40001', 'PORT_FENCE_UPSERT_GENERATION_MISMATCH');
      expect(await state(db)).toEqual(before);
    });
  }, 30_000);

  test('a Pull conflict cannot grant stale local URL bytes the newer server generation', async () => {
    await fixture(async db => {
      await asRole(db, 'service_role');
      await upsert(db, [patch({ deploy_url: 'https://new.example.test' })]);
      const before = await state(db);
      const remote = portUploadMetadataFromRemote(before.ports.find(row => row.id === 'legacy-a'));
      const local = { ...remote, deployUrl: 'https://old.example.test', syncGeneration: '0' };
      const merged = { ...local, ...remote, ...mergePortUploadFields(local, remote) };
      expect(merged.deployUrl).toBe('https://old.example.test');
      expect(merged.syncGeneration).toBe('0');
      await asRole(db, 'service_role');
      await rejectsSql(() => upsert(db, [patch({
        deploy_url: merged.deployUrl, sync_generation: merged.syncGeneration,
      })], operation(2)), '40001', 'PORT_FENCE_UPSERT_GENERATION_MISMATCH');
      expect(await state(db)).toEqual(before);
    });
  }, 30_000);

  test('tombstones exact deletes, replays them, and blocks stale and privileged resurrection', async () => {
    await fixture(async db => {
      await asRole(db, 'authenticated');
      const expected = patch();
      expect(await remove(db, [expected])).toEqual([{ id: 'legacy-a', generation: '1' }]);
      expect(await remove(db, [expected])).toEqual([{ id: 'legacy-a', generation: '1' }]);
      await rejectsSql(() => upsert(db, [patch()], operation(4)), '55000', 'PORT_FENCE_DELETED');
      const deleted = await state(db);
      expect(deleted.ports.map(row => row.id)).toEqual(['legacy-b']);
      expect(deleted.fences[0]).toMatchObject({
        port_id: 'legacy-a', generation: 1, state: 'deleted', owner_device_id: 'mac-a', deleted_name: '기존 프로젝트',
      });
      await rejectsSql(() => db.exec("insert into public.portmgr_ports(id,device_id,name) values ('legacy-a','mac-a','기존 프로젝트')"),
        '55000', 'PORT_FENCE_DELETED');
      expect(await state(db)).toEqual(deleted);
    });
  }, 30_000);

  test('restores exact saved bytes at the next generation and rejects mismatched restores/replays', async () => {
    await fixture(async db => {
      const saved = (await db.query<{ row: PortRow }>(
        "select to_jsonb(p) || jsonb_build_object('sync_generation', sync_generation::text) as row from public.portmgr_ports p where id='legacy-a'",
      )).rows[0]!.row;
      await asRole(db, 'service_role');
      await remove(db, [patch()]);
      await rejectsSql(() => restore(db, { ...saved, device_id: 'mac-b' }, '1'), '40001', 'PORT_FENCE_RESTORE_GENERATION_MISMATCH');
      await rejectsSql(() => restore(db, { ...saved, sync_generation: '1' }, '1'), '40001', 'PORT_FENCE_RESTORE_SOURCE_GENERATION_MISMATCH');
      expect(await restore(db, saved, '1')).toEqual([{ id: 'legacy-a', generation: '2' }]);
      expect(await restore(db, saved, '1')).toEqual([{ id: 'legacy-a', generation: '2' }]);
      await rejectsSql(() => restore(db, { ...saved, memo: 'changed replay' }, '1'), '40001', 'PORT_FENCE_RESTORE_REPLAY_MISMATCH');
      const after = await state(db);
      const { sync_generation: oldGeneration, ...beforeBytes } = saved;
      const { sync_generation: newGeneration, ...restoredBytes } = after.ports[0]!;
      expect(restoredBytes).toEqual(beforeBytes);
      expect(oldGeneration).toBe('0');
      expect(newGeneration).toBe(2);
      expect(after.fences[0]).toMatchObject({ generation: 2, state: 'active', deleted_name: null });
    });
  }, 30_000);

  test('keeps privileged direct updates behind immutable identity and RPC generation triggers', async () => {
    await fixture(async db => {
      const before = await state(db);
      await rejectsSql(() => db.exec("update public.portmgr_ports set memo='bypass' where id='legacy-a'"), '55000', 'PORT_FENCE_UPSERT_RPC_REQUIRED');
      await rejectsSql(() => db.exec("update public.portmgr_ports set id='new-id' where id='legacy-a'"), '22023', 'PORT_FENCE_ID_IMMUTABLE');
      await rejectsSql(() => db.exec("update public.portmgr_ports set device_id='mac-b' where id='legacy-a'"), '22023', 'PORT_FENCE_OWNER_IMMUTABLE');
      expect(await state(db)).toEqual(before);
      await db.exec("delete from public.portmgr_ports where id='legacy-a'");
      const deleted = await state(db);
      expect(deleted.ports.map(row => row.id)).toEqual(['legacy-b']);
      expect(deleted.fences[0]).toMatchObject({ generation: 1, state: 'deleted', deleted_name: '기존 프로젝트' });
    });
  }, 30_000);
});
