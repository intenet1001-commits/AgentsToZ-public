// J1-RELAY-WEB (emulator harness WP5): pure helpers of the lane — QR fragment handling, CSP widening, phone request
// routing, relay sequence audit, shim report judgement — plus static guards (the portal is never served on loopback,
// the lane is registered and hashed, no #pair= token reaches a reason). Nothing here starts a browser, shim or host; one
// test starts the lane's own fixture server (bun, 127.0.0.1, a temp folder) to prove the post-run cleanup really stops it.
import {describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HARNESS_SOURCE_FILES, LANE_MODULES, resolveLane} from '../scripts/emulator-e2e';
import {listenerOwnedBy, reserveLoopbackPort} from '../scripts/emulator-e2e/isolatedSidecar';
import {detectForbiddenTools} from '../scripts/emulator-e2e/preflight';
import {
  FOREIGN_SUPABASE_ORIGIN,
  PORTAL_BUILD_SCRIPT,
  PORTAL_ORIGIN,
  PRODUCTION_CONNECT_SRC,
  assertPortalOrigin,
  assertShimOrigin,
  classifyPhoneRequest,
  contentTypeFor,
  decodePairingUrl,
  encodePairingUrl,
  portalBuildEnv,
  portalFilePath,
  portalResponseHeaders,
  readVercelConfig,
  redactPairingText,
  vercelHeadersFor,
  vercelSourceRegExp,
  summarizePairing,
  widenPortalCsp,
  withForeignSupabase,
  withPortalQuery,
} from '../scripts/emulator-e2e/portalFixtureBuild';
import {
  CARD_FOLLOW_TAP_ALLOWANCE,
  CLAIM_RPC,
  FAKE_AGENT_NAMES,
  KNOWN_CARD_FOLLOW_ISSUE,
  REAL_LABELS,
  RELAY_RESTART_MIN_SKIP,
  SANDBOX_PS_STUB,
  STAND_IN_LABELS,
  auditRelaySequences,
  fakeAgentCliSource,
  fixtureServerSource,
  followCard,
  judgeCardFollow,
  judgePhones,
  judgeRestartSkip,
  judgeShimReport,
  lane,
  parseStartedPids,
  phoneBrowserEnv,
  reapFixtureServers,
  summarizeSideEffects,
} from '../scripts/emulator-e2e/relayWebJourney';

const REPO = join(import.meta.dir, '..');
const SHIM = 'https://localhost:45678';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl';
const payload = {
  schemaVersion: 1, hostId: '11111111-1111-4111-8111-111111111111', pairingId: '22222222-2222-4222-8222-222222222222',
  pairingSecret: 'S'.repeat(43), hostPublicKey: 'K'.repeat(87), expiresAt: '2026-11-02T00:00:00.000Z', supabase: {url: SHIM, anonKey: ANON},
};
const pairingUrl = encodePairingUrl(`${PORTAL_ORIGIN}/remote/`, payload);

describe('QR (pairing URL) helpers', () => {
  test('round trip, query before the fragment, foreign rewrite keeps everything else', () => {
    expect(pairingUrl.startsWith('https://portal.test/remote/#pair=')).toBe(true);
    expect(decodePairingUrl(pairingUrl)).toEqual({base: 'https://portal.test/remote/', payload});
    const withTab = withPortalQuery(pairingUrl, '?tab=workroom');
    expect(withTab.startsWith('https://portal.test/remote/?tab=workroom#pair=')).toBe(true);
    expect(decodePairingUrl(withTab).payload).toEqual(payload);
    const foreign = decodePairingUrl(withForeignSupabase(pairingUrl)).payload;
    expect(foreign.supabase).toEqual({url: FOREIGN_SUPABASE_ORIGIN, anonKey: ANON});
    expect({...foreign, supabase: payload.supabase}).toEqual(payload);
    expect(FOREIGN_SUPABASE_ORIGIN).not.toContain('yfbivsatsorbidfutkvb');
  });

  test('a QR without supabase cannot be rewritten, and a URL without a fragment is refused', () => {
    const {supabase: _omit, ...legacy} = payload;
    expect(() => withForeignSupabase(encodePairingUrl(`${PORTAL_ORIGIN}/remote/`, legacy))).toThrow(/no supabase/);
    expect(() => decodePairingUrl(`${PORTAL_ORIGIN}/remote/`)).toThrow(/#pair=/);
  });

  test('the evidence summary carries no secret and says whether the QR points at the shim', () => {
    const summary = summarizePairing(pairingUrl, {url: SHIM, anonKey: ANON});
    expect(summary).toMatchObject({base: 'https://portal.test/remote/', hasSupabase: true, supabaseUrl: SHIM, supabaseUrlMatchesShim: true, anonKeyMatchesShim: true});
    const text = JSON.stringify(summary);
    expect(text).not.toContain('S'.repeat(43));
    expect(text).not.toContain('#pair=');
    expect(summarizePairing(withForeignSupabase(pairingUrl), {url: SHIM, anonKey: ANON}).supabaseUrlMatchesShim).toBe(false);
  });

  test('reasons are scrubbed of #pair= tokens', () => {
    const text = redactPairingText(`page.goto: timeout navigating to "${pairingUrl}"`);
    expect(text).not.toMatch(/#pair=[A-Za-z0-9_-]{8,}/);
    expect(text).toContain('#pair=<redacted>');
  });
});

describe('portal serving', () => {
  test('the portal origin is a bare non-loopback https origin; loopback origins are refused', () => {
    expect(assertPortalOrigin(PORTAL_ORIGIN)).toBe('https://portal.test');
    for (const bad of ['https://localhost', 'https://127.0.0.1', 'http://portal.test', 'https://portal.test:8443', 'https://app.localhost', 'https://10.0.0.2']) {
      expect(() => assertPortalOrigin(bad)).toThrow();
    }
    expect(assertShimOrigin(SHIM)).toBe(SHIM);
    for (const bad of ['https://localhost', 'http://localhost:4000', 'https://127.0.0.1:4000', 'https://external-supabase.invalid']) expect(() => assertShimOrigin(bad)).toThrow();
  });

  test('CSP: exactly the shim origin is added to the production connect-src; a changed CSP is reported, not widened', () => {
    const html = readFileSync(join(REPO, 'remote', 'index.html'), 'utf8');
    expect(html).toContain(PRODUCTION_CONNECT_SRC);
    const widened = widenPortalCsp(html, SHIM);
    expect(widened.widened).toBe(true);
    expect(widened.html).toContain(`${PRODUCTION_CONNECT_SRC} ${SHIM}`);
    expect(widened.html.replace(` ${SHIM}`, '')).toBe(html);
    expect(widenPortalCsp(html.replace(PRODUCTION_CONNECT_SRC, "connect-src 'self'"), SHIM).widened).toBe(false);
    expect(() => widenPortalCsp(html, 'https://evil.example')).toThrow();
  });

  test('response headers: the web phone gets what vercel.json gives each path (later rules win), CSP widened by the shim only', () => {
    const vercel = readVercelConfig(REPO);
    const raw = vercelHeadersFor(vercel, '/remote/');
    const remoteRule = vercel.headers.find(rule => rule.source === '/remote/(.*)')!;
    const remoteCsp = remoteRule.headers.find(header => header.key === 'Content-Security-Policy')!.value;
    // The narrow /remote/(.*) rule comes after the catch-all and replaces its CSP and Referrer-Policy (Vercel order).
    expect(raw['Content-Security-Policy']).toBe(remoteCsp);
    expect(raw).toMatchObject({'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store, max-age=0'});
    const web = portalResponseHeaders({variant: 'web', pathname: '/remote/', contentType: 'text/html; charset=utf-8', shimOrigin: SHIM, vercel});
    expect(web.cspHeaderWidened).toBe(true);
    expect(web.cspHeaderUnwidened).toBe(false);
    expect(web.headers['Content-Security-Policy']).toBe(remoteCsp.replace(PRODUCTION_CONNECT_SRC, `${PRODUCTION_CONNECT_SRC} ${SHIM}`));
    const unwidened: Record<string, string> = {...web.headers, 'Content-Security-Policy': remoteCsp};
    expect(unwidened).toEqual(raw);
    // An asset path only matches the catch-all; no Cache-Control rule there → no-store.
    const asset = portalResponseHeaders({variant: 'web', pathname: '/assets/remote-abc.js', contentType: 'text/javascript; charset=utf-8', shimOrigin: SHIM, vercel});
    expect(asset.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(asset.headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(asset.headers['Cache-Control']).toBe('no-store');
    // A CSP header without the production connect-src is reported, never served unwidened silently.
    const changed = {headers: [{source: '/(.*)', headers: [{key: 'Content-Security-Policy', value: "default-src 'self'"}]}]};
    expect(portalResponseHeaders({variant: 'web', pathname: '/remote/', contentType: 'text/html', shimOrigin: SHIM, vercel: changed}).cspHeaderUnwidened).toBe(true);
  });

  test('vercel source patterns: literal paths and (.*) only; anything else is refused', () => {
    expect(vercelSourceRegExp('/(.*)').test('/remote/')).toBe(true);
    expect(vercelSourceRegExp('/remote/(.*)').test('/remote/')).toBe(true);
    expect(vercelSourceRegExp('/remote/(.*)').test('/remote')).toBe(false);
    expect(vercelSourceRegExp('/remote').test('/remote/')).toBe(false);
    expect(vercelSourceRegExp('/portal.html').test('/portalxhtml')).toBe(false);
    for (const bad of ['/:path*', '/remote/(.+)', 'remote', '/a*']) expect(() => vercelSourceRegExp(bad)).toThrow();
  });

  test('bundled phone: the iPhone app’s PortalSchemeHandler headers and servedHTML widening (https + wss of the QR Supabase)', () => {
    const vercel = readVercelConfig(REPO);
    const swift = readFileSync(join(REPO, 'mobile', 'ios', 'App', 'PortalSchemeHandler.swift'), 'utf8');
    const literal = /contentSecurityPolicy = "([^"]+)"/.exec(swift)?.[1] ?? '';
    expect(literal).toContain('\\(config.supabaseUrl) \\(supabaseSocket)');
    const appCsp = literal.replace('\\(config.supabaseUrl) \\(supabaseSocket)', `${SHIM} wss://localhost:45678`);
    const html = portalResponseHeaders({variant: 'bundled', pathname: '/remote/', contentType: 'text/html; charset=utf-8', shimOrigin: SHIM, vercel});
    expect(html.headers).toEqual({'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': appCsp, 'Referrer-Policy': 'no-referrer'});
    expect(html.cspHeaderWidened).toBe(true);
    const asset = portalResponseHeaders({variant: 'bundled', pathname: '/assets/a.js', contentType: 'text/javascript', shimOrigin: SHIM, vercel});
    expect(asset.headers).toEqual({'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=31536000, immutable'});
    // Meta CSP: the same addition BundledPortalConfig.servedHTML makes.
    const page = readFileSync(join(REPO, 'remote', 'index.html'), 'utf8');
    expect(widenPortalCsp(page, SHIM, {socket: true}).html).toContain(`${PRODUCTION_CONNECT_SRC} ${SHIM} wss://localhost:45678;`);
  });

  test('phone requests: portal files are fulfilled, the shim continues, everything else (3001, external origins) is cut', () => {
    expect(classifyPhoneRequest('https://portal.test/remote/?tab=workroom', SHIM)).toEqual({kind: 'portal', path: '/remote/'});
    expect(classifyPhoneRequest(`${SHIM}/rest/v1/rpc/${CLAIM_RPC}`, SHIM)).toEqual({kind: 'shim'});
    expect(classifyPhoneRequest('http://127.0.0.1:3001/api/supabase-proxy/rest/v1/x', SHIM)).toEqual({kind: 'abort', origin: 'http://127.0.0.1:3001'});
    expect(classifyPhoneRequest('https://production-supabase.invalid/rest/v1/x', SHIM).kind).toBe('abort');
    expect(classifyPhoneRequest('https://localhost:45679/x', SHIM).kind).toBe('abort');
    expect(portalFilePath('/tmp/dist', '/remote/')).toBe('/tmp/dist/remote/index.html');
    expect(portalFilePath('/tmp/dist', '/../../etc/passwd')).toBeNull();
    expect(portalFilePath('/tmp/dist', '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(contentTypeFor('/a/b.js')).toContain('javascript');
    expect(contentTypeFor('/a/index.html')).toContain('text/html');
  });

  test('static: no lane file serves the portal itself (route only) and none names a forbidden tool', () => {
    const files = ['scripts/emulator-e2e/portalFixtureBuild.ts', 'scripts/emulator-e2e/relayWebPhone.ts', 'scripts/emulator-e2e/relayWebJourney.ts', 'tests/remote-relay-real-host.e2e.mjs'];
    const texts = files.map(path => ({path, text: readFileSync(join(REPO, path), 'utf8')}));
    for (const {path, text} of texts) {
      expect(text, path).not.toMatch(/Bun\.serve\(\s*\{[^}]*fetch[^}]*portal/i);
      expect(text, path).not.toMatch(/createServer\(|\.listen\(|http\.server/);
      expect(text, path).not.toMatch(/https?:\/\/(?:localhost|127\.0\.0\.1):(?:3001|52741|4723)\b/);
      expect(text, path).not.toMatch(/from ['"]\.\.\/\.\.\/src\//);
    }
    expect(detectForbiddenTools(texts)).toEqual([]);
    // The only Bun.serve in the lane is the fixture project's own server source (bound to 127.0.0.1, run by the host).
    expect(fixtureServerSource('/tmp/starts.log', 4100)).toContain("hostname: '127.0.0.1'");
  });

  test('portal builds: web gets the shim origin, bundled gets no VITE_SUPABASE_* (injected at runtime like the app)', () => {
    const base = {repoRoot: '/repo', outDir: '/scratch/out', workDir: '/scratch/work'};
    const web = portalBuildEnv({...base, variant: 'web', supabaseUrl: SHIM, anonKey: ANON}, '/scratch/work/empty-env');
    expect(web).toMatchObject({VITE_SUPABASE_URL: SHIM, VITE_SUPABASE_ANON_KEY: ANON, PATH: '/usr/bin:/bin', HOME: '/scratch/work/home', AGENTSTOZ_EMULATOR_PORTAL_ENV_DIR: '/scratch/work/empty-env'});
    const bundled = portalBuildEnv({...base, variant: 'bundled'}, '/scratch/work/empty-env');
    expect(bundled.VITE_SUPABASE_URL).toBe('');
    expect(bundled.VITE_SUPABASE_ANON_KEY).toBe('');
    expect(() => portalBuildEnv({...base, variant: 'bundled', supabaseUrl: SHIM, anonKey: ANON}, '/e')).toThrow(/bundled/);
    expect(() => portalBuildEnv({...base, variant: 'web', supabaseUrl: 'https://external-supabase.invalid', anonKey: ANON}, '/e')).toThrow(/localhost/);
    expect(Object.keys(web).filter(key => !/^(PATH|HOME|TMPDIR|LANG|NO_COLOR|VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY|AGENTSTOZ_EMULATOR_PORTAL_[A-Z_]+)$/.test(key))).toEqual([]);
    // Values reach the child only through the environment, never spliced into the evaluated source.
    expect(PORTAL_BUILD_SCRIPT).not.toContain(SHIM);
    expect(PORTAL_BUILD_SCRIPT).toContain("configLoader: 'runner'");
  });
});

describe('relay sequence audit (relay-db.json audit.relay_messages)', () => {
  const row = (relay_seq: number, sender_sequence: number, direction = 'host_to_controller', created_at = '2026-11-01T00:00:00Z', session_id = 'aaaaaaaa-0000-4000-8000-000000000000') =>
    ({relay_seq, sender_sequence, direction, created_at, session_id});

  test('monotonic per (session, direction) passes and reports the jump across the restart', () => {
    const audit = auditRelaySequences([
      row(1, 1), row(2, 1, 'controller_to_host'), row(3, 2), row(4, 2, 'controller_to_host'),
      row(5, 1027, 'host_to_controller', '2026-11-01T00:05:00Z'), row(6, 3, 'controller_to_host', '2026-11-01T00:05:01Z'),
    ], '2026-11-01T00:04:00Z');
    expect(audit).toMatchObject({rows: 6, reused: 0, nonMonotonic: 0, relaySeqDuplicates: 0});
    expect(audit.groups.find(group => group.direction === 'host_to_controller')).toMatchObject({count: 3, min: 1, max: 1027, jumpAcrossRestart: 1025});
    expect(audit.groups.find(group => group.direction === 'controller_to_host')?.jumpAcrossRestart).toBe(1);
  });

  test('a reused sender sequence and a duplicate relay_seq are counted', () => {
    const audit = auditRelaySequences([row(1, 1), row(2, 2), row(3, 2), row(3, 4)]);
    expect(audit.reused).toBe(1);
    expect(audit.nonMonotonic).toBe(1);
    expect(audit.relaySeqDuplicates).toBe(1);
  });

  test('separate sessions do not interfere', () => {
    const audit = auditRelaySequences([row(1, 1), row(2, 1, 'host_to_controller', '2026-11-01T00:00:00Z', 'bbbbbbbb-0000-4000-8000-000000000000')]);
    expect(audit.reused).toBe(0);
    expect(audit.groups.map(group => group.session).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });
});

describe('restart sequence skip', () => {
  const row = (relay_seq: number, sender_sequence: number, created_at: string, direction = 'host_to_controller', session_id = 'aaaaaaaa-0000-4000-8000-000000000000') =>
    ({relay_seq, sender_sequence, direction, created_at, session_id});
  const restartAt = '2026-11-01T00:04:00Z';

  test('the restored session’s host sequence must jump by at least the host’s recovery gap', () => {
    const ok = auditRelaySequences([row(1, 1, '2026-11-01T00:00:00Z'), row(2, 40, '2026-11-01T00:01:00Z'), row(3, 1065, '2026-11-01T00:05:00Z')], restartAt);
    expect(judgeRestartSkip(ok, 'aaaaaaaa-0000-4000-8000-000000000000')).toEqual({problems: [], jump: 1025});
    // A regression that removed the skip: every row still unique and increasing, so only this check sees it.
    const noSkip = auditRelaySequences([row(1, 1, '2026-11-01T00:00:00Z'), row(2, 40, '2026-11-01T00:01:00Z'), row(3, 41, '2026-11-01T00:05:00Z')], restartAt);
    expect(noSkip).toMatchObject({reused: 0, nonMonotonic: 0});
    expect(judgeRestartSkip(noSkip, 'aaaaaaaa').problems.join(' ')).toMatch(/jumped by 1, expected ≥ 1024/);
    // No message after the restart (or none before) is not a pass: the resume was not seen.
    const before = auditRelaySequences([row(1, 1, '2026-11-01T00:00:00Z')], restartAt);
    expect(judgeRestartSkip(before, 'aaaaaaaa').problems.join(' ')).toMatch(/both sides of the restart/);
    expect(judgeRestartSkip(before, 'bbbbbbbb').problems.join(' ')).toMatch(/no host_to_controller messages/);
    // The controller direction is not the host's counter.
    const phoneOnly = auditRelaySequences([row(1, 1, '2026-11-01T00:00:00Z', 'controller_to_host'), row(2, 2, '2026-11-01T00:05:00Z', 'controller_to_host')], restartAt);
    expect(judgeRestartSkip(phoneOnly, 'aaaaaaaa').problems.length).toBe(1);
  });

  test('the minimum skip is the host’s REMOTE_CONTROL_SEND_SEQUENCE_RECOVERY_GAP (copied — the lane does not import src/)', () => {
    const source = readFileSync(join(REPO, 'src', 'remoteControlInternetAgent.ts'), 'utf8');
    expect(Number(/export const REMOTE_CONTROL_SEND_SEQUENCE_RECOVERY_GAP = (\d+);/.exec(source)?.[1])).toBe(RELAY_RESTART_MIN_SKIP);
  });
});

describe('phone card follows the host', () => {
  test('followCard counts attempts, not taps: an offline phone (no 새로고침 button) ends instead of looping', async () => {
    let clock = 0;
    let waits = 0;
    const result = await followCard({
      waitEnabled: async ms => { waits += 1; clock += ms; return false; },
      tapRefresh: async ms => { clock += ms; return false; },
      checkAlert: async () => {},
    }, {now: () => clock});
    expect(result).toEqual({followed: false, refreshTaps: 0, attempts: 3});
    expect(waits).toBe(4);
    // The overall deadline also ends it.
    clock = 0;
    const capped = await followCard({waitEnabled: async ms => { clock += ms; return false; }, tapRefresh: async () => true, checkAlert: async () => {}}, {now: () => clock, deadlineMs: 20_000, maxAttempts: 100});
    expect(capped.followed).toBe(false);
    expect(capped.attempts).toBeLessThanOrEqual(1);
    // A phone alert stops the wait at once.
    await expect(followCard({waitEnabled: async () => false, tapRefresh: async () => true, checkAlert: async () => { throw new Error('alert'); }})).rejects.toThrow('alert');
    // One tap that works.
    let enabled = false;
    expect(await followCard({waitEnabled: async () => enabled, tapRefresh: async () => { enabled = true; return true; }, checkAlert: async () => {}}))
      .toEqual({followed: true, refreshTaps: 1, attempts: 1});
  });

  test('judgeCardFollow: one tap after 실행 is the named known issue; a tap anywhere else, or more taps, fails', () => {
    expect(CARD_FOLLOW_TAP_ALLOWANCE).toEqual({before: 0, start: 1, stop: 0});
    const clean = judgeCardFollow([{step: 'web-before', transition: 'before', refreshTaps: 0, followed: true}, {step: 'web-start', transition: 'start', refreshTaps: 0, followed: true}]);
    expect(clean).toEqual({problems: [], knownIssue: null});
    const known = judgeCardFollow([{step: 'web-start', transition: 'start', refreshTaps: 1, followed: true}, {step: 'web-stop', transition: 'stop', refreshTaps: 0, followed: true}]);
    expect(known.problems).toEqual([]);
    expect(known.knownIssue).toMatchObject({id: KNOWN_CARD_FOLLOW_ISSUE, occurrences: [{step: 'web-start', taps: 1}]});
    expect(judgeCardFollow([{step: 'web-stop', transition: 'stop', refreshTaps: 1, followed: true}]).problems.join(' ')).toMatch(/web-stop.*1 새로고침 tap\(s\), allowed 0/);
    expect(judgeCardFollow([{step: 'web-before', transition: 'before', refreshTaps: 1, followed: true}]).problems.length).toBe(1);
    expect(judgeCardFollow([{step: 'web-start', transition: 'start', refreshTaps: 2, followed: true}]).problems.length).toBe(1);
    expect(judgeCardFollow([{step: 'web-start', transition: 'start', refreshTaps: 0, followed: false}]).problems.join(' ')).toMatch(/never followed/);
  });
});

describe('phone post-run judgement', () => {
  const clean = {label: 'web', aborted: [], csp: {widened: 1, headerWidened: 1, missing: 0}, loadedRemote: true, pageErrors: []};

  test('a clean phone passes; any cut origin, unwidened CSP or missing CSP fails', () => {
    expect(judgePhones([clean])).toEqual([]);
    expect(judgePhones([{...clean, aborted: ['http://127.0.0.1:3001']}]).join(' ')).toMatch(/127\.0\.0\.1:3001/);
    expect(judgePhones([{...clean, aborted: ['https://foreign-project.invalid']}]).length).toBe(1);
    expect(judgePhones([{...clean, csp: {widened: 1, headerWidened: 1, missing: 1}}]).length).toBe(1);
    // An HTML page with no CSP at all is not silently fine: nothing was widened.
    expect(judgePhones([{...clean, csp: {widened: 0, headerWidened: 1, missing: 1}}]).length).toBe(2);
    expect(judgePhones([{...clean, csp: {widened: 1, headerWidened: 0, missing: 0}}]).join(' ')).toMatch(/no CSP response header/);
    // A phone that never reached /remote/ is judged only on what it did.
    expect(judgePhones([{...clean, loadedRemote: false, csp: {widened: 0, headerWidened: 0, missing: 0}}])).toEqual([]);
    expect(judgePhones([{...clean, pageErrors: ['boom']}]).join(' ')).toMatch(/page errors: boom/);
  });

  test('fixture server start lines → pids (for the post-run cleanup of servers the host leaves running)', () => {
    expect(parseStartedPids('2026-11-01T00:00:00Z pid=4242 port=5000\n\n2026-11-01T00:01:00Z pid=4343 port=5000\nnoise pid=1\n')).toEqual([4242, 4343]);
    expect(parseStartedPids('')).toEqual([]);
  });

  test('cleanup stops a fixture server the host left running, and never a pid it cannot prove is its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-web-reap-'));
    const alphaDir = join(dir, 'relay-alpha');
    mkdirSync(alphaDir);
    const startsFile = join(dir, 'alpha-starts.log');
    const port = reserveLoopbackPort();
    writeFileSync(join(alphaDir, 'server.ts'), fixtureServerSource(startsFile, port));
    // Like the host's /api/execute-command child: detached from the test, so only the cleanup can stop it.
    const server = Bun.spawn([process.execPath, '--env-file=/dev/null', 'server.ts'], {cwd: alphaDir, stdout: 'ignore', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}});
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !listenerOwnedBy(server.pid, port)) await Bun.sleep(100);
      expect(listenerOwnedBy(server.pid, port)).toBe(true);
      // A start line naming a live pid that is not ours (this test runner: other cwd, not the port's listener) must be left alone.
      writeFileSync(startsFile, `${readFileSync(startsFile, 'utf8')}2026-11-01T00:00:00Z pid=${process.pid} port=${port}\n`);
      const reaped = await reapFixtureServers(startsFile, port, alphaDir);
      expect(reaped.killed).toEqual([server.pid]);
      expect(reaped.stillAlive).toEqual([]);
      expect(reaped.skipped).toEqual([process.pid]);
      expect(await Promise.race([server.exited.then(() => 'exited'), Bun.sleep(5_000).then(() => 'alive')])).toBe('exited');
      expect(listenerOwnedBy(server.pid, port)).toBe(false);
    } finally {
      try { server.kill('SIGKILL'); } catch {}
      rmSync(dir, {recursive: true, force: true});
    }
  }, 30_000);
});

describe('shim report judgement', () => {
  test('claims must equal the phones that paired; unknown routes and rejected origins fail', () => {
    const ok = {ok: true, unknownRoutes: [], rejectedOrigins: [], rpcCalls: {[CLAIM_RPC]: {'authenticated:200': 2}}};
    expect(judgeShimReport(ok, 2)).toEqual({problems: [], claimCalls: 2, claimOk: 2, unknownRoutes: 0, rejectedOrigins: 0});
    // The foreign QR must add no claim: one extra call (even a refused one) fails.
    expect(judgeShimReport({...ok, rpcCalls: {[CLAIM_RPC]: {'authenticated:200': 2, 'authenticated:400': 1}}}, 2).problems.join(' ')).toMatch(/claim RPC calls 3/);
    expect(judgeShimReport({...ok, unknownRoutes: [{}]}, 2).problems).toContain('shim unknown routes 1');
    expect(judgeShimReport({...ok, rejectedOrigins: [{}]}, 2).problems).toContain('shim rejected origins 1');
    expect(judgeShimReport({...ok, rpcCalls: {}}, 2).problems.length).toBeGreaterThan(0);
  });
});

describe('host side-effect summary', () => {
  test('counts command:outcome pairs and collects only the refused attempts', () => {
    const summary = summarizeSideEffects([
      {at: 't', api: 'guard', command: 'start', argc: 0, outcome: 'installed', pid: 9},
      {at: 't', api: 'spawn', command: 'defaults', argc: 3, outcome: 'spawned', pid: 1},
      {at: 't', api: 'spawn', command: 'defaults', argc: 3, outcome: 'spawned', pid: 2},
      {at: 't', api: 'Bun.spawn', command: 'open', argc: 2, outcome: 'refused-by-wrapper'},
      {at: 't'},
    ]);
    expect(summary.count).toBe(4);
    expect(summary.guardInstalled).toBe(1);
    expect(summary.byCommand).toEqual({'defaults:spawned': 2, 'open:refused-by-wrapper': 1, '(unknown):(unknown)': 1});
    expect(summary.refused).toEqual(['open via Bun.spawn']);
    expect(summarizeSideEffects([])).toEqual({count: 0, guardInstalled: 0, byCommand: {}, refused: []});
  });
});

describe('lane wiring', () => {
  test('j1-relay-web is registered, hashed into the evidence and resolves to this module', async () => {
    expect(typeof LANE_MODULES['j1-relay-web']).toBe('function');
    for (const file of ['scripts/emulator-e2e/portalFixtureBuild.ts', 'scripts/emulator-e2e/relayWebPhone.ts', 'scripts/emulator-e2e/relayWebJourney.ts']) {
      expect(HARNESS_SOURCE_FILES).toContain(file);
    }
    const resolved = await resolveLane('j1-relay-web');
    expect(resolved).toBe(lane);
    expect(lane.preconditions).toBeUndefined();
  });

  test('labels name both the real path and every stand-in', () => {
    expect(REAL_LABELS.length).toBeGreaterThan(3);
    // Every deviation from production is labelled: the real HOME of WebKit, the added ?tab=workroom, the route standing in for
    // Vercel's headers, the bundled origin and its port-carrying Supabase URL.
    for (const needle of ['PGlite shim', 'portal.test', 'vercel.json', 'CSP', 'scriptedApproval:true', 'fake shell CLI', 'agentstoz-app://portal', 'real HOME', '?tab=workroom', 'has a port']) {
      expect(STAND_IN_LABELS.some(label => label.includes(needle)), needle).toBe(true);
    }
  });

  test('every agent gets a fake CLI (no fallback to a real one) and the CLI records each input line', () => {
    expect([...FAKE_AGENT_NAMES].sort()).toEqual(['agy', 'claude', 'codex', 'hermes']);
    const source = fakeAgentCliSource("/tmp/it's/transcript.log", 'claude');
    expect(source.startsWith('#!/bin/sh\n')).toBe(true);
    expect(source).toContain('REMOTE_READY');
    expect(source).toContain("INPUT:%s");
    expect(source).toContain("'/tmp/it'\\''s/transcript.log'");
    // The PATH-relative `ps` stub (setuid /bin/ps is refused inside sandbox-exec) lists nothing and succeeds.
    expect(SANDBOX_PS_STUB.startsWith('#!/bin/sh\n')).toBe(true);
    expect(SANDBOX_PS_STUB.trim().split('\n').at(-1)).toBe('exit 0');
    expect(STAND_IN_LABELS.some(label => label.includes('`ps`'))).toBe(true);
  });

  test('the phone browser gets four keys only; HOME is the real one (WebKit sandbox), TMPDIR the run scratch', () => {
    const env = phoneBrowserEnv('/Users/someone', '/scratch/run/phone/tmp/');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
    expect(env).toMatchObject({HOME: '/Users/someone', TMPDIR: '/scratch/run/phone/tmp/', PATH: '/usr/bin:/bin:/usr/sbin:/sbin'});
  });

  test('the e2e entry only runs the harness lane, and runs under node as well as bun', () => {
    const text = readFileSync(join(REPO, 'tests', 'remote-relay-real-host.e2e.mjs'), 'utf8');
    expect(text).toContain("'scripts/emulator-e2e.ts', 'j1-relay-web'");
    expect(text).not.toMatch(/playwright/);
    // Sibling *.e2e.mjs entries are started with `node` (scripts/check-maintainer-web.ts): no Bun-only API.
    expect(text).not.toMatch(/import\.meta\.dir\b|\bBun\./);
    expect(text).toContain("fileURLToPath(new URL('..', import.meta.url))");
    expect(text).toContain("from 'node:child_process'");
  });
});
