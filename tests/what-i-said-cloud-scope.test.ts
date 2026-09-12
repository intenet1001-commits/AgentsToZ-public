import { expect, test } from 'bun:test';
import { readWhatISaidCloudScopes } from '../src/whatISaidCloudScope';
import type { SupabaseClient } from '@supabase/supabase-js';

function client(rows: Array<{ memory_id: string; project_name: string }>, failure = false) {
  const cursors: string[] = [];
  return { cursors, sb: { from(table: string) {
    expect(table).toBe('portmgr_what_i_said_prompts');
    let after = ''; let limit = 0;
    const query = {
      select(columns: string) { expect(columns).toBe('memory_id, project_name'); return query; },
      order(column: string) { expect(column).toBe('memory_id'); return query; },
      limit(value: number) { limit = value; return query; },
      gt(column: string, value: string) { expect(column).toBe('memory_id'); after = value; return query; },
      then(resolve: (value: unknown) => void) {
        cursors.push(after);
        resolve(failure ? { error: { message: 'cloud unavailable' }, data: null }
          : { error: null, data: rows.filter(row => row.memory_id > after).slice(0, limit) });
      },
    };
    return query;
  } } as unknown as SupabaseClient };
}

test('cloud scopes include other devices and advance past duplicate history without reading prompt bodies', async () => {
  const fixture = client([
    ...Array.from({ length: 900 }, () => ({ memory_id: 'a', project_name: 'Local and remote' })),
    { memory_id: 'b', project_name: 'Remote only' },
  ]);
  expect(await readWhatISaidCloudScopes(fixture.sb)).toEqual([
    { memoryId: 'a', name: 'Local and remote' }, { memoryId: 'b', name: 'Remote only' },
  ]);
  expect(fixture.cursors).toEqual(['', 'a']);
});

test('a cloud read failure is not an empty directory', async () => {
  await expect(readWhatISaidCloudScopes(client([], true).sb)).rejects.toThrow('cloud unavailable');
  expect(await readWhatISaidCloudScopes(client([]).sb)).toEqual([]);
});
