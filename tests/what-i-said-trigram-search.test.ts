import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WHAT_I_SAID_FEED_KEY_SQL } from '../src/whatISaidFeedKeySql';

const migration = readFileSync(
  new URL('../supabase/migrations/20260925030000_what_i_said_trigram_search.sql', import.meta.url),
  'utf8',
);

function listFunction(sql: string): string {
  const start = sql.indexOf('create or replace function public.portmgr_list_what_i_said_prompts(');
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf('\nend;\n$$;', start));
}

test('remote prompt search is served by a trigram index on the same normalized expression', () => {
  for (const sql of [WHAT_I_SAID_FEED_KEY_SQL, migration]) {
    expect(sql).toContain('pg_trgm');
    expect(sql).toContain('portmgr_what_i_said_prompts_body_trgm_idx');
    // The index expression and the RPC predicate must be the same expression,
    // or the planner cannot use the index.
    expect(sql).toContain('using gin ((lower(normalize(body, NFKC))) %I.gin_trgm_ops)');
    expect(sql).toContain('where body is not null');
    const fn = listFunction(sql);
    expect(fn).toContain("lower(normalize(p.body, NFKC)) like ('%' || v_needle || '%') escape '\\'");
    // position() cannot use any index; it must be gone from the list RPC.
    expect(fn).not.toContain('position(');
    // '%' and '_' stay literal characters, as before.
    expect(fn).toContain("replace(replace(replace(lower(normalize(v_query, NFKC)), '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
    // Exclusion is still enforced by the database, independent of client caches.
    expect(fn).toContain('mp.memory_id = p.memory_id and mp.upload_excluded');
  }
  // The forward migration is a transaction and re-grants only to service_role.
  expect(migration.trimStart().startsWith('--')).toBe(true);
  expect(migration).toContain('begin;');
  expect(migration.trimEnd().endsWith('commit;')).toBe(true);
  expect(migration).toContain('grant execute on function public.portmgr_list_what_i_said_prompts(text[], text, text, text, text, integer)\n  to service_role;');
});
