import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApiServer } from './startTestApiServer';
import { fetchBrowserDocument, readBrowserContextRequest, resolveBrowserUrl } from '../src/browserContextPolicy';

const endpoint = '/api/agent-runtime/browser-context';
const runtimeCapability = 'c'.repeat(64);
let root = '';
let baseUrl = '';
let child: Bun.Subprocess | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentstoz-browser-security-'));
  const appData = join(root, 'app-data');
  mkdirSync(appData);
  writeFileSync(join(appData, 'ports.json'), '[]');
  const started = await startTestApiServer({
    cwd: join(import.meta.dir, '..'),
    // Deliberately do not inherit live account, proxy or provider credentials.
    env: {
      HOME: root,
      PATH: process.env.PATH,
      APP_DATA_DIR: appData,
      APPDATA: join(root, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(root, '.config'),
      NODE_ENV: 'test',
      PORT: '9000',
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_PARENT_PID: String(process.pid),
      PORTMGR_AGENT_RUNTIME_CAPABILITY: runtimeCapability,
      PORTMGR_REMOTE_CONTROL_CAPABILITY: 'b'.repeat(64),
      PORTMGR_WHAT_I_SAID_CAPABILITY: 'a'.repeat(64),
    },
  });
  baseUrl = started.baseUrl;
  child = started.child;
}, 15_000);

afterAll(async () => {
  if (child) {
    child.kill();
    await child.exited.catch(() => undefined);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function request(input: {
  path?: string;
  method?: string;
  origin?: string | null;
  capability?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...input.headers };
  if (input.origin !== null) headers.Origin = input.origin ?? 'http://tauri.localhost';
  if (input.capability !== null) headers['X-AgentsToZ-Agent-Runtime-Capability'] = input.capability ?? runtimeCapability;
  const method = input.method ?? 'POST';
  const response = await fetch(baseUrl + (input.path ?? endpoint), {
    method,
    headers,
    ...(method === 'GET' || method === 'OPTIONS' ? {} : { body: JSON.stringify(input.body ?? { operation: 'status' }) }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

describe('browser context independent security boundaries', () => {
  test('rejects remote origins, absent authority and unrelated management capabilities', async () => {
    for (const capability of [null, 'a'.repeat(64), 'b'.repeat(64)]) {
      expect((await request({ capability })).response.status).toBe(403);
    }
    for (const origin of [null, 'null', 'https://example.invalid', 'http://localhost:9000.evil.invalid']) {
      expect((await request({ origin })).response.status).toBe(403);
    }
    expect((await request({ origin: null, headers: {
      'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    } })).response.status).toBe(403);
    expect((await request({ capability: null, headers: {
      'X-AgentsToZ-Remote-Control-Capability': runtimeCapability,
    } })).response.status).toBe(403);
  });

  test('only the exact POST route is admitted', async () => {
    for (const path of [endpoint + '?url=http://localhost', endpoint + '/read', endpoint + '/']) {
      expect((await request({ path })).response.status).toBe(403);
    }
    expect((await request({ method: 'GET' })).response.status).toBe(403);
    expect((await request({ method: 'DELETE' })).response.status).toBe(403);
  });

  test('status stays path-free and never exposes reusable management secrets', async () => {
    const { response, body } = await request();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.available).toBe('boolean');
    expect(Array.isArray(body.sessions)).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(root);
    for (const secret of [runtimeCapability, 'a'.repeat(64), 'b'.repeat(64)]) expect(serialized).not.toContain(secret);
    expect(response.headers.get('cache-control')).toContain('no-store');
    if (body.available === false) expect(typeof body.reason).toBe('string');
  });

  test('rejects caller-controlled paths, profiles, CDP, evaluation and unknown operations', async () => {
    for (const body of [
      { operation: 'evaluate', script: 'document.cookie' },
      { operation: 'open', url: 'file:///etc/passwd' },
      { operation: 'open', url: 'http://127.0.0.1:3001/api/ports' },
      { operation: 'open', url: 'http://localhost:9000/' },
      { operation: 'open', url: 'http://169.254.169.254/' },
      { operation: 'open', url: 'http://[::ffff:127.0.0.1]/' },
      { operation: 'open', url: 'http://2130706433/' },
      { operation: 'open', url: 'https://user:pass@example.invalid/' },
      { operation: 'open', url: 'https://example.invalid/?token=secret' },
      { operation: 'open', url: 'https://example.invalid/#secret' },
      { operation: 'status', profilePath: '/tmp/profile' },
      { operation: 'status', cdpEndpoint: 'http://127.0.0.1:9222' },
      { operation: 'status', targetId: 'ops' },
    ]) {
      const { response, body: result } = await request({ body });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain('/etc/passwd');
      expect(JSON.stringify(result)).not.toContain('user:pass');
      expect(JSON.stringify(result)).not.toContain('token=secret');
    }
  });

  test('cannot read or close a guessed or stale session', async () => {
    for (const operation of ['read', 'close']) {
      const { response, body } = await request({ body: { operation, sessionId: crypto.randomUUID() } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.success).toBe(false);
    }
  });
});


describe('browser context SSRF policy without external networking', () => {
  test('rejects mixed DNS answers and alternate local encodings before document fetch', async () => {
    const publicOnly = async () => ['93.184.216.34'];
    const mixed = async () => ['93.184.216.34', '127.0.0.1'];
    for (const url of [
      'file:///etc/passwd', 'http://169.254.169.254/', 'http://10.0.0.1/',
      'http://192.168.1.1/', 'http://100.64.0.1/', 'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f000001/',
      'http://0177.0.0.1/', 'http://localhost:3001/', 'http://localhost:9000/',
      'http://localhost:9001/', 'http://localhost:1420/', 'http://localhost:4567/',
      'https://user:password@example.invalid/', 'https://example.invalid/?secret=1',
      'https://example.invalid/#secret', 'http://example.invalid:9222/',
    ]) {
      await expect(resolveBrowserUrl(url, [3001, 9000, 9001, 1420], publicOnly as never)).rejects.toThrow();
    }
    await expect(resolveBrowserUrl('https://example.invalid/', [], mixed as never)).rejects.toThrow();
    expect((await resolveBrowserUrl('http://localhost:4567/', [4567], publicOnly as never)).address).toBe('127.0.0.1');
    expect((await resolveBrowserUrl('https://example.invalid/', [], publicOnly as never)).address).toBe('93.184.216.34');
  });

  test('one anonymous local fixture GET never follows redirects or accepts binary responses', async () => {
    let redirected = 0;
    let receivedHeaders: Headers | undefined;
    const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req) {
      const path = new URL(req.url).pathname;
      receivedHeaders = req.headers;
      if(path === '/redirect') return new Response(null,{status:302,headers:{Location:'/secret'}});
      if(path === '/secret') redirected++;
      if(path === '/binary') return new Response('private binary',{headers:{'Content-Type':'application/octet-stream'}});
      return new Response('<p>safe fixture</p>',{headers:{'Content-Type':'text/html'}});
    }});
    try {
      const target = (path:string) => ({url:new URL(`http://127.0.0.1:${server.port}${path}`),address:'127.0.0.1'});
      await expect(fetchBrowserDocument(target('/redirect'))).rejects.toThrow();
      expect(redirected).toBe(0);
      await expect(fetchBrowserDocument(target('/binary'))).rejects.toThrow();
      expect(await fetchBrowserDocument(target('/html'))).toContain('safe fixture');
      expect(receivedHeaders!.get('cookie')).toBeNull();
      expect(receivedHeaders!.get('authorization')).toBeNull();
    } finally { await server.stop(true); }
  });
});


describe('browser context bounded local request lifetime', () => {
  test('a stalled request body is cancelled at its deadline', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"operation":')); },
      cancel() { cancelled = true; },
    });
    const started = Date.now();
    await expect(readBrowserContextRequest(new Request('http://localhost/', {
      method:'POST',headers:{'Content-Type':'application/json'},body,
    }))).rejects.toMatchObject({status:408});
    expect(cancelled).toBe(true);
    expect(Date.now()-started).toBeLessThan(3500);
  }, 5000);

  test('a DNS resolver that never completes cannot keep URL admission pending', async () => {
    const started = Date.now();
    await expect(resolveBrowserUrl('https://never-resolves.invalid/', [], (() => new Promise<string[]>(() => {})) as never)).rejects.toThrow();
    expect(Date.now()-started).toBeLessThan(4500);
  }, 5000);

  test('abort stops a stalled anonymous document fixture and cannot leak content', async () => {
    const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('<p>unfinished')); },
      }), {headers:{'Content-Type':'text/html'}});
    }});
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(fetchBrowserDocument({url:new URL(`http://127.0.0.1:${server.port}/`),address:'127.0.0.1'},controller.signal)).rejects.toThrow();
      expect(Date.now()-started).toBeLessThan(1500);
    } finally { clearTimeout(timer);await server.stop(true); }
  }, 3000);
});
