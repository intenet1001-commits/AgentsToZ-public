/**
 * WP8 — J2-SCREEN-SIM: the both-ends judge (scripts/emulator-e2e/screenViewerJudge.ts), the lane's own checks
 * (screenViewerLane.ts), check-ui.py's plans and counts, and static guarantees about the Swift added to the gesture
 * probe (simulator-only, loopback-only). Nothing here builds, boots a simulator or starts the fixture host.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {resolveLane, unregisterLane} from '../scripts/emulator-e2e';
import {detectForbiddenTools, HARNESS_SCAN_PATHS} from '../scripts/emulator-e2e/preflight';
import {formatGate, type NmGateResult} from '../scripts/emulator-e2e/screenFixtureHost';
import {
  EXPECTED_RENDER, EXPECTED_SENT, GESTURE_CLASS, GESTURE_TESTS, MIN_FRAMES, PHONE_ATTACHMENTS, SCOPE_LABEL, SCREEN_VIEWER_CLASS, SCREEN_VIEWER_TESTS,
  canonicalPhoneSent, expectedTestOutcomes, judgeRunDirectory, judgeScreenViewerRun, landingProblems, testCaseOutcomes, tokenForHostEvent,
  type JudgeInput, type PhoneSeen,
} from '../scripts/emulator-e2e/screenViewerJudge';
import {
  J2_EXPECTED, J2_GESTURE_ONLY_EXPECTED, J2_LABELS, J2_PROBE_APP_SOURCES, appTargetSources, laneOutcomeFromCheckUi, loopbackListenerProblems,
  planProblems, productionSourceDigest,
} from '../scripts/emulator-e2e/screenViewerLane';

const root = resolve(import.meta.dir, '..');
const checkUi = join(root, 'mobile/ios/scripts/check-ui.py');
const scratch = mkdtempSync(join(tmpdir(), 'wp8-screen-viewer-'));
afterAll(() => rmSync(scratch, {recursive: true, force: true}));

// MARK: - Synthetic evidence of one good run

const PORT = 50123;
// As an iPhone 17 Pro portrait surface maps them: tap and two-finger tap at the centre, the drag from (0.3, 0.45) to
// (0.7, 0.56) of the surface lands from x 0.3 to 0.7 and y 0.31 to 0.73 of the 16:9 picture.
const sent = 'M(0.5,0.5) L+ L- M(0.5,0.4998) R+ R- M(0.3,0.30625) L+ M(0.41,0.4) M(0.58,0.61) M(0.7,0.7328) L- T:hello';
const gate = (binary: string): NmGateResult => ({binary, sha256: 'a'.repeat(64), passed: true, undefinedSymbols: 100, requiredFound: [],
  extendedFound: [], frameworks: ['/usr/lib/libSystem.B.dylib'], forbiddenFrameworks: [], noted: []});

function hostEvent(token: string): Record<string, unknown> {
  const move = /^M\(([^,]+),([^)]+)\)$/.exec(token);
  if (move) return {kind: 'pointerMove', x: Number(move[1]), y: Number(move[2])};
  if (token.startsWith('T:')) return {kind: 'textAndReturn', text: token.slice(2)};
  const button = {L: 'left', R: 'right', C: 'middle'}[token[0] as 'L' | 'R' | 'C'];
  return {kind: 'button', button, isDown: token[1] === '+'};
}

function goodRun(): JudgeInput {
  const testLog = [...GESTURE_TESTS.map(name => `${GESTURE_CLASS} ${name}`), ...SCREEN_VIEWER_TESTS.map(name => `${SCREEN_VIEWER_CLASS} ${name}`)]
    .map(name => `Test Case '-[AgentsToZMobileUITests.${name}]' passed (2.1 seconds).`).join('\n');
  const device: PhoneSeen = {screenViewerState: 'ended=endedAtMac', screenViewerFrames: 'frames=212', screenViewerRender: EXPECTED_RENDER,
    screenViewerInput: 'input=monitorUnavailable', gestureDelivery: 'left=2 right=1', screenViewerTextResult: 'text=1:posted', screenViewerSent: sent};
  const impostor: PhoneSeen = {screenViewerState: 'impostor=refused', screenViewerFrames: 'frames=0', screenViewerRender: 'failures=0 keyframes=0 status=unknown',
    screenViewerInput: 'input=unknown', gestureDelivery: 'left=0 right=0', screenViewerTextResult: 'text=none', screenViewerSent: 'none'};
  const receipts = [
    {event: 'listening', requestedHost: '127.0.0.1', port: PORT},
    {event: 'ready', mode: 'viewer', pid: 4242},
    {event: 'handshake', outcome: 'failed', peer: '127.0.0.1:60000', reason: 'unknownDevice'},
    {event: 'handshake', outcome: 'accepted', deviceID: 'abc', version: 4, session: 1},
    {event: 'display', session: 1, display: 1, width: 1920, height: 1080},
    {event: 'command', op: 'end', reason: 'endedAtMac', scripted: true},
    {event: 'session-ended', session: 1, deviceID: 'abc', version: 4, outcome: 'endedAtMac', reason: 'endedAtMac', sent: 230},
    {event: 'command', op: 'stop', scripted: true},
    {event: 'stopped', why: 'stop'},
  ];
  const input = sent.split(' ').map(token => ({source: 'phone', session: 1, event: hostEvent(token), ...(token.startsWith('T:') ? {result: 'posted'} : {})}));
  return {
    screenViewer: true,
    testLog,
    phone: {device, impostor},
    hostReady: {event: 'ready', mode: 'viewer', port: PORT, protocolVersion: 4, label: {label: SCOPE_LABEL}},
    receipts: receipts.map(line => JSON.stringify(line)).join('\n') + '\n',
    inputEvents: input.map(line => JSON.stringify(line)).join('\n') + '\n',
    frames: {mode: 'viewer', totals: {offered: 240, skipped: 10, sent: 230, bytes: 9_000_000},
      capture: {delivered: 240, lastWidth: 1920, lastHeight: 1080}},
    nmGate: [gate('/x/ScreenFixtureHost'), gate('/x/ScreenFixtureViewer')].map(formatGate).join('\n'),
  };
}

const jsonl = (lines: Record<string, unknown>[]) => lines.map(line => JSON.stringify(line)).join('\n') + '\n';
const receiptsOf = (run: JudgeInput) => run.receipts.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const inputOf = (run: JudgeInput) => run.inputEvents.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

describe('both-ends judge', () => {
  test('a good run passes, and the expected table is the 7 gesture tests plus the 2 viewer tests', () => {
    const verdict = judgeScreenViewerRun(goodRun());
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.label).toBe('Core+표면만');
    expect(Object.keys(expectedTestOutcomes(true))).toHaveLength(9);
    expect(Object.keys(expectedTestOutcomes(false))).toHaveLength(7);
    expect(verdict.host).toMatchObject({acceptedHandshakes: 1, unknownDeviceRefusals: 1, scriptedEnds: 1, framesSent: 230, nmGatePassed: true,
      releasedHeldInput: 0, tokens: sent});
  });

  test('the host must have recorded the press-and-drag: a tap where the drag should be fails both ends', () => {
    const run = goodRun();
    const withoutDrag = 'M(0.5,0.5) L+ L- M(0.5,0.5) R+ R- M(0.3,0.3) L+ L- T:hello';
    run.phone.device!.screenViewerSent = withoutDrag;
    run.inputEvents = jsonl(withoutDrag.split(' ').map(token => ({source: 'phone', session: 1, event: hostEvent(token), ...(token.startsWith('T:') ? {result: 'posted'} : {})})));
    const verdict = judgeScreenViewerRun(run);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some(problem => problem.startsWith('phone: sent'))).toBe(true);
    expect(verdict.problems.some(problem => problem.startsWith('host: recorded input'))).toBe(true);
  });

  test('what the phone sent must equal what the host recorded, token for token', () => {
    const run = goodRun();
    run.inputEvents = jsonl(inputOf(run).filter((_, index) => index !== 9)); // one move inside the drag lost on the way
    const verdict = judgeScreenViewerRun(run);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some(problem => problem.startsWith('both ends: host recorded'))).toBe(true);
  });

  test('positions: the host must record the exact x,y the phone sent, so a codec that swaps or zeroes them fails', () => {
    const swapped = goodRun();
    swapped.inputEvents = jsonl(inputOf(swapped).map(line => {
      const event = line.event as Record<string, unknown>;
      return event.kind === 'pointerMove' ? {...line, event: {...event, x: event.y, y: event.x}} : line;
    }));
    const swappedVerdict = judgeScreenViewerRun(swapped);
    expect(swappedVerdict.ok).toBe(false);
    expect(swappedVerdict.problems.some(problem => problem.startsWith('both ends: host recorded'))).toBe(true);
    const zeroed = goodRun();
    zeroed.inputEvents = jsonl(inputOf(zeroed).map(line => (line.event as Record<string, unknown>).kind === 'pointerMove'
      ? {...line, event: {kind: 'pointerMove', x: 0, y: 0}} : line));
    const zeroedVerdict = judgeScreenViewerRun(zeroed);
    expect(zeroedVerdict.problems.some(problem => problem.startsWith('both ends: host recorded'))).toBe(true);
    expect(zeroedVerdict.problems.some(problem => problem.startsWith('host: the tap landed at (0, 0)'))).toBe(true);
    // One move off by the smallest step a Double can take is still a mismatch.
    const nudged = goodRun();
    nudged.inputEvents = jsonl(inputOf(nudged).map((line, index) => index === 0 ? {...line, event: {kind: 'pointerMove', x: 0.5000000000000001, y: 0.5}} : line));
    expect(judgeScreenViewerRun(nudged).problems.some(problem => problem.startsWith('both ends: host recorded'))).toBe(true);
  });

  test('positions: a surface that maps touches to the wrong place fails even when both ends agree', () => {
    const misplaced = (line: string): JudgeInput => {
      const run = goodRun();
      run.phone.device!.screenViewerSent = line;
      run.inputEvents = jsonl(line.split(' ').map(token => ({source: 'phone', session: 1, event: hostEvent(token), ...(token.startsWith('T:') ? {result: 'posted'} : {})})));
      return run;
    };
    const backwards = judgeScreenViewerRun(misplaced('M(0.5,0.5) L+ L- M(0.5,0.5) R+ R- M(0.7,0.3) L+ M(0.5,0.5) M(0.3,0.7) L- T:hello'));
    expect(backwards.problems.filter(problem => problem.startsWith('both ends'))).toEqual([]);
    expect(backwards.problems).toContain('host: the drag went from x 0.7 to x 0.3, expected about 0.3 to 0.7');
    expect(backwards.problems.some(problem => problem.startsWith("host: the drag's x did not rise steadily"))).toBe(true);
    const clamped = judgeScreenViewerRun(misplaced('M(0.5,0.5) L+ L- M(0.5,0.5) R+ R- M(0.3,0) L+ M(0.5,0.4) M(0.7,1) L- T:hello'));
    expect(clamped.problems).toContain("host: drag point(s) at the picture's edge (clamped, outside the 16:9 band): (0.3, 0), (0.7, 1)");
    const corner = judgeScreenViewerRun(misplaced('M(0.1,0.9) L+ L- M(0.9,0.1) R+ R- M(0.3,0.3) L+ M(0.5,0.5) M(0.7,0.7) L- T:hello'));
    expect(corner.problems).toContain('host: the tap landed at (0.1, 0.9), expected within 0.05 of (0.5, 0.5)');
    expect(corner.problems).toContain('host: the two-finger tap landed at (0.9, 0.1), expected within 0.1 of (0.5, 0.5)');
    const flat = judgeScreenViewerRun(misplaced('M(0.5,0.5) L+ L- M(0.5,0.5) R+ R- M(0.3,0.5) L+ M(0.5,0.5) M(0.7,0.5) L- T:hello'));
    expect(flat.problems).toContain("host: the drag's y did not rise (0.5 to 0.5)");
    expect(landingProblems(sent)).toEqual([]);
  });

  test("positions: the phone's Swift spelling of a Double compares as that Double", () => {
    expect(canonicalPhoneSent('M(1.0,1e-05) L+ M(0.30000000000000004,0.5) T:hello')).toBe('M(1,0.00001) L+ M(0.30000000000000004,0.5) T:hello');
    expect(canonicalPhoneSent('M(0.5) L+')).toBeNull();
    expect(canonicalPhoneSent('M(nan,0.5)')).toBeNull();
    expect(canonicalPhoneSent(undefined)).toBeNull();
    const spelled = goodRun();
    spelled.phone.device!.screenViewerSent = sent.replace('M(0.5,0.5) L+ L-', 'M(0.50,5e-1) L+ L-');
    expect(judgeScreenViewerRun(spelled).problems).toEqual([]);
  });

  test('pictures received but not shown: a display layer failure or a recovery keyframe fails the run', () => {
    for (const render of ['failures=1 keyframes=1 status=rendering', 'failures=0 keyframes=0 status=failed', 'failures=0 keyframes=0 status=unknown']) {
      const run = goodRun();
      run.phone.device!.screenViewerRender = render;
      expect(judgeScreenViewerRun(run).problems).toContain(`phone: render ${JSON.stringify(render)}, expected "${EXPECTED_RENDER}" (pictures received but not shown)`);
    }
    const missing = goodRun();
    delete missing.phone.device!.screenViewerRender;
    expect(judgeScreenViewerRun(missing).ok).toBe(false);
  });

  test('an impostor the Mac let in, or a phone that saw it as connected, fails', () => {
    const accepted = goodRun();
    accepted.receipts = jsonl(receiptsOf(accepted).map(line => line.reason === 'unknownDevice' ? {event: 'handshake', outcome: 'accepted', deviceID: 'evil', version: 4, session: 2} : line));
    const acceptedVerdict = judgeScreenViewerRun(accepted);
    expect(acceptedVerdict.problems).toContain('host: 2 accepted handshakes, expected exactly 1 (the pinned probe key)');
    expect(acceptedVerdict.problems).toContain('host: no handshake refused as unknownDevice (the impostor key)');
    const phone = goodRun();
    phone.phone.impostor!.screenViewerState = 'impostor=unreachable closed';
    expect(judgeScreenViewerRun(phone).problems.some(problem => problem.startsWith('phone: impostor state'))).toBe(true);
  });

  test(`fewer than ${MIN_FRAMES} frames at either end fails`, () => {
    const host = goodRun();
    host.frames = {...host.frames, totals: {sent: 12}};
    expect(judgeScreenViewerRun(host).problems).toContain(`host: frames.json sent 12, expected at least ${MIN_FRAMES}`);
    const phone = goodRun();
    phone.phone.device!.screenViewerFrames = 'frames=29';
    expect(judgeScreenViewerRun(phone).problems).toContain(`phone: frames=29, expected at least ${MIN_FRAMES}`);
  });

  test('held input released by the host, an unscripted Mac command, no clean stop or a failed nm gate fail', () => {
    const released = goodRun();
    released.inputEvents += JSON.stringify({source: 'release', session: 1, event: {kind: 'button', button: 'left', isDown: false}}) + '\n';
    expect(judgeScreenViewerRun(released).problems).toContain('host: 1 input line(s) not from the phone (held input released)');
    const unscripted = goodRun();
    unscripted.receipts = jsonl(receiptsOf(unscripted).map(line => line.op === 'end' ? {...line, scripted: false} : line));
    expect(judgeScreenViewerRun(unscripted).problems).toContain('host: a Mac command not marked scripted');
    const unstopped = goodRun();
    unstopped.receipts = jsonl(receiptsOf(unstopped).filter(line => line.event !== 'stopped'));
    expect(judgeScreenViewerRun(unstopped).problems).toContain('host: no stopped receipt (did not stop cleanly)');
    const gated = goodRun();
    gated.nmGate = formatGate({...gate('/x/ScreenFixtureHost'), passed: false, requiredFound: ['CGEventPost']});
    expect(judgeScreenViewerRun(gated).problems).toContain('host: nm gate failed');
  });

  test('a missing, skipped or extra test fails; the session must end at the Mac', () => {
    const skipped = goodRun();
    skipped.testLog = skipped.testLog.replace(/(testImpostorKeyIsRefusedByTheMac\]') passed/, '$1 skipped');
    expect(judgeScreenViewerRun(skipped).problems.some(problem => problem.includes('testImpostorKeyIsRefusedByTheMac: skipped'))).toBe(true);
    const extra = goodRun();
    extra.testLog += "\nTest Case '-[AgentsToZMobileUITests.ScreenViewerUITests testSomethingElse]' passed (1.0 seconds).";
    expect(judgeScreenViewerRun(extra).problems).toContain('unexpected test ScreenViewerUITests.testSomethingElse (passed)');
    const phoneClosed = goodRun();
    phoneClosed.receipts = jsonl(receiptsOf(phoneClosed).map(line => line.event === 'session-ended' ? {...line, reason: 'phoneClosed'} : line));
    expect(judgeScreenViewerRun(phoneClosed).problems.some(problem => problem.startsWith('host: the accepted session did not end with endedAtMac'))).toBe(true);
  });

  test('without the viewer tests only the 7 gesture outcomes are judged', () => {
    const run = goodRun();
    run.screenViewer = false;
    run.testLog = run.testLog.split('\n').filter(line => !line.includes(SCREEN_VIEWER_CLASS)).join('\n');
    run.phone = {device: null, impostor: null};
    run.receipts = run.inputEvents = '';
    run.hostReady = run.frames = run.nmGate = null;
    expect(judgeScreenViewerRun(run)).toMatchObject({ok: true, problems: []});
    run.testLog += "\nTest Case '-[AgentsToZMobileUITests.ScreenViewerUITests testImpostorKeyIsRefusedByTheMac]' passed (1.0 seconds).";
    expect(judgeScreenViewerRun(run).ok).toBe(false);
  });

  test('host input JSON maps to the probe tokens; unknown shapes are unreadable', () => {
    expect(tokenForHostEvent({kind: 'pointerMove', x: 0, y: 0})).toBe('M(0,0)');
    expect(tokenForHostEvent({kind: 'pointerMove', x: 0.25, y: 1})).toBe('M(0.25,1)');
    expect(tokenForHostEvent({kind: 'pointerMove', x: 0.25})).toBeNull();
    expect(tokenForHostEvent({kind: 'button', button: 'right', isDown: true})).toBe('R+');
    expect(tokenForHostEvent({kind: 'key', code: 36, isDown: false, modifiers: 0})).toBe('K36-');
    expect(tokenForHostEvent({kind: 'textAndReturn', text: 'hello'})).toBe('T:hello');
    expect(tokenForHostEvent({kind: 'button', button: 'left'})).toBeNull();
    expect(tokenForHostEvent({kind: 'teleport'})).toBeNull();
    expect(testCaseOutcomes("Test Case '-[AgentsToZMobileUITests.ScreenGestureUITests testFingerTapProducesLeftClick]' failed (3.0 seconds).")).toEqual({
      'ScreenGestureUITests.testFingerTapProducesLeftClick': 'failed'});
  });

  test('the run folder layout check-ui.py writes is read back, and the CLI exits 0 / 1 / 64', () => {
    const run = goodRun();
    const dir = join(scratch, 'run-good');
    mkdirSync(join(dir, 'screen-host'), {recursive: true});
    mkdirSync(join(dir, 'attachments'), {recursive: true});
    writeFileSync(join(dir, 'test.log'), run.testLog);
    writeFileSync(join(dir, 'screen-host-ready.json'), JSON.stringify(run.hostReady));
    writeFileSync(join(dir, 'screen-host/host-receipts.jsonl'), run.receipts);
    writeFileSync(join(dir, 'screen-host/input-events.jsonl'), run.inputEvents);
    writeFileSync(join(dir, 'screen-host/frames.json'), JSON.stringify(run.frames));
    writeFileSync(join(dir, 'screen-host/nm-gate.txt'), run.nmGate!);
    writeFileSync(join(dir, 'attachments/a.json'), JSON.stringify(run.phone.device));
    writeFileSync(join(dir, 'attachments/b.json'), JSON.stringify(run.phone.impostor));
    writeFileSync(join(dir, 'attachments/manifest.json'), JSON.stringify([
      {testIdentifier: 'ScreenViewerUITests/testViewerStreamsFixtureMacAndSendsGestures()', attachments: [
        {exportedFileName: 'a.json', suggestedHumanReadableName: `${PHONE_ATTACHMENTS.device}_0_ABC.json`}]},
      {testIdentifier: 'ScreenViewerUITests/testImpostorKeyIsRefusedByTheMac()', attachments: [
        {exportedFileName: 'b.json', suggestedHumanReadableName: `${PHONE_ATTACHMENTS.impostor}_0_DEF.json`},
        {exportedFileName: '../escape.json', suggestedHumanReadableName: `${PHONE_ATTACHMENTS.device}_1.json`}]},
    ]));
    expect(judgeRunDirectory(dir).problems).toEqual([]);
    const cli = (args: string[]) => Bun.spawnSync([process.execPath, '--env-file=/dev/null', 'scripts/emulator-e2e/screenViewerJudge.ts', ...args],
      {cwd: root, stdout: 'pipe', stderr: 'pipe'});
    const good = cli(['judge', '--run-dir', dir]);
    expect(good.exitCode).toBe(0);
    expect(JSON.parse(good.stdout.toString()).ok).toBe(true);
    rmSync(join(dir, 'screen-host/frames.json'));
    const bad = cli(['judge', '--run-dir', dir]);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout.toString()).problems).toContain('host: frames.json sent null, expected at least 30');
    expect(cli(['judge']).exitCode).toBe(64);
  });
});

// MARK: - check-ui.py plans and counts

function plan(args: string[]): Record<string, any> {
  const out = Bun.spawnSync(['/usr/bin/python3', '-I', checkUi, ...args, '--plan'], {cwd: root, stdout: 'pipe', stderr: 'pipe'});
  expect(out.exitCode).toBe(0);
  return JSON.parse(out.stdout.toString());
}

describe('check-ui.py --screen-gestures', () => {
  test('plans: viewer 9/0 with the fixture host and the judge, gesture-only 7/0 without them, device never a viewer', () => {
    const viewer = plan(['--screen-gestures']);
    const gestureOnly = plan(['--screen-gestures', '--no-screen-viewer']);
    const device = plan(['--device', '00000000-0000000000000000']);
    expect(viewer.expected).toEqual(J2_EXPECTED);
    expect(gestureOnly.expected).toEqual(J2_GESTURE_ONLY_EXPECTED);
    expect(device.screenViewer).toBe(false);
    expect(planProblems({viewer, gestureOnly, device})).toEqual([]);
    const commands = viewer.commands as string[][];
    const host = commands.findIndex(argv => argv.includes('scripts/emulator-e2e/screenFixtureHost.ts'));
    const tests = commands.findIndex(argv => argv.includes('test-without-building'));
    expect(commands[host]).toEqual(['bun', '--env-file=/dev/null', 'scripts/emulator-e2e/screenFixtureHost.ts', 'serve', '--mode', 'viewer',
      '--state-dir', '<owner-only scratch>', '--evidence-dir', '<evidence>/screen-host']);
    expect(host).toBeGreaterThan(-1);
    expect(host).toBeLessThan(tests);
    expect(JSON.stringify(commands)).not.toMatch(/\b(3001|52741|4723)\b/);
    expect(planProblems({viewer: gestureOnly, gestureOnly: viewer, device})).not.toEqual([]);
  });

  test('the gesture-only fallback compiles everything the probe refers to (the viewer mode is chosen at launch)', () => {
    const viewer = plan(['--screen-gestures']);
    const gestureOnly = plan(['--screen-gestures', '--no-screen-viewer']);
    expect(appTargetSources(viewer)).toEqual([...J2_PROBE_APP_SOURCES].sort());
    expect(appTargetSources(gestureOnly)).toEqual(appTargetSources(viewer));
    // Every top-level name another Fixtures file declares and the probe uses: that file must be in both app targets.
    const fixtures = 'mobile/ios/UITests/Fixtures';
    const probe = readFileSync(join(root, fixtures, 'ScreenGestureProbeApp.swift'), 'utf8');
    const needed = new Set<string>();
    for (const file of readdirSync(join(root, fixtures)).filter(name => name.endsWith('.swift') && name !== 'ScreenGestureProbeApp.swift')) {
      const declared = [...readFileSync(join(root, fixtures, file), 'utf8').matchAll(/^(?:(?:public|internal|final|private|fileprivate)\s+)*(?:class|struct|enum|actor|protocol|typealias|let|var|func)\s+(\w+)/gm)]
        .map(match => match[1]!);
      expect(declared.length).toBeGreaterThan(0);
      if (declared.some(name => new RegExp(`\\b${name}\\b`).test(probe))) needed.add(`${fixtures}/${file}`);
    }
    expect([...needed]).toContain(`${fixtures}/LoopbackFrameTransport.swift`);
    for (const file of needed) {
      expect(appTargetSources(gestureOnly)).toContain(file);
      expect(appTargetSources(viewer)).toContain(file);
    }
    // Only the viewer UI tests (which need the fixture host) stay out of the fallback.
    const tests = (value: Record<string, any>) => (value.gestureProjectSources as Array<{source: string; as: string}>).filter(item => item.as.startsWith('UITests/')).map(item => item.source);
    expect(tests(gestureOnly)).toEqual(['mobile/ios/UITests/ScreenGestureUITests.swift']);
    expect(tests(viewer)).toEqual(['mobile/ios/UITests/ScreenGestureUITests.swift', 'mobile/ios/UITests/ScreenViewerUITests.swift']);
    const broken = {...gestureOnly, gestureProjectSources: gestureOnly.gestureProjectSources.filter((item: {source: string}) => !item.source.endsWith('LoopbackFrameTransport.swift'))};
    expect(planProblems({viewer, gestureOnly: broken, device: plan(['--device', '00000000-0000000000000000'])}).some(problem => problem.startsWith("the gesture-only plan's app target compiles"))).toBe(true);
  });

  test('step limits stay as design §7 has them: build 600 s, boot 480 s, tests 600 s', () => {
    const script = readFileSync(checkUi, 'utf8');
    expect(script).toContain('command(build_args(derived), timeout=900 if device else 600, log="build.log")');
    expect(script).toContain('timeout=480, log="boot.log"');
    expect(script).toContain('"-resultBundlePath", str(result), *only_boundary], timeout=600, log="test.log", allow_failure=True)');
  });

  test('the unmeasured combined ios-ui budget keeps viewer tests in the opt-in J2 lane', () => {
    const suite = readFileSync(join(root, 'mobile/ios/scripts/check-ui-suite.py'), 'utf8');
    expect(suite).toContain('["--screen-gestures", "--no-screen-viewer"]');
    expect(plan(['--screen-gestures']).screenViewer).toBe(true);
  });

  test('the counts match the Swift test functions and the judge table', () => {
    const functions = (file: string) => [...readFileSync(join(root, file), 'utf8').matchAll(/func (test\w+)\(/g)].map(match => match[1]).sort();
    expect(functions('mobile/ios/UITests/ScreenGestureUITests.swift')).toEqual([...GESTURE_TESTS].sort());
    expect(functions('mobile/ios/UITests/ScreenViewerUITests.swift')).toEqual([...SCREEN_VIEWER_TESTS].sort());
    expect(J2_EXPECTED.passed).toBe(GESTURE_TESTS.length + SCREEN_VIEWER_TESTS.length);
    expect(J2_GESTURE_ONLY_EXPECTED.passed).toBe(GESTURE_TESTS.length);
    const script = readFileSync(checkUi, 'utf8');
    expect(script).toContain(`GESTURE_LANE_PASSES = ${GESTURE_TESTS.length}`);
    expect(script).toContain(`SCREEN_VIEWER_PASSES = ${SCREEN_VIEWER_TESTS.length}`);
  });

  test('host flags are refused outside --screen-gestures and together with --no-screen-viewer', () => {
    const run = (args: string[]) => Bun.spawnSync(['/usr/bin/python3', '-I', checkUi, ...args, '--plan'], {cwd: root, stdout: 'pipe', stderr: 'pipe'});
    expect(run(['--no-screen-viewer']).exitCode).toBe(2);
    expect(run(['--screen-host-state-parent', '/tmp']).exitCode).toBe(2);
    expect(run(['--screen-gestures', '--no-screen-viewer', '--screen-host-sandbox-base', '/tmp/x.sb']).exitCode).toBe(2);
    expect(run(['--screen-gestures', '--device', '00000000-0000000000000000']).exitCode).toBe(2);
  });

  test('the copied project has exactly one place for each added source (what check-ui.py adds beside)', () => {
    const converted = Bun.spawnSync(['/usr/bin/plutil', '-convert', 'json', '-o', '-', join(root, 'mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj')], {stdout: 'pipe'});
    const objects = (JSON.parse(converted.stdout.toString()) as {objects: Record<string, any>}).objects;
    const script = readFileSync(checkUi, 'utf8');
    for (const sibling of ['AgentsToZMobileApp.swift', 'WorkspaceUITests.swift']) {
      expect(script).toContain(`"${sibling}")`);
      const references = Object.entries(objects).filter(([, item]) => item.isa === 'PBXFileReference' && item.path === sibling).map(([key]) => key);
      expect(references).toHaveLength(1);
      expect(Object.values(objects).filter(item => item.isa === 'PBXGroup' && (item.children ?? []).includes(references[0]))).toHaveLength(1);
      const built = Object.entries(objects).filter(([, item]) => item.isa === 'PBXBuildFile' && item.fileRef === references[0]).map(([key]) => key);
      expect(built).toHaveLength(1);
      expect(Object.values(objects).filter(item => item.isa === 'PBXSourcesBuildPhase' && (item.files ?? []).includes(built[0]))).toHaveLength(1);
    }
  });
});

// MARK: - Swift: simulator-only, loopback-only

describe('probe sources', () => {
  const read = (file: string) => readFileSync(join(root, file), 'utf8');

  test('every viewer UI test runs only in a simulator and skips on a device', () => {
    const source = read('mobile/ios/UITests/ScreenViewerUITests.swift');
    for (const name of SCREEN_VIEWER_TESTS) {
      const body = source.slice(source.indexOf(`func ${name}()`)).split(/\n    func test/)[0]!;
      expect(body).toMatch(/^func \w+\(\) throws \{\n\s+#if targetEnvironment\(simulator\)/);
      expect(body).toMatch(/#else\n\s+throw XCTSkip\(/);
    }
    expect(source).toContain(`static let expectedSent = #"${EXPECTED_SENT.source}"#`);
    expect(source).toContain(`static let expectedRender = "${EXPECTED_RENDER}"`);
    expect(source).toContain('"screenViewerRender"');
    expect(source).toContain(`"${PHONE_ATTACHMENTS.device}"`);
    expect(source).toContain(`"${PHONE_ATTACHMENTS.impostor}"`);
  });

  test('the loopback transport compiles only for the simulator, connects only to 127.0.0.1 and refuses reserved ports', () => {
    const source = read('mobile/ios/UITests/Fixtures/LoopbackFrameTransport.swift');
    expect(source).toMatch(/^#if targetEnvironment\(simulator\)$/m);
    expect(source).toMatch(/^#else\n#error\(/m);
    expect(source).toContain('let loopbackProbeDeniedPorts: Set<UInt16> = [3001, 52741, 4723]');
    expect(source).toContain('.hostPort(host: .ipv4(.loopback), port: nwPort)');
    expect(source).toContain('parameters.includePeerToPeer = false');
    expect(source).toContain('usesInterfaceType(.loopback)');
    expect(source).not.toMatch(/NWBrowser|NWListener|Bonjour|\.wifi/);
  });

  test('the viewer mode is reached only through --screen-viewer and uses no Secure Enclave, keychain or Face ID', () => {
    const source = read('mobile/ios/UITests/Fixtures/ScreenGestureProbeApp.swift');
    expect(source).toContain('if ProcessInfo.processInfo.arguments.contains("--screen-viewer") { ScreenViewerProbe() } else { GestureProbe() }');
    expect(source).toContain('ScreenViewer.connect(over: transport, mac: configuration.mac, signer: ProbeSoftwareSigner(key: configuration.key))');
    expect(source).toContain('ScreenSurface.SurfaceView(hosted: display)');
    // The judge compares positions exactly: the probe records the Doubles it sends, and counts display layer failures.
    expect(source).toContain('case let .pointerMove(x, y): token = "M(\\(x),\\(y))"');
    expect(source).toContain('renderLabel.text = "failures=\\(renderFailures) keyframes=\\(keyframeRequests) status=\\(name)"');
    expect(source).not.toMatch(/SecureEnclave|SecItem|LAContext|LocalAuthentication|ScreenClient\.open/);
  });

  test('the files this package added are scanned by preflight and name no forbidden tool', () => {
    const files = ['mobile/ios/UITests/Fixtures/LoopbackFrameTransport.swift', 'mobile/ios/UITests/ScreenViewerUITests.swift'];
    for (const file of files) expect(HARNESS_SCAN_PATHS).toContain(file);
    const scanned = [...files, 'mobile/ios/UITests/Fixtures/ScreenGestureProbeApp.swift', 'mobile/ios/scripts/check-ui.py',
      'scripts/emulator-e2e/screenViewerJudge.ts', 'scripts/emulator-e2e/screenViewerLane.ts'].map(path => ({path, text: read(path)}));
    expect(detectForbiddenTools(scanned)).toEqual([]);
  });
});

// MARK: - The lane's own checks

describe('lane j2', () => {
  test('registered under j2, labelled Core+표면만 on both sides of the evidence label', async () => {
    const lane = await resolveLane('j2');
    try {
      expect(lane?.id).toBe('j2');
      expect(lane?.preconditions?.({} as never)).toEqual([]);
    } finally {
      unregisterLane('j2');
    }
    expect(J2_LABELS.real.some(item => item.includes('Core+표면만'))).toBe(true);
    expect(J2_LABELS.standIn.some(item => item.includes('Core+표면만'))).toBe(true);
    expect(J2_LABELS.standIn.join('\n')).toContain('synthetic NV12');
  });

  const passed = {exitCode: 0, timedOut: false, summary: {passedTests: 9, skippedTests: 0, failedTests: 0},
    result: {state: 'passed', mode: 'screen-gestures', screenViewer: true, expected: {passed: 9, skipped: 0},
      screenViewerVerdict: {ok: true}, screenViewerHost: {stateRemoved: true, exit: 0, port: PORT, barObservedByPhone: true, bar: {status: {title: 'iPhone ‘Fixture Phone’ · 조작 중'}, pause: {title: 'iPhone ‘Fixture Phone’ · 원격 입력 멈춤', held: true}, view: {title: 'iPhone ‘Fixture Phone’ · 보는 중', held: true}}}}};

  test('check-ui.py result → outcome: pass only with the viewer run, 9/0/0, an ok verdict and a cleaned host', () => {
    expect(laneOutcomeFromCheckUi(passed)).toEqual({status: 'pass'});
    expect(laneOutcomeFromCheckUi({...passed, result: {...passed.result, screenViewerHost: {...passed.result.screenViewerHost, bar: {}}}}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({...passed, result: {...passed.result, screenViewerHost: {...passed.result.screenViewerHost, barObservedByPhone: false}}}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({...passed, result: null}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({...passed, timedOut: true}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({...passed, result: {...passed.result, screenViewer: false}}).reason).toContain('did not run the viewer tests');
    expect(laneOutcomeFromCheckUi({...passed, summary: {passedTests: 7, skippedTests: 2, failedTests: 0}}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({...passed, result: {...passed.result, screenViewerHost: {stateRemoved: false, exit: 0}}}).reason).toContain('was not removed');
    expect(laneOutcomeFromCheckUi({...passed, exitCode: 1, result: {...passed.result, state: 'failed', problems: ['x']}})).toEqual({status: 'fail', reason: 'check-ui.py exit 1: x'});
  });

  test('listeners: 127.0.0.1 only, no reserved port, and the fixture port seen when the run passed', () => {
    expect(loopbackListenerProblems([{address: '127.0.0.1', port: PORT}], PORT, true)).toEqual([]);
    expect(loopbackListenerProblems([], PORT, true)).toEqual([`the fixture port 127.0.0.1:${PORT} was never seen listening`]);
    expect(loopbackListenerProblems([], PORT, false)).toEqual([]);
    expect(loopbackListenerProblems([{address: '*', port: PORT}], PORT, true)).toContain(`listener on *:${PORT} (only 127.0.0.1 is allowed)`);
    expect(loopbackListenerProblems([{address: '127.0.0.1', port: 3001}], null, false)).toEqual(['listener on reserved port 3001']);
  });

  test('the production source digest covers the app and ScreenControlCore and changes when a file does', () => {
    const fake = join(scratch, 'repo');
    mkdirSync(join(fake, 'mobile/ios/App'), {recursive: true});
    writeFileSync(join(fake, 'mobile/ios/App/A.swift'), 'let a = 1');
    const before = productionSourceDigest(fake);
    writeFileSync(join(fake, 'mobile/ios/App/A.swift'), 'let a = 2');
    expect(productionSourceDigest(fake).digest).not.toBe(before.digest);
    expect(productionSourceDigest(root).files).toBeGreaterThan(20);
  });
});
