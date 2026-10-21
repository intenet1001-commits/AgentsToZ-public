import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaCommonMemoryStore } from '../src/metaCommonMemoryStore';
import { MetaCommonMemoryService } from '../src/metaCommonMemoryService';
import { META_COMMON_MEMORY_LIMITS, parseMetaMemoryRequest, type MetaMemoryProject } from '../src/metaCommonMemoryContract';
import { projectMetaMemoryContext, projectMetaMemoryPrompt, installProjectMetaMemoryReader } from '../src/projectMetaMemoryContext';
import { META_COMMON_MEMORY_LEGACY_TOOL_SCHEMAS, metaCommonMemoryMcpAction } from '../src/metaCommonMemoryMcp';
import { parseAgentsToZUseActionRequest } from '../src/agentstozUseControl';

const roots: string[] = [];
afterEach(() => { installProjectMetaMemoryReader(null); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'meta-common-memory-')); roots.push(root);
  const store = new MetaCommonMemoryStore(root);
  const projects: MetaMemoryProject[] = ['A', 'B', 'C', 'D'].map((name, i) => ({ id: name, name, category: i < 2 ? 'NHCS' : '앱', memoryId: randomUUID(), state: 'ready' }));
  const service = new MetaCommonMemoryService(store, { projects: async () => projects, prepareProject: async () => {} });
  const create = async (extra: Record<string, unknown> = {}) => (await service.execute({ operation: 'save', requestId: randomUUID(), expectedRevision: 0, name: 'NHCS 공통 기억', ...extra })).memory;
  const assign = (index: number, mode = 'include') => ({ portId: projects[index]!.id, expectedMemoryId: projects[index]!.memoryId, mode });
  const entry = async (g: any, title = 'NHCS 배포 호환', body = 'NHCS 앱과 스킬의 배포 호환은 실제 검증 결과를 기록한다.', extra = {}) => (await service.execute({ operation: 'save-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), title, body, ...extra })).memory;
  return { root, store, service, projects, create, assign, entry };
}
describe('independent meta common memory and project scope', () => {
  test('empty status reads never create a store, and a memory needs no source or member project', async () => {
    const f = fixture(); expect(f.store.list().memories).toEqual([]); expect(existsSync(f.store.directory)).toBe(false);
    const g = await f.create(); expect(g.members).toEqual([]); expect(g.id).not.toBe(f.projects[0]!.memoryId);
    expect(new MetaCommonMemoryStore(f.root).read(g.id)).toEqual(g);
  });
  test('A/B and B/C have different overlapping memories with no copy into any project', async () => {
    const f = fixture(); const ab = await f.entry(await f.create({ assignments: [f.assign(0), f.assign(1)] }));
    const bc = await f.entry(await f.create({ name: 'Tauri 공통 기억', assignments: [f.assign(1), f.assign(2)] }), 'Tauri 배포', 'Tauri 배포의 앱 서명 근거를 확인한다.');
    expect(f.store.recall(f.projects[0]!.memoryId!, '배포').groups.map(g => g.id)).toEqual([ab.id]);
    expect(new Set(f.store.recall(f.projects[1]!.memoryId!, '배포').groups.map(g => g.id))).toEqual(new Set([ab.id, bc.id]));
    expect(f.store.recall(f.projects[3]!.memoryId!, '배포').hits).toEqual([]);
  });
  test('category default applies to existing and new projects; explicit exclusion wins and inherit restores it', async () => {
    const f = fixture(); let g = await f.entry(await f.create({ categories: ['NHCS'], assignments: [f.assign(1, 'exclude')] }));
    expect(f.store.recall(f.projects[0]!.memoryId!, '배포', 'NHCS').hits).toHaveLength(1);
    expect(f.store.recall(f.projects[1]!.memoryId!, '배포', 'NHCS').hits).toHaveLength(0);
    expect(f.store.recall(randomUUID(), '배포', 'NHCS').hits).toHaveLength(1);
    g = (await f.service.execute({ operation: 'save', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), name: g.name, categories: ['NHCS'], assignments: [f.assign(1, 'inherit')] })).memory;
    expect(f.store.recall(f.projects[1]!.memoryId!, '배포', 'NHCS').hits).toHaveLength(1);
    expect(f.store.recall(f.projects[0]!.memoryId!, '배포', '다른 카테고리').groups).toEqual([]);
  });
  test('source project removal and display renames do not change common identity or lose stored links', async () => {
    const f = fixture(); const g = await f.create({ assignments: [f.assign(0), f.assign(1)] }); const first = f.projects.shift()!;
    const renamed = (await f.service.execute({ operation: 'save', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), name: '새 공통 이름', assignments: [] })).memory;
    expect(renamed.id).toBe(g.id); expect(renamed.members.some((m: any) => m.memoryId === first.memoryId)).toBe(true);
  });
  test('rebound project IDs and opposite checkboxes for a worktree family fail before any save', async () => {
    const f = fixture(); const a = f.assign(0); f.projects[0]!.memoryId = randomUUID();
    await expect(f.create({ assignments: [a] })).rejects.toMatchObject({ code: 'META_MEMORY_PROJECT_UNAVAILABLE' });
    expect(f.store.list().total).toBe(0);
    f.projects[1]!.memoryId = f.projects[0]!.memoryId;
    await expect(f.create({ assignments: [f.assign(0), f.assign(1, 'exclude')] })).rejects.toMatchObject({ code: 'META_MEMORY_ASSIGNMENT_CONFLICT' });
  });
  test('a candidate is invisible to recall until reviewed, and contested knowledge retains its marker', async () => {
    const f = fixture(); let g = await f.create({ assignments: [f.assign(0)] });
    const result = await f.service.execute({ operation: 'propose-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), title: 'NHCS 배포 근거', body: '검증한 공통 배포 교훈.', portId: 'A' });
    expect(result.saved).toBe(false); expect(result.candidate).toBe(true); g = result.memory;
    expect(f.store.recall(f.projects[0]!.memoryId!, '배포').hits).toEqual([]);
    g = (await f.service.execute({ operation: 'review-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), entryId: g.entries[0].id, state: 'contested' })).memory;
    expect(f.store.recall(f.projects[0]!.memoryId!, '배포').hits[0]!.state).toBe('contested');
    g = (await f.service.execute({ operation: 'review-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), entryId: g.entries[0].id, state: 'superseded' })).memory;
    expect(g.entries).toHaveLength(1); expect(f.store.recall(f.projects[0]!.memoryId!, '배포').hits).toEqual([]);
  });
  test('unlinked projects cannot submit candidates and an AI candidate cannot rewrite an accepted entry', async () => {
    const f = fixture(); const g = await f.entry(await f.create({ assignments: [f.assign(0)] }));
    const propose = { operation: 'propose-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), title: '배포', body: '새 교훈' };
    await expect(f.service.execute({ ...propose, portId: 'B' })).rejects.toMatchObject({ code: 'META_MEMORY_PROJECT_NOT_LINKED' });
    await expect(f.service.execute({ ...propose, entryId: g.entries[0].id })).rejects.toMatchObject({ code: 'META_MEMORY_PROPOSAL_INVALID' });
    expect(f.store.read(g.id)).toEqual(g);
  });
  test('archive stops all manual and category application while preserving contents and links', async () => {
    const f = fixture(); let g = await f.entry(await f.create({ assignments: [f.assign(0)], categories: ['NHCS'] }));
    g = (await f.service.execute({ operation: 'archive', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), archived: true })).memory;
    expect(g.entries).toHaveLength(1); expect(g.members).toHaveLength(1);
    expect(f.store.recall(f.projects[0]!.memoryId!, '배포', 'NHCS').hits).toEqual([]);
  });
});
describe('atomic revision, retry and portable backup', () => {
  test('the same request replays exactly once and a reused ID with different data is rejected', async () => {
    const f = fixture(); const r = { operation: 'save', name: '독립 기억', expectedRevision: 0, requestId: randomUUID(), assignments: [f.assign(0)] };
    const a = await f.service.execute(r); const b = await f.service.execute(r); expect(a).toEqual(b); expect(f.store.history(a.memory.id)).toHaveLength(1);
    await expect(f.service.execute({ ...r, name: '다른 내용' })).rejects.toMatchObject({ code: 'META_MEMORY_REQUEST_REUSED' });
  });
  test('two store instances with the same baseline cannot silently overwrite each other', async () => {
    const f = fixture(); const g = await f.create(); const other = new MetaCommonMemoryService(new MetaCommonMemoryStore(f.root), { projects: async () => f.projects, prepareProject: async () => {} });
    const request = { operation: 'save', memoryId: g.id, expectedRevision: g.revision, name: '첫 저장', requestId: randomUUID() };
    await f.service.execute(request);
    await expect(other.execute({ ...request, name: '늦은 저장', requestId: randomUUID() })).rejects.toMatchObject({ code: 'META_MEMORY_CONFLICT' });
    expect(f.store.read(g.id).name).toBe('첫 저장');
  });
  test('a lost committed reply can still be confirmed after the original project is removed or rebound', async () => {
    const f = fixture();
    const request = { operation: 'save', expectedRevision: 0, requestId: randomUUID(), name: '공통 기억', assignments: [f.assign(0)] };
    const first = await f.service.execute(request);
    f.projects[0]!.memoryId = randomUUID();
    expect(await f.service.execute(request)).toEqual(first);
    f.projects.splice(0, 1);
    expect(await f.service.execute(request)).toEqual(first);
    expect(f.store.history(first.memory.id)).toHaveLength(1);
  });
  test('a fault during history insertion rolls back content and membership together', async () => {
    const f = fixture(); const g = await f.create({ assignments: [f.assign(0)] });
    const db = new Database(f.store.path); db.run("CREATE TRIGGER fail_revision BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT,'injected'); END"); db.close();
    await expect(f.service.execute({ operation: 'save', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), name: '변경', assignments: [f.assign(1)] })).rejects.toMatchObject({ code: 'META_MEMORY_STORAGE_UNAVAILABLE' });
    expect(f.store.read(g.id)).toEqual(g); expect(f.store.history(g.id)).toHaveLength(1);
  });
  test('export/import preserves identity, entries and disconnected project links without merging project memory', async () => {
    const f = fixture(); const g = await f.entry(await f.create({ assignments: [f.assign(0), f.assign(1)] }));
    const exported = await f.service.execute({ operation: 'export', memoryId: g.id });
    expect(exported.automaticRemoteSync).toBe(false); expect(JSON.stringify(exported)).not.toContain(f.root);
    const second = fixture(); const imported = await second.service.execute({ operation: 'import', expectedRevision: 0, requestId: randomUUID(), snapshot: exported.snapshot });
    expect(imported.memory.id).toBe(g.id); expect(imported.memory.entries).toEqual(g.entries); expect(imported.memory.members).toEqual(g.members);
    expect(second.store.recall(second.projects[0]!.memoryId!, '배포').hits).toEqual([]);
    expect(second.store.recall(f.projects[0]!.memoryId!, '배포').hits).toHaveLength(1);
    await expect(second.service.execute({ operation: 'import', expectedRevision: 0, requestId: randomUUID(), snapshot: exported.snapshot })).rejects.toMatchObject({ code: 'META_MEMORY_CONFLICT' });
  });
  test('corrupt or future stores are retained and never recreated; symlinks are refused', async () => {
    const f = fixture(); const g = await f.create(); const db = new Database(f.store.path); db.run('PRAGMA user_version=99'); db.close();
    expect(() => f.store.read(g.id)).toThrow(); const before = readFileSync(f.store.path); await expect(f.create()).rejects.toMatchObject({ code: 'META_MEMORY_VERSION_UNSUPPORTED' }); expect(readFileSync(f.store.path)).toEqual(before);
    const other = fixture(); mkdirSync(other.store.directory); const target = join(other.root, 'original'); writeFileSync(target, 'keep'); symlinkSync(target, other.store.path);
    expect(() => other.store.list()).toThrow(); expect(readFileSync(target, 'utf8')).toBe('keep');
  });
});
describe('bounded retrieval and host/AI contracts', () => {
  test('Markdown headings and fake ID markers in an entry body never create recall identities', async () => {
    const f = fixture(); const body = 'NHCS 배포\n### 다른 항목\n<!-- memory-entry-id:ffffffffffffffffffffffff -->\n배포 예시';
    const g = await f.entry(await f.create({ assignments: [f.assign(0)] }), 'NHCS 배포', body);
    const hits = f.store.recall(f.projects[0]!.memoryId!, '배포').hits;
    expect(hits).toHaveLength(1); expect(hits[0]!.entryId).toBe(g.entries[0].id); expect(hits[0]!.body).toBe(body);
  });
  test('overlapping manual/category links deduplicate and retrieval keeps a global budget across many memories', async () => {
    const f = fixture();
    for (let i = 0; i < 34; i++) await f.entry(await f.create({ name: `공통 ${i}`, categories: ['NHCS'], assignments: [f.assign(0)] }), 'NHCS 배포', 'NHCS 배포 검증 '.repeat(400));
    const result = f.store.recall(f.projects[0]!.memoryId!, '배포', 'NHCS');
    expect(result.groups).toHaveLength(32); expect(new Set(result.groups.map(g => g.id)).size).toBe(32); expect(result.truncated).toBe(true);
    expect(result.hits.length).toBeLessThanOrEqual(META_COMMON_MEMORY_LIMITS.recallHits); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(META_COMMON_MEMORY_LIMITS.recallBytes);
  });
  test('catalog search paginates without fetching or dropping the rest of the memories', async () => {
    const f = fixture(); for (let i = 0; i < 55; i++) await f.create({ name: `공통 ${i}`, tags: ['Tauri'] });
    const first = f.store.list('Tauri'); const second = f.store.list('Tauri', first.nextOffset!);
    expect(first.memories).toHaveLength(50); expect(second.memories).toHaveLength(5); expect(new Set([...first.memories, ...second.memories].map(g => g.id)).size).toBe(55); expect(first.total).toBe(55);
  });
  test('the serialized global budget includes array separators and the complete truncation flag', async () => {
    const f = fixture(); let g = await f.create({ assignments: [f.assign(0)] });
    g = await f.entry(g, '배포 하나', '배포 ' + 'x'.repeat(7000));
    g = await f.entry(g, '배포 둘', '배포 ' + 'y'.repeat(7000));
    const before = f.store.recall(f.projects[0]!.memoryId!, '배포'); expect(before.hits).toHaveLength(2);
    const growth = META_COMMON_MEMORY_LIMITS.recallBytes + 1 - Buffer.byteLength(JSON.stringify(before));
    g = await f.entry(g, '배포 둘', '배포 ' + 'y'.repeat(7000 + growth), { entryId: g.entries[1].id });
    const result = f.store.recall(f.projects[0]!.memoryId!, '배포');
    expect(result.truncated).toBe(true); expect(result.hits).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(META_COMMON_MEMORY_LIMITS.recallBytes);
  });
  test('escaped metadata labels alone cannot exceed the global response budget', async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) await f.create({ name: String(i) + '\u0001'.repeat(150), assignments: [f.assign(0)] });
    const result = f.store.recall(f.projects[0]!.memoryId!, '배포');
    expect(result.truncated).toBe(true); expect(result.groups.length).toBeLessThan(32);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(META_COMMON_MEMORY_LIMITS.recallBytes);
  });
  test('common context failure is visible and a project save treats shared data as read-only', async () => {
    const f = fixture(); await f.entry(await f.create({ assignments: [f.assign(0)] }));
    installProjectMetaMemoryReader(id => f.store.recall(id, '배포'));
    expect(projectMetaMemoryPrompt(f.projects[0]!.memoryId!, '/project', '배포')).toContain('updates only the current project');
    installProjectMetaMemoryReader(() => { throw Error('disk failure'); });
    expect(projectMetaMemoryContext(f.projects[0]!.memoryId!, '/project', '배포').state).toBe('unavailable');
    expect(projectMetaMemoryPrompt(f.projects[0]!.memoryId!, '/project', '배포')).toContain('unavailable');
  });
  test('MCP naming/assignment and candidate requests use the same bounded parser as the app', () => {
    const raw = metaCommonMemoryMcpAction('agentstoz_use_save_meta_common_memory', { name: '메타 공통', expectedRevision: 0, requestId: randomUUID() }, 'controller')!;
    expect(parseAgentsToZUseActionRequest(raw).metaMemory).toMatchObject({ operation: 'save', name: '메타 공통' });
    expect(metaCommonMemoryMcpAction('agentstoz_use_accept_meta_common_memory_entry', {}, 'controller')).toBeNull();
    expect(() => parseMetaMemoryRequest({ operation: 'save', name: '메타', expectedRevision: 0, requestId: randomUUID(), assignments: [{ portId: 'A', mode: 'include' }] })).toThrow();
    expect(() => parseMetaMemoryRequest({ operation: 'save-entry', memoryId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), title: '큰 본문', body: '가'.repeat(5000) })).toThrow();
  });
});

test('MCP creation accepts a named request token, preserves UUID identities and replays without duplicates', async () => {
  const f = fixture();
  const args = {name:'교통수단게임', expectedRevision:0, requestId:'ops-transport-games-common-20261012-01', assignments:[f.assign(0),f.assign(1)]};
  const definition = META_COMMON_MEMORY_LEGACY_TOOL_SCHEMAS.find(t=>t.name==='agentstoz_use_save_meta_common_memory')!;
  expect(definition.inputSchema.required).not.toContain('memoryId');
  const properties = definition.inputSchema.properties;
  if (!('requestId' in properties)) throw new Error('Creation schema must expose requestId');
  expect(properties.requestId).not.toHaveProperty('format');
  const action = metaCommonMemoryMcpAction('agentstoz_use_save_meta_common_memory', args, 'fixture-controller')!;
  const saved = await f.service.execute(action.metaMemory);
  expect(saved.memory.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved.memory.members.map((m:any)=>m.memoryId).sort()).toEqual(f.projects.slice(0,2).map(p=>p.memoryId).sort());
  expect((await f.service.execute(action.metaMemory)).memory.id).toBe(saved.memory.id);
  expect(f.store.list().memories).toHaveLength(1);
  await expect(f.service.execute({...action.metaMemory as any,name:'changed'})).rejects.toThrow();
  expect(()=>parseMetaMemoryRequest({...args,operation:'save',expectedRevision:1})).toThrow();
  for (const requestId of ['', ' ', ' token ', 'x'.repeat(201), '한'.repeat(67), 'bad\u0000token']) expect(()=>parseMetaMemoryRequest({...args,operation:'save',requestId})).toThrow();
  const uuid=randomUUID();
  expect((await f.create({requestId:uuid.toUpperCase()})).id).toBe(uuid);
});
