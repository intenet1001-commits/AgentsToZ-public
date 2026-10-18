import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
  REMOTE_JOURNEY_DEV_BUNDLE_ID, REMOTE_JOURNEY_OPT_IN_ENV, REMOTE_JOURNEY_OPT_IN_VALUE, RemoteJourneyRefusal,
  journeySessionMatches, nonceAnswerMarker, nonceRequestText, observeJourneyPage, parseRemoteJourneyArgs, runRemoteJourney,
  selectJourneySession,
  type JourneyDriver, type JourneyObservation, type JourneyTapTarget, type RemoteJourneyConfig,
} from '../mobile/ios/scripts/remote-journey-iphone';
import {reduceRemoteJourney} from '../src/remoteJourneyReducer';
import {sha256Hex} from '../src/voiceEvalCorpus';

/** No device is touched here: argument refusals, a fake driver, and a fake page. The script itself is never run on a phone. */
const SCRIPT = resolve(import.meta.dir, '../mobile/ios/scripts/remote-journey-iphone.ts');
const UDID = '00008110-001E2C910EE8401E';
const optedIn = {[REMOTE_JOURNEY_OPT_IN_ENV]: REMOTE_JOURNEY_OPT_IN_VALUE};
// Parsing/fake-driver fixtures never write evidence. Keep their valid output outside the checkout:
// Codex-managed worktrees live under ~/.codex, where the production recorder correctly refuses writes.
const fixtureOutput = join(tmpdir(), 'agentstoz-remote-journey-fixture');
const base = ['--device', UDID, '--project', 'sandbox', '--out', fixtureOutput];
const refusal = (fn: () => unknown) => {
  try {fn();} catch (error) {
    expect(error).toBeInstanceOf(RemoteJourneyRefusal);
    return (error as RemoteJourneyRefusal).code;
  }
  throw Error('expected a refusal');
};

describe('remote journey device script — refusals before any device call', () => {
  test('--device is required, and so is the explicit attended opt-in', () => {
    expect(refusal(() => parseRemoteJourneyArgs([], optedIn))).toBe('DEVICE_REQUIRED');
    expect(refusal(() => parseRemoteJourneyArgs(['--project', 'sandbox'], optedIn))).toBe('DEVICE_REQUIRED');
    expect(refusal(() => parseRemoteJourneyArgs(base, {}))).toBe('OPT_IN_REQUIRED');
    expect(refusal(() => parseRemoteJourneyArgs(base, {[REMOTE_JOURNEY_OPT_IN_ENV]: '1'}))).toBe('OPT_IN_REQUIRED');
    expect(refusal(() => parseRemoteJourneyArgs(['--device', 'not a udid', '--project', 'x'], optedIn))).toBe('DEVICE_INVALID');
  });

  test('only the AgentsToZ dev app may be driven', () => {
    for (const bundle of ['com.openai.chat', 'com.openai.codex', 'com.intenet.agentstoz.mobile', 'com.intenet.agentstoz.mobile.testflight'])
      expect(refusal(() => parseRemoteJourneyArgs([...base, '--bundle-id', bundle], optedIn))).toBe('BUNDLE_NOT_ALLOWED');
    expect(parseRemoteJourneyArgs([...base, '--bundle-id', REMOTE_JOURNEY_DEV_BUNDLE_ID], optedIn).bundleId).toBe(REMOTE_JOURNEY_DEV_BUNDLE_ID);
  });

  test('a non-loopback Appium server, unknown flags, unsupported metrics and protected output folders are refused', () => {
    expect(refusal(() => parseRemoteJourneyArgs([...base, '--appium', 'http://10.0.0.5:4723'], optedIn))).toBe('APPIUM_URL_NOT_LOCAL');
    expect(refusal(() => parseRemoteJourneyArgs([...base, '--approve-sas'], optedIn))).toBe('UNKNOWN_ARGUMENT');
    expect(refusal(() => parseRemoteJourneyArgs([...base, '--metric', 'response'], optedIn))).toBe('METRIC_INVALID');
    expect(refusal(() => parseRemoteJourneyArgs([...base, '--metric', 'sustained-1h'], optedIn))).toBe('METRIC_UNSUPPORTED');
    expect(refusal(() => parseRemoteJourneyArgs(['--device', UDID], optedIn))).toBe('PROJECT_REQUIRED');
    for (const protectedDir of [join(homedir(), 'Library/Application Support/com.portmanager.portmanager/x'), join(homedir(), '.codex'), join(homedir(), '.codex/worktrees/fixture/mobile/ios/build/evidence'), join(homedir(), '.claude/projects')])
      expect(refusal(() => parseRemoteJourneyArgs([...base, '--out', protectedDir], optedIn))).toBe('OUT_DIR_NOT_ALLOWED');
  });

  test('a valid invocation yields a sealed config with a fresh nonce and the dev bundle', () => {
    const config = parseRemoteJourneyArgs([...base, '--metric', 'lock-return', '--duplicate-tap', '--record'], optedIn);
    expect(config.device).toBe(UDID);
    expect(config.outDir).toBe(resolve(fixtureOutput));
    expect(config.metric).toBe('lock-return');
    expect(config.duplicateTap).toBe(true);
    expect(config.record).toBe(true);
    expect(config.bundleId).toBe(REMOTE_JOURNEY_DEV_BUNDLE_ID);
    expect(config.nonce).toMatch(/^[A-Za-z0-9_-]{12,64}$/);
    expect(config.appiumUrl).toBe('http://127.0.0.1:4723');
    expect(parseRemoteJourneyArgs(base, optedIn).nonce).not.toBe(config.nonce);
  });

  test('running the script without --device or without the opt-in exits non-zero before touching anything', async () => {
    const run = async (args: string[], env: Record<string, string>) => {
      const child = Bun.spawn(['bun', SCRIPT, ...args], {stdout: 'pipe', stderr: 'pipe', env: {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env}});
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return {code, err};
    };
    const noDevice = await run([], {});
    expect(noDevice.code).toBe(2);
    expect(noDevice.err).toContain('DEVICE_REQUIRED');
    const noOptIn = await run(base, {});
    expect(noOptIn.code).toBe(2);
    expect(noOptIn.err).toContain('OPT_IN_REQUIRED');
  });

  test('the script never drives the Mac screen or approval UI', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    for (const forbidden of ['cliclick', 'screencapture', 'osascript', 'CGWindowList', 'xcrun', 'devicectl'])
      expect(source).not.toContain(forbidden);
  });
});

/** A phone in a fake world: the composer, pending submission records, the terminal's answer markers. */
function fakePhone(options: {screen?: JourneyObservation['screen']; dedupe?: boolean; answerAfterPolls?: number | null; sessionVisible?: boolean;
  lostAfterLock?: boolean; doubleExecute?: boolean; leaveAfterPolls?: number; legacy?: boolean;
  /** Session tab labels on the page, the session selected at start, and a page that ignores a session tap. */
  sessions?: string[]; active?: string | null; project?: string; stuckSelection?: boolean} = {}) {
  let screen = options.screen ?? 'other', composer = options.sessionVisible ?? false, draft: string | null = null;
  let pending: JourneyObservation['pending'] = [], answers = 0, polls = 0, submitted = 0, nextId = 1;
  let active: string | null = options.active === undefined ? (composer ? 'sandbox · codex' : null) : options.active;
  const sessions = options.sessions ?? ['sandbox · codex'], project = options.project ?? 'sandbox';
  const taps: JourneyTapTarget[] = [], typed: string[] = [], sentTo: (string | null)[] = [];
  const driver: JourneyDriver = {
    async activate() {},
    async observe() {
      polls++;
      if (submitted && options.answerAfterPolls !== null && polls >= (options.answerAfterPolls ?? 2)) {
        pending = [];
        answers = options.doubleExecute ? 2 : 1;
        if (draft !== null) draft = null;
      }
      if (submitted && options.leaveAfterPolls !== undefined && polls >= options.leaveAfterPolls) screen = 'other';
      const visible = screen === 'workroom' && composer;
      // The page reads the composer textarea: off screen there is none, so no draft can be read.
      return {screen, composerVisible: visible, draft: visible ? draft : null, pending: pending.map(p => ({...p})), unsupportedNotice: false, answerCount: answers, connected: true,
        activeSession: visible ? active : null};
    },
    async tap(target) {
      if (target === 'workroom-session') {
        const matches = sessions.filter(label => journeySessionMatches(label, project));
        if (matches.length === 0) throw new RemoteJourneyRefusal('WORKROOM_SESSION_NOT_FOUND', 'no session');
        if (matches.length > 1) throw new RemoteJourneyRefusal('WORKROOM_SESSION_AMBIGUOUS', 'two sessions');
        taps.push(target);
        composer = true;
        if (!options.stuckSelection) active = matches[0]!;
        return;
      }
      taps.push(target);
      if (target === 'tab-workroom') screen = 'workroom';
      if (target === 'workroom-send') {
        sentTo.push(active);
        // An older Mac without terminal-submission-v1: the panel sends at once and empties the composer, no record.
        if (options.legacy) {draft = null; submitted++; polls = 0; return;}
        if (pending.length && options.dedupe !== false) return;
        pending.push({id: 'sub-' + String(nextId++).padStart(8, '0'), state: null, storeId: null});
        submitted++;
        polls = 0;
      }
    },
    async typeDraft(text) {typed.push(active ?? ''); draft = text;},
    async startRecording() {},
    async stopRecording() {return new Uint8Array([1, 2, 3]);},
    async close() {},
  };
  return {driver, taps, typed, sentTo, lock() {screen = 'other'; composer = false; if (options.lostAfterLock) draft = null;}};
}
function fakeIo(onPrompt: (message: string) => void = () => {}) {
  let now = 1_792_011_100_000;
  const prompts: string[] = [];
  return {prompts, io: {now: () => now, sleep: async (ms: number) => {now += ms;}, prompt: async (message: string) => {prompts.push(message); onPrompt(message); now += 4_000;}}};
}
const config = (extra: Partial<RemoteJourneyConfig> = {}): RemoteJourneyConfig =>
  ({...parseRemoteJourneyArgs(base, optedIn), nonce: 'nonceAbc12345', ...extra});

describe('remote journey runner with a fake driver', () => {
  test('a canonical journey opens the Workroom, submits the nonce request once and reduces to ok', async () => {
    const phone = fakePhone(), {io, prompts} = fakeIo();
    const result = await runRemoteJourney(config(), phone.driver, io);
    expect(result.aborted).toBeNull();
    expect(phone.taps).toEqual(['tab-workroom', 'workroom-session', 'workroom-send']);
    expect(prompts).toEqual([]);
    const reduced = reduceRemoteJourney(result.log);
    expect(reduced.outcome).toBe('ok');
    expect(reduced.effortCount).toBe(3);
    expect(reduced.violations).toEqual([]);
    expect(reduced.taskStateObserved).toBe(true);
    const submit = result.log.events.find(e => e.kind === 'submit')!;
    expect(submit).toMatchObject({submissionId: 'sub-00000001', draftDigest: sha256Hex(nonceRequestText('nonceAbc12345'))});
  });

  test('a composer already open on another session is never used: the requested project is selected first', async () => {
    const phone = fakePhone({screen: 'workroom', sessionVisible: true, active: 'AgentsToZ-OPS · codex',
      sessions: ['AgentsToZ-OPS · codex', 'sandbox-app · codex', 'sandbox · codex']}), {io} = fakeIo();
    const result = await runRemoteJourney(config(), phone.driver, io);
    expect(result.aborted).toBeNull();
    expect(phone.taps).toEqual(['workroom-session', 'workroom-send']);
    expect(phone.typed).toEqual(['sandbox · codex']);
    expect(phone.sentTo).toEqual(['sandbox · codex']);
  });

  test('a composer already open on the requested project is used without an extra tap', async () => {
    const phone = fakePhone({screen: 'workroom', sessionVisible: true, active: 'sandbox · codex #2',
      sessions: ['sandbox · codex #1', 'sandbox · codex #2']}), {io} = fakeIo();
    await runRemoteJourney(config(), phone.driver, io);
    expect(phone.taps).toEqual(['workroom-send']);
    expect(phone.sentTo).toEqual(['sandbox · codex #2']);
  });

  test('a missing, ambiguous or unselectable project session refuses before anything is typed or sent', async () => {
    const cases: [Parameters<typeof fakePhone>[0], string][] = [
      [{screen: 'workroom', sessionVisible: true, active: 'AgentsToZ-OPS · codex', sessions: ['AgentsToZ-OPS · codex']}, 'WORKROOM_SESSION_NOT_FOUND'],
      [{screen: 'workroom', sessionVisible: true, active: 'AgentsToZ-OPS · codex', sessions: ['sandbox · codex', 'sandbox · claude']}, 'WORKROOM_SESSION_AMBIGUOUS'],
      [{screen: 'workroom', sessionVisible: true, active: 'AgentsToZ-OPS · codex', sessions: ['sandbox · codex'], stuckSelection: true}, 'WORKROOM_TARGET_MISMATCH'],
    ];
    for (const [options, expected] of cases) {
      const phone = fakePhone(options), {io} = fakeIo();
      let code = '';
      try {await runRemoteJourney(config(), phone.driver, io);} catch (error) {code = (error as RemoteJourneyRefusal).code;}
      expect(code).toBe(expected);
      expect(phone.typed).toEqual([]);
      expect(phone.sentTo).toEqual([]);
    }
  });

  test('a scheduled duplicate tap that the app deduplicates is a retry, not a duplicate action', async () => {
    const phone = fakePhone(), {io} = fakeIo();
    const result = await runRemoteJourney(config({duplicateTap: true}), phone.driver, io);
    const submits = result.log.events.filter(e => e.kind === 'submit');
    expect(submits.map(s => s.kind === 'submit' && s.submissionId)).toEqual(['sub-00000001', 'sub-00000001']);
    const reduced = reduceRemoteJourney(result.log);
    expect(reduced.retryCount).toBe(1);
    expect(reduced.violations).toEqual([]);
  });

  test('a duplicate tap that executes twice is reported as duplicate-action', async () => {
    const phone = fakePhone({dedupe: false, doubleExecute: true}), {io} = fakeIo();
    const reduced = reduceRemoteJourney((await runRemoteJourney(config({duplicateTap: true}), phone.driver, io)).log);
    expect(reduced.violations).toContain('duplicate-action');
  });

  test('a lock-return journey asks the human, records the perturbation and the re-entry it cost', async () => {
    const phone = fakePhone(), {io, prompts} = fakeIo(message => {if (message.includes('잠그')) phone.lock();});
    const result = await runRemoteJourney(config({metric: 'lock-return'}), phone.driver, io);
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain('잠그');
    const kinds = result.log.events.map(e => e.kind);
    expect(kinds).toContain('perturb');
    expect(kinds).toContain('reentry');
    const reduced = reduceRemoteJourney(result.log);
    expect(reduced.effortCount).toBe(6);
    expect(reduced.latencyMs).not.toBeNull();
  });

  test('every recovery metric sends its request only after the human confirms the perturbation is over', async () => {
    for (const [metric, cue] of [['lock-return', '잠그'], ['wifi-change', 'Wi‑Fi를 끄'], ['host-restart', '종료']] as const) {
      // The CLI would answer on the very next look; nothing may be in flight while the human holds the perturbation.
      const phone = fakePhone({answerAfterPolls: 1}), {io} = fakeIo(message => {if (message.includes(cue)) phone.lock();});
      const result = await runRemoteJourney(config({metric}), phone.driver, io);
      const events = result.log.events;
      const end = events.find(e => e.kind === 'perturb' && e.phase === 'end')!;
      const submits = events.filter(e => e.kind === 'submit');
      expect(submits.length).toBe(1);
      expect(submits.every(s => s.t >= end.t)).toBe(true);
      expect(events.indexOf(submits[0]!)).toBeGreaterThan(events.indexOf(end));
      const reduced = reduceRemoteJourney(result.log);
      expect(reduced.outcome).toBe('ok');
      // The fake taps take no time, so the clock can read 0 here; what matters is that it is a real, attributable clock.
      expect(reduced.reasons).toEqual([]);
      expect(reduced.latencyMs).not.toBeNull();
    }
  });

  test('a draft lost across the lock is recorded as draft-lost', async () => {
    const phone = fakePhone({answerAfterPolls: null, lostAfterLock: true}), {io} = fakeIo(message => {if (message.includes('잠그')) phone.lock();});
    const reduced = reduceRemoteJourney((await runRemoteJourney(config({metric: 'lock-return', deadlineMs: 20_000}), phone.driver, io)).log);
    expect(reduced.violations).toEqual(['draft-lost']);
    expect(reduced.outcome).toBe('timeout');
    expect(reduced.latencyMs).toBeNull();
  });

  test('leaving the Workroom screen is not a lost draft: an unseen composer says nothing about the draft', async () => {
    const phone = fakePhone({answerAfterPolls: null, leaveAfterPolls: 3}), {io} = fakeIo();
    const reduced = reduceRemoteJourney((await runRemoteJourney(config({deadlineMs: 12_000}), phone.driver, io)).log);
    expect(reduced.violations).toEqual([]);
    expect(reduced.outcome).toBe('timeout');
  });

  test('on the legacy input path the composer is emptied by the send: a slow answer is a timeout, not draft-lost', async () => {
    const phone = fakePhone({legacy: true, answerAfterPolls: null}), {io} = fakeIo();
    const result = await runRemoteJourney(config({deadlineMs: 10_000}), phone.driver, io);
    const submit = result.log.events.find(e => e.kind === 'submit');
    expect(submit).toMatchObject({submissionId: null});
    const reduced = reduceRemoteJourney(result.log);
    expect(reduced.outcome).toBe('timeout');
    expect(reduced.violations).toEqual([]);
  });

  test('no answer before the deadline ends the journey with a timeout, not a hang', async () => {
    const phone = fakePhone({answerAfterPolls: null}), {io} = fakeIo();
    const result = await runRemoteJourney(config({deadlineMs: 10_000}), phone.driver, io);
    const reduced = reduceRemoteJourney(result.log);
    expect(reduced.outcome).toBe('timeout');
    expect(reduced.taskStateObserved).toBe(false);
  });

  test('the Mac approval screen is a consent boundary: nothing is tapped and nothing is approved', async () => {
    const phone = fakePhone({screen: 'approval'}), {io} = fakeIo();
    let code = '';
    try {await runRemoteJourney(config(), phone.driver, io);} catch (error) {code = (error as RemoteJourneyRefusal).code;}
    expect(code).toBe('CONSENT_BOUNDARY');
    expect(phone.taps).toEqual([]);
  });

  test('a recording becomes the captureHash; without one the hash stays null', async () => {
    const recorded = await runRemoteJourney(config({record: true}), fakePhone().driver, fakeIo().io);
    expect(recorded.captureHash).toBe(sha256Hex(new Uint8Array([1, 2, 3])));
    const plain = await runRemoteJourney(config(), fakePhone().driver, fakeIo().io);
    expect(plain.captureHash).toBeNull();
  });
});

describe('page observation (runs inside the dev app web view)', () => {
  const page = (o: {workspaceTab?: string; approval?: boolean; composer?: string | null; screenText?: string; connection?: string; storage?: Record<string, string>; notice?: string; active?: string}) => {
    const el = (props: Record<string, unknown>) => props;
    const doc = {querySelector(selector: string) {
      if (selector === '[data-testid="internet-remote-approval"]') return o.approval ? el({}) : null;
      if (selector === 'main[data-workspace-tab]') return o.workspaceTab ? el({getAttribute: () => o.workspaceTab}) : null;
      if (selector === 'textarea[aria-label="워크룸 입력"]') return o.composer === undefined || o.composer === null ? null : el({value: o.composer});
      if (selector === '[data-testid="workroom-readable-screen"]') return null;
      if (selector === '.xterm-rows') return o.screenText === undefined ? null : el({textContent: o.screenText});
      if (selector === '[data-testid="remote-connection-state"]') return el({textContent: o.connection ?? '연결됨'});
      if (selector === '.ai-terminal-error, [role="alert"]') return o.notice ? el({textContent: o.notice}) : null;
      if (selector === '.ai-terminal-current .ai-terminal-current-label') return o.active ? el({textContent: ' ' + o.active + ' '}) : null;
      return null;
    }};
    const entries = Object.entries(o.storage ?? {});
    const storage = {length: entries.length, key: (i: number) => entries[i]?.[0] ?? null, getItem: (k: string) => o.storage?.[k] ?? null};
    return {doc, storage};
  };
  test('reads the screen, composer, pending records and nonce answers without the request text counting as an answer', () => {
    const marker = nonceAnswerMarker('nonceAbc12345');
    const request = nonceRequestText('nonceAbc12345');
    expect(request).not.toContain(marker);
    const {doc, storage} = page({workspaceTab: 'workroom', composer: '', active: 'sandbox · codex', screenText: request + '\n' + marker + '\n',
      storage: {'agentstoz:pending-submission:v1:host:s1': JSON.stringify({id: 'sub-00000001', sessionId: 's1', receipt: {state: 'unknown', storeId: 'store-0001'}}), other: 'x'}});
    const observed = observeJourneyPage(doc as never, storage as never, marker, '이 기기는 전체 요청 제출을 아직 받지 않습니다');
    expect(observed).toEqual({screen: 'workroom', composerVisible: true, draft: null, pending: [{id: 'sub-00000001', state: 'unknown', storeId: 'store-0001'}],
      unsupportedNotice: false, answerCount: 1, connected: true, activeSession: 'sandbox · codex'});
  });
  test('the approval screen is reported as such, and a disconnected state is not connected', () => {
    const {doc, storage} = page({approval: true, connection: '휴대폰 오프라인'});
    const observed = observeJourneyPage(doc as never, storage as never, 'ACK-x', 'n');
    expect(observed.screen).toBe('approval');
    expect(observed.connected).toBe(false);
  });
  /** Session tabs as the panel renders them: owner span, the label as a text node, then the state span. */
  const tabs = (rows: {owner: string; label: string; state: string; ended?: boolean}[]) => {
    const clicked: string[] = [];
    const buttons = rows.map(row => ({
      className: 'ai-terminal-tab' + (row.ended ? ' ai-terminal-tab--ended' : ''), disabled: false,
      textContent: row.owner + row.label + row.state,
      childNodes: [{nodeType: 1, textContent: ''}, {nodeType: 1, textContent: row.owner}, {nodeType: 3, textContent: row.label}, {nodeType: 1, textContent: row.state}],
      click() {clicked.push(row.label);},
    }));
    return {clicked, doc: {querySelectorAll: (selector: string) => selector === '.ai-terminal-session-list button[role="tab"]' ? buttons : []}};
  };
  test('a session is selected only by an exact, unique project label — never by a substring of the button text', () => {
    const rows = [
      {owner: '이 기기', label: 'app-store · codex', state: '실행 중'},
      {owner: '이 기기', label: 'sandbox · codex #1', state: '실행 중'},
      {owner: '이 기기', label: 'sandbox · claude', state: '실행 중'},
      {owner: '이 기기', label: 'old · codex', state: '종료', ended: true},
    ];
    for (const [project, result, clicked] of [
      ['app', 'missing', []], ['실행', 'missing', []], ['이 기기', 'missing', []], ['old', 'missing', []],
      ['sandbox', 'ambiguous', []], ['sandbox · codex #1', 'selected', ['sandbox · codex #1']], ['app-store', 'selected', ['app-store · codex']],
    ] as const) {
      const {doc, clicked: got} = tabs(rows);
      expect(selectJourneySession(doc as never, project, journeySessionMatches)).toBe(result);
      expect(got).toEqual([...clicked]);
    }
    expect(journeySessionMatches('sandbox · codex #2', 'sandbox')).toBe(true);
    expect(journeySessionMatches('sandbox-app · codex', 'sandbox')).toBe(false);
    expect(journeySessionMatches(null, 'sandbox')).toBe(false);
  });

  test('the session selector and matcher are self-contained so they can be shipped to the web view', () => {
    const matcher = new Function('return (' + journeySessionMatches.toString() + ')')();
    const select = new Function('return (' + selectJourneySession.toString() + ')')();
    const {doc, clicked} = tabs([{owner: '1호', label: 'sandbox · codex', state: '실행 중'}]);
    expect(select(doc, 'sandbox', matcher)).toBe('selected');
    expect(clicked).toEqual(['sandbox · codex']);
  });

  test('the observer is self-contained so it can be shipped to the web view as source', () => {
    const shipped = new Function('return (' + observeJourneyPage.toString() + ')')();
    const {doc, storage} = page({workspaceTab: 'home'});
    expect(shipped(doc, storage, 'ACK-x', 'n').screen).toBe('other');
  });
});
