import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserProfileHost, handleUserProfileRequest, USER_PROFILE_PATH, USER_PROFILE_HTTP_MAX_BYTES, USER_PROFILE_POLICY, userProfilePublicError, type UserProfileRegisteredProject } from '../src/userProfileHost';
import { UserProfileError, type UserProfileEntry } from '../src/userProfileContract';
import { USER_PROFILE_FILE, USER_PROFILE_EVIDENCE } from '../src/userProfileStore';
import { type PromptGuideKeyProvider } from '../src/promptGuideKeyProvider';
import { initializeProjectMemory } from '../project-memory-server';
import { readControlProfileAccess } from '../src/controlProfileStore';
import { CONTROL_PROFILE_HEADER, CONTROL_PROFILE_CONTROLLER } from '../src/controlProfileContract';
import { startTestApiServer } from './startTestApiServer';

const directories: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const origin = 'http://localhost:9000';
const memoryA = randomUUID(), memoryB = randomUUID();
const project = (memoryId = memoryA): UserProfileRegisteredProject => ({ projectId: 'project-a', memoryId, name: '사용자 프로젝트' });
const entry = (overrides: Partial<UserProfileEntry> = {}): UserProfileEntry => ({
  id: randomUUID(), title: '검증 선호', body: '완료 전에 검증 결과를 알려주세요.', scope: 'all-projects', projectMemoryId: null,
  state: 'active', updatedAt: '2026-10-25T01:02:03.000Z', origin: 'user-confirmed', ...overrides,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'user-profile-host-')); directories.push(root);
  const appDataDir = join(root, 'app-data');
  let rows = [project()], key: Buffer | null = null, reads = 0, creates = 0;
  let onRead: (() => void | Promise<void>) | undefined, onCreate: (() => void | Promise<void>) | undefined;
  const keyProvider: PromptGuideKeyProvider = {
    async read() { reads++; await onRead?.(); return key ? Buffer.from(key) : null; },
    async create() { creates++; await onCreate?.(); key ??= Buffer.alloc(32, 71); return Buffer.from(key); },
  };
  const host = new UserProfileHost({ appDataDir, keyProvider, registeredProjects: async () => rows });
  return { root, appDataDir, host, keyProvider,
    setRows(next: UserProfileRegisteredProject[]) { rows = next; },
    onRead(callback: typeof onRead) { onRead = callback; }, onCreate(callback: typeof onCreate) { onCreate = callback; },
    get reads() { return reads; }, get creates() { return creates; },
  };
}
function request(body: unknown, options: { method?: string; path?: string; origin?: string | null; headers?: Record<string, string>; raw?: BodyInit } = {}) {
  const method = options.method ?? 'POST';
  const headers = { 'Content-Type': 'application/json', ...(options.origin === null ? {} : { Origin: options.origin ?? origin }), ...options.headers };
  return new Request('http://127.0.0.1:3001' + (options.path ?? USER_PROFILE_PATH), {
    method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: options.raw ?? JSON.stringify(body) }),
  });
}
const authorize = (req: Request) => req.headers.get('origin') === origin || req.headers.get('origin') === 'tauri://localhost';
async function post(host: UserProfileHost, body: unknown, options: Parameters<typeof request>[1] = {}) {
  const response = await handleUserProfileRequest(request(body, options), host, { authorize });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}
const save = (entries: UserProfileEntry[], expectedRevision = '0') => ({ operation: 'save', confirmed: true, expectedRevision, entries });

describe('local user-profile HTTP and host boundary', () => {
  test('empty read and bounded projects are lazy, private, path-free and independent of credentials', async () => {
    const f = fixture();
    const read = await post(f.host, { operation: 'read' });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ success: true, storage: 'local', profile: { revision: '0', entries: [] }, policy: USER_PROFILE_POLICY });
    f.setRows([project(), { ...project(), projectId: 'same-memory-alias', name: '别名' }]);
    const projects = await post(f.host, { operation: 'projects' });
    expect(projects.body).toEqual({ success: true, storage: 'local', projects: [{ memoryId: memoryA, name: '사용자 프로젝트' }] });
    expect(JSON.stringify(projects.body)).not.toContain('project-a');
    expect(JSON.stringify(projects.body)).not.toContain(f.root);
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    expect(existsSync(f.appDataDir)).toBe(false); expect(f.reads).toBe(0); expect(f.creates).toBe(0);
  });

  test('only exact POST local management requests reach body/store handling', async () => {
    let calls = 0;
    const host = { async perform() { calls++; throw new Error('must not reach private data'); } };
    for (const [req, code, status] of [
      [request({ operation: 'read' }, { origin: null }), 'USER_PROFILE_ORIGIN_DENIED', 403],
      [request({ operation: 'read' }, { origin: 'https://portal.example' }), 'USER_PROFILE_ORIGIN_DENIED', 403],
      [request({}, { method: 'GET' }), 'USER_PROFILE_METHOD_NOT_ALLOWED', 405],
      [request({}, { path: USER_PROFILE_PATH + '/save' }), 'USER_PROFILE_NOT_FOUND', 404],
      [request({}, { path: USER_PROFILE_PATH + '?operation=read' }), 'USER_PROFILE_INVALID_INPUT', 400],
      [request({}, { path: USER_PROFILE_PATH + '?' }), 'USER_PROFILE_INVALID_INPUT', 400],
    ] as const) {
      const response = await handleUserProfileRequest(req, host, { authorize });
      expect(response.status).toBe(status); expect((await response.json() as any).code).toBe(code);
      if (status === 405) expect(response.headers.get('allow')).toBe('POST');
    }
    expect(calls).toBe(0);
  });

  test('save needs explicit confirmation and exact keys before credentials, directories or writes', async () => {
    const f = fixture(), row = entry();
    for (const input of [
      { operation: 'save', expectedRevision: '0', entries: [row] },
      { ...save([row]), confirmed: false }, { ...save([row]), confirmed: 'true' },
      { ...save([row]), controllerProfileId: randomUUID() },
      { ...save([row]), operation: 'review' }, { ...save([row]), entries: [{ ...row, origin: 'ai-inferred' }] },
      { operation: 'read', portId: 'project-a' }, { operation: 'projects', folderPath: '/private' },
    ]) expect((await post(f.host, input)).status).toBe(400);
    expect(existsSync(f.appDataDir)).toBe(false); expect(f.reads).toBe(0); expect(f.creates).toBe(0);
  });

  test('confirmed save encrypts exact data; revision conflict preserves the current profile and draft', async () => {
    const f = fixture(), row = entry();
    const saved = await post(f.host, save([row]), { origin: 'tauri://localhost' });
    expect(saved.status).toBe(200); expect(saved.body.profile.entries).toEqual([row]);
    expect(saved.body.profile.revision).not.toBe('0'); expect(f.creates).toBe(1);
    const ciphertext = readFileSync(join(f.appDataDir, USER_PROFILE_FILE), 'utf8');
    expect(ciphertext).not.toContain(row.body); expect(ciphertext).not.toContain(row.title);
    const rejected = await post(f.host, save([entry({ body: 'stale draft remains local' })]));
    expect(rejected.status).toBe(409); expect(rejected.body.code).toBe('USER_PROFILE_CONFLICT');
    expect((await post(f.host, { operation: 'read' })).body.profile).toEqual(saved.body.profile);
    expect(readFileSync(join(f.appDataDir, USER_PROFILE_FILE), 'utf8')).toBe(ciphertext);
  });

  test('unregistered active scopes are refused before credentials; an old scope can be deactivated, never reactivated', async () => {
    const f = fixture();
    const stale = entry({ scope: 'project', projectMemoryId: memoryB });
    const rejected = await post(f.host, save([stale]));
    expect(rejected.status).toBe(409); expect(rejected.body.code).toBe('USER_PROFILE_SCOPE_UNAVAILABLE');
    expect(f.creates).toBe(0); expect(f.reads).toBe(0); expect(existsSync(f.appDataDir)).toBe(false);
    const inactive = await post(f.host, save([{ ...stale, state: 'inactive' }]));
    expect(inactive.status).toBe(200);
    expect((await f.host.recallForProject('project-a')).entries).toEqual([]);
    expect((await post(f.host, save([stale], inactive.body.profile.revision))).status).toBe(409);
  });

  test('registration withdrawn during key preparation cannot cross the final commit guard', async () => {
    const f = fixture();
    f.onCreate(() => f.setRows([]));
    const rejected = await post(f.host, save([entry({ scope: 'project', projectMemoryId: memoryA })]));
    expect(rejected.status).toBe(409); expect(rejected.body.code).toBe('USER_PROFILE_SCOPE_UNAVAILABLE');
    expect(f.creates).toBe(1);
    expect(existsSync(join(f.appDataDir, USER_PROFILE_FILE))).toBe(false);
    expect(existsSync(join(f.appDataDir, USER_PROFILE_EVIDENCE))).toBe(false);
    expect(readdirSync(f.appDataDir).every(name => !name.includes('.enc') && !name.includes('.tmp-'))).toBe(true);
  });

  test('MCP-facing recall binds the exact current project, only active applicable entries and an 8000-byte whole-entry budget', async () => {
    const f = fixture();
    f.setRows([project(), { projectId: 'project-b', memoryId: memoryB, name: '다른 프로젝트' }]);
    const global = entry({ title: 'global 검증' }), scoped = entry({ title: 'scoped 검증', scope: 'project', projectMemoryId: memoryA });
    const foreign = entry({ title: 'foreign 검증', scope: 'project', projectMemoryId: memoryB });
    const inactive = entry({ title: 'inactive 검증', state: 'inactive' });
    expect((await post(f.host, save([global, scoped, foreign, inactive]))).status).toBe(200);
    const recalled = await f.host.recallForProject('project-a', '검증');
    expect(recalled.entries.map(row => row.id)).toEqual([global.id, scoped.id]);
    expect(JSON.stringify(recalled)).not.toContain('foreign'); expect(JSON.stringify(recalled)).not.toContain('inactive');
    await expect(f.host.recallForProject('unknown-project')).rejects.toMatchObject({ code: 'USER_PROFILE_SCOPE_UNAVAILABLE' });
    const large = Array.from({ length: 8 }, () => entry({ body: '가'.repeat(1_000) }));
    const revision = (await post(f.host, { operation: 'read' })).body.profile.revision;
    expect((await post(f.host, save(large, revision))).status).toBe(200);
    const bounded = await f.host.recallForProject('project-a');
    expect(bounded.entries.length).toBeGreaterThan(0); expect(bounded.entries.length).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(8_000); expect(bounded.truncated).toBe(true);
    expect(bounded.entries.every(row => row.body === '가'.repeat(1_000))).toBe(true);
  });

  test('project binding changed during an asynchronous key read cannot leak an old-scope recall', async () => {
    const f = fixture();
    expect((await post(f.host, save([entry({ scope: 'project', projectMemoryId: memoryA })]))).status).toBe(200);
    f.onRead(() => f.setRows([project(memoryB)]));
    await expect(f.host.recallForProject('project-a')).rejects.toMatchObject({ code: 'USER_PROFILE_SCOPE_UNAVAILABLE' });
  });

  test('production narrow admission resolves only the requested project twice and never enumerates the inventory', async () => {
    const f = fixture(), requested: string[] = [];
    const host = new UserProfileHost({ appDataDir: f.appDataDir, keyProvider: f.keyProvider,
      registeredProjects: async () => { throw new Error('full inventory must not be read'); },
      resolveProject: async id => { requested.push(id); return id === 'project-a' ? project() : null; } });
    expect((await host.recallForProject('project-a')).entries).toEqual([]);
    expect(requested).toEqual(['project-a', 'project-a']);
    const mismatched = new UserProfileHost({ appDataDir: f.appDataDir, keyProvider: f.keyProvider,
      registeredProjects: async () => [], resolveProject: async () => ({ ...project(), projectId: 'foreign-project' }) });
    await expect(mismatched.recallForProject('project-a')).rejects.toMatchObject({ code: 'USER_PROFILE_SCOPE_UNAVAILABLE' });
    expect(f.reads).toBe(0); expect(f.creates).toBe(0);
  });

  test('registry ambiguity and credential failures are sanitized without raw private values', async () => {
    const f = fixture(); f.setRows([project(), project()]);
    expect((await post(f.host, { operation: 'projects' })).body.code).toBe('USER_PROFILE_PROJECTS_UNAVAILABLE');
    const host = new UserProfileHost({ appDataDir: f.appDataDir, registeredProjects: async () => [],
      keyProvider: { read: async () => { throw new Error('/private/key/path secret-value'); }, create: async () => { throw new Error('secret-value'); } } });
    const failed = await post(host, save([entry()]));
    expect(failed.status).toBe(503); expect(failed.body.code).toBe('USER_PROFILE_UNAVAILABLE');
    expect(JSON.stringify(failed.body)).not.toContain('secret-value'); expect(JSON.stringify(failed.body)).not.toContain('/private/key/path');
    expect(userProfilePublicError(new Error('private'))).toMatchObject({ code: 'USER_PROFILE_UNAVAILABLE', status: 503 });
    expect(userProfilePublicError(new UserProfileError('USER_PROFILE_RESULT_UNCERTAIN'))).toMatchObject({ code: 'USER_PROFILE_RESULT_UNCERTAIN', status: 503 });
  });

  test('stream/declared byte ceilings, malformed UTF-8, encoding and body length fail before host effects', async () => {
    let calls = 0;
    const host = { async perform() { calls++; return { storage: 'local' as const, projects: [] }; } };
    const cases: Array<[Request, number, string]> = [
      [request({}, { headers: { 'Content-Length': String(USER_PROFILE_HTTP_MAX_BYTES + 1) } }), 413, 'USER_PROFILE_BODY_TOO_LARGE'],
      [request({}, { raw: new Uint8Array(USER_PROFILE_HTTP_MAX_BYTES + 1) }), 413, 'USER_PROFILE_BODY_TOO_LARGE'],
      [request({}, { raw: new Uint8Array([0xff]) }), 400, 'USER_PROFILE_INVALID_INPUT'],
      [request({}, { headers: { 'Content-Encoding': 'gzip' } }), 415, 'USER_PROFILE_JSON_REQUIRED'],
      [request({}, { headers: { 'Content-Type': 'text/plain' } }), 415, 'USER_PROFILE_JSON_REQUIRED'],
      [request({}, { headers: { 'Content-Length': '4' } }), 400, 'USER_PROFILE_INVALID_INPUT'],
      [request({}, { raw: '{' }), 400, 'USER_PROFILE_INVALID_INPUT'],
    ];
    for (const [req, status, code] of cases) {
      const response = await handleUserProfileRequest(req, host, { authorize });
      expect(response.status).toBe(status); expect((await response.json() as any).code).toBe(code);
      if (status === 413) expect(response.headers.get('connection')).toBe('close');
    }
    expect(calls).toBe(0);
    const controller = new AbortController();
    const stalled = new Request('http://127.0.0.1:3001' + USER_PROFILE_PATH, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, signal: controller.signal,
      body: new ReadableStream({ start() {} }), duplex: 'half',
    } as RequestInit);
    const pending = handleUserProfileRequest(stalled, host, { authorize }); controller.abort();
    expect((await pending).status).toBe(400); expect(calls).toBe(0);
    expect((await handleUserProfileRequest(request({ operation: 'projects' }), host, { authorize })).status).toBe(200);
    expect(calls).toBe(1);
  });
});

test('real isolated API keeps local management and authenticated MCP read separate, exposes only initialized non-OPS projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'user-profile-api-')); directories.push(root);
  const data = join(root, 'app-data'); mkdirSync(data);
  const env = { ...process.env, HOME: root, APP_DATA_DIR: data, NODE_ENV: 'test', PORT: '9000',
    PORTMGR_WHAT_I_SAID_TEST_KEY: '31'.repeat(32), AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1' };
  const { baseUrl, child } = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env }); children.push(child);
  const call = async (path: string, body: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  expect((await call(USER_PROFILE_PATH, { operation: 'read' })).status).toBe(403);
  expect((await call(USER_PROFILE_PATH, { operation: 'read' }, { Origin: 'https://hostile.example' })).status).toBe(403);
  const empty = await call(USER_PROFILE_PATH, { operation: 'read' }, { Origin: origin });
  expect(empty.status).toBe(200); expect(empty.body.profile).toEqual({ revision: '0', entries: [] });
  const initialized = (name: string) => {
    const path = join(root, name); mkdirSync(path);
    const memory = initializeProjectMemory({ folderPath: path, projectName: name, autoBackup: false });
    return { path, memoryId: memory.config!.memoryId };
  };
  const managed = initialized('managed'), dev = initialized('AgentsToZ_byCS'), ops = initialized('AgentsToZ-OPS');
  const opsClone = initialized('separate-ops-clone');
  const cloneConfigPath = join(opsClone.path, '.agent-memory/config.json');
  const cloneConfig = JSON.parse(readFileSync(cloneConfigPath, 'utf8'));
  cloneConfig.memoryId = ops.memoryId;
  writeFileSync(cloneConfigPath, JSON.stringify(cloneConfig));
  const uninitialized = join(root, 'uninitialized'); mkdirSync(uninitialized);
  writeFileSync(join(data, 'ports.json'), JSON.stringify([
    { id: 'managed', name: 'Managed project', folderPath: managed.path },
    { id: 'dev', name: 'DEV project', folderPath: dev.path, role: 'dev' },
    { id: 'ops', name: 'AgentsToZ OPS', folderPath: ops.path, role: 'ops' },
    { id: 'ops-alias', name: 'Misleading managed alias', folderPath: ops.path, role: 'managed' },
    { id: 'ops-clone', name: 'Separate checkout with OPS memory identity', folderPath: opsClone.path, role: 'managed' },
    { id: 'uninitialized', name: 'Uninitialized', folderPath: uninitialized },
  ]));
  const projects = await call(USER_PROFILE_PATH, { operation: 'projects' }, { Origin: 'tauri://localhost' });
  expect(projects.status).toBe(200);
  expect(new Set(projects.body.projects.map((row: any) => row.memoryId))).toEqual(new Set([managed.memoryId, dev.memoryId]));
  expect(projects.body.projects.every((row: any) => Object.keys(row).sort().join(',') === 'memoryId,name')).toBe(true);
  expect(JSON.stringify(projects.body)).not.toContain(root); expect(JSON.stringify(projects.body)).not.toContain(ops.memoryId);
  expect((await call(USER_PROFILE_PATH + '?', { operation: 'read' }, { Origin: origin })).status).toBe(400);
  const refused = await call(USER_PROFILE_PATH, { ...save([entry()]), confirmed: false }, { Origin: origin });
  expect(refused.status).toBe(400); expect(refused.body.code).toBe('USER_PROFILE_CONFIRMATION_REQUIRED');
  const action = { action: 'recall-user-profile', controllerPortId: CONTROL_PROFILE_CONTROLLER, portId: 'managed', query: '검증' };
  const { query: _query, ...withoutQuery } = action;
  const malformedRecall = await call('/api/agentstoz-use/action', withoutQuery);
  expect(malformedRecall.status).toBe(400); expect(malformedRecall.body.code).toBe('USER_PROFILE_INVALID_INPUT');
  expect(JSON.stringify(malformedRecall.body)).not.toContain(root);
  expect(malformedRecall.body).not.toHaveProperty('userProfile');
  expect((await call('/api/agentstoz-use/action', action)).status).toBe(403);
  expect((await call('/api/control-profile/prepare', {})).status).toBe(200);
  const token = readControlProfileAccess(data)!.token;
  const recalled = await call('/api/agentstoz-use/action', action, { [CONTROL_PROFILE_HEADER]: token });
  expect(recalled.status).toBe(200);
  expect(recalled.body).toMatchObject({ success: true, performed: true, action: 'recall-user-profile', effect: 'read-only', userProfile: { revision: '0', entries: [], truncated: false }, userProfilePolicy: USER_PROFILE_POLICY });
  expect((await call('/api/agentstoz-use/action', { ...action, portId: 'ops' }, { [CONTROL_PROFILE_HEADER]: token })).status).toBe(409);
  expect((await call('/api/agentstoz-use/action', { ...action, portId: 'ops-alias' }, { [CONTROL_PROFILE_HEADER]: token })).status).toBe(409);
  expect((await call('/api/agentstoz-use/action', { ...action, portId: 'ops-clone' }, { [CONTROL_PROFILE_HEADER]: token })).status).toBe(409);
  expect((await call('/api/agentstoz-use/action', { ...action, portId: 'uninitialized' }, { [CONTROL_PROFILE_HEADER]: token })).status).toBe(409);
  expect((await call('/api/agentstoz-use/action', action, { [CONTROL_PROFILE_HEADER]: 'bad-token' })).status).toBe(403);
  expect(existsSync(join(data, USER_PROFILE_FILE))).toBe(false);
  expect(existsSync(join(data, USER_PROFILE_EVIDENCE))).toBe(false);
  // Confirmed encryption/write uses the injected fake-key host tests above. This
  // production-route subprocess deliberately never requests any OS credential.
}, 20_000);
