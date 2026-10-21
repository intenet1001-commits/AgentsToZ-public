import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestApiServer } from './startTestApiServer';
import { handleAgentsToZUseMcpRequest } from '../agentstoz-use-mcp-server';
import { readControlProfileAccess } from '../src/controlProfileStore';
import { CONTROL_PROFILE_HEADER, CONTROL_PROFILE_CONTROLLER } from '../src/controlProfileContract';
const dirs: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => { for (const child of children.splice(0)) { child.kill(); await child.exited; } for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'meta-memory-api-')); dirs.push(home);
  const data = join(home, 'app-data'); mkdirSync(data);
  const a = join(home, 'A'), b = join(home, 'B'); mkdirSync(a); mkdirSync(b);
  for (const root of [a, b]) expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
  // Real restored devices retain old sync provenance on their own registrations.
  // It must never hide a locally registered, resolvable project from shared memory.
  const sourceDeviceId = '00000000-0000-4000-8000-000000000000';
  writeFileSync(join(data, 'ports.json'), JSON.stringify([{ id: 'A', name: 'A', folderPath: a, category: 'NHCS', sourceDeviceId }, { id: 'B', name: 'B', folderPath: b, category: 'NHCS', sourceDeviceId }]));
  const env = { ...process.env, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1' };
  const { child, baseUrl } = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env }); children.push(child);
  const post = async (path: string, body: unknown, headers = {}) => {
    const response = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const action = (body: unknown) => post('/api/meta-common-memory', body);
  return { home, data, a, b, env, baseUrl, child, post, action };
}
test('real API prepares project identity, joins independent common memory, and recalls it without rewriting either project', async () => {
  const f = await fixture();
  expect((await f.action({ operation: 'list' })).body.memories).toEqual([]);
  const unprepared = (await f.action({ operation: 'projects' })).body.projects;
  expect(unprepared.every((p: any) => p.state === 'uninitialized')).toBe(true);
  for (const portId of ['A', 'B']) expect((await f.action({ operation: 'prepare-project', portId })).status).toBe(200);
  const projects = (await f.action({ operation: 'projects' })).body.projects;
  const beforeA = readFileSync(join(f.a, '.agent-memory', 'CORE.md'), 'utf8');
  const beforeB = readFileSync(join(f.b, '.agent-memory', 'CORE.md'), 'utf8');
  const assignments = projects.map((p: any) => ({ portId: p.id, expectedMemoryId: p.memoryId, mode: 'include' }));
  const created = await f.action({ operation: 'save', expectedRevision: 0, requestId: randomUUID(), name: 'NHCS 제품 공통', tags: ['NHCS'], assignments });
  expect(created.status).toBe(200); let memory = created.body.memory;
  expect(memory.id).not.toBe(projects[0].memoryId); expect(memory.id).not.toBe(projects[1].memoryId);
  const saved = await f.action({ operation: 'save-entry', memoryId: memory.id, expectedRevision: memory.revision, requestId: randomUUID(), title: '연동 계약', body: '스킬과 앱의 연동 계약은 실제 양쪽 결과로 확인한다.' });
  expect(saved.status).toBe(200); memory = saved.body.memory;
  for (const root of [f.a, f.b]) {
    const recall = await f.post('/api/project-memory/recall', { folderPath: root, query: '연동 계약' });
    expect(recall.status).toBe(200); expect(recall.body.commonMemory.state).toBe('ready'); expect(recall.body.commonMemory.hits[0].memoryId).toBe(memory.id);
  }
  expect(readFileSync(join(f.a, '.agent-memory', 'CORE.md'), 'utf8')).toBe(beforeA);
  expect(readFileSync(join(f.b, '.agent-memory', 'CORE.md'), 'utf8')).toBe(beforeB);
  const prepareAgain = await f.action({ operation: 'prepare-project', portId: 'A' }); expect(prepareAgain.status).toBe(200);
  expect(JSON.parse(readFileSync(join(f.a, '.agent-memory', 'config.json'), 'utf8')).memoryId).toBe(projects[0].memoryId);
  const external = await f.post('/api/meta-common-memory', { operation: 'read', memoryId: memory.id }, { Origin: 'https://untrusted.example' }); expect(external.status).toBe(403);
}, 30_000);
test('real MCP can name/link and propose, but cannot accept its own candidate or use another profile token', async () => {
  const f = await fixture();
  await f.post('/api/control-profile/prepare', {});
  const call = async (name: string, args = {}) => await handleAgentsToZUseMcpRequest({ id: 1, method: 'tools/call', params: { name, arguments: args } }, { ...f.env, AGENTSTOZ_USE_ENDPOINT: f.baseUrl + '/api/agentstoz-use/action' }) as any;
  const created = await call('agentstoz_use_save_meta_common_memory', { name: '출처 없는 메타 공통', expectedRevision: 0, requestId: randomUUID(), tags: ['Tauri'] });
  expect(created.result.isError).toBe(false); const g = created.result.structuredContent.memory;
  const candidate = await call('agentstoz_use_propose_meta_common_memory_entry', { memoryId: g.id, expectedRevision: g.revision, requestId: randomUUID(), title: '배포 검증', body: '공통 배포 검증 교훈의 근거를 확인한다.' });
  expect(candidate.result.isError).toBe(false); expect(candidate.result.structuredContent.saved).toBe(false);
  const entry = candidate.result.structuredContent.memory.entries[0];
  const forbidden = await f.post('/api/agentstoz-use/action', { action: 'meta-common-memory', controllerPortId: CONTROL_PROFILE_CONTROLLER, metaMemory: { operation: 'review-entry', memoryId: g.id, expectedRevision: 2, requestId: randomUUID(), entryId: entry.id, state: 'active' } }, { [CONTROL_PROFILE_HEADER]: readControlProfileAccess(f.data)!.token });
  expect(forbidden.status).toBe(403); expect(forbidden.body.code).toBe('META_MEMORY_APP_ACTION_REQUIRED');
  const read = await call('agentstoz_use_read_meta_common_memory', { memoryId: g.id }); expect(read.result.structuredContent.memory.entries[0].state).toBe('candidate');
  expect(JSON.stringify(read)).not.toContain(f.home); expect(JSON.stringify(read)).not.toContain(readControlProfileAccess(f.data)!.token);
  const unauthorized = await f.post('/api/agentstoz-use/action', { action: 'meta-common-memory', controllerPortId: CONTROL_PROFILE_CONTROLLER, metaMemory: { operation: 'list' } }, { [CONTROL_PROFILE_HEADER]: '0'.repeat(64) }); expect(unauthorized.status).toBe(403);
  // 1.39.0: the meta tools left tools/list, but an older MCP binary's 'meta-common-memory' recall still works on this host,
  // and recall by a registered portId resolves the project's long-term memory here (no cloud: the local fallback answers).
  expect((await f.action({ operation: 'prepare-project', portId: 'A' })).status).toBe(200);
  const legacyRecall = await call('agentstoz_use_recall_meta_common_memory', { portId: 'A', query: '배포 검증' }); expect(legacyRecall.result.isError).toBe(false);
  const byProject = await call('agentstoz_use_recall_common_memory', { portId: 'A', query: '배포 검증' }); expect(byProject.result.isError).toBe(false);
  expect(byProject.result.structuredContent).toMatchObject({ mode: 'memory', memoryId: JSON.parse(readFileSync(join(f.a, '.agent-memory', 'config.json'), 'utf8')).memoryId });
  const token = readControlProfileAccess(f.data)!.token;
  const aiReview = await f.post('/api/agentstoz-use/action', { action: 'common-memory', controllerPortId: CONTROL_PROFILE_CONTROLLER, commonMemory: { op: 'knowledge', request: { operation: 'review-entry', memoryId: g.id, expectedRevision: 2, requestId: randomUUID(), entryId: entry.id, state: 'active' } } }, { [CONTROL_PROFILE_HEADER]: token });
  expect(aiReview.status).toBe(403); expect(aiReview.body.code).toBe('COMMON_MEMORY_PERMISSION_REQUIRED');
}, 30_000);
