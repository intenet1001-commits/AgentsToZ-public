/**
 * WP4 J1-LAN-APP: the sandboxed LAN journey host's pure judges (phase checks, receipt verdict, en0 pick, arguments),
 * check-ui.py's count table (--plan for simulator / device / portal), test20's simulator-only contract and the j1-lan
 * lane's registration and verdict. Nothing here builds, boots a simulator, binds the LAN or starts the host.
 */
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  FIXTURE_DISPLAY_PORT, FIXTURE_NAMES, FIXTURE_PROJECTS, JOURNEY_PHASES, fixtureRegisteredProjects, type HostSnapshot, type JourneyPhase, type JourneyReceipt, controlAckName, evaluateJourneyReceipts,
  closeReasonLabel, firewallBlockReason, isPairRefusal, parseControlRequestName, parseHostArgs, parseReceipts, phaseProblems, pickEn0Address, redactPairTokens,
  tapServeOptions, tappedMessageType, type TransportEvent,
} from '../mobile/ios/scripts/lan-journey-host';
import {
  J1_LAN_TEST, devicePlanProblems, laneOutcomeFromCheckUi, lanJourneyPreconditions, lanListenerProblemsFor, supervisorReadyPort,
} from '../scripts/emulator-e2e/lanJourney';
import {LANE_MODULES, catalogEntry, resolveLane, unregisterLane} from '../scripts/emulator-e2e';
import {detectForbiddenTools, harnessScanTargets} from '../scripts/emulator-e2e/preflight';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CHECK_UI = join(REPO_ROOT, 'mobile/ios/scripts/check-ui.py');
const HOST = join(REPO_ROOT, 'mobile/ios/scripts/lan-journey-host.ts');
const SWIFT = join(REPO_ROOT, 'mobile/ios/UITests/WorkspaceUITests.swift');
const DEVICE = '00008150-001234560A11401C';
const TOKEN = '#pair=' + 'a'.repeat(43);

describe('en0 address and arguments', () => {
  const rows = {
    lo0: [{address: '127.0.0.1', family: 'IPv4', internal: true}],
    en0: [{address: 'fe80::1', family: 'IPv6', internal: false}, {address: '192.168.0.23', family: 'IPv4', internal: false}],
    en1: [{address: '10.0.0.5', family: 'IPv4', internal: false}],
    utun3: [{address: '100.64.0.2', family: 'IPv4', internal: false}],
  };
  test('picks the private IPv4 of en0 only; a requested address must be one of en0', () => {
    expect(pickEn0Address(rows)).toEqual({address: '192.168.0.23'});
    expect(pickEn0Address(rows, '192.168.0.23')).toEqual({address: '192.168.0.23'});
    expect(pickEn0Address(rows, '10.0.0.5').address).toBeNull();
    expect(pickEn0Address({...rows, en0: [{address: '8.8.8.8', family: 'IPv4', internal: false}]}).address).toBeNull();
    const none = pickEn0Address({lo0: rows.lo0});
    expect(none.address).toBeNull();
    expect(none.reason).toContain('no public or wildcard fallback');
  });

  test('parses supervise and serve strictly; reserved and low ports are refused', () => {
    expect(parseHostArgs(['supervise', '--evidence-dir', '/x'])).toEqual({mode: 'supervise', evidenceDir: '/x', keepScratch: false});
    expect(parseHostArgs(['supervise', '--evidence-dir', '/x', '--address', '10.1.2.3', '--port', '45000', '--keep-scratch']))
      .toEqual({mode: 'supervise', evidenceDir: '/x', address: '10.1.2.3', port: 45000, keepScratch: true});
    expect(parseHostArgs(['serve', '--journey-dir', '/j', '--evidence-dir', '/e', '--address', '192.168.0.2', '--port', '45001']))
      .toEqual({mode: 'serve', journeyDir: '/j', evidenceDir: '/e', address: '192.168.0.2', port: 45001});
    for (const bad of [
      ['supervise'], ['supervise', '--evidence-dir', '/x', '--port', '3001'], ['supervise', '--evidence-dir', '/x', '--port', '52741'],
      ['supervise', '--evidence-dir', '/x', '--port', '4723'], ['supervise', '--evidence-dir', '/x', '--port', '80'],
      ['supervise', '--evidence-dir', '/x', '--address', '8.8.8.8'], ['supervise', '--evidence-dir', '/x', '--bogus', '1'],
      ['serve', '--evidence-dir', '/e', '--address', '192.168.0.2'], ['serve', '--evidence-dir', '/e', '--journey-dir', '/j', '--address', '192.168.0.2', '--port', '45001', '--keep-scratch'],
      ['run', '--evidence-dir', '/x'],
    ]) expect(() => parseHostArgs(bad)).toThrow();
  });

  test('probe takes only an en0 address (it binds nothing)', () => {
    expect(parseHostArgs(['probe'])).toEqual({mode: 'probe'});
    expect(parseHostArgs(['probe', '--address', '192.168.0.2'])).toEqual({mode: 'probe', address: '192.168.0.2'});
    for (const bad of [['probe', '--address', '8.8.8.8'], ['probe', '--port', '45000'], ['probe', '--evidence-dir', '/x'], ['probe', '--keep-scratch']]) {
      expect(() => parseHostArgs(bad)).toThrow();
    }
  });

  test('only a firewall that clearly reads off lets the journey bind en0', () => {
    const off = {globalState: 'Firewall is disabled. (State = 0)', blockAll: 'Firewall has block all state set to disabled.'};
    expect(firewallBlockReason(off)).toBeNull();
    expect(firewallBlockReason({...off, blockAll: null})).toBeNull();
    expect(firewallBlockReason({...off, globalState: 'Firewall is enabled. (State = 1)'})).toContain('firewall is on');
    expect(firewallBlockReason({...off, globalState: 'Firewall is blocking all non-essential incoming connections. (State = 2)'})).toContain('firewall is on');
    expect(firewallBlockReason({...off, blockAll: 'Firewall has block all state set to enabled.'})).toContain('blocks all incoming');
    // Unreadable or unrecognised counts as on (nobody may answer the prompt it could raise).
    expect(firewallBlockReason({globalState: null, blockAll: null})).toContain('could not be read');
    expect(firewallBlockReason(null)).toContain('could not be read');
    expect(firewallBlockReason({...off, globalState: 'something else'})).toContain('firewall is on');
  });

  test('control requests are NN-<phase>.json for known phases only; acks and temporaries are not requests', () => {
    expect(parseControlRequestName('01-listed.json')).toEqual({sequence: 1, phase: 'listed'});
    expect(parseControlRequestName('03-consent-required.json')).toEqual({sequence: 3, phase: 'consent-required'});
    expect(parseControlRequestName('06-backgrounded.json')).toEqual({sequence: 6, phase: 'backgrounded'});
    expect(parseControlRequestName('01-listed.ack.json')).toBeNull();
    expect(parseControlRequestName('.01-listed.json.tmp')).toBeNull();
    expect(parseControlRequestName('01-delete-everything.json')).toBeNull();
    expect(controlAckName(4, 'sent')).toBe('04-sent.ack.json');
  });

  test('a #pair= token never survives redaction', () => {
    expect(redactPairTokens(`open http://192.168.0.2:4000/remote/${TOKEN} now`)).toBe('open http://192.168.0.2:4000/remote/#pair=<redacted> now');
  });
});

describe('the transport tap', () => {
  type Socket = {id: string};
  const tapped = () => {
    const events: TransportEvent[] = [];
    const calls: string[] = [];
    const options = tapServeOptions({
      hostname: '192.168.0.2',
      fetch(request: Request) {
        calls.push(`fetch ${new URL(request.url).pathname}`);
        if (new URL(request.url).pathname === '/remote/ws') return undefined;
        return new Response('page', {status: new URL(request.url).pathname.startsWith('/remote/') ? 200 : 404});
      },
      websocket: {
        open(socket: Socket) { calls.push(`open ${socket.id}`); },
        message(socket: Socket, raw: unknown) { calls.push(`message ${socket.id} ${typeof raw}`); return 'handled'; },
        close(socket: Socket, code: number, reason: string) { calls.push(`close ${socket.id} ${code} ${reason}`); },
      },
    }, event => { events.push(event); });
    return {events, calls, options: options as unknown as {fetch(request: Request, server: unknown): unknown; websocket: Record<string, (...args: unknown[]) => unknown>; hostname: string}};
  };

  test('observes page loads, counted frames and closes; the handlers run unchanged', () => {
    const {events, calls, options} = tapped();
    expect(options.hostname).toBe('192.168.0.2');
    expect(options.fetch(new Request('http://192.168.0.2:45000/remote/'), null)).toBeInstanceOf(Response);
    options.fetch(new Request('http://192.168.0.2:45000/remote/app.js'), null);
    options.fetch(new Request('http://192.168.0.2:45000/remote/ws'), null);
    const first = {id: 'one'};
    const second = {id: 'two'};
    options.websocket.open!(first);
    expect(options.websocket.message!(first, JSON.stringify({type: 'controller.pair', pairingToken: 'secret-token-value'}))).toBe('handled');
    options.websocket.message!(first, JSON.stringify({type: 'terminal.read'}));
    options.websocket.close!(first, 1008, 'INVALID_PAIRING');
    options.websocket.message!(second, new TextEncoder().encode(JSON.stringify({type: 'session.restore', sessionToken: 'x'})));
    options.websocket.message!(second, '{not json');
    options.websocket.close!(second, 1000, 'bye\nwith a token #pair=abcdefghijk');
    expect(calls).toEqual(['fetch /remote/', 'fetch /remote/app.js', 'fetch /remote/ws', 'open one', 'message one string', 'message one string',
      'close one 1008 INVALID_PAIRING', 'message two object', 'message two string', 'close two 1000 bye\nwith a token #pair=abcdefghijk']);
    expect(events).toEqual([
      {kind: 'page', path: '/remote/', status: 200},
      {kind: 'message', socket: 1, type: 'controller.pair'},
      {kind: 'close', socket: 1, code: 1008, reason: 'INVALID_PAIRING', pairAttempt: true, restoreAttempt: false},
      {kind: 'message', socket: 2, type: 'session.restore'},
      {kind: 'close', socket: 2, code: 1000, reason: '<other>', pairAttempt: false, restoreAttempt: true},
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(isPairRefusal(events[2]!)).toBe(true);
    expect(isPairRefusal(events[4]!)).toBe(false);
  });

  test('only a pairing socket closed 1008 with a pairing error is a refusal; an observer error changes nothing', () => {
    const close = (code: number, reason: string, pairAttempt = true): TransportEvent => ({kind: 'close', socket: 1, code, reason, pairAttempt, restoreAttempt: false});
    expect(isPairRefusal(close(1008, 'PAIRING_EXPIRED'))).toBe(true);
    expect(isPairRefusal(close(1008, 'INVALID_PAIRING', false))).toBe(false);
    expect(isPairRefusal(close(1008, 'pairing timeout'))).toBe(false);
    expect(isPairRefusal(close(1012, 'INVALID_PAIRING'))).toBe(false);
    expect(tappedMessageType(JSON.stringify({type: 'session.end'}))).toBe('session.end');
    expect(tappedMessageType(JSON.stringify({type: 'project.list'}))).toBeNull();
    expect(tappedMessageType(42)).toBeNull();
    expect(closeReasonLabel('remote control restarting')).toBe('remote control restarting');
    expect(closeReasonLabel('원격 종료')).toBe('<other>');
    const options = tapServeOptions({fetch: () => new Response('x'), websocket: {message: () => 'ok'}}, () => { throw new Error('observer'); }) as unknown as {websocket: {message(...args: unknown[]): unknown}};
    expect(options.websocket.message({}, JSON.stringify({type: 'controller.pair'}))).toBe('ok');
    // No websocket handlers: nothing to tap, the options come back as they were.
    const untouched = {fetch: () => new Response('x')};
    expect(tapServeOptions(untouched, () => {})).toBe(untouched);
  });
});

const base: HostSnapshot = {
  sessions: 1, connected: 1, controllers: 1, managementIds: 1, pairingPending: false, projectStarts: 0, projectActions: 0,
  terminalStarts: 0, terminalInputs: 0, bypassStarts: 0, consentRefusals: 0, consentGranted: false, transcriptHasResult: false, readDeliveredResult: false,
  restarts: 0, pageLoads: 1, pairAttempts: 1, pairRefusals: 0, restores: 0, sessionEnds: 0,
};
const worked = {projectStarts: 1, projectActions: 1, consentGranted: true, terminalStarts: 1, terminalInputs: 1, transcriptHasResult: true, readDeliveredResult: true};
const good: Record<JourneyPhase, HostSnapshot> = {
  listed: base,
  started: {...base, projectStarts: 1, projectActions: 1},
  'consent-required': {...base, projectStarts: 1, projectActions: 1, consentRefusals: 2},
  sent: {...base, projectStarts: 1, projectActions: 1, consentRefusals: 2, consentGranted: true, terminalStarts: 1, terminalInputs: 1, transcriptHasResult: true},
  'output-seen': {...base, ...worked},
  // The scripted listener restart: the session kept by the record, detached, under a new management id; the restarted
  // listener's own fresh pairing is pending (it goes nowhere).
  backgrounded: {...base, ...worked, restarts: 1, connected: 0, managementIds: 2, pairingPending: true},
  // The page's session.restore attaches it to a new socket under another id; the controller (token hash) stays one.
  resumed: {...base, ...worked, restarts: 1, managementIds: 3, pairingPending: true, restores: 1},
  disconnected: {...base, ...worked, sessions: 0, connected: 0, managementIds: 3, restarts: 1, restores: 1, sessionEnds: 1},
  replayed: {...base, ...worked, sessions: 0, connected: 0, managementIds: 3, restarts: 1, restores: 1, sessionEnds: 1, pageLoads: 2, pairAttempts: 2, pairRefusals: 1},
  done: {...base, sessions: 0},
};

describe('phase checks', () => {
  const judge = (phase: JourneyPhase, change: Partial<HostSnapshot>) => phaseProblems(phase, {...good[phase], ...change}, good);

  test('the expected host state passes every phase', () => {
    for (const phase of JOURNEY_PHASES) expect({phase, problems: phaseProblems(phase, good[phase], good)}).toEqual({phase, problems: []});
  });

  test('each phase catches its own failure', () => {
    const failing: Array<[JourneyPhase, Partial<HostSnapshot>]> = [
      ['listed', {pairingPending: true}], ['listed', {projectActions: 1}], ['listed', {pageLoads: 0}],
      ['listed', {pairAttempts: 2}], ['listed', {pairRefusals: 1}],
      ['started', {projectStarts: 2, projectActions: 2}],
      ['consent-required', {consentRefusals: 0}], ['consent-required', {consentGranted: true}],
      ['sent', {bypassStarts: 1}], ['sent', {terminalInputs: 2}], ['sent', {transcriptHasResult: false}],
      ['output-seen', {readDeliveredResult: false}],
      // No real drop: the listener was not restarted, or the socket is still attached after it.
      ['backgrounded', {restarts: 0}], ['backgrounded', {connected: 1}], ['backgrounded', {pairAttempts: 2}],
      // A new pairing (second controller), a replayed input, or a resume that never restored onto a new socket.
      ['resumed', {controllers: 2}], ['resumed', {terminalInputs: 2}], ['resumed', {connected: 0}], ['resumed', {pairAttempts: 2}],
      ['resumed', {restores: 0}], ['resumed', {managementIds: 2}], ['resumed', {restarts: 2}],
      ['disconnected', {sessions: 1}], ['disconnected', {sessionEnds: 0}], ['disconnected', {pairRefusals: 1}],
      // The replay must reach the host (page load, pairing) and be refused by it.
      ['replayed', {sessions: 1, controllers: 2}], ['replayed', {projectStarts: 2, projectActions: 2}],
      ['replayed', {pairRefusals: 0}], ['replayed', {pageLoads: 1}], ['replayed', {pairAttempts: 1}],
    ];
    for (const [phase, change] of failing) expect({phase, change, failed: judge(phase, change).length > 0}).toEqual({phase, change, failed: true});
  });

  test('resume and replay are judged against the earlier phase, never on their own', () => {
    expect(phaseProblems('resumed', good.resumed, {})).toContain('resumed without a backgrounded phase (no real socket drop)');
    expect(phaseProblems('replayed', good.replayed, {})).toContain('replayed without a disconnected phase');
  });
});

function journey(): JourneyReceipt[] {
  const rows: Array<Omit<JourneyReceipt, 'seq' | 'at'>> = [
    {kind: 'host.ready', sandboxed: true, address: '192.168.0.2', port: 45000},
    {kind: 'lan.page', path: '/remote/', status: 200},
    {kind: 'lan.message', socket: 1, type: 'controller.pair'},
    {kind: 'lan.sessions', count: 1, connected: 1},
    {kind: 'control.phase', phase: 'listed', ok: true, problems: []},
    {kind: 'gateway.action', action: 'start', target: FIXTURE_PROJECTS.a, actionId: 'a-1'},
    {kind: 'control.phase', phase: 'started', ok: true, problems: []},
    {kind: 'terminal.refused', operation: 'list', consent: true},
    {kind: 'control.phase', phase: 'consent-required', ok: true, problems: []},
    {kind: 'consent.granted', scriptedApproval: true},
    {kind: 'terminal.request', operation: 'start', target: FIXTURE_PROJECTS.a, agent: 'codex', bypassPermissions: false},
    {kind: 'terminal.request', operation: 'input', containsCommand: true, bytes: 6},
    {kind: 'terminal.read', deliveredResult: true},
    {kind: 'control.phase', phase: 'sent', ok: true, problems: []},
    {kind: 'transcript', hasResult: true},
    {kind: 'control.phase', phase: 'output-seen', ok: true, problems: []},
    {kind: 'lan.restart', closeCode: 1012, connectedBefore: 1, recordSessions: 1, restoredSessions: 1, samePort: true},
    {kind: 'lan.sessions', count: 1, connected: 0},
    {kind: 'control.phase', phase: 'backgrounded', ok: true, problems: []},
    {kind: 'lan.close', socket: 1, code: 1012, reason: 'remote control restarting', pairAttempt: true, restoreAttempt: false},
    {kind: 'lan.message', socket: 2, type: 'session.restore'},
    {kind: 'lan.sessions', count: 1, connected: 1},
    {kind: 'control.phase', phase: 'resumed', ok: true, problems: []},
    {kind: 'lan.message', socket: 2, type: 'session.end'},
    {kind: 'lan.close', socket: 2, code: 1000, reason: 'session ended', pairAttempt: false, restoreAttempt: true},
    {kind: 'lan.sessions', count: 0, connected: 0},
    {kind: 'control.phase', phase: 'disconnected', ok: true, problems: []},
    {kind: 'lan.page', path: '/remote/', status: 200},
    {kind: 'lan.message', socket: 3, type: 'controller.pair'},
    {kind: 'lan.close', socket: 3, code: 1008, reason: 'INVALID_PAIRING', pairAttempt: true, restoreAttempt: false},
    {kind: 'lan.pair', outcome: 'refused', socket: 3, code: 'INVALID_PAIRING'},
    {kind: 'control.phase', phase: 'replayed', ok: true, problems: []},
    {kind: 'control.phase', phase: 'done', ok: true, problems: []},
    {kind: 'host.stopped', signal: 'SIGTERM'},
  ];
  return rows.map((row, index) => ({seq: index + 1, at: '2026-11-01T00:00:00.000Z', ...row}) as JourneyReceipt);
}

function withChange(change: (rows: JourneyReceipt[]) => JourneyReceipt[]): string[] {
  const rows = change(journey()).map((row, index) => ({...row, seq: index + 1}));
  return evaluateJourneyReceipts(rows).problems;
}

const insertBefore = (kind: string, phase: string | null, row: Omit<JourneyReceipt, 'seq' | 'at'>) => (rows: JourneyReceipt[]) => {
  const index = rows.findIndex(entry => entry.kind === kind && (phase === null || entry.phase === phase));
  return [...rows.slice(0, index), {seq: 0, at: '', ...row} as JourneyReceipt, ...rows.slice(index)];
};

describe('the journey verdict from the host receipts', () => {
  test('the whole journey passes with exactly one start, one input and RESULT:hello', () => {
    const verdict = evaluateJourneyReceipts(journey());
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.counts).toMatchObject({projectStartsA: 1, terminalStarts: 1, terminalInputs: 1, consentGrants: 1, phases: [...JOURNEY_PHASES],
      listenerRestarts: 1, sessionRestores: 1, pairAttempts: 2, pairRefusals: 1});
  });

  test('round trip through the JSONL file keeps the verdict and counts malformed lines', () => {
    const text = `${journey().map(row => JSON.stringify(row)).join('\n')}\nnot json\n`;
    const parsed = parseReceipts(text);
    expect(parsed.malformed).toBe(1);
    expect(evaluateJourneyReceipts(parsed.receipts, text).ok).toBe(true);
  });

  test('every way the journey can go wrong fails it', () => {
    const cases: Array<[string, (rows: JourneyReceipt[]) => JourneyReceipt[]]> = [
      ['second start', insertBefore('control.phase', 'started', {kind: 'gateway.action', action: 'start', target: FIXTURE_PROJECTS.a, actionId: 'a-2'})],
      ['same action twice', insertBefore('control.phase', 'started', {kind: 'gateway.action', action: 'start', target: FIXTURE_PROJECTS.a, actionId: 'a-1'})],
      ['action on B', insertBefore('control.phase', 'started', {kind: 'gateway.action', action: 'stop', target: FIXTURE_PROJECTS.b, actionId: 'b-1'})],
      ['bypass start', rows => rows.map(row => row.operation === 'start' ? {...row, bypassPermissions: true} : row)],
      ['start on B', rows => rows.map(row => row.operation === 'start' ? {...row, target: FIXTURE_PROJECTS.b} : row)],
      ['two inputs', insertBefore('control.phase', 'sent', {kind: 'terminal.request', operation: 'input', containsCommand: true})],
      ['input without the command', rows => rows.map(row => row.operation === 'input' ? {...row, containsCommand: false} : row)],
      ['no consent refusal', rows => rows.filter(row => row.kind !== 'terminal.refused')],
      ['grant not scripted', rows => rows.map(row => row.kind === 'consent.granted' ? {...row, scriptedApproval: false} : row)],
      ['grant before refusal', rows => {
        const grant = rows.find(row => row.kind === 'consent.granted')!;
        return [rows[0]!, grant, ...rows.slice(1).filter(row => row !== grant)];
      }],
      ['no transcript', rows => rows.filter(row => row.kind !== 'transcript')],
      ['phone never read the result', rows => rows.filter(row => row.kind !== 'terminal.read')],
      ['phase failed', rows => rows.map(row => row.phase === 'resumed' ? {...row, ok: false, problems: ['two controllers']} : row)],
      ['phase missing', rows => rows.filter(row => row.phase !== 'replayed')],
      ['input replayed after resume', insertBefore('control.phase', 'disconnected', {kind: 'terminal.request', operation: 'input', containsCommand: true})],
      ['host not sandboxed', rows => rows.map(row => row.kind === 'host.ready' ? {...row, sandboxed: false} : row)],
      ['host did not stop cleanly', rows => rows.filter(row => row.kind !== 'host.stopped')],
      ['host error', insertBefore('host.stopped', null, {kind: 'host.error', message: 'boom'})],
      ['token in receipts', rows => rows.map(row => row.kind === 'host.ready' ? {...row, note: `http://x/remote/${TOKEN}`} : row)],
      // The background drop must be real and restored by the page itself.
      ['no listener restart', rows => rows.filter(row => row.kind !== 'lan.restart')],
      ['two listener restarts', insertBefore('control.phase', 'resumed', {kind: 'lan.restart', closeCode: 1012, restoredSessions: 1})],
      ['restart not restorable', rows => rows.map(row => row.kind === 'lan.restart' ? {...row, closeCode: 1001} : row)],
      ['restart lost the session', rows => rows.map(row => row.kind === 'lan.restart' ? {...row, restoredSessions: 0} : row)],
      ['restart after the resume', rows => {
        const restart = rows.find(row => row.kind === 'lan.restart')!;
        const rest = rows.filter(row => row !== restart);
        const at = rest.findIndex(row => row.phase === 'resumed') + 1;
        return [...rest.slice(0, at), restart, ...rest.slice(at)];
      }],
      ['never detached', rows => rows.filter(row => !(row.kind === 'lan.sessions' && row.count === 1 && row.connected === 0))],
      ['never reattached', rows => {
        const restart = rows.findIndex(row => row.kind === 'lan.restart');
        return rows.filter((row, index) => !(index > restart && row.kind === 'lan.sessions' && row.connected === 1));
      }],
      ['no session.restore', rows => rows.filter(row => row.type !== 'session.restore')],
      ['resume paired again', rows => rows.map(row => row.type === 'session.restore' ? {...row, type: 'controller.pair'} : row)],
      ['no first pairing', rows => rows.filter(row => !(row.type === 'controller.pair' && row.socket === 1))],
      ['no session.end', rows => rows.filter(row => row.type !== 'session.end')],
      // The replay must be refused by the host, not fail on the phone.
      ['replay not refused', rows => rows.filter(row => row.kind !== 'lan.pair')],
      ['replay never reached the host', rows => {
        const disconnected = rows.findIndex(row => row.phase === 'disconnected');
        return rows.filter((row, index) => !(index > disconnected && row.kind === 'lan.page'));
      }],
      ['refusal before the replay', insertBefore('control.phase', 'disconnected', {kind: 'lan.pair', outcome: 'refused', socket: 9, code: 'INVALID_PAIRING'})],
    ];
    for (const [name, change] of cases) expect({name, failed: withChange(change).length > 0}).toEqual({name, failed: true});
  });
});

function plan(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync(['/usr/bin/python3', '-I', CHECK_UI, ...args, '--plan'], {cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', env: {PATH: '/usr/bin:/bin', ...env}});
  return {code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString()};
}

describe('check-ui.py count table (--plan runs nothing)', () => {
  const tests = (outcomes: Record<string, string>) => outcomes;
  test('simulator: test20 and test30 pass, with the host started before the tests', () => {
    const result = plan([]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.lanJourney).toBe(true);
    expect(parsed.expected).toEqual({passed: 3, skipped: 1, tests: tests({
      test00OnboardingAcceptsKoreanInputAndRejectsUnsupportedAddress: 'passed',
      test10PersonalWorkspaceSettingsTabsAndColdLaunch: 'skipped',
      [J1_LAN_TEST]: 'passed',
      test30MacControllerInviteIsRejectedByDeviceRegistration: 'passed',
    })});
    const commands = (parsed.commands as string[][]).map(command => command.join(' '));
    const host = commands.findIndex(command => command.includes('lan-journey-host.ts supervise'));
    const testRun = commands.findIndex(command => command.includes('test-without-building'));
    expect(host).toBeGreaterThan(commands.findIndex(command => command.includes('simctl create')));
    expect(host).toBe(testRun - 1);
    expect(commands[host]).toContain('--env-file=/dev/null');
    // Asked first, before the build: a Mac that cannot run the journey learns it before minutes of building.
    expect(commands[0]).toBe('bun --env-file=/dev/null mobile/ios/scripts/lan-journey-host.ts probe');
    expect(commands[1]).toContain('build-for-testing');
    expect(devicePlanProblems(parsed)).not.toEqual([]);
  });

  test('a journey that cannot run here skips test20 (1 pass / 2 skip), or is blocked with --require-lan-journey', () => {
    const plain = JSON.parse(plan([]).out);
    expect(plain.requireLanJourney).toBe(false);
    expect(plain.expectedIfLanBlocked).toEqual({passed: 2, skipped: 2, tests: {
      test00OnboardingAcceptsKoreanInputAndRejectsUnsupportedAddress: 'passed',
      test10PersonalWorkspaceSettingsTabsAndColdLaunch: 'skipped',
      [J1_LAN_TEST]: 'skipped',
      test30MacControllerInviteIsRejectedByDeviceRegistration: 'passed',
    }});
    const required = JSON.parse(plan(['--require-lan-journey', '--lan-address', '192.168.0.2']).out);
    expect(required.requireLanJourney).toBe(true);
    expect(required.expectedIfLanBlocked).toBeNull();
    expect(required.expected).toEqual(plain.expected);
    expect((required.commands as string[][])[0]!.join(' ')).toBe('bun --env-file=/dev/null mobile/ios/scripts/lan-journey-host.ts probe --address 192.168.0.2');
    expect(plan(['--device', DEVICE, '--require-lan-journey']).code).not.toBe(0);
    expect(plan(['--screen-gestures', '--require-lan-journey']).code).not.toBe(0);
  });

  test('check-ui-suite.py still runs the normal lane without --require-lan-journey (a blocked journey skips, not exit 78)', () => {
    const suite = readFileSync(join(REPO_ROOT, 'mobile/ios/scripts/check-ui-suite.py'), 'utf8');
    expect(suite).not.toContain('--require-lan-journey');
    const runner = readFileSync(CHECK_UI, 'utf8');
    // The test step keeps its 600 s limit (the device build's 900 s is older and unrelated).
    expect(runner).toMatch(/"-resultBundlePath", str\(result\), \*only_boundary\], timeout=600, log="test\.log"/);
  });

  test('device: test20 skips and no host starts; 1 pass / 2 skip, 2 / 1 with a portal', () => {
    const device = JSON.parse(plan(['--device', DEVICE]).out);
    expect(device.lanJourney).toBe(false);
    expect(device.expected).toMatchObject({passed: 1, skipped: 3});
    expect(device.expected.tests[J1_LAN_TEST]).toBe('skipped');
    expect(devicePlanProblems(device)).toEqual([]);
    const withPortal = JSON.parse(plan(['--device', DEVICE], {AGENTSTOZ_IOS_PORTAL_URL: 'https://portal.example'}).out);
    expect(withPortal.expected).toMatchObject({passed: 2, skipped: 2});
    const simulatorPortal = JSON.parse(plan([], {AGENTSTOZ_IOS_PORTAL_URL: 'https://portal.example'}).out);
    expect(simulatorPortal.expected).toMatchObject({passed: 4, skipped: 0});
  });

  test('gesture-only fallback keeps 7 / 0 and starts no host; LAN options only apply to the normal simulator lane', () => {
    const gestures = JSON.parse(plan(['--screen-gestures', '--no-screen-viewer']).out);
    expect(gestures.expected).toEqual({passed: 7, skipped: 0});
    expect(gestures.lanJourney).toBe(false);
    expect(plan(['--device', DEVICE, '--lan-port', '45000']).code).not.toBe(0);
    expect(plan(['--screen-gestures', '--lan-address', '192.168.0.2']).code).not.toBe(0);
    expect(plan(['--lan-port', '3001']).code).not.toBe(0);
    expect(plan(['--lan-address', '8.8.8.8']).code).not.toBe(0);
    const pinned = JSON.parse(plan(['--lan-address', '192.168.0.2', '--lan-port', '45000']).out);
    expect((pinned.commands as string[][]).some(command => command.join(' ').includes('supervise --evidence-dir <evidence>/lan-journey --address 192.168.0.2 --port 45000'))).toBe(true);
  });

  test('the table names exactly the tests WorkspaceUITests.swift declares', () => {
    const swift = readFileSync(SWIFT, 'utf8');
    const declared = [...swift.matchAll(/func (test\w+)\(/g)].map(match => match[1]!).sort();
    expect(Object.keys(JSON.parse(plan([]).out).expected.tests).sort()).toEqual(declared);
  });
});

describe('test20 is simulator-only and never pastes or scans', () => {
  const swift = readFileSync(SWIFT, 'utf8');
  const start = swift.indexOf(`func ${J1_LAN_TEST}()`);
  const body = swift.slice(start, swift.indexOf('\n    }\n', start));
  test('the body is wrapped in #if targetEnvironment(simulator) with an XCTSkip #else', () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/^func \w+\(\) throws \{\n\s+#if targetEnvironment\(simulator\)/);
    expect(body).toMatch(/#else\n\s+throw XCTSkip\([^)]*\)\n\s+#endif\s*$/);
    expect(body).toContain('throw XCTSkip("check-ui.py did not start the same-network journey host');
    // Vision and the helpers exist only in simulator builds.
    expect(swift).toMatch(/#if targetEnvironment\(simulator\)\nimport Vision\n#endif/);
    expect(swift).toMatch(/#if targetEnvironment\(simulator\)\nextension WorkspaceUITests \{/);
  });

  test('it never taps the paste button or the QR scanner, and reads the URL from the journey folder', () => {
    expect(swift).not.toMatch(/pasteConnectLink"\]\.tap|scanConnectionQR"\]\.tap|startConnectionQR"\]\.tap/);
    expect(body).toContain('AGENTSTOZ_LAN_JOURNEY_DIR');
    expect(swift).toContain('appendingPathComponent("pairing-url")');
    expect(body.includes('#pair=" +')).toBe(false);
  });

  test('it types into the composer, never into the first text view (xterm\'s helper textarea comes first)', () => {
    expect(swift).not.toContain('textViews.firstMatch');
    expect(swift).toContain('placeholderValue CONTAINS %@", "Enter 전송"');
    expect(body).toContain('let line = composer(web)');
  });

  test('the phases it writes are the host phases, in order', () => {
    const phases = [...body.matchAll(/host\.expect\("([a-z-]+)"/g)].map(match => match[1]);
    expect(phases).toEqual([...JOURNEY_PHASES]);
  });

  test('the background step lets the host drop the socket while the app is away, and the replay needs the page\'s own 「연결 종료」', () => {
    const home = body.indexOf('XCUIDevice.shared.press(.home)');
    const backgrounded = body.indexOf('host.expect("backgrounded"');
    const activate = body.indexOf('app.activate()');
    expect(home).toBeGreaterThan(0);
    expect(backgrounded).toBeGreaterThan(home);
    expect(activate).toBeGreaterThan(backgrounded);
    expect(body.indexOf('host.expect("resumed"')).toBeGreaterThan(activate);
    // A native 「연결 종료」 view (load failure) does not count: only the page's status.
    expect(body).not.toMatch(/ended\.exists\s*\|\|\s*endedView\.exists/);
    expect(body).toContain('XCTAssertFalse(app.descendants(matching: .any)["workroomEnded"].exists');
  });
});

describe('j1-lan lane', () => {
  const firewallOff = {globalState: 'Firewall is disabled. (State = 0)', blockAll: 'Firewall has block all state set to disabled.', stealthMode: null};
  test('is registered, unattended, and blocked without an en0 address or with the firewall on', async () => {
    expect(typeof LANE_MODULES['j1-lan']).toBe('function');
    expect(catalogEntry('j1-lan').kind).toBe('unattended');
    const lane = await resolveLane('j1-lan');
    // The registry is process-wide; other files register their own stand-in lanes under this id.
    unregisterLane('j1-lan');
    expect(lane?.id).toBe('j1-lan');
    expect(lane!.preconditions!({capabilities: {en0PrivateIpv4: null, firewall: firewallOff}} as never)).not.toEqual([]);
    expect(lane!.preconditions!({capabilities: {en0PrivateIpv4: '192.168.0.2', firewall: firewallOff}} as never)).toEqual([]);
    expect(lanJourneyPreconditions({capabilities: {en0PrivateIpv4: '192.168.0.2', firewall: {...firewallOff, globalState: 'Firewall is enabled. (State = 1)'}}} as never).join(' ')).toContain('firewall is on');
    expect(lanJourneyPreconditions({capabilities: {en0PrivateIpv4: '192.168.0.2', firewall: {...firewallOff, blockAll: 'Firewall has block all state set to enabled.'}}} as never).join(' ')).toContain('blocks all incoming');
    expect(lanJourneyPreconditions({capabilities: {en0PrivateIpv4: '192.168.0.2'}} as never).join(' ')).toContain('could not be read');
  });

  test('the harness guard follows the port the supervisor reports listening; nothing may listen off loopback before it', () => {
    expect(supervisorReadyPort(JSON.stringify({portAttempts: [{port: 45000, outcome: 'in-use'}, {port: 45002, outcome: 'listening'}]}))).toBe(45002);
    expect(supervisorReadyPort(JSON.stringify({portAttempts: [{port: 45000, outcome: 'in-use'}]}))).toBeNull();
    expect(supervisorReadyPort(JSON.stringify({portAttempts: [{port: 80, outcome: 'listening'}]}))).toBeNull();
    expect(supervisorReadyPort('')).toBeNull();
    expect(lanListenerProblemsFor([{address: '127.0.0.1', port: 50000}], '192.168.0.2', null, false)).toEqual([]);
    expect(lanListenerProblemsFor([{address: '192.168.0.2', port: 45000}], '192.168.0.2', null, false)).not.toEqual([]);
    expect(lanListenerProblemsFor([{address: '*', port: 45000}], '192.168.0.2', 45000, true)).not.toEqual([]);
    expect(lanListenerProblemsFor([{address: '192.168.0.2', port: 45000}], '192.168.0.2', 45000, true)).toEqual([]);
  });

  const passedResult = () => ({
    state: 'passed', lanJourney: true, lanJourneyVerdict: {ok: true}, consumedFixtureToken: {files: ['UI.xcresult', 'test.log', 'attachments']},
    expected: {passed: 2, skipped: 1, tests: {a: 'passed', b: 'skipped', [J1_LAN_TEST]: 'passed'}},
    tests: {a: 'passed', b: 'skipped', [J1_LAN_TEST]: 'passed'},
  });
  const summary = {passedTests: 2, skippedTests: 1, failedTests: 0};

  test('pass needs both ends; blocked and skipped never count as pass', () => {
    expect(laneOutcomeFromCheckUi({exitCode: 0, timedOut: false, result: passedResult(), summary})).toEqual({status: 'pass'});
    expect(laneOutcomeFromCheckUi({exitCode: 78, timedOut: false, result: {state: 'blocked', reason: 'no en0'}, summary: null})).toEqual({status: 'blocked', reason: 'no en0'});
    expect(laneOutcomeFromCheckUi({exitCode: 0, timedOut: true, result: passedResult(), summary}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({exitCode: 0, timedOut: false, result: null, summary}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({exitCode: 1, timedOut: false, result: {...passedResult(), state: 'failed', problems: ['x']}, summary}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({exitCode: 0, timedOut: false, result: {...passedResult(), tests: {a: 'passed', b: 'skipped', [J1_LAN_TEST]: 'skipped'}}, summary}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({exitCode: 0, timedOut: false, result: passedResult(), summary: {...summary, passedTests: 1, skippedTests: 2}}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({exitCode: 0, timedOut: false, result: {...passedResult(), lanJourneyVerdict: {ok: false}}, summary}).status).toBe('fail');
    expect(laneOutcomeFromCheckUi({exitCode: 0, timedOut: false, result: {...passedResult(), consumedFixtureToken: undefined}, summary}).status).toBe('fail');
  });
});

describe('the fixture projects survive the real core', () => {
  test('both cards reach the phone; A offers start/stop, B nothing; the display port is not a reserved one', async () => {
    const {RemoteControlCore} = await import('../src/remoteControlCore');
    const {RESERVED_LOOPBACK_PORTS} = await import('../scripts/emulator-e2e/environment');
    let running = false;
    const core = new RemoteControlCore({
      listRegisteredProjects: () => fixtureRegisteredProjects(running, {a: '/fixture/project-a', b: '/fixture/project-b'}) as never,
      executeRegisteredProjectAction: () => { running = true; },
    }, {hostName: 'Isolated LAN journey host'});
    const pairing = core.enable('http://192.168.0.23:43210');
    const ready = await core.pair(new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1)).get('pair') ?? '');
    const cards = ready.projects.map(project => ({name: project.name, status: project.status, actions: [...project.actions].sort()}));
    expect(cards).toEqual([
      {name: FIXTURE_NAMES.a, status: 'stopped', actions: ['start', 'stop']},
      {name: FIXTURE_NAMES.b, status: 'unknown', actions: []},
    ]);
    expect((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(FIXTURE_DISPLAY_PORT)).toBe(false);
    core.disable();
  });
});

describe('isolation of the host script', () => {
  const text = readFileSync(HOST, 'utf8');
  test('imports no host code statically (src/ only inside the sandboxed serve)', () => {
    const staticImports = [...text.matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)].map(match => match[1]);
    expect(staticImports.every(path => path!.startsWith('node:'))).toBe(true);
    const serve = text.slice(text.indexOf('async function serve('));
    const supervise = text.slice(text.indexOf('async function supervise('), text.indexOf('async function serve('));
    expect(supervise).not.toMatch(/import\('[^']*src\//);
    expect(serve.indexOf("sandboxRefusal(repoRoot)")).toBeLessThan(serve.indexOf("import('../../../src/remoteControlLanServer')"));
  });

  test('is scanned by preflight and names no forbidden tool', () => {
    const targets = harnessScanTargets(REPO_ROOT).filter(target => /lan-journey-host\.ts$|lanJourney\.ts$|check-ui\.py$/.test(target.path));
    expect(targets.map(target => target.path).sort()).toEqual(['mobile/ios/scripts/check-ui.py', 'mobile/ios/scripts/lan-journey-host.ts', 'scripts/emulator-e2e/lanJourney.ts']);
    expect(detectForbiddenTools(targets)).toEqual([]);
    expect(detectForbiddenTools([{path: 'mobile/ios/UITests/WorkspaceUITests.swift', text: readFileSync(SWIFT, 'utf8')}])).toEqual([]);
  });
});
