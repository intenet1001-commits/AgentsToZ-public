import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectProjectMemory,
  initializeProjectMemory,
  previewProjectMemoryConflict,
  projectMemoryHoldsNoLocalWork,
  pullProjectMemory,
  readMemoryDocument,
  resolveProjectMemoryConflict,
  sessionPreflightBlocksSave,
  writeMemoryDocument,
} from '../project-memory-server';
import { resolveAppDataDir } from '../src/appDataDir';
import { startTestApiServer } from './startTestApiServer';

/**
 * A device with no recorded agreement with Supabase (`lastSyncedHash` missing: first sync here, a state file lost or
 * never written, or a lineage the identity claim just adopted). Pull used to back up the local document and replace it
 * with the Supabase head, and `/api/project-memory/sync` — whose `conflict` direction runs that Pull — then answered
 * 409 `conflict: true` over the file it had just replaced, with the remote recorded as the new agreement (2026-11-01).
 * Now such a document is replaced only when nothing was ever written into it; otherwise the person chooses.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const REMOTE_ID = '22222222-2222-4222-8222-222222222222';
const entry = (title: string, id: string, body: string) => `\n### ${title}\n<!-- memory-entry-id:${id} -->\n\n- ${body}\n`;
const LOCAL_ONLY = entry('Only on this Mac', 'b'.repeat(24), 'never backed up anywhere');
const REMOTE_ONLY = entry('From the other Mac', 'c'.repeat(24), 'pushed elsewhere');

interface Revision { id: string; memory_id: string; parent_revision_id: string | null; content: string; content_hash: string; created_at: string; device_name?: string }

/** A stateful fake Supabase: revisions per memory_id, optional aliases, and the CAS append RPC. */
function fakeSupabase() {
  const state = { revisions: [] as Revision[], aliases: {} as Record<string, string>, appended: [] as any[] };
  const newest = (rows: Revision[]) => [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url), body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined);
    const eq = (name: string) => url.searchParams.get(name)?.replace(/^eq\./, '');
    if (url.pathname.endsWith('/portmgr_project_memory_aliases')) {
      const canonical = state.aliases[eq('alias_memory_id') ?? ''];
      return Response.json(canonical ? { canonical_memory_id: canonical } : null);
    }
    if (url.pathname.endsWith('/portmgr_project_memories')) return Response.json({ memory_id: eq('memory_id') ?? null, canonical_repo_key: null });
    if (url.pathname.endsWith('/portmgr_project_memory_revisions') && req.method === 'GET') {
      const id = eq('id'), memoryId = eq('memory_id');
      const rows = newest(state.revisions).filter(r => (!id || r.id === id) && (!memoryId || r.memory_id === memoryId));
      return Response.json(id ? rows : rows.slice(0, 1));
    }
    if (url.pathname.endsWith('/rpc/portmgr_append_project_memory_revision')) {
      state.appended.push(body);
      const head = newest(state.revisions.filter(r => r.memory_id === body.p_memory_id))[0];
      if ((head?.id ?? null) !== body.p_expected_parent_revision_id) return Response.json([{ inserted: false, current_head_revision_id: head?.id ?? null }]);
      state.revisions.push({ id: body.p_id, memory_id: body.p_memory_id, parent_revision_id: head?.id ?? null, content: body.p_content, content_hash: body.p_content_hash, created_at: new Date(Date.parse(head?.created_at ?? '2026-10-31T00:00:00.000Z') + 60_000).toISOString() });
      return Response.json([{ inserted: true, current_head_revision_id: body.p_id }]);
    }
    return req.method === 'GET' ? Response.json([]) : Response.json(null);
  } });
  return { state, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** A project initialized on this device with no recorded agreement — exactly what `initializeProjectMemory` leaves. */
function project(parent: string, name = 'project') {
  const folder = join(parent, name); mkdirSync(folder, { recursive: true });
  initializeProjectMemory({ folderPath: folder, projectName: 'Unagreed', agent: 'codex', autoBackup: true });
  const status = detectProjectMemory(folder);
  const root = status.projectRoot, memoryPath = status.memoryPath!, memoryId = status.config!.memoryId;
  const statePath = join(root, '.agent-memory/state.json');
  const template = readMemoryDocument(root, memoryPath);
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const backups = () => existsSync(join(root, '.agent-memory/backups'))
    ? readdirSync(join(root, '.agent-memory/backups')).filter(name => name.startsWith('CORE-')) : [];
  return { folder, root, memoryPath, memoryId, template, state, backups };
}

function remoteRevision(memoryId: string, content: string, createdAt = '2026-10-31T01:00:00.000Z'): Revision {
  return { id: REMOTE_ID, memory_id: memoryId, parent_revision_id: null, content, content_hash: sha(content), created_at: createdAt, device_name: 'Other Mac' };
}

describe('Pull with no recorded agreement (fake Supabase)', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-unagreed-'));
    const supabase = fakeSupabase();
    const portalDataFile = join(dir, 'portal.json');
    writeFileSync(portalDataFile, JSON.stringify({ supabaseUrl: supabase.url, supabaseAnonKey: 'fixture', deviceId: 'this-mac' }));
    cleanups.push(() => { supabase.stop(); rmSync(dir, { recursive: true, force: true }); });
    const p = project(dir);
    expect(p.state()).toMatchObject({ lastSyncedHash: null, lastPulledRevisionId: null });
    return { dir, supabase, portalDataFile, ...p };
  };

  test('local memory that differs is never replaced: a conflict with the comparison, nothing written', async () => {
    const f = setup();
    const local = f.template.trimEnd() + '\n' + LOCAL_ONLY;
    writeMemoryDocument(f.root, f.memoryPath, local);
    const remote = f.template.trimEnd() + '\n' + REMOTE_ONLY;
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, remote));
    const stateBefore = f.state();

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });

    // Before the fix: { success: true, restored: true, backupPath } and the local-only entry gone from memory.
    expect(pulled).toMatchObject({ success: false, conflict: true, remoteRevisionId: REMOTE_ID, remoteChangedSinceSync: true, localChangedSinceSync: true, lastSyncedHash: null });
    expect(pulled.restored).toBeUndefined();
    expect(pulled.backupPath).toBeUndefined();
    expect(pulled.localContent).toBe(local);
    expect(pulled.remoteContent).toBe(remote);
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(local);
    expect(f.backups()).toEqual([]);
    expect(f.state()).toMatchObject({ lastSyncedHash: stateBefore.lastSyncedHash, lastPulledRevisionId: stateBefore.lastPulledRevisionId });
    // The session save stops here too instead of consolidating into the replaced document.
    expect(sessionPreflightBlocksSave(pulled)).toBe(true);
    expect(f.supabase.state.appended).toHaveLength(0);
  });

  test('the person still decides through the existing compare → resolve flow (two-way, no base)', async () => {
    const f = setup();
    const local = f.template.trimEnd() + '\n' + LOCAL_ONLY;
    writeMemoryDocument(f.root, f.memoryPath, local);
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, f.template.trimEnd() + '\n' + REMOTE_ONLY));

    const preview: any = await previewProjectMemoryConflict({ folderPath: f.folder, portalDataFile: f.portalDataFile });
    expect(preview).toMatchObject({ conflict: true, remoteRevisionId: REMOTE_ID, baseRevisionId: null, baseContent: null });
    const resolved: any = await resolveProjectMemoryConflict({
      folderPath: f.folder, portalDataFile: f.portalDataFile, strategy: 'keep-local',
      expectedLocalHash: preview.localContentHash, expectedRemoteRevisionId: preview.remoteRevisionId, expectedRemoteContentHash: preview.remoteContentHash,
    });
    expect(resolved).toMatchObject({ success: true, strategy: 'keep-local', preservedRemoteRevisionId: REMOTE_ID });
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(local);
    expect(f.supabase.state.appended).toHaveLength(1);
    expect(f.supabase.state.appended[0]).toMatchObject({ p_expected_parent_revision_id: REMOTE_ID, p_content: local });
    // The choice records the agreement, so the next sync has a baseline.
    expect(f.state().lastSyncedHash).toBe(sha(local));
  });

  test('identical bytes record the agreement, so later syncs have a baseline', async () => {
    const f = setup();
    const shared = f.template.trimEnd() + '\n' + LOCAL_ONLY;
    writeMemoryDocument(f.root, f.memoryPath, shared);
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, shared));

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });

    expect(pulled).toMatchObject({ success: true, alreadySynced: true, revisionId: REMOTE_ID });
    expect(pulled.conflict).toBeUndefined();
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(shared);
    expect(f.backups()).toEqual([]);
    expect(f.state()).toMatchObject({ lastSyncedHash: sha(shared), lastPulledRevisionId: REMOTE_ID });
  });

  test('first-time adoption still works: the untouched template takes the Supabase memory (with a backup)', async () => {
    const f = setup();
    expect(projectMemoryHoldsNoLocalWork(f.template)).toBe(true);
    const remote = f.template.trimEnd() + '\n' + REMOTE_ONLY;
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, remote));

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });

    expect(pulled).toMatchObject({ success: true, restored: true, revisionId: REMOTE_ID });
    expect(pulled.conflict).toBeUndefined();
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(remote);
    expect(f.state()).toMatchObject({ lastSyncedHash: sha(remote), lastPulledRevisionId: REMOTE_ID });
  });

  test('a missing local document is created from the template and adopts Supabase', async () => {
    const f = setup();
    unlinkSync(f.memoryPath);
    const remote = f.template.trimEnd() + '\n' + REMOTE_ONLY;
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, remote));

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });

    expect(pulled).toMatchObject({ success: true, restored: true });
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(remote);
  });

  test('an empty local document adopts Supabase', async () => {
    const f = setup();
    writeFileSync(f.memoryPath, '');
    expect(projectMemoryHoldsNoLocalWork(readMemoryDocument(f.root, f.memoryPath))).toBe(true);
    const remote = f.template.trimEnd() + '\n' + REMOTE_ONLY;
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, remote));

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });

    expect(pulled).toMatchObject({ success: true, restored: true });
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(remote);
  });

  test('one edited template line is already someone\'s memory and is not replaced', async () => {
    const f = setup();
    const edited = f.template.replace('- Purpose: To be confirmed during the first memory update.', '- Purpose: ship the billing export.');
    expect(edited).not.toBe(f.template);
    expect(projectMemoryHoldsNoLocalWork(edited)).toBe(false);
    writeMemoryDocument(f.root, f.memoryPath, edited);
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, f.template.trimEnd() + '\n' + REMOTE_ONLY));

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });

    expect(pulled.conflict).toBe(true);
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(edited);
  });

  test('a lineage the identity claim adopts (cursor cleared) does not replace this device\'s memory', async () => {
    const f = setup();
    const local = f.template.trimEnd() + '\n' + LOCAL_ONLY;
    writeMemoryDocument(f.root, f.memoryPath, local);
    // This device had agreed with its own lineage; the registry now names another one.
    const statePath = join(f.root, '.agent-memory/state.json');
    writeFileSync(statePath, JSON.stringify({ ...f.state(), lastSyncedHash: sha(local), lastPulledRevisionId: '33333333-3333-4333-8333-333333333333' }));
    const canonical = '44444444-4444-4444-8444-444444444444';
    f.supabase.state.aliases[f.memoryId] = canonical;
    f.supabase.state.revisions.push(remoteRevision(canonical, f.template.trimEnd() + '\n' + REMOTE_ONLY));

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile });

    expect(detectProjectMemory(f.folder).config!.memoryId).toBe(canonical);
    expect(f.state()).toMatchObject({ lastSyncedHash: null, lastPulledRevisionId: null });
    expect(pulled).toMatchObject({ conflict: true, remoteRevisionId: REMOTE_ID });
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(local);
    expect(f.backups()).toEqual([]);
  });

  test('an explicit forced Pull is still the person\'s choice to replace (with a backup)', async () => {
    const f = setup();
    const local = f.template.trimEnd() + '\n' + LOCAL_ONLY;
    writeMemoryDocument(f.root, f.memoryPath, local);
    const remote = f.template.trimEnd() + '\n' + REMOTE_ONLY;
    f.supabase.state.revisions.push(remoteRevision(f.memoryId, remote));

    const pulled: any = await pullProjectMemory({ folderPath: f.folder, portalDataFile: f.portalDataFile, force: true });

    expect(pulled).toMatchObject({ success: true, restored: true });
    expect(readMemoryDocument(f.root, f.memoryPath)).toBe(remote);
    expect(readFileSync(pulled.backupPath, 'utf8')).toBe(local);
  });
});

describe('/api/project-memory/sync with no recorded agreement (real API, fake Supabase)', () => {
  let home = '', baseUrl = '', child: Bun.Subprocess | null = null;
  let supabase: ReturnType<typeof fakeSupabase>;
  let count = 0;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'memory-unagreed-api-'));
    supabase = fakeSupabase();
    const env = { ...process.env, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config'), PORTMGR_ALLOWED_ORIGINS: '' };
    const appData = resolveAppDataDir(process.platform, env, home);
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(appData, 'portal.json'), JSON.stringify({ supabaseUrl: supabase.url, supabaseAnonKey: 'fixture', deviceId: 'this-mac' }));
    writeFileSync(join(appData, 'ports.json'), '[]');
    ({ baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env }));
  }, 60_000);
  afterAll(async () => {
    try { child?.kill(); } catch {}
    await child?.exited.catch(() => undefined);
    supabase?.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const sync = async (folderPath: string) => {
    const response = await fetch(`${baseUrl}/api/project-memory/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderPath }) });
    return { status: response.status, body: await response.json() as any };
  };
  /** Pins the file time against the remote revision time so the status heuristic picks a known direction. */
  const pinned = (withLocalEntry: boolean, remoteCreatedAt: string) => {
    supabase.state.revisions = [];
    const p = project(join(home, 'projects'), `p${++count}`);
    if (withLocalEntry) writeMemoryDocument(p.root, p.memoryPath, p.template.trimEnd() + '\n' + LOCAL_ONLY);
    const when = new Date('2026-10-31T00:00:00.000Z'); utimesSync(p.memoryPath, when, when);
    const remote = p.template.trimEnd() + '\n' + REMOTE_ONLY;
    supabase.state.revisions.push(remoteRevision(p.memoryId, remote, remoteCreatedAt));
    return { ...p, remote, local: readMemoryDocument(p.root, p.memoryPath) };
  };

  test('the `conflict` direction answers the conflict and leaves local memory exactly as it was', async () => {
    const p = pinned(true, '2026-10-31T00:00:00.000Z');
    const { status, body } = await sync(p.folder);
    // Before the fix: 409 { conflict: true, restored: true, success: true, backupPath } over a replaced document.
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, direction: 'conflict', action: 'none', conflict: true, remoteRevisionId: REMOTE_ID, localContent: p.local, remoteContent: p.remote });
    expect(body.restored).toBeUndefined();
    expect(body.backupPath).toBeUndefined();
    expect(readMemoryDocument(p.root, p.memoryPath)).toBe(p.local);
    expect(p.backups()).toEqual([]);
    expect(p.state()).toMatchObject({ lastSyncedHash: null, lastPulledRevisionId: null });
  }, 30_000);

  test('a `pull` direction (Supabase looks newer) answers the conflict at the top level instead of replacing', async () => {
    const p = pinned(true, '2026-10-31T05:00:00.000Z');
    const { status, body } = await sync(p.folder);
    expect(status).toBe(409);
    // Top level, where the panel, the dock and the skills look for it (nested it showed only 「요청 실패 (409)」).
    expect(body).toMatchObject({ ok: false, direction: 'pull', action: 'none', conflict: true, localContent: p.local });
    expect(readMemoryDocument(p.root, p.memoryPath)).toBe(p.local);
    expect(p.backups()).toEqual([]);
  }, 30_000);

  test('an untouched template in the `conflict` direction is adopted and answered as the Pull it was', async () => {
    const p = pinned(false, '2026-10-31T00:00:00.000Z');
    const { status, body } = await sync(p.folder);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, direction: 'conflict', action: 'pull', result: { success: true, restored: true, revisionId: REMOTE_ID } });
    expect(body.conflict).toBeUndefined();
    expect(readMemoryDocument(p.root, p.memoryPath)).toBe(p.remote);
    expect(p.state()).toMatchObject({ lastSyncedHash: sha(p.remote), lastPulledRevisionId: REMOTE_ID });
  }, 30_000);
});
