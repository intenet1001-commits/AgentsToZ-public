/**
 * WP2 — the emulator harness's PGlite Supabase shim (scripts/emulator-e2e/supabaseShim.ts) and per-run CA
 * (scripts/emulator-e2e/fixtureCa.ts).
 *
 * The client side of every check is real product code: the relay host transport and phone client
 * (src/remoteControlRelayRpcClient.ts), RemoteControlInternetAgent, AgentDialogueHost wired the way
 * api-server.ts wires it, and the portal's own email-code login (src/portalEmailCodeAuth.ts) on supabase-js.
 * The https door is exercised from a separate Bun process whose environment is built from empty and trusts
 * the run's CA only through NODE_EXTRA_CA_CERTS — and the same process without it must fail TLS.
 *
 * Every test or hook that starts a shim, a child process or openssl carries its own timeout (SHIM_TIMEOUT_MS):
 * starting PGlite with the canonical schema took over 6 s on a loaded machine, past Bun's 5 s default, which
 * silently dropped the whole suite. The last describe block checks that rule on this file's own syntax tree.
 * Guards that would touch a real folder or port if they regressed are tested on a fake home, or through a path
 * whose parent is a regular file, so a regression fails with ENOTDIR instead of writing anything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as ts from 'typescript';
import { createFixtureCa, describeFixtureCertificate } from '../scripts/emulator-e2e/fixtureCa';
import {
  SHIM_CREDENTIALS_FILE, SHIM_DIALOGUE_DUMP_FILE, SHIM_EXIT_STOP_FAILED, SHIM_EXIT_UNSUPPORTED, SHIM_EXIT_USAGE,
  SHIM_RELAY_DUMP_FILE, SHIM_REPORT_FILE, SHIM_RESERVED_PORTS,
  assertIsolatedShimEnvironment, assertLoopbackShimUrl, measureShimIsolation, parseShimFlags, postgrestHttpStatus,
  redactForEvidence, runShimClientSelfcheck, serveOptionsFromArgv, shimRealHome, startSupabaseShim,
  validateShimSelfcheckInput, validateSupabaseShimOptions,
  type ShimSelfcheckResult, type SupabaseShim, type SupabaseShimCredentials, type SupabaseShimReport,
} from '../scripts/emulator-e2e/supabaseShim';
import {
  SUPABASE_SHIM_EXIT, parseShimReady, shimProblems, startSupabaseShimHost, supabaseShimServeArgs,
} from '../scripts/emulator-e2e/supabaseShimHost';
import { LaneHosts, applyHostViolations } from '../scripts/emulator-e2e';
import { buildAllowlistedEnv, createIsolatedProfile, realHome } from '../scripts/emulator-e2e/environment';
import { writeSandboxProfile, type SandboxProfileInput } from '../scripts/emulator-e2e/sandbox';

/** Generous on purpose: the cost is only a slower failure, the alternative is a suite that vanishes under load. */
const SHIM_TIMEOUT_MS = 120_000;
const SHIM_SCRIPT = resolve(import.meta.dir, '../scripts/emulator-e2e/supabaseShim.ts');
const API_VERSION = { 'X-Supabase-Api-Version': '2024-01-01' };
const roots: string[] = [];
function scratch(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `atz-shim-${label}-`)));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, 'evidence'), 0o700); } catch { /* only the evidence-failure tests lock one */ }
    rmSync(root, { recursive: true, force: true });
  }
});

/** A path whose parent is a regular file: creating it fails with ENOTDIR, so a regressed guard writes nothing. */
function unCreatableUnder(root: string, name = 'scratch'): string {
  const file = join(root, `regular-file-${randomUUID().slice(0, 8)}`);
  writeFileSync(file, 'not a directory\n');
  return join(file, name);
}

/** The harness rule: a child's environment is built from empty, never inherited (no APP_DATA_DIR, CODEX_HOME…). */
function allowlistedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  mkdirSync(join(home, 'tmp'), { recursive: true, mode: 0o700 });
  return { PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(process.execPath)}`, HOME: home, TMPDIR: join(home, 'tmp'), NODE_ENV: 'test', ...extra };
}

async function runChild(args: string[], env: Record<string, string>, cwd: string, timeoutMs = 90_000) {
  const child = Bun.spawn([process.execPath, '--env-file=/dev/null', SHIM_SCRIPT, ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { stdout, stderr, code };
}

type ServeLine = { event: string; httpUrl: string; httpsUrl: string; credentialsPath: string; isolation: { status: string } };

/** Start `serve` and read its stdout up to the first line with event `until`; the caller signals and drains it. */
async function startServeChild(args: string[], env: Record<string, string>, cwd: string, until: 'starting' | 'ready' = 'ready') {
  const child = Bun.spawn([process.execPath, '--env-file=/dev/null', SHIM_SCRIPT, 'serve', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let lines: ServeLine[] = [];
  while (!lines.some(line => line.event === until)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`shim exited before "${until}": ${await new Response(child.stderr).text()}`);
    buffered += decoder.decode(chunk.value, { stream: true });
    lines = buffered.split('\n').slice(0, -1).filter(entry => entry.startsWith('{')).map(entry => JSON.parse(entry) as ServeLine);
  }
  const ready = lines.find(line => line.event === until)!;
  const drain = async () => {
    let rest = buffered;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    return rest;
  };
  return { child, ready, events: lines.map(line => line.event), buffered, drain, dispose: () => { clearTimeout(killer); child.kill('SIGKILL'); } };
}

function lastJsonLine<T>(text: string): T {
  const line = text.trim().split('\n').filter(entry => entry.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON line in: ${text.slice(0, 400)}`);
  return JSON.parse(line) as T;
}

function failedChecks(result: ShimSelfcheckResult) {
  return result.checks.filter(check => !check.ok);
}

/** Raw GoTrue calls, so each test sees the exact status and code (auth-js hides some of them). */
function goTrue(base: string, anonKey: string) {
  const headers = { apikey: anonKey, 'Content-Type': 'application/json', ...API_VERSION };
  const call = async (path: string, init: RequestInit) => {
    const response = await fetch(`${base}/auth/v1${path}`, init);
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> | null };
  };
  return {
    async signIn(email: string, code: string) {
      expect((await call('/otp', { method: 'POST', headers, body: JSON.stringify({ email, create_user: false }) })).status).toBe(200);
      const verified = await call('/verify', { method: 'POST', headers, body: JSON.stringify({ type: 'email', email, token: code }) });
      expect(verified.status).toBe(200);
      return verified.body as { access_token: string; refresh_token: string };
    },
    refresh: (refreshToken: string) => call('/token?grant_type=refresh_token', { method: 'POST', headers, body: JSON.stringify({ refresh_token: refreshToken }) }),
    async user(accessToken: string) {
      const outcome = await call('/user', { headers: { ...headers, Authorization: `Bearer ${accessToken}` } });
      return outcome.status === 200 ? 'live' : `${outcome.status}/${outcome.body?.code}`;
    },
    async logout(accessToken: string, scope?: 'global' | 'local' | 'others') {
      const outcome = await call(`/logout${scope ? `?scope=${scope}` : ''}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${accessToken}` } });
      return outcome.status === 204 ? 204 : `${outcome.status}/${outcome.body?.code}`;
    },
  };
}

describe.skipIf(process.platform === 'win32')('per-run fixture CA', () => {
  test('mints a loopback-only server certificate, destroys the CA key, and keeps files private', () => {
    const dir = join(scratch('ca'), 'ca');
    const ca = createFixtureCa({ dir, label: 'unit' });
    expect(ca.caKeyDestroyed).toBe(true);
    expect(existsSync(join(dir, 'fixture-ca.key'))).toBe(false);
    expect(existsSync(join(dir, 'fixture-server.csr'))).toBe(false);
    for (const path of [ca.caCertPath, ca.serverCertPath, ca.serverKeyPath]) expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(ca.caFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    const caText = describeFixtureCertificate(ca.caCertPath);
    expect(caText).toContain('CN=AgentsToZ emulator fixture CA unit');
    expect(caText).toContain('CA:TRUE');
    expect(caText).toMatch(/Name Constraints: critical[\s\S]*DNS:localhost/);
    const leaf = describeFixtureCertificate(ca.serverCertPath);
    expect(leaf).toContain('Subject: CN=localhost');
    expect(leaf).toContain('Issuer: CN=AgentsToZ emulator fixture CA unit');
    expect(leaf).toMatch(/DNS:localhost, IP Address:127\.0\.0\.1, IP Address:0:0:0:0:0:0:0:1/);
    expect(leaf).toContain('TLS Web Server Authentication');
    // One CA per directory: an owned simulator may already trust the first one.
    expect(() => createFixtureCa({ dir })).toThrow('already exists');
  }, SHIM_TIMEOUT_MS);

  test('refuses names that could be a real host', () => {
    const root = scratch('ca-refuse');
    expect(() => createFixtureCa({ dir: join(root, 'a'), dnsNames: ['example.com'] })).toThrow('non-reserved');
    expect(() => createFixtureCa({ dir: join(root, 'b'), ipAddresses: ['192.168.0.10'] })).toThrow('non-loopback');
    expect(() => createFixtureCa({ dir: join(root, 'c'), ipAddresses: ['0.0.0.0'] })).toThrow('non-loopback');
    expect(() => createFixtureCa({ dir: 'relative/ca' })).toThrow('absolute');
    expect(() => createFixtureCa({ dir: join(root, 'd'), validityDays: 365 })).toThrow('validityDays');
  }, SHIM_TIMEOUT_MS);
});

describe.skipIf(process.platform === 'win32')('supabase shim', () => {
  let shim: SupabaseShim;
  let root: string;
  let evidence: string;
  let report: SupabaseShimReport | null = null;

  beforeAll(async () => {
    root = scratch('main');
    evidence = join(root, 'evidence');
    // preferredPort 0: the main suite never competes for 443; the fallback rule has its own test below.
    shim = await startSupabaseShim({ scratchDir: join(root, 'shim'), evidenceDir: evidence, runId: 'unit-main', https: { preferredPort: 0 } });
  }, SHIM_TIMEOUT_MS);
  afterAll(async () => { await shim?.stop(); }, SHIM_TIMEOUT_MS);

  test('refuses wildcard, LAN and name bindings before opening anything', async () => {
    const dir = scratch('bind');
    for (const hostname of ['0.0.0.0', '::', '192.168.1.10', 'localhost', ''] as never[]) {
      await expect(startSupabaseShim({ scratchDir: dir, http: { hostname } })).rejects.toThrow('only literal 127.0.0.1 or ::1');
      await expect(startSupabaseShim({ scratchDir: dir, http: false, https: { hostname } })).rejects.toThrow('only literal 127.0.0.1 or ::1');
    }
    await expect(startSupabaseShim({ scratchDir: 'relative' })).rejects.toThrow('absolute');
    await expect(startSupabaseShim({ scratchDir: dir, users: [{ email: 'x@emulator.test', member: false }] })).rejects.toThrow('member');
  }, SHIM_TIMEOUT_MS);

  test('opens an http and an https door on loopback, writes private credentials and reports its isolation', () => {
    expect(shim.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(shim.httpsUrl).toMatch(/^https:\/\/localhost:\d+$/);
    expect(shim.httpsFallback).toBeNull();
    for (const url of [shim.httpUrl!, shim.httpsUrl!]) expect(SHIM_RESERVED_PORTS).not.toContain(Number(new URL(url).port));
    expect(statSync(shim.credentialsPath).mode & 0o077).toBe(0);
    const stored = JSON.parse(readFileSync(shim.credentialsPath, 'utf8')) as SupabaseShimCredentials;
    expect(stored.otpCode).toMatch(/^\d{8}$/);
    expect(stored.caCertPath).toBe(shim.ca!.caCertPath);
    expect(stored.users).toEqual([{ email: 'owner@emulator.test', member: true }, { email: 'outsider@emulator.test', member: false }]);
    // The kernel's answer for this (unsandboxed) test process: the run is marked as not isolated, not passed off as one.
    expect(shim.isolation).toEqual(measureShimIsolation());
    if (process.platform === 'darwin') expect(shim.isolation.method).toBe('sandbox_check');
  });

  test('http door: real relay round trip, dialogue control call/poll, email-code login and grant refusals', async () => {
    const result = await runShimClientSelfcheck({ credentials: shim.credentials(), door: 'http', appDataDir: join(root, 'client-http') });
    expect(failedChecks(result)).toEqual([]);
    expect(result.checks.map(check => check.name)).toEqual([
      'transport', 'anon-denied-service-functions', 'email-code-login', 'member-rpc', 'member-denied-host-functions',
      'service-denied-controller-functions', 'relay-roundtrip', 'dialogue-control', 'outsider-not-member', 'refresh-and-logout',
    ]);
    expect(result.isolation).toEqual(measureShimIsolation());
    const relay = result.checks.find(check => check.name === 'relay-roundtrip')!.detail as Record<string, unknown>;
    // Over plaintext http the Mac leaves the Supabase project out of the QR (production rule).
    expect(relay.qrSupabase).toBeNull();
    expect(relay.executions).toBe(1);
    // Logout is proven on a live session, on both sides of the call (auth-js would hide a failed logout).
    expect(result.checks.find(check => check.name === 'refresh-and-logout')!.detail).toEqual({
      rotated: true, retriedRefresh: 'active-token-returned', beforeLogout: 'live', afterLogout: '403/session_not_found', refreshAfterLogout: 'refresh_token_not_found',
    });
    expect(result.checks.find(check => check.name === 'outsider-not-member')!.detail).toEqual({ member: false, beforeSignOut: 'live', afterSignOut: '403/session_not_found' });
    expect(shim.authEvents().filter(event => event.type === 'logout').map(event => event.ok)).toEqual([true, true]);
    // One refused service-role attempt (grant evidence) and exactly one real claim by the signed-in phone.
    expect(shim.requests().filter(entry => entry.fn === 'portmgr_remote_control_claim_pairing').map(entry => `${entry.role}:${entry.status}`))
      .toEqual(['service_role:403', 'authenticated:200']);
    expect(shim.rpcCallCount('portmgr_remote_control_host_receive_messages')).toBeGreaterThan(0);
    expect(shim.rpcCallCount('portmgr_remote_control_controller_send_message')).toBe(2);
  }, SHIM_TIMEOUT_MS);

  test('https door from an allowlisted child: works only through NODE_EXTRA_CA_CERTS', async () => {
    const home = join(root, 'child-home');
    const env = allowlistedEnv(home, { NODE_EXTRA_CA_CERTS: shim.ca!.caCertPath });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TMPDIR']);
    const args = ['client-selfcheck', '--credentials', shim.credentialsPath, '--door', 'https', '--app-data', join(home, 'app-data')];
    const trusted = await runChild(args, env, home);
    const result = lastJsonLine<ShimSelfcheckResult>(trusted.stdout);
    expect({ failed: failedChecks(result), code: trusted.code, stderr: trusted.stderr.slice(0, 400) })
      .toEqual({ failed: [], code: 0, stderr: trusted.stderr.slice(0, 400) });
    // This child is not under the WP1 sandbox, and its result says so.
    if (process.platform === 'darwin') expect(result.isolation).toEqual({ status: 'not-sandboxed', processSandboxed: false, method: 'sandbox_check' });
    const relay = result.checks.find(check => check.name === 'relay-roundtrip')!.detail as Record<string, unknown>;
    // Over https the QR carries this exact origin — the path the phone app's bundled portal needs.
    expect(relay.qrSupabase).toBe(new URL(shim.httpsUrl!).origin);

    const untrusted = await runChild(args, allowlistedEnv(join(root, 'child-untrusted')), join(root, 'child-untrusted'));
    const refused = lastJsonLine<ShimSelfcheckResult>(untrusted.stdout);
    expect(untrusted.code).toBe(1);
    expect(refused.checks).toHaveLength(1);
    expect(refused.checks[0]!.name).toBe('transport');
    expect(refused.checks[0]!.error?.code).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT/);
  }, SHIM_TIMEOUT_MS);

  test('PostgREST door rejects forged, expired and unsigned tokens and unknown keys', async () => {
    const rpc = (headers: Record<string, string>) => fetch(`${shim.httpUrl}/rest/v1/rpc/portmgr_is_member`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
    }).then(async response => ({ status: response.status, body: await response.json() as Record<string, unknown> }));
    const now = Math.floor(Date.now() / 1000);
    const forged = (() => {
      const [head, body] = shim.anonKey.split('.');
      return `${head}.${body}.${Buffer.from('not the signature at all, not even close').toString('base64url')}`;
    })();
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.x`;
    const expired = shim.signTestJwt({ role: 'authenticated', sub: '99999999-9999-4999-8999-999999999999', iat: now - 7200, exp: now - 3600 });
    expect(await rpc({})).toMatchObject({ status: 401, body: { message: 'No API key found in request' } });
    expect(await rpc({ apikey: forged })).toMatchObject({ status: 401, body: { message: 'Invalid API key' } });
    expect(await rpc({ apikey: shim.anonKey, Authorization: `Bearer ${forged}` })).toMatchObject({ status: 401, body: { code: 'PGRST301' } });
    expect(await rpc({ apikey: shim.anonKey, Authorization: `Bearer ${unsigned}` })).toMatchObject({ status: 401, body: { code: 'PGRST301' } });
    expect(await rpc({ apikey: shim.anonKey, Authorization: `Bearer ${expired}` })).toMatchObject({ status: 401, body: { code: 'PGRST303' } });
    // A token minted for a role Supabase never issues is not turned into a database role.
    expect(await rpc({ apikey: shim.anonKey, Authorization: `Bearer ${shim.signTestJwt({ role: 'postgres', exp: now + 60 })}` }))
      .toMatchObject({ status: 401, body: { code: 'PGRST301' } });
    // service_role passes the grant and the membership function answers true for it, as in Supabase.
    expect(await rpc({ apikey: shim.serviceRoleKey })).toMatchObject({ status: 200, body: true as never });
  });

  test('empty fixture policy supports only the expected service-role read', async () => {
    const params = new URLSearchParams({select: 'memory_id,capture_configured,capture_enabled,capture_enabled_at,retention_days,analysis_allowed,updated_at', memory_id: 'in.(f2fd4238-a3cf-48af-9532-052f32612b90)'});
    const path = `${shim.httpUrl}/rest/v1/portmgr_what_i_said_memory_policy?${params}`;
    const response = await fetch(path, {headers: {apikey: shim.serviceRoleKey, Authorization: `Bearer ${shim.serviceRoleKey}`}});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    const denied = await fetch(path, {headers: {apikey: shim.anonKey, Authorization: `Bearer ${shim.anonKey}`}});
    expect(denied.status).toBe(403);
    const forged = await fetch(path, {headers: {apikey: shim.serviceRoleKey, Authorization: `Bearer ${shim.anonKey}`}});
    expect(forged.status).toBe(403);
  });

  test('device alias lookup reads the canonical empty fixture table with service-role authority only', async () => {
    // remoteDeviceSql defines the table, grants service_role SELECT and enables RLS; this fixture has no aliases.
    const params = new URLSearchParams({canonical_device_id:'eq.f2fd4238-a3cf-48af-9532-052f32612b90',select:'alias_device_id',limit:'500'});
    const path = `${shim.httpUrl}/rest/v1/portmgr_device_identity_aliases?${params}`;
    const allowed = await fetch(path, {headers:{apikey:shim.serviceRoleKey,Authorization:`Bearer ${shim.serviceRoleKey}`}});
    expect(allowed.status).toBe(200); expect(await allowed.json()).toEqual([]);
    for (const headers of [{apikey:shim.anonKey,Authorization:`Bearer ${shim.anonKey}`},
      {apikey:shim.serviceRoleKey,Authorization:`Bearer ${shim.anonKey}`}]) {
      expect((await fetch(path,{headers})).status).toBe(403);
    }
  });

  test('CORS answers the portal origins for the headers supabase-js sends', async () => {
    for (const origin of ['https://portal.test', 'agentstoz-app://portal']) {
      const response = await fetch(`${shim.httpUrl}/rest/v1/rpc/portmgr_is_member`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'apikey, authorization, content-type, x-client-info' },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-headers')).toBe('apikey, authorization, content-type, x-client-info');
    }
  });

  test('stop() leaves redacted relay and dialogue dumps with the insert history and a clean report', async () => {
    report = await shim.stop();
    expect(report.version).toBe(2);
    expect(report.ok).toBe(true);
    expect(report.unknownRoutes).toEqual([]);
    expect(report.rejectedOrigins).toEqual([]);
    expect(report.internalErrors).toEqual([]);
    expect(report.interruptedAtStop).toEqual([]);
    expect(report.stopErrors).toEqual([]);
    expect(report.isolation).toEqual(shim.isolation);
    expect(report.https?.caFingerprintSha256).toBe(shim.ca!.caFingerprintSha256);
    // The superuser-owned definer functions are a counted, named difference from Supabase, not a silent one.
    expect(report.superuserOwnedDefinerFunctions).toBeGreaterThan(0);
    expect(report.knownDifferences.some(entry => /SECURITY DEFINER[\s\S]*superuser[\s\S]*postgres\) is not a superuser/.test(entry))).toBe(true);
    // Per self-check (http, then https): anon refused, the signed-in member refused, the host's own call accepted.
    // The untrusted child never got past TLS, so it left no row.
    expect(report.rpcCalls.portmgr_remote_control_register_host).toEqual({ 'anon:401': 2, 'authenticated:403': 2, 'service_role:200': 2 });
    // Per self-check: outsider and member logouts both took effect; refresh, retry ok, refresh after logout refused.
    expect(report.authEvents).toEqual(expect.arrayContaining([
      { type: 'logout', ok: 4, failed: 0 },
      { type: 'refresh', ok: 4, failed: 2 },
    ]));
    for (const name of [SHIM_RELAY_DUMP_FILE, SHIM_DIALOGUE_DUMP_FILE, SHIM_REPORT_FILE]) {
      const path = join(evidence, name);
      expect(statSync(path).mode & 0o077).toBe(0);
      const text = readFileSync(path, 'utf8');
      for (const secret of [shim.anonKey, shim.serviceRoleKey, 'eyJ']) expect(text.includes(secret)).toBe(false);
    }
    const relay = JSON.parse(readFileSync(join(evidence, SHIM_RELAY_DUMP_FILE), 'utf8'));
    const hosts = relay.tables.portmgr_remote_control_hosts as Record<string, unknown>[];
    expect(hosts.length).toBe(2);
    for (const host of hosts) {
      expect(host.host_secret_hash).toBe('[redacted]');
      expect(host.public_key).toBe('[redacted]');
      expect(host.host_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    for (const message of relay.tables.portmgr_remote_control_messages as Record<string, unknown>[]) {
      expect(message.ciphertext).toBe('[redacted]');
      expect(message.nonce).toBe('[redacted]');
    }
    // The history survives acknowledgement deletes: one row per accepted envelope, never a reused sequence.
    const audit = relay.audit.relay_messages as { relay_seq: number; session_id: string; direction: string; sender_sequence: number }[];
    expect(audit.length).toBeGreaterThanOrEqual(8);
    const seen = new Set(audit.map(row => `${row.session_id}/${row.direction}/${row.sender_sequence}`));
    expect(seen.size).toBe(audit.length);
    expect(audit.map(row => row.relay_seq)).toEqual([...audit.map(row => row.relay_seq)].sort((a, b) => a - b));
    expect(new Set(audit.map(row => row.direction))).toEqual(new Set(['controller_to_host', 'host_to_controller']));
    const dialogue = JSON.parse(readFileSync(join(evidence, SHIM_DIALOGUE_DUMP_FILE), 'utf8'));
    const controls = dialogue.audit.dialogue_controls as { control_id: string; event: string; state: string; request_kind: string; request_id: string }[];
    // Two control calls (http + https self-checks), each inserted once, taken once and answered once —
    // even though the live table clears the request on answer and later deletes the row.
    expect(controls.map(row => `${row.event}:${row.state}`)).toEqual(['insert:pending', 'update:taken', 'update:done', 'insert:pending', 'update:taken', 'update:done']);
    expect(new Set(controls.map(row => row.request_kind))).toEqual(new Set(['projects']));
    expect(new Set(controls.map(row => row.request_id)).size).toBe(2);
    expect(await shim.stop()).toBe(report);
  }, SHIM_TIMEOUT_MS);
});

describe.skipIf(process.platform === 'win32')('GoTrue subset', () => {
  let shim: SupabaseShim;
  let clock = Date.now();
  const at = (seconds: number) => { clock = start + seconds * 1000; };
  const start = clock;

  beforeAll(async () => {
    shim = await startSupabaseShim({ scratchDir: join(scratch('gotrue'), 'shim'), https: false, runId: 'unit-gotrue', now: () => clock });
  }, SHIM_TIMEOUT_MS);
  afterAll(async () => {
    const report = await shim?.stop();
    expect(report?.ok).toBe(true);
  }, SHIM_TIMEOUT_MS);

  test('refresh follows GoTrue: a retry gets the active token back, reuse inside the interval swaps, past it the family is revoked', async () => {
    const auth = goTrue(shim.httpUrl!, shim.anonKey);
    at(0);
    const a = await auth.signIn('owner@emulator.test', shim.otpCode);
    at(1);
    const b = await auth.refresh(a.refresh_token);
    expect(b.status).toBe(200);
    expect(b.body!.refresh_token).not.toBe(a.refresh_token);
    // The client lost B's response and retries with A: GoTrue returns B (still the active token), not an error.
    at(2);
    const retried = await auth.refresh(a.refresh_token);
    expect({ status: retried.status, token: retried.body!.refresh_token === b.body!.refresh_token }).toEqual({ status: 200, token: true });
    expect(await auth.user(retried.body!.access_token)).toBe('live');
    at(3);
    const c = await auth.refresh(b.body!.refresh_token);
    expect(c.status).toBe(200);
    // A is used and not C's parent, but A was used 3 s ago: inside the 10 s reuse interval it is still swapped.
    at(4);
    const d = await auth.refresh(a.refresh_token);
    expect(d.status).toBe(200);
    expect(new Set([a.refresh_token, b.body!.refresh_token, c.body!.refresh_token, d.body!.refresh_token]).size).toBe(4);
    // B was used at 3 s; at 20 s that is past the interval: every refresh token of the session is revoked …
    at(20);
    expect(await auth.refresh(b.body!.refresh_token)).toMatchObject({ status: 400, body: { code: 'refresh_token_already_used' } });
    // … but the session stays, so an access token already issued keeps working until it expires (as in GoTrue).
    expect(await auth.user(d.body!.access_token)).toBe('live');
    at(40);
    expect(await auth.refresh(d.body!.refresh_token)).toMatchObject({ status: 400, body: { code: 'refresh_token_already_used' } });
    expect(await auth.refresh('never-issued')).toMatchObject({ status: 400, body: { code: 'refresh_token_not_found' } });
  }, SHIM_TIMEOUT_MS);

  test('each swap of a used refresh token restarts its reuse interval, as GoTrue writes updated_at on every swap', async () => {
    const auth = goTrue(shim.httpUrl!, shim.anonKey);
    // A fresh session; the clock runs from 50 s so nothing from the previous test is in any interval.
    at(50);
    const a = await auth.signIn('owner@emulator.test', shim.otpCode);
    at(51);
    const b = await auth.refresh(a.refresh_token); // A first used at 51 s
    expect(b.status).toBe(200);
    at(52);
    expect((await auth.refresh(b.body!.refresh_token)).status).toBe(200); // the active token is no longer A's child
    // A reused at 58 s, inside 51 + 10: swapped, and A's interval now runs from 58 s.
    at(58);
    const d = await auth.refresh(a.refresh_token);
    expect(d.status).toBe(200);
    at(59);
    expect((await auth.refresh(d.body!.refresh_token)).status).toBe(200); // again so the retry branch cannot answer
    // A reused at 65 s: past 51 + 10 but inside 58 + 10, so GoTrue still swaps it (a fixed window would revoke).
    at(65);
    const f = await auth.refresh(a.refresh_token);
    expect(f.status).toBe(200);
    expect(f.body!.refresh_token).not.toBe(d.body!.refresh_token);
    at(66);
    expect((await auth.refresh(f.body!.refresh_token)).status).toBe(200);
    // Past 65 + 10 the reuse is refused and every refresh token of the session is revoked; the session stays.
    at(76);
    expect(await auth.refresh(a.refresh_token)).toMatchObject({ status: 400, body: { code: 'refresh_token_already_used' } });
    expect(await auth.user(f.body!.access_token)).toBe('live');
  }, SHIM_TIMEOUT_MS);

  test('logout deletes exactly the sessions its scope names, and their refresh tokens', async () => {
    const auth = goTrue(shim.httpUrl!, shim.anonKey);
    at(100);
    const [s1, s2, s3] = [await auth.signIn('owner@emulator.test', shim.otpCode), await auth.signIn('owner@emulator.test', shim.otpCode), await auth.signIn('owner@emulator.test', shim.otpCode)];
    const outsider = await auth.signIn('outsider@emulator.test', shim.otpCode);
    for (const session of [s1, s2, s3, outsider]) expect(await auth.user(session.access_token)).toBe('live');

    expect(await auth.logout(s1.access_token, 'local')).toBe(204);
    expect([await auth.user(s1.access_token), await auth.user(s2.access_token), await auth.user(s3.access_token)]).toEqual(['403/session_not_found', 'live', 'live']);
    expect(await auth.refresh(s1.refresh_token)).toMatchObject({ status: 400, body: { code: 'refresh_token_not_found' } });

    expect(await auth.logout(s2.access_token, 'others')).toBe(204);
    expect([await auth.user(s2.access_token), await auth.user(s3.access_token), await auth.user(outsider.access_token)]).toEqual(['live', '403/session_not_found', 'live']);

    expect(await auth.logout(s2.access_token)).toBe(204); // default scope: global
    expect(await auth.user(s2.access_token)).toBe('403/session_not_found');
    expect(await auth.user(outsider.access_token)).toBe('live');
    // Logging out a session that no longer exists is refused, the way auth-js then ignores it.
    expect(await auth.logout(s2.access_token)).toBe('403/session_not_found');
    expect(shim.authEvents().filter(event => event.type === 'logout').map(event => event.ok)).toEqual([true, true, true, false]);
  }, SHIM_TIMEOUT_MS);
});

describe.skipIf(process.platform === 'win32')('strictness', () => {
  test('unknown routes, unsupported features, unemulated CORS headers and foreign origins are refused and fail the report', async () => {
    const root = scratch('strict');
    const shim = await startSupabaseShim({ scratchDir: root, https: false, runId: 'unit-strict' });
    try {
      const base = shim.httpUrl!;
      const key = { apikey: shim.anonKey, Authorization: `Bearer ${shim.anonKey}`, 'Content-Type': 'application/json' };
      const preflight = (headers: string) => ({ method: 'OPTIONS', headers: { Origin: 'https://portal.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': headers } });
      const probes: [string, RequestInit][] = [
        ['/rest/v1/portmgr_ports?select=*', { headers: key }],
        ['/rest/v1/portmgr_what_i_said_memory_policy?select=*', { headers: {apikey: shim.serviceRoleKey} }],
        ['/rest/v1/portmgr_device_identity_aliases?select=*', { headers: {apikey: shim.serviceRoleKey} }],
        ['/rest/v1/rpc/portmgr_is_member', { headers: key }],
        ['/rest/v1/rpc/portmgr_is_member?select=x', { method: 'POST', headers: key, body: '{}' }],
        ['/rest/v1/rpc/portmgr_is_member', { method: 'POST', headers: { ...key, Prefer: 'count=exact' }, body: '{}' }],
        ['/auth/v1/token?grant_type=password', { method: 'POST', headers: key, body: '{}' }],
        ['/auth/v1/otp', { method: 'POST', headers: key, body: JSON.stringify({ phone: '+15555550100' }) }],
        ['/auth/v1/otp', { method: 'POST', headers: key, body: JSON.stringify({ email: 'new@emulator.test', create_user: true }) }],
        ['/auth/v1/verify', { method: 'POST', headers: key, body: JSON.stringify({ type: 'magiclink', token_hash: 'x' }) }],
        ['/auth/v1/settings', { headers: key }],
        ['/storage/v1/object/voc/x', { method: 'POST', headers: key, body: 'x' }],
        ['/realtime/v1/websocket?apikey=secret', { headers: key }],
        ['/functions/v1/voc', { method: 'POST', headers: key, body: '{}' }],
        // A browser would fail these with a bare CORS error; the shim must say what it did not emulate.
        ['/rest/v1/rpc/portmgr_is_member', preflight('apikey, x-evil')],
        ['/rest/v1/rpc/portmgr_is_member', preflight('apikey, prefer')],
      ];
      for (const [path, init] of probes) {
        const response = await fetch(base + path, init);
        expect({ path, status: response.status, code: ((await response.json()) as { code?: string }).code })
          .toEqual({ path, status: 404, code: 'SHIM_UNKNOWN_ROUTE' });
      }
      const unknown = shim.unknownRoutes();
      expect(unknown).toHaveLength(probes.length);
      expect(unknown.slice(-2).map(entry => entry.reason)).toEqual([
        'preflight asks for unemulated request header(s) x-evil',
        'preflight asks for unemulated request header(s) prefer',
      ]);
      // Only parameter names are kept — never a value that might be a token.
      expect(unknown.find(entry => entry.path === '/realtime/v1/websocket')?.queryKeys).toEqual(['apikey']);
      expect(JSON.stringify(unknown)).not.toContain('secret');

      const foreign = await fetch(`${base}/rest/v1/rpc/portmgr_is_member`, { method: 'POST', headers: { ...key, Origin: 'http://localhost:5173' }, body: '{}' });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
      expect(shim.rejectedOrigins()).toMatchObject([{ origin: 'http://localhost:5173' }]);
      // A real function with argument names nobody declared is PostgREST's "not found", not a shim gap.
      const wrongArgs = await fetch(`${base}/rest/v1/rpc/portmgr_is_member`, { method: 'POST', headers: key, body: JSON.stringify({ p_nope: 1 }) });
      expect(wrongArgs.status).toBe(404);
      expect(((await wrongArgs.json()) as { code?: string }).code).toBe('PGRST202');
      expect(shim.unknownRoutes()).toHaveLength(probes.length);
      const report = shim.report();
      expect(report.ok).toBe(false);
      expect(report.unknownRoutes).toHaveLength(probes.length);
    } finally {
      await shim.stop();
    }
  }, SHIM_TIMEOUT_MS);

  test('the CLI prints no secrets, writes evidence and exits 3 after an unknown route', async () => {
    const root = scratch('cli');
    const home = join(root, 'home');
    const served = await startServeChild(['--scratch', join(root, 'shim'), '--evidence', join(root, 'evidence'), '--run-id', 'unit-cli', '--https-port', '0'], allowlistedEnv(home), home);
    try {
      const { ready, buffered } = served;
      expect(ready.event).toBe('ready');
      expect(ready.httpsUrl).toMatch(/^https:\/\/localhost:\d+$/);
      expect(ready.isolation.status).toBe(process.platform === 'darwin' ? 'not-sandboxed' : 'unknown');
      const credentials = JSON.parse(readFileSync(ready.credentialsPath, 'utf8')) as SupabaseShimCredentials;
      expect(statSync(ready.credentialsPath).mode & 0o077).toBe(0);
      expect(ready.credentialsPath).toBe(join(root, 'shim', SHIM_CREDENTIALS_FILE));
      for (const secret of [credentials.anonKey, credentials.serviceRoleKey, credentials.otpCode]) expect(buffered.includes(secret)).toBe(false);
      const response = await fetch(`${ready.httpUrl}/rest/v1/portmgr_ports`, { headers: { apikey: credentials.anonKey } });
      expect(response.status).toBe(404);
      served.child.kill('SIGTERM');
      const rest = await served.drain();
      expect(await served.child.exited).toBe(SHIM_EXIT_UNSUPPORTED);
      const stopped = lastJsonLine<{ event: string; ok: boolean; unknownRoutes: number; stopErrors: string[] }>(rest);
      expect(stopped).toMatchObject({ event: 'stopped', ok: false, unknownRoutes: 1, stopErrors: [] });
      const report = JSON.parse(readFileSync(join(root, 'evidence', SHIM_REPORT_FILE), 'utf8')) as SupabaseShimReport;
      expect(report.unknownRoutes).toMatchObject([{ method: 'GET', path: '/rest/v1/portmgr_ports' }]);
      expect(existsSync(join(root, 'evidence', SHIM_RELAY_DUMP_FILE))).toBe(true);
      for (const secret of [credentials.anonKey, credentials.serviceRoleKey]) expect(readFileSync(join(root, 'evidence', SHIM_REPORT_FILE), 'utf8').includes(secret)).toBe(false);
    } finally {
      served.dispose();
      await served.child.exited;
    }
  }, SHIM_TIMEOUT_MS);

  test('the CLI exits 2 on every usage error and refused environment, before starting anything', async () => {
    const root = scratch('usage');
    const home = join(root, 'home');
    const env = allowlistedEnv(home);
    const blocked = unCreatableUnder(root);
    const cases: [string, string[], Record<string, string>][] = [
      ['missing --scratch', ['serve'], env],
      ['relative --scratch', ['serve', '--scratch', 'relative/dir'], env],
      ['non-numeric --https-port', ['serve', '--scratch', blocked, '--https-port', 'abc'], env],
      ['reserved --https-port', ['serve', '--scratch', blocked, '--https-port', String(SHIM_RESERVED_PORTS[2])], env],
      ['unknown flag', ['serve', '--scratch', blocked, '--bogus'], env],
      ['trailing argument', ['serve', '--scratch', blocked, 'extra'], env],
      ['repeated --scratch', ['serve', '--scratch', blocked, '--scratch', blocked], env],
      ['flag without value', ['serve', '--scratch'], env],
      ['no door left', ['serve', '--scratch', blocked, '--no-http', '--no-https'], env],
      ['selfcheck without arguments', ['client-selfcheck'], env],
      ['selfcheck with a relative app-data', ['client-selfcheck', '--credentials', join(root, 'none.json'), '--door', 'http', '--app-data', 'rel'], env],
      ['unknown command', ['bogus'], env],
      ['forbidden environment key', ['serve', '--scratch', blocked], { ...env, CODEX_HOME: join(root, 'codex') }],
      ['forbidden environment prefix', ['serve', '--scratch', blocked], { ...env, SUPABASE_URL: 'https://shim.invalid' }],
      // Bun writes its transpiler cache under $HOME/Library/Caches/bun before any script line runs (measured
      // 2026-11-01); turning that cache off keeps this probe from creating anything under the real home.
      ['HOME under the real home', ['serve', '--scratch', blocked], { ...env, HOME: join(shimRealHome(), `.atz-shim-guard-probe-${randomUUID()}`), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }],
      ['TMPDIR under the real home', ['serve', '--scratch', blocked], { ...env, TMPDIR: join(shimRealHome(), `.atz-shim-guard-probe-${randomUUID()}`) }],
    ];
    const outcomes: Record<string, unknown> = {};
    for (const [label, args, childEnv] of cases) {
      const outcome = await runChild(args, childEnv, home, 30_000);
      outcomes[label] = { code: outcome.code, event: outcome.stderr.includes('"usage-error"') ? 'usage-error' : outcome.stderr.slice(0, 200), stdout: outcome.stdout };
    }
    expect(outcomes).toEqual(Object.fromEntries(cases.map(([label]) => [label, { code: SHIM_EXIT_USAGE, event: 'usage-error', stdout: '' }])));
    // Nothing was created where the refused HOME or TMPDIR pointed.
    for (const [, , childEnv] of cases.slice(-2)) for (const key of ['HOME', 'TMPDIR']) if (childEnv[key]!.includes('.atz-shim-guard-probe-')) expect(existsSync(childEnv[key]!)).toBe(false);
  }, SHIM_TIMEOUT_MS);

  test('the https door prefers its fixed port and records why it fell back', async () => {
    const blocker = net.createServer();
    await new Promise<void>(done => blocker.listen({ host: '127.0.0.1', port: 0, exclusive: true }, done));
    const taken = (blocker.address() as net.AddressInfo).port;
    const root = scratch('fallback');
    try {
      const shim = await startSupabaseShim({ scratchDir: join(root, 'a'), http: false, https: { preferredPort: taken } });
      try {
        expect(shim.httpsPort).not.toBe(taken);
        expect(shim.httpsFallback).toBe(`EADDRINUSE binding 127.0.0.1:${taken}`);
        expect(shim.report().https).toMatchObject({ preferredPort: taken, fallback: `EADDRINUSE binding 127.0.0.1:${taken}` });
      } finally { await shim.stop(); }
      await expect(startSupabaseShim({ scratchDir: join(root, 'b'), http: false, https: { preferredPort: taken, requirePreferredPort: true } }))
        .rejects.toThrow(`https door needs port ${taken}: EADDRINUSE`);
    } finally {
      await new Promise<void>(done => blocker.close(() => done()));
    }
  }, SHIM_TIMEOUT_MS);

  test('stop() waits for a request that was still running and keeps it in the report', async () => {
    const shim = await startSupabaseShim({ scratchDir: join(scratch('drain'), 'shim'), https: false, runId: 'unit-drain' });
    let pending: Promise<unknown> | null = null;
    try {
      // A body that never ends keeps the handler waiting inside the shim when stop() closes the door.
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"p_never_finished":')); } });
      pending = fetch(`${shim.httpUrl}/rest/v1/rpc/portmgr_is_member`, {
        method: 'POST', headers: { apikey: shim.anonKey, 'Content-Type': 'application/json' }, body, duplex: 'half',
      } as RequestInit).catch(error => error);
      const deadline = Date.now() + 20_000;
      while (shim.inFlight() !== 1 && Date.now() < deadline) await Bun.sleep(10);
      expect(shim.inFlight()).toBe(1);
      const report = await shim.stop();
      expect(shim.inFlight()).toBe(0);
      expect(report.requestCount).toBe(1);
      expect(report.interruptedAtStop).toMatchObject([{ door: 'http', method: 'POST', path: '/rest/v1/rpc/portmgr_is_member' }]);
      // Cut off by our own stop: recorded, not an internal error, and not a failed run.
      expect({ ok: report.ok, internalErrors: report.internalErrors, stopErrors: report.stopErrors }).toEqual({ ok: true, internalErrors: [], stopErrors: [] });
    } finally {
      await shim.stop();
      await pending;
    }
  }, SHIM_TIMEOUT_MS);

  test('an evidence folder that cannot be written fails the report instead of rejecting stop()', async () => {
    const root = scratch('evidence-lib');
    const evidence = join(root, 'evidence');
    const shim = await startSupabaseShim({ scratchDir: join(root, 'shim'), evidenceDir: evidence, https: false, runId: 'unit-evidence' });
    expect(statSync(evidence).isDirectory()).toBe(true); // created at start, so a bad path fails fast
    chmodSync(evidence, 0o500);
    try {
      const report = await shim.stop();
      expect(report.ok).toBe(false);
      expect(report.stopErrors).toHaveLength(2);
      expect(report.stopErrors[0]).toMatch(/^evidence dumps not written: .*(EACCES|permission denied)/i);
      expect(report.stopErrors[1]).toMatch(/^evidence report not written: .*(EACCES|permission denied)/i);
    } finally {
      chmodSync(evidence, 0o700);
    }
  }, SHIM_TIMEOUT_MS);

  test('the CLI arms SIGTERM before startup: a signal during startup still stops cleanly and writes evidence', async () => {
    // Regression: the handlers used to be registered after the ready line, so a SIGTERM in that window took the
    // default action (exit 143, no evidence). Startup (PGlite + schema) takes seconds, so this signal lands in it.
    const root = scratch('early-signal');
    const home = join(root, 'home');
    const evidence = join(root, 'evidence');
    const served = await startServeChild(['--scratch', join(root, 'shim'), '--evidence', evidence, '--no-https'], allowlistedEnv(home), home, 'starting');
    try {
      expect(served.events).toEqual(['starting']);
      served.child.kill('SIGTERM');
      const rest = await served.drain();
      expect(await served.child.exited).toBe(0);
      const stopped = lastJsonLine<{ event: string; why: string; ok: boolean; requestCount: number }>(rest);
      expect(stopped).toMatchObject({ event: 'stopped', why: 'SIGTERM', ok: true, requestCount: 0 });
      const report = JSON.parse(readFileSync(join(evidence, SHIM_REPORT_FILE), 'utf8')) as SupabaseShimReport;
      expect(report.ok).toBe(true);
    } finally {
      served.dispose();
      await served.child.exited;
    }
  }, SHIM_TIMEOUT_MS);

  test('the CLI exits 4, not with an unhandled rejection, when its evidence cannot be written', async () => {
    const root = scratch('evidence-cli');
    const home = join(root, 'home');
    const evidence = join(root, 'evidence');
    const served = await startServeChild(['--scratch', join(root, 'shim'), '--evidence', evidence, '--no-https'], allowlistedEnv(home), home);
    try {
      chmodSync(evidence, 0o500);
      served.child.kill('SIGTERM');
      const rest = await served.drain();
      expect(await served.child.exited).toBe(SHIM_EXIT_STOP_FAILED);
      const stopped = lastJsonLine<{ event: string; ok: boolean; stopErrors: string[] }>(rest);
      expect(stopped.event).toBe('stopped');
      expect(stopped.ok).toBe(false);
      expect(stopped.stopErrors).toHaveLength(2);
    } finally {
      chmodSync(evidence, 0o700);
      served.dispose();
      await served.child.exited;
    }
  }, SHIM_TIMEOUT_MS);

  test('evidence redaction removes secrets at any depth and embedded tokens', () => {
    expect(redactForEvidence({
      host_id: 'h', host_secret_hash: 'abc', nested: { request: { sessionToken: 't', kind: 'projects', requestId: 'r' } },
      url: 'https://portal.test/remote/#pair=abc', jwt: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.x', list: [{ public_key: 'k' }], keep: 3,
    })).toEqual({
      host_id: 'h', host_secret_hash: '[redacted]', nested: { request: { sessionToken: '[redacted]', kind: 'projects', requestId: 'r' } },
      url: '[redacted]', jwt: '[redacted]', list: [{ public_key: '[redacted]' }], keep: 3,
    });
  });
});

describe.skipIf(process.platform === 'win32')('guards', () => {
  test('PostgREST status table: exact codes before their class, PTxyz custom statuses', () => {
    const table: [string, 'anon' | 'authenticated', number][] = [
      ['42501', 'anon', 401], ['42501', 'authenticated', 403], ['42883', 'anon', 404], ['42P01', 'anon', 404], ['42P17', 'anon', 500],
      ['23503', 'anon', 409], ['23505', 'anon', 409], ['25006', 'anon', 405], ['25001', 'anon', 500], ['P0001', 'anon', 400], ['P0002', 'anon', 500],
      // The canonical SQL raises 54000 (REMOTE_CONTROL_SESSION_LIMIT) and 53400: PostgREST answers 500 for both.
      ['54000', 'anon', 500], ['54001', 'anon', 500], ['53400', 'anon', 500], ['53000', 'anon', 503], ['53100', 'anon', 503],
      ['08006', 'anon', 503], ['0L000', 'anon', 403], ['0P000', 'anon', 403], ['28000', 'anon', 403], ['28P01', 'anon', 403],
      ['09000', 'anon', 500], ['2D000', 'anon', 500], ['38000', 'anon', 500], ['39000', 'anon', 500], ['3B000', 'anon', 500], ['40001', 'anon', 500],
      ['55000', 'anon', 500], ['57014', 'anon', 500], ['58000', 'anon', 500], ['F0000', 'anon', 500], ['HV000', 'anon', 500], ['XX000', 'anon', 500],
      ['PT402', 'anon', 402], ['PT418', 'authenticated', 418], ['22023', 'anon', 400], ['23514', 'anon', 400], ['42P10', 'anon', 400],
    ];
    expect(table.map(([code, role]) => [code, role, postgrestHttpStatus(code, role)])).toEqual(table);
  });

  test('path rules: scratch and app data outside the real home, evidence outside protected folders (fake home)', () => {
    const root = scratch('paths');
    const home = join(root, 'Users', 'someone');
    mkdirSync(join(home, 'Library', 'Application Support', 'com.portmanager.portmanager'), { recursive: true });
    const outside = join(root, 'outside');
    const base = { scratchDir: join(outside, 'scratch') };
    expect(() => validateSupabaseShimOptions(base, home)).not.toThrow();
    expect(() => validateSupabaseShimOptions({ ...base, evidenceDir: join(home, 'agentstoz-emulator', 'run', 'evidence') }, home)).not.toThrow();
    expect(() => validateSupabaseShimOptions({ scratchDir: join(home, 'scratch') }, home)).toThrow('inside the real home');
    for (const protectedDir of [join(home, 'Library', 'Application Support', 'com.portmanager.portmanager', 'x'), join(home, '.claude', 'x'), join(home, '.codex'), join(home, 'Library', 'Keychains', 'x')]) {
      expect(() => validateSupabaseShimOptions({ ...base, evidenceDir: protectedDir }, home)).toThrow('inside a protected real folder');
    }
    // A symlink into the home does not hide it.
    symlinkSync(home, join(root, 'link-to-home'));
    expect(() => validateSupabaseShimOptions({ scratchDir: join(root, 'link-to-home', 'scratch') }, home)).toThrow('inside the real home');
    const credentials = { http: { url: 'http://127.0.0.1:54321' }, https: null } as unknown as SupabaseShimCredentials;
    expect(() => validateShimSelfcheckInput({ credentials, door: 'http', appDataDir: join(outside, 'app-data') }, home)).not.toThrow();
    expect(() => validateShimSelfcheckInput({ credentials, door: 'http', appDataDir: join(home, 'Library', 'Application Support', 'com.portmanager.portmanager') }, home)).toThrow('inside the real home');
  });

  test('ports 3001, 52741 and 4723 are refused on both doors (fake home)', () => {
    const home = join(scratch('ports'), 'home');
    const scratchDir = join(dirname(home), 'scratch');
    for (const port of [3001, 52741, 4723]) {
      expect(() => validateSupabaseShimOptions({ scratchDir, http: { port } }, home)).toThrow(`reserved port ${port}`);
      expect(() => validateSupabaseShimOptions({ scratchDir, http: false, https: { preferredPort: port } }, home)).toThrow(`reserved port ${port}`);
      expect(() => serveOptionsFromArgv(['--scratch', scratchDir, '--https-port', String(port)])).toThrow(`reserved port ${port}`);
    }
    expect(() => validateSupabaseShimOptions({ scratchDir, http: { port: 54321 }, https: { preferredPort: 443 } }, home)).not.toThrow();
  });

  test('startSupabaseShim and the self-check apply the guards before creating, binding or fetching anything', async () => {
    const root = scratch('wiring');
    // Each refused path has a regular file as parent: if a guard regressed, creating it would fail with ENOTDIR.
    await expect(startSupabaseShim({ scratchDir: unCreatableUnder(root), http: { port: 3001 } })).rejects.toThrow('reserved port 3001');
    await expect(startSupabaseShim({ scratchDir: unCreatableUnder(root), http: false, https: { preferredPort: 52741 } })).rejects.toThrow('reserved port 52741');
    await expect(startSupabaseShim({ scratchDir: unCreatableUnder(root), evidenceDir: join(shimRealHome(), '.claude', `atz-shim-guard-probe-${randomUUID()}`) }))
      .rejects.toThrow('inside a protected real folder');
    if (realpathSync(import.meta.path).startsWith(`${realpathSync(shimRealHome())}/`)) {
      // This test file lives under the real home here: a folder "inside" it is under the home and cannot be created.
      await expect(startSupabaseShim({ scratchDir: join(import.meta.path, 'scratch') })).rejects.toThrow('inside the real home');
      const credentials = { http: { url: 'http://127.0.0.1:54321' }, https: null, users: [{ email: 'owner@emulator.test', member: true }] } as unknown as SupabaseShimCredentials;
      await expect(runShimClientSelfcheck({ credentials, door: 'http', appDataDir: join(import.meta.path, 'app-data') })).rejects.toThrow('inside the real home');
    }
    // Non-loopback, reserved and malformed doors are refused before the first request (.invalid never resolves anyway).
    for (const url of ['https://production-supabase.invalid', 'https://shim.invalid', 'http://192.0.2.1:54321', 'https://127.0.0.1.shim.invalid', 'http://localhost:3001', 'https://localhost:52741', 'http://127.0.0.1:54321/rest/v1']) {
      const door = url.startsWith('https:') ? 'https' : 'http';
      const credentials = { [door]: { url }, users: [{ email: 'owner@emulator.test', member: true }] } as unknown as SupabaseShimCredentials;
      await expect(runShimClientSelfcheck({ credentials, door, appDataDir: unCreatableUnder(root, 'app-data') })).rejects.toThrow('supabase shim self-check: refusing');
    }
    expect(assertLoopbackShimUrl('http://127.0.0.1:54321', 'http').origin).toBe('http://127.0.0.1:54321');
    expect(assertLoopbackShimUrl('http://[::1]:54321', 'http').origin).toBe('http://[::1]:54321');
    expect(assertLoopbackShimUrl('https://localhost', 'https').origin).toBe('https://localhost');
  }, SHIM_TIMEOUT_MS);

  test('the CLI environment rule refuses forbidden keys and a real HOME, TMPDIR or app-data folder (fake home)', () => {
    const root = scratch('env');
    const home = join(root, 'real-home');
    const ok = { PATH: '/usr/bin:/bin', HOME: join(root, 'child-home'), TMPDIR: join(root, 'child-home', 'tmp'), NODE_ENV: 'test' };
    expect(() => assertIsolatedShimEnvironment(ok, home)).not.toThrow();
    expect(() => assertIsolatedShimEnvironment({ ...ok, CODEX_HOME: '/x', PORTMGR_FOO: '1', VITE_SUPABASE_URL: 'x' }, home)).toThrow('forbidden environment keys: CODEX_HOME, PORTMGR_FOO, VITE_SUPABASE_URL');
    expect(() => assertIsolatedShimEnvironment({ ...ok, HOME: join(home, 'x') }, home)).toThrow('HOME');
    expect(() => assertIsolatedShimEnvironment({ ...ok, TMPDIR: join(home, 'tmp') }, home)).toThrow('TMPDIR');
    expect(() => assertIsolatedShimEnvironment({ ...ok, APP_DATA_DIR: join(home, 'Library', 'Application Support', 'com.portmanager.portmanager') }, home)).toThrow('app-data');
    expect(() => assertIsolatedShimEnvironment({ ...ok, HOME: '' }, home)).toThrow('HOME must be');
  });

  test('isolation is measured by the kernel: a child under sandbox-exec reports "sandboxed"', async () => {
    if (process.platform !== 'darwin') return;
    const root = scratch('isolation');
    const probe = join(root, 'probe.ts');
    writeFileSync(probe, `import { measureShimIsolation } from ${JSON.stringify(resolve(import.meta.dir, '../scripts/emulator-e2e/supabaseShim.ts'))};\nconsole.log(JSON.stringify(measureShimIsolation()));\n`);
    const run = async (command: string[]) => {
      const child = Bun.spawn(command, { cwd: root, env: allowlistedEnv(join(root, 'home')), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { code, isolation: lastJsonLine<Record<string, unknown>>(stdout) };
    };
    const bun = [process.execPath, '--env-file=/dev/null', probe];
    // A permissive profile: the point is only that the kernel reports a sandbox, which the shim then passes on.
    expect(await run(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', ...bun])).toEqual({ code: 0, isolation: { status: 'sandboxed', processSandboxed: true, method: 'sandbox_check' } });
    expect(await run(bun)).toEqual({ code: 0, isolation: { status: 'not-sandboxed', processSandboxed: false, method: 'sandbox_check' } });
  }, SHIM_TIMEOUT_MS);

  test('flag parsing is strict', () => {
    expect([...parseShimFlags(['--member', 'a@b.test', '--member', 'c@d.test', '--no-https'], { '--member': 'multi', '--no-https': 'switch' })])
      .toEqual([['--member', ['a@b.test', 'c@d.test']], ['--no-https', ['true']]]);
    expect(() => parseShimFlags(['--x', '1'], {})).toThrow('unknown flag --x');
    expect(() => parseShimFlags(['positional'], {})).toThrow('unexpected argument');
    expect(() => parseShimFlags(['--a'], { '--a': 'value' })).toThrow('--a needs a value');
    expect(() => parseShimFlags(['--a', '--b'], { '--a': 'value', '--b': 'switch' })).toThrow('--a needs a value');
    expect(() => parseShimFlags(['--a', '1', '--a', '2'], { '--a': 'value' })).toThrow('--a given twice');
  });
});

describe.skipIf(process.platform === 'win32')('harness host (ctx.startSupabaseShim)', () => {
  test('exit codes, serve arguments and the ready line are checked the way the shim defines them', () => {
    expect(SUPABASE_SHIM_EXIT).toEqual({ clean: 0, usage: SHIM_EXIT_USAGE, unsupported: SHIM_EXIT_UNSUPPORTED, stopFailed: SHIM_EXIT_STOP_FAILED });
    const base = { scratchDir: '/s', evidenceDir: '/e', runId: 'r' };
    expect(supabaseShimServeArgs(base)).toEqual(['serve', '--scratch', '/s', '--evidence', '/e', '--run-id', 'r', '--https-port', '0']);
    expect(supabaseShimServeArgs({ ...base, members: ['a@b.test'], outsiders: ['c@d.test'], httpsPort: 443, requireHttpsPort: true }))
      .toEqual(['serve', '--scratch', '/s', '--evidence', '/e', '--run-id', 'r', '--member', 'a@b.test', '--outsider', 'c@d.test', '--https-port', '443', '--require-https-port']);
    expect(supabaseShimServeArgs({ ...base, https: false })).toEqual(['serve', '--scratch', '/s', '--evidence', '/e', '--run-id', 'r', '--no-https']);
    // The serve parser accepts exactly what the harness passes.
    expect(serveOptionsFromArgv(supabaseShimServeArgs({ scratchDir: '/private/tmp/x', evidenceDir: '/private/tmp/y', runId: 'r.lbl', members: ['a@b.test'] }).slice(1)).https)
      .toEqual({ preferredPort: 0, requirePreferredPort: false });
    expect(() => supabaseShimServeArgs({ ...base, https: false, httpsPort: 443 })).toThrow('contradict');
    expect(() => supabaseShimServeArgs({ ...base, http: false, https: false })).toThrow('no door');

    const ready = { event: 'ready', runId: 'r', pid: 42, httpUrl: 'http://127.0.0.1:50001', httpsUrl: 'https://localhost:50002', httpsPort: 50002,
      httpsFallback: null, caCertPath: '/s/ca/ca.pem', caFingerprintSha256: 'ab', credentialsPath: '/s/supabase-shim.json', isolation: { status: 'sandboxed', processSandboxed: true, method: 'sandbox_check' } };
    expect(parseShimReady(ready).loopbackPorts).toEqual([50001, 50002]);
    expect(() => parseShimReady({ ...ready, httpUrl: 'http://192.168.0.2:50001' })).toThrow('non-loopback');
    expect(() => parseShimReady({ ...ready, httpUrl: `http://127.0.0.1:${SHIM_RESERVED_PORTS[0]}` })).toThrow('reserved port');
    expect(() => parseShimReady({ ...ready, httpUrl: null, httpsUrl: null })).toThrow('no door');
    expect(() => parseShimReady({ ...ready, credentialsPath: 'relative.json' })).toThrow('credentialsPath');

    const sandboxed = { isolation: { status: 'sandboxed' as const, processSandboxed: true, method: 'sandbox_check' as const } };
    const clean = { exitCode: 0, signalCode: null, stopped: { event: 'stopped' }, forced: false };
    expect(shimProblems(sandboxed, clean)).toEqual([]);
    expect(shimProblems(sandboxed, null)).toEqual(['still running']);
    expect(shimProblems({ isolation: { status: 'not-sandboxed', processSandboxed: false, method: 'sandbox_check' } }, clean)[0]).toContain('not-sandboxed');
    expect(shimProblems(sandboxed, { ...clean, exitCode: SHIM_EXIT_UNSUPPORTED, stopped: { event: 'stopped', unknownRoutes: 1, rejectedOrigins: 0, internalErrors: 0 } }))
      .toEqual(['exited 3: unknown routes, rejected origins or internal errors were seen (unknown routes 1, rejected origins 0, internal errors 0)']);
    expect(shimProblems(sandboxed, { exitCode: null, signalCode: 'SIGKILL', stopped: null, forced: true })).toEqual(['did not stop within the grace period (SIGKILL)', 'exited SIGKILL: killed by SIGKILL']);
  });

  test('refuses a LAN inbound profile, a bad label and an evidence folder that already exists, before spawning', async () => {
    const root = scratch('host-refusals');
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });
    const input: SandboxProfileInput = { writableRoots: [work] };
    const plain = writeSandboxProfile(join(root, 'sandbox'), 'plain', input);
    const lan = writeSandboxProfile(join(root, 'sandbox'), 'lan', { ...input, lanInbound: { port: 45_341 } });
    const base = { repoRoot: resolve(import.meta.dir, '..'), env: {}, scratchDir: join(work, 'shim'), runId: 'r', label: 'supabase' };
    await expect(startSupabaseShimHost({ ...base, profile: lan, evidenceDir: join(work, 'e1') })).rejects.toThrow('without lanInbound');
    await expect(startSupabaseShimHost({ ...base, profile: plain, label: 'Bad Label', evidenceDir: join(work, 'e2') })).rejects.toThrow('label');
    mkdirSync(join(work, 'e3'));
    await expect(startSupabaseShimHost({ ...base, profile: plain, evidenceDir: join(work, 'e3') })).rejects.toThrow('already exists');
    expect(existsSync(join(work, 'shim'))).toBe(false);
  }, SHIM_TIMEOUT_MS);

  test('runs sandboxed under the WP1 profile; the lane scope stops it and a dirty exit fails the lane whatever it returned', async () => {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
    const root = scratch('host');
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });
    const profileDir = join(root, 'sandbox');
    const input: SandboxProfileInput = { writableRoots: [work] };
    const logs: string[] = [];
    const hosts = new LaneHosts({ profileDir, hostProfileInput: input, hostSandbox: writeSandboxProfile(profileDir, 'host', input), en0PrivateIpv4: null, log: line => logs.push(line) });
    const start = (label: string) => {
      const isolated = createIsolatedProfile(work, `shim-${label}`);
      return hosts.startSupabaseShim({
        repoRoot: resolve(import.meta.dir, '..'), runId: 'test-run', label, profile: writeSandboxProfile(profileDir, `host-${label}`, input),
        env: buildAllowlistedEnv({ home: realHome(), profile: isolated }), scratchDir: join(isolated.root, 'shim'), evidenceDir: join(work, 'evidence', label),
      });
    };
    const clean = await start('clean');
    const dirty = await start('dirty');
    try {
      expect(clean.ready.isolation.status).toBe('sandboxed');
      expect(clean.loopbackPorts.length).toBe(2);
      expect(clean.ready.httpsFallback).toBeNull();
      const credentials = clean.credentials();
      expect(credentials.pid).toBe(clean.pid);
      expect(credentials.anonKey.length).toBeGreaterThan(20);
      // No key, code or token on the events the harness keeps as evidence.
      const events = readFileSync(join(clean.evidenceDir, 'host-events.jsonl'), 'utf8');
      for (const secret of [credentials.anonKey, credentials.serviceRoleKey, credentials.otpCode]) expect(events).not.toContain(secret);
      // A real call through the http door from outside the sandbox (the orchestrator side).
      const response = await fetch(`${clean.ready.httpUrl}/auth/v1/otp`, {
        method: 'POST', headers: { apikey: credentials.anonKey, 'Content-Type': 'application/json', ...API_VERSION },
        body: JSON.stringify({ email: credentials.users[0]!.email, create_user: false }),
      });
      expect(response.status).toBe(200);
      // An unknown route makes the other shim exit 3 at stop.
      expect((await fetch(`${dirty.ready.httpUrl}/rest/v1/portmgr_ports`)).status).toBeGreaterThanOrEqual(400);
      expect((await clean.stop()).exitCode).toBe(0);
    } finally {
      const violations = await hosts.settle();
      expect(violations).toEqual([expect.stringMatching(/^supabase shim dirty: exited 3: unknown routes/)]);
      expect(logs.some(line => line.includes('lane left supabase shim dirty'))).toBe(true);
      expect(applyHostViolations({ status: 'pass' }, violations).status).toBe('fail');
    }
    expect(clean.problems()).toEqual([]);
    expect(dirty.result()?.exitCode).toBe(SHIM_EXIT_UNSUPPORTED);
    for (const name of [SHIM_REPORT_FILE, SHIM_RELAY_DUMP_FILE, SHIM_DIALOGUE_DUMP_FILE]) expect(existsSync(join(clean.evidenceDir, name))).toBe(true);
    expect((JSON.parse(readFileSync(join(clean.evidenceDir, SHIM_REPORT_FILE), 'utf8')) as SupabaseShimReport).isolation.status).toBe('sandboxed');
    // settle is idempotent.
    expect(await hosts.settle()).toEqual([expect.stringMatching(/^supabase shim dirty:/)]);
  }, SHIM_TIMEOUT_MS);
});

describe.skipIf(process.platform === 'win32')('this file', () => {
  test('every test or hook that starts a shim, a child or openssl sets its own timeout; every suite is skipped on Windows', () => {
    const source = readFileSync(import.meta.path, 'utf8');
    const file = ts.createSourceFile(import.meta.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const slowCalls = ['startSupabaseShim', 'startSupabaseShimHost', 'settle', 'startServeChild', 'runChild', 'runShimClientSelfcheck', 'createFixtureCa', 'spawn', 'stop'];
    const isSlow = (node: ts.Node): boolean => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (slowCalls.includes(name)) return true;
      }
      return ts.forEachChild(node, isSlow) ?? false;
    };
    const timeoutValue = (node: ts.Expression | undefined): number => {
      if (!node) return 0;
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (ts.isIdentifier(node) && node.text === 'SHIM_TIMEOUT_MS') return SHIM_TIMEOUT_MS;
      return 0;
    };
    const problems: string[] = [];
    let checked = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const callbackIndex = name === 'test' ? 1 : ['beforeAll', 'afterAll', 'beforeEach', 'afterEach'].includes(name) ? 0 : -1;
        const callback = callbackIndex >= 0 ? node.arguments[callbackIndex] : undefined;
        if (callback && isSlow(callback)) {
          checked += 1;
          if (timeoutValue(node.arguments[callbackIndex + 1]) < 30_000) {
            problems.push(`${name} at line ${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} has no explicit timeout >= 30 s`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const statement of file.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
      const callee = statement.expression.expression.getText(file);
      if (/^describe\b/.test(callee) && callee !== "describe.skipIf(process.platform === 'win32')") problems.push(`top-level ${callee} is not skipped on Windows`);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(15);
  }, SHIM_TIMEOUT_MS);
});
