import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { normalizeInternetRemoteControlStatusResponse } from '../src/internetRemoteControlContract';
import { parseRemoteControlRelayPairingUrl } from '../src/remoteControlRelayContract';
import {
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
} from '../src/remoteControlRelayCrypto';
import { startTestApiServer } from './startTestApiServer';

const CAPABILITY = 'f'.repeat(64);
const TAURI_ORIGIN = 'http://tauri.localhost';
const SERVICE_ROLE = 'service-role-test-only';
const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const relayServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const server of relayServers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sidecarEnvironment(home: string, appDataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    APP_DATA_DIR: appDataDir,
    NODE_ENV: 'test',
    PORT: '9000',
    PORTMGR_ALLOWED_ORIGINS: '',
    PORTMGR_BUNDLED_SIDECAR: '1',
    PORTMGR_PARENT_PID: String(process.pid),
    PORTMGR_WHAT_I_SAID_CAPABILITY: 'e'.repeat(64),
    PORTMGR_REMOTE_CONTROL_CAPABILITY: CAPABILITY,
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    SUPABASE_SERVICE_ROLE_KEY: undefined,
  };
}

async function management(
  baseUrl: string,
  path: string,
  body: Record<string, unknown> = {},
  input: { method?: string; capability?: string; origin?: string | null } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.origin !== null) headers.Origin = input.origin ?? TAURI_ORIGIN;
  if (input.capability !== '') {
    headers['X-AgentsToZ-Remote-Control-Capability'] = input.capability ?? CAPABILITY;
  }
  const method = input.method ?? 'POST';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-remote-internet-management-'));
  roots.push(home);
  const envBase = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const appDataDir = resolveAppDataDir(process.platform, envBase, home);
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(join(appDataDir, 'ports.json'), '[]');
  return { home, appDataDir };
}

function startFakeRelay(
  fetch: (request: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 49_152 + Math.floor(Math.random() * (65_535 - 49_152));
    try {
      return Bun.serve({ hostname: '127.0.0.1', port, fetch });
    } catch { /* reserve another explicit high port */ }
  }
  throw new Error('could not reserve a fake relay port');
}

describe('Internet QR sidecar management boundary', () => {
  test('blocks only a new task grant while allowing a legacy grant to be retained', () => {
    const source = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    const scopesStart = source.indexOf("pathname === '/api/remote-control/internet/sessions/scopes'");
    const scopesEnd = source.indexOf("pathname === '/api/remote-control/internet/disable'", scopesStart);
    const scopesRoute = source.slice(scopesStart, scopesEnd);
    expect(scopesRoute).toContain('const existingSession = remoteControlInternetAgent.status().sessions.find(');
    expect(scopesRoute).toContain('existingSession?.taskScopeGranted !== true');
    expect(scopesRoute).not.toContain('if (body.grantTaskScope && !AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED)');

    const approvalStart = source.indexOf("pathname === '/api/remote-control/internet/sessions/approve'");
    const approvalEnd = source.indexOf("pathname === '/api/remote-control/internet/sessions/revoke'", approvalStart);
    expect(source.slice(approvalStart, approvalEnd)).toContain(
      'if (body.grantTaskScope === true && !AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED)',
    );
  });

  test('keeps exact POST routes and exact HTTPS controller origins behind the Tauri capability', async () => {
    const { home, appDataDir } = createFixture();
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: sidecarEnvironment(home, appDataDir),
    });
    children.push(child);

    const status = await management(baseUrl, '/api/remote-control/internet/status');
    expect(status.response.status).toBe(200);
    expect(status.payload).toEqual({
      status: {
        enabled: false,
        state: 'disabled',
        controllerUrl: null,
        hostExpiresAt: null,
        pairingExpiresAt: null,
        lastRelayContactAt: null,
        sessions: [],
        error: null,
      },
      // Offered so the first step is not a blank field holding an address that
      // lives nowhere in the app. Null here: this fixture has no portal deploy
      // URL and has never enabled successfully.
      suggestedControllerOrigin: null,
    });
    expect(status.response.headers.get('cache-control')).toContain('no-store');

    const missingCapability = await management(
      baseUrl,
      '/api/remote-control/internet/status',
      {},
      { capability: '' },
    );
    expect(missingCapability.response.status).toBe(403);

    const wrongMethod = await management(
      baseUrl,
      '/api/remote-control/internet/status',
      {},
      { method: 'GET' },
    );
    expect(wrongMethod.response.status).toBe(405);

    const querySmuggling = await management(
      baseUrl,
      '/api/remote-control/internet/status?hostSecret=hidden',
    );
    expect(querySmuggling.response.status).toBe(404);

    for (const controllerOrigin of [
      'http://controller.example.test',
      'https://controller.example.test/remote/',
      'https://controller.example.test/?token=hidden',
      'https://user:password@controller.example.test',
    ]) {
      const rejected = await management(baseUrl, '/api/remote-control/internet/enable', { controllerOrigin });
      expect(rejected.response.status).toBe(400);
      expect(rejected.payload.code).toBe('INVALID_CONTROLLER_ORIGIN');
    }

    for (const [path, body] of [
      ['/api/remote-control/internet/status', { hostSecret: 'hidden' }],
      ['/api/remote-control/internet/enable', { controllerOrigin: 'https://controller.example.test', path: '/tmp' }],
      ['/api/remote-control/internet/sessions/approve', { sessionId: 'not-a-uuid', expectedSasCode: '123456' }],
      ['/api/remote-control/internet/sessions/approve', { sessionId: '22222222-2222-4222-8222-222222222222', expectedSasCode: '12345' }],
      ['/api/remote-control/internet/sessions/scopes', { sessionId: 'not-a-uuid', grantTaskScope: true, grantConversationScope: false }],
      ['/api/remote-control/internet/sessions/scopes', { sessionId: '22222222-2222-4222-8222-222222222222', grantTaskScope: 'yes', grantConversationScope: false }],
      ['/api/remote-control/internet/sessions/revoke', { sessionId: 'not-a-uuid' }],
      ['/api/remote-control/internet/disable', { all: true }],
    ] as const) {
      const rejected = await management(baseUrl, path, body);
      expect(rejected.response.status).toBe(400);
      expect(rejected.payload.code).toMatch(/^INVALID_/);
    }
  });

  test('returns the one-use QR only from enable and keeps all status responses secret-free', async () => {
    const calls: Array<{ rpc: string; authorization: string | null; body: Record<string, unknown> }> = [];
    let registeredHost: { id: string; publicKey: string; fingerprint: string } | null = null;
    let failDisable = false;
    let exposePendingSession = false;
    let sessionApprovalState: 'pending' | 'approved' = 'pending';
    const controllerKeys = await generateRemoteControlRelayKeyPair();
    const controllerPublicKey = await exportRemoteControlRelayPublicKey(controllerKeys.publicKey);
    const controllerFingerprint = await fingerprintRemoteControlRelayPublicKey(controllerPublicKey);
    const relay = startFakeRelay(async request => {
      const url = new URL(request.url);
      const rpc = url.pathname.split('/').at(-1) ?? '';
      const body = await request.json() as Record<string, unknown>;
      calls.push({ rpc, authorization: request.headers.get('authorization'), body });
      if (rpc === 'portmgr_remote_control_register_host') {
        const publicKey = String(body.p_public_key ?? '');
        registeredHost = {
          id: String(body.p_host_id ?? ''),
          publicKey,
          fingerprint: await fingerprintRemoteControlRelayPublicKey(publicKey),
        };
        return Response.json([{
          host_id: registeredHost.id,
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          public_key_fingerprint: registeredHost.fingerprint,
        }]);
      }
      if (rpc === 'portmgr_remote_control_create_pairing' && registeredHost) {
        expect(body.p_pairing_secret_hash).toMatch(/^[0-9a-f]{64}$/);
        return Response.json([{
          pairing_id: '11111111-1111-4111-8111-111111111111',
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          host_public_key: registeredHost.publicKey,
          host_public_key_fingerprint: registeredHost.fingerprint,
        }]);
      }
      if (rpc === 'portmgr_remote_control_host_list_sessions') {
        if (!exposePendingSession) return Response.json([]);
        return Response.json([{
          session_id: '22222222-2222-4222-8222-222222222222',
          pairing_id: '11111111-1111-4111-8111-111111111111',
          controller_id: '33333333-3333-4333-8333-333333333333',
          controller_name: '통합 테스트 iPhone',
          controller_public_key: controllerPublicKey,
          controller_key_fingerprint: controllerFingerprint,
          approval_state: sessionApprovalState,
          created_at: new Date(Date.now() - 1_000).toISOString(),
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          approved_at: sessionApprovalState === 'approved' ? new Date().toISOString() : null,
          revoked_at: null,
        }]);
      }
      if (rpc === 'portmgr_remote_control_host_approve_session') {
        sessionApprovalState = 'approved';
        return Response.json([{
          session_id: '22222222-2222-4222-8222-222222222222',
          approval_state: 'approved',
        }]);
      }
      if (rpc === 'portmgr_remote_control_host_receive_messages') {
        return Response.json([]);
      }
      if (rpc === 'portmgr_remote_control_disable_host') {
        return failDisable
          ? Response.json({ message: 'relay offline' }, { status: 503 })
          : Response.json([{}]);
      }
      return Response.json({ message: 'unexpected RPC' }, { status: 404 });
    });
    relayServers.push(relay);

    const { home, appDataDir } = createFixture();
    writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({
      supabaseUrl: `http://127.0.0.1:${relay.port}`,
      deviceName: '테스트 Mac',
    }));
    writeFileSync(join(appDataDir, 'supabase-service.json'), JSON.stringify({ serviceRoleKey: SERVICE_ROLE }));
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: sidecarEnvironment(home, appDataDir),
    });
    children.push(child);

    const enabled = await management(baseUrl, '/api/remote-control/internet/enable', {
      controllerOrigin: 'https://controller.example.test',
    });
    expect(enabled.response.status).toBe(200);
    expect(Object.keys(enabled.payload).sort()).toEqual(['pairing', 'status']);
    expect(enabled.payload.status.enabled).toBe(true);
    expect(enabled.payload.status.state).toBe('pairing');
    expect(enabled.payload.status.controllerUrl).toBe('https://controller.example.test/remote/');
    expect(Object.keys(enabled.payload.pairing).sort()).toEqual(['expiresAt', 'pairingUrl']);
    const pairing = parseRemoteControlRelayPairingUrl(enabled.payload.pairing.pairingUrl);
    expect(pairing.controllerUrl).toBe('https://controller.example.test/remote/');
    expect(pairing.bootstrap.pairingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(enabled.payload)).not.toContain(SERVICE_ROLE);

    exposePendingSession = true;
    let status = await management(baseUrl, '/api/remote-control/internet/status');
    for (
      let attempt = 0;
      attempt < 40 && !/^\d{6}$/.test(status.payload.status.sessions[0]?.sasCode ?? '');
      attempt += 1
    ) {
      await Bun.sleep(50);
      status = await management(baseUrl, '/api/remote-control/internet/status');
    }
    expect(status.response.status).toBe(200);
    expect(status.payload.status.enabled).toBe(true);
    expect(status.payload.status.sessions).toEqual([expect.objectContaining({
      sessionId: '22222222-2222-4222-8222-222222222222',
      pairingId: pairing.bootstrap.pairingId,
      approvalState: 'pending',
      sasCode: expect.stringMatching(/^\d{6}$/),
    })]);
    expect(normalizeInternetRemoteControlStatusResponse(status.payload).sessions[0]?.pairingId)
      .toBe(pairing.bootstrap.pairingId);
    const serializedStatus = JSON.stringify(status.payload);
    for (const forbidden of [
      SERVICE_ROLE,
      'pairingUrl',
      'pairingSecret',
      'hostSecret',
      'privateKey',
      'sessionToken',
    ]) expect(serializedStatus).not.toContain(forbidden);

    const blockedApproval = await management(baseUrl, '/api/remote-control/internet/sessions/approve', {
      sessionId: '22222222-2222-4222-8222-222222222222',
      expectedSasCode: status.payload.status.sessions[0].sasCode,
      grantTaskScope: true,
      grantConversationScope: false,
    });
    expect(blockedApproval.response.status).toBe(409);
    expect(blockedApproval.payload.code).toBe('AGENT_RUNTIME_MANAGED_EXECUTION_DISABLED');

    const approved = await management(baseUrl, '/api/remote-control/internet/sessions/approve', {
      sessionId: '22222222-2222-4222-8222-222222222222',
      expectedSasCode: status.payload.status.sessions[0].sasCode,
      grantTaskScope: false,
      grantConversationScope: false,
    });
    expect(approved.response.status).toBe(200);
    expect(approved.payload.status.sessions[0]).toMatchObject({
      approvalState: 'approved',
      taskScopeGranted: false,
      conversationScopeGranted: false,
    });
    const blockedScopes = await management(baseUrl, '/api/remote-control/internet/sessions/scopes', {
      sessionId: '22222222-2222-4222-8222-222222222222',
      grantTaskScope: true,
      grantConversationScope: true,
    });
    expect(blockedScopes.response.status).toBe(409);
    expect(blockedScopes.payload.code).toBe('AGENT_RUNTIME_MANAGED_EXECUTION_DISABLED');

    const scopes = await management(baseUrl, '/api/remote-control/internet/sessions/scopes', {
      sessionId: '22222222-2222-4222-8222-222222222222',
      grantTaskScope: false,
      grantConversationScope: true,
    });
    expect(scopes.response.status).toBe(200);
    expect(scopes.payload.status.sessions[0]).toMatchObject({
      approvalState: 'approved',
      taskScopeGranted: false,
      conversationScopeGranted: true,
    });

    // Local revocation must win even when the Internet relay is unreachable;
    // the server-side host registration expires independently after its TTL.
    failDisable = true;
    const disabled = await management(baseUrl, '/api/remote-control/internet/disable');
    expect(disabled.response.status).toBe(200);
    expect(disabled.payload).toEqual({
      status: expect.objectContaining({ enabled: false, state: 'disabled', sessions: [] }),
    });
    expect(calls.every(call => call.authorization === `Bearer ${SERVICE_ROLE}`)).toBe(true);
    expect(calls.map(call => call.rpc)).toContain('portmgr_remote_control_disable_host');
  });

  test('reports a missing relay migration without leaking PostgREST or service-role details', async () => {
    const relay = startFakeRelay(() => Response.json({
      code: 'PGRST202',
      message: 'Could not find the function public.portmgr_remote_control_register_host in the schema cache',
    }, { status: 404 }));
    relayServers.push(relay);
    const { home, appDataDir } = createFixture();
    writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({
      supabaseUrl: `http://127.0.0.1:${relay.port}`,
      deviceName: '테스트 Mac',
    }));
    writeFileSync(join(appDataDir, 'supabase-service.json'), JSON.stringify({ serviceRoleKey: SERVICE_ROLE }));
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: sidecarEnvironment(home, appDataDir),
    });
    children.push(child);

    const result = await management(baseUrl, '/api/remote-control/internet/enable', {
      controllerOrigin: 'https://controller.example.test',
    });
    expect(result.response.status).toBe(503);
    expect(result.payload).toEqual({
      success: false,
      code: 'INTERNET_REMOTE_MIGRATION_REQUIRED',
      error: '외부 인터넷 원격제어용 최신 Supabase 마이그레이션이 필요합니다. 설정에서 DB 설치·업데이트를 먼저 실행하세요.',
    });
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain('PGRST202');
    expect(serialized).not.toContain(SERVICE_ROLE);
  });
});
