/**
 * 「주간 잔여」 on the phone's Home tab: one read-only workspace action, `usage.weekly`, on the existing `workspace-v1` channel —
 * no capability flag, no protocol version, no project-card key. The Mac answers from a snapshot without holding its relay poll;
 * the phone reads a strict shape and hides the card for a Mac that refuses the action.
 */
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AI_TERMINAL_REQUEST_INVALID_CODE} from '../src/aiTerminalProtocol';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, workspaceScope, type MobileWorkspaceRequest, type MobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';
import {isBackgroundTerminalRequest, readOnlyTerminalProbe} from '../src/remoteControlRelayController';
import {normalizeRemoteTerminalRequest} from '../src/remoteControlTerminalProtocol';
import {
  RemoteWeeklyUsageView, WEEKLY_USAGE_ACCOUNT_NOTE, WEEKLY_USAGE_AUTO_READ_GAP_MS, WEEKLY_USAGE_CONNECT_HINT, createRemoteWeeklyUsageReader, remoteWeeklyUsageAgo,
  weeklyUsageCardLines, type RemoteWeeklyUsageCardState, type RemoteWeeklyUsageMemory,
} from '../src/RemoteWeeklyUsageCard';
import {weeklyUsageState, type WeeklyUsage} from '../src/weeklyUsage';
import {codexWeeklyUsageNoDataState} from '../src/weeklyUsageDisplay';
import {DockWeeklyUsageFigure} from '../src/components/DockWeeklyUsage';
import {
  WEEKLY_USAGE_COMMUNITY_REFUSAL, WEEKLY_USAGE_REMOTE_ACTION, WEEKLY_USAGE_UPDATE_REQUIRED, normalizeRemoteWeeklyUsage, readRemoteWeeklyUsage, remoteWeeklyUsageMinimum,
  remoteWeeklyUsageState, toRemoteWeeklyUsage, weeklyUsageUnsupported, type RemoteWeeklyUsageRow,
} from '../src/weeklyUsageRemote';
import {createWeeklyUsageRemoteReader} from '../src/weeklyUsageRemoteHost';

const NOW = Date.parse('2026-10-29T03:00:00.000Z');
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
const host = (over: Partial<Record<'claude' | 'codex' | 'agy', Partial<WeeklyUsage>>> = {}): WeeklyUsage[] => [
  {provider: 'claude', buckets: [{label: '주간', remainingPercent: 63, resetsAt: 1793664000}], checkedAt: '2026-10-29T02:58:00.123456+00:00', source: 'statusline', connected: true, canConnect: true, ...over.claude},
  {provider: 'codex', buckets: [{label: '주간', remainingPercent: 41.5, resetsAt: 1793600000}], checkedAt: iso(-20_000), source: 'live', connected: true, canConnect: false, ...over.codex},
  {provider: 'agy', buckets: [], checkedAt: null, source: 'unavailable', connected: false, canConnect: true, ...over.agy},
];
const row = (over: Partial<RemoteWeeklyUsageRow> = {}): RemoteWeeklyUsageRow => ({provider: 'codex', buckets: [{label: '주간', remainingPercent: 50, resetsAt: null}], checkedAt: iso(), source: 'live', connected: true, ...over});
const request = {operation: 'workspace' as const, requestId: 'request_weekly_1', targetId: 'control_1234', workspace: {action: WEEKLY_USAGE_REMOTE_ACTION}};

test('the Mac sends its rows in claude/codex/agy order without canConnect, every value checked and the time a plain ISO instant', () => {
  const rows = toRemoteWeeklyUsage([...host({agy: {buckets: [
    {label: 'Gemini', remainingPercent: 80, resetsAt: 0}, {label: 'Claude/GPT', remainingPercent: 45, resetsAt: 1793700000.5},
    {label: '5시간', remainingPercent: 10, resetsAt: null}, {label: '추가 한도', remainingPercent: Number.NaN, resetsAt: null}, {label: '추가 한도', remainingPercent: 101, resetsAt: null},
  ], checkedAt: 'not a time', connected: true}})].reverse());
  expect(rows.map(r => r.provider)).toEqual(['claude', 'codex', 'agy']);
  for (const r of rows) expect(Object.keys(r).sort()).toEqual(['buckets', 'checkedAt', 'connected', 'provider', 'source']);
  // Python's isoformat() (microseconds, +00:00) becomes the form every engine parses.
  expect(rows[0]!.checkedAt).toBe('2026-10-29T02:58:00.123Z');
  expect(rows[2]).toEqual({provider: 'agy', buckets: [{label: 'Gemini', remainingPercent: 80, resetsAt: null}, {label: 'Claude/GPT', remainingPercent: 45, resetsAt: 1793700000.5}], checkedAt: null, source: 'unavailable', connected: true});
  expect(normalizeRemoteWeeklyUsage(rows)).toEqual(rows);
  expect(toRemoteWeeklyUsage([])).toEqual([]);
  // At most eight buckets reach the phone.
  expect(toRemoteWeeklyUsage(host({agy: {buckets: Array.from({length: 12}, () => ({label: '추가 한도', remainingPercent: 50, resetsAt: null}))}}))[2]!.buckets).toHaveLength(8);
});

test('the phone accepts exactly that shape and rejects the whole answer on anything else', () => {
  const good = [row({provider: 'claude', source: 'statusline'}), row(), row({provider: 'agy', buckets: [], checkedAt: null, source: 'unavailable', connected: false})];
  expect(normalizeRemoteWeeklyUsage(good)).toEqual(good);
  expect(normalizeRemoteWeeklyUsage([])).toEqual([]);
  const bucket = (b: Record<string, unknown>) => [row({buckets: [b as never]})];
  for (const bad of [
    null, {}, 'rows',
    [{...row(), canConnect: false}],
    [row({provider: 'claude'}), row(), row({provider: 'agy'}), row({provider: 'agy'})],
    [row(), row()],
    [row(), row({provider: 'claude'})],
    [row({provider: 'gemini' as never})],
    [row({buckets: Array.from({length: 9}, () => ({label: '주간', remainingPercent: 1, resetsAt: null}))})],
    bucket({label: '5시간', remainingPercent: 1, resetsAt: null}),
    bucket({label: '주간', remainingPercent: Number.NaN, resetsAt: null}),
    bucket({label: '주간', remainingPercent: 100.1, resetsAt: null}),
    bucket({label: '주간', remainingPercent: -1, resetsAt: null}),
    bucket({label: '주간', remainingPercent: '50', resetsAt: null}),
    bucket({label: '주간', remainingPercent: 50, resetsAt: 0}),
    bucket({label: '주간', remainingPercent: 50, resetsAt: '2026-11-03T00:00:00Z'}),
    bucket({label: '주간', remainingPercent: 50}),
    bucket({label: '주간', remainingPercent: 50, resetsAt: null, used: 50}),
    [row({checkedAt: 'yesterday'})],
    [row({checkedAt: '2026-10-29'})],
    [row({checkedAt: `${'2026-10-29T03:00:00.'}${'1'.repeat(80)}Z`})],
    [row({source: 'session-log' as never})],
    [row({connected: 'yes' as never})],
    [{provider: 'codex', buckets: [], checkedAt: null, source: 'live'}],
  ]) expect(() => normalizeRemoteWeeklyUsage(bad)).toThrow('주간 잔여 응답 형식이 올바르지 않습니다.');
});

test('the phone reads the same four states as the Mac dock and the same figure (the lowest bucket)', () => {
  const cases: [Partial<WeeklyUsage>, number][] = [
    [{buckets: [], checkedAt: null, connected: true}, NOW],
    [{buckets: [], checkedAt: null, connected: false}, NOW],
    [{buckets: [{label: '주간', remainingPercent: 40, resetsAt: null}], checkedAt: iso(-60_000)}, NOW],
    [{buckets: [{label: '주간', remainingPercent: 40, resetsAt: null}], checkedAt: iso(-16 * 60_000)}, NOW],
    [{buckets: [{label: '주간', remainingPercent: 40, resetsAt: NOW / 1000 - 1}], checkedAt: iso(-60_000)}, NOW],
    [{buckets: [{label: '주간', remainingPercent: 40, resetsAt: NOW / 1000 + 3600}], checkedAt: iso(5 * 60_000)}, NOW],
    [{buckets: [{label: '주간', remainingPercent: 40, resetsAt: null}], checkedAt: null, connected: true}, NOW],
  ];
  const seen = new Set<string>();
  for (const [over, now] of cases) {
    const full: WeeklyUsage = {provider: 'claude', buckets: [], checkedAt: null, source: 'statusline', connected: true, canConnect: true, ...over};
    // Same object on both sides (the labels here are all ones the phone accepts): the phone's state must equal the dock's.
    expect(remoteWeeklyUsageState(full as unknown as RemoteWeeklyUsageRow, now)).toBe(weeklyUsageState(full, now));
    seen.add(weeklyUsageState(full, now));
  }
  expect([...seen].sort()).toEqual(['ready', 'stale', 'unavailable', 'waiting']);
  expect(remoteWeeklyUsageMinimum({buckets: [{label: 'Gemini', remainingPercent: 80, resetsAt: 1}, {label: 'Claude/GPT', remainingPercent: 45, resetsAt: 2}]})).toEqual({remainingPercent: 45, resetsAt: 2});
  expect(remoteWeeklyUsageMinimum({buckets: []})).toBeNull();
});

test('the request has no keys of its own, needs no feature scope, and its answer carries only the weekly rows', () => {
  expect(normalizeMobileWorkspaceRequest(request)).toEqual(request);
  expect(normalizeRemoteTerminalRequest({type: 'terminal.request', sessionToken: 'a'.repeat(43), request}).request).toEqual(request);
  for (const extra of [{sessionId: 'session_1234'}, {set: true}, {provider: 'claude'}, {operation: 'connect'}, {query: 'x'}])
    expect(() => normalizeMobileWorkspaceRequest({...request, workspace: {action: WEEKLY_USAGE_REMOTE_ACTION, ...extra}})).toThrow();
  expect(workspaceScope(WEEKLY_USAGE_REMOTE_ACTION)).toBeNull();
  const ok = {kind: 'workspace', action: WEEKLY_USAGE_REMOTE_ACTION, weeklyUsage: [row()]};
  expect(normalizeMobileWorkspaceResult(ok)).toEqual(ok as never);
  for (const bad of [
    {kind: 'workspace', action: WEEKLY_USAGE_REMOTE_ACTION},
    {kind: 'workspace', action: WEEKLY_USAGE_REMOTE_ACTION, weeklyUsage: [row()], effort: {auto: true}},
    {kind: 'workspace', action: WEEKLY_USAGE_REMOTE_ACTION, weeklyUsage: [{...row(), canConnect: true}]},
    {kind: 'workspace', action: 'memory.status', weeklyUsage: [row()]},
    {kind: 'workspace', action: 'workroom.effort', effort: {auto: true}, weeklyUsage: []},
  ]) expect(() => normalizeMobileWorkspaceResult(bad)).toThrow();
});

function gatewayFixture(over: {granted?: string[]; weeklyUsage?: (() => Promise<RemoteWeeklyUsageRow[]>) | null; live?: () => boolean} = {}) {
  const calls = {perform: 0, forward: 0, weekly: 0};
  const gateway = createMobileWorkspaceGateway({
    terminal: async () => ({sessions: []}), active: () => true,
    resolve: async () => [{controlId: 'control_1234', runtimeTargetId: 'runtime_1234'}, {controlId: 'control_5678', runtimeTargetId: 'runtime_5678'}],
    consent: async () => ({targetIds: new Set(over.granted ?? ['runtime_1234']), workspaceScopes: [], isActive: over.live ?? (() => true), requestOwner: 'device_1234'}),
    perform: async () => { calls.perform++; throw new Error('perform must not run'); },
    opsRuntimeTargetId: () => 'runtime_1234',
    forward: async () => { calls.forward++; return {kind: 'workspace', action: WEEKLY_USAGE_REMOTE_ACTION, weeklyUsage: []}; },
    ...(over.weeklyUsage === null ? {} : {weeklyUsage: async () => { calls.weekly++; return (over.weeklyUsage ?? (async () => toRemoteWeeklyUsage(host())))(); }}),
  });
  return {gateway, calls};
}

test('the Mac answers a phone holding at least one project, through any project it was shown, and nothing more', async () => {
  const {gateway, calls} = gatewayFixture();
  const result = await gateway(request, [], 'owner') as MobileWorkspaceResult;
  expect(result).toEqual({kind: 'workspace', action: WEEKLY_USAGE_REMOTE_ACTION, weeklyUsage: toRemoteWeeklyUsage(host())});
  expect(JSON.stringify(result)).not.toContain('canConnect');
  // The project it rides is only a channel: one shown but not granted still carries it while another is granted.
  expect(((await gateway({...request, targetId: 'control_5678'}, [], 'owner')) as MobileWorkspaceResult).action).toBe(WEEKLY_USAGE_REMOTE_ACTION);
  // A project this phone was never shown is refused.
  await expect(gateway({...request, targetId: 'control_9999'}, [], 'owner')).rejects.toThrow('프로젝트 범위를 허용하세요');
  expect(calls).toEqual({perform: 0, forward: 0, weekly: 2});
});

test('no granted project, no consent, a revoked grant, another community device or an exhausted read budget gets nothing', async () => {
  const none = gatewayFixture({granted: []});
  await expect(none.gateway(request, [], 'owner')).rejects.toThrow('프로젝트 범위를 허용하세요');
  expect(none.calls.weekly).toBe(0);
  const noConsent = createMobileWorkspaceGateway({terminal: async () => ({}), active: () => true, resolve: async () => [{controlId: 'control_1234', runtimeTargetId: 'runtime_1234'}], consent: async () => null,
    perform: async () => { throw new Error('unreachable'); }, weeklyUsage: async () => { throw new Error('unreachable'); }});
  await expect(noConsent(request, [], 'owner')).rejects.toThrow('프로젝트 범위를 허용하세요');
  let live = true;
  const revoked = gatewayFixture({live: () => live, weeklyUsage: async () => { live = false; return []; }});
  await expect(revoked.gateway(request, [], 'owner')).rejects.toThrow('결과를 다시 확인하세요');
  const device = gatewayFixture();
  await expect(device.gateway(request, [], 'owner', () => true, 'device_ref_3ho')).rejects.toThrow(WEEKLY_USAGE_COMMUNITY_REFUSAL);
  expect(device.calls).toEqual({perform: 0, forward: 0, weekly: 0});
  const budget = gatewayFixture();
  for (let i = 0; i < 60; i++) await budget.gateway({...request, requestId: `request_weekly_${i + 10}`}, [], 'owner');
  await expect(budget.gateway(request, [], 'owner')).rejects.toThrow('모바일 조회 요청이 많습니다');
  expect(budget.calls.weekly).toBe(60);
});

test('a composition without the reader says to update the Mac, which the card does not take for an older Mac', async () => {
  const {gateway} = gatewayFixture({weeklyUsage: null});
  const error = await gateway(request, [], 'owner').catch(e => e);
  expect(error.message).toBe(WEEKLY_USAGE_UPDATE_REQUIRED);
  expect(weeklyUsageUnsupported(error)).toBe(false);
  // An older Mac's strict request check, an older relay host, or the relay's own refusal code: hide the card.
  expect(weeklyUsageUnsupported(new Error('모바일 작업 요청 형식이 올바르지 않습니다.'))).toBe(true);
  expect(weeklyUsageUnsupported(Object.assign(new Error('터미널 요청 형식이 올바르지 않습니다.'), {code: AI_TERMINAL_REQUEST_INVALID_CODE}))).toBe(true);
  expect(weeklyUsageUnsupported(new TypeError('Load failed'))).toBe(false);
  expect(weeklyUsageUnsupported(new Error(WEEKLY_USAGE_COMMUNITY_REFUSAL))).toBe(false);
});

test('on the phone the read waits behind what a person pressed, and an older Mac’s refusal does not stand as the relay error', () => {
  expect(isBackgroundTerminalRequest(request)).toBe(true);
  expect(readOnlyTerminalProbe(request)).toBe(true);
  // Unchanged neighbours.
  expect(readOnlyTerminalProbe({...request, workspace: {action: 'memory.status'}})).toBe(false);
  expect(isBackgroundTerminalRequest({...request, workspace: {action: 'voc.inbox'}})).toBe(false);
});

test('the Mac answers from its snapshot at once, refreshes at most once per Codex cache, and waits for a refresh at most two seconds', async () => {
  let clock = NOW, calls = 0;
  const gate: {release?: () => void} = {};
  const reader = createWeeklyUsageRemoteReader({now: () => clock, waitMs: 20, status: async () => {
    calls++;
    if (calls === 2) await new Promise<void>(resolve => { gate.release = resolve; });
    return host({codex: {buckets: [{label: '주간', remainingPercent: 41.5 - calls, resetsAt: null}]}});
  }});
  const first = await reader();
  expect(first[1]!.buckets[0]!.remainingPercent).toBe(40.5);
  // Within the cache window: the snapshot, no new status().
  clock += 29_000;
  expect(await reader()).toEqual(first);
  expect(calls).toBe(1);
  // Past it: one refresh starts; a slow one is not awaited past the wait, and a second read joins it instead of starting another.
  clock += 2_000;
  const started = performance.now();
  expect(await reader()).toEqual(first);
  expect(await reader()).toEqual(first);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(calls).toBe(2);
  gate.release!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((await reader())[1]!.buckets[0]!.remainingPercent).toBe(39.5);
  expect(calls).toBe(2);
});

test('before its first read finishes the Mac answers nothing rather than a guess, and a failed refresh keeps the last snapshot', async () => {
  let clock = NOW, fail = false;
  const slow = createWeeklyUsageRemoteReader({now: () => clock, waitMs: 10, status: () => new Promise(() => {})});
  expect(await slow()).toEqual([]);
  const flaky = createWeeklyUsageRemoteReader({now: () => clock, waitMs: 50, status: async () => { if (fail) throw new Error('codex gone'); return host(); }});
  const kept = await flaky();
  fail = true; clock += 60_000;
  expect(await flaky()).toEqual(kept);
  // A synchronous throw does not wedge the refresh either.
  const sync = createWeeklyUsageRemoteReader({now: () => clock, waitMs: 50, status: () => { throw new Error('sync'); }});
  expect(await sync()).toEqual([]);
  expect(await sync()).toEqual([]);
});

const cardState = () => {
  const published: RemoteWeeklyUsageCardState[] = [];
  return {published, last: () => published.at(-1)!};
};
const memory = (): RemoteWeeklyUsageMemory => ({answers: new Map(), refused: new Set()});

test('the card reads one Mac at a time, remembers each Mac’s answer, and an older Mac’s refusal hides it for that Mac only', async () => {
  const s = cardState(), mem = memory();
  let clock = NOW;
  const asked: string[] = [];
  const answers: Record<string, () => Promise<RemoteWeeklyUsageRow[]>> = {
    control_a: async () => [row()],
    control_old: async () => { throw Object.assign(new Error('터미널 요청 형식이 올바르지 않습니다.'), {code: AI_TERMINAL_REQUEST_INVALID_CODE}); },
  };
  const reader = createRemoteWeeklyUsageReader(async id => { asked.push(id); return answers[id]!(); }, state => s.published.push(state), {memory: mem, now: () => clock});
  reader.point({host: 'host_a', controlId: 'control_a'});
  await reader.read();
  expect(s.last()).toMatchObject({host: 'host_a', rows: [row()], readAt: NOW, busy: false, error: '', unsupported: false});
  // An automatic read right after an answer is skipped; 「새로고침」 is not.
  await reader.read();
  expect(asked).toEqual(['control_a']);
  await reader.read(true);
  expect(asked).toEqual(['control_a', 'control_a']);
  clock += WEEKLY_USAGE_AUTO_READ_GAP_MS;
  await reader.read();
  expect(asked).toHaveLength(3);
  reader.point({host: 'host_old', controlId: 'control_old'});
  expect(s.last()).toMatchObject({host: 'host_old', rows: null, unsupported: false});
  await reader.read();
  expect(s.last()).toMatchObject({host: 'host_old', unsupported: true, error: ''});
  await reader.read(true);
  expect(asked.filter(id => id === 'control_old')).toHaveLength(1);
  reader.point({host: 'host_a', controlId: 'control_a'});
  expect(s.last()).toMatchObject({host: 'host_a', rows: [row()], unsupported: false});
});

test('a failure keeps what is shown, an answer for a Mac the card left is only remembered, and reads never pile up', async () => {
  const s = cardState(), mem = memory();
  const gate: {release?: (rows: RemoteWeeklyUsageRow[]) => void} = {};
  let fail = false;
  const asked: string[] = [];
  const reader = createRemoteWeeklyUsageReader(id => { asked.push(id); if (fail) return Promise.reject(new Error('휴대폰이 오프라인입니다.')); return new Promise(resolve => { gate.release = resolve; }); },
    state => s.published.push(state), {memory: mem, now: () => NOW});
  reader.point({host: 'host_a', controlId: 'control_a'});
  const first = reader.read();
  expect(s.last().busy).toBe(true);
  // Asked again while one is in flight: folded into one more read after it, for the Mac shown then (the card points, then reads).
  void reader.read(true); void reader.read(true);
  reader.point({host: 'host_b', controlId: 'control_b'});
  void reader.read();
  gate.release!([row({provider: 'claude', source: 'statusline'})]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(asked).toEqual(['control_a', 'control_b']);
  expect(s.last().host).toBe('host_b');
  expect(s.last().rows).toBeNull();
  expect(mem.answers.get('host_a')?.rows[0]!.provider).toBe('claude');
  gate.release!([row()]);
  await first;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(s.last()).toMatchObject({host: 'host_b', rows: [row()], busy: false});
  fail = true;
  await reader.read(true);
  expect(s.last()).toMatchObject({host: 'host_b', rows: [row()], error: '휴대폰이 오프라인입니다.'});
  reader.dispose();
  const count = s.published.length;
  await reader.read(true);
  expect(s.published).toHaveLength(count);
});

test('the read goes through the workspace transport with nothing but the action', async () => {
  const sent: MobileWorkspaceRequest[] = [];
  const rows = await readRemoteWeeklyUsage(async r => { sent.push(r); return {kind: 'workspace', action: WEEKLY_USAGE_REMOTE_ACTION, weeklyUsage: [row()]}; }, 'control_1234');
  expect(rows).toEqual([row()]);
  expect(sent[0]!.workspace).toEqual({action: WEEKLY_USAGE_REMOTE_ACTION});
  expect(normalizeMobileWorkspaceRequest(sent[0])).toBeTruthy();
  await expect(readRemoteWeeklyUsage(async () => ({kind: 'workspace', action: 'memory.status'} as MobileWorkspaceResult), 'control_1234')).rejects.toThrow();
});

const view = (over: Partial<React.ComponentProps<typeof RemoteWeeklyUsageView>> = {}) => renderToStaticMarkup(<RemoteWeeklyUsageView hostName="아젠투지 1호"
  rows={toRemoteWeeklyUsage(host())} readAt={NOW} busy={false} error="" phoneOnline macOnline now={NOW} onRefresh={() => {}} {...over}/>);

test('the card says each CLI’s remaining figure, when it resets, what is old, and what would connect it', () => {
  const html = view();
  expect(html).toContain('data-testid="remote-weekly-usage"');
  expect(html).toContain('주간 잔여 <span>· 아젠투지 1호</span>');
  expect(html).toContain('63% 남음');
  expect(html).toContain('41.5% 남음');
  // Reset time in the phone's one date format (11월 3일 …), never toLocaleString.
  expect(html).toMatch(/11월 3일 \d{2}:\d{2} 초기화/);
  expect(html).toContain(WEEKLY_USAGE_CONNECT_HINT);
  expect(html).toContain(WEEKLY_USAGE_ACCOUNT_NOTE);
  expect(html).toContain('aria-label="주간 잔여 새로고침"');
  const lines = weeklyUsageCardLines(toRemoteWeeklyUsage(host({
    claude: {checkedAt: iso(-40 * 60_000)},
    codex: {buckets: [], checkedAt: null},
    agy: {buckets: [{label: 'Gemini', remainingPercent: 80, resetsAt: null}, {label: 'Claude/GPT', remainingPercent: 9, resetsAt: null}], checkedAt: iso(-60_000), connected: true},
  })), NOW);
  expect(lines.map(l => [l.provider, l.state, l.figure])).toEqual([['claude', 'stale', '63% 남음'], ['codex', 'unavailable', '확인 안 됨'], ['agy', 'ready', '최소 9% 남음']]);
  expect(lines[0]!.detail).toBe('이전 값 · 40분 전');
  expect(lines[2]).toMatchObject({detail: 'Gemini 80% · Claude/GPT 9% · 초기화 시각 미제공', low: true});
  expect(weeklyUsageCardLines(toRemoteWeeklyUsage(host({claude: {buckets: [], checkedAt: null, connected: true}})), NOW)[0]).toMatchObject({state: 'waiting', figure: '활동 대기'});
  expect(remoteWeeklyUsageAgo(iso(-3 * 3600_000), NOW)).toBe('3시간 전');
  expect(remoteWeeklyUsageAgo(null, NOW)).toBe('시각 미상');
});

test('live Codex response without a weekly window is distinct from a failed read on both displays', () => {
  const withoutWeekly = row({buckets: [], checkedAt: iso(-60_000), source: 'live'});
  expect(codexWeeklyUsageNoDataState(withoutWeekly, NOW)).toBe('current');
  expect(weeklyUsageCardLines([withoutWeekly], NOW)[1]).toMatchObject({figure: '주간 자료 없음', detail: 'Codex 응답에 주간 자료가 없습니다 · 1분 전 확인'});
  const html = view({rows: [withoutWeekly]});
  expect(html).toContain('주간 자료 없음');
  expect(html).toContain('Codex 응답에 주간 자료가 없습니다');
  for (const failed of [row({buckets: [], checkedAt: null, source: 'unavailable'}), row({buckets: [], checkedAt: null, source: 'live'}), row({buckets: [], checkedAt: iso(120_000), source: 'live'})]) {
    expect(codexWeeklyUsageNoDataState(failed, NOW)).toBeNull();
    expect(weeklyUsageCardLines([failed], NOW)[1]?.figure).toBe('확인 안 됨');
  }
  expect(codexWeeklyUsageNoDataState(row(), NOW)).toBeNull();
});

test('empty Codex weekly responses age consistently on the dock and mobile at the 15-minute boundary', () => {
  for (const [offset, expectedState, age] of [[-900_000, 'current', '15분 전 확인'], [-900_001, 'stale', '이전 확인 · 15분 전 확인']] as const) {
    const result = row({buckets: [], checkedAt: iso(offset), source: 'live'});
    expect(codexWeeklyUsageNoDataState(result, NOW)).toBe(expectedState);
    const mobile = weeklyUsageCardLines([result], NOW)[1]!;
    expect(mobile.figure).toBe('주간 자료 없음');
    expect(mobile.detail).toContain(age);
    expect(mobile.state).toBe(expectedState === 'stale' ? 'stale' : 'unavailable');
    const dock = renderToStaticMarkup(<DockWeeklyUsageFigure row={{...result, canConnect: false}} provider="codex" itemsLoaded now={NOW}/>);
    expect(dock).toContain('주간 자료 없음');
    expect(dock).toContain(age);
  }
  for (const invalid of [null, 'invalid', iso(60_001)]) {
    const result = row({buckets: [], checkedAt: invalid, source: 'live'});
    expect(codexWeeklyUsageNoDataState(result, NOW)).toBeNull();
    expect(weeklyUsageCardLines([result], NOW)[1]?.figure).toBe('확인 안 됨');
    const dock = renderToStaticMarkup(<DockWeeklyUsageFigure row={{...result, canConnect: false}} provider="codex" itemsLoaded now={NOW}/>);
    expect(dock).toContain('확인 안 됨');
    expect(dock).not.toContain('이전 확인');
  }
});

test('offline is said as offline, the last values as the last values, and an empty answer as still reading', () => {
  const phone = view({phoneOnline: false});
  expect(phone).toContain('휴대폰이 오프라인입니다 · 아래는 10월 29일');
  expect(phone).toContain('disabled=""');
  expect(view({macOnline: false, rows: null, readAt: null})).toContain('Mac이 응답하지 않습니다 · 주간 잔여를 확인하지 못했습니다.');
  expect(view({rows: []})).toContain('data-testid="remote-weekly-usage-pending"');
  expect(view({rows: null, readAt: null})).toContain('확인하는 중');
  expect(view({error: '모바일 조회 요청이 많습니다.'})).toContain('모바일 조회 요청이 많습니다.');
});

test('source contract: keyed on the host and first project, no polling timer, nothing from node or the Mac’s modules', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const portal = read('src/remote-control-portal-main.tsx'), card = read('src/RemoteWeeklyUsageCard.tsx'), remote = read('src/weeklyUsageRemote.ts');
  expect(portal).toContain("host={selectedHostId??''} hostName={status.hostName??''} controlId={status.projects[0]?.controlId??''} transport={workroomTransport}/>");
  expect(portal).not.toMatch(/<RemoteWeeklyUsageCard[^>]*projects=/);
  for (const source of [card, remote]) {
    expect(source).not.toMatch(/setInterval|from ['"]node:|from ['"][^'"]*(?:weeklyUsageHost|DockWeeklyUsage|i18n)['"]/);
    expect(source).not.toMatch(/^import \{[^}]*\} from '\.\/weeklyUsage';/m);
  }
  expect(card).toContain('clearTimeout(timer)');
  expect(remote).not.toContain('setTimeout');
  expect(card).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  const css = read('src/remote-control-portal.css');
  const block = css.slice(css.indexOf('.workspace-weekly {'), css.indexOf('.workspace-project-source {'));
  expect(block.length).toBeGreaterThan(100);
  expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba\(/);
});
