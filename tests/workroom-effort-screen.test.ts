/**
 * 「에포트 자동」 after launch (w16): the host reads the effort the CLI shows (the w9 sampler already reads rows after
 * output), notices when the person changes it themselves, and on each whole-request submission records advice when
 * the request seems to need another level. It types nothing into the CLI.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {submissionDigest} from '../src/workroomSubmissionProtocol';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const TARGET = 'project-effort-1234';

function fixture(options: {auto?: boolean} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'effort-screen-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  const store = new WorkroomConversationJournal((mkdirSync(join(dir, 'journal'), {mode: 0o700}), join(dir, 'journal')));
  cleanups.push(() => store.close());
  let auto = options.auto ?? true;
  const clock = {now: 2_000_000};
  const children: {pid: number; emit(text: string): void; writes: string[]; exit(code: number): void}[] = [];
  const service = new AiTerminalService({
    submissions: () => store,
    resolveTarget: async id => { if (id !== TARGET) throw new Error('unregistered'); return {cwd: dir}; },
    executable: agent => `/fixture/bin/${agent}`, activitySampler: false, activityClock: () => clock.now,
    env: {HOME: dir, PATH: '/usr/bin'},
    effortAuto: {get: () => auto, set: value => (auto = value)},
    codexEffortModel: () => ({ok: true, model: null, allowed: ['low', 'medium', 'high']}),
    signalGroup: pid => children.find(child => child.pid === pid)?.exit(143),
    spawn: (_args, spawnOptions: any) => {
      let settle!: (code: number) => void;
      const exited = new Promise<number>(resolve => { settle = resolve; });
      const writes: string[] = [];
      const child = {pid: 7_100_000 + children.length, writes,
        emit: (text: string) => spawnOptions.terminal.data(null, new TextEncoder().encode(text)),
        exit: (code: number) => { spawnOptions.terminal.exit?.(); settle(code); }};
      children.push(child);
      return {pid: child.pid, exited, kill: () => child.exit(143), terminal: {write: (data: string) => { writes.push(data); return Buffer.byteLength(data); }, resize() {}, close() {}}} as any;
    },
  });
  cleanups.push(() => service.shutdown());
  const start = async (agent: 'claude' | 'codex' | 'hermes', prompt?: string) => {
    const session = (await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: TARGET, agent, cols: 100, rows: 24, ...(prompt ? {prompt} : {})})).session!;
    return {session, child: children.at(-1)!};
  };
  const screen = async (child: {emit(text: string): void}, text: string) => { child.emit(text); clock.now += 50; await Bun.sleep(5); await service.sampleActivity(); };
  const record = async (sessionId: string) => (await service.performEffort({operation: 'effort', sessionIds: [sessionId]})).effort.sessions[0]!;
  let n = 0;
  const submit = async (sessionId: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    return service.perform({operation: 'submission', requestId: crypto.randomUUID(), sessionId, submission: {phase: 'single', id: `submission-${++n}`, bytes: bytes.length, digest: submissionDigest(bytes), data: Buffer.from(bytes).toString('base64')}});
  };
  return {service, start, screen, record, submit, setAuto: (value: boolean) => { auto = value; }};
}

test('the effort Claude shows is recorded; a clamp below the requested level is shown, not «fixed»', async () => {
  const f = fixture();
  const {session, child} = await f.start('claude', 'fix the deadlock in the queue');
  await f.screen(child, '\x1b[2J\x1b[H Welcome\r\n> \r\n  ◐ medium · /effort\r\n');
  expect(await f.record(session.id)).toMatchObject({level: 'high', seen: 'medium', manual: false});
  // Nothing was typed into the CLI by auto.
  expect(child.writes).toEqual([]);
});

test('native choices are observed until the next contextual auto request (screen or typed)', async () => {
  const f = fixture();
  const claude = await f.start('claude', 'add a toggle');
  await f.screen(claude.child, '\x1b[2J\x1b[H> \r\n  ◐ medium · /effort\r\n');
  expect((await f.record(claude.session.id)).manual).toBe(false);
  await f.screen(claude.child, '\x1b[2J\x1b[H> /effort\r\n  ⎿  Set effort level to low (this session only)\r\n> \r\n');
  expect(await f.record(claude.session.id)).toMatchObject({manual: true, seen: 'low'});

  const codex = await f.start('codex', 'add a toggle');
  await f.screen(codex.child, '\x1b[2J\x1b[H model: gpt-6-sol medium   /model to change\r\n> \r\n');
  expect(await f.record(codex.session.id)).toMatchObject({seen: 'medium', manual: false});
  await f.screen(codex.child, '\x1b[2J\x1b[H • Model changed to gpt-6-luna high\r\n> \r\n');
  expect(await f.record(codex.session.id)).toMatchObject({manual: true, seen: 'high'});

  const hermes = await f.start('hermes', 'add a toggle');
  await f.service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: hermes.session.id, data: '/reasoning high\r'});
  expect((await f.record(hermes.session.id)).manual).toBe(true);
});

test('a phrase already on the first screen read (a resumed transcript) is the baseline, not a change', async () => {
  const f = fixture();
  const {session, child} = await f.start('claude', 'add a toggle');
  await f.screen(child, '\x1b[2J\x1b[H  ⎿  Set effort level to medium (this session only)\r\n> \r\n');
  expect((await f.record(session.id)).manual).toBe(false);
  // The same line scrolled with other output is still not new.
  await f.screen(child, '\x1b[2J\x1b[H  ⎿  Set effort level to medium (this session only)\r\n⏺ Done.\r\n> \r\n');
  expect((await f.record(session.id)).manual).toBe(false);
});

test('advice: a whole-request submission that needs another level is recorded — nothing is typed, nothing waits', async () => {
  const f = fixture();
  const {session, child} = await f.start('claude', 'add a settings toggle');
  expect((await f.record(session.id)).level).toBe('medium');
  const before = child.writes.length;
  const started = Date.now();
  expect((await f.submit(session.id, '왜 자꾸 빌드가 깨지지? 원인 찾아줘\r')).submission?.state).toBe('written');
  expect(Date.now() - started).toBeLessThan(1_000);
  // Only the person's request was written.
  expect(child.writes.slice(before).join('')).toBe('왜 자꾸 빌드가 깨지지? 원인 찾아줘\r');
  expect((await f.record(session.id)).advice).toMatchObject({tier: 'high', reason: 'unclear-failure'});
  // A CLI command keeps the advice; a request that matches the current level clears it.
  await f.submit(session.id, '/compact\r');
  expect((await f.record(session.id)).advice).toMatchObject({tier: 'high'});
  await f.submit(session.id, 'add another toggle\r');
  expect((await f.record(session.id)).advice).toBeUndefined();
});

test('OFF suppresses advice while Auto resumes contextual advice after manual selection', async () => {
  const f = fixture();
  const {session} = await f.start('claude', 'add a settings toggle');
  const state = await f.service.submitHostInstruction({id: 'use-instruction-1', sessionId: session.id, data: 'fix the deadlock\r', receiptOwner: 'agentstoz:use', skipCorrections: true});
  expect(state.state).toBe('written');
  expect((await f.record(session.id)).advice).toBeUndefined();
  f.setAuto(false);
  await f.submit(session.id, 'fix the deadlock\r');
  expect((await f.record(session.id)).advice).toBeUndefined();
  f.setAuto(true);
  await f.service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: session.id, data: '/model\r'});
  await f.submit(session.id, 'fix the deadlock\r');
  expect(await f.record(session.id)).toMatchObject({manual: false,advice:{tier:'high'}});
});

test('a session started without auto gets advice only when the request needs low or high', async () => {
  const f = fixture();
  const {session} = await f.start('claude');
  await f.submit(session.id, 'add a toggle\r');
  expect((await f.record(session.id)).advice).toBeUndefined();
  await f.submit(session.id, 'audit the sandbox boundary\r');
  expect((await f.record(session.id)).advice).toMatchObject({tier: 'high', reason: 'security'});
});

test('Auto may re-evaluate a higher current level for both hard and routine requests', async () => {
  const f = fixture();
  const {session, child} = await f.start('claude');
  await f.screen(child, '\x1b[2J\x1b[H> \r\n  ● max · /effort\r\n');
  await f.submit(session.id, 'fix the deadlock\r');
  expect((await f.record(session.id)).advice).toMatchObject({tier:'high'});
  await f.submit(session.id, 'fix the typo\r');
  expect((await f.record(session.id)).advice).toMatchObject({tier: 'low', reason: 'typo'});
});
