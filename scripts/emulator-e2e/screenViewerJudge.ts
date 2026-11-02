/**
 * J2-SCREEN-SIM (WP8) — the verdict over both ends of one `check-ui.py --screen-gestures` run, from its evidence folder
 * only: the phone (the probe's XCUITest outcomes and the labels each viewer test attached) and the Mac (the fixture
 * Screen host's receipts, recorded input with its exact pointer positions, frame totals and nm gate). check-ui.py runs it after the tests (so a manifest
 * run of `ios-ui` is judged the same way) and the orchestrator lane (screenViewerLane.ts) runs it again on the same
 * folder. Pure apart from reading files; imports node builtins only, so check-ui.py can call it through bun:
 *
 *   bun --env-file=/dev/null scripts/emulator-e2e/screenViewerJudge.ts judge --run-dir <check-ui run folder>
 *
 * prints one JSON verdict and exits 0 when it holds, 1 when it does not, 64 on a usage error.
 *
 * Run folder layout (check-ui.py): test.log · attachments/manifest.json (+ exported files) · screen-host-ready.json ·
 * screen-host/{host-receipts.jsonl, input-events.jsonl, frames.json, nm-gate.txt}.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

export const SCREEN_VIEWER_CLASS = 'ScreenViewerUITests';
export const SCREEN_VIEWER_TESTS = Object.freeze(['testImpostorKeyIsRefusedByTheMac', 'testViewerStreamsFixtureMacAndSendsGestures'] as const);
/** The production touch-surface tests the gesture lane already ran before the viewer mode existed. */
export const GESTURE_CLASS = 'ScreenGestureUITests';
export const GESTURE_TESTS = Object.freeze([
  'testFingerTapProducesLeftClick',
  'testKeyboardPanelSpaceButtonsRouteTheRequestedAction',
  'testReturnAndKeypadEnterMapToMacKeys',
  'testReturnCommitsMarkedCompositionAndSubmitsOnce',
  'testTextReturnDraftIsRetainedUntilMatchingPostedReceipt',
  'testTrackpadDiscardsPausedInputAndUsesResynchronizedMacPointer',
  'testTwoFingerTapProducesRightClick',
] as const);
/** The phone's input, in order: tap, two-finger tap, press-and-drag (at least one move while held), text with Return.
 * Every move carries its x,y. The same expression as ScreenViewerUITests.expectedSent. */
export const EXPECTED_SENT = /^M\([^ (),]+,[^ (),]+\) L\+ L- M\([^ (),]+,[^ (),]+\) R\+ R- M\([^ (),]+,[^ (),]+\) L\+( M\([^ (),]+,[^ (),]+\))+ L- T:hello$/;
export const MIN_FRAMES = 30;
/** The probe's display layer never failed and showed the stream (ScreenViewerUITests.expectedRender). */
export const EXPECTED_RENDER = 'failures=0 keyframes=0 status=rendering';
/**
 * Where the gestures must land on the Mac (fractions of the 1920x1080 picture). The UI test taps the surface's centre,
 * two-finger taps its centre and drags from (0.3, 0.45) to (0.7, 0.56) of the full-screen surface: a 16:9 picture fills
 * the full width and the middle band of a portrait phone, so x maps one to one and the drag's y stays inside the band.
 */
export const LANDING = Object.freeze({
  tap: {x: 0.5, y: 0.5, tolerance: 0.05},
  twoFingerTap: {x: 0.5, y: 0.5, tolerance: 0.1},
  dragX: {from: 0.3, to: 0.7, tolerance: 0.05},
  /** A drag point at 0 or 1 was clamped to an edge: it left the picture. */
  insideBand: {min: 0.02, max: 0.98},
});
export const SCOPE_LABEL = 'Core+표면만';
export const PHONE_ATTACHMENTS = Object.freeze({device: 'screen-viewer-phone-device', impostor: 'screen-viewer-phone-impostor'});

export type TestOutcome = 'passed' | 'failed' | 'skipped';
type Json = Record<string, unknown>;

/** `Test Case '-[AgentsToZMobileUITests.<Class> <name>]' passed|failed|skipped` lines of xcodebuild's test.log. */
export function testCaseOutcomes(log: string): Record<string, TestOutcome> {
  const out: Record<string, TestOutcome> = {};
  for (const match of log.matchAll(/Test Case '-\[AgentsToZMobileUITests\.(\w+) (\w+)\]' (passed|failed|skipped)/g)) {
    out[`${match[1]}.${match[2]}`] = match[3] as TestOutcome;
  }
  return out;
}

/** Every test this lane expects, and that each one passed. */
export function expectedTestOutcomes(screenViewer: boolean): Record<string, TestOutcome> {
  const names = [...GESTURE_TESTS.map(name => `${GESTURE_CLASS}.${name}`),
    ...(screenViewer ? SCREEN_VIEWER_TESTS.map(name => `${SCREEN_VIEWER_CLASS}.${name}`) : [])];
  return Object.fromEntries(names.sort().map(name => [name, 'passed' as const]));
}

/** One JSON object per line; a line that does not parse is counted, not thrown. */
export function parseJsonLines(text: string): {lines: Json[]; malformed: number} {
  const lines: Json[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) lines.push(value as Json); else malformed += 1;
    } catch { malformed += 1; }
  }
  return {lines, malformed};
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A pointer move token in its one canonical spelling: JavaScript's shortest round-trip text of each Double. */
export const moveToken = (x: number, y: number): string => `M(${x},${y})`;

/** The probe's token for one input event as the fixture host records it (FixtureInputJSON); null for an unknown shape. */
export function tokenForHostEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const value = event as Json;
  switch (value.kind) {
    case 'pointerMove': return finiteNumber(value.x) && finiteNumber(value.y) ? moveToken(value.x, value.y) : null;
    case 'button': {
      const letter = value.button === 'left' ? 'L' : value.button === 'right' ? 'R' : value.button === 'middle' ? 'C' : null;
      return letter && typeof value.isDown === 'boolean' ? `${letter}${value.isDown ? '+' : '-'}` : null;
    }
    case 'scroll': return 'S';
    case 'key': return typeof value.code === 'number' && typeof value.isDown === 'boolean' ? `K${value.code}${value.isDown ? '+' : '-'}` : null;
    case 'text': return typeof value.text === 'string' ? `X:${value.text}` : null;
    case 'textAndReturn': return typeof value.text === 'string' ? `T:${value.text}` : null;
    default: return null;
  }
}

/**
 * The probe's `screenViewerSent` label with each move re-spelled canonically. The probe writes Swift's shortest
 * round-trip text of the Double it sent ("0.5", "1.0", "1e-05"); parsing that gives the same Double, so the two ends
 * compare exactly. Null when a move is not two finite numbers.
 */
export function canonicalPhoneSent(label: string | null | undefined): string | null {
  if (typeof label !== 'string') return null;
  const tokens = label.split(' ').map(token => {
    if (!token.startsWith('M(')) return token;
    const match = /^M\(([^ (),]+),([^ (),]+)\)$/.exec(token);
    const x = match ? Number(match[1]) : NaN, y = match ? Number(match[2]) : NaN;
    return Number.isFinite(x) && Number.isFinite(y) ? moveToken(x, y) : null;
  });
  return tokens.every(token => token !== null) ? tokens.join(' ') : null;
}

/** The moves of a token line, with their place in it. */
function moves(tokens: string): Array<{index: number; x: number; y: number}> {
  return tokens.split(' ').flatMap((token, index) => {
    const match = /^M\(([^ (),]+),([^ (),]+)\)$/.exec(token);
    return match ? [{index, x: Number(match[1]), y: Number(match[2])}] : [];
  });
}

/**
 * Where the recorded gestures landed (a line that already matches EXPECTED_SENT): the tap and the two-finger tap near
 * the middle, the drag's x rising from about 0.3 to about 0.7 and every drag point inside the picture's band, with y
 * rising too. A surface that maps touches to the wrong place, or a codec that swaps or zeroes x and y, fails here even
 * when the event kinds are right.
 */
export function landingProblems(tokens: string): string[] {
  const problems: string[] = [];
  const list = tokens.split(' ');
  const all = moves(tokens);
  const at = (index: number) => all.find(move => move.index === index);
  const near = (value: number, target: number, tolerance: number) => Math.abs(value - target) <= tolerance;
  const where = (move: {x: number; y: number}) => `(${move.x}, ${move.y})`;
  const tap = at(0), twoFinger = at(3);
  if (!tap || !near(tap.x, LANDING.tap.x, LANDING.tap.tolerance) || !near(tap.y, LANDING.tap.y, LANDING.tap.tolerance)) {
    problems.push(`the tap landed at ${tap ? where(tap) : 'nowhere'}, expected within ${LANDING.tap.tolerance} of (${LANDING.tap.x}, ${LANDING.tap.y})`);
  }
  if (!twoFinger || !near(twoFinger.x, LANDING.twoFingerTap.x, LANDING.twoFingerTap.tolerance) || !near(twoFinger.y, LANDING.twoFingerTap.y, LANDING.twoFingerTap.tolerance)) {
    problems.push(`the two-finger tap landed at ${twoFinger ? where(twoFinger) : 'nowhere'}, expected within ${LANDING.twoFingerTap.tolerance} of (${LANDING.twoFingerTap.x}, ${LANDING.twoFingerTap.y})`);
  }
  // The drag: the move before its left press, then every move while it is held (up to the left release).
  const release = list.lastIndexOf('L-');
  const drag = all.filter(move => move.index >= 6 && move.index < release);
  const start = drag[0], end = drag[drag.length - 1];
  if (!start || !end || drag.length < 2) return [...problems, `the drag recorded ${drag.length} move(s), expected a start and at least one move while held`];
  if (!near(start.x, LANDING.dragX.from, LANDING.dragX.tolerance) || !near(end.x, LANDING.dragX.to, LANDING.dragX.tolerance)) {
    problems.push(`the drag went from x ${start.x} to x ${end.x}, expected about ${LANDING.dragX.from} to ${LANDING.dragX.to}`);
  }
  if (drag.some((move, index) => index > 0 && move.x < drag[index - 1]!.x)) problems.push(`the drag's x did not rise steadily (${drag.map(move => move.x).join(', ')})`);
  if (!(end.y > start.y)) problems.push(`the drag's y did not rise (${start.y} to ${end.y})`);
  const outside = drag.filter(move => move.y <= LANDING.insideBand.min || move.y >= LANDING.insideBand.max
    || move.x <= LANDING.insideBand.min || move.x >= LANDING.insideBand.max);
  if (outside.length) problems.push(`drag point(s) at the picture's edge (clamped, outside the 16:9 band): ${outside.map(where).join(', ')}`);
  return problems;
}

export interface PhoneSeen {
  screenViewerState?: string;
  screenViewerFrames?: string;
  screenViewerRender?: string;
  screenViewerInput?: string;
  gestureDelivery?: string;
  screenViewerTextResult?: string;
  screenViewerSent?: string;
}

export interface JudgeInput {
  /** Whether this run compiled and ran the viewer tests (`--no-screen-viewer` leaves them out). */
  screenViewer: boolean;
  testLog: string;
  /** What each viewer test attached; null when the attachment is missing. */
  phone: {device: PhoneSeen | null; impostor: PhoneSeen | null};
  /** check-ui.py's copy of the host's ready line (no key material). */
  hostReady: Json | null;
  receipts: string;
  inputEvents: string;
  frames: Json | null;
  nmGate: string | null;
}

export interface JudgeVerdict {
  ok: boolean;
  problems: string[];
  label: string;
  tests: {expected: Record<string, TestOutcome>; observed: Record<string, TestOutcome>};
  phone: {frames: number | null; render: string | null; sent: string | null; state: string | null; impostorState: string | null};
  host: {
    phoneEvents: number;
    tokens: string | null;
    framesSent: number | null;
    acceptedHandshakes: number;
    unknownDeviceRefusals: number;
    scriptedEnds: number;
    sessionEnds: string[];
    releasedHeldInput: number;
    malformedLines: number;
    nmGatePassed: boolean | null;
  };
}

const frameCount = (label: string | undefined): number | null => {
  const match = /^frames=(\d+)$/.exec(label ?? '');
  return match ? Number(match[1]) : null;
};

/** Both ends of one run. Without the viewer tests only the test table is judged (the host never started). */
export function judgeScreenViewerRun(input: JudgeInput): JudgeVerdict {
  const problems: string[] = [];
  const expected = expectedTestOutcomes(input.screenViewer);
  const observed = testCaseOutcomes(input.testLog);
  for (const [name, outcome] of Object.entries(expected)) {
    if (observed[name] !== outcome) problems.push(`test ${name}: ${observed[name] ?? 'not run'}, expected ${outcome}`);
  }
  for (const name of Object.keys(observed)) if (!(name in expected)) problems.push(`unexpected test ${name} (${observed[name]})`);

  const receiptLines = parseJsonLines(input.receipts);
  const inputLines = parseJsonLines(input.inputEvents);
  const receipts = receiptLines.lines;
  const handshakes = receipts.filter(line => line.event === 'handshake');
  const accepted = handshakes.filter(line => line.outcome === 'accepted');
  const unknownDevice = handshakes.filter(line => line.outcome === 'failed' && line.reason === 'unknownDevice');
  const scriptedEnds = receipts.filter(line => line.event === 'command' && line.op === 'end' && line.scripted === true && line.reason === 'endedAtMac');
  const sessionEnds = receipts.filter(line => line.event === 'session-ended').map(line => String(line.reason));
  const phoneLines = inputLines.lines.filter(line => line.source === 'phone');
  const released = inputLines.lines.filter(line => line.source !== 'phone');
  const hostTokens = phoneLines.map(line => tokenForHostEvent(line.event));
  const tokens = hostTokens.every((token): token is string => token !== null) ? hostTokens.join(' ') : null;
  const framesSent = typeof (input.frames?.totals as Json | undefined)?.sent === 'number' ? (input.frames!.totals as Json).sent as number : null;
  const gateVerdicts = input.nmGate === null ? [] : [...input.nmGate.matchAll(/^verdict: (PASS|FAIL)$/gm)].map(match => match[1]);
  const nmGatePassed = input.nmGate === null ? null : gateVerdicts.length === 2 && gateVerdicts.every(verdict => verdict === 'PASS')
    && !/^\s+PRESENT /m.test(input.nmGate);

  const device = input.phone.device, impostor = input.phone.impostor;
  const phoneFrames = frameCount(device?.screenViewerFrames);
  const verdictBase = {
    label: SCOPE_LABEL,
    tests: {expected, observed},
    phone: {frames: phoneFrames, render: device?.screenViewerRender ?? null, sent: device?.screenViewerSent ?? null, state: device?.screenViewerState ?? null,
      impostorState: impostor?.screenViewerState ?? null},
    host: {phoneEvents: phoneLines.length, tokens, framesSent, acceptedHandshakes: accepted.length, unknownDeviceRefusals: unknownDevice.length,
      scriptedEnds: scriptedEnds.length, sessionEnds, releasedHeldInput: released.length,
      malformedLines: receiptLines.malformed + inputLines.malformed, nmGatePassed},
  };
  if (!input.screenViewer) return {ok: problems.length === 0, problems, ...verdictBase};

  // Phone end: what the probe showed and sent.
  if (!device) problems.push(`phone: no ${PHONE_ATTACHMENTS.device} attachment`);
  else {
    if (device.screenViewerState !== 'ended=endedAtMac') problems.push(`phone: state ${JSON.stringify(device.screenViewerState)}, expected "ended=endedAtMac"`);
    if (phoneFrames === null || phoneFrames < MIN_FRAMES) problems.push(`phone: ${device.screenViewerFrames ?? 'no frame count'}, expected at least ${MIN_FRAMES}`);
    if (device.screenViewerRender !== EXPECTED_RENDER) problems.push(`phone: render ${JSON.stringify(device.screenViewerRender ?? null)}, expected "${EXPECTED_RENDER}" (pictures received but not shown)`);
    // The UI test first requires ready and sends input. After that the fixture's scripted bar switches to view-only;
    // the v4 phone then reports monitorUnavailable. The last attachment must reflect that transition.
    if (device.screenViewerInput !== 'input=monitorUnavailable') problems.push(`phone: ${device.screenViewerInput ?? 'no input state'}, expected input=monitorUnavailable after fixture view-only`);
    if (device.gestureDelivery !== 'left=2 right=1') problems.push(`phone: ${device.gestureDelivery ?? 'no delivery'}, expected left=2 right=1`);
    if (device.screenViewerTextResult !== 'text=1:posted') problems.push(`phone: ${device.screenViewerTextResult ?? 'no text result'}, expected text=1:posted`);
    if (!EXPECTED_SENT.test(device.screenViewerSent ?? '')) problems.push(`phone: sent ${JSON.stringify(device.screenViewerSent)} is not tap, two-finger tap, press-and-drag, text and Return`);
  }
  if (!impostor) problems.push(`phone: no ${PHONE_ATTACHMENTS.impostor} attachment`);
  else {
    if (impostor.screenViewerState !== 'impostor=refused') problems.push(`phone: impostor state ${JSON.stringify(impostor.screenViewerState)}, expected "impostor=refused"`);
    if (impostor.screenViewerFrames !== 'frames=0') problems.push(`phone: the impostor saw ${impostor.screenViewerFrames}`);
  }

  // Mac end: what the fixture host recorded.
  const ready = input.hostReady;
  if (!ready) problems.push('host: no ready line');
  else {
    if (ready.mode !== 'viewer') problems.push(`host: mode ${String(ready.mode)}, expected viewer`);
    if ((ready.label as Json | undefined)?.label !== SCOPE_LABEL) problems.push(`host: label ${JSON.stringify((ready.label as Json | undefined)?.label)}, expected ${SCOPE_LABEL}`);
    if (typeof ready.port !== 'number' || [3001, 52741, 4723].includes(ready.port)) problems.push(`host: port ${String(ready.port)}`);
  }
  if (receiptLines.malformed || inputLines.malformed) problems.push(`host: ${receiptLines.malformed + inputLines.malformed} malformed evidence line(s)`);
  if (accepted.length !== 1) problems.push(`host: ${accepted.length} accepted handshakes, expected exactly 1 (the pinned probe key)`);
  if (unknownDevice.length < 1) problems.push('host: no handshake refused as unknownDevice (the impostor key)');
  const otherHandshakes = handshakes.filter(line => line.outcome !== 'accepted' && !(line.outcome === 'failed' && line.reason === 'unknownDevice'));
  if (otherHandshakes.length) problems.push(`host: other handshake outcomes ${JSON.stringify(otherHandshakes.map(line => [line.outcome, line.reason]))}`);
  if (receipts.some(line => line.event === 'session-refused')) problems.push('host: a session was refused');
  if (scriptedEnds.length !== 1) problems.push(`host: ${scriptedEnds.length} scripted end commands, expected 1`);
  if (!receipts.some(line => line.event === 'session-ended' && line.reason === 'endedAtMac' && line.session === accepted[0]?.session)) {
    problems.push(`host: the accepted session did not end with endedAtMac (${JSON.stringify(sessionEnds)})`);
  }
  if (!receipts.some(line => line.event === 'stopped')) problems.push('host: no stopped receipt (did not stop cleanly)');
  if (receipts.filter(line => line.event === 'command').some(line => line.scripted !== true)) problems.push('host: a Mac command not marked scripted');
  if (released.length) problems.push(`host: ${released.length} input line(s) not from the phone (held input released)`);
  if (phoneLines.some(line => line.session !== accepted[0]?.session)) problems.push('host: recorded input from a session other than the accepted one');
  if (tokens === null) problems.push('host: an input event the judge cannot read');
  else {
    if (!EXPECTED_SENT.test(tokens)) problems.push(`host: recorded input ${JSON.stringify(tokens)} is not tap, two-finger tap, press-and-drag, text and Return`);
    else problems.push(...landingProblems(tokens).map(problem => `host: ${problem}`));
    // Exact: the same kinds in the same order and, for every move, the same x and y as numbers.
    if (device && tokens !== canonicalPhoneSent(device.screenViewerSent)) problems.push(`both ends: host recorded ${JSON.stringify(tokens)} but the phone sent ${JSON.stringify(device.screenViewerSent)}`);
  }
  if (!phoneLines.some(line => (line.event as Json | undefined)?.kind === 'textAndReturn' && line.result === 'posted')) problems.push('host: no posted text-and-Return');
  if (framesSent === null || framesSent < MIN_FRAMES) problems.push(`host: frames.json sent ${framesSent}, expected at least ${MIN_FRAMES}`);
  if (framesSent !== null && phoneFrames !== null && phoneFrames > framesSent) problems.push(`both ends: the phone counted ${phoneFrames} pictures but the host sent ${framesSent}`);
  const capture = input.frames?.capture as Json | undefined;
  if (capture && (capture.lastWidth !== 1920 || capture.lastHeight !== 1080)) problems.push(`host: synthetic display ${String(capture.lastWidth)}x${String(capture.lastHeight)}, expected 1920x1080`);
  if (nmGatePassed !== true) problems.push(`host: nm gate ${nmGatePassed === null ? 'missing' : 'failed'}`);
  return {ok: problems.length === 0, problems, ...verdictBase};
}

function readText(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function readJson(path: string): Json | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
  } catch { return null; }
}

/** The labels a viewer test attached, from `xcresulttool export attachments` (manifest.json and the exported files). */
export function phoneAttachments(runDir: string): {device: PhoneSeen | null; impostor: PhoneSeen | null} {
  const folder = join(runDir, 'attachments');
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')); } catch { manifest = []; }
  const entries = (Array.isArray(manifest) ? manifest : []).flatMap((test: any) => Array.isArray(test?.attachments) ? test.attachments : []);
  const find = (prefix: string): PhoneSeen | null => {
    const entry = entries.find((item: any) => typeof item?.suggestedHumanReadableName === 'string' && item.suggestedHumanReadableName.startsWith(prefix)
      && typeof item?.exportedFileName === 'string' && !item.exportedFileName.includes('/'));
    return entry ? readJson(join(folder, entry.exportedFileName)) as PhoneSeen | null : null;
  };
  return {device: find(PHONE_ATTACHMENTS.device), impostor: find(PHONE_ATTACHMENTS.impostor)};
}

export function judgeRunDirectory(runDir: string, screenViewer = true): JudgeVerdict {
  const host = join(runDir, 'screen-host');
  return judgeScreenViewerRun({
    screenViewer,
    testLog: readText(join(runDir, 'test.log')),
    phone: phoneAttachments(runDir),
    hostReady: readJson(join(runDir, 'screen-host-ready.json')),
    receipts: readText(join(host, 'host-receipts.jsonl')),
    inputEvents: readText(join(host, 'input-events.jsonl')),
    frames: readJson(join(host, 'frames.json')),
    nmGate: existsSync(join(host, 'nm-gate.txt')) ? readText(join(host, 'nm-gate.txt')) : null,
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runDir = args[0] === 'judge' ? args[args.indexOf('--run-dir') + 1] : undefined;
  if (!runDir || args.indexOf('--run-dir') < 0) {
    console.error('usage: bun scripts/emulator-e2e/screenViewerJudge.ts judge --run-dir DIR [--no-screen-viewer]');
    process.exit(64);
  }
  const verdict = judgeRunDirectory(runDir, !args.includes('--no-screen-viewer'));
  console.log(JSON.stringify(verdict));
  process.exit(verdict.ok ? 0 : 1);
}
