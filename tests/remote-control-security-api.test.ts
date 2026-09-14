import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { startTestApiServer } from './startTestApiServer';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const WHAT_I_SAID_CAPABILITY = 'a'.repeat(64);
const REMOTE_CONTROL_CAPABILITY = 'b'.repeat(64);
const TAURI_ORIGIN = 'http://tauri.localhost';

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedSidecarEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    NODE_ENV: 'test',
    PORT: '9000',
    PORTMGR_ALLOWED_ORIGINS: '',
    PORTMGR_BUNDLED_SIDECAR: '1',
    PORTMGR_PARENT_PID: String(process.pid),
    PORTMGR_WHAT_I_SAID_CAPABILITY: WHAT_I_SAID_CAPABILITY,
    PORTMGR_REMOTE_CONTROL_CAPABILITY: REMOTE_CONTROL_CAPABILITY,
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
  };
  env.APP_DATA_DIR = resolveAppDataDir(process.platform, env, home);
  return env;
}

async function apiRequest(input: {
  baseUrl: string;
  path: string;
  method?: string;
  body?: string;
  capability?: 'remote' | 'what-i-said' | 'none';
  origin?: string | null;
  extraHeaders?: Record<string, string>;
}): Promise<{ response: Response; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...input.extraHeaders,
  };
  if (input.origin !== null) headers.Origin = input.origin ?? TAURI_ORIGIN;
  if (input.capability === 'remote') {
    headers['X-AgentsToZ-Remote-Control-Capability'] = REMOTE_CONTROL_CAPABILITY;
  } else if (input.capability === 'what-i-said') {
    headers['X-AgentsToZ-What-I-Said-Capability'] = WHAT_I_SAID_CAPABILITY;
  }
  const method = input.method ?? 'POST';
  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method,
    headers,
    ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { body: input.body ?? '{}' }),
  });
  const text = await response.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

describe('QR remote-control bundled sidecar security boundary', () => {
  test('keeps management capabilities non-interchangeable and enforces exact routes, methods, and bodies', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-remote-security-api-'));
    roots.push(home);
    const env = isolatedSidecarEnvironment(home);
    mkdirSync(env.APP_DATA_DIR!, { recursive: true });
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), '[]');

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const correct = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      capability: 'remote',
    });
    expect(correct.response.status).toBe(200);
    expect(correct.body).toEqual({ enabled: false, listener: null, pairing: null, sessions: [] });
    expect(correct.response.headers.get('cache-control')).toContain('no-store');

    const whatCapabilityOnRemote = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      capability: 'none',
      extraHeaders: {
        'X-AgentsToZ-Remote-Control-Capability': WHAT_I_SAID_CAPABILITY,
      },
    });
    expect(whatCapabilityOnRemote.response.status).toBe(403);
    expect(whatCapabilityOnRemote.body.code).toBe('REMOTE_CONTROL_MANAGEMENT_ORIGIN_DENIED');

    const remoteCapabilityOnWhat = await apiRequest({
      baseUrl,
      path: '/api/what-i-said/status',
      capability: 'none',
      extraHeaders: {
        'X-AgentsToZ-What-I-Said-Capability': REMOTE_CONTROL_CAPABILITY,
      },
    });
    expect(remoteCapabilityOnWhat.response.status).toBe(403);
    expect(remoteCapabilityOnWhat.body.code).toBe('WHAT_I_SAID_MANAGEMENT_ORIGIN_DENIED');

    const missingCapability = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      capability: 'none',
    });
    expect(missingCapability.response.status).toBe(403);

    const noOrigin = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      capability: 'remote',
      origin: null,
    });
    expect(noOrigin.response.status).toBe(403);

    const unknownRoute = await apiRequest({
      baseUrl,
      path: '/api/remote-control/arbitrary-shell',
      capability: 'remote',
    });
    expect(unknownRoute.response.status).toBe(404);
    expect(unknownRoute.body.code).toBe('ROUTE_NOT_FOUND');

    const wrongMethod = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      method: 'GET',
      capability: 'remote',
    });
    expect(wrongMethod.response.status).toBe(405);
    expect(wrongMethod.body.code).toBe('METHOD_NOT_ALLOWED');

    const querySmuggling = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status?folderPath=%2Ftmp%2Fsecret',
      capability: 'remote',
    });
    expect(querySmuggling.response.status).toBe(404);
    expect(querySmuggling.body.code).toBe('ROUTE_NOT_FOUND');

    for (const request of [
      { path: '/api/remote-control/status', body: '{"folderPath":"/tmp/secret"}' },
      { path: '/api/remote-control/interfaces', body: '{"command":"rm -rf /tmp/x"}' },
      { path: '/api/remote-control/enable', body: '{"interfaceAddress":"192.168.1.2","command":"id"}' },
      { path: '/api/remote-control/sessions/revoke', body: '{"all":true,"path":"/tmp"}' },
      { path: '/api/remote-control/sessions/revoke', body: '{"sessionId":"session_12345678","all":false}' },
      { path: '/api/remote-control/sessions/revoke', body: '{"sessionId":"session_12345678","all":true}' },
      { path: '/api/remote-control/sessions/revoke', body: '{"all":false}' },
      { path: '/api/remote-control/disable', body: '{"all":true}' },
    ]) {
      const rejected = await apiRequest({
        baseUrl,
        path: request.path,
        body: request.body,
        capability: 'remote',
      });
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.code).toBe('INVALID_REQUEST');
    }

    const malformed = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      body: '{',
      capability: 'remote',
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body.code).toBe('INVALID_REQUEST');

    const oversized = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      body: JSON.stringify({ padding: 'x'.repeat(5_000) }),
      capability: 'remote',
    });
    expect(oversized.response.status).toBe(413);
    expect(oversized.body.code).toBe('REQUEST_TOO_LARGE');

    const wrongPreflightCapability = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      method: 'OPTIONS',
      capability: 'none',
      extraHeaders: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-agentstoz-what-i-said-capability',
      },
    });
    expect(wrongPreflightCapability.response.status).toBe(403);

    const correctPreflight = await apiRequest({
      baseUrl,
      path: '/api/remote-control/status',
      method: 'OPTIONS',
      capability: 'none',
      extraHeaders: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-agentstoz-remote-control-capability',
      },
    });
    expect(correctPreflight.response.status).toBe(200);
  });

  test('removes both sidecar capabilities before a registered project process is spawned', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-remote-security-env-'));
    roots.push(home);
    const env = isolatedSidecarEnvironment(home);
    const appDataDir = env.APP_DATA_DIR!;
    const projectPath = join(home, 'project');
    const resultPath = join(home, 'inherited-environment.txt');
    const commandPath = join(projectPath, 'check-sidecar-environment.sh');
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    const quotedResult = resultPath.replace(/'/g, `'"'"'`);
    writeFileSync(commandPath, [
      '#!/bin/bash',
      'if [ -n "${PORTMGR_WHAT_I_SAID_CAPABILITY:-}${PORTMGR_REMOTE_CONTROL_CAPABILITY:-}${APP_DATA_DIR:-}${PORTMGR_PARENT_PID:-}${PORTMGR_BUNDLED_SIDECAR:-}" ]; then',
      `  printf leaked > '${quotedResult}'`,
      'else',
      `  printf absent > '${quotedResult}'`,
      'fi',
      '',
    ].join('\n'));
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: 'remote-security-env-check',
      name: 'Remote security environment check',
      folderPath: projectPath,
      commandPath,
    }]));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);
    const response = await fetch(`${baseUrl}/api/execute-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portId: 'remote-security-env-check',
        commandPath,
        folderPath: projectPath,
      }),
    });
    expect(response.status).toBe(200);
    for (let attempt = 0; attempt < 100 && !existsSync(resultPath); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(readFileSync(resultPath, 'utf8')).toBe('absent');
  });
});
