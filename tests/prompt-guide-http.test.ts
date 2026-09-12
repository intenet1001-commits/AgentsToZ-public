import { afterEach, describe, expect, test } from 'bun:test';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePromptGuideRequest, PROMPT_GUIDES_HTTP_MAX_BYTES } from '../src/promptGuideHttp';
import { PromptGuideStore, PromptGuideError, PROMPT_GUIDES_FILE, type PromptGuideEntry } from '../src/promptGuideStore';
import { __setPromptGuideDurabilityFaultForTests } from '../src/promptGuideKeyProvider';

const roots: string[] = [];
const servers: Array<{ stop(close: boolean): void }> = [];
const CAPABILITY = 'a'.repeat(64);
const ORIGIN = 'http://tauri.localhost';
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
// Execute the existing production capability comparison without starting the API's
// unrelated background services, reading a real Keychain, or loading a real .env.
const authStart = apiSource.indexOf('function isWhatISaidManagementOrigin(');
const authEnd = apiSource.indexOf('function isRemoteControlManagementOrigin(', authStart);
if (authStart < 0 || authEnd < authStart) throw Error('production What I Said capability boundary not found');
const authJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(apiSource.slice(authStart, authEnd));
const authorized = new Function('WHAT_I_SAID_MANAGEMENT_ORIGINS', 'IS_BUNDLED_API_SIDECAR', 'WHAT_I_SAID_MANAGEMENT_CAPABILITY', 'Buffer', 'timingSafeEqual',
  authJs + '\nreturn isWhatISaidManagementRequest;')(
  new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']), true, CAPABILITY, Buffer, timingSafeEqual,
) as (req: Request, origin: string | null) => boolean;

afterEach(() => {
  __setPromptGuideDurabilityFaultForTests(null);
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const entry = (id = 'guide', body = '격리된 개인 프롬프트 fixture 입니다.'): PromptGuideEntry => ({
  id, title: '가이드 fixture', body, pinned: true, updatedAt: '2026-09-09T01:02:03.000Z',
});
function setup(options: { keyFailure?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-prompt-guide-http-')); roots.push(root);
  const appDataDir = join(root, 'app-data');
  let key: Buffer | null = null; let keyReads = 0, keyCreates = 0;
  const store = new PromptGuideStore({ appDataDir, keyProvider: {
    async read() { keyReads++; if (options.keyFailure) throw Error('synthetic private OS details'); return key ? Buffer.from(key) : null; },
    async create() { keyCreates++; key ??= Buffer.alloc(32, 39); return Buffer.from(key); },
  } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: PROMPT_GUIDES_HTTP_MAX_BYTES + 64 * 1024,
    fetch(req) {
      if (!authorized(req, req.headers.get('origin'))) return Response.json({ success: false, code: 'WHAT_I_SAID_MANAGEMENT_ORIGIN_DENIED', error: '허용되지 않은 관리 요청입니다.' }, { status: 403 });
      return handlePromptGuideRequest(req, store, { Vary: 'Origin' });
    },
  });
  servers.push(server);
  return { store, appDataDir, base: `http://127.0.0.1:${server.port}`, get keyReads() { return keyReads; }, get keyCreates() { return keyCreates; } };
}
async function request(f: { base: string }, path: string, input: unknown = {}, options: { method?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const method = options.method ?? 'POST';
  const response = await fetch(f.base + path, { method, headers: {
    Origin: ORIGIN, 'Content-Type': 'application/json', 'X-AgentsToZ-What-I-Said-Capability': CAPABILITY, ...options.headers,
  }, ...(!['GET', 'HEAD'].includes(method) ? { body: options.raw ?? JSON.stringify(input) } : {}) });
  return { response, body: await response.json() as any };
}

describe('prompt guide protected HTTP boundary', () => {
  test('API wires one app-data store after the existing capability gate', () => {
    expect(apiSource.match(/const promptGuideStore = new PromptGuideStore\(/g)).toHaveLength(1);
    expect(apiSource).toContain('new PromptGuideStore({ appDataDir: APP_DATA_DIR })');
    const guard = apiSource.indexOf("if (url.pathname.startsWith('/api/what-i-said/')");
    const dispatch = apiSource.indexOf('return handlePromptGuideRequest(req, promptGuideStore, headers);');
    expect(guard).toBeGreaterThan(-1); expect(dispatch).toBeGreaterThan(guard);
  });

  test('missing/wrong capability, feed/remote credentials and non-app origins cannot read or initialize', async () => {
    const f = setup();
    for (const headers of [
      { 'X-AgentsToZ-What-I-Said-Capability': '' },
      { 'X-AgentsToZ-What-I-Said-Capability': 'b'.repeat(64) },
      { 'X-AgentsToZ-What-I-Said-Capability': '', 'X-AgentsToZ-Remote-Control-Capability': CAPABILITY, Authorization: 'AgentsToZ-HMAC fixture' },
      { Origin: '' }, { Origin: 'https://example.test' }, { Origin: 'http://localhost:9000' },
    ] as Record<string, string>[]) {
      const result = await request(f, '/api/what-i-said/guides/list', {}, { headers });
      expect(result.response.status).toBe(403); expect(result.body.success).toBe(false);
    }
    expect(f.keyReads).toBe(0); expect(f.keyCreates).toBe(0); expect(existsSync(f.appDataDir)).toBe(false);
    const result = await request(f, '/api/what-i-said/guides/list');
    expect(result.body).toEqual({ success: true, revision: '0', entries: [] });
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    expect(f.keyReads).toBe(0); expect(existsSync(f.appDataDir)).toBe(false);
  });

  test('exact methods, paths, queries, JSON object shapes and encodings reject before credentials', async () => {
    const f = setup();
    for (const [path, method, status] of [
      ['/api/what-i-said/guides/list', 'GET', 405], ['/api/what-i-said/guides/save', 'DELETE', 405],
      ['/api/what-i-said/guides/list?limit=1', 'POST', 400], ['/api/what-i-said/guides/save/', 'POST', 404],
      ['/api/what-i-said/guides/unknown', 'POST', 404],
    ] as const) {
      const result = await request(f, path, {}, { method }); expect(result.response.status).toBe(status);
      if (status === 405) expect(result.response.headers.get('allow')).toBe('POST');
    }
    for (const input of [null, [], { limit: 1 }, { entries: [] }]) {
      expect((await request(f, '/api/what-i-said/guides/list', input)).response.status).toBe(400);
    }
    for (const input of [{}, { expectedRevision: '0' }, { expectedRevision: '0', entries: [], extra: true },
      { expectedRevision: '0', entries: [entry(), entry()] }, { expectedRevision: '0', entries: [entry('large', 'x'.repeat(16_385))] }]) {
      expect((await request(f, '/api/what-i-said/guides/save', input)).response.status).toBe(400);
    }
    expect((await request(f, '/api/what-i-said/guides/list', {}, { raw: '{broken private fixture' })).body.code).toBe('PROMPT_GUIDES_INVALID_INPUT');
    expect((await request(f, '/api/what-i-said/guides/list', {}, { headers: { 'Content-Type': 'text/plain' } })).response.status).toBe(415);
    expect((await request(f, '/api/what-i-said/guides/list', {}, { headers: { 'Content-Encoding': 'gzip' } })).response.status).toBe(415);
    expect(f.keyReads).toBe(0); expect(f.keyCreates).toBe(0); expect(existsSync(f.appDataDir)).toBe(false);
  });

  test('real encrypted save/list, competing HTTP CAS and explicit deletion preserve one authority', async () => {
    const f = setup();
    const first = await request(f, '/api/what-i-said/guides/save', { expectedRevision: '0', entries: [entry()] });
    expect(first.response.status).toBe(200); expect(first.body.success).toBe(true); expect(f.keyCreates).toBe(1);
    const loaded = await request(f, '/api/what-i-said/guides/list'); expect(loaded.body).toEqual(first.body);
    const contenders = await Promise.all(['left', 'right'].map(id => request(f, '/api/what-i-said/guides/save', { expectedRevision: first.body.revision, entries: [entry(id)] })));
    expect(contenders.map(item => item.response.status).sort()).toEqual([200, 409]);
    const winner = contenders.find(item => item.response.status === 200)!;
    const current = await request(f, '/api/what-i-said/guides/list'); expect(current.body).toEqual(winner.body);
    const ciphertext = readFileSync(join(f.appDataDir, PROMPT_GUIDES_FILE), 'utf8');
    expect(ciphertext).not.toContain(entry().body); expect(ciphertext).not.toContain(entry().title);
    const removed = await request(f, '/api/what-i-said/guides/save', { expectedRevision: current.body.revision, entries: [] });
    expect(removed.response.status).toBe(200); expect(removed.body.entries).toEqual([]); expect(removed.body.revision).not.toBe('0');
    expect((await request(f, '/api/what-i-said/guides/list')).body).toEqual(removed.body);
  });

  test('accepts an exact 1 MiB complete payload and rejects one extra byte without changing the revision', async () => {
    const f = setup();
    const entries = Array.from({ length: 64 }, (_, i) => entry(`guide-${i}`, 'x'.repeat(16_384)));
    const payload = { expectedRevision: '0', entries };
    const excess = Buffer.byteLength(JSON.stringify(payload)) - PROMPT_GUIDES_HTTP_MAX_BYTES;
    expect(excess).toBeGreaterThan(0); expect(excess).toBeLessThan(16_384);
    entries[63]!.body = entries[63]!.body.slice(excess);
    const raw = JSON.stringify(payload); expect(Buffer.byteLength(raw)).toBe(PROMPT_GUIDES_HTTP_MAX_BYTES);
    const saved = await request(f, '/api/what-i-said/guides/save', null, { raw });
    expect(saved.response.status).toBe(200); expect(saved.body.entries).toHaveLength(64);
    const denied = await request(f, '/api/what-i-said/guides/save', null, { raw: raw + ' ' });
    expect(denied.response.status).toBe(413); expect(denied.body.code).toBe('PROMPT_GUIDES_BODY_TOO_LARGE');
    expect(denied.response.headers.get('connection')).toBe('close');
    expect((await request(f, '/api/what-i-said/guides/list')).body.revision).toBe(saved.body.revision);
    // Repeated early rejection must never poison the pool used by a later read.
    for (let attempt = 0; attempt < 8; attempt++) {
      expect((await request(f, '/api/what-i-said/guides/save', null, { raw: raw + ' ' })).response.status).toBe(413);
      expect((await request(f, '/api/what-i-said/guides/list')).body.revision).toBe(saved.body.revision);
    }
  });

  test('unknown OS exceptions and unknown error codes return fixed Korean messages without details', async () => {
    const f = setup({ keyFailure: true });
    const result = await request(f, '/api/what-i-said/guides/save', { expectedRevision: '0', entries: [entry()] });
    expect(result.response.status).toBe(503); expect(result.body.code).toBe('PROMPT_GUIDES_UNAVAILABLE');
    expect(JSON.stringify(result.body)).not.toContain('synthetic private OS details'); expect(result.body.error).toMatch(/[가-힣]/);
    const response = await handlePromptGuideRequest(new Request('http://fixture/api/what-i-said/guides/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), {
      async read() { throw new PromptGuideError('private-new-code'); }, async save() { throw Error('not reached'); },
    });
    expect(await response.json()).toMatchObject({ success: false, code: 'PROMPT_GUIDES_UNAVAILABLE' });
  });

  test.skipIf(process.platform === 'win32')('uncertain committed rename is reported honestly through HTTP and can be read back', async () => {
    const f = setup(); const first = await request(f, '/api/what-i-said/guides/save', { expectedRevision: '0', entries: [entry()] });
    __setPromptGuideDurabilityFaultForTests(phase => {
      if (phase === 'directory' && JSON.parse(readFileSync(join(f.appDataDir, PROMPT_GUIDES_FILE), 'utf8')).revision !== first.body.revision) throw Error('private fsync fixture');
    });
    const result = await request(f, '/api/what-i-said/guides/save', { expectedRevision: first.body.revision, entries: [entry('new-visible')] });
    expect(result.response.status).toBe(503); expect(result.body.code).toBe('PROMPT_GUIDES_RESULT_UNCERTAIN');
    expect(result.body.error).not.toContain('저장하지'); expect(result.body.error).not.toContain('private');
    const current = await request(f, '/api/what-i-said/guides/list');
    expect(current.response.status).toBe(200); expect(current.body.entries[0].id).toBe('new-visible');
  });

  test('chunked, invalid UTF-8, declared length and aborted bodies cannot reach the store', async () => {
    let calls = 0;
    const store = { async read() { calls++; return { revision: '0', entries: [] }; }, async save() { calls++; return { revision: '0', entries: [] }; } };
    const streamed = (bytes: Uint8Array, headers: Record<string, string> = {}) => new Request('http://fixture/api/what-i-said/guides/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    });
    const tooBig = await handlePromptGuideRequest(streamed(new Uint8Array(PROMPT_GUIDES_HTTP_MAX_BYTES + 1)), store);
    expect(tooBig.status).toBe(413);
    let earlyCancelled = false;
    const declaredTooBig = new Request('http://fixture/api/what-i-said/guides/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(PROMPT_GUIDES_HTTP_MAX_BYTES + 1) },
      body: new ReadableStream({ cancel() { earlyCancelled = true; return new Promise<void>(() => {}); } }),
    });
    // Stop a rejected upload before pooling, without waiting for cancellation to settle.
    expect((await handlePromptGuideRequest(declaredTooBig, store)).status).toBe(413);
    expect(earlyCancelled).toBe(true);
    expect((await handlePromptGuideRequest(streamed(new Uint8Array([0xff])), store)).status).toBe(400);
    expect((await handlePromptGuideRequest(streamed(new TextEncoder().encode('{}'), { 'Content-Length': '1e3' }), store)).status).toBe(400);
    expect((await handlePromptGuideRequest(streamed(new TextEncoder().encode('{}'), { 'Content-Length': '3' }), store)).status).toBe(400);
    const controller = new AbortController(); controller.abort();
    const aborted = new Request('http://fixture/api/what-i-said/guides/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new ReadableStream(), signal: controller.signal });
    expect((await handlePromptGuideRequest(aborted, store)).status).toBe(400); expect(calls).toBe(0);
  });

  test('an unfinished request body times out and cancels the stream before any storage operation', async () => {
    let calls = 0, cancelled = false;
    const req = new Request('http://fixture/api/what-i-said/guides/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({ cancel() { cancelled = true; } }),
    });
    const result = await handlePromptGuideRequest(req, { async read() { calls++; return { revision: '0', entries: [] }; }, async save() { calls++; return { revision: '0', entries: [] }; } });
    expect(result.status).toBe(408); expect(await result.json()).toMatchObject({ code: 'PROMPT_GUIDES_BODY_TIMEOUT' });
    expect(result.headers.get('connection')).toBe('close');
    expect(cancelled).toBe(true); expect(calls).toBe(0);
  }, 10_000);
});
