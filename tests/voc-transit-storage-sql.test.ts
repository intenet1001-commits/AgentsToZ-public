import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { VOC_TRANSIT_STORAGE_SQL } from '../src/vocTransitStorageSql';
import { MIGRATION_SQL } from '../src/schemaSql';

test('setup SQL carries the photo-VOC transit bucket, identical to its migration', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20260927010000_voc_transit_storage.sql', import.meta.url), 'utf8');
  expect(VOC_TRANSIT_STORAGE_SQL).toBe(migration);
  expect(MIGRATION_SQL).toContain(VOC_TRANSIT_STORAGE_SQL);
});

// 2026-09-27: the transit bucket existed only as a migration, so a newly self-hosted
// Supabase could not take phone photo VOCs. Every app table/function/bucket created by a
// migration must also be reachable from the setup SQL a new user applies.
const NOT_APP_SCHEMA = new Set([
  'portmgr_device_credentials', // legacy, no longer read or written
  'wordpress_blogs', 'wordpress_writing_findings', 'wordpress_design_findings', 'wordpress_headline_examples', 'wordpress_playbook_rules', // corpus, not the app
]);
test('no migration creates app schema that new installs would miss', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const setup = MIGRATION_SQL.toLowerCase();
  const missing: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(new URL(file, dir), 'utf8').toLowerCase();
    const names = new Set<string>();
    for (const m of sql.matchAll(/create (?:or replace )?function\s+(?:public\.)?(portmgr_[a-z0-9_]+)/g)) names.add(m[1]!);
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z0-9_]+)/g)) names.add(m[1]!);
    for (const m of sql.matchAll(/storage\.buckets[^;]*values\s*\(\s*'([^']+)'/g)) names.add(m[1]!);
    for (const name of names) if (!NOT_APP_SCHEMA.has(name) && !setup.includes(name)) missing.push(`${file}: ${name}`);
  }
  expect(missing).toEqual([]);
});
