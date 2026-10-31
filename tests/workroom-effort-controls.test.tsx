/**
 * 「에포트 자동」 on screen (w16 Build B): the option next to bypass, the receipt next to the model/effort the CLI shows, and the
 * reader that asks the Mac. Nothing is shown before the Mac has answered, and nothing ever again after an older Mac refused.
 */
import {expect, test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GUIDE_CONTENT} from '../src/guide/guideContent';
import {WorkroomEffortAdvice, WorkroomEffortBadge, WorkroomEffortOption, createWorkroomEffortReader, createWorkroomEffortRequest, type WorkroomEffortState} from '../src/WorkroomEffortControls';
import {WORKROOM_EFFORT_ELSEWHERE, workroomEffortView, type WorkroomEffortView} from '../src/workroomEffortView';
import {normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';

const state = (over: Partial<WorkroomEffortState>): WorkroomEffortState => ({supported: true, auto: true, session: null, sessionId: null, busy: false, error: '', ...over});
const option = (s: WorkroomEffortState, extra: Partial<React.ComponentProps<typeof WorkroomEffortOption>> = {}) =>
  renderToStaticMarkup(<WorkroomEffortOption state={s} onChange={() => {}} remote={false} {...extra}/>);

test('the option is not drawn until this Mac has answered, nor for a Mac that does not know it', () => {
  expect(option(state({supported: null, auto: null}))).toBe('');
  expect(option(state({supported: false, auto: null}))).toBe('');
});

test('global Workroom preference offers auto by default, recommendations and off with honest scope', () => {
  const html=option(state({}));
  expect(html).toContain('data-testid="workroom-effort-mode"');expect(html).toContain('data-help-key="workroom-effort-auto"');
  expect(html).toContain('value="auto" selected=""');
  for(const text of ['자동선택 (기본)','추천제공','미선택','낮음·보통·높음','후속 요청','연동된 외부 CLI','현재 세션에만','Codex · Claude Code · Hermes'])expect(html).toContain(text);
  expect(option(state({auto:false,mode:'recommend'}))).toContain('실제 강도는 직접 선택');
  expect(option(state({auto:false,mode:'off'}))).toContain('value="off" selected=""');
  expect(option(state({busy:true}))).toContain('disabled=""');expect(option(state({error:'저장 실패'}))).toContain('저장 실패');
  expect(option(state({}),{remote:true,deviceName:'아젠투지 1호'})).toContain('아젠투지 1호의 프로젝트 워크룸과 연동된 외부 CLI');
});

test('a panel driving another community Mac shows that Mac’s setting read-only', () => {
  const html = option(state({auto: false}), {readOnly: WORKROOM_EFFORT_ELSEWHERE});
  expect(html).toContain('data-testid="workroom-effort-auto-readonly"');
  expect(html).toContain('에포트 미선택');
  expect(html).toContain(WORKROOM_EFFORT_ELSEWHERE);
  expect(html).not.toContain('type="checkbox"');
});

test('the receipt: badge and advice, both nothing without a decision', () => {
  const session = {agent: 'claude' as const, tier: 'high' as const, reason: 'concurrency' as const, level: 'high' as const, origin: 'launch' as const, manual: false};
  const badge = renderToStaticMarkup(<WorkroomEffortBadge session={session}/>);
  expect(badge).toContain('data-testid="workroom-effort-badge"');
  expect(badge).toContain('data-help-key="workroom-effort-badge"');
  expect(badge).toContain('에포트 자동 · 높음 (동시성)');
  expect(badge).toContain('data-effort-level="high"');
  expect(renderToStaticMarkup(<WorkroomEffortBadge session={null}/>)).toBe('');
  expect(renderToStaticMarkup(<WorkroomEffortBadge session={{agent: 'claude', manual: false}}/>)).toBe('');
  const advice = renderToStaticMarkup(<WorkroomEffortAdvice session={{...session, tier: 'medium', reason: 'standard', level: 'medium', advice: {tier: 'high', reason: 'design-review'}}}/>);
  expect(advice).toContain('data-testid="workroom-effort-advice"');
  expect(advice).toContain('이번 요청은 높음이 맞아 보입니다 (설계·리뷰) · 지금 보통 · 바꾸려면 「에포트 변경」');
  expect(renderToStaticMarkup(<WorkroomEffortAdvice session={session}/>)).toBe('');
});

test('both help keys have guide entries', () => {
  expect(GUIDE_CONTENT['workroom-effort-auto']?.title).toBe('워크룸 에포트 조정');
  expect(GUIDE_CONTENT['workroom-effort-badge']?.title).toBeTruthy();
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('extended local read negotiates max, older strict hosts fall back once, and writes never retry', async () => {
  const record = {sessionId:'session-1234',agent:'claude' as const,manual:false,level:'max' as const,origin:'launch' as const};
  const calls: unknown[] = [];
  let old = false;
  const request = createWorkroomEffortRequest(async raw => {
    const parsed = normalizeMobileWorkspaceRequest(raw);
    calls.push(parsed.workspace);
    if (old && parsed.workspace.effortExtended) throw new Error('모바일 작업 요청 형식이 올바르지 않습니다.');
    return normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.effort',effort:workroomEffortView(true,record,'auto',parsed.workspace.effortExtended === true)});
  }, true);
  const input = {targetId:'project-1234',sessionId:'session-1234'};
  expect((await request(input)).session?.level).toBe('max');
  expect(calls).toHaveLength(1);
  old = true;
  expect((await request(input)).session?.level).toBeUndefined();
  expect(calls).toHaveLength(3);
  expect((calls[1] as {effortExtended?:boolean}).effortExtended).toBe(true);
  expect((calls[2] as {effortExtended?:boolean}).effortExtended).toBeUndefined();
  await request(input);
  expect(calls).toHaveLength(4);
  const failedWrites: unknown[] = [];
  const write = createWorkroomEffortRequest(async raw => {failedWrites.push(raw); throw new Error('모바일 작업 요청 형식이 올바르지 않습니다.');}, true);
  await expect(write({...input,mode:'off'})).rejects.toThrow();
  expect(failedWrites).toHaveLength(1);
  const legacy = workroomEffortView(true,record,'auto');
  expect(legacy.session?.level).toBeUndefined();
});
test('effortExtended: the strict normalizer takes only `true`, only on workroom.effort, and a reply carries no new key', () => {
  const request = (workspace: Record<string, unknown>) => ({operation: 'workspace', requestId: 'request-1234', targetId: 'project-1234', workspace});
  // Accepted with or without a session, for a read or a change, and kept as sent.
  for (const workspace of [{action: 'workroom.effort', effortModes: true, effortExtended: true},
    {action: 'workroom.effort', effortModes: true, effortExtended: true, sessionId: 'session-1234'},
    {action: 'workroom.effort', effortModes: true, effortExtended: true, mode: 'off'}])
    expect(normalizeMobileWorkspaceRequest(request(workspace)).workspace.effortExtended).toBe(true);
  expect(normalizeMobileWorkspaceRequest(request({action: 'workroom.effort', effortModes: true})).workspace.effortExtended).toBeUndefined();
  // Anything but `true`, or on any other action, is the same refusal an older host gives (so the reader's one fallback applies).
  for (const value of [false, 'true', 1, null, {}])
    expect(() => normalizeMobileWorkspaceRequest(request({action: 'workroom.effort', effortModes: true, effortExtended: value}))).toThrow('모바일 작업 요청 형식이 올바르지 않습니다.');
  for (const action of ['workroom.status', 'memory.status', 'workroom.save'])
    expect(() => normalizeMobileWorkspaceRequest(request({action, sessionId: 'session-1234', effortExtended: true}))).toThrow('모바일 작업 요청 형식이 올바르지 않습니다.');
  // The reply keeps its three keys; a pinned max survives only the negotiated reader, and an unknown session key is refused.
  const record = {sessionId: 'session-1234', agent: 'codex' as const, manual: false, level: 'ultra' as const, origin: 'launch' as const};
  expect(normalizeMobileWorkspaceResult({kind: 'workspace', action: 'workroom.effort', effort: workroomEffortView(true, record, 'auto', true)}).effort?.session?.level).toBe('ultra');
  expect(() => normalizeMobileWorkspaceResult({kind: 'workspace', action: 'workroom.effort', effort: {auto: true}, effortExtended: true})).toThrow();
  expect(() => normalizeMobileWorkspaceResult({kind: 'workspace', action: 'workroom.effort', effort: {auto: true, session: {agent: 'codex', manual: false, pinned: 'max'}}})).toThrow();
  for (const level of ['xhigh', 'max', 'ultra'] as const) expect(workroomEffortView(true, {...record, level}, 'auto').session?.level).toBeUndefined();
});

test('a phone never asks for extended levels: only the Mac\'s own panel does, and a phone request carries no new key', async () => {
  const sent: unknown[] = [];
  const phone = createWorkroomEffortRequest(async raw => { sent.push(normalizeMobileWorkspaceRequest(raw).workspace); return normalizeMobileWorkspaceResult({kind: 'workspace', action: 'workroom.effort', effort: {auto: true}}); }, false);
  await phone({targetId: 'project-1234', sessionId: 'session-1234'});
  await phone({targetId: 'project-1234', mode: 'recommend'});
  expect(sent.every(workspace => !Object.hasOwn(workspace as object, 'effortExtended'))).toBe(true);
  // The panel asks for extended levels only when it is not a remote surface (src/AiTerminalPanel.tsx).
  const panel = await Bun.file(new URL('../src/AiTerminalPanel.tsx', import.meta.url)).text();
  expect(panel).toMatch(/useWorkroomEffort\(\{[^}]*extended:!remote\}\)/);
});
type ReaderInput = Parameters<Parameters<typeof createWorkroomEffortReader>[0]>[0];
function reader(answer: (input: ReaderInput) => Promise<WorkroomEffortView>, options: {readOnly?: boolean} = {}) {
  const calls: ReaderInput[] = [];
  const states: WorkroomEffortState[] = [];
  const r = createWorkroomEffortReader(input => { calls.push(input); return answer(input); }, s => states.push(s), options);
  return {r, calls, states};
}

test('the reader asks once at a time, folds overlapping asks into one more, and ignores an answer for a target it left', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const {r, calls} = reader(async input => { await gate; return {auto: true, session: input.sessionId ? {agent: 'claude', level: 'high', tier: 'high', reason: 'security', manual: false} : undefined}; });
  r.point({targetId: 'target-a', sessionId: 'session-a'});
  void r.read(); void r.read(); void r.read();
  expect(calls.length).toBe(1);
  r.point({targetId: 'target-b'});
  release(); await flush(); await flush();
  // The first answer belonged to session-a: its record is not shown for target-b, but the Mac's setting is.
  expect(r.state().auto).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[1]).toEqual({effortModes:true,targetId: 'target-b'});
  await flush();
  expect(r.state().session).toBeNull();
});

test('the record says which session it belongs to', async () => {
  const {r} = reader(async input => ({auto: true, ...(input.sessionId ? {session: {agent: 'codex' as const, manual: false, skipped: 'model-unknown' as const}} : {})}));
  r.point({targetId: 'target-a', sessionId: 'session-a'});
  await r.read();
  expect(r.state()).toMatchObject({sessionId: 'session-a', session: {agent: 'codex', skipped: 'model-unknown'}});
  r.point({targetId: 'target-a', sessionId: 'session-b'});
  expect(r.state()).toMatchObject({sessionId: null, session: null});
  r.point({targetId: 'target-a'});
  await r.read();
  expect(r.state()).toMatchObject({sessionId: null, session: null, auto: true});
});

test('an older Mac’s refusal hides everything for good — no retry loop; a network failure is not that', async () => {
  let mode: 'old' | 'down' = 'down';
  const {r, calls} = reader(async () => { throw new Error(mode === 'old' ? '모바일 작업 요청 형식이 올바르지 않습니다.' : 'Load failed'); });
  r.point({targetId: 'target-a'});
  await r.read();
  expect(r.state().supported).toBeNull();
  mode = 'old';
  await r.read();
  expect(r.state().supported).toBe(false);
  await r.read(); await r.read();
  expect(calls.length).toBe(2);
  await r.set(false);
  expect(calls.length).toBe(2);
});

test('a change is sent once, only after the Mac answered, and its failure says so without losing the shown value', async () => {
  let fail = false, auto = true;
  const {r, calls} = reader(async input => { if (input.set !== undefined) { if (fail) throw new Error('저장하지 못했습니다.'); auto = input.set; } return {auto}; });
  r.point({targetId: 'target-a'});
  await r.set(false);
  expect(calls.length).toBe(0); // not before the first answer
  await r.read();
  await Promise.all([r.set(false), r.set(false)]);
  expect(calls.filter(c => c.set !== undefined)).toEqual([{effortModes:true,targetId: 'target-a', set: false}]);
  expect(r.state()).toMatchObject({auto: false, busy: false, error: ''});
  fail = true;
  await r.set(true);
  expect(r.state()).toMatchObject({auto: false, busy: false, error: '저장하지 못했습니다.'});
});

test('a read-only reader never sends a change', async () => {
  const {r, calls} = reader(async () => ({auto: true}), {readOnly: true});
  r.point({targetId: 'target-a'});
  await r.read();
  await r.set(false);
  expect(calls).toEqual([{effortModes:true,targetId: 'target-a'}]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

test('a read begun before a setting change cannot restore the old checkbox value', async () => {
  const oldRead = deferred<WorkroomEffortView>();
  let reads = 0;
  const {r} = reader(async input => input.set !== undefined ? {auto: input.set} : ++reads === 1 ? {auto: true} : oldRead.promise);
  r.point({targetId: 'target-a'});
  await r.read();
  const pending = r.read();
  await r.set(false);
  expect(r.state().auto).toBe(false);
  oldRead.resolve({auto: true});
  await pending;
  expect(r.state().auto).toBe(false);
});

test('replacing the Mac reader retires its pending response and queued refreshes', async () => {
  const oldRead = deferred<WorkroomEffortView>();
  const {r, calls, states} = reader(() => oldRead.promise);
  r.point({targetId: 'target-a', sessionId: 'session-a'});
  const pending = r.read();
  void r.read();
  r.dispose();
  const published = states.length;
  oldRead.resolve({auto: true, session: {agent: 'claude', level: 'high', manual: false}});
  await pending;
  await r.set(false);
  expect(states.length).toBe(published);
  expect(calls).toHaveLength(1);
});
