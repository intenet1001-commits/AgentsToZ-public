import { PGlite } from '@electric-sql/pglite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PROJECT_MEMORY_REVISION_RETENTION_SQL } from '../src/projectMemoryRevisionRetentionSql';
import { PROJECT_MEMORY_MIGRATION_SQL } from '../src/schemaSql';

const migration = readFileSync(new URL(
  '../supabase/migrations/20260925020000_project_memory_revision_retention.sql',
  import.meta.url,
), 'utf8');

async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
create table portmgr_project_memory_revisions(id text primary key, memory_id text not null,
  parent_revision_id text, device_id text, content text not null default 'x', content_hash text not null default 'h',
  created_at timestamptz default now());
create table portmgr_project_memory_heads(memory_id text primary key, head_revision_id text);
create table portmgr_project_memory_devices(memory_id text, device_id text, revision_id text, primary key(memory_id, device_id));
create table portmgr_project_memory_merges(id text primary key, source_head_revision_ids text[] not null, merged_revision_id text);`);
  await db.exec(PROJECT_MEMORY_REVISION_RETENTION_SQL);
  return db;
}

/**
 * `hoursAgo` apart, newest first: r000 is the newest. Anchored to 12:00 UTC today, not `now()` —
 * the daily buckets are UTC days, so an anchor that moves with the clock changed which row is
 * «newest in its day» and these tests failed only when run around 10–11 UTC (2026-09-27).
 */
async function seed(db: PGlite, memoryId: string, count: number, stepHours: number, deviceId = 'mac') {
  await db.query(`insert into portmgr_project_memory_revisions(id, memory_id, device_id, created_at)
    select $1 || lpad(g::text, 3, '0'), $1, $4,
      (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') + interval '12 hours'
        - (g * $3::int) * interval '1 hour'
    from generate_series(0, $2::int - 1) g`, [memoryId, count, stepHours, deviceId]);
  await db.query(`insert into portmgr_project_memory_heads values ($1, $1 || '000')`, [memoryId]);
}

async function ids(db: PGlite, memoryId: string): Promise<string[]> {
  return (await db.query<{ id: string }>(
    'select id from portmgr_project_memory_revisions where memory_id = $1 order by id', [memoryId],
  )).rows.map(row => row.id);
}

async function prune(db: PGlite, memoryId: string | null, limit = 500) {
  return (await db.query<{ deleted: number }>(
    'select portmgr_prune_project_memory_revisions($1, 30, $2) as deleted', [memoryId, limit],
  )).rows[0]!.deleted;
}

describe('project memory revision retention', () => {
  test('ships as its own migration and is part of the canonical setup SQL', () => {
    expect(migration).toBe(PROJECT_MEMORY_REVISION_RETENTION_SQL);
    expect(PROJECT_MEMORY_MIGRATION_SQL).toContain(PROJECT_MEMORY_REVISION_RETENTION_SQL);
  });

  test('keeps the newest 30 and a thinned tail instead of 500 full copies', async () => {
    const db = await database();
    try {
      // 500 pushes, 3 hours apart: ~62 days of history.
      await seed(db, 'm', 500, 3);
      const deleted = await prune(db, 'm');
      const kept = await ids(db, 'm');
      expect(deleted).toBe(500 - kept.length);
      // 30 newest + about one per remaining day, never all 500.
      expect(kept.length).toBeGreaterThan(30);
      expect(kept.length).toBeLessThan(110);
      for (let index = 0; index < 30; index += 1) expect(kept).toContain(`m${String(index).padStart(3, '0')}`);
      // Every day of the window still has a restore point.
      const days = (await db.query<{ days: number }>(`select count(distinct date_trunc('day', created_at at time zone 'UTC'))::int as days
        from portmgr_project_memory_revisions where memory_id = 'm'`)).rows[0]!.days;
      const allDays = Math.ceil((499 * 3) / 24);
      expect(days).toBeGreaterThanOrEqual(allDays - 1);
    } finally { await db.close(); }
  });

  test('never deletes the head, a device sync point, a merge reference, or the newest per device', async () => {
    const db = await database();
    try {
      await seed(db, 'm', 200, 1);
      // Pin old rows that retention would otherwise remove (same UTC day as newer ones).
      await db.exec(`update portmgr_project_memory_heads set head_revision_id = 'm150' where memory_id = 'm';
insert into portmgr_project_memory_devices values ('m', 'phone', 'm151');
insert into portmgr_project_memory_merges values ('merge', array['m152'], 'm153');
insert into portmgr_project_memory_revisions(id, memory_id, device_id, created_at)
  select 'old-device', 'm', 'retired-mac', created_at + interval '1 second' from portmgr_project_memory_revisions where id = 'm154';`);
      await prune(db, 'm');
      const kept = await ids(db, 'm');
      for (const pinned of ['m150', 'm151', 'm152', 'm153', 'old-device']) expect(kept).toContain(pinned);
      expect(kept).not.toContain('m155');
    } finally { await db.close(); }
  });

  test('is bounded per call and only touches the requested memory', async () => {
    const db = await database();
    try {
      await seed(db, 'a', 300, 1);
      await seed(db, 'b', 300, 1);
      expect(await prune(db, 'a', 5)).toBe(5);
      expect((await ids(db, 'b')).length).toBe(300);
      // Oldest first: the five removed from 'a' are its oldest prunable rows.
      expect(await ids(db, 'a')).not.toContain('a299');
      // Repeated calls converge and then delete nothing.
      while (await prune(db, 'a') > 0) { /* drain */ }
      expect(await prune(db, 'a')).toBe(0);
      // A null memory id sweeps every memory, still bounded.
      expect(await prune(db, null, 7)).toBe(7);
    } finally { await db.close(); }
  });

  test('is callable only by service_role', async () => {
    const db = await database();
    try {
      const rows = (await db.query<{ role: string; allowed: boolean }>(`select role, has_function_privilege(role,
        'public.portmgr_prune_project_memory_revisions(text,integer,integer)', 'EXECUTE') as allowed
        from unnest(array['anon','authenticated','service_role']) role`)).rows;
      expect(rows).toEqual([
        { role: 'anon', allowed: false },
        { role: 'authenticated', allowed: false },
        { role: 'service_role', allowed: true },
      ]);
    } finally { await db.close(); }
  });
});
