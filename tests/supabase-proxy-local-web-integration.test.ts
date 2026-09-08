import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { startTestApiServer } from './startTestApiServer';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const upstreams: Array<ReturnType<typeof Bun.serve>> = [];

function startUpstream(fetch: (request: Request) => Response) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    try {
      return Bun.serve({ hostname: '127.0.0.1', port, fetch });
    } catch { /* try another bounded loopback port */ }
  }
  throw new Error('could not reserve a Supabase proxy fixture port');
}

function canBindLoopback(): boolean {
  try {
    const probe = startUpstream(() => new Response(null, { status: 204 }));
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

// Some managed sandboxes deny every listen(2) call. Keep CI exercising the
// real child/upstream integration whenever loopback binding is available.
const loopbackIntegrationTest = canBindLoopback() ? test : test.skip;

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('source-development Supabase proxy', () => {
  loopbackIntegrationTest('forwards exact loopback UI requests without exposing the service key', async () => {
    const observed: Array<{ path: string; authorization: string | null; apikey: string | null }> = [];
    const upstream = startUpstream(request => {
        const url = new URL(request.url);
        observed.push({
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get('authorization'),
          apikey: request.headers.get('apikey'),
        });
        return Response.json([{ id: 'safe-fixture' }], {
          headers: { 'Content-Range': '0-0/1' },
        });
    });
    upstreams.push(upstream);

    const home = mkdtempSync(join(tmpdir(), 'agentstoz-supabase-proxy-'));
    roots.push(home);
    const env = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    };
    const appDataDir = resolveAppDataDir(process.platform, env, home);
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({
      supabaseUrl: `http://127.0.0.1:${upstream.port}`,
      supabaseAnonKey: 'public-test-key',
    }));
    writeFileSync(join(appDataDir, 'supabase-service.json'), JSON.stringify({
      serviceRoleKey: 'private-service-test-key',
    }));

    const uiPort = 39_101;
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...env,
        APP_DATA_DIR: appDataDir,
        NODE_ENV: 'test',
        PORT: String(uiPort),
        PORTMGR_BUNDLED_SIDECAR: '0',
        AGENTSTOZ_SKIP_HERMES_SYNC: '1',
      },
    });
    children.push(child);

    const allowed = await fetch(`${baseUrl}/api/supabase-proxy/rest/v1/portmgr_ports?select=id`, {
      headers: {
        Origin: `http://127.0.0.1:${uiPort}`,
        apikey: 'renderer-placeholder',
        Authorization: 'Bearer renderer-placeholder',
      },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual([{ id: 'safe-fixture' }]);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(`http://127.0.0.1:${uiPort}`);
    expect(observed).toEqual([{
      path: '/rest/v1/portmgr_ports?select=id',
      authorization: 'Bearer private-service-test-key',
      apikey: 'private-service-test-key',
    }]);

    const remote = await fetch(`${baseUrl}/api/supabase-proxy/rest/v1/portmgr_ports?select=id`, {
      headers: { Origin: 'https://portal.example' },
    });
    expect(remote.status).toBe(403);
    expect(observed).toHaveLength(1);

    const originless = await fetch(`${baseUrl}/api/supabase-proxy/rest/v1/portmgr_ports?select=id`);
    expect(originless.status).toBe(403);
    expect(observed).toHaveLength(1);
  });
});
