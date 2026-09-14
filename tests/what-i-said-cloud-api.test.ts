import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { startTestApiServer } from './startTestApiServer';

test('a fresh device reads cloud-only prompts and totals while local capture remains unavailable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-cloud-voc-'));
  const row = { id: 'remote-prompt', memory_id: 'remote-memory', project_name: 'Other Mac project',
    device_id: 'other-device', device_name: 'Other Mac', feed_seq: '123', agent: 'codex',
    prompt_origin: 'human', recorded_at: '2026-09-07T00:00:00Z', body: 'Fixture cloud prompt', redaction_state: 'clean' };
  const calls: Array<{ path: string; body: any }> = [];
  let excluded = false;
  const cloud = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/portmgr_what_i_said_prompts')) {
      if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Range': '0-0/1' } });
      return Response.json([{ memory_id: row.memory_id, project_name: row.project_name }]);
    }
    if (url.pathname.endsWith('/portmgr_what_i_said_memory_policy')) return Response.json(excluded ? [{ memory_id: row.memory_id }] : []);
    if (url.pathname.endsWith('/rpc/portmgr_list_what_i_said_prompts')) {
      expect((body as any).p_memory_ids).toEqual(['remote-memory']);
      return Response.json([row]);
    }
    return Response.json([]);
  } });
  let child: Bun.Subprocess | undefined;
  try {
    const env = { ...process.env, HOME: home, APPDATA: join(home, 'AppData'), XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test', PORTMGR_BUNDLED_SIDECAR: '1', PORTMGR_WHAT_I_SAID_CAPABILITY: 'c'.repeat(64), AGENTSTOZ_SKIP_HERMES_SYNC: '1' };
    const dir = resolveAppDataDir(process.platform, env, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ports.json'), '[]');
    writeFileSync(join(dir, 'portal.json'), JSON.stringify({ supabaseUrl: cloud.url.origin, deviceId: 'fresh-device' }));
    writeFileSync(join(dir, 'supabase-service.json'), JSON.stringify({ serviceRoleKey: 'fixture-service-role' }), { mode: 0o600 });
    const api = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env }); child = api.child;
    const request = async (path: string, body: unknown = {}) => {
      const result = await fetch(`${api.baseUrl}/api/what-i-said/${path}`, { method: 'POST',
        headers: { Origin: 'http://tauri.localhost', 'Content-Type': 'application/json', 'X-AgentsToZ-What-I-Said-Capability': 'c'.repeat(64) },
        body: JSON.stringify(body) });
      return { status: result.status, body: await result.json() as any };
    };
    const status = await request('remote/status');
    expect(status.status).toBe(200);
    expect(status.body.storedRows).toBe(1);
    expect(status.body.projects).toEqual([]);
    expect(status.body.cloudProjects).toEqual([{ memoryId: 'remote-memory', name: 'Other Mac project' }]);
    for (const body of [{}, { memoryIds: ['remote-memory'] }]) {
      const list = await request('list', body);
      expect(list.status).toBe(200);
      expect(list.body.source).toBe('supabase');
      expect(list.body.items).toMatchObject([{ text: row.body, deviceId: 'other-device', memoryId: 'remote-memory' }]);
    }
    expect((await request('sync', { memoryIds: ['remote-memory'] })).status).not.toBe(200);
    excluded = true;
    expect((await request('list')).body.items).toEqual([]);
    expect(calls.filter(call => call.body && !call.path.endsWith('/rpc/portmgr_list_what_i_said_prompts'))).toEqual([]);
  } finally {
    child?.kill(); await child?.exited;
    cloud.stop(true); rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
