import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProjectMemory } from '../project-memory-server';
import { resolveAppDataDir } from '../src/appDataDir';
import {
  captureWhatISaidPrompt,
  configureWhatISaidCapture,
  type WhatISaidLocation,
} from '../src/whatISaidStore';
import { startTestApiServer } from './startTestApiServer';

const KEY = Buffer.alloc(32, 0x31);
const CAPABILITY = 'c'.repeat(64);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface CloudCalls {
  cursorReads: number;
  upserts: Array<Record<string, unknown>>;
  cleanups: number;
  exclusionReads: number;
  scopeReads: number;
  listRpcs: number;
}

/** A tiny PostgREST stand-in: only what the What-I-said paths touch. */
function fakeCloud(options: { listFails?: boolean } = {}) {
  const calls: CloudCalls = { cursorReads: 0, upserts: [], cleanups: 0, exclusionReads: 0, scopeReads: 0, listRpcs: 0 };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const url = new URL(request.url);
    const select = url.searchParams.get('select') ?? '';
    if (url.pathname.endsWith('/portmgr_what_i_said_memory_policy')) {
      if (url.searchParams.get('upload_excluded') === 'eq.true') calls.exclusionReads += 1;
      return Response.json([]);
    }
    if (url.pathname.endsWith('/portmgr_what_i_said_prompts')) {
      if (request.method === 'POST') {
        const rows = await request.json() as Array<Record<string, unknown>>;
        calls.upserts.push(...rows);
        return new Response(null, { status: 201 });
      }
      if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Range': '0-0/0' } });
      if (select === 'local_seq') {
        calls.cursorReads += 1;
        const max = calls.upserts.reduce((top, row) => Math.max(top, Number(row.local_seq ?? 0)), 0);
        return Response.json(max > 0 ? [{ local_seq: max }] : []);
      }
      if (select === 'memory_id, project_name' || select === 'memory_id,project_name') {
        calls.scopeReads += 1;
        return Response.json([]);
      }
      return Response.json([]);
    }
    if (url.pathname.endsWith('/rpc/portmgr_what_i_said_cleanup')) {
      calls.cleanups += 1;
      return Response.json(0);
    }
    if (url.pathname.endsWith('/rpc/portmgr_list_what_i_said_prompts')) {
      calls.listRpcs += 1;
      if (options.listFails) return Response.json({ message: 'upstream unhealthy' }, { status: 503 });
      return Response.json([]);
    }
    return Response.json([]);
  } });
  cleanups.push(() => server.stop(true));
  return { server, calls };
}

async function setup(input: { cloudUrl: string; uploadEnabled: boolean; globalCapture: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-throttle-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    NODE_ENV: 'test',
    PORT: '9000',
    PORTMGR_ALLOWED_ORIGINS: '',
    PORTMGR_BUNDLED_SIDECAR: '1',
    PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
    PORTMGR_WHAT_I_SAID_TEST_KEY: KEY.toString('hex'),
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
  };
  const appDataDir = resolveAppDataDir(process.platform, env, home);
  const projectPath = join(home, 'projects', 'throttle');
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  const git = Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: projectPath });
  if (git.exitCode !== 0) throw new Error('git init failed');
  const memory = initializeProjectMemory({ folderPath: projectPath, projectName: 'Throttle project', autoBackup: false });
  const location: WhatISaidLocation = { appDataDir, projectRoot: projectPath, memoryId: memory.config!.memoryId };
  configureWhatISaidCapture({
    ...location,
    enabled: true,
    retention: 365,
    analysisAllowed: false,
    now: '2026-09-01T00:00:00.000Z',
  });
  const addPrompt = (event: string, text: string) => {
    const result = captureWhatISaidPrompt({
      ...location,
      key: KEY,
      agent: 'codex',
      sourceIdentity: 'fixture.jsonl',
      sourceEventIdentity: event,
      recordedAt: '2026-09-02T00:00:00.000Z',
      text,
      now: '2026-09-02T00:00:01.000Z',
    });
    if (!result.stored) throw new Error(`fixture prompt was not stored: ${result.reason}`);
  };
  addPrompt('1', 'first local prompt');
  writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
    { id: 'throttle', name: 'Throttle project', folderPath: projectPath },
  ]));
  writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({
    supabaseUrl: input.cloudUrl,
    deviceId: 'this-device',
    deviceName: 'This Mac',
    whatISaidRemote: { enabled: input.uploadEnabled, excludedMemoryIds: [] },
  }));
  writeFileSync(join(appDataDir, 'supabase-service.json'), JSON.stringify({ serviceRoleKey: 'fixture-service-role' }), { mode: 0o600 });
  if (input.globalCapture) {
    writeFileSync(join(appDataDir, 'what-i-said-settings.json'), JSON.stringify({
      schemaVersion: 1, enabled: true, retentionDays: 365, analysisAllowed: false,
      updatedAt: '2026-09-01T00:00:00.000Z',
    }));
  }
  const api = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env });
  cleanups.push(async () => { api.child.kill(); await api.child.exited.catch(() => undefined); });
  const request = async (path: string, body: unknown = {}) => {
    const response = await fetch(`${api.baseUrl}/api/what-i-said/${path}`, {
      method: 'POST',
      headers: {
        Origin: 'http://tauri.localhost',
        'Content-Type': 'application/json',
        'X-AgentsToZ-What-I-Said-Capability': CAPABILITY,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { projectPath, request, addPrompt, appDataDir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  return predicate();
}

test('background capture pushes only when the local store has something new', async () => {
  const cloud = fakeCloud();
  const { projectPath, request, addPrompt } = await setup({
    cloudUrl: cloud.server.url.origin, uploadEnabled: true, globalCapture: true,
  });
  // The startup tick uploads the backlog once.
  expect(await waitFor(() => cloud.calls.upserts.length >= 1)).toBe(true);
  // Let any in-flight startup work settle before measuring idle captures.
  await Bun.sleep(300);
  const cursorReadsAfterBacklog = cloud.calls.cursorReads;
  const cleanupsAfterBacklog = cloud.calls.cleanups;
  const upsertsAfterBacklog = cloud.calls.upserts.length;
  expect(cleanupsAfterBacklog).toBe(1);

  for (let i = 0; i < 3; i += 1) {
    const idle = await request('capture', { folderPath: projectPath });
    expect(idle.status).toBe(200);
    expect(idle.body.captured).toBe(0);
  }
  // Nothing new: no cursor read, no upsert, no cleanup RPC.
  expect(cloud.calls.cursorReads).toBe(cursorReadsAfterBacklog);
  expect(cloud.calls.upserts.length).toBe(upsertsAfterBacklog);
  expect(cloud.calls.cleanups).toBe(cleanupsAfterBacklog);

  // A row written by another path advances the local seq; the next capture uploads it.
  addPrompt('2', 'second local prompt');
  await request('capture', { folderPath: projectPath });
  expect(await waitFor(() => cloud.calls.upserts.length > upsertsAfterBacklog)).toBe(true);
  // The hourly cleanup RPC is not repeated for the second push.
  expect(cloud.calls.cleanups).toBe(cleanupsAfterBacklog);
}, 40_000);

test('an unhealthy remote opens the breaker: the library answers locally without waiting again', async () => {
  const cloud = fakeCloud({ listFails: true });
  const { request } = await setup({ cloudUrl: cloud.server.url.origin, uploadEnabled: false, globalCapture: false });

  // Local-first page: no remote round-trip at all.
  const local = await request('list', { source: 'local', limit: 50 });
  expect(local.status).toBe(200);
  expect(local.body).toMatchObject({ source: 'local', localFirst: true, remoteDegraded: false });
  expect(local.body.items.map((item: any) => item.text)).toEqual(['first local prompt']);
  expect(cloud.calls.listRpcs).toBe(0);

  // Auto mode tries the remote once, then falls back and says so.
  const first = await request('list', { limit: 50 });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ source: 'local', remoteDegraded: true });
  expect(typeof first.body.remoteRetryAt).toBe('string');
  expect(first.body.items).toHaveLength(1);
  expect(cloud.calls.listRpcs).toBe(1);

  // While the breaker is open nobody waits on the remote again.
  const second = await request('list', { limit: 50 });
  expect(second.body).toMatchObject({ source: 'local', remoteDegraded: true });
  const remote = await request('list', { source: 'remote', limit: 50 });
  expect(remote.status).toBe(503);
  expect(remote.body.code).toBe('WHAT_I_SAID_REMOTE_DEGRADED');
  expect(cloud.calls.listRpcs).toBe(1);

  // An unknown source is an input error, not a silent default.
  expect((await request('list', { source: 'cloud', limit: 50 })).status).toBe(400);
}, 40_000);

test('scope and exclusion metadata are cached between library reads', async () => {
  const cloud = fakeCloud();
  const { request } = await setup({ cloudUrl: cloud.server.url.origin, uploadEnabled: false, globalCapture: false });
  for (let i = 0; i < 3; i += 1) {
    const page = await request('list', { source: 'remote', limit: 50 });
    expect(page.status).toBe(200);
    expect(page.body.source).toBe('supabase');
  }
  expect(cloud.calls.listRpcs).toBe(3);
  expect(cloud.calls.scopeReads).toBe(1);
  expect(cloud.calls.exclusionReads).toBe(1);
}, 40_000);

test('fixing the Supabase connection closes the breaker right away', async () => {
  // A wrong/unhealthy target opens the breaker (up to 10 min after repeats). When the
  // user points the app at a working project, the library must not keep answering
  // "Supabase is not responding" for the rest of that window.
  const broken = fakeCloud({ listFails: true });
  const healthy = fakeCloud();
  const { request, appDataDir } = await setup({ cloudUrl: broken.server.url.origin, uploadEnabled: false, globalCapture: false });
  expect((await request('list', { limit: 50 })).body).toMatchObject({ remoteDegraded: true });
  expect((await request('list', { source: 'remote', limit: 50 })).status).toBe(503);

  writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({
    supabaseUrl: healthy.server.url.origin,
    deviceId: 'this-device',
    deviceName: 'This Mac',
    whatISaidRemote: { enabled: false, excludedMemoryIds: [] },
  }));
  const fixed = await request('list', { source: 'remote', limit: 50 });
  expect(fixed.status).toBe(200);
  expect(fixed.body).toMatchObject({ source: 'supabase', remoteDegraded: false });
  expect(healthy.calls.listRpcs).toBe(1);
  // The old target's cached metadata is not reused for the new one.
  expect(healthy.calls.exclusionReads + healthy.calls.scopeReads).toBeGreaterThan(0);
}, 40_000);
