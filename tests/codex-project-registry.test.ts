import { expect, test } from 'bun:test';
import { reconcileCodexBackendProject, ensureCodexBackendProject, codexProjectIdempotencyKey } from '../src/codexProjectRegistry';
import type { SpawnCodexAppServer } from '../src/codexFirstConversation';

const folderPath = '/Users/test/Projects/이현이열차';
const codexHome = '/Users/test/.codex';
const project = (id = 'existing-project', path = folderPath) => ({ id, roots: [{ path }], name: '이현이열차' });

test('reuses an existing exact root on a later page, independent of name or Korean normalization', async () => {
  const calls: string[] = [];
  const result = await reconcileCodexBackendProject({ folderPath, codexHome, request: async (method, params) => {
    calls.push(method);
    if (method === 'project/list') return params.cursor === null
      ? { data: [project('same-name', '/other/이현이열차')], nextCursor: 'second' }
      : { data: [project('existing-project', folderPath.normalize('NFD'))], nextCursor: null };
    if (method === 'project/read') return { project: project() };
    throw new Error('Unexpected create');
  } });
  expect(result).toEqual({ backendRegistered: true, backendProjectId: 'existing-project', reused: true });
  expect(calls).toEqual(['project/list', 'project/list', 'project/read']);
});

test('creates only after complete absence and verifies the unchanged existing folder', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const result = await reconcileCodexBackendProject({ folderPath, codexHome, request: async (method, params) => {
    calls.push({ method, params });
    return method === 'project/list' ? { data: [], nextCursor: null } : { project: project('created') };
  } });
  expect(result).toMatchObject({ backendProjectId: 'created', reused: false });
  expect(calls.map(c => c.method)).toEqual(['project/list', 'project/create', 'project/read']);
  expect(calls[1]!.params).toEqual({ name: '이현이열차', roots: [{ path: folderPath }], idempotencyKey: codexProjectIdempotencyKey(codexHome, folderPath) });
});

test('an uncertain create retries with the same scoped key, not a second project identity', async () => {
  const keys: unknown[] = [];
  let attempt = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    if (method === 'project/list') return { data: [], nextCursor: null };
    if (method === 'project/create') {
      keys.push(params.idempotencyKey);
      if (++attempt === 1) throw new Error('lost receipt');
    }
    return { project: project('retained') };
  };
  await expect(reconcileCodexBackendProject({ folderPath, codexHome, request })).rejects.toThrow('lost receipt');
  expect(await reconcileCodexBackendProject({ folderPath, codexHome, request })).toMatchObject({ backendProjectId: 'retained' });
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toBe(codexProjectIdempotencyKey(codexHome, folderPath.normalize('NFD')));
  expect(keys[0]).not.toBe(codexProjectIdempotencyKey('/other/.codex', folderPath));
});

test('invalid, ambiguous, interrupted or cyclic inventories never authorize creation', async () => {
  for (const page of [
    { data: [project('a'), project('b')], nextCursor: null },
    { data: [{}], nextCursor: null },
    { data: [], nextCursor: 'loop' },
    { data: [], nextCursor: undefined },
  ]) {
    const calls: string[] = [];
    await expect(reconcileCodexBackendProject({ folderPath, codexHome, request: async method => { calls.push(method); return page; } })).rejects.toThrow();
    expect(calls).not.toContain('project/create');
  }
  await expect(reconcileCodexBackendProject({ folderPath, codexHome, request: async () => { throw new Error('unavailable'); } })).rejects.toThrow('unavailable');
});

test('changed readback roots and wrong create identities cannot become registration success', async () => {
  for (const mismatch of ['create', 'read'] as const) {
    await expect(reconcileCodexBackendProject({ folderPath, codexHome, request: async method => {
      if (method === 'project/list') return { data: [], nextCursor: null };
      return { project: project('created', method === `project/${mismatch}` ? '/wrong/folder' : folderPath) };
    } })).rejects.toThrow();
  }
});

test('official stdio project protocol initializes experimental capability, creates no chats and ends its owned process', async () => {
  const requests: Record<string, any>[] = [], commands: string[][] = [];
  let ended = false;
  const spawn: SpawnCodexAppServer = command => {
    commands.push(command);
    let output!: ReadableStreamDefaultController<Uint8Array>, errors!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { output = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { errors = c; } });
    const exited = new Promise<number>(r => { resolveExit = r; });
    const finish = () => { if (!ended) { ended = true; output.close(); errors.close(); resolveExit(0); } };
    return { stdout, stderr, exited, kill: finish, stdin: {
      write(chunk) {
        const request = JSON.parse(String(chunk)); requests.push(request);
        if (request.id === undefined) return;
        const result = request.method === 'initialize' ? { codexHome }
          : request.method === 'project/list' ? { data: [project()], nextCursor: null }
            : { project: project() };
        output.enqueue(new TextEncoder().encode(JSON.stringify({ id: request.id, result }) + '\n'));
      }, end: finish,
    } };
  };
  expect(await ensureCodexBackendProject({ codexPath: '/verified/codex', folderPath, spawn })).toMatchObject({ reused: true, backendProjectId: 'existing-project' });
  expect(commands).toEqual([['/verified/codex', 'app-server', '--listen', 'stdio://']]);
  expect(requests[0]!.params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
  expect(requests.map(r => r.method)).toEqual(['initialize', 'initialized', 'project/list', 'project/read']);
  expect(ended).toBe(true);
});
