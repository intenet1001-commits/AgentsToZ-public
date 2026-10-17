import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecentSessionFileDiscovery, recentSessionFiles } from '../src/recentSessionFiles';

test('large history returns only the newest files while the event loop and HTTP remain responsive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recent-sessions-'));
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('healthy') });
  try {
    for (let day = 0; day < 20; day++) {
      const dir = join(root, String(day)); mkdirSync(dir);
      for (let index = 0; index < 100; index++) {
        const path = join(dir, `${index}.jsonl`); writeFileSync(path, '{}\n');
        const time = 1_700_000_000 + day * 100 + index; utimesSync(path, time, time);
      }
    }
    const discovery = createRecentSessionFileDiscovery(root);
    let finished = false;
    const scan = discovery().then(files => { finished = true; return files; });
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe('healthy');
    expect(finished).toBe(false);
    const [all, fewer] = await Promise.all([scan, discovery(10)]);
    expect(all).toHaveLength(96);
    expect(fewer).toEqual(all.slice(0, 10));
    expect(all[0]?.full).toBe(join(root, '19', '99.jsonl'));
    expect(all[95]?.full).toBe(join(root, '19', '4.jsonl'));
    const appended = join(root, '0', '0.jsonl');
    utimesSync(appended, 1_800_000_000, 1_800_000_000);
    expect((await discovery(1))[0]?.full).toBe(appended);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test('missing histories are empty and directory symlinks are not traversed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recent-symlink-'));
  try {
    expect(await recentSessionFiles(join(root, 'missing'))).toEqual([]);
    symlinkSync(root, join(root, 'cycle'));
    writeFileSync(join(root, 'readme.txt'), '{}');
    expect(await recentSessionFiles(root)).toEqual([]);
    await expect(recentSessionFiles(root, 0)).rejects.toThrow('limit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
