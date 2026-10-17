import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkroomConversationJournal } from '../src/workroomConversationJournal';
import { WorkroomConversationService } from '../src/workroomConversationService';
import { workroomSessionContext } from '../src/workroomConversationIdentity';
import { claudeProjectSlugCandidates } from '../src/sessionTranscript';
import { normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult } from '../src/mobileWorkspaceProtocol';
import { createMobileWorkspaceGateway } from '../src/mobileWorkspaceGateway';
import {
  REMOTE_HISTORY_ACTIONS, REMOTE_HISTORY_ROW_KEYS, WORKROOM_HISTORY_REMOTE_FEATURE, normalizeHistoryScopes, normalizeRemoteHistoryResult,
  pendingRemoteHistoryResumes, savePendingRemoteHistoryResume, clearPendingRemoteHistoryResume, historyGrantFields, toggleHistoryScope,
  REMOTE_HISTORY_PENDING_PER_HOST,
} from '../src/workroomHistoryRemoteProtocol';
import { createRemoteWorkroomHistoryHost, type RemoteHistoryService } from '../src/workroomHistoryRemoteHost';
import { checkRemoteHistoryResume, listRemoteHistory, remoteHistoryOutcomeText, resumeRemoteHistory } from '../src/remoteWorkroomHistoryClient';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from '../src/mobileWorkspaceProtocol';

const directories: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TARGET = 'runtime-target-001', OTHER = 'runtime-target-002';
function fixture(options: { accountId?: string; launchFailure?: boolean; prepareFails?: () => boolean; prepareGate?: () => Promise<void> | undefined } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-history-remote-'))); directories.push(root);
  const cwd = join(root, 'project'), provider = join(root, '.claude'); mkdirSync(cwd); mkdirSync(provider);
  const env = { HOME: root, CLAUDE_CONFIG_DIR: provider };
  const make = (targetId: string) => {
    const summary = { id: randomUUID(), targetId, agent: 'claude' as const, state: 'running' as const, createdAt: new Date().toISOString(), exitCode: null, cols: 100, rows: 30, accountId: options.accountId ?? 'host-default' };
    return { summary, context: workroomSessionContext(summary, cwd, env, false, summary.id) };
  };
  const save = (id: string) => { const dir = join(provider, 'projects', claudeProjectSlugCandidates(cwd)[0]!); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'fixture only' } }) + '\n'); };
  const journal = new WorkroomConversationJournal(root);
  const mine = make(TARGET), theirs = make(OTHER);
  save(mine.summary.id); save(theirs.summary.id);
  const created = journal.started(mine.context); journal.observe({ ...mine.context, summary: { ...mine.summary, state: 'exited' } }, mine.summary.id);
  const foreign = journal.started(theirs.context); journal.observe({ ...theirs.context, summary: { ...theirs.summary, state: 'exited' } }, theirs.summary.id);
  let launches = 0;
  const launched: string[] = [];
  const service = new WorkroomConversationService({
    appDataDir: root, journal, platform: 'darwin', contexts: () => [],
    prepare: async record => {
      // Like `prepareHistoryContext`: a project folder that vanished throws Node's own ENOENT, which names the absolute path.
      if (options.prepareFails?.()) realpathSync(join(root, 'project-that-was-removed'));
      const gate = options.prepareGate?.(); if (gate) await gate;
      const c = record.targetId === TARGET ? mine : theirs; return { ...c.context, summary: { ...c.summary, state: 'exited' as const } };
    },
    assertNoWriter: async () => {},
    launch: async (_record, _requestId, _cols, _rows, binding) => {
      const context = { ...mine.context, summary: { ...mine.summary, id: randomUUID() } };
      await binding.validate(context); binding.launching(); launches++; launched.push(context.summary.id);
      if (options.launchFailure) throw new Error('fixture crash after spawn');
      journal.started(context, binding.logicalConversationId); return { session: context.summary };
    },
  });
  closers.push(() => service.shutdown());
  const host = createRemoteWorkroomHistoryHost(service);
  return { root, journal, service, host, created, foreign, launches: () => launches, launched };
}
const full = { canResume: true, accountSelect: false, allowed: () => true };

describe('remote history wire protocol', () => {
  test('history permissions are a separate strict list; resume needs read', () => {
    expect(WORKROOM_HISTORY_REMOTE_FEATURE).toBe('workroom-history-v1');
    expect(normalizeHistoryScopes(['history.read', 'history.resume'])).toEqual(['history.read', 'history.resume']);
    for (const bad of [['history.resume'], ['history.read', 'history.read'], ['records.read'], 'history.read', null]) expect(() => normalizeHistoryScopes(bad)).toThrow();
  });
  test('requests are strict per action and carry no paths, provider ids or extra keys', () => {
    const base = (action: string, history: unknown) => ({ operation: 'workspace', requestId: 'request-0001', targetId: 'control-0001', workspace: { action, history } });
    expect(normalizeMobileWorkspaceRequest(base('history.list', {})).workspace.action).toBe('history.list');
    expect(normalizeMobileWorkspaceRequest(base('history.list', { before: randomUUID() })).workspace.history?.before).toBeTruthy();
    const execute = { conversationId: randomUUID(), expectedRevision: 3, reviewId: randomUUID(), resumeRequestId: randomUUID(), cols: 100, rows: 30 };
    expect(normalizeMobileWorkspaceRequest(base('history.resume.execute', execute)).workspace.history).toEqual(execute);
    for (const bad of [
      base('history.list', { path: '/Users/x' }), base('history.list', undefined), base('history.list', { before: '../x' }),
      base('history.resume.review', { conversationId: randomUUID() }), base('history.resume.execute', { ...execute, bypassPermissions: true }),
      base('history.resume.execute', { ...execute, cols: 9999 }), base('history.resume.status', { requestId: randomUUID() }),
      { ...base('history.list', {}), workspace: { action: 'history.list', history: {}, sessionId: 'session-0001' } },
    ]) expect(() => normalizeMobileWorkspaceRequest(bad)).toThrow();
  });
  test('results allow only the public row keys and stay bounded', () => {
    const row = { id: randomUUID(), title: '대화', agent: 'claude', state: 'ended', resumable: true, updatedAt: new Date().toISOString(), revision: 2 };
    expect(normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'history.list', history: { records: [row], nextBefore: null } }).history?.records).toHaveLength(1);
    for (const key of ['targetId', 'sessionId', 'providerConversationId', 'accountId', 'accountLabel', 'cwd', 'storeInstanceId'])
      expect(() => normalizeRemoteHistoryResult('history.list', { records: [{ ...row, [key]: 'x' }], nextBefore: null })).toThrow();
    expect([...REMOTE_HISTORY_ROW_KEYS].sort()).toEqual(['agent', 'id', 'resumable', 'revision', 'state', 'title', 'updatedAt']);
    expect(() => normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'history.list', history: { records: [row] }, records: [] })).toThrow();
    expect(() => normalizeRemoteHistoryResult('history.resume.status', { resume: { state: 'completed', sessionId: 'x' } })).toThrow();
    expect(normalizeRemoteHistoryResult('history.resume.status', { resume: { state: 'unknown' } }).resume?.state).toBe('unknown');
  });
  test('a pending resume keeps only its identity, per Mac, so an unknown outcome is checked with status after a reload', () => {
    const map = new Map<string, string>(), storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
    const row = { host: 'host-0001', conversationId: randomUUID(), resumeRequestId: randomUUID() };
    savePendingRemoteHistoryResume(storage, row);
    expect(pendingRemoteHistoryResumes(storage, 'host-0001')).toEqual([row]);
    expect(pendingRemoteHistoryResumes(storage, 'host-0002')).toEqual([]);
    expect(() => savePendingRemoteHistoryResume(storage, { ...row, prompt: 'x' } as any)).toThrow();
    clearPendingRemoteHistoryResume(storage, row); expect(pendingRemoteHistoryResumes(storage, 'host-0001')).toEqual([]);
  });
});

describe('phone pending-resume storage', () => {
  const memoryStorage = () => { const map = new Map<string, string>(); return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };
  const V1 = 'agentstoz.remote.workroom-history.pending-resumes.v1', V2 = 'agentstoz.remote.workroom-history.pending-resumes.v2';
  const entry = (host = 'host-0001') => ({ host, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: 'control_' + randomUUID().replaceAll('-', ''), requestedAt: new Date().toISOString() });
  test('a pending resume remembers the project control id it was sent to and when — still no title, prompt or path', () => {
    const storage = memoryStorage(), row = entry();
    savePendingRemoteHistoryResume(storage, row);
    expect(pendingRemoteHistoryResumes(storage, 'host-0001')).toEqual([row]);
    for (const extra of [{ title: 'x' }, { prompt: 'x' }, { cwd: '/Users/x' }, { controlId: '../x' }, { requestedAt: 'yesterday' }])
      expect(() => savePendingRemoteHistoryResume(storage, { ...entry(), ...extra } as any)).toThrow();
  });
  test('rows of the previous release are still read and cleared, and new rows never touch their key', () => {
    const storage = memoryStorage(), legacy = { host: 'host-0001', conversationId: randomUUID(), resumeRequestId: randomUUID() };
    storage.setItem(V1, JSON.stringify([legacy]));
    const row = entry();
    savePendingRemoteHistoryResume(storage, row);
    // A page from before this change reads only V1: its list is exactly what it wrote, so it neither drops nor overwrites the new row.
    expect(JSON.parse(storage.getItem(V1)!)).toEqual([legacy]);
    expect(JSON.parse(storage.getItem(V2)!)).toEqual([row]);
    expect(pendingRemoteHistoryResumes(storage, 'host-0001')).toEqual([legacy, row]);
    clearPendingRemoteHistoryResume(storage, legacy);
    expect(pendingRemoteHistoryResumes(storage, 'host-0001')).toEqual([row]);
    expect(JSON.parse(storage.getItem(V1)!)).toEqual([]);
  });
  test('a second pending request for the same conversation is refused, never replaced', () => {
    const storage = memoryStorage(), first = entry();
    savePendingRemoteHistoryResume(storage, first);
    expect(() => savePendingRemoteHistoryResume(storage, { ...entry(), conversationId: first.conversationId })).toThrow('결과');
    expect(pendingRemoteHistoryResumes(storage, 'host-0001')).toEqual([first]);
  });
  test('the cap counts one Mac and its refusal points to the cleanup list; another Mac is not blocked by it', () => {
    const storage = memoryStorage();
    for (let i = 0; i < REMOTE_HISTORY_PENDING_PER_HOST; i++) savePendingRemoteHistoryResume(storage, entry('host-0001'));
    expect(() => savePendingRemoteHistoryResume(storage, entry('host-0001'))).toThrow('결과 확인이 필요한 요청');
    expect(() => savePendingRemoteHistoryResume(storage, entry('host-0002'))).not.toThrow();
    expect(pendingRemoteHistoryResumes(storage, 'host-0001')).toHaveLength(REMOTE_HISTORY_PENDING_PER_HOST);
  });
});

describe('mobile gateway: history permission boundary', () => {
  const gateway = (opts: { historyScopes?: string[]; targets?: string[]; active?: () => boolean; history?: boolean; workspaceScopes?: string[] } = {}) => {
    const calls: unknown[] = [];
    const g = createMobileWorkspaceGateway({
      terminal: async () => ({ sessions: [] }), active: () => true,
      resolve: async () => [{ controlId: 'control_1234', runtimeTargetId: TARGET }],
      consent: async () => ({ targetIds: new Set(opts.targets ?? [TARGET]), workspaceScopes: (opts.workspaceScopes ?? []) as any, historyScopes: opts.historyScopes as any, isActive: opts.active ?? (() => true), requestOwner: 'device:h:c' }),
      perform: async () => { throw new Error('workspace perform must not run for history'); },
      ...(opts.history === false ? {} : { history: async (request: any, targetId: string, owner: string, access: any) => { calls.push({ action: request.workspace.action, targetId, owner, canResume: access.canResume, accountSelect: access.accountSelect, ...(access.canRead === false ? { canRead: false } : {}) }); return request.workspace.action === 'history.list' ? { records: [], nextBefore: null } : request.workspace.action === 'history.restart' ? { restart: null } : { review: { id: 'review-0001', expiresAt: 1, available: false, reason: '확인', revision: 1 } }; } }),
      forward: async () => { calls.push('forward'); return { sessions: [] } as any; }, opsRuntimeTargetId: () => TARGET,
    });
    return { g, calls };
  };
  const request = (action: string, history: unknown = {}) => ({ operation: 'workspace' as const, requestId: 'request-' + randomUUID(), targetId: 'control_1234', workspace: { action, history } as any });
  test('every history action is refused without the new grant field; existing pairings get nothing', async () => {
    for (const historyScopes of [undefined, []]) {
      const { g, calls } = gateway({ historyScopes, workspaceScopes: ['records.read', 'memory.save', 'voice.use', 'account.select'] });
      // A well-formed body for each action (the restart offer of w14 included), so the refusal is the grant's, not the format's.
      const body = (action: string) => action === 'history.list' || action === 'history.restart' ? {} : action === 'history.resume.status' ? { resumeRequestId: randomUUID() }
        : action === 'history.restart.dismiss' ? { offerId: randomUUID(), expectedRevision: 1, dismissRequestId: randomUUID() }
        : { conversationId: randomUUID(), expectedRevision: 1, ...(action === 'history.resume.execute' ? { reviewId: randomUUID(), resumeRequestId: randomUUID(), cols: 100, rows: 30 } : {}) };
      for (const action of REMOTE_HISTORY_ACTIONS.filter(action => action !== 'history.restart')) await expect(g(request(action, body(action)) as any, [], 'internet:x')).rejects.toThrow('대화 기록');
      expect(calls).toEqual([]);
      // The one exception (w14 review): the restart offer, asked as a count only — no rows, no titles, nothing to resume —
      // so the phone can say which permission is missing instead of staying silent.
      await g(request('history.restart', {}) as any, [], 'internet:x');
      expect(calls).toEqual([{ action: 'history.restart', targetId: TARGET, owner: 'device:h:c', canResume: false, accountSelect: true, canRead: false }]);
    }
  });
  test('read does not imply resume; a project outside the grant and a revoked grant are refused', async () => {
    const review = { conversationId: randomUUID(), expectedRevision: 1 };
    const readOnly = gateway({ historyScopes: ['history.read'] });
    expect((await readOnly.g(request('history.list') as any, [], 'internet:x') as any).history).toEqual({ records: [], nextBefore: null });
    await expect(readOnly.g(request('history.resume.review', review) as any, [], 'internet:x')).rejects.toThrow('이어 열기');
    const outside = gateway({ historyScopes: ['history.read', 'history.resume'], targets: [OTHER] });
    await expect(outside.g(request('history.list') as any, [], 'internet:x')).rejects.toThrow();
    expect(outside.calls).toEqual([]);
    const revoked = gateway({ historyScopes: ['history.read', 'history.resume'], active: () => false });
    await expect(revoked.g(request('history.list') as any, [], 'internet:x')).rejects.toThrow();
    expect(revoked.calls).toEqual([]);
    const both = gateway({ historyScopes: ['history.read', 'history.resume'], workspaceScopes: ['account.select'] });
    await both.g(request('history.resume.review', review) as any, [], 'internet:x');
    expect(both.calls).toEqual([{ action: 'history.resume.review', targetId: TARGET, owner: 'device:h:c', canResume: true, accountSelect: true }]);
  });
  test('the host learns which projects this device may use, so a status can find the device\'s own receipt (host-only)', async () => {
    const seen: (string[] | undefined)[] = [];
    const g = createMobileWorkspaceGateway({
      terminal: async () => ({ sessions: [] }), active: () => true,
      resolve: async () => [{ controlId: 'control_1234', runtimeTargetId: TARGET }, { controlId: 'control_5678', runtimeTargetId: OTHER }],
      consent: async () => ({ targetIds: new Set([TARGET, OTHER]), workspaceScopes: [], historyScopes: ['history.read'], isActive: () => true, requestOwner: 'device:h:c' }),
      perform: async () => { throw new Error('unused'); },
      history: async (_request: any, _target: string, _owner: string, access: any) => { seen.push(access.targets ? [...access.targets].sort() : undefined); return { resume: { state: 'unknown' } }; },
    });
    const result = await g(request('history.resume.status', { resumeRequestId: randomUUID() }) as any, [], 'internet:x') as any;
    expect(result.history).toEqual({ resume: { state: 'unknown' } });
    expect(seen).toEqual([[TARGET, OTHER].sort()]);
    // The set stays on the Mac: the reply carries no project list.
    expect(Object.keys(result).sort()).toEqual(['action', 'history', 'kind']);
  });
  test('an old gateway configuration answers with an update notice, and another device never relays history', async () => {
    const old = gateway({ historyScopes: ['history.read'], history: false });
    await expect(old.g(request('history.list') as any, [], 'internet:x')).rejects.toThrow('업데이트');
    const { g, calls } = gateway({ historyScopes: ['history.read', 'history.resume'] });
    await expect(g(request('history.list') as any, [], 'internet:x', () => true, 'device-ref-0001')).rejects.toThrow('대화 기록');
    expect(calls).toEqual([]);
  });
});

describe('remote history host', () => {
  test('lists only the authorized project, with opaque ids and no provider ids, paths or account roots', async () => {
    const f = fixture();
    const result = await f.host(request('history.list', {}), TARGET, 'device:h:c', full);
    expect(result.records?.map(r => r.id)).toEqual([f.created.id]);
    const text = JSON.stringify(result);
    for (const secret of [f.root, f.created.sessionId, OTHER, f.foreign.id, 'host-default']) expect(text.includes(secret)).toBe(false);
    expect(result.records![0]!.resumable).toBe(true);
    expect(Object.keys(result.records![0]!).sort()).toEqual([...REMOTE_HISTORY_ROW_KEYS].sort());
    expect(normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'history.list', history: result }).history).toEqual(result);
    expect((await f.host(request('history.list', {}), TARGET, 'device:h:c', { ...full, canResume: false })).records![0]!.resumable).toBe(false);
    // Another project's conversation is not found, whatever the request names.
    await expect(f.host(request('history.resume.review', { conversationId: f.foreign.id, expectedRevision: f.journal.get(f.foreign.id).revision }), TARGET, 'device:h:c', full)).rejects.toThrow();
    await expect(f.host(request('history.list', { before: f.foreign.id }), TARGET, 'device:h:c', full)).rejects.toThrow();
  });
  test('a lost execute response is answered from the receipt: status and a replay launch nothing new', async () => {
    const f = fixture();
    const row = f.journal.get(f.created.id);
    const review = await f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', full);
    expect(review.review?.available).toBe(true);
    const execute = { conversationId: row.id, expectedRevision: review.review!.revision, reviewId: review.review!.id, resumeRequestId: randomUUID(), cols: 100, rows: 30 };
    const first = await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full); // response "lost" on the way back
    expect(first.resume?.state).toBe('completed');
    const status = await f.host(request('history.resume.status', { resumeRequestId: execute.resumeRequestId }), TARGET, 'device:h:c', full);
    expect(status.resume).toEqual({ state: 'completed', sessionId: f.launched[0]! });
    expect((await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full)).resume?.state).toBe('completed');
    expect(f.launches()).toBe(1);
    // The receipt belongs to this phone: another device naming the same id learns nothing.
    expect((await f.host(request('history.resume.status', { resumeRequestId: execute.resumeRequestId }), TARGET, 'device:h:other', full)).resume).toEqual({ state: 'not-recorded' });
  });
  test('an unknown outcome stays unknown and is never retried by itself', async () => {
    const f = fixture({ launchFailure: true });
    const row = f.journal.get(f.created.id);
    const review = await f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', full);
    const execute = { conversationId: row.id, expectedRevision: review.review!.revision, reviewId: review.review!.id, resumeRequestId: randomUUID(), cols: 100, rows: 30 };
    expect((await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full)).resume?.state).toBe('unknown');
    expect((await f.host(request('history.resume.status', { resumeRequestId: execute.resumeRequestId }), TARGET, 'device:h:c', full)).resume?.state).toBe('unknown');
    expect((await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full)).resume?.state).toBe('unknown');
    expect(f.launches()).toBe(1);
    expect((await f.host(request('history.list', {}), TARGET, 'device:h:c', full)).records![0]!.resumable).toBe(false);
  });
  test('the grant is re-checked at the launch boundary; a review cannot be used by another device', async () => {
    const f = fixture();
    const row = f.journal.get(f.created.id);
    const review = await f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', full);
    const execute = { conversationId: row.id, expectedRevision: review.review!.revision, reviewId: review.review!.id, resumeRequestId: randomUUID(), cols: 100, rows: 30 };
    await expect(f.host(request('history.resume.execute', execute), TARGET, 'device:h:other', full)).rejects.toThrow();
    let live = true;
    const revoking = { ...full, allowed: () => live };
    const second = await f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', revoking);
    live = false;
    await expect(f.host(request('history.resume.execute', { ...execute, reviewId: second.review!.id, expectedRevision: second.review!.revision }), TARGET, 'device:h:c', revoking)).rejects.toThrow();
    expect(f.launches()).toBe(0);
  });
  // The host's entry guard above runs before the service. These two reach the service itself: the grant stays live
  // for the first `n` checks and is revoked after that, so the refusal happens past the host guard.
  const revokedAfter = (n: number) => { let calls = 0; return { ...full, allowed: () => ++calls <= n, calls: () => calls }; };
  const reviewed = async (f: ReturnType<typeof fixture>) => {
    const row = f.journal.get(f.created.id);
    const review = await f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', full);
    return { conversationId: row.id, expectedRevision: review.review!.revision, reviewId: review.review!.id, resumeRequestId: randomUUID(), cols: 100, rows: 30 };
  };
  test('a grant revoked after the host guard is refused by the service before the receipt is reserved', async () => {
    const f = fixture();
    const execute = await reviewed(f);
    const access = revokedAfter(1); // host entry passes; the service's pre-receipt check is the first refusal
    await expect(f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', access)).rejects.toThrow('권한');
    expect(access.calls()).toBe(2);
    expect(f.launches()).toBe(0);
    expect((await f.host(request('history.resume.status', { resumeRequestId: execute.resumeRequestId }), TARGET, 'device:h:c', full)).resume).toEqual({ state: 'not-recorded' });
  });
  test('a grant revoked between the receipt and the spawn is refused inside the launch binding and recorded as rejected', async () => {
    const f = fixture();
    const execute = await reviewed(f);
    const access = revokedAfter(2); // host entry and service pre-receipt pass; binding.validate is the first refusal
    expect((await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', access)).resume).toEqual({ state: 'rejected' });
    expect(access.calls()).toBe(3);
    expect(f.launches()).toBe(0);
    expect((await f.host(request('history.resume.status', { resumeRequestId: execute.resumeRequestId }), TARGET, 'device:h:c', full)).resume).toEqual({ state: 'rejected' });
    // A replay of the same request is answered from the receipt and still launches nothing.
    expect((await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full)).resume).toEqual({ state: 'rejected' });
    expect(f.launches()).toBe(0);
  });
  test('a local error before the receipt reaches the phone as a fixed Korean message without the path; status says it never ran', async () => {
    let fail = false;
    const f = fixture({ prepareFails: () => fail });
    const execute = await reviewed(f);
    fail = true;
    const error = await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain(f.root);
    expect(error!.message).not.toMatch(/ENOENT|realpath|[\/\\]/);
    expect(error!.message).toMatch(/[가-힣]/);
    expect(f.launches()).toBe(0);
    expect((await f.host(request('history.resume.status', { resumeRequestId: execute.resumeRequestId }), TARGET, 'device:h:c', full)).resume).toEqual({ state: 'not-recorded' });
  });
  // H1: «not-recorded» makes the phone forget its only handle and say the conversation did not open. The host may say
  // it only when it can prove no receipt exists for this device and id; anything less is «unknown», which the phone keeps.
  const status = (f: ReturnType<typeof fixture>, resumeRequestId: string, targetId = TARGET, access: any = full, host = f.host) =>
    host(request('history.resume.status', { resumeRequestId }), targetId, 'device:h:c', access).then(r => r.resume);
  test('a receipt asked about through another project is unknown, unless that project is within the device grant', async () => {
    const f = fixture();
    const execute = await reviewed(f);
    expect((await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full)).resume?.state).toBe('completed');
    // The phone switched its project picker after the resume: the receipt exists, so «not recorded» would be false.
    expect(await status(f, execute.resumeRequestId, OTHER)).toEqual({ state: 'unknown' });
    expect(await status(f, execute.resumeRequestId, OTHER, { ...full, targets: new Set([OTHER]) })).toEqual({ state: 'unknown' });
    // The receipt's project is still granted to this device: its own receipt is answered as it is.
    expect(await status(f, execute.resumeRequestId, OTHER, { ...full, targets: new Set([OTHER, TARGET]) })).toEqual({ state: 'completed', sessionId: f.launched[0]! });
    expect(f.launches()).toBe(1);
  });
  test('a conversation the journal cannot read right now is unknown, never «not recorded»', async () => {
    const f = fixture();
    const execute = await reviewed(f);
    await f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full);
    // `record()` swallows journal errors and returns null; a receipt was there all along.
    const blind: RemoteHistoryService = {
      storeId: () => f.service.storeId(), listTarget: (t, b, l) => f.service.listTarget(t, b, l), record: () => null,
      resumeReceipt: id => f.service.resumeReceipt(id), perform: (v, o) => f.service.perform(v, o),
    };
    expect(await status(f, execute.resumeRequestId, TARGET, full, createRemoteWorkroomHistoryHost(blind))).toEqual({ state: 'unknown' });
  });
  test('a status read while the execute is still on its way to the receipt is unknown, then settles from the receipt', async () => {
    let blocking = false, release!: () => void, entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({ prepareGate: () => { if (!blocking) return; blocking = false; entered(); return new Promise<void>(resolve => { release = resolve; }); } });
    const execute = await reviewed(f);
    blocking = true;
    const running = f.host(request('history.resume.execute', execute), TARGET, 'device:h:c', full);
    await inside;
    // No receipt yet, but the request is running on this Mac: it may still open the conversation.
    expect(await status(f, execute.resumeRequestId)).toEqual({ state: 'unknown' });
    release();
    expect((await running).resume?.state).toBe('completed');
    expect(await status(f, execute.resumeRequestId)).toEqual({ state: 'completed', sessionId: f.launched[0]! });
    expect(f.launches()).toBe(1);
  });
  test('resume is refused without the resume permission or for another CLI account the phone may not select', async () => {
    const f = fixture({ accountId: 'acct_12345678-1234-4123-8123-123456789abc' });
    const row = f.journal.get(f.created.id);
    await expect(f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', { ...full, canResume: false })).rejects.toThrow('이어 열기');
    await expect(f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', full)).rejects.toThrow('계정');
    expect((await f.host(request('history.list', {}), TARGET, 'device:h:c', full)).records![0]!.resumable).toBe(false);
    expect((await f.host(request('history.resume.review', { conversationId: row.id, expectedRevision: row.revision }), TARGET, 'device:h:c', { ...full, accountSelect: true })).review?.available).toBe(true);
    expect(f.launches()).toBe(0);
  });
});
function request(action: string, history: Record<string, unknown>) {
  return { action, history } as any;
}

describe('Mac dialog grant helpers', () => {
  test('nothing is written for an unticked dialog, so the request body of an old grant flow is unchanged', () => {
    expect(historyGrantFields([])).toEqual({});
    expect(historyGrantFields(['history.read'])).toEqual({ historyScopes: ['history.read'] });
    expect(() => historyGrantFields(['history.resume'])).toThrow();
  });
  test('ticking resume also ticks read; unticking read also unticks resume', () => {
    expect(toggleHistoryScope([], 'history.resume', true)).toEqual(['history.read', 'history.resume']);
    expect(toggleHistoryScope(['history.read', 'history.resume'], 'history.read', false)).toEqual([]);
    expect(toggleHistoryScope(['history.read', 'history.resume'], 'history.resume', false)).toEqual(['history.read']);
    expect(toggleHistoryScope([], 'history.read', true)).toEqual(['history.read']);
  });
});

// Review F1: the Mac keeps receipts by the asking pairing (`device:<host>:<controller>`), and a new QR claim gives the
// phone a new controller id. The phone's pending row is kept by Mac only, so after it pairs again the real host answers
// «not-recorded» for a conversation it did open. The phone must not take that as proof.
describe('phone ↔ real Mac host: a resume sent over an earlier pairing', () => {
  const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };
  test('the phone keeps the request and does not say the conversation never opened; the sending pairing still reads the receipt', async () => {
    const f = fixture(), storage = memory(), HOST = 'host-0123456789', CONTROL = 'control_1234';
    let owner = 'device:h:internet:controller-one';
    const transport = async (sent: MobileWorkspaceRequest): Promise<MobileWorkspaceResult> => {
      const { action, history } = sent.workspace as { action: string; history: unknown };
      const result = await f.host({ action, history }, TARGET, owner, full);
      if (action === 'history.resume.execute') throw new Error('Mac이 아직 결과를 보내지 않았습니다.'); // the answer is lost
      return normalizeMobileWorkspaceResult({ kind: 'workspace', action: action as any, history: result });
    };
    const listed = (await listRemoteHistory(transport, CONTROL)).records[0]!;
    expect((await resumeRemoteHistory({ transport, storage, host: HOST, controlId: CONTROL, pairing: 'pairing-one-00001', row: listed, cols: 100, rows: 30 })).kind).toBe('unknown');
    expect(f.launches()).toBe(1);
    const pending = pendingRemoteHistoryResumes(storage, HOST)[0]!;
    // A new QR: the relay hands the phone a new controller id, so the Mac asks under another owner.
    owner = 'device:h:internet:controller-two';
    const outcome = await checkRemoteHistoryResume({ transport, storage, controlId: CONTROL, pairing: 'pairing-two-00002', pending });
    expect(outcome.kind).not.toBe('not-recorded');
    expect(remoteHistoryOutcomeText(outcome)).not.toContain('열리지 않았습니다');
    expect(pendingRemoteHistoryResumes(storage, HOST)).toHaveLength(1);
    // Through the pairing that sent it the Mac answers from its receipt, and nothing launched twice.
    owner = 'device:h:internet:controller-one';
    expect(await checkRemoteHistoryResume({ transport, storage, controlId: CONTROL, pairing: 'pairing-one-00001', pending })).toEqual({ kind: 'completed', sessionId: f.launched[0]! });
    expect(f.launches()).toBe(1);
  });
});
