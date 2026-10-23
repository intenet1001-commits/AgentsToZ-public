/**
 * 업데이트 뒤 작업 세션 이어 열기 — the phone (w14, Build B). The restart offer travels as `history.restart` /
 * `history.restart.dismiss` on the existing history channel, advertised as `workroom-restart-v1` only on the extended
 * capability read. Rows carry the phone's own control ids, never runtime ids, session ids, paths, provider ids or account
 * names. Real SQLite journals in a temp folder, fixture transcripts. No CLI, app or network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { WorkroomConversationJournal, type WorkroomJournalOptions } from '../src/workroomConversationJournal';
import { WorkroomConversationService } from '../src/workroomConversationService';
import { workroomSessionContext } from '../src/workroomConversationIdentity';
import { WORKROOM_HISTORY_VERSION } from '../src/workroomConversationProtocol';
import { claudeProjectSlugCandidates } from '../src/sessionTranscript';
import { normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, type MobileWorkspaceRequest, type MobileWorkspaceResult } from '../src/mobileWorkspaceProtocol';
import { createMobileWorkspaceGateway } from '../src/mobileWorkspaceGateway';
import {
  REMOTE_HISTORY_ACTIONS, REMOTE_HISTORY_RESULT_BYTES, REMOTE_HISTORY_WHY, REMOTE_RESTART_AVAILABILITY, REMOTE_RESTART_ROW_KEYS,
  WORKROOM_RESTART_REMOTE_FEATURE, isRemoteHistoryAction, normalizeRemoteHistoryRequest, normalizeRemoteHistoryResult, remoteHistoryScopeFor,
} from '../src/workroomHistoryRemoteProtocol';
import { createRemoteWorkroomHistoryHost, type RemoteHistoryAccess } from '../src/workroomHistoryRemoteHost';
import { listRemoteRestart, dismissRemoteRestart, resumeRemoteRestartRows } from '../src/remoteWorkroomRestartClient';
import { listRemoteHistory } from '../src/remoteWorkroomHistoryClient';
import { pendingRemoteHistoryResumes } from '../src/workroomHistoryRemoteProtocol';
import { normalizeRemoteHistoryRequestV1 } from './fixtures/workroom-history-remote-request-v1';
import type { WorkroomSessionContext } from '../src/workroomConversationHost';
import type { AiTerminalAgent } from '../src/aiTerminalProtocol';
import { WORKROOM_RESTART_AVAILABILITY } from '../src/workroomConversationProtocol';

const BOOT_A = 'boot-aaaa-0001', BOOT_B = 'boot-bbbb-0002';
const TARGET = 'project-target-001', OTHER = 'project-target-002';
const CONTROL = 'control_' + 'T'.repeat(36), CONTROL_OTHER = 'control_' + 'O'.repeat(36);
const ACCOUNT = 'acct_12345678-1234-4123-8123-123456789abc';
const directories: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* already closed */ } } for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Boot A ran some sessions and died; boot B is this Mac now, with a service and the phone's history host. */
function restartFixture(rows: { target?: string; agent?: AiTerminalAgent; accountId?: string; bypass?: boolean; title?: string; save?: boolean }[], options: { platform?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-restart-remote-'))); directories.push(root);
  const cwd = join(root, 'project'), claudeHome = join(root, '.claude'), codexHome = join(root, '.codex');
  mkdirSync(cwd); mkdirSync(claudeHome); mkdirSync(codexHome);
  const env = { HOME: root, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  let clock = Date.parse('2026-10-16T01:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const open = (bootId: string, opts: WorkroomJournalOptions = {}) => {
    const journal = new WorkroomConversationJournal(root, now, bootId, { build: bootId === BOOT_A ? '700' : '701', pid: 4_000_000, alive: () => false, ...opts });
    closers.push(() => journal.close());
    return journal;
  };
  const saveClaude = (id: string) => { const dir = join(claudeHome, 'projects', claudeProjectSlugCandidates(cwd)[0]!); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'fixture only' } }) + '\n'); };
  const a = open(BOOT_A);
  const ids: string[] = [];
  for (const row of rows) {
    const agent = row.agent ?? 'claude';
    const summary = { id: randomUUID(), targetId: row.target ?? TARGET, agent, state: 'running' as const, createdAt: now(), exitCode: null, cols: 100, rows: 30, accountId: row.accountId ?? 'host-default' };
    const context: WorkroomSessionContext = { ...workroomSessionContext(summary, cwd, env, false, agent === 'claude' ? summary.id : undefined), ...(row.bypass ? { bypass: true } : {}) };
    let record = a.started(context);
    if (row.title) record = a.mutate(record.id, record.revision, 'rename-' + randomUUID(), 'rename', row.title);
    if (agent === 'claude' && row.save !== false) saveClaude(summary.id);
    ids.push(record.id);
    clock += 1_000;
  }
  a.close(); clock += 5_000;
  const b = open(BOOT_B);
  let launches = 0;
  const history = new WorkroomConversationService({
    appDataDir: root, journal: b, platform: options.platform ?? 'darwin', contexts: () => [], tickMs: 0,
    prepare: async record => workroomSessionContext({ id: record.sessionId, targetId: record.targetId, agent: record.agent, state: 'exited', createdAt: record.createdAt, exitCode: null, cols: 100, rows: 30, accountId: record.accountId }, cwd, env, false),
    assertNoWriter: async () => {},
    launch: async (record, _requestId, _cols, _rows, binding) => {
      const summary = { id: randomUUID(), targetId: record.targetId, agent: record.agent, state: 'running' as const, createdAt: now(), exitCode: null, cols: 100, rows: 30, accountId: record.accountId };
      const context = workroomSessionContext(summary, cwd, env, false, binding.resume.conversationId);
      await binding.validate(context); binding.launching(); launches++;
      b.started(context, binding.logicalConversationId); return { session: context.summary };
    },
  });
  closers.push(() => history.shutdown());
  const host = createRemoteWorkroomHistoryHost(history);
  return { root, journal: b, history, host, ids, launches: () => launches };
}
const map = (...pairs: [string, string][]) => new Map(pairs);
const access = (o: Partial<RemoteHistoryAccess> = {}): RemoteHistoryAccess => ({ canResume: true, accountSelect: false, allowed: () => true,
  targets: new Set([TARGET, OTHER]), controlIds: map([TARGET, CONTROL], [OTHER, CONTROL_OTHER]), ...o });
const ask = (f: ReturnType<typeof restartFixture>, action: string, history: Record<string, unknown> = {}, a: RemoteHistoryAccess = access(), owner = 'device:h:c') =>
  f.host({ action, history }, TARGET, owner, a);

describe('workroom-restart-v1 wire', () => {
  test('a separate feature name; two new history actions with read and resume scopes', () => {
    expect(WORKROOM_RESTART_REMOTE_FEATURE).toBe('workroom-restart-v1');
    expect(REMOTE_HISTORY_ACTIONS).toContain('history.restart');
    expect(REMOTE_HISTORY_ACTIONS).toContain('history.restart.dismiss');
    expect(isRemoteHistoryAction('history.restart')).toBe(true);
    expect(remoteHistoryScopeFor('history.restart')).toBe('history.read');
    expect(remoteHistoryScopeFor('history.restart.dismiss')).toBe('history.resume');
    // Every availability the Mac can answer has a phone name: an older phone never sees an unknown value.
    for (const value of WORKROOM_RESTART_AVAILABILITY) expect(REMOTE_RESTART_AVAILABILITY).toContain(value);
    expect(REMOTE_HISTORY_WHY).not.toContain('ready'); expect(REMOTE_HISTORY_WHY).not.toContain('check');
    expect(REMOTE_HISTORY_WHY).toContain('grant'); expect(REMOTE_HISTORY_WHY).toContain('account');
  });
  test('requests are strict: restart takes nothing, dismiss its three fields, list a literal detail flag', () => {
    const base = (action: string, history: unknown) => ({ operation: 'workspace', requestId: 'request-0001', targetId: 'control-0001', workspace: { action, history } });
    expect(normalizeMobileWorkspaceRequest(base('history.restart', {})).workspace.history).toEqual({});
    const dismiss = { offerId: randomUUID(), expectedRevision: 2, dismissRequestId: randomUUID() };
    expect(normalizeMobileWorkspaceRequest(base('history.restart.dismiss', dismiss)).workspace.history).toEqual(dismiss);
    expect(normalizeMobileWorkspaceRequest(base('history.list', { detail: true })).workspace.history).toEqual({ detail: true });
    for (const bad of [
      base('history.restart', { offerId: randomUUID() }), base('history.restart', undefined),
      base('history.restart.dismiss', { offerId: randomUUID(), expectedRevision: 2 }), base('history.restart.dismiss', { ...dismiss, conversationId: randomUUID() }),
      base('history.restart.dismiss', { ...dismiss, offerId: '../x' }), base('history.restart.dismiss', { ...dismiss, expectedRevision: 0 }),
      base('history.list', { detail: false }), base('history.list', { detail: 'yes' }),
    ]) expect(() => normalizeMobileWorkspaceRequest(bad)).toThrow();
  });
  test('an older Mac refuses `detail` and the restart actions, so the phone must ask only a Mac that advertises the feature', () => {
    expect(normalizeRemoteHistoryRequestV1('history.list', {})).toEqual({});
    expect(() => normalizeRemoteHistoryRequestV1('history.list', { detail: true })).toThrow();
    expect(() => normalizeRemoteHistoryRequestV1('history.restart', {})).toThrow();
    // The new normaliser still reads an old phone's list request unchanged.
    expect(normalizeRemoteHistoryRequest('history.list', {})).toEqual({});
  });
  test('restart results allow only the public row keys, a closed availability list and at most 64 rows', () => {
    const row = { id: randomUUID(), project: CONTROL, title: '대화', agent: 'claude' as const, availability: 'ready' as const, bypass: null, revision: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const offer = { offerId: randomUUID(), revision: 1, update: true, more: false, complete: true, closable: true, unlisted: 0, rows: [row] };
    expect(normalizeRemoteHistoryResult('history.restart', { restart: offer }).restart).toEqual(offer);
    expect(normalizeRemoteHistoryResult('history.restart', { restart: null }).restart).toBeNull();
    expect(normalizeRemoteHistoryResult('history.restart.dismiss', { restart: null }).restart).toBeNull();
    expect([...REMOTE_RESTART_ROW_KEYS].sort()).toEqual(['agent', 'availability', 'bypass', 'createdAt', 'id', 'project', 'revision', 'title', 'updatedAt']);
    // A count-only offer (no read grant) has no rows; rows and a count never travel together; closable is the Mac's word.
    const countOnly = { ...offer, complete: false, closable: false, unlisted: 3, rows: [] };
    expect(normalizeRemoteHistoryResult('history.restart', { restart: countOnly }).restart).toEqual(countOnly);
    for (const bad of [{ ...offer, unlisted: 1 }, { ...offer, rows: [] }, { ...offer, closable: 'yes' }, { ...offer, unlisted: -1 }, (({ closable: _c, ...rest }) => rest)(offer)])
      expect(() => normalizeRemoteHistoryResult('history.restart', { restart: bad })).toThrow();
    for (const key of ['targetId', 'sessionId', 'providerConversationId', 'accountId', 'accountLabel', 'cwd', 'storeInstanceId'])
      expect(() => normalizeRemoteHistoryResult('history.restart', { restart: { ...offer, rows: [{ ...row, [key]: 'x' }] } })).toThrow();
    for (const bad of [{ ...row, availability: 'maybe' }, { ...row, bypass: 'yes' }, { ...row, project: '/Users/x' }, { ...row, title: 'x'.repeat(97) }])
      expect(() => normalizeRemoteHistoryResult('history.restart', { restart: { ...offer, rows: [bad] } })).toThrow();
    expect(() => normalizeRemoteHistoryResult('history.restart', { restart: { ...offer, rows: Array.from({ length: 65 }, () => row) } })).toThrow();
    expect(() => normalizeRemoteHistoryResult('history.restart', { restart: { ...offer, storeInstanceId: 'x' } })).toThrow();
    expect(() => normalizeRemoteHistoryResult('history.restart', { restart: offer, records: [] })).toThrow();
    expect(normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'history.restart', history: { restart: offer } }).history?.restart).toEqual(offer);
  });
  test('a list row carries `why` only as a closed code (or null when it can be opened)', () => {
    const row = { id: randomUUID(), title: '대화', agent: 'claude' as const, state: 'detached' as const, resumable: false, updatedAt: new Date().toISOString(), revision: 2 };
    expect(normalizeRemoteHistoryResult('history.list', { records: [{ ...row, why: 'unsaved' }], nextBefore: null }).records![0]!.why).toBe('unsaved');
    expect(normalizeRemoteHistoryResult('history.list', { records: [{ ...row, resumable: true, why: null }], nextBefore: null }).records![0]!.why).toBeNull();
    expect(normalizeRemoteHistoryResult('history.list', { records: [row], nextBefore: null }).records![0]).toEqual(row);
    for (const why of ['ready', 'later', 1]) expect(() => normalizeRemoteHistoryResult('history.list', { records: [{ ...row, why }], nextBefore: null })).toThrow();
  });
});

describe('history.restart on the Mac', () => {
  test('rows only for this phone\'s projects, named by its own control ids; nothing host-only on the wire', async () => {
    const f = restartFixture([{ target: TARGET, bypass: true }, { target: TARGET, agent: 'hermes' }, { target: OTHER }]);
    const result = await ask(f, 'history.restart', {}, access({ targets: new Set([TARGET]), controlIds: map([TARGET, CONTROL]) }));
    const offer = result.restart!;
    expect(offer.rows.map(r => r.id).sort()).toEqual([f.ids[0]!, f.ids[1]!].sort());
    expect(offer.rows.every(r => r.project === CONTROL)).toBe(true);
    expect(offer.complete).toBe(false);
    expect(offer.update).toBe(true);
    expect(offer.rows.find(r => r.id === f.ids[0])).toMatchObject({ availability: 'ready', bypass: true });
    expect(offer.rows.find(r => r.id === f.ids[1])).toMatchObject({ availability: 'unsupported' });
    for (const r of offer.rows) expect(Object.keys(r).sort()).toEqual([...REMOTE_RESTART_ROW_KEYS].sort());
    const text = JSON.stringify(result);
    for (const secret of [f.root, TARGET, OTHER, f.ids[2]!, 'host-default', f.journal.get(f.ids[0]!).sessionId, f.history.storeId()]) expect(text.includes(secret)).toBe(false);
    expect(normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'history.restart', history: result }).history).toEqual(result);
    // The whole grant sees every row.
    const whole = (await ask(f, 'history.restart')).restart!;
    expect(whole.complete).toBe(true);
    expect(whole.rows.find(r => r.id === f.ids[2])?.project).toBe(CONTROL_OTHER);
  });
  test('a phone that may not see any of the rows gets no offer', async () => {
    const f = restartFixture([{ target: OTHER }]);
    expect((await ask(f, 'history.restart', {}, access({ targets: new Set([TARGET]), controlIds: map([TARGET, CONTROL]) }))).restart).toBeNull();
    // The Mac's own offer is untouched by that.
    expect((await f.history.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'restart.list' })).restart?.rows).toHaveLength(1);
  });
  test('long Korean titles are trimmed to the reply budget and say there is more', async () => {
    const title = '업데이트 전에 실행 중이던 아주 긴 워크룸 대화 제목'.padEnd(96, '가');
    const f = restartFixture(Array.from({ length: 24 }, () => ({ title })));
    const offer = (await ask(f, 'history.restart')).restart!;
    expect(offer.more).toBe(true);
    expect(offer.rows.length).toBeLessThan(24);
    expect(new TextEncoder().encode(JSON.stringify({ restart: offer })).length).toBeLessThanOrEqual(REMOTE_HISTORY_RESULT_BYTES);
    expect(() => normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'history.restart', history: { restart: offer } })).not.toThrow();
  });
  test('without the resume grant a row that could open says grant; another CLI account says account', async () => {
    const f = restartFixture([{ target: TARGET }, { target: TARGET, accountId: ACCOUNT }, { target: TARGET, agent: 'agy' }]);
    const read = (await ask(f, 'history.restart', {}, access({ canResume: false }))).restart!;
    expect(read.rows.find(r => r.id === f.ids[0])?.availability).toBe('grant');
    expect(read.rows.find(r => r.id === f.ids[2])?.availability).toBe('unsupported');
    const resume = (await ask(f, 'history.restart')).restart!;
    expect(resume.rows.find(r => r.id === f.ids[1])?.availability).toBe('account');
    expect(['ready', 'check']).toContain((await ask(f, 'history.restart', {}, access({ accountSelect: true }))).restart!.rows.find(r => r.id === f.ids[1])!.availability);
  });
  test('elsewhere than macOS there is no offer, as on the Mac', async () => {
    const f = restartFixture([{ target: TARGET }], { platform: 'win32' });
    expect((await ask(f, 'history.restart')).restart).toBeNull();
  });
});

describe('history.restart.dismiss on the Mac', () => {
  const dismissOf = (offer: { offerId: string; revision: number }, dismissRequestId = randomUUID()) => ({ offerId: offer.offerId, expectedRevision: offer.revision, dismissRequestId });
  test('needs the resume grant', async () => {
    const f = restartFixture([{ target: TARGET }]);
    const offer = (await ask(f, 'history.restart')).restart!;
    await expect(ask(f, 'history.restart.dismiss', dismissOf(offer), access({ canResume: false }))).rejects.toThrow('이어 열기');
    expect((await ask(f, 'history.restart')).restart?.offerId).toBe(offer.offerId);
  });
  test('a phone that cannot see every row may not close the offer for the Mac', async () => {
    const f = restartFixture([{ target: TARGET }, { target: OTHER }]);
    const partial = access({ targets: new Set([TARGET]), controlIds: map([TARGET, CONTROL]) });
    const offer = (await ask(f, 'history.restart', {}, partial)).restart!;
    expect(offer.complete).toBe(false);
    await expect(ask(f, 'history.restart.dismiss', dismissOf(offer), partial)).rejects.toThrow('Mac');
    expect((await f.history.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'restart.list' })).restart?.offerId).toBe(offer.offerId);
  });
  test('closes it for every window and phone; a replay is answered, never an error; the request id is the phone\'s own namespace', async () => {
    const f = restartFixture([{ target: TARGET }]);
    const offer = (await ask(f, 'history.restart')).restart!;
    const body = dismissOf(offer);
    expect((await ask(f, 'history.restart.dismiss', body)).restart).toBeNull();
    expect((await f.history.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'restart.list' })).restart).toBeNull();
    expect((await ask(f, 'history.restart.dismiss', body)).restart).toBeNull();
    const db = new Database(join(f.root, 'workroom-history-v1', 'history.sqlite'), { readonly: true });
    try {
      const stored = (db.query('SELECT dismiss_request,state FROM workroom_restart_offers').get() as { dismiss_request: string; state: string });
      expect(stored.state).toBe('dismissed');
      expect(stored.dismiss_request.startsWith('rh_')).toBe(true);
      expect(stored.dismiss_request).not.toBe(body.dismissRequestId);
    } finally { db.close(); }
    // The row stays in the history list whatever happens to the offer.
    expect((await ask(f, 'history.list')).records!.map(r => r.id)).toContain(f.ids[0]!);
  });
  test('an offer that is no longer the current one is answered with the current one and changes nothing', async () => {
    const f = restartFixture([{ target: TARGET }]);
    const offer = (await ask(f, 'history.restart')).restart!;
    const answered = await ask(f, 'history.restart.dismiss', { offerId: randomUUID(), expectedRevision: 1, dismissRequestId: randomUUID() });
    expect(answered.restart?.offerId).toBe(offer.offerId);
    expect((await ask(f, 'history.restart')).restart?.offerId).toBe(offer.offerId);
  });
});

describe('history.list detail', () => {
  test('a row says why it cannot be opened, only when asked', async () => {
    const f = restartFixture([{ target: TARGET }, { target: TARGET, agent: 'hermes' }, { target: TARGET, save: false }]);
    await ask(f, 'history.restart'); // the restart probes: the unsaved Claude row is known as such now
    const plain = (await ask(f, 'history.list')).records!;
    expect(plain.every(r => !('why' in r))).toBe(true);
    const detailed = (await ask(f, 'history.list', { detail: true })).records!;
    const why = (id: string) => detailed.find(r => r.id === id)!;
    expect(why(f.ids[0]!)).toMatchObject({ resumable: true, why: null });
    expect(why(f.ids[1]!)).toMatchObject({ resumable: false, why: 'unsupported' });
    expect(why(f.ids[2]!)).toMatchObject({ resumable: false, why: 'unsaved' });
    expect((await ask(f, 'history.list', { detail: true }, access({ canResume: false }))).records!.find(r => r.id === f.ids[0])).toMatchObject({ resumable: false, why: 'grant' });
    expect(normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'history.list', history: { records: detailed, nextBefore: null } }).history?.records).toEqual(detailed);
  });
});

describe('mobile gateway: restart permission boundary', () => {
  const gateway = (opts: { historyScopes?: string[]; targets?: string[] } = {}) => {
    const calls: { action: string; targetId: string; controlIds: [string, string][]; canRead?: boolean }[] = [];
    const g = createMobileWorkspaceGateway({
      terminal: async () => ({ sessions: [] }), active: () => true,
      resolve: async () => [{ controlId: CONTROL, runtimeTargetId: TARGET }, { controlId: CONTROL_OTHER, runtimeTargetId: OTHER }],
      consent: async () => ({ targetIds: new Set(opts.targets ?? [TARGET]), workspaceScopes: [], historyScopes: (opts.historyScopes ?? ['history.read', 'history.resume']) as any, isActive: () => true, requestOwner: 'device:h:c' }),
      perform: async () => { throw new Error('workspace perform must not run for history'); },
      history: async (request: any, targetId: string, _owner: string, a: any) => { calls.push({ action: request.workspace.action, targetId, controlIds: [...(a.controlIds ?? new Map()).entries()], ...(a.canRead === false ? { canRead: false } : {}) }); return { restart: null }; },
      forward: async () => { throw new Error('never forwarded'); }, opsRuntimeTargetId: () => TARGET,
    });
    return { g, calls };
  };
  const request = (action: string, history: unknown, targetId = CONTROL) => ({ operation: 'workspace' as const, requestId: 'request-' + randomUUID(), targetId, workspace: { action, history } as any });
  const dismiss = { offerId: randomUUID(), expectedRevision: 1, dismissRequestId: randomUUID() };
  test('the asking project only has to be one of this connection\'s; the host learns which projects the phone may see', async () => {
    const { g, calls } = gateway({ targets: [OTHER] });
    // The phone asks through a project it was shown but may not use: the offer is about all of its projects, not that one.
    expect((await g(request('history.restart', {}) as any, [], 'internet:x') as any).history).toEqual({ restart: null });
    expect(calls).toEqual([{ action: 'history.restart', targetId: TARGET, controlIds: [[OTHER, CONTROL_OTHER]] }]);
    await expect(g(request('history.restart', {}, 'control_' + 'X'.repeat(36)) as any, [], 'internet:x')).rejects.toThrow();
    // Other history actions still need the named project itself.
    await expect(g(request('history.list', {}) as any, [], 'internet:x')).rejects.toThrow('프로젝트 범위');
  });
  test('restart without the read grant is a count only; dismiss needs the resume grant; another device never relays them', async () => {
    const none = gateway({ historyScopes: [] });
    // Count only (w14 review): the host is asked with canRead false and answers how many, never which.
    expect((await none.g(request('history.restart', {}) as any, [], 'internet:x') as any).history).toEqual({ restart: null });
    expect(none.calls.map(c => c.action)).toEqual(['history.restart']); expect(none.calls[0]!.canRead).toBe(false);
    await expect(none.g(request('history.restart.dismiss', dismiss) as any, [], 'internet:x')).rejects.toThrow('대화 기록');
    expect(none.calls).toHaveLength(1);
    const readOnly = gateway({ historyScopes: ['history.read'] });
    expect((await readOnly.g(request('history.restart', {}) as any, [], 'internet:x') as any).history).toEqual({ restart: null });
    await expect(readOnly.g(request('history.restart.dismiss', dismiss) as any, [], 'internet:x')).rejects.toThrow('이어 열기');
    const { g, calls } = gateway();
    for (const [action, body] of [['history.restart', {}], ['history.restart.dismiss', dismiss]] as const)
      await expect(g(request(action, body) as any, [], 'internet:x', () => true, 'device-ref-0001')).rejects.toThrow('대화 기록');
    expect(calls).toEqual([]);
  });
});

describe('phone ↔ real Mac host', () => {
  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
  const transportFor = (f: ReturnType<typeof restartFixture>, a: RemoteHistoryAccess = access(), sent: string[] = []) => async (request: MobileWorkspaceRequest): Promise<MobileWorkspaceResult> => {
    normalizeMobileWorkspaceRequest(request);
    const { action, history } = request.workspace as { action: string; history: unknown };
    sent.push(action + ':' + request.targetId);
    const target = request.targetId === CONTROL ? TARGET : request.targetId === CONTROL_OTHER ? OTHER : 'unknown';
    return normalizeMobileWorkspaceResult({ kind: 'workspace', action: action as any, history: await f.host({ action, history }, target, 'device:h:c', a) });
  };
  test('the phone opens each offered conversation once, through its own project, and the offer goes away', async () => {
    const f = restartFixture([{ target: TARGET }, { target: OTHER }, { target: TARGET, agent: 'hermes' }]);
    const sent: string[] = [], storage = memory();
    const transport = transportFor(f, access(), sent);
    const offer = (await listRemoteRestart(transport, CONTROL))!;
    expect(offer.rows).toHaveLength(3);
    const result = await resumeRemoteRestartRows({ transport, storage, host: 'host-0123456789', pairing: 'pairing-0000001', rows: offer.rows, cols: 100, height: 30 });
    expect(result.opened.map(o => o.row.id).sort()).toEqual([f.ids[0]!, f.ids[1]!].sort());
    expect(result.stopped).toBeNull();
    expect(f.launches()).toBe(2);
    // Each row went through its own project; the Hermes row was never sent.
    expect(sent.filter(s => s.startsWith('history.resume.execute')).sort()).toEqual([`history.resume.execute:${CONTROL}`, `history.resume.execute:${CONTROL_OTHER}`].sort());
    expect(pendingRemoteHistoryResumes(storage, 'host-0123456789')).toEqual([]);
    // Nothing left to open: the next look finishes the offer, on the phone and on the Mac.
    expect(await listRemoteRestart(transport, CONTROL)).toBeNull();
    // A second press finds nothing and launches nothing.
    expect((await resumeRemoteRestartRows({ transport, storage, host: 'host-0123456789', pairing: 'pairing-0000001', rows: offer.rows, cols: 100, height: 30 })).opened).toEqual([]);
    expect(f.launches()).toBe(2);
  });
  test('dismiss from the phone, and the list with reasons for a phone that asks', async () => {
    const f = restartFixture([{ target: TARGET }]);
    const transport = transportFor(f);
    const offer = (await listRemoteRestart(transport, CONTROL))!;
    expect(await dismissRemoteRestart(transport, CONTROL, offer)).toBeNull();
    expect(await listRemoteRestart(transport, CONTROL)).toBeNull();
    const page = await listRemoteHistory(transport, CONTROL, undefined, true);
    expect(page.records[0]).toMatchObject({ id: f.ids[0], why: null, resumable: true });
  });
});
