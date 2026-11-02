/**
 * WP7 — ScreenFixtureHost harness (scripts/emulator-e2e/screenFixtureHost.ts): the pure helpers, and the sandbox
 * rules measured with the real sandbox-exec against processes and listeners this test starts itself (a `sleep`, two
 * loopback listeners). Nothing here builds or starts the fixture host, touches 3001/52741/4723, the real desktop,
 * TCC or the keychain. Regressions for the review of emu/wp7 (findings 1–10).
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  DENIED_MACH_SERVICES,
  DENIED_PORTS,
  FIXTURE_RULES_MARKER,
  INVITES_REACHING_COUNTING_LISTENER,
  assertFixtureEnvironment,
  assertGatedBinary,
  createSelfcheckWorkDir,
  evaluateGate,
  fixtureEnvironmentProblems,
  freshEvidenceDirectory,
  lane,
  laneOutcomeFromReport,
  loopbackOnlyVerdict,
  parseLsofListeners,
  productionSourcesVsMain,
  profileShapeProblems,
  replyForCaller,
  screenFixtureSandboxProfile,
  selfcheck,
  start,
  summarizeTccLog,
  tccVerdict,
  writeFixtureProfile,
  type ScreenFixtureBuild,
  type ScreenHostLaneContext,
  type SelfcheckReport,
} from '../scripts/emulator-e2e/screenFixtureHost';
import {LANE_MODULES, resolveLane, unregisterLane} from '../scripts/emulator-e2e';
import {buildSandboxProfile} from '../scripts/emulator-e2e/sandbox';
import {PRODUCTION_SUPABASE_REFS} from '../scripts/emulator-e2e/environment';

const macOnly = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
/** A home that does not exist: the pure checks never consult directory services. */
const FAKE_HOME = '/Users/wp7-screen-fixture-test-home';

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
afterAll(() => { for (const dir of made) rmSync(dir, {recursive: true, force: true}); });

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The shape of WP0's buildAllowlistedEnv (scripts/emulator-e2e/environment.ts) for an isolated profile under `root`. */
function wp0Environment(root: string): Record<string, string> {
  const home = join(root, 'home');
  return {
    PATH: `${join(root, 'bin')}:${join(home, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home, USER: 'tester', LOGNAME: 'tester', TMPDIR: `${join(root, 'tmp')}/`, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    APP_DATA_DIR: join(root, 'app-data'), APPDATA: join(root, 'roaming'), USERPROFILE: home, HERMES_HOME: join(home, '.hermes'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), TMUX_TMPDIR: join(root, 'tmux'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    NODE_ENV: 'test', NO_COLOR: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
    AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC: '1',
  };
}

/** WP1's network and signal rules (scripts/emulator-e2e/sandbox.ts at cd89a7dd), the base a lane's fixture profile starts from. */
const WP1_SHAPED_BASE = [
  '(version 1)',
  '(allow default)',
  '(deny signal)',
  '(allow signal (target same-sandbox))',
  '(deny network-outbound (remote ip "*:*"))',
  '(deny network-bind (local ip "*:*"))',
  '(deny network-inbound (local ip "*:*"))',
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:*"))',
  ...DENIED_PORTS.map(port => `(deny network-outbound (remote ip "localhost:${port}"))`),
  '',
].join('\n');

/**
 * WP1's shape at daeca98e: a one-port loopback allowlist followed by the port and unix-socket denies. Alone, that order
 * made its own allowed port fail intermittently (8/60 measured); the fixture rules appended after it must not inherit that.
 */
const WP1_ALLOWLIST_SHAPED_BASE = [
  '(version 1)',
  '(allow default)',
  '(deny signal)',
  '(allow signal (target same-sandbox))',
  '(deny network-outbound (remote ip "*:*"))',
  '(deny network-bind (local ip "*:*"))',
  '(deny network-inbound (local ip "*:*"))',
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:45678"))',
  ...DENIED_PORTS.map(port => `(deny network-outbound (remote ip "localhost:${port}"))`),
  ...DENIED_PORTS.map(port => `(deny network-bind (local ip "*:${port}"))`),
  ...DENIED_PORTS.map(port => `(deny network-inbound (local ip "*:${port}"))`),
  '(deny network-outbound (remote unix-socket (path-regex #"^/")))',
  '',
].join('\n');

/**
 * WP1's real generator (scripts/emulator-e2e/sandbox.ts, merged from emu/wp0-1 at 5c8d645d): the base the orchestrator
 * hands a lane as `ctx.hostSandbox.text`, with its own one-port loopback allowlist as the last outbound rule.
 */
const WP1_GENERATED_BASE = buildSandboxProfile({writableRoots: [tempDir('atz-wp7-wp1-base-')], home: FAKE_HOME, allowedLoopbackPorts: [45678]}).text;

describe('sandbox profile generator', () => {
  test('refuses 3001, 52741 and 4723 as outbound ports (finding 10)', () => {
    const dir = tempDir('atz-wp7-ports-');
    for (const port of DENIED_PORTS) {
      expect(() => screenFixtureSandboxProfile({writable: [dir], executables: ['/usr/bin/true'], outboundPorts: [port], realHome: FAKE_HOME}))
        .toThrow(`refusing to let a fixture connect to port ${port}`);
    }
  });

  test('confines signals with deny + same-sandbox, never `(target others)` (finding 1)', () => {
    const dir = tempDir('atz-wp7-signal-');
    const profile = screenFixtureSandboxProfile({writable: [dir], executables: ['/usr/bin/true'], realHome: FAKE_HOME});
    expect(profile).not.toContain('(target others)');
    const rules = profile.slice(profile.indexOf(FIXTURE_RULES_MARKER)).split('\n');
    expect(rules[rules.indexOf('(deny signal)') + 1]).toBe('(allow signal (target same-sandbox))');
    expect(profileShapeProblems(profile, [])).toEqual([]);
  });

  test('never emits an unfiltered network deny; the host has no outbound allow, the phone only its port (finding 7)', () => {
    const dir = tempDir('atz-wp7-net-');
    const host = screenFixtureSandboxProfile({writable: [dir], executables: ['/usr/bin/true'], realHome: FAKE_HOME});
    const phone = screenFixtureSandboxProfile({writable: [dir], executables: ['/usr/bin/true'], outboundPorts: [40123], realHome: FAKE_HOME});
    for (const profile of [host, phone]) expect(profile.split('\n')).not.toContain('(deny network*)');
    expect(host).not.toContain('(allow network-outbound (remote ip');
    expect(profileShapeProblems(phone, [40123])).toEqual([]);
    expect(profileShapeProblems(phone, [])).toContain('outbound allows 40123 != none');
    for (const name of DENIED_MACH_SERVICES) expect(host).toContain(`(global-name "${name}")`);
  });

  test('appends its rules after the orchestrator base and narrows it (finding 3)', () => {
    const dir = tempDir('atz-wp7-base-');
    const profile = screenFixtureSandboxProfile({writable: [dir], executables: ['/usr/bin/true'], base: WP1_SHAPED_BASE, realHome: FAKE_HOME});
    expect(profile.startsWith(WP1_SHAPED_BASE.trimEnd())).toBe(true);
    expect(profile.indexOf(FIXTURE_RULES_MARKER)).toBeGreaterThan(WP1_SHAPED_BASE.trimEnd().length - 1);
    // The base's `localhost:*` allow comes before the marker; after it there is a deny-all and no outbound allow.
    expect(profileShapeProblems(profile, [])).toEqual([]);
    expect(() => screenFixtureSandboxProfile({writable: [dir], executables: ['/usr/bin/true'], base: '(allow default)', realHome: FAKE_HOME}))
      .toThrow('must start with (version 1)');
  });

  test('flags a profile with an unfiltered network deny or a `(target others)` signal rule', () => {
    const bad = ['(version 1)', '(allow default)', '(deny network*)', FIXTURE_RULES_MARKER, '(deny signal (target others))', ''].join('\n');
    const problems = profileShapeProblems(bad, []);
    expect(problems).toContain('an unfiltered (deny network*) makes later port denies ineffective');
    expect(problems).toContain('(target others) does not stop signals');
    expect(problems).toContain('signals are not confined to the sandbox');
  });

  test('keeps the outbound allowlist after every outbound deny, and flags a deny after it', () => {
    const dir = tempDir('atz-wp7-order-');
    const phone = screenFixtureSandboxProfile({writable: [dir], executables: ['/usr/bin/true'], outboundPorts: [40123], realHome: FAKE_HOME});
    const rules = phone.slice(phone.indexOf(FIXTURE_RULES_MARKER)).split('\n').map(line => line.trim()).filter(line => line.startsWith('('));
    const network = rules.filter(line => line.includes('network-'));
    expect(network.at(-1)).toBe('(allow network-outbound (remote ip "localhost:40123"))');
    const reordered = phone.replace('(allow network-outbound (remote ip "localhost:40123"))',
      '(allow network-outbound (remote ip "localhost:40123"))\n(deny network-outbound (remote ip "localhost:1"))');
    expect(profileShapeProblems(reordered, [40123])).toContain('an outbound deny follows the outbound allowlist (makes the allowed port fail intermittently)');
  });

  test('refuses to run a program a fixture could replace, and to write a profile where a fixture can (finding 8)', () => {
    const dir = tempDir('atz-wp7-rewrite-');
    const program = join(dir, 'screen-fixture-viewer');
    writeFileSync(program, '#!/bin/sh\n', {mode: 0o700});
    expect(() => screenFixtureSandboxProfile({writable: [dir], executables: [program], realHome: FAKE_HOME})).toThrow('could replace it');
    const writable = join(dir, 'phone');
    mkdirSync(writable, {mode: 0o700});
    expect(() => writeFixtureProfile(join(writable, 'profiles'), 'viewer', '(version 1)\n', [writable])).toThrow('a fixture may write');
    const outside = writeFixtureProfile(join(dir, 'profiles'), 'viewer', '(version 1)\n', [writable]);
    expect(readFileSync(outside.path, 'utf8')).toBe('(version 1)\n');
    expect(statSync(outside.path).mode & 0o777).toBe(0o600);
  });
});

describe('fixture environment (finding 3, finding 6)', () => {
  test('accepts the orchestrator environment, APP_DATA_DIR included, when every path is in the scratch', () => {
    const root = tempDir('atz-wp7-env-');
    expect(fixtureEnvironmentProblems(wp0Environment(root), [root], FAKE_HOME)).toEqual([]);
    expect(() => assertFixtureEnvironment(wp0Environment(root), [root], FAKE_HOME)).not.toThrow();
  });

  test('refuses APP_DATA_DIR outside the scratch roots', () => {
    const root = tempDir('atz-wp7-env-');
    const problems = fixtureEnvironmentProblems({...wp0Environment(root), APP_DATA_DIR: '/private/var/agentstoz-elsewhere'}, [root], FAKE_HOME);
    expect(problems).toEqual(['APP_DATA_DIR /private/var/agentstoz-elsewhere is outside the scratch roots']);
  });

  test('refuses a HOME under the real home even when a scratch root says so', () => {
    const scratch = join(FAKE_HOME, 'x');
    const problems = fixtureEnvironmentProblems({PATH: '/usr/bin:/bin', HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp') + '/'},
      [scratch], FAKE_HOME);
    expect(problems).toContain(`scratch root ${scratch} is not outside the real home`);
    expect(problems).toContain(`HOME ${join(scratch, 'home')} is under the real home`);
    expect(problems).toContain(`TMPDIR ${join(scratch, 'tmp')}/ is under the real home`);
  });

  test('is an allowlist: tokens, agent homes and URLs are refused', () => {
    const root = tempDir('atz-wp7-env-');
    const env = {...wp0Environment(root), ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', CODEX_HOME: '/x', API_PORT: '3001',
      VITE_SUPABASE_URL: PRODUCTION_SUPABASE_REFS[0]!, HERMES_HOME: join(FAKE_HOME, '.hermes')};
    const problems = fixtureEnvironmentProblems(env, [root], FAKE_HOME);
    for (const key of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'CODEX_HOME', 'API_PORT', 'VITE_SUPABASE_URL']) {
      expect(problems).toContain(`${key} is not on the fixture allowlist`);
    }
    expect(problems).toContain('VITE_SUPABASE_URL mentions the production Supabase project');
    expect(problems).toContain(`HERMES_HOME ${join(FAKE_HOME, '.hermes')} is under the real home`);
    expect(() => assertFixtureEnvironment(env, [root], FAKE_HOME)).toThrow('fixture environment rejected');
  });

  test('refuses shim and real-home PATH entries', () => {
    const root = tempDir('atz-wp7-env-');
    const problems = fixtureEnvironmentProblems({...wp0Environment(root), PATH: `/opt/pyenv/shims:${join(FAKE_HOME, '.bun', 'bin')}:/usr/bin`},
      [root], FAKE_HOME);
    expect(problems).toContain('PATH contains a shim directory /opt/pyenv/shims');
    expect(problems).toContain(`PATH entry ${join(FAKE_HOME, '.bun', 'bin')} is under the real home`);
  });
});

describe('work and evidence folders (finding 4)', () => {
  test('selfcheck deletes only the folder it made inside --work-dir, never the parent or its contents', async () => {
    const parent = tempDir('atz-wp7-parent-');
    chmodSync(parent, 0o755);
    writeFileSync(join(parent, 'keep-me'), 'the caller owns this\n');
    const evidenceDir = join(tempDir('atz-wp7-evidence-'), 'run');
    // A missing sandbox-exec ends the run as blocked before anything is built or started; finish() still cleans up.
    const report = await selfcheck({workParent: parent, evidenceDir, sandboxExecPath: '/nonexistent/sandbox-exec', realHome: FAKE_HOME,
      log: () => {}});
    expect(report.status).toBe('blocked');
    expect(readdirSync(parent)).toEqual(['keep-me']);
    expect(statSync(parent).mode & 0o777).toBe(0o755);
    expect(existsSync(join(evidenceDir, 'selfcheck-report.json'))).toBe(true);
  });

  test('the work folder is a fresh private child of the parent, and a parent in the real home is refused', () => {
    const parent = tempDir('atz-wp7-parent-');
    const work = createSelfcheckWorkDir(parent, FAKE_HOME);
    expect(work.startsWith(`${parent}/agentstoz-screen-fixture-`)).toBe(true);
    expect(statSync(work).mode & 0o777).toBe(0o700);
    expect(createSelfcheckWorkDir(parent, FAKE_HOME)).not.toBe(work);
    expect(() => createSelfcheckWorkDir(join(FAKE_HOME, 'scratch'), FAKE_HOME)).toThrow('inside the real home');
  });

  test('an evidence folder must be new or empty', () => {
    const dir = tempDir('atz-wp7-evidence-');
    writeFileSync(join(dir, 'other-run.json'), '{}');
    expect(() => freshEvidenceDirectory(dir)).toThrow('it is not empty');
    expect(freshEvidenceDirectory(join(dir, 'new'))).toBe(join(dir, 'new'));
  });
});

describe('nm gate (finding 5)', () => {
  const otool = (extra = '') => `bin:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n${extra}`;

  test('passes a clean binary, fails a forbidden symbol or framework, and only notes LAContext', () => {
    expect(evaluateGate('/x/host', 'h', '_memcpy\n_VTCompressionSessionCreate\n', otool()).passed).toBe(true);
    const injected = evaluateGate('/x/host', 'h', '_memcpy\n_CGEventPost\n', otool());
    expect(injected).toMatchObject({passed: false, requiredFound: ['CGEventPost']});
    const capture = evaluateGate('/x/host', 'h', '_memcpy\n', otool('\t/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit (x)\n'));
    expect(capture).toMatchObject({passed: false, forbiddenFrameworks: ['ScreenCaptureKit']});
    expect(evaluateGate('/x/host', 'h', '_OBJC_CLASS_$_LAContext\n', otool())).toMatchObject({passed: true, noted: ['LAContext']});
  });

  test('start() refuses an ungated, failed or changed binary before making any folder', async () => {
    const dir = tempDir('atz-wp7-gate-');
    const host = join(dir, 'screen-fixture-host'), viewer = join(dir, 'screen-fixture-viewer');
    writeFileSync(host, 'host bytes');
    writeFileSync(viewer, 'viewer bytes');
    const gate = (binary: string, passed: boolean) => ({...evaluateGate(binary, sha(readFileSync(binary)), '', 'x:\n'), passed});
    const build = (gates: ScreenFixtureBuild['gates']): ScreenFixtureBuild => ({outDir: dir, hostBinary: host, viewerBinary: viewer, coreLibrary: '',
      hostSources: [], seconds: 0, gates});
    const stateDir = join(dir, 'state');
    await expect(start({mode: 'viewer', build: build([gate(host, false), gate(viewer, true)]), stateDir, evidenceDir: join(dir, 'evidence')}))
      .rejects.toThrow('the nm gate did not pass (screen-fixture-host)');
    expect(existsSync(stateDir)).toBe(false);
    expect(() => assertGatedBinary(build([]), host)).toThrow('no gate ran');
    expect(() => assertGatedBinary(build([gate(viewer, true)]), host)).toThrow('was never gated');
    const passed = build([gate(host, true), gate(viewer, true)]);
    expect(() => assertGatedBinary(passed, host)).not.toThrow();
    writeFileSync(host, 'replaced after the gate');
    expect(() => assertGatedBinary(passed, host)).toThrow('changed after the nm gate');
  });
});

describe('checks that measure what they claim (finding 9)', () => {
  test('lsof listeners: only 127.0.0.1, every expected port, no never-port', () => {
    const listeners = parseLsofListeners('p123\nf5\nn127.0.0.1:5000\nf6\nn[::1]:5001\nf7\nn*:5002\n');
    expect(listeners).toEqual([{address: '127.0.0.1', port: 5000}, {address: '::1', port: 5001}, {address: '*', port: 5002}]);
    expect(loopbackOnlyVerdict([{address: '127.0.0.1', port: 5000}], [5000]).passed).toBe(true);
    expect(loopbackOnlyVerdict(listeners, [5000]).problems).toEqual(['listening on ::1:5001', 'listening on *:5002']);
    expect(loopbackOnlyVerdict([{address: '127.0.0.1', port: 5000}], [5000, 5003]).problems).toEqual(['port 5003 not listening']);
    expect(loopbackOnlyVerdict([], [5000]).passed).toBe(false);
    expect(loopbackOnlyVerdict([{address: '127.0.0.1', port: 3001}], [3001]).problems).toEqual(['listening on never-port 3001']);
  });

  const line = (eventMessage: string) => JSON.stringify({eventMessage});
  test('the TCC check does not pass when nothing is recognised in the log', () => {
    const quiet = {...summarizeTccLog(line('something else entirely')), observed: true};
    expect(quiet.recognizedRequests).toBe(0);
    expect(tccVerdict(quiet)).toMatchObject({passed: false});
    expect(tccVerdict({...summarizeTccLog(''), observed: false, error: 'log show exited 1'}).passed).toBe(false);
  });

  test('the TCC check passes preflight-only traffic and fails a fixture prompt', () => {
    const preflight = [
      line('AUTHREQ_CTX: msgID=401.7, function=TCCAccessRequest, service=kTCCServiceListenEvent, preflight=yes, query=1'),
      line('AUTHREQ_ATTRIBUTION: msgID=401.7, attribution={accessing={TCCDProcess: identifier=com.apple.coremedia.videoencoder, pid=1}}'),
    ].join('\n');
    const ok = {...summarizeTccLog(preflight), observed: true};
    expect(ok.videoToolboxService).toMatchObject({requests: 1, preflightOnly: 1, prompts: 0});
    expect(tccVerdict(ok).passed).toBe(true);
    const prompted = [
      preflight,
      line('AUTHREQ_CTX: msgID=402.1, function=TCCAccessRequest, service=kTCCServiceScreenCapture, preflight=no, query=1'),
      line('AUTHREQ_ATTRIBUTION: msgID=402.1, attribution={accessing={TCCDProcess: identifier=screen-fixture-host, pid=2}}'),
      line('AUTHREQ_PROMPTING: msgID=402.1, service=kTCCServiceScreenCapture'),
    ].join('\n');
    const bad = {...summarizeTccLog(prompted), observed: true};
    expect(bad.fixture).toMatchObject({requests: 1, prompts: 1, preflightOnly: 0});
    expect(tccVerdict(bad).passed).toBe(false);
  });

  test('production sources against main: not measured without git metadata', () => {
    const copy = tempDir('atz-wp7-archive-');
    expect(productionSourcesVsMain(copy)).toEqual({measured: false, reason: 'no git metadata for this checkout (a git-archive copy)'});
  });
});

describe('serve and invitations (finding 10)', () => {
  test('serve replies carry the caller id, never the internal counter', () => {
    expect(replyForCaller({op: 'status', id: 'caller-7'}, {event: 'reply', id: 3, ok: true})).toEqual({event: 'reply', ok: true, id: 'caller-7'});
    expect(replyForCaller({op: 'status'}, {event: 'reply', id: 3, ok: true})).toEqual({event: 'reply', ok: true});
  });

  test('only the legacy invitation can reach the counting listener', () => {
    expect([...INVITES_REACHING_COUNTING_LISTENER]).toEqual(['deviceLegacy']);
    const main = readFileSync(join(import.meta.dir, '..', 'native', 'screen-control', 'Tests', 'Fixtures', 'ScreenFixtureHost', 'main.swift'), 'utf8');
    expect(main).toContain('let reachable = ["device": false, "deviceLegacy": true, "controller": false]');
    expect(main).not.toContain('receipts.log("listening", ["host":');
  });
});

describe('orchestrator lane (finding 2)', () => {
  const report = (status: SelfcheckReport['status'], checks: SelfcheckReport['checks'], blockedReason?: string): SelfcheckReport =>
    ({lane: 'screen-host-selfcheck', status, checks, blockedReason, evidenceDir: '/nonexistent/evidence/screen-host', seconds: 1,
      label: {} as SelfcheckReport['label']});

  test('exports the screen-host-selfcheck lane', () => {
    expect(lane.id).toBe('screen-host-selfcheck');
    expect(typeof lane.run).toBe('function');
    expect(lane.title.length).toBeGreaterThan(0);
  });

  test('the orchestrator loads it: `bun scripts/emulator-e2e.ts screen-host-selfcheck` has a loader', async () => {
    expect(typeof LANE_MODULES['screen-host-selfcheck']).toBe('function');
    try {
      expect(await resolveLane('screen-host-selfcheck')).toBe(lane);
    } finally {
      unregisterLane('screen-host-selfcheck');
    }
  });

  test('maps a report to an outcome with a reason for anything but a pass, and labels always', () => {
    const pass = laneOutcomeFromReport(report('pass', [{name: 'build', passed: true}]), '/nonexistent/evidence');
    expect(pass.status).toBe('pass');
    expect(pass.labels?.real.length).toBeGreaterThan(0);
    expect(pass.labels?.standIn.length).toBeGreaterThan(0);
    const fail = laneOutcomeFromReport(report('fail', [{name: 'build', passed: true}, {name: 'sandbox-canary-signal-outside-sandbox-refused', passed: false}]), '/x');
    expect(fail).toMatchObject({status: 'fail', reason: 'failed checks: sandbox-canary-signal-outside-sandbox-refused'});
    expect(laneOutcomeFromReport(report('blocked', [], 'not macOS'), '/x')).toMatchObject({status: 'blocked', reason: 'not macOS'});
  });

  test.skipIf(!macOnly)('run() takes its environments from ctx and its sandbox base from ctx.hostSandbox', async () => {
    const scratchRoot = tempDir('atz-wp7-lane-');
    const evidenceRoot = tempDir('atz-wp7-lane-evidence-');
    const asked: string[] = [];
    const ctx: ScreenHostLaneContext = {
      runId: 'test', repoRoot: '/nonexistent', scratchRoot, home: FAKE_HOME, evidence: {dir: evidenceRoot},
      hostSandbox: {text: WP1_SHAPED_BASE, sha256: sha(WP1_SHAPED_BASE)},
      isolatedProfile: label => { asked.push(label); throw new Error(`stop after ${label}`); },
      allowlistedEnv: () => ({}),
      log: () => {},
    };
    const outcome = await lane.run(ctx);
    // The first environment the selfcheck needs comes from ctx; the stub stops the run there, before anything is built.
    expect(asked).toEqual(['screen-tools']);
    expect(outcome.status).toBe('fail');
    const written = JSON.parse(readFileSync(join(evidenceRoot, 'screen-host', 'selfcheck-report.json'), 'utf8')) as SelfcheckReport;
    expect(written.sandboxBaseSha256).toBe(sha(WP1_SHAPED_BASE));
    expect(JSON.stringify(written.checks)).toContain('stop after screen-tools');
    // The work folder inside the scratch root was removed; the scratch root itself stays for the orchestrator.
    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});

describe.skipIf(!macOnly)('generated profiles under the real sandbox-exec', () => {
  const sandboxed = (profile: string, argv: string[]) => Bun.spawnSync(['/usr/bin/sandbox-exec', '-f', profile, ...argv],
    {env: {PATH: '/usr/bin:/bin'}, stdout: 'pipe', stderr: 'pipe'});
  const listener = async (): Promise<{server: Server; port: number}> => {
    const server = createServer(socket => socket.destroy());
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as {port: number}).port));
    });
    return {server, port};
  };

  for (const [name, base] of [['standalone', undefined], ['after a WP1-shaped base', WP1_SHAPED_BASE],
    ['after a WP1 allowlist-shaped base', WP1_ALLOWLIST_SHAPED_BASE], ['after WP1\'s generated base', WP1_GENERATED_BASE]] as const) {
    test(`${name}: a SIGTERM to an unrelated process is refused and the process lives (finding 1)`, async () => {
      const dir = tempDir('atz-wp7-sig-');
      const scratch = join(dir, 'scratch');
      mkdirSync(scratch, {mode: 0o700});
      const text = screenFixtureSandboxProfile({writable: [scratch], executables: ['/bin/sh', '/bin/bash'], base});
      const {path} = writeFixtureProfile(join(dir, 'profiles'), 'signal', text, [scratch]);
      const bystander = Bun.spawn(['/bin/sleep', '60'], {stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'});
      try {
        const attack = sandboxed(path, ['/bin/sh', '-c', `kill -TERM ${bystander.pid}`]);
        const self = sandboxed(path, ['/bin/sh', '-c', 'kill -0 $$']);
        await Bun.sleep(200);
        expect(attack.exitCode).not.toBe(0);
        expect(attack.stderr.toString()).toContain('Operation not permitted');
        expect(bystander.exitCode).toBeNull();
        expect(bystander.signalCode).toBeNull();
        expect(self.exitCode).toBe(0);
      } finally {
        bystander.kill('SIGKILL');
        await bystander.exited;
      }
    });

    // Repeated: with an outbound deny after the one-port allow, the allowed port failed with EPERM in ~15% of trials.
    test(`${name}: only the allowlisted loopback port is reachable, every time (finding 7)`, async () => {
      const dir = tempDir('atz-wp7-net-');
      const scratch = join(dir, 'scratch');
      mkdirSync(scratch, {mode: 0o700});
      const outcomes: {allowed: number | null; other: number | null}[] = [];
      for (let trial = 0; trial < 30; trial++) {
        const allowed = await listener(), other = await listener();
        try {
          const text = screenFixtureSandboxProfile({writable: [scratch], executables: ['/usr/bin/nc'], outboundPorts: [allowed.port], base});
          const {path} = writeFixtureProfile(join(dir, 'profiles'), 'phone', text, [scratch]);
          outcomes.push({allowed: sandboxed(path, ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', String(allowed.port)]).exitCode,
            other: sandboxed(path, ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', String(other.port)]).exitCode});
        } finally {
          allowed.server.close();
          other.server.close();
        }
      }
      expect(outcomes.filter(outcome => outcome.allowed !== 0)).toEqual([]);
      expect(outcomes.filter(outcome => outcome.other === 0)).toEqual([]);
    }, 60_000);
  }

  test('the measurement behind the corrected comment: a later port deny works after filtered rules (finding 7)', async () => {
    const dir = tempDir('atz-wp7-claim-');
    const denied = await listener(), control = await listener();
    try {
      const write = (name: string, rules: string[]) => {
        const path = join(dir, `${name}.sb`);
        writeFileSync(path, ['(version 1)', '(allow default)', ...rules, ''].join('\n'));
        return path;
      };
      const filtered = write('filtered', ['(deny network-outbound (remote ip "*:*"))', '(allow network-outbound (remote ip "localhost:*"))',
        `(deny network-outbound (remote ip "localhost:${denied.port}"))`]);
      expect(sandboxed(filtered, ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', String(denied.port)]).exitCode).not.toBe(0);
      expect(sandboxed(filtered, ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', String(control.port)]).exitCode).toBe(0);
    } finally {
      denied.server.close();
      control.server.close();
    }
  });
});
