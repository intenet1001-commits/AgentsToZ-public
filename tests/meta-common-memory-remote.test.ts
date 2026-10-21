import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaCommonMemoryStore } from '../src/metaCommonMemoryStore';
import { MetaCommonMemoryService } from '../src/metaCommonMemoryService';
import { MetaCommonMemoryRemoteHost, metaMemoryRemoteProjectRef } from '../src/metaCommonMemoryRemoteHost';
import { createMetaMemoryRemoteRequester } from '../src/metaCommonMemoryRemoteClient';
import { MetaMemoryClientError } from '../src/metaCommonMemoryClient';
import { META_MEMORY_REMOTE_LIMITS, META_MEMORY_REMOTE_TARGET, normalizeMetaMemoryRemoteRequest, splitMetaMemoryWireText } from '../src/metaCommonMemoryRemoteProtocol';
import { createMobileWorkspaceGateway } from '../src/mobileWorkspaceGateway';
import { normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, type MobileWorkspaceScope, type MobileWorkspaceRequest } from '../src/mobileWorkspaceProtocol';
import type { MetaMemoryProject } from '../src/metaCommonMemoryContract';
const hosts: MetaCommonMemoryRemoteHost[] = [], dirs: string[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.dispose(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'meta-memory-remote-')); dirs.push(root);
  const store = new MetaCommonMemoryStore(root); let live = true, scopes: MobileWorkspaceScope[] = ['meta-memory.manage'];
  const projects: MetaMemoryProject[] = [{ id: 'actual-private-registration-id', name: '스킬 A', category: 'NHCS', memoryId: randomUUID(), state: 'ready' }];
  let lost = false, resolves = 0;
  const host = new MetaCommonMemoryRemoteHost(async (owner, request, active) => {
    const service = new MetaCommonMemoryService(store, {
      assertActive: () => { if (!active()) throw Error('revoked'); },
      projects: async () => projects.map(p => ({ ...p, id: metaMemoryRemoteProjectRef(owner, p.id) })),
      prepareProject: async () => {},
    });
    return service.execute(request);
  }); hosts.push(host);
  const gateway = createMobileWorkspaceGateway({
    terminal: async () => { throw Error('terminal grant remains separate'); }, active: () => live,
    resolve: async () => { resolves++; return []; },
    consent: async () => ({ targetIds: new Set<string>(), workspaceScopes: scopes, isActive: () => live, requestOwner: 'device:host:phone' }),
    perform: async () => { throw Error('ordinary project dispatcher must not handle common memory'); },
    metaMemory: (r, owner, active) => host.perform(owner, r, active),
  });
  const request = createMetaMemoryRemoteRequester(async r => {
    normalizeMobileWorkspaceRequest(r);
    const result = await gateway(r, [], 'internet:phone') as any;
    normalizeMobileWorkspaceResult(result);
    if (lost && r.workspace.meta?.phase === 'execute') { lost = false; throw Error('response lost after commit'); }
    return result;
  });
  return { root, store, host, request, gateway, projects, lose: () => { lost = true; }, live: (v: boolean) => { live = v; }, scopes: (v: MobileWorkspaceScope[]) => { scopes = v; }, resolves: () => resolves };
}
const create = () => ({ operation: 'save', expectedRevision: 0, requestId: randomUUID(), name: '제품 공통', description: '', tags: [], categories: [], assignments: [] });
test('escaped Unicode chunks preserve the full input while every existing workspace envelope stays within 8500 bytes', () => {
  const text = '가🙂\\"\n\t'.repeat(5000), chunks = splitMetaMemoryWireText(text);
  expect(chunks.join('')).toBe(text); expect(chunks.length).toBeGreaterThan(1);
  for (let index = 0; index < chunks.length; index++) {
    const r: MobileWorkspaceRequest = { operation: 'workspace', requestId: randomUUID(), targetId: META_MEMORY_REMOTE_TARGET, workspace: { action: 'meta-memory', meta: { phase: 'upload', rpcId: randomUUID(), hash: digest(text), index, count: chunks.length, text: chunks[index]! } } };
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(8500); expect(normalizeMobileWorkspaceRequest(r)).toEqual(r);
  }
  expect(() => normalizeMetaMemoryRemoteRequest({ phase: 'execute', rpcId: randomUUID(), hash: digest(text), folderPath: '/private' })).toThrow();
  expect(() => normalizeMobileWorkspaceRequest({ operation: 'workspace', requestId: randomUUID(), targetId: 'project_wrong', workspace: { action: 'meta-memory', meta: { phase: 'release', rpcId: randomUUID(), hash: digest(text) } } })).toThrow();
});
test('legacy project/terminal permissions never grant host-wide common-memory access; it needs no original project', async () => {
  const f = fixture(); f.scopes(['records.read', 'memory.save']);
  await expect(f.request({ operation: 'list' })).rejects.toThrow('따로 허용'); expect(f.store.list('', 0).total).toBe(0);
  f.scopes(['meta-memory.manage']); const result = await f.request(create()); expect(result.memory.name).toBe('제품 공통'); expect(result.memory.members).toEqual([]);
  expect(f.resolves()).toBe(0); expect(f.host.size).toBe(0);
  await expect(f.gateway({ operation: 'list', requestId: randomUUID() }, [], 'internet:phone')).rejects.toThrow('terminal grant remains separate');
});
test('a phone can name, select projects, edit a long entry, review a candidate and preserve attribution through bounded frames', async () => {
  const f = fixture(); const inventory = await f.request({ operation: 'projects' });
  const project = inventory.projects[0]; expect(project.id).not.toBe(f.projects[0]!.id);
  expect(JSON.stringify(inventory)).not.toContain('actual-private-registration-id');
  let g = (await f.request({ ...create(), categories: ['NHCS'], assignments: [{ portId: project.id, expectedMemoryId: project.memoryId, mode: 'include' }] })).memory;
  const body = '전용 기억과 공통 기억을 구분한다.🙂\n'.repeat(200);
  expect(Buffer.byteLength(body)).toBeGreaterThan(8500); expect(Buffer.byteLength(body)).toBeLessThan(12000);
  g = (await f.request({ operation: 'save-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), title: '긴 연동 계약', body, portId: project.id })).memory;
  expect(g.entries[0].body).toBe(body.trim()); expect(g.entries[0].sourceMemoryId).toBe(project.memoryId);
  g = (await f.request({ operation: 'propose-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), title: '검토할 교훈', body: '근거 확인 후 적용' })).memory;
  expect(g.entries[1].state).toBe('candidate');
  g = (await f.request({ operation: 'review-entry', memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), entryId: g.entries[1].id, state: 'active' })).memory;
  expect(g.entries[1].state).toBe('active'); expect((await f.request({ operation: 'history', memoryId: g.id })).history.length).toBe(4);
});
test('lost mutation response is uncertain and retrying its exact durable request commits once, even after the selected project disappears', async () => {
  const f = fixture(), p = (await f.request({ operation: 'projects' })).projects[0];
  const payload = { ...create(), assignments: [{ portId: p.id, expectedMemoryId: p.memoryId, mode: 'include' }] };
  f.lose(); let error: unknown; try { await f.request(payload); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(MetaMemoryClientError); expect((error as MetaMemoryClientError).uncertain).toBe(true);
  expect(f.store.list('', 0).total).toBe(1); f.projects.splice(0);
  const result = await f.request(payload); expect(result.memory.revision).toBe(1); expect(f.store.history(result.memory.id)).toHaveLength(1);
  expect(f.host.size).toBe(0);
});
test('stale phone edits cannot overwrite a newer desktop revision and return a definite conflict', async () => {
  const f = fixture(), payload = create(), g = (await f.request(payload)).memory;
  f.store.mutate({ id: g.id, expectedRevision: 1, requestId: randomUUID(), operation: 'desktop-edit', request: {} }, v => ({ ...v, name: 'Mac 최신 이름' }));
  let error: unknown; try { await f.request({ ...payload, memoryId: g.id, expectedRevision: 1, requestId: randomUUID(), name: '폰 예전 입력' }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(MetaMemoryClientError); expect((error as MetaMemoryClientError).uncertain).toBe(false); expect(f.store.read(g.id).name).toBe('Mac 최신 이름');
});
test('revocation while project references are resolving is checked immediately before the SQLite transaction', async () => {
  const f = fixture(); let active = true;
  const p = f.projects[0]!; const service = new MetaCommonMemoryService(f.store, { projects: async () => { active = false; return [p]; }, prepareProject: async () => {}, assertActive: () => { if (!active) throw Error('revoked'); } });
  await expect(service.execute({ ...create(), assignments: [{ portId: p.id, expectedMemoryId: p.memoryId, mode: 'include' }] })).rejects.toThrow('revoked');
  expect(f.store.list('', 0).total).toBe(0);
});
test('owner-bound chunks reject missing, changed and foreign requests and expired buffers never delete memory', async () => {
  let now = 1000, calls = 0; const host = new MetaCommonMemoryRemoteHost(async () => { calls++; return { name: 'safe' }; }, () => now); hosts.push(host);
  const rpcId = randomUUID(), text = JSON.stringify({ operation: 'list' }), hash = digest(text);
  await host.perform('phone-a', { phase: 'upload', rpcId, hash, index: 0, count: 2, text }, () => true);
  await expect(host.perform('phone-a', { phase: 'execute', rpcId, hash }, () => true)).rejects.toThrow('누락');
  await expect(host.perform('phone-a', { phase: 'upload', rpcId, hash, index: 0, count: 2, text: 'changed' }, () => true)).rejects.toThrow();
  await expect(host.perform('phone-b', { phase: 'execute', rpcId, hash }, () => true)).rejects.toThrow('만료');
  now += META_MEMORY_REMOTE_LIMITS.ttlMs; expect(host.size).toBe(0); expect(calls).toBe(0);
});
test('unknown payload fields are rejected before execution, global transfer admission is bounded, and release permits progress', async () => {
  let calls = 0; const host = new MetaCommonMemoryRemoteHost(async () => { calls++; return {}; }); hosts.push(host);
  const text = JSON.stringify({ operation: 'projects', folderPath: '/secret/path' }), hash = digest(text), rpcId = randomUUID();
  await host.perform('a', { phase: 'upload', rpcId, hash, index: 0, count: 1, text }, () => true);
  await expect(host.perform('a', { phase: 'execute', rpcId, hash }, () => true)).rejects.toThrow('지원하지 않는'); expect(calls).toBe(0);
  await host.perform('a', { phase: 'release', rpcId, hash }, () => true);
  const ids: string[] = [];
  for (let i = 0; i < META_MEMORY_REMOTE_LIMITS.records; i++) { const id = randomUUID(); ids.push(id); await host.perform('owner-' + i, { phase: 'upload', rpcId: id, hash, index: 0, count: 1, text }, () => true); }
  await expect(host.perform('extra', { phase: 'upload', rpcId: randomUUID(), hash, index: 0, count: 1, text }, () => true)).rejects.toThrow('전송이 많습니다');
  await host.perform('owner-0', { phase: 'release', rpcId: ids[0]!, hash }, () => true); expect(host.size).toBe(META_MEMORY_REMOTE_LIMITS.records - 1);
});
test('common-memory permission is not forwarded through a community peer connection', async () => {
  const f = fixture();
  const r: MobileWorkspaceRequest = { operation: 'workspace', requestId: randomUUID(), targetId: META_MEMORY_REMOTE_TARGET, workspace: { action: 'meta-memory', meta: { phase: 'release', rpcId: randomUUID(), hash: digest('') } } };
  await expect(f.gateway(r, [], 'internet:phone', () => true, 'community-device')).rejects.toThrow('직접 연결');
  f.live(false); await expect(f.request({ operation: 'list' })).rejects.toThrow('다시 연결');
});
