/**
 * 「에포트 자동」 at launch (w16): the real terminal service with a fake PTY. The host decides from the first request
 * and passes each CLI's own launch flag; restricted (CS duty), history resume, no-request and Antigravity launches
 * pass nothing. A 「다시 시작」 keeps the level the replaced session launched with, unless the person changed it.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService, type AiTerminalAuthority} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {submissionDigest} from '../src/workroomSubmissionProtocol';
import type {CodexEffortModel} from '../src/codexEffortModel';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const TARGET = 'project-effort-1234';

function fixture(options: {auto?: boolean; env?: Record<string, string>; codex?: CodexEffortModel; journal?: boolean} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'effort-launch-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  let auto = options.auto ?? true;
  const spawns: string[][] = [];
  const children: {pid: number; exit(code: number): void}[] = [];
  let store: WorkroomConversationJournal | undefined;
  if (options.journal) { store = new WorkroomConversationJournal((mkdirSync(join(dir, 'journal'), {mode: 0o700}), join(dir, 'journal'))); cleanups.push(() => store!.close()); }
  const service = new AiTerminalService({
    ...(store ? {submissions: () => store!} : {}),
    resolveTarget: async id => { if (id !== TARGET) throw new Error('unregistered'); return {cwd: dir}; },
    executable: agent => `/fixture/bin/${agent}`, headlessScreen: false, activitySampler: false,
    env: {HOME: dir, PATH: '/usr/bin', ...(options.env ?? {})},
    effortAuto: {get: () => auto, set: value => (auto = value)},
    codexEffortModel: () => options.codex ?? {ok: true, model: null, allowed: ['low', 'medium', 'high']},
    resume: async () => null,
    signalGroup: pid => children.find(child => child.pid === pid)?.exit(143),
    spawn: (args, spawnOptions: any) => {
      spawns.push(args);
      let settle!: (code: number) => void;
      const exited = new Promise<number>(resolve => { settle = resolve; });
      const child = {pid: 7_000_000 + spawns.length, exit: (code: number) => { spawnOptions.terminal.exit?.(); settle(code); }};
      children.push(child);
      return {pid: child.pid, exited, kill: () => child.exit(143), terminal: {write: (data: string) => Buffer.byteLength(data), resize() {}, close() {}}} as any;
    },
  });
  cleanups.push(() => service.shutdown());
  const start = async (agent: 'claude' | 'codex' | 'hermes' | 'agy', prompt?: string, extra: Record<string, unknown> = {}, authority?: AiTerminalAuthority) =>
    (await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: TARGET, agent, cols: 80, rows: 24, ...(prompt !== undefined ? {prompt} : {}), ...extra}, authority)).session!;
  const record = async (sessionId: string) => (await service.performEffort({operation: 'effort', sessionIds: [sessionId]})).effort.sessions[0]!;
  return {service, spawns, start, record, cwd: realpathSync(dir), setAuto: (value: boolean) => { auto = value; }};
}
const flag = (args: string[] | undefined, name: string) => { const i = (args ?? []).indexOf(name); return i < 0 ? null : args![i + 1]; };

test('normal starts, restarts and saved resumes enforce approval policy instead of inheriting a global bypass', async () => {
  for (const agent of ['codex', 'claude'] as const) {
    const f = fixture();
    const first = await f.start(agent);
    await f.start(agent, undefined, {resumeFrom: first.id});
    await f.service.perform({operation:'start', requestId:crypto.randomUUID(), targetId:TARGET, agent, accountId:'host-default', cols:80, rows:24}, undefined,
      {historyResume:{logicalConversationId:crypto.randomUUID(), accountId:'host-default', cwd:f.cwd,
        resume:{agent, conversationId:crypto.randomUUID()}, validate:async()=>{}, launching:()=>{}}});
    expect(f.spawns).toHaveLength(3);
    for (const args of f.spawns) {
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('bypassPermissions');
      if (agent === 'codex') {
        expect(flag(args, '--ask-for-approval')).toBe('on-request');
        expect(flag(args, '--sandbox')).toBe('workspace-write');
      } else expect(flag(args, '--permission-mode')).toBe('default');
    }
  }
});

test('ON: a hard request starts Claude at high, a routine one at low, anything else at medium — before the prompt', async () => {
  const f = fixture();
  const hard = await f.start('claude', '두 창이 동시에 저장하면 데드락이 걸려요');
  expect(f.spawns[0]!.slice(1)).toEqual(['--session-id', hard.id, '--permission-mode', 'default', '--effort', 'high', '--', '두 창이 동시에 저장하면 데드락이 걸려요']);
  expect(await f.record(hard.id)).toMatchObject({sessionId: hard.id, agent: 'claude', tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch', manual: false});
  await f.start('claude', 'fix the typo in README');
  expect(flag(f.spawns[1], '--effort')).toBe('low');
  await f.start('claude', 'add a settings toggle');
  expect(flag(f.spawns[2], '--effort')).toBe('medium');
  // The record never rides the wire summary: phone normalizers reject unknown keys.
  expect(Object.keys(hard)).not.toContain('effort');
});

test('OFF: no flag at all, and the record says why', async () => {
  const f = fixture({auto: false});
  const session = await f.start('claude', 'fix the deadlock');
  expect(f.spawns[0]!.includes('--effort')).toBe(false);
  expect(await f.record(session.id)).toMatchObject({skipped: 'off', manual: false});
  expect((await f.record(session.id)).level).toBeUndefined();
});

test('no first request, a CLI command or Antigravity: no flag', async () => {
  const f = fixture();
  const empty = await f.start('claude');
  expect(f.spawns[0]!.includes('--effort')).toBe(false);
  expect(await f.record(empty.id)).toMatchObject({skipped: 'no-request'});
  const slash = await f.start('claude', '/compact');
  expect(f.spawns[1]!.includes('--effort')).toBe(false);
  expect(await f.record(slash.id)).toMatchObject({skipped: 'unclassified'});
  const agy = await f.start('agy', 'fix the deadlock');
  expect(f.spawns[2]!.some(arg => /effort|reasoning/.test(arg))).toBe(false);
  expect(await f.record(agy.id)).toMatchObject({agent: 'agy', skipped: 'unsupported'});
});

test('Codex: -c model_reasoning_effort only for a proven catalog model; Hermes: chat --reasoning', async () => {
  const proven = fixture();
  await proven.start('codex', 'write the migration for the ports table');
  expect(proven.spawns[0]!).toContain('model_reasoning_effort="high"');
  expect(proven.spawns[0]!.indexOf('model_reasoning_effort="high"')).toBeLessThan(proven.spawns[0]!.indexOf('--'));
  const unknown = fixture({codex: {ok: false, why: 'model'}});
  const session = await unknown.start('codex', 'write the migration for the ports table');
  expect(unknown.spawns[0]!.some(arg => arg.includes('model_reasoning_effort'))).toBe(false);
  expect(await unknown.record(session.id)).toMatchObject({tier: 'high', skipped: 'model-unknown'});
  const hermes = fixture();
  await hermes.start('hermes', 'rename the variable');
  expect(hermes.spawns[0]!.slice(1, 4)).toEqual(['chat', '--reasoning', 'low']);
});

test('CLAUDE_CODE_EFFORT_LEVEL in the launch environment overrides the flag, so none is passed', async () => {
  const f = fixture({env: {CLAUDE_CODE_EFFORT_LEVEL: 'max'}});
  const session = await f.start('claude', 'fix the deadlock');
  expect(f.spawns[0]!.includes('--effort')).toBe(false);
  expect(await f.record(session.id)).toMatchObject({skipped: 'env-override'});
});

test('a restricted CS duty launch keeps its own rules; a history resume passes nothing', async () => {
  const f = fixture();
  const profile = {permissionMode: 'dontAsk' as const, tools: ['Read'], allowedTools: ['Read(./**)'], disallowedTools: []};
  const duty = (await f.service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: TARGET, agent: 'claude', cols: 80, rows: 24, prompt: 'fix the deadlock'}, undefined, {launchProfile: profile})).session!;
  expect(f.spawns[0]!.includes('--effort')).toBe(false);
  expect(await f.record(duty.id)).toMatchObject({skipped: 'restricted'});
  const resumed = (await f.service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: TARGET, agent: 'claude', cols: 80, rows: 24, accountId: 'host-default'}, undefined,
    {historyResume: {logicalConversationId: crypto.randomUUID(), accountId: 'host-default', cwd: f.cwd,
      resume: {agent: 'claude', conversationId: crypto.randomUUID()}, validate: async () => {}, launching: () => {}}})).session!;
  expect(f.spawns[1]!.includes('--effort')).toBe(false);
  expect(await f.record(resumed.id)).toMatchObject({skipped: 'history-resume'});
});

test('「다시 시작」 keeps the launch level; after the person changed effort it passes nothing', async () => {
  const f = fixture();
  const first = await f.start('claude', '왜 자꾸 빌드가 깨지지?');
  expect(flag(f.spawns[0], '--effort')).toBe('high');
  const second = await f.start('claude', undefined, {resumeFrom: first.id});
  expect(flag(f.spawns[1], '--effort')).toBe('high');
  expect(await f.record(second.id)).toMatchObject({tier: 'high', reason: 'unclear-failure', level: 'high', origin: 'restart', manual: false});
  // A native selection does not disable Auto; a restart reuses the prior task context.
  await f.service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: second.id, data: '/effort\r'});
  expect(await f.record(second.id)).toMatchObject({manual: true});
  const third = await f.start('claude', undefined, {resumeFrom: second.id});
  expect(flag(f.spawns[2], '--effort')).toBe('high');
  expect(await f.record(third.id)).toMatchObject({manual: false, level: 'high'});
  // Turned OFF meanwhile: a restart of an auto session passes nothing either.
  const fourth = await f.start('claude', 'fix the deadlock');
  f.setAuto(false);
  await f.start('claude', undefined, {resumeFrom: fourth.id});
  expect(f.spawns[4]!.includes('--effort')).toBe(false);
});

test('a phone (remote authority) and a launch submission follow this Mac\'s setting', async () => {
  const f = fixture({journal: true});
  const authority: AiTerminalAuthority = {owner: 'internet:phone-1234', targets: new Set([TARGET])};
  f.service.setRemoteAccess(authority.owner, true);
  await f.start('claude', 'Check the search endpoint for SQL injection', {}, authority);
  expect(flag(f.spawns[0], '--effort')).toBe('high');
  const text = 'fix the typo in README\r', bytes = new TextEncoder().encode(text);
  const launched = await f.service.perform({operation: 'submission', requestId: crypto.randomUUID(), submission: {phase: 'single', id: 'launch-effort', bytes: bytes.length, digest: submissionDigest(bytes),
    data: Buffer.from(bytes).toString('base64'), launch: {targetId: TARGET, agent: 'claude', cols: 80, rows: 24}}});
  expect(launched.submission?.state).toBe('written');
  expect(flag(f.spawns[1], '--effort')).toBe('low');
  f.setAuto(false);
  await f.start('claude', 'fix the deadlock', {}, authority);
  expect(f.spawns[2]!.includes('--effort')).toBe(false);
});

test('restart plan: the replaced launch\'s tier is kept and the CLI-side checks run again', async () => {
  const {planWorkroomEffort} = await import('../src/workroomEffortSession');
  const base = {auto: true, restricted: false, historyResume: false, envOverride: false};
  const unknownCodex = {tier: 'high' as const, reason: 'migration' as const, manual: false, skipped: 'model-unknown' as const};
  expect(planWorkroomEffort({...base, agent: 'codex', previous: unknownCodex, codexAllowed: () => ['low', 'medium', 'high']}))
    .toEqual({tier: 'high', reason: 'migration', manual: false, level: 'high', origin: 'restart'});
  expect(planWorkroomEffort({...base, agent: 'codex', previous: unknownCodex, codexAllowed: () => null})).toMatchObject({skipped: 'model-unknown'});
  expect(planWorkroomEffort({...base, agent: 'claude', previous: {tier: 'low', reason: 'typo', level: 'low', manual: false}, envOverride: true})).toMatchObject({skipped: 'env-override'});
  expect(planWorkroomEffort({...base, agent: 'claude', previous: {manual: false, skipped: 'unclassified'}})).toEqual({manual: false, skipped: 'unclassified'});
  expect(planWorkroomEffort({...base, agent: 'claude', previous: {manual: false, skipped: 'off'}})).toEqual({manual: false, skipped: 'no-request'});
  expect(planWorkroomEffort({...base, agent: 'claude', previous: {manual: true, seen: 'max'}})).toEqual({manual: false, skipped: 'no-request'});
});
