/**
 * agentstoz_use_set_workroom_effort (MCP 1.81.0): a person's session-only effort choice for another Workroom session.
 *
 * Real AiTerminalService, real native effort control (src/workroomEffortRuntime.ts), real MCP mapping and host parser;
 * only the PTY is fake — no CLI, model, installed app, Keychain or shared setting file is touched (the effort setting is
 * a temporary file under the fixture directory and HOME points there too).
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {createWorkroomEffortSetting} from '../src/workroomEffortSetting';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import {changeWorkroomEffort} from '../src/workroomEffortRuntime';
import {workroomEffortBadgeText} from '../src/workroomEffortView';
import {
  holdWorkroomEffortChoice, releaseWorkroomEffortChoice, workroomEffortChoiceLevels, workroomEffortChoiceView,
  workroomEffortRestartBase, type WorkroomEffortChoiceInput,
} from '../src/workroomEffortChoice';
import {noteWorkroomEffortRequest, observeWorkroomEffortScreen, workroomEffortRecord, type WorkroomEffortState} from '../src/workroomEffortSession';
import {agentsToZUseWorkroomEffort} from '../src/agentstozUseWorkroomEffort';
import {AgentsToZUseControlError, parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {AGENTSTOZ_USE_MCP_TOOLS, WORKROOM_EFFORT_ASK_TIMEOUT_MS, agentsToZUseMcpActionForTool, agentsToZUseMcpTimeoutMs, handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

// ---------------------------------------------------------------- pure rules

const base = (over: Partial<WorkroomEffortChoiceInput> = {}): WorkroomEffortChoiceInput => ({
  sessionId: 'session-choice-0001', agent: 'codex', pid: 4242, inputRevision: 3, running: true,
  rows: ['› Ask Codex to do anything', '', '  gpt-6.1-sol high · 100% context left'], hasScreen: true,
  restricted: false, envOverride: false, thinkingOff: false, support: {claudeSessionPicker: true, codexDefaultKeys: true}, ...over,
});

describe('which levels a person may choose', () => {
  test('per CLI and model, never a level the session cannot take', () => {
    expect(workroomEffortChoiceLevels({agent: 'claude', thinkingOff: false}, 'Opus 5.5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(workroomEffortChoiceLevels({agent: 'claude', thinkingOff: false, launchModel: {model: 'claude-sonnet-5-5'}})).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // An unidentified Claude model, or thinking off: only what every Claude model takes.
    expect(workroomEffortChoiceLevels({agent: 'claude', thinkingOff: false}, 'some-future-model')).toEqual(['low', 'medium', 'high']);
    expect(workroomEffortChoiceLevels({agent: 'claude', thinkingOff: true}, 'Opus 5.5')).toEqual(['low', 'medium', 'high']);
    expect(workroomEffortChoiceLevels({agent: 'codex', thinkingOff: false}, 'unknown-codex-model')).toEqual(['low', 'medium', 'high']);
    // Codex: extra levels only where its config proof names the very model the screen shows.
    const proof = {model: 'gpt-6.1-terra', allowed: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const};
    const terra = workroomEffortChoiceLevels({agent: 'codex', thinkingOff: false, codexProof: proof}, 'GPT-6.1-Terra');
    expect(terra.slice(0, 3)).toEqual(['low', 'medium', 'high']);
    expect(terra.length).toBeGreaterThan(3);
    expect(workroomEffortChoiceLevels({agent: 'codex', thinkingOff: false}, 'gpt-6.1-terra')).toEqual(['low', 'medium', 'high']);
    expect(workroomEffortChoiceLevels({agent: 'codex', thinkingOff: false, codexProof: proof}, 'gpt-6.1-sol')).toEqual(['low', 'medium', 'high']);
    expect(workroomEffortChoiceLevels({agent: 'codex', thinkingOff: false, codexProof: {model: null, allowed: ['low', 'medium', 'high']}}, 'gpt-6.1-terra')).toEqual(['low', 'medium', 'high']);
    expect(workroomEffortChoiceLevels({agent: 'hermes', thinkingOff: false, launchModel: {model: 'claude-haiku-5-5', provider: 'anthropic'}})).toEqual([]);
    expect(workroomEffortChoiceLevels({agent: 'agy', thinkingOff: false})).toEqual([]);
  });

  test('refusals say why, in a fixed order, and offer nothing to pick', () => {
    const reason = (over: Partial<WorkroomEffortChoiceInput>) => workroomEffortChoiceView(base(over));
    expect(reason({running: false}).unsupportedReason).toBe('not-running');
    expect(reason({agent: 'agy'}).unsupportedReason).toBe('agy-model-variant');
    expect(reason({restricted: true}).unsupportedReason).toBe('restricted');
    expect(reason({state: {manual: false, pinned: 'high', level: 'high'}}).unsupportedReason).toBe('team-pinned');
    expect(reason({agent: 'claude', envOverride: true, rows: []}).unsupportedReason).toBe('env-override');
    expect(reason({support: {claudeSessionPicker: true, codexDefaultKeys: false}}).unsupportedReason).toBe('cli-control-unavailable');
    expect(reason({agent: 'hermes', launchModel: {model: 'claude-haiku-5-5', provider: 'anthropic'}}).unsupportedReason).toBe('model-no-effort');
    expect(reason({hasScreen: false, rows: null}).unsupportedReason).toBe('screen-unavailable');
    // No level to count a change from or to read back: refused at the read, before the person is asked.
    expect(reason({rows: ['› Ask Codex to do anything']}).unsupportedReason).toBe('effort-not-shown');
    // An earlier unknown outcome on this process: refused at the read, naming the request to check.
    expect(reason({outcomeUnknown: 'choice-earlier-0001'})).toMatchObject({unsupportedReason: 'previous-outcome-unknown', originalRequestId: 'choice-earlier-0001', choices: []});
    expect(reason({running: false, outcomeUnknown: 'choice-earlier-0001'}).unsupportedReason).toBe('not-running');
    for (const over of [{running: false}, {agent: 'agy' as const}, {restricted: true}]) {
      const view = reason(over);
      expect(view.supported).toBe(false); expect(view.choices).toEqual([]); expect(view.unsupportedText).toBeTruthy();
    }
  });

  test('current says where it came from: the screen now, or the level last observed there', () => {
    expect(workroomEffortChoiceView(base({}))).toMatchObject({current: 'high', currentFrom: 'screen', supported: true});
    const launchModel = {model: 'gpt-6.1-sol'};
    const hidden = workroomEffortChoiceView(base({launchModel, rows: ['› Ask Codex to do anything'], state: {manual: false, seen: 'medium'}}));
    expect(hidden).toMatchObject({model: 'gpt-6.1-sol', current: 'medium', currentFrom: 'last-observed', supported: true});
    // The same model and level from the screen or from the last observation is the same binding.
    expect(hidden.binding).toBe(workroomEffortChoiceView(base({launchModel, rows: ['  gpt-6.1-sol medium · 100% context left'], state: {manual: false, seen: 'medium'}})).binding);
  });

  test('the binding changes with the process, account, model, shown effort, held choice or input — and with nothing else', () => {
    const binding = (over: Partial<WorkroomEffortChoiceInput>) => workroomEffortChoiceView(base(over)).binding;
    const first = binding({});
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(binding({})).toBe(first);
    // The same screen with other transcript rows above it does not move it.
    expect(binding({rows: ['• Ran tests', '› Ask Codex to do anything', '', '  gpt-6.1-sol high · 100% context left']})).toBe(first);
    for (const over of [
      {pid: 4243}, {sessionId: 'session-choice-0002'}, {accountId: 'acct-12345678'}, {inputRevision: 4},
      {rows: ['› Ask Codex to do anything', '', '  gpt-6.1-sol medium · 100% context left']},
      {rows: ['› Ask Codex to do anything', '', '  gpt-6.1-terra high · 100% context left']},
      {state: {manual: false, chosen: {level: 'high' as const, requestId: 'req-00000001', at: 'x', replaced: {}}}},
    ]) expect(binding(over)).not.toBe(first);
  });
});

describe('priority and lifetime of a held choice', () => {
  const auto = (): WorkroomEffortState => ({manual: false, tier: 'medium', reason: 'standard', level: 'medium', origin: 'launch', seen: 'medium'});

  test('holding replaces the automatic decision and the record carries no new key; release restores it', () => {
    const state = auto();
    holdWorkroomEffortChoice(state, 'high', 'req-hold-0001', '2026-11-03T00:00:00.000Z');
    expect(state).toMatchObject({level: 'high', origin: 'runtime', seen: 'high', manual: false, runtimeStatus: 'applied'});
    expect(state.tier).toBeUndefined();
    const record = workroomEffortRecord('session-choice-0001', 'codex', state);
    expect(Object.keys(record)).not.toContain('chosen');
    expect(Object.keys(record).sort()).toEqual(['agent', 'level', 'manual', 'origin', 'runtimeStatus', 'seen', 'sessionId']);
    // Shown like a pinned level: requested, and what the CLI shows.
    expect(workroomEffortBadgeText({...record, mode: 'auto'} as any)).toBe(`에포트 요청 · 높음 · CLI 표시 높음`);
    // A second choice keeps the first replaced decision, so a release restores the automatic one, not the first choice.
    holdWorkroomEffortChoice(state, 'low', 'req-hold-0002', '2026-11-03T00:00:01.000Z');
    releaseWorkroomEffortChoice(state);
    expect(state).toMatchObject({tier: 'medium', reason: 'standard', level: 'medium', origin: 'launch'});
    expect(state.chosen).toBeUndefined(); expect(state.runtimeStatus).toBeUndefined();
  });

  test('auto neither advises nor decides while a choice holds', () => {
    const state = auto();
    holdWorkroomEffortChoice(state, 'low', 'req-hold-0003', 'x');
    noteWorkroomEffortRequest(state, 'codex', '보안 취약점을 분석하고 전체 아키텍처를 다시 설계해 줘', true, 'x');
    expect(state.advice).toBeUndefined();
    expect(state.level).toBe('low');
  });

  test('a native change in the CLI wins: the choice ends and is recorded as the person\'s own setting', () => {
    const state = auto();
    holdWorkroomEffortChoice(state, 'high', 'req-hold-0004', 'x');
    observeWorkroomEffortScreen(state, 'codex', ['› Ask Codex to do anything', '  gpt-6.1-sol high · 100% context left']);
    expect(state.chosen?.level).toBe('high'); expect(state.manual).toBe(false);
    observeWorkroomEffortScreen(state, 'codex', ['› Ask Codex to do anything', '  gpt-6.1-sol low · 100% context left']);
    expect(state.chosen).toBeUndefined();
    expect(state.manual).toBe(true);
    expect(state.seen).toBe('low');
  });

  test('a restart plans from what the choice replaced; the live state keeps its choice', () => {
    const state = auto();
    holdWorkroomEffortChoice(state, 'high', 'req-hold-0005', 'x');
    const restart = workroomEffortRestartBase(state)!;
    expect(restart.chosen).toBeUndefined();
    expect(restart).toMatchObject({tier: 'medium', level: 'medium', origin: 'launch'});
    expect(state.chosen?.level).toBe('high');
    expect(workroomEffortRestartBase(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the host, with a fake PTY

const codexScreen = (level: string, composer = 'Ask Codex to do anything') =>
  `\x1b[2J\x1b[H• Done.\r\n\r\n› ${composer}\r\n\r\n  gpt-6.1-sol ${level} · 100% context left\x1b[3;${composer === 'Ask Codex to do anything' ? 3 : 3 + composer.length}H`;
const CODEX_ORDER = ['low', 'medium', 'high', 'xhigh'];
type Respond = (text: string, emit: (screen: string) => void) => void;
/** Codex's native reasoning shortcuts: ESC , lowers one step, ESC . raises one, and the footer repaints. */
const codexCli = (start: string, options: {silent?: boolean} = {}) => {
  const cli = {level: start, respond: ((text, emit) => {
    if (text !== '\x1b,' && text !== '\x1b.') return;
    if (options.silent) return;
    cli.level = CODEX_ORDER[CODEX_ORDER.indexOf(cli.level) + (text === '\x1b,' ? -1 : 1)]!;
    emit(codexScreen(cli.level));
  }) as Respond};
  return cli;
};
const codexShortcuts = (start: string, options: {silent?: boolean} = {}): Respond => codexCli(start, options).respond;

function host(screen: string, options: {respond?: Respond; agent?: 'codex' | 'claude'; env?: Record<string, string>} = {}) {
  const agent = options.agent ?? 'codex';
  const root = mkdtempSync(join(tmpdir(), 'effort-choice-'));
  const store = new WorkroomConversationJournal(root), setting = createWorkroomEffortSetting(root);
  const clock = {now: 3_000_000};
  const writes: string[] = [];
  let emit: (screen: string) => void = () => {};
  let pid = 720_000;
  const exits = new Map<number, () => void>();
  const service = new AiTerminalService({
    signalGroup: target => exits.get(target)?.(),
    submissions: () => store, effortAuto: setting, resolveTarget: async () => ({cwd: root}), executable: () => '/fixture/' + agent,
    activitySampler: false, activityClock: () => clock.now, env: {HOME: root, PATH: '/usr/bin', ...options.env}, resume: async () => null,
    codexEffortModel: () => ({ok: true, model: 'gpt-6.1-sol', allowed: ['low', 'medium', 'high']}),
    effortRuntimeSupport: () => ({claudeSessionPicker: agent === 'claude', codexDefaultKeys: agent === 'codex'}),
    effortRuntime: control => changeWorkroomEffort({...control, idle: () => true}),
    spawn: (_args, o: any) => {
      let exit!: (n: number) => void;
      const exited = new Promise<number>(r => { exit = r; });
      emit = text => o.terminal.data(null, new TextEncoder().encode(text));
      queueMicrotask(() => emit(screen));
      const end = () => { o.terminal.exit?.(); exit(143); };
      exits.set(++pid, end);
      return {pid, exited, kill: end,
        terminal: {write: (text: string) => { writes.push(text); options.respond?.(text, emit); return Buffer.byteLength(text); }, resize() {}, close() {}}} as any;
    },
  });
  cleanup.push(async () => { await service.shutdown(); store.close(); rmSync(root, {recursive: true, force: true}); });
  const start = async (resumeFrom?: string) => {
    const r = await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'project-choice-0001', agent, cols: 100, rows: 28, ...(resumeFrom ? {resumeFrom} : {})});
    await Bun.sleep(30);
    return r.session!;
  };
  const send = (sessionId: string, text: string, id: string) => submitWorkroomDraft({id, sessionId, text: text + '\r', prepared: () => {},
    request: r => service.perform({...r, requestId: crypto.randomUUID()})});
  const native = async (text: string) => { emit(text); clock.now += 50; await Bun.sleep(10); await service.sampleActivity(); };
  const record = async (sessionId: string) => (await service.performEffort({operation: 'effort', sessionIds: [sessionId]})).effort.sessions[0]!;
  return {service, writes, start, send, native, record, emit: (text: string) => emit(text)};
}

describe('the host applies a person\'s choice through the CLI\'s own session-only control', () => {
  test('receipt saturation refuses new choices while an original applied ID never executes again',async()=>{
    const f=host(codexScreen('high'),{respond:codexShortcuts('high')}),s=await f.start();
    const choose=async(level:'high'|'medium',requestId:string)=>f.service.chooseEffort({sessionId:s.id,targetId:s.targetId,level,requestId,binding:(await f.service.effortChoice(s.id,s.targetId)).binding});
    await choose('high','capacity-held-seed');
    const original={sessionId:s.id,targetId:s.targetId,level:'medium' as const,requestId:'capacity-original',binding:(await f.service.effortChoice(s.id,s.targetId)).binding};
    const result=await f.service.chooseEffort(original);
    await choose('high','capacity-back-high');
    for(let i=0;i<509;i++)await choose('high',`capacity-held-${i}`);
    const before=[...f.writes];
    await expect(choose('medium','capacity-overflow')).rejects.toMatchObject({code:'BUSY',typed:false});
    expect(await f.service.chooseEffort(original)).toEqual(result);
    expect(f.writes).toEqual(before);expect((await f.service.effortChoice(s.id,s.targetId)).current).toBe('high');
  },20_000);
  test('read, then set: one native shortcut, a screen readback, and the choice holds with auto offered to release it', async () => {
    const f = host(codexScreen('high'), {respond: codexShortcuts('high')}), s = await f.start();
    const read = await f.service.effortChoice(s.id, s.targetId);
    expect(read).toMatchObject({sessionId: s.id, agent: 'codex', supported: true, model: 'gpt-6.1-sol', current: 'high'});
    expect(read.choices).toEqual(expect.arrayContaining(['low', 'medium', 'high']));
    expect(read.choices).not.toContain('auto');
    const result = await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'medium', binding: read.binding, requestId: 'choice-apply-0001'});
    expect(result).toMatchObject({outcome: 'applied', requested: 'medium', readback: 'medium'});
    expect(f.writes).toEqual(['\x1b,']);
    expect(result.view).toMatchObject({current: 'medium', chosen: 'medium'});
    expect(result.view.choices).toContain('auto');
    const record = await f.record(s.id);
    expect(record).toMatchObject({level: 'medium', origin: 'runtime', seen: 'medium', manual: false});
    expect(Object.keys(record)).not.toContain('chosen');

    // The same requestId answers with the recorded result and types nothing; reusing it for another level is refused.
    expect(await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'medium', binding: read.binding, requestId: 'choice-apply-0001'})).toEqual(result);
    expect(f.writes).toEqual(['\x1b,']);
    await expect(f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'low', binding: read.binding, requestId: 'choice-apply-0001'}))
      .rejects.toMatchObject({code: 'REQUEST_ID_CONFLICT'});
    // The read's binding no longer describes this session (its effort and choice moved): refused before any key.
    await expect(f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'low', binding: read.binding, requestId: 'choice-stale-0001'}))
      .rejects.toMatchObject({code: 'BINDING_CHANGED', typed: false});
    expect(f.writes).toEqual(['\x1b,']);
    // Not offered by this session: refused before any key.
    const now = await f.service.effortChoice(s.id, s.targetId);
    await expect(f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'ultra', binding: now.binding, requestId: 'choice-level-0001'}))
      .rejects.toMatchObject({code: 'LEVEL_UNSUPPORTED'});
    expect(f.writes).toEqual(['\x1b,']);
  });

  test('a person typing in the composer stops the choice before any key; the read after it is a new binding', async () => {
    const f = host(codexScreen('high'), {respond: codexShortcuts('high')}), s = await f.start();
    f.emit(codexScreen('high', '고칠 내용 작성 중')); await Bun.sleep(20);
    const read = await f.service.effortChoice(s.id, s.targetId);
    await expect(f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'low', binding: read.binding, requestId: 'choice-busy-0001'}))
      .rejects.toMatchObject({code: 'NOT_READY', typed: false});
    expect(f.writes).toEqual([]);
    expect((await f.record(s.id)).level).not.toBe('low');
  }, 15_000);

  test('a key typed without a confirmed result: OUTCOME_UNKNOWN, never resent, and further choices on that CLI stop', async () => {
    const f = host(codexScreen('high'), {respond: codexShortcuts('high', {silent: true})}), s = await f.start();
    const read = await f.service.effortChoice(s.id, s.targetId);
    const first = f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'low', binding: read.binding, requestId: 'choice-unknown-0001'});
    await expect(first).rejects.toMatchObject({code: 'OUTCOME_UNKNOWN', typed: true, originalRequestId: 'choice-unknown-0001'});
    const typed = [...f.writes];
    expect(typed[0]).toBe('\x1b,');
    // The same requestId only reports the recorded outcome.
    await expect(f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'low', binding: read.binding, requestId: 'choice-unknown-0001'}))
      .rejects.toMatchObject({code: 'OUTCOME_UNKNOWN'});
    // The next read already says so, before the person is asked again.
    const again = await f.service.effortChoice(s.id, s.targetId);
    expect(again).toMatchObject({supported: false, unsupportedReason: 'previous-outcome-unknown', originalRequestId: 'choice-unknown-0001', choices: []});
    // A fresh request on the same CLI names the unknown one and types nothing.
    await expect(f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'medium', binding: again.binding, requestId: 'choice-unknown-0002'}))
      .rejects.toMatchObject({code: 'OUTCOME_UNKNOWN', typed: false, originalRequestId: 'choice-unknown-0001'});
    expect(f.writes).toEqual(typed);
    expect((await f.record(s.id)).runtimeStatus).toBe('unconfirmed');
  }, 20_000);

  test('auto skips a session while the person\'s choice holds, and decides again after auto releases it', async () => {
    const f = host(codexScreen('high'), {respond: codexShortcuts('high')}), s = await f.start();
    const read = await f.service.effortChoice(s.id, s.targetId);
    // Already at high: held without a key.
    expect(await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'high', binding: read.binding, requestId: 'choice-held-0001'}))
      .toMatchObject({outcome: 'held', readback: 'high'});
    expect(f.writes).toEqual([]);
    // A low-tier request: with the choice holding, nothing but the request is typed and no advice is left.
    expect(await f.send(s.id, 'git 상태만 알려줘', 'choice-held-send-0001')).toMatchObject({state: 'written'});
    expect(f.writes.join('')).toBe('git 상태만 알려줘\r');
    expect((await f.record(s.id)).advice).toBeUndefined();
    // Release with auto: nothing is typed, the CLI keeps high, and the next request is decided by auto again.
    f.emit(codexScreen('high')); await Bun.sleep(20);
    const held = await f.service.effortChoice(s.id, s.targetId);
    expect(held.choices).toContain('auto');
    const before = f.writes.length;
    expect(await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'auto', binding: held.binding, requestId: 'choice-release-0001'}))
      .toMatchObject({outcome: 'released', readback: 'high'});
    expect(f.writes.length).toBe(before);
    const released = await f.service.effortChoice(s.id, s.targetId);
    expect(released.chosen).toBeUndefined(); expect(released.choices).not.toContain('auto');
    expect(await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'auto', binding: released.binding, requestId: 'choice-release-0002'}))
      .toMatchObject({outcome: 'not-held'});
    expect(await f.send(s.id, 'git 상태만 알려줘', 'choice-held-send-0002')).toMatchObject({state: 'written'});
    expect(f.writes.slice(before)[0]).toBe('\x1b,');
  }, 20_000);

  test('a later native change in the CLI ends the choice; a restart starts from the Mac policy, not from the choice', async () => {
    const cli = codexCli('high');
    const f = host(codexScreen('high'), {respond: cli.respond}), s = await f.start();
    const read = await f.service.effortChoice(s.id, s.targetId);
    await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'medium', binding: read.binding, requestId: 'choice-native-0001'});
    // The person presses Codex's own shortcut: the footer shows low.
    cli.level = 'low';
    await f.native(codexScreen('low'));
    const after = await f.service.effortChoice(s.id, s.targetId);
    expect(after.chosen).toBeUndefined();
    expect(after.current).toBe('low');
    expect((await f.record(s.id)).manual).toBe(true);

    const again = await f.service.effortChoice(s.id, s.targetId);
    await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'medium', binding: again.binding, requestId: 'choice-native-0002'});
    expect((await f.service.effortChoice(s.id, s.targetId)).chosen).toBe('medium');
    const restarted = await f.start(s.id);
    expect(restarted.id).not.toBe(s.id);
    const fresh = await f.service.effortChoice(restarted.id, restarted.targetId);
    expect(fresh.chosen).toBeUndefined();
    expect(fresh.choices).not.toContain('auto');
    // The old process's binding never applies to the new one.
    await expect(f.service.chooseEffort({sessionId: restarted.id, targetId: restarted.targetId, level: 'low', binding: again.binding, requestId: 'choice-native-0003'}))
      .rejects.toMatchObject({code: 'BINDING_CHANGED'});
  }, 20_000);

  test('Claude: the slider and `s` (this session only), never `/effort <level>`; an env override is refused before any key', async () => {
    const rule = '─'.repeat(70);
    const claudeRest = (level: string, note = '') => `\x1b[2J\x1b[H ▐▛███▛█   Claude Code v2.1.314\r\n   Opus 5.5 · Claude Max\r\n${note}\r\n                                        ◉ ${level} · /effort\r\n${rule}\r\n❯ \r\n${rule}\x1b[6;3H`;
    let level = 'xhigh';
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    const respond: Respond = (text, emit) => {
      if (text === '/effort\r') emit('\x1b[2J\x1b[H   Effort\r\n\r\n         Faster                             Smarter\r\n         ──────────────────────────────▲───────────\r\n         low     medium     high     xhigh      max\r\n\r\n   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel');
      else if (text === '\x1b[D' || text === '\x1b[C') level = levels[levels.indexOf(level) + (text === '\x1b[D' ? -1 : 1)]!;
      else if (text === 's') emit(claudeRest(level, `  ⎿ Set effort level to ${level} (this session only)`));
    };
    const f = host(claudeRest('xhigh'), {agent: 'claude', respond}), s = await f.start();
    const read = await f.service.effortChoice(s.id, s.targetId);
    expect(read).toMatchObject({supported: true, current: 'xhigh'});
    expect(read.choices).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const result = await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'medium', binding: read.binding, requestId: 'choice-claude-0001'});
    expect(result).toMatchObject({outcome: 'applied', readback: 'medium'});
    expect(f.writes).toEqual(['/effort\r', '\x1b[D', '\x1b[D', 's']);
    expect(f.writes.some(w => /^\/effort\s+\S/.test(w))).toBe(false);
    expect(result).toMatchObject({readbackFrom: 'screen'});
    // Its own confirmation line is the new baseline, not a native change.
    await f.native(claudeRest('medium', '  ⎿ Set effort level to medium (this session only)'));
    expect((await f.service.effortChoice(s.id, s.targetId)).chosen).toBe('medium');
    // After a turn Claude hides its effort row: the level is the one last observed, and it says so.
    await f.native(`\x1b[2J\x1b[H ▐▛███▛█   Claude Code v2.1.314\r\n   Opus 5.5 · Claude Max\r\n\r\n${rule}\r\n❯ \r\n${rule}\x1b[5;3H`);
    const hidden = await f.service.effortChoice(s.id, s.targetId);
    expect(hidden).toMatchObject({current: 'medium', currentFrom: 'last-observed', chosen: 'medium', supported: true});
    const before = f.writes.length;
    expect(await f.service.chooseEffort({sessionId: s.id, targetId: s.targetId, level: 'medium', binding: hidden.binding, requestId: 'choice-claude-0003'}))
      .toMatchObject({outcome: 'held', readback: 'medium', readbackFrom: 'last-observed'});
    expect(f.writes.length).toBe(before);

    const g = host(claudeRest('xhigh'), {agent: 'claude', respond, env: {CLAUDE_CODE_EFFORT_LEVEL: 'high'}}), t = await g.start();
    const blocked = await g.service.effortChoice(t.id, t.targetId);
    expect(blocked).toMatchObject({supported: false, unsupportedReason: 'env-override', choices: []});
    await expect(g.service.chooseEffort({sessionId: t.id, targetId: t.targetId, level: 'low', binding: blocked.binding, requestId: 'choice-claude-0002'}))
      .rejects.toMatchObject({code: 'UNSUPPORTED'});
    expect(g.writes).toEqual([]);
  }, 20_000);

  test('another project\'s target is not this session', async () => {
    const f = host(codexScreen('high')), s = await f.start();
    await expect(f.service.effortChoice(s.id, 'project-other-0001')).rejects.toThrow();
    await expect(f.service.chooseEffort({sessionId: s.id, targetId: 'project-other-0001', level: 'low', binding: 'a'.repeat(32), requestId: 'choice-other-0001'})).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------- MCP tool, host parser and handler

describe('agentstoz_use_set_workroom_effort', () => {
  const map = (args: Record<string, unknown>) => agentsToZUseMcpActionForTool('agentstoz_use_set_workroom_effort', args, 'controller-id');

  test('its description fits what Claude Code keeps and says the person picks', () => {
    const tool = AGENTSTOZ_USE_MCP_TOOLS.find(t => t.name === 'agentstoz_use_set_workroom_effort')!;
    expect(tool.description.length).toBeLessThanOrEqual(2_000);
    for (const phrase of ['never your own', 'AskUserQuestion', 'never pick a level yourself', 'binding unchanged', 'fresh requestId',
      'never the global default, model or account', 'OUTCOME_UNKNOWN', 'do not resend', 'Desktop apps']) expect(tool.description).toContain(phrase);
    expect((tool.inputSchema as any).required).toEqual(['sessionId']);
    expect((tool.inputSchema as any).properties.level.enum).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect((tool.inputSchema as any).additionalProperties).toBe(false);
  });

  test('read and set map to one action the host parser accepts; anything else is refused', () => {
    const read = map({portId: 'study-id', sessionId: 'session_12345678'});
    expect(read).toEqual({action: 'set-workroom-effort', controllerPortId: 'controller-id', portId: 'study-id', sessionId: 'session_12345678'});
    expect(parseAgentsToZUseActionRequest(read)).toMatchObject({action: 'set-workroom-effort', sessionId: 'session_12345678', requestId: null});
    expect(parseAgentsToZUseActionRequest(read).effortLevel).toBeUndefined();
    const set = map({target: 'ops', sessionId: 'session_12345678', level: 'medium', binding: 'b'.repeat(32), requestId: 'choice-map-0001'});
    expect(set).toEqual({action: 'set-workroom-effort', controllerPortId: 'controller-id', target: 'ops', sessionId: 'session_12345678',
      level: 'medium', binding: 'b'.repeat(32), requestId: 'choice-map-0001'});
    expect(parseAgentsToZUseActionRequest(set)).toMatchObject({effortLevel: 'medium', effortBinding: 'b'.repeat(32), requestId: 'choice-map-0001', target: 'ops'});
    expect(agentsToZUseMcpTimeoutMs(set)).toBe(30_000);
    expect(agentsToZUseMcpTimeoutMs(read)).toBe(20_000);
    const refused = (body: Record<string, unknown>) => { try { parseAgentsToZUseActionRequest({action: 'set-workroom-effort', controllerPortId: 'controller-id', portId: 'study-id', sessionId: 'session_12345678', ...body}); } catch (error) { return (error as AgentsToZUseControlError).code; } return null; };
    expect(refused({level: 'turbo', binding: 'b'.repeat(32), requestId: 'choice-map-0002'})).toBe('AGENTSTOZ_USE_WORKROOM_EFFORT_INVALID');
    expect(refused({level: 'low', requestId: 'choice-map-0003'})).toBe('AGENTSTOZ_USE_WORKROOM_EFFORT_INVALID');
    expect(refused({level: 'low', binding: 'B'.repeat(32), requestId: 'choice-map-0004'})).toBe('AGENTSTOZ_USE_WORKROOM_EFFORT_INVALID');
    expect(refused({level: 'low', binding: 'b'.repeat(32)})).toBe('AGENTSTOZ_USE_WORKROOM_REQUEST_ID_INVALID');
    expect(refused({binding: 'b'.repeat(32)})).toBe('AGENTSTOZ_USE_WORKROOM_EFFORT_INVALID');
    expect(refused({requestId: 'choice-map-0005'})).toBe('AGENTSTOZ_USE_WORKROOM_EFFORT_INVALID');
    // No model, provider, account or arbitrary argument rides along: refused, not dropped.
    for (const extra of [{model: 'gpt-6.1-terra'}, {provider: 'openai'}, {accountId: 'acct-12345678'}, {agent: 'codex'}, {global: true}])
      expect(() => map({portId: 'study-id', sessionId: 'session_12345678', level: 'low', binding: 'b'.repeat(32), requestId: 'choice-map-0006', ...extra})).toThrow('unsupported arguments');
    expect(refused({accountId: 'acct-12345678', level: 'low', binding: 'b'.repeat(32), requestId: 'choice-map-0007'})).toBe('AGENTSTOZ_USE_ACCOUNT_INVALID');
    expect(() => map({sessionId: 'session_12345678'})).toThrow();
  });

  test('the handler refuses the caller\'s own session before reaching the host, and maps host refusals to typed codes', async () => {
    const calls: string[] = [];
    const fake = {
      effortChoice: async () => { calls.push('read'); return {sessionId: 's', agent: 'codex', supported: true, choices: ['low'], inputRevision: 1, binding: 'c'.repeat(32)} as any; },
      chooseEffort: async () => { calls.push('set'); const {WorkroomEffortChoiceError} = await import('../src/workroomEffortChoice'); throw new WorkroomEffortChoiceError('OUTCOME_UNKNOWN', 'unknown', true, 'choice-h-0001'); },
    };
    let self: unknown;
    try { await agentsToZUseWorkroomEffort(fake, {session: {id: 'session-self-0001', targetId: 't'}, callerSessionId: 'session-self-0001'}); } catch (error) { self = error; }
    expect(self).toMatchObject({code: 'AGENTSTOZ_USE_WORKROOM_SELF_TARGET', status: 409});
    expect(calls).toEqual([]);
    const read = await agentsToZUseWorkroomEffort(fake, {session: {id: 'session-other-0001', targetId: 't'}, callerSessionId: 'session-self-0001'});
    expect(read.effect).toBe('read-only');
    expect(read.body.guidance).toContain('AskUserQuestion');
    let unknown: unknown;
    try { await agentsToZUseWorkroomEffort(fake, {session: {id: 'session-other-0001', targetId: 't'}, callerSessionId: null, level: 'low', binding: 'c'.repeat(32), requestId: 'choice-h-0001'}); } catch (error) { unknown = error; }
    expect(unknown).toMatchObject({code: 'AGENTSTOZ_USE_WORKROOM_EFFORT_OUTCOME_UNKNOWN', status: 409, details: {keysTyped: true, originalRequestId: 'choice-h-0001'}});
  });

  test('the handler preserves whether the readback was on screen or last observed', async () => {
    const view = {sessionId: 's', agent: 'claude', supported: true, choices: ['low'], inputRevision: 1, binding: 'c'.repeat(32)} as any;
    for (const source of ['screen', 'last-observed', undefined] as const) {
      const fake = {
        effortChoice: async () => view,
        chooseEffort: async () => ({outcome: 'held' as const, requested: 'low' as const, view,
          ...(source ? {readback: 'low', readbackFrom: source} : {})}),
      };
      const result = await agentsToZUseWorkroomEffort(fake, {session: {id: 'session-other-0001', targetId: 't'},
        callerSessionId: null, level: 'low', binding: 'c'.repeat(32), requestId: 'choice-readback-0001'});
      if (source) expect(result.body).toMatchObject({readback: 'low', readbackFrom: source});
      else { expect(result.body).not.toHaveProperty('readback'); expect(result.body).not.toHaveProperty('readbackFrom'); }
    }
  });
});

// ---------------------------------------------------------------- ask=true: the person picks in the client's own form

describe('ask=true shows the choices to the person through MCP elicitation and applies only their pick', () => {
  const view = {sessionId: 'session_12345678', agent: 'codex', supported: true, model: 'gpt-6.1-sol', current: 'high', currentFrom: 'screen',
    choices: ['low', 'medium', 'high'], inputRevision: 2, binding: 'd'.repeat(32)};
  /** A fake host: reads answer the view, sets record what they were asked. */
  const fakeHost = (readGate?:()=>Promise<void>) => {
    const calls: any[] = [];
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body: any = await request.json(); calls.push(body);
      expect(body.action).toBe('set-workroom-effort');
      if (body.level === undefined) {await readGate?.();return Response.json({success: true, performed: true, effect: 'read-only', effort: view, guidance: 'x'});}
      return Response.json({success: true, performed: true, effect: 'set-workroom-effort', outcome: 'applied', requested: body.level, readback: body.level, readbackFrom: 'screen', effort: {...view, current: body.level, chosen: body.level}});
    }});
    cleanup.push(() => server.stop(true));
    return {calls, endpoint: `http://127.0.0.1:${server.port}/api/agentstoz-use/action`};
  };
  const startMcp = (endpoint: string) => {
    const home = mkdtempSync(join(tmpdir(), 'effort-ask-mcp-'));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'agentstoz-use-mcp-server.ts')], {
      cwd: join(import.meta.dir, '..'),
      env: {...process.env, HOME: home, APP_DATA_DIR: join(home, 'app-data'), AGENTSTOZ_CONTROLLER_PORT_ID: 'fixture-controller', AGENTSTOZ_USE_ENDPOINT: endpoint},
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    cleanup.push(async () => { try { child.kill(); } catch {} await child.exited.catch(() => undefined); rmSync(home, {recursive: true, force: true}); });
    const lines: any[] = [];
    const waiters: {match: (line: any) => boolean; resolve: (line: any) => void}[] = [];
    void (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, {stream: true});
        while (buffer.includes('\n')) {
          const at = buffer.indexOf('\n'), line = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          lines.push(line);
          for (const waiter of waiters.splice(0)) if (waiter.match(line)) waiter.resolve(line); else waiters.push(waiter);
        }
      }
    })();
    const next = (match: (line: any) => boolean): Promise<any> => {
      const found = lines.find(match); if (found) return Promise.resolve(found);
      return Promise.race([new Promise(resolve => waiters.push({match, resolve})), Bun.sleep(8_000).then(() => { throw new Error('MCP line missing'); })]);
    };
    const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', ...message})}\n`);
    const call = (id: number, args: Record<string, unknown>) => write({id, method: 'tools/call', params: {name: 'agentstoz_use_set_workroom_effort', arguments: args}});
    const reply = async (id: number) => (await next(line => line.id === id && 'result' in line)).result;
    return {lines, next, write, call, reply};
  };
  const elicitation = (line: any) => line.method === 'elicitation/create';

  test('cancelling the parent call retires its form and a late accept cannot dispatch a change',async()=>{
    const host=fakeHost(),mcp=startMcp(host.endpoint);
    mcp.write({id:1,method:'initialize',params:{capabilities:{elicitation:{}}}});await mcp.reply(1);
    mcp.call(2,{portId:'study-id',sessionId:'session_12345678',ask:true});
    const form=await mcp.next(elicitation);
    mcp.write({id:2,method:'ping'});
    expect((await mcp.next(line=>line.id===2&&line.error)).error.code).toBe(-32600);
    mcp.write({method:'notifications/cancelled',params:{requestId:2,reason:'person cancelled parent'}});
    await mcp.next(line=>line.method==='notifications/cancelled'&&line.params?.requestId===form.id);
    expect((await mcp.reply(2)).structuredContent.personChoice).toBe('cancelled');
    mcp.write({id:form.id,result:{action:'accept',content:{level:'medium'}}});
    mcp.write({id:3,method:'ping'});await mcp.reply(3);
    expect(host.calls.filter(c=>c.level!==undefined)).toEqual([]);
  },20_000);

  test('parent cancellation during the initial host read never opens a later form',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const host=fakeHost(()=>gate),mcp=startMcp(host.endpoint);
    mcp.write({id:1,method:'initialize',params:{capabilities:{elicitation:{}}}});await mcp.reply(1);
    mcp.call(2,{portId:'study-id',sessionId:'session_12345678',ask:true});
    for(let i=0;i<100&&host.calls.length===0;i++)await Bun.sleep(10);
    expect(host.calls).toHaveLength(1);
    mcp.write({method:'notifications/cancelled',params:{requestId:2}});
    mcp.write({id:3,method:'ping'});await mcp.reply(3);release();
    expect((await mcp.reply(2)).structuredContent.personChoice).toBe('cancelled');
    expect(mcp.lines.some(elicitation)).toBe(false);expect(host.calls.filter(c=>c.level!==undefined)).toEqual([]);
  },20_000);

  test('accept: one form with the session\'s own levels, then one set with the read\'s binding and a fresh requestId', async () => {
    const host = fakeHost(), mcp = startMcp(host.endpoint);
    mcp.write({id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {elicitation: {}}, clientInfo: {name: 'claude-code'}}});
    await mcp.reply(1);
    mcp.call(2, {portId: 'study-id', sessionId: 'session_12345678', ask: true});
    const asked = await mcp.next(elicitation);
    expect(typeof asked.id).toBe('string');
    expect(asked.params.requestedSchema).toEqual({type: 'object', required: ['level'], properties: {level: {type: 'string', title: '에포트',
      enum: ['low', 'medium', 'high'], enumNames: ['낮음 (low)', '보통 (medium)', '높음 (high)']}}});
    expect(asked.params.message).toContain('지금: high');
    expect(asked.params.message).toContain('전역 기본값·모델·계정은 바뀌지 않습니다');
    // While the person decides, nothing is set and other calls on this connection still answer.
    expect(host.calls.map(c => c.level)).toEqual([undefined]);
    mcp.call(3, {portId: 'study-id', sessionId: 'session_12345678'});
    expect((await mcp.reply(3)).structuredContent.effort.binding).toBe('d'.repeat(32));
    mcp.write({id: asked.id, result: {action: 'accept', content: {level: 'medium'}}});
    const result = (await mcp.reply(2)).structuredContent;
    expect(result).toMatchObject({personChoice: 'chosen', outcome: 'applied', readback: 'medium'});
    expect(result.requestId).toMatch(/^ask-[a-f0-9]{24}$/);
    const set = host.calls.filter(c => c.level !== undefined);
    expect(set).toEqual([expect.objectContaining({level: 'medium', binding: 'd'.repeat(32), requestId: result.requestId, portId: 'study-id', sessionId: 'session_12345678'})]);
    expect(set[0]).not.toHaveProperty('ask');
  }, 20_000);

  test('decline or cancel changes nothing; a level the session does not offer is refused; ask carries no level of the AI', async () => {
    const host = fakeHost(), mcp = startMcp(host.endpoint);
    mcp.write({id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {elicitation: {}}}});
    await mcp.reply(1);
    /** The next form after the ones already answered. */
    const form = (n: number) => mcp.next(line => elicitation(line) && mcp.lines.filter(elicitation).indexOf(line) === n);
    for (const [n, id, action, expected] of [[0, 2, 'decline', 'declined'], [1, 3, 'cancel', 'cancelled']] as const) {
      mcp.call(id, {portId: 'study-id', sessionId: 'session_12345678', ask: true});
      const asked = await form(n);
      mcp.write({id: asked.id, result: {action}});
      expect((await mcp.reply(id)).structuredContent).toMatchObject({personChoice: expected, effort: {current: 'high'}});
    }
    mcp.call(4, {portId: 'study-id', sessionId: 'session_12345678', ask: true});
    const asked = await form(2);
    mcp.write({id: asked.id, result: {action: 'accept', content: {level: 'ultra'}}});
    const refused = await mcp.reply(4);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('nothing was changed');
    mcp.call(5, {portId: 'study-id', sessionId: 'session_12345678', ask: true, level: 'low'});
    expect((await mcp.reply(5)).content[0].text).toContain('the person picks');
    expect(host.calls.filter(c => c.level !== undefined)).toEqual([]);
  }, 20_000);

  test('no answer in time: nothing is set and the read comes back as timeout', async () => {
    const host = fakeHost();
    const env = {...process.env, AGENTSTOZ_CONTROLLER_PORT_ID: 'fixture-controller', AGENTSTOZ_USE_ENDPOINT: host.endpoint};
    const asked: any[] = [];
    const client = {elicit: async (params: Record<string, unknown>, timeoutMs: number) => { asked.push({params, timeoutMs}); return null; }};
    await handleAgentsToZUseMcpRequest({jsonrpc: '2.0', id: 1, method: 'initialize', params: {capabilities: {elicitation: {}}}}, env);
    try {
      const response: any = await handleAgentsToZUseMcpRequest({jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {name: 'agentstoz_use_set_workroom_effort', arguments: {portId: 'study-id', sessionId: 'session_12345678', ask: true}}}, env, client);
      expect(response.result.structuredContent).toMatchObject({personChoice: 'timeout', effort: {current: 'high'}});
      expect(asked).toHaveLength(1);
      expect(asked[0].timeoutMs).toBe(WORKROOM_EFFORT_ASK_TIMEOUT_MS);
      expect(host.calls.filter(c => c.level !== undefined)).toEqual([]);
    } finally {
      await handleAgentsToZUseMcpRequest({jsonrpc: '2.0', id: 3, method: 'initialize', params: {}}, env);
    }
  });

  test('a client without forms gets ask-unavailable and the AskUserQuestion fallback; no form is sent', async () => {
    const host = fakeHost(), mcp = startMcp(host.endpoint);
    mcp.write({id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {elicitation: {url: {}}}}});
    await mcp.reply(1);
    mcp.call(2, {portId: 'study-id', sessionId: 'session_12345678', ask: true});
    const result = (await mcp.reply(2)).structuredContent;
    expect(result).toMatchObject({personChoice: 'ask-unavailable', effort: {choices: ['low', 'medium', 'high']}});
    expect(result.guidance).toContain('AskUserQuestion');
    expect(mcp.lines.some(elicitation)).toBe(false);
    expect(host.calls.filter(c => c.level !== undefined)).toEqual([]);
  }, 20_000);
});
