import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface RecentSessionFile { full: string; size: number; mtimeMs: number }

/** Stream directory entries and keep only the newest bounded candidates.
 * No transcript body reads, symlink traversal or all-history array/sort. The
 * scan is still O(file count), but every filesystem wait yields to the API. */
export async function recentSessionFiles(root: string, limit = 96): Promise<RecentSessionFile[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Invalid session discovery limit');
  const newest: RecentSessionFile[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 16) return;
    let entries;
    try { entries = await opendir(directory, { bufferSize: 32 }); }
    catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
    for await (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let stamp;
      try { stamp = await stat(full); }
      catch (error: any) { if (error?.code === 'ENOENT') continue; throw error; }
      if (!stamp.isFile()) continue;
      const candidate = { full, size: stamp.size, mtimeMs: stamp.mtimeMs };
      let index = newest.findIndex(file => candidate.mtimeMs > file.mtimeMs
        || (candidate.mtimeMs === file.mtimeMs && candidate.full < file.full));
      if (index < 0) index = newest.length;
      if (index >= limit) continue;
      newest.splice(index, 0, candidate);
      if (newest.length > limit) newest.pop();
    }
  }
  await walk(root, 0);
  return newest;
}

/** Share concurrent scans only; completed snapshots do not hide later appends. */
export function createRecentSessionFileDiscovery(root: string) {
  let pending: Promise<RecentSessionFile[]> | null = null;
  return (limit = 96): Promise<RecentSessionFile[]> => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 96) return Promise.reject(new Error('Invalid session discovery limit'));
    if (!pending) {
      const scan = recentSessionFiles(root, 96).finally(() => { if (pending === scan) pending = null; });
      pending = scan;
    }
    return pending.then(files => files.slice(0, limit));
  };
}
