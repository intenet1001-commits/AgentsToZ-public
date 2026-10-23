// T8: the phone's 'local-common' view hides cloud-fenced copies and stops making new local groups while the cloud answers.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaCommonMemoryStore } from '../src/metaCommonMemoryStore';
import { MetaCommonMemoryService, META_MEMORY_CLOUD_TAB_MESSAGE } from '../src/metaCommonMemoryService';
import { MetaCommonMemoryRemoteHost, metaMemoryRemoteProjectRef } from '../src/metaCommonMemoryRemoteHost';
import { createMetaMemoryRemoteRequester } from '../src/metaCommonMemoryRemoteClient';
import { MetaMemoryClientError } from '../src/metaCommonMemoryClient';
import { createMobileWorkspaceGateway } from '../src/mobileWorkspaceGateway';
import { normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult } from '../src/mobileWorkspaceProtocol';
import { metaMemoryCloudHintFor, META_MEMORY_CLOUD_TAB_CODES } from '../src/RemoteMetaCommonMemoryCloudHint';
import { createCommonMemoryService, clearCommonMemoryServiceCaches } from '../common-memory-server';
import { createCommonMemoryMigration } from '../common-memory-migration-server';
import { CommonCloud } from './fixtures/common-memory/cloud';
import type { MetaMemoryProject } from '../src/metaCommonMemoryContract';

const hosts: MetaCommonMemoryRemoteHost[] = [], dirs: string[] = [];
afterEach(() => { clearCommonMemoryServiceCaches(); for (const h of hosts.splice(0)) h.dispose(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const SCOPE = 'e'.repeat(64);
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (name: string) => ({ operation: 'save', expectedRevision: 0, requestId: randomUUID(), name, description: '', tags: [], categories: [], assignments: [] });
const fence = (store: MetaCommonMemoryStore, id: string) => { const s = store.read(id); store.prepareHandoff({ groupId: id, scopeId: SCOPE, requestId: randomUUID(), requestHash: 'b'.repeat(64), sourceFingerprint: createHash('sha256').update(JSON.stringify(s)).digest('hex') }, s.revision, '{}'); };

/** The phone path end to end, with the policy wired exactly as api-server.ts wires the kind='meta' branch. */
function world(cloudAvailable: () => Promise<boolean>) {
  const root = mkdtempSync(join(tmpdir(), 'local-fence-')); dirs.push(root);
  const store = new MetaCommonMemoryStore(root), projects: MetaMemoryProject[] = [{ id: 'reg', name: 'A', category: 'NHCS', memoryId: randomUUID(), state: 'ready' }];
  const desktop = new MetaCommonMemoryService(store, { projects: async () => projects, prepareProject: async () => {} });
  let availability = 0;
  const host = new MetaCommonMemoryRemoteHost(async (owner, request, active) => new MetaCommonMemoryService(store, {
    assertActive: () => { if (!active()) throw Error('revoked'); },
    projects: async () => projects.map(p => ({ ...p, id: metaMemoryRemoteProjectRef(owner, p.id) })),
    prepareProject: async () => {},
  }, { remote: { cloudAvailable: async () => { availability++; return cloudAvailable(); } } }).execute(request)); hosts.push(host);
  const gateway = createMobileWorkspaceGateway({
    terminal: async () => { throw Error('no terminal'); }, active: () => true, resolve: async () => [],
    consent: async () => ({ targetIds: new Set<string>(), workspaceScopes: ['meta-memory.manage'], isActive: () => true, requestOwner: 'device:host:phone' }),
    perform: async () => { throw Error('not a project action'); },
    metaMemory: (r, owner, active) => host.perform(owner, r, active),
  });
  const phone = createMetaMemoryRemoteRequester(async r => { normalizeMobileWorkspaceRequest(r); const result = await gateway(r, [], 'internet:phone') as any; normalizeMobileWorkspaceResult(result); return result; });
  return { store, desktop, phone, availability: () => availability };
}
const refusal = async (run: Promise<unknown>) => { try { await run; } catch (e) { return e as MetaMemoryClientError; } throw Error('expected a refusal'); };

describe('phone local-common', () => {
  test('the list hides fenced groups (with exact totals) and keeps unfenced ones; the desktop still sees both', async () => {
    const w = world(async () => true);
    const migrated = (await w.desktop.execute(save('NHCS 공통'))).memory, local = (await w.desktop.execute(save('이 Mac 전용'))).memory;
    fence(w.store, migrated.id);
    const listed = await w.phone({ operation: 'list', query: '', offset: 0 });
    expect(listed.memories.map((m: any) => m.id)).toEqual([local.id]); expect(listed.total).toBe(1); expect(listed.nextOffset).toBeNull();
    expect((await w.phone({ operation: 'read', memoryId: local.id })).memory.name).toBe('이 Mac 전용');
    expect((await w.desktop.execute({ operation: 'list', query: '', offset: 0 })).total).toBe(2);
    expect((await w.desktop.execute({ operation: 'read', memoryId: migrated.id })).memory.name).toBe('NHCS 공통');
    expect(w.availability()).toBe(0);
  });
  test('paging past 50 fenced groups never lets them crowd out the unfenced page', async () => {
    const w = world(async () => true), fencedIds: string[] = [];
    const keep = (await w.desktop.execute(save('남는 기억'))).memory;
    for (let i = 0; i < 52; i++) { const g = (await w.desktop.execute(save('옮긴 ' + i))).memory; fence(w.store, g.id); fencedIds.push(g.id); }
    const listed = await w.phone({ operation: 'list', query: '', offset: 0 });
    expect(listed.memories.map((m: any) => m.id)).toEqual([keep.id]); expect(listed.total).toBe(1);
  });
  test('a fenced read, history or export is a definite META_MEMORY_CLOUD_AUTHORITY that the v1 client parses', async () => {
    const w = world(async () => true), g = (await w.desktop.execute(save('옮긴 기억'))).memory; fence(w.store, g.id);
    for (const body of [{ operation: 'read', memoryId: g.id }, { operation: 'history', memoryId: g.id }, { operation: 'export', memoryId: g.id }]) {
      const e = await refusal(w.phone(body));
      expect(e).toBeInstanceOf(MetaMemoryClientError); expect(e.code).toBe('META_MEMORY_CLOUD_AUTHORITY'); expect(e.message).toBe(META_MEMORY_CLOUD_TAB_MESSAGE); expect(e.uncertain).toBe(false);
    }
  });
  test('create is refused while the cloud answers and allowed without it; nothing in SQLite changes on refusals', async () => {
    let cloud = true; const w = world(async () => cloud);
    const g = (await w.desktop.execute(save('옮긴 기억'))).memory; fence(w.store, g.id);
    const before = sha(w.store.path);
    await w.phone({ operation: 'list', query: '', offset: 0 }); await refusal(w.phone({ operation: 'read', memoryId: g.id }));
    const e = await refusal(w.phone(save('폰에서 새로')));
    expect(e.code).toBe('META_MEMORY_CLOUD_REQUIRED'); expect(e.uncertain).toBe(false);
    const snapshot = { ...w.store.read(g.id), id: randomUUID() };
    expect((await refusal(w.phone({ operation: 'import', expectedRevision: 0, requestId: randomUUID(), snapshot }))).code).toBe('META_MEMORY_CLOUD_REQUIRED');
    expect(sha(w.store.path)).toBe(before); expect(w.store.list().total).toBe(1);
    cloud = false;
    const made = (await w.phone(save('폰에서 새로'))).memory;
    expect(w.store.read(made.id).name).toBe('폰에서 새로');
  });
  test('editing an unfenced group never asks the cloud; a cloud failure on create is reported, not turned into a local group', async () => {
    let fail = false; const w = world(async () => { if (fail) throw Object.assign(Error('네트워크 끊김'), { code: 'COMMON_MEMORY_CLOUD_UNAVAILABLE' }); return false; });
    const g = (await w.phone(save('폰 기억'))).memory, n = w.availability();
    await w.phone({ operation: 'save', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), name: '이름 바꿈', description: '', tags: [], categories: [], assignments: [] });
    expect(w.availability()).toBe(n);
    fail = true; await refusal(w.phone(save('실패')));
    expect(w.store.list().total).toBe(1);
  });
});

describe('cloudAvailable (the compatibility decision as yes/no)', () => {
  const migration = (cloud: CommonCloud | null) => {
    const root = mkdtempSync(join(tmpdir(), 'local-fence-cloud-')); dirs.push(root);
    return createCommonMemoryMigration(new MetaCommonMemoryStore(root), createCommonMemoryService(() => cloud), async () => []);
  };
  test('true only after a real cloud read; absent or unmigrated is false; any other failure is reported', async () => {
    const live = Object.assign(new CommonCloud(), { commonMemoryScope: SCOPE });
    expect(await migration(live).cloudAvailable()).toBe(true);
    expect(await migration(null).cloudAvailable()).toBe(false);
    const unmigrated = Object.assign(new CommonCloud(), { commonMemoryScope: SCOPE, error: { code: 'PGRST205', message: 'missing table' } });
    expect(await migration(unmigrated).cloudAvailable()).toBe(false);
    const broken = Object.assign(new CommonCloud(), { commonMemoryScope: SCOPE, error: { code: '57014', message: 'canceling statement' } });
    await expect(migration(broken).cloudAvailable()).rejects.toBeDefined();
  });
});

describe('cloud-tab hint', () => {
  test('a cloud-tab refusal or an empty unfiltered first page shows it; other outcomes leave it alone', () => {
    for (const code of META_MEMORY_CLOUD_TAB_CODES) expect(metaMemoryCloudHintFor({ operation: 'read' }, { error: new MetaMemoryClientError('x', code) })).toBe(true);
    expect(metaMemoryCloudHintFor({ operation: 'read' }, { error: new MetaMemoryClientError('x', 'META_MEMORY_CONFLICT') })).toBeUndefined();
    expect(metaMemoryCloudHintFor({ operation: 'list', query: '', offset: 0 }, { result: { total: 0 } })).toBe(true);
    expect(metaMemoryCloudHintFor({ operation: 'list', query: '', offset: 0 }, { result: { total: 2 } })).toBe(false);
    expect(metaMemoryCloudHintFor({ operation: 'list', query: '찾기', offset: 0 }, { result: { total: 0 } })).toBeUndefined();
    expect(metaMemoryCloudHintFor({ operation: 'read' }, { result: { memory: {} } })).toBeUndefined();
  });
});
