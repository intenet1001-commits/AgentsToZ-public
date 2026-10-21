import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { pruneRemoteProjectMemoryRevisions } from '../project-memory-server';

type Call = { kind: string; args: unknown[] };

function fakeSupabase(options: { rpcError?: { code: string; message: string } | null; tail?: Array<{ id: string }> }) {
  const calls: Call[] = [];
  const builder = (table: string) => {
    const chain: any = {
      select: (...args: unknown[]) => { calls.push({ kind: `select:${table}`, args }); return chain; },
      eq: (...args: unknown[]) => { calls.push({ kind: 'eq', args }); return chain; },
      order: (...args: unknown[]) => { calls.push({ kind: 'order', args }); return chain; },
      range: (...args: unknown[]) => {
        calls.push({ kind: 'range', args });
        return Promise.resolve({ data: options.tail ?? [], error: null });
      },
      delete: () => ({
        in: (...args: unknown[]) => { calls.push({ kind: `delete:${table}`, args }); return Promise.resolve({ error: null }); },
      }),
    };
    return chain;
  };
  return {
    calls,
    rpc: (name: string, args: unknown) => {
      calls.push({ kind: `rpc:${name}`, args: [args] });
      return Promise.resolve(options.rpcError ? { data: null, error: options.rpcError } : { data: 12, error: null });
    },
    from: builder,
  };
}

describe('project memory revision pruning after push', () => {
  test('asks the server for bounded retention (30 recent) and never lists history itself', async () => {
    const sb = fakeSupabase({});
    expect(await pruneRemoteProjectMemoryRevisions(sb, 'memory-one')).toEqual({ mode: 'server', deleted: 12 });
    expect(sb.calls).toEqual([{
      kind: 'rpc:portmgr_prune_project_memory_revisions',
      args: [{ p_memory_id: 'memory-one', p_keep_recent: 30, p_limit: 200 }],
    }]);
  });

  test('on a database without the RPC it falls back to a bounded page, not every id', async () => {
    const sb = fakeSupabase({
      rpcError: { code: 'PGRST202', message: 'Could not find the function public.portmgr_prune_project_memory_revisions' },
      tail: [{ id: 'old-1' }, { id: 'old-2' }],
    });
    expect(await pruneRemoteProjectMemoryRevisions(sb, 'memory-one')).toEqual({ mode: 'legacy', deleted: 2 });
    expect(sb.calls.find(call => call.kind === 'range')?.args).toEqual([500, 699]);
    expect(sb.calls.at(-1)).toEqual({ kind: 'delete:portmgr_project_memory_revisions', args: ['id', ['old-1', 'old-2']] });
  });

  test('other RPC failures surface instead of silently deleting by the legacy rule', async () => {
    const sb = fakeSupabase({ rpcError: { code: '57014', message: 'canceling statement due to statement timeout' } });
    await expect(pruneRemoteProjectMemoryRevisions(sb, 'memory-one')).rejects.toThrow('statement timeout');
    expect(sb.calls.some(call => call.kind.startsWith('delete:'))).toBe(false);
  });

  test('push no longer selects every revision id of a memory to slice the tail', () => {
    const source = readFileSync(new URL('../project-memory-server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function pushProjectMemory(input: {');
    const push = source.slice(start, source.indexOf('\nexport async function pullProjectMemory(input: {', start));
    expect(push).toContain('pruneRemoteProjectMemoryRevisions(sb, config.memoryId)');
    expect(push).not.toMatch(/\.slice\(MAX_REMOTE_REVISIONS\)/);
    expect(source).not.toContain('MAX_REMOTE_REVISIONS = 500');
  });
});
