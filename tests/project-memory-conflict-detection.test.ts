import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectProjectMemory,
  initializeProjectMemory,
  previewProjectMemoryConflict,
  projectMemoryRemoteMovedSinceSync,
  pullProjectMemory,
  pushProjectMemory,
  readMemoryDocument,
  resolveProjectMemoryConflict,
  sessionPreflightBlocksSave,
  writeMemoryDocument,
} from '../project-memory-server';
import { compareProjectMemoryEntries } from '../src/projectMemoryConflictEntries';
import { projectMemoryConflictFromResult, projectMemoryConflictSummary } from '../src/projectMemoryConflict';

/**
 * Conflict detection → resolution for project memory (VOC 2026-11-01). The dock said 「로컬·Supabase 기억이 모두 바뀌어
 * 저장하지 않았습니다」 when only the local side had changed: the session save's preflight Pull reported every local
 * edit as a conflict, whether or not Supabase had moved. These run the real server functions against a fake Supabase.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const BASE_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_ID = '22222222-2222-4222-8222-222222222222';
const entry = (title: string, id: string, body: string) => `\n### ${title}\n<!-- memory-entry-id:${id} -->\n\n- ${body}\n`;

interface Revision { id: string; memory_id: string; parent_revision_id: string | null; content: string; content_hash: string; created_at: string; device_name?: string }

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A temp project whose memory last synced at `base`, plus a stateful fake Supabase holding its revisions. */
function fixture(options: { localExtra?: string; remoteExtra?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-conflict-'));
  const folder = join(dir, 'project'); mkdirSync(folder);
  initializeProjectMemory({ folderPath: folder, projectName: 'Conflict', agent: 'codex', autoBackup: true });
  const status = detectProjectMemory(folder);
  const root = status.projectRoot, memoryPath = status.memoryPath!, memoryId = status.config!.memoryId;
  const base = readMemoryDocument(root, memoryPath).trimEnd() + '\n' + entry('Shared decision', 'a'.repeat(24), 'both sides keep this');
  writeMemoryDocument(root, memoryPath, base + (options.localExtra ?? ''));
  const statePath = join(root, '.agent-memory/state.json');
  writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), lastSyncedHash: sha(base), lastPulledRevisionId: BASE_ID }));

  const revisions: Revision[] = [{ id: BASE_ID, memory_id: memoryId, parent_revision_id: null, content: base, content_hash: sha(base), created_at: '2026-10-31T00:00:00.000Z' }];
  if (options.remoteExtra) {
    const content = base + options.remoteExtra;
    revisions.push({ id: REMOTE_ID, memory_id: memoryId, parent_revision_id: BASE_ID, content, content_hash: sha(content), created_at: '2026-10-31T01:00:00.000Z', device_name: 'Other Mac' });
  }
  const requests: { method: string; path: string; body?: any }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url), body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined);
    requests.push({ method: req.method, path: url.pathname, body });
    if (url.pathname.endsWith('/portmgr_project_memory_aliases')) return Response.json(null);
    if (url.pathname.endsWith('/portmgr_project_memories')) return Response.json({ memory_id: memoryId, canonical_repo_key: null });
    if (url.pathname.endsWith('/portmgr_project_memory_revisions') && req.method === 'GET') {
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      const newest = [...revisions].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return Response.json(id ? newest.filter(r => r.id === id) : newest.slice(0, 1));
    }
    if (url.pathname.endsWith('/rpc/portmgr_append_project_memory_revision')) {
      const head = [...revisions].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
      if (body.p_expected_parent_revision_id !== head.id) return Response.json([{ inserted: false, current_head_revision_id: head.id }]);
      revisions.push({ id: body.p_id, memory_id: body.p_memory_id, parent_revision_id: head.id, content: body.p_content, content_hash: body.p_content_hash, created_at: new Date(Date.parse(head.created_at) + 60_000).toISOString() });
      return Response.json([{ inserted: true, current_head_revision_id: body.p_id }]);
    }
    return req.method === 'GET' ? Response.json([]) : Response.json(null);
  } });
  const portalDataFile = join(dir, 'portal.json');
  writeFileSync(portalDataFile, JSON.stringify({ supabaseUrl: `http://127.0.0.1:${server.port}`, supabaseAnonKey: 'fixture', deviceId: 'this-mac' }));
  cleanups.push(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const appended = () => requests.filter(r => r.path.endsWith('/rpc/portmgr_append_project_memory_revision'));
  return { folder, root, memoryPath, memoryId, base, revisions, requests, appended, portalDataFile, statePath };
}

describe('the shared rule: did Supabase move since this device last synced?', () => {
  test('unchanged when the head is the last pulled revision or still holds the last synced bytes', () => {
    const config = { lastPulledRevisionId: 'r1', lastSyncedHash: 'h1' };
    expect(projectMemoryRemoteMovedSinceSync({ id: 'r1', content_hash: 'h2' }, config)).toBe(false);
    expect(projectMemoryRemoteMovedSinceSync({ id: 'r9', content_hash: 'h1' }, config)).toBe(false);
    expect(projectMemoryRemoteMovedSinceSync({ id: 'r9', content_hash: 'h9' }, config)).toBe(true);
    expect(projectMemoryRemoteMovedSinceSync(null, config)).toBe(false);
  });
  test('no recorded agreement counts as moved, so the unknown case stays guarded', () => {
    expect(projectMemoryRemoteMovedSinceSync({ id: 'r1', content_hash: 'h1' }, { lastPulledRevisionId: null, lastSyncedHash: null })).toBe(true);
  });
  test('the session save stops only for a head that moved (or a payload that does not say)', () => {
    expect(sessionPreflightBlocksSave({ conflict: true, remoteChangedSinceSync: true })).toBe(true);
    expect(sessionPreflightBlocksSave({ conflict: true })).toBe(true);
    expect(sessionPreflightBlocksSave({ conflict: true, remoteChangedSinceSync: false })).toBe(false);
    expect(sessionPreflightBlocksSave({ conflict: false })).toBe(false);
    expect(sessionPreflightBlocksSave(null)).toBe(false);
  });
});

describe('local work on an unchanged Supabase head is not a conflict', () => {
  test('Pull still refuses to replace the local edit, but says Supabase did not move', async () => {
    const f = fixture({ localExtra: entry('Local only', 'b'.repeat(24), 'not backed up yet') });
    const before = readMemoryDocument(f.root, f.memoryPath);
    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });
    expect(pulled.conflict).toBe(true);
    expect(pulled.remoteChangedSinceSync).toBe(false);
    expect(pulled.localChangedSinceSync).toBe(true);
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(before);
    // This exact answer used to end the session save with 「로컬·Supabase 기억이 모두 바뀌어 저장하지 않았습니다」.
    expect(sessionPreflightBlocksSave(pulled)).toBe(false);
    const conflict = projectMemoryConflictFromResult(pulled, 'pull')!;
    expect(conflict.remoteChangedSinceSync).toBe(false);
    expect(projectMemoryConflictSummary(conflict)).toContain('Supabase는 마지막 동기화 이후 바뀌지 않았고');
    // The save's own Push then appends on top of the unchanged head.
    const pushed: any = await pushProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });
    expect(pushed.conflict).toBeUndefined();
    expect(f.appended()).toHaveLength(1);
    expect(f.appended()[0]!.body).toMatchObject({ p_expected_parent_revision_id: BASE_ID, p_content: before });
  });
});

describe('a real conflict: compare, then resolve only by the person\'s choice', () => {
  const both = () => fixture({
    localExtra: entry('Local addition', 'b'.repeat(24), 'added on this Mac'),
    remoteExtra: entry('Remote addition', 'c'.repeat(24), 'added on the other Mac'),
  });

  test('the save preflight stops, and nothing is written on either side', async () => {
    const f = both();
    const before = readMemoryDocument(f.root, f.memoryPath), state = readFileSync(f.statePath, 'utf8');
    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });
    expect(pulled).toMatchObject({ conflict: true, remoteChangedSinceSync: true, remoteRevisionId: REMOTE_ID });
    expect(sessionPreflightBlocksSave(pulled)).toBe(true);
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(before);
    expect(JSON.parse(readFileSync(f.statePath, 'utf8')).lastSyncedHash).toBe(JSON.parse(state).lastSyncedHash);
    expect(f.appended()).toHaveLength(0);
  });

  test('the comparison is read-only and carries the last agreed revision, so additions are told from deletions', async () => {
    const f = both();
    const before = readMemoryDocument(f.root, f.memoryPath), state = readFileSync(f.statePath, 'utf8');
    const preview: any = await previewProjectMemoryConflict({ folderPath: f.folder, portalDataFile: f.portalDataFile });
    expect(preview).toMatchObject({ conflict: true, remoteRevisionId: REMOTE_ID, baseRevisionId: BASE_ID, baseContent: f.base, remoteChangedSinceSync: true });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(before);
    expect(readFileSync(f.statePath, 'utf8')).toBe(state);
    const comparison = compareProjectMemoryEntries({ localContent: preview.localContent, remoteContent: preview.remoteContent, baseContent: preview.baseContent });
    expect(comparison.differences.map(d => [d.title, d.change])).toEqual([['Local addition', 'local-added'], ['Remote addition', 'remote-added']]);
    expect(comparison.merge.ok).toBe(true);
  });

  test('a base whose bytes do not match the synced hash is not trusted', async () => {
    const f = both();
    f.revisions[0]!.content += '\ntampered';
    const preview: any = await previewProjectMemoryConflict({ folderPath: f.folder, portalDataFile: f.portalDataFile });
    expect(preview.baseContent).toBeNull();
    const comparison = compareProjectMemoryEntries({ localContent: preview.localContent, remoteContent: preview.remoteContent, baseContent: preview.baseContent });
    expect(comparison.merge.ok).toBe(false);
  });

  test('a chosen merge keeps both additions once, backs up local and appends on the shown head; a replay is stale', async () => {
    const f = both();
    const preview: any = await previewProjectMemoryConflict({ folderPath: f.folder, portalDataFile: f.portalDataFile });
    const comparison = compareProjectMemoryEntries({ localContent: preview.localContent, remoteContent: preview.remoteContent, baseContent: preview.baseContent });
    if (!comparison.merge.ok) throw Error(comparison.merge.reason);
    const choice = {
      folderPath: f.folder, portalDataFile: f.portalDataFile, strategy: 'merged' as const, mergedContent: comparison.merge.content,
      expectedLocalHash: preview.localContentHash, expectedRemoteRevisionId: preview.remoteRevisionId, expectedRemoteContentHash: preview.remoteContentHash,
    };
    const resolved: any = await resolveProjectMemoryConflict(choice);
    expect(resolved).toMatchObject({ success: true, strategy: 'merged', preservedRemoteRevisionId: REMOTE_ID });
    expect(typeof resolved.backupPath).toBe('string');
    const saved = readMemoryDocument(f.root, f.memoryPath);
    for (const id of ['a', 'b', 'c']) expect(saved.split(`memory-entry-id:${id.repeat(24)}`)).toHaveLength(2);
    expect(f.appended()).toHaveLength(1);
    expect(f.appended()[0]!.body).toMatchObject({ p_expected_parent_revision_id: REMOTE_ID, p_content: saved });
    expect(JSON.parse(readFileSync(f.statePath, 'utf8')).lastSyncedHash).toBe(sha(saved));
    // The same reviewed choice again (a resend) finds a newer head and changes nothing.
    const replay: any = await resolveProjectMemoryConflict(choice);
    expect(replay.stale).toBe(true);
    expect(f.appended()).toHaveLength(1);
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(saved);
  });
});

describe('session save wiring', () => {
  test('the preflight Pull decides through the shared rule before refusing the save', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'project-memory-server.ts'), 'utf8');
    const start = source.indexOf('export async function sessionEndProjectMemory');
    const body = source.slice(start, source.indexOf('await updateProjectMemory(input)', start));
    expect(body.indexOf('sessionPreflightBlocksSave(preflight)')).toBeGreaterThan(-1);
    expect(body.indexOf('sessionPreflightBlocksSave(preflight)')).toBeLessThan(body.indexOf('preflightConflict: true'));
    const push = source.slice(source.indexOf('export async function pushProjectMemory('), source.indexOf('export async function pullProjectMemory('));
    expect(push).toContain('projectMemoryRemoteMovedSinceSync(latest, config)');
  });
});
