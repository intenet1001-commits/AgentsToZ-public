import {afterEach, describe, expect, test} from 'bun:test';
import {appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {
  WORKROOM_ACTIVITY_LOG_LIMIT, WORKROOM_NEEDS_ANSWER_STABLE_MS, WORKROOM_STARTING_IDLE_QUIET_MS, WORKROOM_TURN_FINISHED_QUIET_MS,
  WORKROOM_WORKING_SUSTAIN_MS, WorkroomActivityBoard, initialWorkroomActivityTracker, normalizeWorkroomActivityRequest,
  parseWorkroomTurnCompletions, reduceWorkroomActivity, workroomSampleInputs, type WorkroomActivityInput, type WorkroomActivityTracker,
} from '../src/aiTerminalActivity';
import {initialWorkroomNotifyMemory, stepWorkroomNotify, type WorkroomNotification} from '../src/workroomNotifyPolicy';
import {createWorkroomTranscriptSignals, WORKROOM_TRANSCRIPT_TICK_BYTES} from '../src/aiTerminalActivityTranscript';
import {spawnSync} from 'node:child_process';
import {renameSync, utimesSync} from 'node:fs';
import {claudeProjectSlugCandidates} from '../src/sessionTranscript';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';
import {createCommunityControlExecutor} from '../src/agentDialogueControl';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';

// ---------------------------------------------------------------- reducer table

const run = (inputs: WorkroomActivityInput[], start = initialWorkroomActivityTracker(0)) => {
  let tracker: WorkroomActivityTracker = start;
  const states: string[] = [];
  for (const input of inputs) {
    const result = reduceWorkroomActivity(tracker, input);
    tracker = result.tracker;
    if (result.changed) states.push(`${tracker.activity.state}${tracker.activity.exact ? '' : '~'}`);
  }
  return {tracker, states};
};

describe('activity reducer', () => {
  test('a written request is working at once; quiet with no question is a heuristic turn end', () => {
    const {states, tracker} = run([
      {type: 'submit', at: 1_000, turn: 1},
      {type: 'screen', at: 2_000, turn: 1, changed: true, awaitsAnswer: false},
      {type: 'quiet', at: 3_000, turn: 1, quietFor: 1_000, awaitsAnswer: false},
      {type: 'quiet', at: 7_000, turn: 1, quietFor: WORKROOM_TURN_FINISHED_QUIET_MS, awaitsAnswer: false},
    ]);
    expect(states).toEqual(['working', 'turn-finished~']);
    expect(tracker.activity).toMatchObject({state: 'turn-finished', exact: false, source: 'screen', turn: 1});
  });

  test('needs-answer from any running state once the question stayed on screen, the starting screen included (critique item 5)', () => {
    const ask = (at: number, quietFor = 0): WorkroomActivityInput => ({type: 'quiet', at, turn: 0, quietFor, awaitsAnswer: true});
    // One sample of a question is not enough; the same question 1.5 s later is.
    expect(run([ask(2_000)]).states).toEqual([]);
    expect(run([ask(2_000), ask(2_000 + WORKROOM_NEEDS_ANSWER_STABLE_MS)]).states).toEqual(['needs-answer~']);
    const idle = run([{type: 'quiet', at: 6_000, turn: 0, quietFor: WORKROOM_STARTING_IDLE_QUIET_MS, awaitsAnswer: false}]);
    expect(idle.states).toEqual(['idle~']);
    expect(run([ask(9_000), ask(11_000)], idle.tracker).states).toEqual(['needs-answer~']);
    // No output-quiet requirement: real prompts keep repainting (Claude blinks a row, Codex its title).
    const repainting = run([{type: 'submit', at: 0, turn: 1},
      {type: 'screen', at: 1_000, turn: 1, changed: true, awaitsAnswer: true},
      {type: 'screen', at: 2_000, turn: 1, changed: true, awaitsAnswer: true},
      {type: 'screen', at: 3_000, turn: 1, changed: false, awaitsAnswer: true}]);
    expect(repainting.states).toEqual(['working', 'needs-answer~']);
    // A question that leaves the screen before it held restarts its clock.
    expect(run([ask(1_000), {type: 'screen', at: 2_000, turn: 0, changed: true, awaitsAnswer: false}, ask(2_500)]).states).toEqual([]);
  });

  test('Enter while a question is on screen answers it: no new turn, so no heuristic «turn finished» after a trust screen', () => {
    const asking = run([{type: 'quiet', at: 1_000, turn: 0, quietFor: 1_000, awaitsAnswer: true}, {type: 'quiet', at: 3_000, turn: 0, quietFor: 3_000, awaitsAnswer: true}]);
    expect(asking.states).toEqual(['needs-answer~']);
    const answered = run([
      {type: 'submit', at: 4_000, turn: 1},
      {type: 'screen', at: 5_000, turn: 1, changed: true, awaitsAnswer: false},
      {type: 'quiet', at: 9_000, turn: 1, quietFor: WORKROOM_TURN_FINISHED_QUIET_MS + 1_000, awaitsAnswer: false},
      {type: 'quiet', at: 11_000, turn: 1, quietFor: WORKROOM_STARTING_IDLE_QUIET_MS + 1_000, awaitsAnswer: false},
    ], asking.tracker);
    // Back to starting (the question interrupted start-up), then idle — never working or turn-finished.
    expect(answered.states).toEqual(['starting~', 'idle~']);
    expect(answered.tracker.lastSubmitAt).toBeNull();
    // Even before needs-answer fired, a question already sampled makes Enter an answer.
    const early = run([{type: 'screen', at: 500, turn: 0, changed: true, awaitsAnswer: true}, {type: 'submit', at: 900, turn: 1}]);
    expect(early.states).toEqual([]);
  });

  test('starting stays starting through its first paints, then becomes idle (never a heuristic turn end)', () => {
    const {states} = run([
      {type: 'screen', at: 500, turn: 0, changed: true, awaitsAnswer: false},
      {type: 'quiet', at: 2_500, turn: 0, quietFor: 2_000, awaitsAnswer: false},
      {type: 'screen', at: 3_000, turn: 0, changed: true, awaitsAnswer: false},
      {type: 'quiet', at: 8_500, turn: 0, quietFor: WORKROOM_STARTING_IDLE_QUIET_MS, awaitsAnswer: false},
    ]);
    expect(states).toEqual(['idle~']);
  });

  test('an idle session counts as working only after sustained screen changes', () => {
    const idle = run([{type: 'quiet', at: 6_000, turn: 0, quietFor: 6_000, awaitsAnswer: false}]).tracker;
    expect(run([{type: 'screen', at: 7_000, turn: 0, changed: true, awaitsAnswer: false}], idle).states).toEqual([]);
    const sustained = run([
      {type: 'screen', at: 7_000, turn: 0, changed: true, awaitsAnswer: false},
      {type: 'screen', at: 7_000 + WORKROOM_WORKING_SUSTAIN_MS, turn: 0, changed: true, awaitsAnswer: false},
    ], idle);
    expect(sustained.states).toEqual(['working~']);
    // A quiet gap restarts the run: one repaint now and one later is not work.
    const gap = run([
      {type: 'screen', at: 7_000, turn: 0, changed: true, awaitsAnswer: false},
      {type: 'quiet', at: 9_000, turn: 0, quietFor: 2_000, awaitsAnswer: false},
      {type: 'screen', at: 11_000, turn: 0, changed: true, awaitsAnswer: false},
    ], idle);
    expect(gap.states).toEqual([]);
  });

  test('turn-finished becomes idle on seen or new keystrokes; needs-answer ignores seen', () => {
    const finished = run([{type: 'submit', at: 0, turn: 1}, {type: 'quiet', at: 6_000, turn: 1, quietFor: 6_000, awaitsAnswer: false}]).tracker;
    expect(run([{type: 'seen', at: 7_000, turn: 1}], finished).states).toEqual(['idle']);
    expect(run([{type: 'keys', at: 7_000, turn: 2}], finished).states).toEqual(['idle']);
    const asking = run([{type: 'submit', at: 0, turn: 1}, {type: 'quiet', at: 1_000, turn: 1, quietFor: 1_000, awaitsAnswer: true},
      {type: 'quiet', at: 3_000, turn: 1, quietFor: 3_000, awaitsAnswer: true}]).tracker;
    expect(asking.activity.state).toBe('needs-answer');
    expect(run([{type: 'seen', at: 3_000, turn: 1}], asking).states).toEqual([]);
    // Answering changes the screen to something that is not a question: back to the work it interrupted.
    expect(run([{type: 'keys', at: 3_000, turn: 2}, {type: 'screen', at: 3_500, turn: 2, changed: true, awaitsAnswer: false}], asking).states).toEqual(['working~']);
  });

  test('a transcript turn end is exact, upgrades a heuristic one, and loses to a question on screen', () => {
    const working = run([{type: 'submit', at: 10_000, turn: 1}]).tracker;
    expect(run([{type: 'transcript', at: 12_000, turn: 1, key: 'a', completedAt: 11_500}], working).states).toEqual(['turn-finished']);
    const heuristic = run([{type: 'quiet', at: 16_000, turn: 1, quietFor: 6_000, awaitsAnswer: false}], working).tracker;
    const upgraded = run([{type: 'transcript', at: 17_000, turn: 1, key: 'a', completedAt: 15_000}], heuristic);
    expect(upgraded.states).toEqual(['turn-finished']);
    expect(upgraded.tracker.activity).toMatchObject({source: 'transcript', exact: true});
    // The same key never fires twice.
    expect(run([{type: 'transcript', at: 18_000, turn: 1, key: 'a', completedAt: 15_000}], upgraded.tracker).states).toEqual([]);
    // An end written before the last request belongs to an earlier turn.
    expect(run([{type: 'transcript', at: 12_000, turn: 1, key: 'old', completedAt: 5_000}], working).states).toEqual([]);
    const asking = run([{type: 'quiet', at: 11_000, turn: 1, quietFor: 1_000, awaitsAnswer: true}, {type: 'quiet', at: 13_000, turn: 1, quietFor: 3_000, awaitsAnswer: true}], working).tracker;
    expect(asking.activity.state).toBe('needs-answer');
    expect(run([{type: 'transcript', at: 14_000, turn: 1, key: 'b', completedAt: 13_500}], asking).states).toEqual([]);
  });

  test('exit keeps its code and cause, and nothing changes afterwards', () => {
    const {tracker, states} = run([{type: 'exit', at: 5_000, turn: 3, code: 2, cause: 'exit'}, {type: 'submit', at: 6_000, turn: 4}]);
    expect(states).toEqual(['exited']);
    expect(tracker.activity).toMatchObject({state: 'exited', exitCode: 2, cause: 'exit', source: 'exit', exact: true});
  });
});

// Review 2026-10-16: a transcript turn end belongs to one request, and quiet counts from the request.
describe('activity reducer: which request a turn end belongs to', () => {
  const screen = (at: number, turn: number): WorkroomActivityInput => ({type: 'screen', at, turn, changed: true, awaitsAnswer: false});
  const announced = (inputs: WorkroomActivityInput[], until: number) => {
    let tracker = initialWorkroomActivityTracker(0), memory = initialWorkroomNotifyMemory();
    const sent: WorkroomNotification[] = [];
    for (const input of inputs) {
      const result = reduceWorkroomActivity(tracker, input); tracker = result.tracker;
      if (!result.changed) continue;
      const step = stepWorkroomNotify(memory, {type: 'event', now: input.at, event: {sessionId: 's1', ...tracker.activity}});
      memory = step.memory; sent.push(...step.notifications);
    }
    for (let now = inputs.at(-1)!.at; now <= until; now += 1_000) {
      const step = stepWorkroomNotify(memory, {type: 'tick', now}); memory = step.memory; sent.push(...step.notifications);
    }
    return sent.map(n => [n.at, n.text]);
  };

  test('a request queued while the CLI works: the end of the earlier one is not the end of the queued one', () => {
    const inputs: WorkroomActivityInput[] = [
      {type: 'submit', at: 0, turn: 1}, screen(1_000, 1),
      {type: 'submit', at: 5_000, turn: 2},
      {type: 'transcript', at: 8_500, turn: 2, key: 'codex:turn-1', completedAt: 8_000},
      ...Array.from({length: 8}, (_, i) => screen(9_000 + i * 1_000, 2)),
      {type: 'transcript', at: 30_500, turn: 2, key: 'codex:turn-2', completedAt: 30_000},
    ];
    expect(run(inputs).states).toEqual(['working', 'working', 'turn-finished']);
    // Announced once, at the real end of the queued request.
    expect(announced(inputs, 60_000)).toEqual([[30_500, '작업이 끝났습니다']]);
  });

  test('an end written before a newer request but read after it does not finish the newer request', () => {
    const {states, tracker} = run([
      {type: 'submit', at: 0, turn: 1},
      {type: 'submit', at: 10_400, turn: 2},
      {type: 'transcript', at: 10_900, turn: 2, key: 'claude:end1', completedAt: 10_000},
    ]);
    expect(states).toEqual(['working', 'working']);
    expect(tracker.activity).toMatchObject({state: 'working', turn: 2});
    // Its own end then finishes it.
    expect(run([{type: 'transcript', at: 20_000, turn: 2, key: 'claude:end2', completedAt: 19_500}], tracker).states).toEqual(['turn-finished']);
  });

  test('a request sent to an idle CLI after an end that is read late: the late end is the earlier turn', () => {
    const finished = run([{type: 'submit', at: 0, turn: 1}, {type: 'quiet', at: 6_000, turn: 1, quietFor: 6_000, awaitsAnswer: false},
      {type: 'seen', at: 7_000, turn: 1}]).tracker;
    expect(finished.activity.state).toBe('idle');
    const {states} = run([{type: 'submit', at: 10_400, turn: 2}, {type: 'transcript', at: 10_900, turn: 2, key: 'old', completedAt: 10_000}], finished);
    expect(states).toEqual(['working']);
  });

  test('quiet is counted from the request, not from output long before it', () => {
    const memory = {startedAt: 0};
    let tracker = initialWorkroomActivityTracker(0);
    const states: string[] = [];
    const apply = (input: WorkroomActivityInput) => { const r = reduceWorkroomActivity(tracker, input); tracker = r.tracker; if (r.changed) states.push(`${tracker.activity.state}${tracker.activity.exact ? '' : '~'}`); };
    for (const input of workroomSampleInputs(memory, {at: 2_000, turn: 0, lastOutputAt: 1_000, rows: ['> ']})) apply(input);
    for (const input of workroomSampleInputs(memory, {at: 7_000, turn: 0, lastOutputAt: 1_000})) apply(input);
    apply({type: 'submit', at: 20_000, turn: 1});
    // The CLI has not repainted by the next sweep (start-up, MCP loading, a loaded Mac): still working.
    for (const input of workroomSampleInputs(memory, {at: 20_600, turn: 1, lastOutputAt: 1_000})) apply(input);
    for (const input of workroomSampleInputs(memory, {at: 22_000, turn: 1, lastOutputAt: 1_000})) apply(input);
    expect(states).toEqual(['idle~', 'working']);
    // Three seconds after the request with nothing written, it is a heuristic end.
    for (const input of workroomSampleInputs(memory, {at: 20_000 + WORKROOM_TURN_FINISHED_QUIET_MS, turn: 1, lastOutputAt: 1_000})) apply(input);
    expect(states).toEqual(['idle~', 'working', 'turn-finished~']);
  });
});

describe('activity board: log, reset and waiters', () => {
  test('each transition is logged once; the log is capped; an old or foreign cursor resets', async () => {
    let now = 0;
    const board = new WorkroomActivityBoard(() => now);
    board.track('session-0001', {targetId: 'target-0001', agent: 'codex', lastOutputAt: () => null});
    const first = board.events();
    expect(first.reset).toBe(true);
    expect(first.events).toEqual([]);
    expect(first.sessions.map(s => s.state)).toEqual(['starting']);
    const cursor = {bootId: board.bootId, seq: first.cursor};
    expect(board.apply('session-0001', {type: 'submit', at: ++now, turn: 1})).toBe(true);
    expect(board.apply('session-0001', {type: 'submit', at: ++now, turn: 2})).toBe(true);
    const page = board.events(cursor);
    expect(page.reset).toBe(false);
    expect(page.events.map(e => [e.seq, e.state, e.turn])).toEqual([[2, 'working', 1], [3, 'working', 2]]);
    for (let i = 0; i < WORKROOM_ACTIVITY_LOG_LIMIT + 10; i++) board.apply('session-0001', {type: 'submit', at: ++now, turn: 3 + i});
    expect(board.events(cursor).reset).toBe(true);
    expect(board.events({bootId: board.bootId, seq: board.cursor - 3}).events.length).toBe(3);
    expect(board.events({bootId: crypto.randomUUID(), seq: board.cursor}).reset).toBe(true);
    expect(board.events({bootId: board.bootId, seq: board.cursor + 5}).reset).toBe(true);
  });

  test('wait resolves on the next transition and returns empty at its timeout', async () => {
    const board = new WorkroomActivityBoard();
    board.track('session-0001', {targetId: 'target-0001', agent: 'claude', lastOutputAt: () => null});
    const cursor = {bootId: board.bootId, seq: board.cursor};
    const started = performance.now();
    const empty = await board.wait(cursor, 60);
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(empty).toMatchObject({reset: false, events: []});
    const waiting = board.wait(cursor, 5_000);
    setTimeout(() => board.apply('session-0001', {type: 'submit', at: Date.now(), turn: 1}), 20);
    const woke = await waiting;
    expect(woke.events.map(e => e.state)).toEqual(['working']);
  });

  test('request validation caps waitMs at 25 s and rejects unknown keys', () => {
    expect(normalizeWorkroomActivityRequest({operation: 'activity', waitMs: 90_000})).toEqual({operation: 'activity', waitMs: 25_000});
    expect(normalizeWorkroomActivityRequest({operation: 'seen', sessionId: 'session-0001'})).toEqual({operation: 'seen', sessionId: 'session-0001'});
    for (const bad of [{operation: 'activity', waitMs: -1}, {operation: 'activity', after: {bootId: 'x', seq: 0}}, {operation: 'activity', extra: 1}, {operation: 'seen'}, {operation: 'list'}])
      expect(() => normalizeWorkroomActivityRequest(bad)).toThrow();
  });
});

// ---------------------------------------------------------------- service with a fake PTY and a fake clock

type FakeChild = {pid: number; emit(text: string): void; exit(code: number): void; writes: string[]};
const services: AiTerminalService[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const targetId = 'project-fixture-123';
function fakeService(extra: Partial<ConstructorParameters<typeof AiTerminalService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentstoz-activity-')); dirs.push(dir);
  const children: FakeChild[] = [];
  let nextPid = 4_100_000;
  const clock = {now: 1_000_000};
  const spawn = (_args: string[], options: any) => {
    let settle!: (code: number) => void;
    const exited = new Promise<number>(resolve => { settle = resolve; });
    const writes: string[] = [];
    const control: FakeChild = {pid: ++nextPid, writes,
      emit: text => options.terminal.data(null, new TextEncoder().encode(text)),
      exit: code => { options.terminal.exit?.(); settle(code); }};
    children.push(control);
    return {pid: control.pid, exited, kill: () => control.exit(143), terminal: {write: (data: string) => { writes.push(data); return Buffer.byteLength(data); }, resize() {}, close() {}}};
  };
  const service = new AiTerminalService({
    resolveTarget: async id => { if (id !== targetId) throw new Error('unregistered'); return {cwd: dir}; },
    executable: () => '/bin/sh', spawn: spawn as any,
    signalGroup: (pid, _signal) => children.find(child => child.pid === pid)?.exit(143),
    activityClock: () => clock.now, activitySampler: false, ...extra,
  });
  services.push(service);
  const start = async (agent: 'codex' | 'claude' = 'codex', prompt?: string) => {
    const session = (await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId, agent, cols: 80, rows: 24, ...(prompt ? {prompt} : {})})).session!;
    return {session, child: children.at(-1)!};
  };
  const state = (id: string) => service.activitySnapshot().find(entry => entry.sessionId === id);
  const advance = async (ms: number) => { clock.now += ms; await service.sampleActivity(); };
  const exited = async (id: string) => {
    for (const deadline = Date.now() + 3_000; Date.now() < deadline; await Bun.sleep(5))
      if (state(id)?.state === 'exited') return;
    throw new Error('not exited');
  };
  return {service, start, state, advance, clock, dir, exited};
}

const PROMPT = '\x1b[2J\x1b[H> \r\n';
const CLAUDE_PROCEED = '\x1b[2J\x1b[H Bash command\r\n   rm -rf build\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again\r\n   3. No, and tell Claude what to do differently (esc)\r\n';

describe('service: fake PTY + fake clock', () => {
  test('\\r input is working within one tick; a proceed screen held 1.5 s is needs-answer; a prompt + 3 s is turn-finished', async () => {
    const {service, start, state, advance} = fakeService();
    const {session, child} = await start();
    expect(state(session.id)?.state).toBe('starting');
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: 'do it\r'});
    expect(state(session.id)).toMatchObject({state: 'working', exact: true, turn: 1});
    child.emit(CLAUDE_PROCEED); await advance(0);
    await advance(WORKROOM_NEEDS_ANSWER_STABLE_MS);
    expect(state(session.id)?.state).toBe('needs-answer');
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: '1'});
    child.emit('\x1b[2J\x1b[H⠋ Running…\r\n'); await advance(100);
    expect(state(session.id)?.state).toBe('working');
    child.emit(PROMPT); await advance(100);
    await advance(WORKROOM_TURN_FINISHED_QUIET_MS);
    expect(state(session.id)).toMatchObject({state: 'turn-finished', exact: false, turn: 2});
    expect(service.markSeen(session.id)).toBe(true);
    expect(state(session.id)?.state).toBe('idle');
  });

  test('a launch with a first request starts working; a starting trust screen becomes needs-answer', async () => {
    const {service, start, state, advance} = fakeService();
    const working = await start('claude', 'fix it');
    expect(state(working.session.id)?.state).toBe('working');
    const trust = await start('claude');
    trust.child.emit('\x1b[2J\x1b[H Do you trust the files in this folder?\r\n ❯ 1. Yes, proceed\r\n   2. No, exit\r\n');
    await advance(0); await advance(WORKROOM_NEEDS_ANSWER_STABLE_MS);
    expect(state(trust.session.id)?.state).toBe('needs-answer');
    // The Enter that answers it is a keystroke: once the folder is trusted the session is starting again, never working.
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: trust.session.id, data: '\r'});
    expect(state(trust.session.id)?.state).toBe('needs-answer');
    trust.child.emit(PROMPT); await advance(100);
    expect(state(trust.session.id)?.state).toBe('starting');
    await advance(WORKROOM_TURN_FINISHED_QUIET_MS);
    expect(state(trust.session.id)?.state).toBe('starting');
    await advance(WORKROOM_STARTING_IDLE_QUIET_MS);
    expect(state(trust.session.id)?.state).toBe('idle');
  });

  test('exit code 2 is exited with cause exit; a close is cause close (never announced)', async () => {
    const {service, start, state, exited} = fakeService();
    const a = await start();
    a.child.exit(2); await exited(a.session.id);
    expect(state(a.session.id)).toMatchObject({state: 'exited', exitCode: 2, cause: 'exit'});
    const b = await start();
    await service.perform({operation: 'close', requestId: crypto.randomUUID(), sessionId: b.session.id});
    await exited(b.session.id);
    expect(state(b.session.id)).toMatchObject({state: 'exited', cause: 'close'});
  });

  test('a restart and an app shutdown end sessions with their own causes', async () => {
    const {service, start, state, exited} = fakeService({resume: async () => null});
    const a = await start();
    await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: a.session.id});
    await exited(a.session.id);
    expect(state(a.session.id)).toMatchObject({state: 'exited', cause: 'restart'});
    const b = await start();
    const board = service.activitySnapshot.bind(service);
    await service.shutdown();
    for (const deadline = Date.now() + 3_000; Date.now() < deadline && board().find(e => e.sessionId === b.session.id)?.state !== 'exited'; await Bun.sleep(5));
    expect(board().find(e => e.sessionId === b.session.id)).toMatchObject({state: 'exited', cause: 'shutdown'});
  });

  test('an unasked codex session is never probed with lsof', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-activity-unasked-')); dirs.push(home);
    let opened = 0;
    const {start, advance} = fakeService({env: {HOME: home}, turnSignals: createWorkroomTranscriptSignals({platform: 'darwin', openFiles: async () => { opened++; return []; }})});
    await start('codex');
    for (let i = 0; i < 5; i++) await advance(20_000);
    expect(opened).toBe(0);
  });

  test('the wire summary keeps its keys exactly', async () => {
    const {service, start} = fakeService();
    const {session} = await start();
    expect(Object.keys(session).sort()).toEqual(['agent', 'cols', 'createdAt', 'exitCode', 'id', 'rows', 'state', 'targetId']);
    const listed = await service.perform({operation: 'list', requestId: crypto.randomUUID()});
    expect(Object.keys(listed.sessions![0]!).sort()).toEqual(['agent', 'cols', 'createdAt', 'exitCode', 'id', 'rows', 'state', 'targetId']);
  });

  test('activity is local-only: every remote authority and community owner is refused', async () => {
    const {service, start} = fakeService();
    const {session} = await start();
    await expect(service.performActivity({operation: 'activity', waitMs: 0})).resolves.toMatchObject({activity: {reset: true}});
    const authority = {owner: 'internet:host:controller', targets: new Set([targetId])};
    await expect(service.performActivity({operation: 'activity', waitMs: 0}, authority)).rejects.toThrow('이 Mac의 화면');
    await expect(service.performActivity({operation: 'seen', sessionId: session.id}, authority)).rejects.toThrow('이 Mac의 화면');
    await expect(service.performActivity({operation: 'activity', waitMs: 0}, undefined, {receiptOwner: 'community:endpoint'})).rejects.toThrow('이 Mac의 화면');
    // The wire protocol (relay, LAN) does not know the operations at all.
    expect(() => normalizeAiTerminalRequest({operation: 'activity', requestId: 'request-0001', waitMs: 0})).toThrow();
    expect(() => normalizeAiTerminalRequest({operation: 'seen', requestId: 'request-0001', sessionId: session.id})).toThrow();
    const gateway = createAiTerminalRemoteGateway({service, active: () => true, resolve: async () => [{controlId: 'control-0001', runtimeTargetId: targetId}]});
    await expect(gateway({operation: 'activity', requestId: 'request-0001'} as any, [], 'internet:host:controller')).rejects.toThrow();
    service.setRemoteAccess('internet:host:controller', true);
    await expect(gateway({operation: 'seen', requestId: 'request-0001', sessionId: session.id} as any, [], 'internet:host:controller')).rejects.toThrow();
    const community = createCommunityControlExecutor({terminal: async () => ({}), workspace: async () => ({}), projects: async () => ({projects: []} as any)});
    await expect(community({kind: 'terminal', body: {operation: 'activity', waitMs: 0}})).rejects.toThrow();
    await expect(community({kind: 'terminal', body: {operation: 'seen', sessionId: session.id}})).rejects.toThrow();
  });

  test('a remote or community read never marks a finished session seen; a remote keystroke does (review 2026-10-16)', async () => {
    const {service, start, state, advance, clock} = fakeService();
    const {session, child} = await start();
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: 'go\r'});
    child.emit(PROMPT); await advance(0); await advance(WORKROOM_TURN_FINISHED_QUIET_MS);
    expect(state(session.id)?.state).toBe('turn-finished');
    service.setRemoteAccess('lan:viewer', true);
    const authority = {owner: 'lan:viewer', targets: new Set([targetId])};
    clock.now += 2_500;
    // A background poll or an @-delivery screen read is not a person looking at it.
    await service.perform({operation: 'read', requestId: crypto.randomUUID(), sessionId: session.id, after: 0}, authority);
    await service.perform({operation: 'read', requestId: crypto.randomUUID(), sessionId: session.id, after: 0, snapshot: true}, undefined, {receiptOwner: 'community:endpoint-0001'});
    expect(state(session.id)?.state).toBe('turn-finished');
    // Typing into it from the phone is.
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: '\x1b[A'}, authority);
    expect(state(session.id)?.state).toBe('idle');
  });

  test('a lone Enter is a keystroke, not a request: no working and no heuristic turn end (review 2026-10-16)', async () => {
    const {service, start, state, advance} = fakeService();
    const {session, child} = await start();
    child.emit(PROMPT); await advance(100);
    await advance(WORKROOM_STARTING_IDLE_QUIET_MS);
    expect(state(session.id)?.state).toBe('idle');
    // The empty composer's Enter pass-through, the Enter key button and agentstoz_use «enter» all send '\r' alone.
    for (const data of ['\r', '\x1b[B\r', ' \r']) {
      await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data});
      expect(state(session.id)?.state).toBe('idle');
    }
    await advance(WORKROOM_TURN_FINISHED_QUIET_MS + 1_000);
    expect(state(session.id)?.state).toBe('idle');
    // Text ended by Enter is still a request.
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: 'go\r'});
    expect(state(session.id)).toMatchObject({state: 'working', exact: true});
  });

  test('a close or restart that fails before the CLI was signalled leaves a later crash announced as an exit', async () => {
    let failRemember = true;
    const {service, start, state, exited} = fakeService({resume: async () => null, rememberEnded: () => { if (failRemember) throw new Error('queue write failed'); }});
    const a = await start();
    await expect(service.perform({operation: 'close', requestId: crypto.randomUUID(), sessionId: a.session.id})).rejects.toThrow('queue write failed');
    const b = await start();
    await expect(service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: b.session.id})).rejects.toThrow('queue write failed');
    failRemember = false;
    expect(state(a.session.id)?.state).not.toBe('exited');
    expect(state(b.session.id)?.state).not.toBe('exited');
    a.child.exit(139); b.child.exit(134);
    await exited(a.session.id); await exited(b.session.id);
    expect(state(a.session.id)).toMatchObject({state: 'exited', exitCode: 139, cause: 'exit'});
    expect(state(b.session.id)).toMatchObject({state: 'exited', exitCode: 134, cause: 'exit'});
  });

  test('sampling cost is bounded: twelve chatty sessions finish a sweep well inside its 1 s period', async () => {
    const {start, advance, service} = fakeService();
    const children = [];
    for (let i = 0; i < 12; i++) children.push((await start()).child);
    const line = (n: number) => `\x1b[2J\x1b[H${'x'.repeat(70)} ${n}\r\n`.repeat(20);
    const timings: number[] = [];
    for (let tick = 0; tick < 10; tick++) {
      for (const child of children) for (let burst = 0; burst < 20; burst++) child.emit(line(tick * 100 + burst));
      const started = performance.now();
      await advance(1_000);
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    // Measured ~5–20 ms on the dev Mac; the bound leaves room for a loaded machine and still proves the sweep is
    // per-session-once, not per-chunk (200 chunks per session per tick here).
    expect(timings[Math.floor(timings.length / 2)]!).toBeLessThan(400);
    expect(service.activitySnapshot()).toHaveLength(12);
  });
});

// ---------------------------------------------------------------- transcripts (exact turn ends)

const claudeLine = (row: object) => JSON.stringify(row) + '\n';
describe('turn parser and bounded transcript tail', () => {
  test('only public final text is captured, with a bounded Unicode-safe result', () => {
    const at='2026-10-16T01:00:05.000Z';
    const codex=parseWorkroomTurnCompletions('codex',claudeLine({timestamp:at,type:'event_msg',payload:{type:'task_complete',turn_id:'final',last_agent_message:'연결 확인'}}));
    expect(codex[0]?.resultText).toBe('연결 확인');
    const claude=parseWorkroomTurnCompletions('claude',claudeLine({timestamp:at,type:'assistant',uuid:'final',message:{stop_reason:'end_turn',content:[{type:'thinking',thinking:'private'},{type:'tool_use',input:{secret:'not final'}},{type:'text',text:'완료 답변'}]}}));
    expect(claude[0]?.resultText).toBe('완료 답변');expect(JSON.stringify(claude)).not.toContain('private');
    expect(parseWorkroomTurnCompletions('codex',claudeLine({timestamp:at,type:'event_msg',payload:{type:'turn_aborted',last_agent_message:'취소'}}))).toEqual([]);
    const long=parseWorkroomTurnCompletions('codex',claudeLine({timestamp:at,type:'event_msg',payload:{type:'task_complete',last_agent_message:'😀'.repeat(10_000)}}))[0]!.resultText!;
    expect(Buffer.byteLength(long)).toBeLessThan(12_200);expect(long).toContain('나머지는 연결 워크룸');expect(long).not.toContain('\uFFFD');
  });

  test('an exact final reply is mirrored once and a temporary recording failure retries without AI input',async()=>{
    let rows:any[]=[],attempts=0;const recorded:any[]=[];
    const f=fakeService({turnSignals:{poll:async()=>({completions:rows.splice(0),bytes:100}),forget(){}},threadCompleted:async(id,c,revision,active)=>{
      attempts++;if(attempts===1)throw Error('temporary store failure');if(active())recorded.push({id,...c,revision});
    }});
    const {session}=await f.start();await f.service.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:session.id,data:'답변해\r'});
    rows=[{key:'codex:final-one',completedAt:f.clock.now,resultText:'최종 답변'}];await f.advance(100);expect(recorded).toEqual([]);
    await f.advance(15_000);expect(recorded).toHaveLength(1);expect(recorded[0]).toMatchObject({resultText:'최종 답변',revision:1});
    rows=[{key:'codex:final-one',completedAt:f.clock.now,resultText:'최종 답변'},{key:'codex:old-history',completedAt:0,resultText:'이전 답변'}];await f.advance(100);expect(recorded).toHaveLength(1);
  });

  test('a new input during transcript polling cannot complete the newer request with an older reply',async()=>{
    let release:((v:any)=>void)|undefined;const recorded:any[]=[];let pause=false;
    const f=fakeService({turnSignals:{poll:async()=>pause?await new Promise(resolve=>{release=resolve;}):({completions:[],bytes:0}),forget(){}},threadCompleted:async(...args)=>{recorded.push(args);}});
    const {session}=await f.start();await f.service.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:session.id,data:'첫 요청\r'});pause=true;
    const sampling=f.advance(10);while(!release)await Bun.sleep(1);
    await f.service.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:session.id,data:'둘째 요청\r'});
    release({completions:[{key:'codex:old-turn',completedAt:f.clock.now,resultText:'첫 요청 답'}],bytes:100});await sampling;
    expect(recorded).toEqual([]);expect(f.service.inspectSession(session.id,targetId).completedInputRevision).toBeNull();
  });
  test('claude end_turn counts, tool_use and side chains do not; codex task_complete counts', () => {
    const text = [
      claudeLine({type: 'user', sessionId: 's', timestamp: '2026-10-16T01:00:00.000Z'}),
      claudeLine({type: 'assistant', uuid: 'a1', timestamp: '2026-10-16T01:00:01.000Z', message: {stop_reason: 'tool_use'}}),
      claudeLine({type: 'assistant', uuid: 'a2', isSidechain: true, timestamp: '2026-10-16T01:00:02.000Z', message: {stop_reason: 'end_turn'}}),
      claudeLine({type: 'assistant', uuid: 'a3', timestamp: '2026-10-16T01:00:03.000Z', message: {stop_reason: 'end_turn'}}),
      '{"type":"assistant","partial', // a cut line is not evidence
    ].join('');
    expect(parseWorkroomTurnCompletions('claude', text)).toEqual([{key: 'claude:a3', completedAt: Date.parse('2026-10-16T01:00:03.000Z')}]);
    const codex = [
      JSON.stringify({timestamp: '2026-10-16T01:00:00.000Z', type: 'event_msg', payload: {type: 'task_started'}}),
      JSON.stringify({timestamp: '2026-10-16T01:00:05.000Z', type: 'event_msg', payload: {type: 'task_complete', turn_id: 't1'}}),
    ].join('\n') + '\n';
    expect(parseWorkroomTurnCompletions('codex', codex)).toEqual([{key: 'codex:t1', completedAt: Date.parse('2026-10-16T01:00:05.000Z')}]);
  });

  test('a claude workroom becomes exact turn-finished from its transcript; symlinks are refused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-activity-home-')); dirs.push(home);
    const {service, start, state, advance, clock, dir} = fakeService({env: {HOME: home}, turnSignals: createWorkroomTranscriptSignals()});
    const {session, child} = await start('claude');
    const projects = join(home, '.claude', 'projects', claudeProjectSlugCandidates(realpathSync(dir))[0]!);
    mkdirSync(projects, {recursive: true});
    const transcript = join(projects, `${session.id}.jsonl`);
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: 'hello\r'});
    child.emit('\x1b[2J\x1b[H✻ Thinking…\r\n');
    writeFileSync(transcript, claudeLine({type: 'user', timestamp: new Date(clock.now).toISOString()}));
    await advance(500);
    expect(state(session.id)?.state).toBe('working');
    appendFileSync(transcript, claudeLine({type: 'assistant', uuid: 'tool', timestamp: new Date(clock.now).toISOString(), message: {stop_reason: 'tool_use'}}));
    await advance(500);
    expect(state(session.id)?.state).toBe('working');
    appendFileSync(transcript, claudeLine({type: 'assistant', uuid: 'done', timestamp: new Date(clock.now).toISOString(), message: {stop_reason: 'end_turn'}}));
    await advance(500);
    expect(state(session.id)).toMatchObject({state: 'turn-finished', exact: true, source: 'transcript'});
    const complete=service.inspectSession(session.id,session.targetId);expect(complete.completedInputRevision).toBe(complete.inputRevision);
    await service.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:session.id,data:'next draft'});
    const typing=service.inspectSession(session.id,session.targetId);expect(typing.completedInputRevision).not.toBe(typing.inputRevision);

    // A symlinked transcript is never followed.
    const other = await start('claude');
    const outside = join(home, 'outside.jsonl');
    writeFileSync(outside, claudeLine({type: 'assistant', uuid: 'x', timestamp: new Date(clock.now + 1).toISOString(), message: {stop_reason: 'end_turn'}}));
    symlinkSync(outside, join(projects, `${other.session.id}.jsonl`));
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: other.session.id, data: 'go\r'});
    await advance(1_000);
    expect(state(other.session.id)?.state).toBe('working');
  });

  test('the tail reads at most its budget even when the file grew far more', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-activity-tail-')); dirs.push(home);
    const cwd = join(home, 'project'); mkdirSync(cwd);
    const projects = join(home, '.claude', 'projects', claudeProjectSlugCandidates(cwd)[0]!); mkdirSync(projects, {recursive: true});
    const path = join(projects, 'conversation-0001.jsonl');
    const filler = claudeLine({type: 'user', timestamp: '2026-10-16T00:00:00.000Z', text: 'x'.repeat(2_000)});
    writeFileSync(path, filler.repeat(1_000)); // ~2 MB of history
    const signals = createWorkroomTranscriptSignals({now: () => 0});
    const session = {sessionId: 'session-0001', agent: 'claude', cwd, env: {HOME: home}, createdAt: new Date().toISOString(), conversationId: 'conversation-0001', restricted: false, lastSubmitAt: null};
    const first = await signals.poll(session, WORKROOM_TRANSCRIPT_TICK_BYTES);
    expect(first.bytes).toBeLessThanOrEqual(WORKROOM_TRANSCRIPT_TICK_BYTES);
    appendFileSync(path, filler.repeat(1_000) + claudeLine({type: 'assistant', uuid: 'end', timestamp: '2026-10-16T00:00:09.000Z', message: {stop_reason: 'end_turn'}}));
    const second = await signals.poll(session, WORKROOM_TRANSCRIPT_TICK_BYTES);
    expect(second.bytes).toBeLessThanOrEqual(WORKROOM_TRANSCRIPT_TICK_BYTES);
    expect(second.completions.map(c => c.key)).toEqual(['claude:end']);
    // Restricted sessions and screen-only CLIs are never read.
    expect(await signals.poll({...session, sessionId: 'session-0002', restricted: true}, WORKROOM_TRANSCRIPT_TICK_BYTES)).toEqual({completions: [], bytes: 0});
    expect(await signals.poll({...session, sessionId: 'session-0003', agent: 'hermes'}, WORKROOM_TRANSCRIPT_TICK_BYTES)).toEqual({completions: [], bytes: 0});
  });

  test('a codex workroom binds its rollout through the thread lock and reads task_complete', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-activity-codex-')); dirs.push(home);
    const thread = '019fe081-1111-4222-8333-444455556666';
    const lock = join(home, '.codex', 'thread-writer-locks', `${thread}.lock`);
    let opened = 0;
    const {service, start, state, advance, clock, dir} = fakeService({env: {HOME: home},
      turnSignals: createWorkroomTranscriptSignals({platform: 'darwin', openFiles: async () => { opened++; return [lock]; }})});
    const {session} = await start('codex');
    const day = new Date(); // Codex files rollouts by the real local date of the session
    const folder = join(home, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    mkdirSync(folder, {recursive: true});
    const rollout = join(folder, `rollout-2026-10-16T01-00-00-${thread}.jsonl`);
    writeFileSync(rollout, JSON.stringify({type: 'session_meta', payload: {id: thread, cwd: realpathSync(dir), timestamp: day.toISOString(), source: 'cli'}}) + '\n');
    await service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: 'go\r'});
    await advance(500);
    expect(opened).toBe(1);
    appendFileSync(rollout, JSON.stringify({timestamp: new Date(clock.now).toISOString(), type: 'event_msg', payload: {type: 'task_complete', turn_id: 'turn-1'}}) + '\n');
    await advance(500);
    expect(state(session.id)).toMatchObject({state: 'turn-finished', exact: true});
    expect(opened).toBe(1); // bound once, cached
  });
});

// Review 2026-10-16: bounded, non-blocking tails; a resumed Codex thread binds wherever its rollout lives.
describe('transcript tail: review fixes', () => {
  const dayFolder = (home: string, at: Date) => join(home, '.codex', 'sessions', String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0'));

  test('a resumed Codex thread whose rollout sits in an older day folder still binds', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-activity-resumed-')); dirs.push(home);
    const thread = '019fe081-1111-4222-8333-444455556666';
    const old = new Date(Date.now() - 3 * 86_400_000);
    const folder = dayFolder(home, old); mkdirSync(folder, {recursive: true});
    const rollout = join(folder, `rollout-x-${thread}.jsonl`);
    writeFileSync(rollout, JSON.stringify({type: 'session_meta', payload: {id: thread, cwd: home, timestamp: old.toISOString(), source: 'cli'}}) + '\n');
    const signals = createWorkroomTranscriptSignals({platform: 'darwin'});
    const session = {sessionId: 'session-0001', agent: 'codex', cwd: home, env: {HOME: home}, createdAt: new Date().toISOString(),
      conversationId: thread, restricted: false, lastSubmitAt: Date.now()};
    await signals.poll(session, WORKROOM_TRANSCRIPT_TICK_BYTES);
    appendFileSync(rollout, JSON.stringify({timestamp: new Date().toISOString(), type: 'event_msg', payload: {type: 'task_complete', turn_id: 't9'}}) + '\n');
    const got = await signals.poll({...session, lastSubmitAt: Date.now() + 1}, WORKROOM_TRANSCRIPT_TICK_BYTES);
    expect(got.completions.map(c => c.key)).toEqual(['codex:t9']);
  });

  test('a FIFO swapped in between the stat and the open never blocks the sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentstoz-activity-fifo-')); dirs.push(dir);
    const path = join(dir, 'conversation.jsonl');
    writeFileSync(path, claudeLine({type: 'user', timestamp: '2026-10-16T00:00:00.000Z'}));
    // In a child: the race is forced by a hook that swaps a FIFO in right after the stat. A blocking open hangs the child.
    const script = `
      import {rmSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
      import {readWorkroomTranscriptAppended} from ${JSON.stringify(join(import.meta.dir, '../src/aiTerminalActivityTranscript.ts'))};
      const path = ${JSON.stringify(path)};
      const result = readWorkroomTranscriptAppended(path, 0, 65536, {afterStat: () => { rmSync(path); spawnSync('mkfifo', [path]); }});
      console.log(JSON.stringify(result));`;
    const child = spawnSync(process.execPath, ['-e', script], {timeout: 8_000, encoding: 'utf8'});
    expect(child.signal).toBeNull();
    expect(child.stdout.trim()).toBe('null');
  }, 15_000);

  test('a replaced file is re-read from its newest window on the next poll, never past the budget', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-activity-replaced-')); dirs.push(home);
    const cwd = join(home, 'project'); mkdirSync(cwd);
    const projects = join(home, '.claude', 'projects', claudeProjectSlugCandidates(cwd)[0]!); mkdirSync(projects, {recursive: true});
    const path = join(projects, 'conversation-0001.jsonl');
    const filler = claudeLine({type: 'user', timestamp: '2026-10-16T00:00:00.000Z', text: 'x'.repeat(2_000)});
    writeFileSync(path, filler.repeat(100));
    let read = 0;
    const signals = createWorkroomTranscriptSignals({now: () => 0, onRead: bytes => { read += bytes; }});
    const session = {sessionId: 'session-0001', agent: 'claude', cwd, env: {HOME: home}, createdAt: new Date().toISOString(), conversationId: 'conversation-0001', restricted: false, lastSubmitAt: null};
    const budget = 64 * 1024;
    await signals.poll(session, budget);
    // Replaced by a larger file (another inode).
    const fresh = join(projects, 'fresh.jsonl');
    writeFileSync(fresh, filler.repeat(200) + claudeLine({type: 'assistant', uuid: 'end', timestamp: '2026-10-16T00:00:09.000Z', message: {stop_reason: 'end_turn'}}));
    renameSync(fresh, path);
    read = 0;
    const second = await signals.poll(session, budget);
    expect(read).toBeLessThanOrEqual(budget);
    expect(second.bytes).toBe(read);
    read = 0;
    const third = await signals.poll(session, budget);
    expect(read).toBeLessThanOrEqual(budget);
    expect(third.bytes).toBe(read);
    expect([...second.completions, ...third.completions].map(c => c.key)).toEqual(['claude:end']);
  });

  test('Windows rollout matching charges what it reads to the sweep budget and skips files untouched since the start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-activity-winmatch-')); dirs.push(home);
    const now = Date.now();
    const folder = dayFolder(home, new Date(now)); mkdirSync(folder, {recursive: true});
    const meta = (id: string, cwd: string) => JSON.stringify({type: 'session_meta', payload: {id, cwd, timestamp: new Date(now).toISOString(), source: 'cli', instructions: 'i'.repeat(40_000)}}) + '\n';
    for (let i = 0; i < 40; i++) {
      const id = `019fe081-1111-4222-8333-${String(i).padStart(12, '0')}`;
      writeFileSync(join(folder, `rollout-x-${id}.jsonl`), meta(id, join(home, `other-${i}`)));
    }
    // An old rollout touched before the session started is not even opened.
    const stale = join(folder, 'rollout-x-019fe081-1111-4222-8333-999999999999.jsonl');
    writeFileSync(stale, meta('019fe081-1111-4222-8333-999999999999', join(home, 'stale')));
    utimesSync(stale, new Date(now - 3_600_000), new Date(now - 3_600_000));
    let read = 0;
    const signals = createWorkroomTranscriptSignals({platform: 'win32', now: () => now, onRead: bytes => { read += bytes; }});
    const session = {sessionId: 'session-0001', agent: 'codex', cwd: join(home, 'project'), env: {HOME: home}, createdAt: new Date(now - 60_000).toISOString(),
      restricted: false, lastSubmitAt: now};
    const budget = 200 * 1024;
    const got = await signals.poll(session, budget);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThanOrEqual(budget);
    expect(got.bytes).toBe(read);
  });
});
