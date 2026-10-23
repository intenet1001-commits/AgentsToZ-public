import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from '../src/mobileWorkspaceProtocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRemoteHistoryResume, listRemoteHistory, remoteHistoryOutcomeMessage, remoteHistoryOutcomeText, resumeRemoteHistory, resumedSessionEntry, selectResumedSessionOn } from '../src/remoteWorkroomHistoryClient';
import { REMOTE_HISTORY_PENDING_PER_HOST, pendingRemoteHistoryResumes, savePendingRemoteHistoryResume } from '../src/workroomHistoryRemoteProtocol';
import { REMOTE_HISTORY_DISMISS_WARNING, RemoteHistoryPendingList, RemoteWorkroomHistoryPanel, pendingResumeLabel, remoteHistoryRowLabels } from '../src/RemoteWorkroomHistoryPanel';
import { entryKeepsComposerDraft } from '../src/aiTerminalEntry';

const HOST = 'host-0123456789', CONTROL = 'control_1234';
// What the gateway answers for a control id outside the connection (src/mobileWorkspaceGateway.ts).
const GATEWAY_REFUSAL = 'Mac의 외부 인터넷 QR 원격제어에서 이 기기가 사용할 프로젝트 범위를 허용하세요.';
const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };
const row = { id: randomUUID(), title: '지난 대화', agent: 'claude' as const, state: 'ended' as const, resumable: true, updatedAt: new Date().toISOString(), revision: 3 };
function fakeMac(opts: { loseExecute?: boolean; outcome?: 'completed' | 'unknown' | 'rejected'; available?: boolean } = {}) {
  const sent: MobileWorkspaceRequest[] = []; let executions = 0; const receipts = new Map<string, string>();
  const transport = async (request: MobileWorkspaceRequest): Promise<MobileWorkspaceResult> => {
    sent.push(request);
    const { action, history } = request.workspace as any;
    expect(request.targetId).toBe(CONTROL);
    if (action === 'history.list') return { kind: 'workspace', action, history: { records: [row], nextBefore: null } };
    if (action === 'history.resume.review') return { kind: 'workspace', action, history: { review: { id: 'review-' + randomUUID(), expiresAt: Date.now() + 60_000, available: opts.available ?? true, reason: opts.available === false ? '실행 중인 대화입니다.' : '', revision: 4 } } };
    if (action === 'history.resume.execute') {
      if (!receipts.has(history.resumeRequestId)) { executions++; receipts.set(history.resumeRequestId, opts.outcome ?? 'completed'); }
      if (opts.loseExecute) throw new Error('Mac이 아직 결과를 보내지 않았습니다.');
      const state = receipts.get(history.resumeRequestId)!;
      return { kind: 'workspace', action, history: { resume: { state: state as any, ...(state === 'completed' ? { sessionId: 'session-0001' } : {}) } } };
    }
    if (action === 'history.resume.status') {
      const state = receipts.get(history.resumeRequestId) ?? 'not-recorded';
      return { kind: 'workspace', action, history: { resume: { state: state as any, ...(state === 'completed' ? { sessionId: 'session-0001' } : {}) } } };
    }
    throw new Error('unexpected ' + action);
  };
  return { transport, sent, executions: () => executions };
}

describe('phone history client', () => {
  test('same-minute saved conversations can be distinguished without showing opaque ids', () => {
    const at = new Date(2026, 9, 21, 0, 12, 5);
    const a = {...row, title:'Codex CLI 대화', updatedAt:at.toISOString()};
    const b = {...a, id:randomUUID(), updatedAt:new Date(at.getTime()+1000).toISOString()};
    const labels = remoteHistoryRowLabels([a,b]);
    expect(labels[0]).toEndWith('00:12:05');
    expect(labels[1]).toEndWith('00:12:06');
    expect(new Set(labels).size).toBe(2);
    const ties = remoteHistoryRowLabels([a,{...a,id:b.id}]);
    expect(ties[0]).toEndWith('대화 1'); expect(ties[1]).toEndWith('대화 2');
    expect(ties.join(' ')).not.toContain(a.id); expect(ties.join(' ')).not.toContain(b.id);
    expect(remoteHistoryRowLabels([a])[0]).toEndWith('00:12');
  });
  test('list sends one history.list for the chosen project', async () => {
    const mac = fakeMac();
    const page = await listRemoteHistory(mac.transport, CONTROL);
    expect(page.records).toEqual([row]);
    expect(mac.sent.map(r => (r.workspace as any).action)).toEqual(['history.list']);
  });
  test('a lost execute response leaves only a status check — never a second execute', async () => {
    const mac = fakeMac({ loseExecute: true }), storage = memory();
    const outcome = await resumeRemoteHistory({ transport: mac.transport, storage, host: HOST, controlId: CONTROL, row, cols: 100, rows: 30 });
    expect(outcome.kind).toBe('unknown');
    expect(mac.executions()).toBe(1);
    const pending = pendingRemoteHistoryResumes(storage, HOST);
    expect(pending).toHaveLength(1);
    // A reload keeps only the identity; the follow-up asks status, and the host answers from its receipt.
    const checked = await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: CONTROL, pending: pending[0]! });
    expect(checked).toEqual({ kind: 'completed', sessionId: 'session-0001' });
    expect(mac.sent.map(r => (r.workspace as any).action)).toEqual(['history.resume.review', 'history.resume.execute', 'history.resume.status']);
    expect(mac.executions()).toBe(1);
    expect(pendingRemoteHistoryResumes(storage, HOST)).toEqual([]);
  });
  test('an unknown outcome stays pending; status keeps saying unknown and nothing re-executes', async () => {
    const mac = fakeMac({ outcome: 'unknown' }), storage = memory();
    expect((await resumeRemoteHistory({ transport: mac.transport, storage, host: HOST, controlId: CONTROL, row, cols: 100, rows: 30 })).kind).toBe('unknown');
    const pending = pendingRemoteHistoryResumes(storage, HOST)[0]!;
    expect((await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: CONTROL, pending })).kind).toBe('unknown');
    expect(pendingRemoteHistoryResumes(storage, HOST)).toHaveLength(1);
    expect(mac.executions()).toBe(1);
  });
  test('an unavailable review never executes', async () => {
    const mac = fakeMac({ available: false }), storage = memory();
    expect(await resumeRemoteHistory({ transport: mac.transport, storage, host: HOST, controlId: CONTROL, row, cols: 100, rows: 30 })).toEqual({ kind: 'unavailable', reason: '실행 중인 대화입니다.' });
    expect(mac.executions()).toBe(0);
    expect(pendingRemoteHistoryResumes(storage, HOST)).toEqual([]);
  });
  test('without a place to remember the request, the phone refuses to execute', async () => {
    const mac = fakeMac();
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    await expect(resumeRemoteHistory({ transport: mac.transport, storage: broken, host: HOST, controlId: CONTROL, row, cols: 100, rows: 30 })).rejects.toThrow();
    expect(mac.executions()).toBe(0);
  });
});

describe('phone history client: the status asks the right project', () => {
  const OTHER = 'control_5678';
  function recordingMac(opts: { refuse?: string[] } = {}) {
    const sent: MobileWorkspaceRequest[] = [];
    const transport = async (request: MobileWorkspaceRequest): Promise<MobileWorkspaceResult> => {
      sent.push(request);
      if (opts.refuse?.includes(request.targetId)) throw new Error(GATEWAY_REFUSAL);
      const { action } = request.workspace as any;
      if (action === 'history.resume.review') return { kind: 'workspace', action, history: { review: { id: 'review-' + randomUUID(), expiresAt: Date.now() + 60_000, available: true, reason: '', revision: 4 } } };
      if (action === 'history.resume.execute') throw new Error('Mac이 아직 결과를 보내지 않았습니다.');
      if (action === 'history.resume.status') return { kind: 'workspace', action, history: { resume: { state: 'unknown' } } };
      throw new Error('unexpected ' + action);
    };
    return { transport, sent };
  }
  test('the pending request remembers its project, and the status goes there even after the picker moved', async () => {
    const mac = recordingMac(), storage = memory();
    expect((await resumeRemoteHistory({ transport: mac.transport, storage, host: HOST, controlId: CONTROL, row, cols: 100, rows: 30 })).kind).toBe('unknown');
    const pending = pendingRemoteHistoryResumes(storage, HOST)[0]!;
    expect(pending.controlId).toBe(CONTROL);
    expect(Number.isFinite(Date.parse(pending.requestedAt!))).toBe(true);
    await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: OTHER, pending });
    expect(mac.sent.at(-1)!.targetId).toBe(CONTROL);
  });
  test('a project control id this connection no longer has falls back to a current project', async () => {
    // Like the gateway: a control id outside this connection is refused, and only then is a current project asked.
    const mac = recordingMac({ refuse: ['control_reissued'] }), storage = memory();
    const pending = { host: HOST, conversationId: row.id, resumeRequestId: randomUUID(), controlId: 'control_reissued', requestedAt: new Date().toISOString() };
    await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: OTHER, pending });
    expect(mac.sent.map(r => r.targetId)).toEqual(['control_reissued', OTHER]);
  });
  test('when this Mac already holds the maximum of unsettled requests, the phone refuses before asking anything', async () => {
    const mac = recordingMac(), storage = memory();
    for (let i = 0; i < REMOTE_HISTORY_PENDING_PER_HOST; i++) savePendingRemoteHistoryResume(storage, { host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: CONTROL, requestedAt: new Date().toISOString() });
    await expect(resumeRemoteHistory({ transport: mac.transport, storage, host: HOST, controlId: CONTROL, row, cols: 100, rows: 30 })).rejects.toThrow('결과 확인이 필요한 요청');
    expect(mac.sent).toEqual([]);
  });
});

describe('phone history panel', () => {
  test('an old Mac (no workroom-history-v1) renders nothing — no error, no button', () => {
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: false, visible: true, online: true, host: HOST, projects: [{ targetId: CONTROL, label: 'A' }], transport: fakeMac().transport }));
    expect(html).toBe('');
  });
  test('a supporting Mac shows a folded history entry', () => {
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: true, visible: true, online: true, host: HOST, projects: [{ targetId: CONTROL, label: 'A' }], transport: fakeMac().transport }));
    expect(html).toContain('data-testid="remote-workroom-history"');
    expect(html).toContain('대화 기록');
  });
});

describe('phone history panel: unsettled requests (H3)', () => {
  const at = '2026-10-16T01:02:03.000Z';
  const pendingRow = (over: Record<string, unknown> = {}) => ({ host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: CONTROL, requestedAt: at, ...over });
  const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1;
  test('every unsettled request of this Mac is listed with a status check and a dismiss — also those whose conversation is not on screen', () => {
    const storage = memory();
    const elsewhere = pendingRow({ controlId: 'control_gone' }), mine = pendingRow();
    savePendingRemoteHistoryResume(storage, mine); savePendingRemoteHistoryResume(storage, elsewhere);
    savePendingRemoteHistoryResume(storage, pendingRow({ host: 'host-another-mac' }));
    // The history list itself is not loaded: the unsettled requests still show, read straight from this phone.
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: true, visible: true, online: true, host: HOST, projects: [{ targetId: CONTROL, label: '블로그' }], transport: fakeMac().transport, storage }));
    expect(html).toContain('data-testid="remote-workroom-history-pending"');
    expect(html).toContain('결과 확인이 필요한 요청');
    expect(count(html, 'remote-workroom-history-pending-row')).toBe(2);
    expect(count(html, 'remote-workroom-history-pending-check')).toBe(2);
    expect(count(html, 'remote-workroom-history-pending-dismiss')).toBe(2);
    // Nothing is dismissed without the confirmation step.
    expect(count(html, 'remote-workroom-history-pending-dismiss-confirm')).toBe(0);
  });
  test('the dismiss asks first and says the Mac may already have opened that conversation', () => {
    const entry = pendingRow();
    const props = { entries: [entry], rows: null, projects: [{ targetId: CONTROL, label: '블로그' }], busy: false, online: true, canCheck: true,
      onCheck: () => {}, onAskDismiss: () => {}, onDismiss: () => {}, onCancelDismiss: () => {} };
    const asking = renderToStaticMarkup(createElement(RemoteHistoryPendingList, { ...props, confirming: entry.resumeRequestId }));
    expect(asking).toContain('data-testid="remote-workroom-history-pending-dismiss-confirm"');
    expect(asking).toContain(REMOTE_HISTORY_DISMISS_WARNING);
    expect(REMOTE_HISTORY_DISMISS_WARNING).toContain('이미');
    expect(REMOTE_HISTORY_DISMISS_WARNING).toContain('열었을 수 있습니다');
    const idle = renderToStaticMarkup(createElement(RemoteHistoryPendingList, { ...props, confirming: null }));
    expect(idle).not.toContain(REMOTE_HISTORY_DISMISS_WARNING);
  });
  test('a full list says new resumes wait for this cleanup', () => {
    const storage = memory();
    for (let i = 0; i < REMOTE_HISTORY_PENDING_PER_HOST; i++) savePendingRemoteHistoryResume(storage, pendingRow());
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: true, visible: true, online: true, host: HOST, projects: [{ targetId: CONTROL, label: '블로그' }], transport: fakeMac().transport, storage }));
    expect(html).toContain('data-testid="remote-workroom-history-pending-full"');
  });
  test('labels: a loaded conversation by its title, else the project it was sent to, else a plain note — never an id', () => {
    const projects = [{ targetId: CONTROL, label: '블로그' }];
    const shown = pendingRow({ conversationId: row.id });
    expect(pendingResumeLabel(shown, [row], projects)).toContain('지난 대화');
    const notLoaded = pendingRow();
    expect(pendingResumeLabel(notLoaded, [row], projects)).toContain('블로그');
    const gone = pendingRow({ controlId: 'control_gone' });
    const legacy = { host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID() };
    for (const entry of [gone, legacy]) {
      const label = pendingResumeLabel(entry, null, projects);
      expect(label).toMatch(/[가-힣]/);
      expect(label).not.toContain(entry.conversationId);
      expect(label).not.toContain(entry.resumeRequestId);
    }
  });
});

describe('phone history panel: the resumed session is selected (H5)', () => {
  test('a completed resume selects the returned session when the Workroom lists it', async () => {
    const asked: string[] = [];
    const message = await remoteHistoryOutcomeMessage({ kind: 'completed', sessionId: 'session-0001' }, async id => { asked.push(id); return true; });
    expect(asked).toEqual(['session-0001']);
    expect(message).toContain('골랐습니다');
  });
  test('a session the list does not hold (or a failed lookup) falls back to telling the person to pick it', async () => {
    for (const select of [async () => false, async () => { throw new Error('/Users/x 실패'); }]) {
      const message = await remoteHistoryOutcomeMessage({ kind: 'completed', sessionId: 'session-0001' }, select);
      expect(message).toContain('세션 목록에서 선택하세요');
      expect(message).not.toContain('/Users');
    }
    let called = false;
    expect(await remoteHistoryOutcomeMessage({ kind: 'completed' }, async () => { called = true; return true; })).toContain('세션 목록에서 선택하세요');
    expect(called).toBe(false);
    expect(await remoteHistoryOutcomeMessage({ kind: 'unknown' })).toContain('결과 확인');
  });
  test('the Workroom entry is built from the phone\'s own session list — control ids, never the Mac\'s runtime id', () => {
    const sessions = [
      { id: 'session-0001', targetId: CONTROL, agent: 'claude' as const, state: 'running' as const, createdAt: '', exitCode: null, cols: 100, rows: 30 },
      { id: 'session-0002', targetId: 'control_5678', agent: 'codex' as const, state: 'running' as const, createdAt: '', exitCode: null, cols: 100, rows: 30 },
    ];
    expect(resumedSessionEntry(sessions, 'session-0001')).toEqual({ targetId: CONTROL, sessionId: 'session-0001', agent: 'claude' });
    expect(resumedSessionEntry(sessions, 'session-9999')).toBeNull();
  });
  // Integration review w4 (finding 2): a resume or check started on Mac A can finish after the phone switched to Mac B.
  // Its session belongs to A's Workroom; applied to B's (a global entry), B's project, AI and selection were overwritten.
  describe('selecting the resumed session only on the Mac it was resumed on', () => {
    const sessions = [{ id: 'session-0001', targetId: CONTROL, agent: 'claude' as const }];
    test('the same Mac still shown: listed, selected', async () => {
      const applied: unknown[] = []; let lists = 0;
      const selected = await selectResumedSessionOn({ hostId: HOST, currentHostId: () => HOST, sessionId: 'session-0001',
        list: async () => { lists++; return sessions; }, apply: entry => applied.push(entry) });
      expect(selected).toBe(true); expect(lists).toBe(1);
      expect(applied).toEqual([{ targetId: CONTROL, sessionId: 'session-0001', agent: 'claude' }]);
    });
    test('the phone switched Macs while the list was on its way: nothing applied, the person is told to pick it', async () => {
      const applied: unknown[] = []; let current = HOST;
      const selected = await selectResumedSessionOn({ hostId: HOST, currentHostId: () => current, sessionId: 'session-0001',
        list: async () => { current = 'host-other-mac-01'; return sessions; }, apply: entry => applied.push(entry) });
      expect(selected).toBe(false); expect(applied).toEqual([]);
    });
    test('already switched when the result came back: the old Mac is not even listed', async () => {
      const applied: unknown[] = []; let lists = 0;
      const selected = await selectResumedSessionOn({ hostId: HOST, currentHostId: () => 'host-other-mac-01', sessionId: 'session-0001',
        list: async () => { lists++; return sessions; }, apply: entry => applied.push(entry) });
      expect(selected).toBe(false); expect(lists).toBe(0); expect(applied).toEqual([]);
    });
    test('no Mac or a session the list does not hold: nothing applied', async () => {
      const applied: unknown[] = [];
      expect(await selectResumedSessionOn({ hostId: null, currentHostId: () => null, sessionId: 'session-0001', list: async () => sessions, apply: entry => applied.push(entry) })).toBe(false);
      expect(await selectResumedSessionOn({ hostId: HOST, currentHostId: () => HOST, sessionId: 'session-9999', list: async () => sessions, apply: entry => applied.push(entry) })).toBe(false);
      expect(applied).toEqual([]);
    });
    test('the portal selects through it with the Mac the callback was made for', () => {
      const portal = readFileSync(join(import.meta.dir, '..', 'src', 'remote-control-portal-main.tsx'), 'utf8');
      const start = portal.indexOf('const selectResumedSession='), end = portal.indexOf('\n  const ', start + 1);
      expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
      const body = portal.slice(start, end);
      expect(body).toContain('selectResumedSessionOn(');
      expect(body).toContain('currentHostId:()=>selectedHostIdRef.current');
      expect(body).toContain('hostId:selectedHostId');
      expect(body).not.toContain('resumedSessionEntry(');
    });
  });
  test('selecting the resumed session keeps a draft the person is writing in the new-task composer', () => {
    const select = { nonce: 1, targetId: CONTROL, sessionId: 'session-0001', keepDraft: true };
    expect(entryKeepsComposerDraft(select, '작성 중인 요청', '')).toBe(true);
    expect(entryKeepsComposerDraft(select, '', '제목만')).toBe(true);
    // Nothing to keep: the entry applies as before.
    expect(entryKeepsComposerDraft(select, '  ', '')).toBe(false);
    // Only entries that ask for it; an entry carrying its own prompt or no session applies as before.
    expect(entryKeepsComposerDraft({ ...select, keepDraft: undefined }, '작성 중인 요청', '')).toBe(false);
    expect(entryKeepsComposerDraft({ ...select, prompt: '새 요청' }, '작성 중인 요청', '')).toBe(false);
    expect(entryKeepsComposerDraft({ ...select, sessionId: undefined }, '작성 중인 요청', '')).toBe(false);
  });
});

// Review of the H1–H5 follow-ups. «not-recorded» lets the phone drop its only handle and say the conversation never
// opened; the Mac can only say it for the pairing and the project it was asked through.
describe('phone history client: «not recorded» is believed only for the pairing and project the request used (review)', () => {
  const OTHER = 'control_5678', FIRST = 'pairing-first-0001', SECOND = 'pairing-second-002';
  // A Mac that keeps receipts by the asking pairing (its owner) and the request id, like the real host.
  function pairedMac(opts: { refuse?: string[]; status?: 'not-recorded' | 'completed' } = {}) {
    const sent: MobileWorkspaceRequest[] = [];
    let pairing = FIRST; const receipts = new Set<string>();
    const transport = async (request: MobileWorkspaceRequest): Promise<MobileWorkspaceResult> => {
      sent.push(request);
      if (opts.refuse?.includes(request.targetId)) throw new Error(GATEWAY_REFUSAL);
      const { action, history } = request.workspace as any;
      if (action === 'history.resume.review') return { kind: 'workspace', action, history: { review: { id: 'review-' + randomUUID(), expiresAt: Date.now() + 60_000, available: true, reason: '', revision: 4 } } };
      if (action === 'history.resume.execute') { receipts.add(pairing + '\0' + history.resumeRequestId); throw new Error('Mac이 아직 결과를 보내지 않았습니다.'); }
      if (action === 'history.resume.status') {
        const state = opts.status ?? (receipts.has(pairing + '\0' + history.resumeRequestId) ? 'completed' : 'not-recorded');
        return { kind: 'workspace', action, history: { resume: { state, ...(state === 'completed' ? { sessionId: 'session-0001' } : {}) } } };
      }
      throw new Error('unexpected ' + action);
    };
    return { transport, sent, repair: (next: string) => { pairing = next; } };
  }
  test('the pending request remembers the pairing it was sent over', async () => {
    const mac = pairedMac(), storage = memory();
    await resumeRemoteHistory({ transport: mac.transport, storage, host: HOST, controlId: CONTROL, pairing: FIRST, row, cols: 100, rows: 30 });
    expect(pendingRemoteHistoryResumes(storage, HOST)[0]!.pairing).toBe(FIRST);
  });
  test('after the phone pairs again, «not recorded» is not proof: the request stays and the phone does not say it never opened', async () => {
    const mac = pairedMac(), storage = memory();
    expect((await resumeRemoteHistory({ transport: mac.transport, storage, host: HOST, controlId: CONTROL, pairing: FIRST, row, cols: 100, rows: 30 })).kind).toBe('unknown');
    mac.repair(SECOND);
    const pending = pendingRemoteHistoryResumes(storage, HOST)[0]!;
    const outcome = await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: CONTROL, pairing: SECOND, pending });
    expect(outcome).toEqual({ kind: 'unproven', earlierConnection: true });
    expect(remoteHistoryOutcomeText(outcome)).not.toContain('열리지 않았습니다');
    expect(remoteHistoryOutcomeText(outcome)).toContain('이전 연결');
    expect(pendingRemoteHistoryResumes(storage, HOST)).toHaveLength(1);
  });
  test('the same pairing and project: «not recorded» still settles the request', async () => {
    const storage = memory(), mac = pairedMac({ status: 'not-recorded' });
    const pending = { host: HOST, conversationId: row.id, resumeRequestId: randomUUID(), controlId: CONTROL, pairing: FIRST, requestedAt: new Date().toISOString() };
    savePendingRemoteHistoryResume(storage, pending);
    expect(await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: CONTROL, pairing: FIRST, pending })).toEqual({ kind: 'not-recorded' });
    expect(pendingRemoteHistoryResumes(storage, HOST)).toEqual([]);
  });
  test('a row without a pairing (first release) or a phone that cannot name its pairing: «not recorded» is not proof', async () => {
    for (const [entry, pairing] of [
      [{ host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID() }, FIRST],
      [{ host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: CONTROL, pairing: FIRST }, null],
    ] as const) {
      const storage = memory(), mac = pairedMac({ status: 'not-recorded' });
      savePendingRemoteHistoryResume(storage, entry);
      expect(await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: CONTROL, pairing, pending: entry })).toEqual({ kind: 'unproven', earlierConnection: false });
      expect(pendingRemoteHistoryResumes(storage, HOST)).toHaveLength(1);
    }
  });
  test('the status asks the project the request was sent to, even when the loaded project page does not list it', async () => {
    const mac = pairedMac(), storage = memory();
    const pending = { host: HOST, conversationId: row.id, resumeRequestId: randomUUID(), controlId: 'control_on_page_2', pairing: FIRST, requestedAt: new Date().toISOString() };
    // What the panel used to pass: the page of projects it had loaded.
    const loadedPage = { controlIds: [OTHER] } as {};
    await checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: OTHER, pairing: FIRST, pending, ...loadedPage });
    expect(mac.sent.map(r => r.targetId)).toEqual(['control_on_page_2']);
  });
  test('when the Mac refuses that project, a current project is asked once; its «not recorded» proves nothing, its receipt does', async () => {
    const pending = { host: HOST, conversationId: row.id, resumeRequestId: randomUUID(), controlId: 'control_gone', pairing: FIRST, requestedAt: new Date().toISOString() };
    const refused = pairedMac({ refuse: ['control_gone'], status: 'not-recorded' }), storage = memory();
    savePendingRemoteHistoryResume(storage, pending);
    expect(await checkRemoteHistoryResume({ transport: refused.transport, storage, controlId: OTHER, pairing: FIRST, pending })).toEqual({ kind: 'unproven', earlierConnection: false });
    expect(refused.sent.map(r => r.targetId)).toEqual(['control_gone', OTHER]);
    expect(pendingRemoteHistoryResumes(storage, HOST)).toHaveLength(1);
    const answered = pairedMac({ refuse: ['control_gone'], status: 'completed' });
    expect(await checkRemoteHistoryResume({ transport: answered.transport, storage, controlId: OTHER, pairing: FIRST, pending })).toEqual({ kind: 'completed', sessionId: 'session-0001' });
    expect(pendingRemoteHistoryResumes(storage, HOST)).toEqual([]);
  });
  test('when both are refused, the first refusal is reported and the request stays', async () => {
    const storage = memory(), mac = pairedMac({ refuse: ['control_gone', OTHER] });
    const pending = { host: HOST, conversationId: row.id, resumeRequestId: randomUUID(), controlId: 'control_gone', pairing: FIRST, requestedAt: new Date().toISOString() };
    savePendingRemoteHistoryResume(storage, pending);
    await expect(checkRemoteHistoryResume({ transport: mac.transport, storage, controlId: OTHER, pairing: FIRST, pending })).rejects.toThrow(GATEWAY_REFUSAL);
    expect(pendingRemoteHistoryResumes(storage, HOST)).toHaveLength(1);
  });
  test('the panel offers only the dismiss for a request sent over an earlier pairing — a status check cannot reach it', () => {
    const storage = memory();
    savePendingRemoteHistoryResume(storage, { host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: CONTROL, pairing: FIRST, requestedAt: new Date().toISOString() });
    savePendingRemoteHistoryResume(storage, { host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: CONTROL, pairing: SECOND, requestedAt: new Date().toISOString() });
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: true, visible: true, online: true, host: HOST, pairing: SECOND, projects: [{ targetId: CONTROL, label: '블로그' }], transport: fakeMac().transport, storage }));
    const count = (id: string) => html.split(`data-testid="${id}"`).length - 1;
    expect(count('remote-workroom-history-pending-row')).toBe(2);
    expect(count('remote-workroom-history-pending-check')).toBe(1);
    expect(count('remote-workroom-history-pending-earlier')).toBe(1);
    expect(count('remote-workroom-history-pending-dismiss')).toBe(2);
  });
});

// The overall cap counts every Mac's unsettled requests, so one this phone no longer holds must still be reachable.
describe('phone history panel: requests of a Mac this phone no longer holds (review)', () => {
  const GONE = 'host-forgotten-01', ELSEWHERE = 'host-elsewhere-02';
  const at = new Date().toISOString();
  const fill = (storage: ReturnType<typeof memory>, host: string, n: number) => {
    for (let i = 0; i < n; i++) savePendingRemoteHistoryResume(storage, { host, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: CONTROL, requestedAt: at });
  };
  test('they are listed in any Mac\'s history for a confirmed dismiss — never a status check', () => {
    const storage = memory();
    fill(storage, HOST, 1); fill(storage, GONE, 2); fill(storage, ELSEWHERE, 1);
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: true, visible: true, online: true, host: HOST, knownHosts: [HOST, ELSEWHERE], projects: [{ targetId: CONTROL, label: '블로그' }], transport: fakeMac().transport, storage }));
    const count = (id: string) => html.split(`data-testid="${id}"`).length - 1;
    expect(html).toContain('data-testid="remote-workroom-history-orphans"');
    expect(count('remote-workroom-history-orphan-row')).toBe(2);
    // This Mac's own row keeps its check; the forgotten Mac's rows can only be dismissed, after the warning.
    expect(count('remote-workroom-history-pending-check')).toBe(1);
    expect(count('remote-workroom-history-pending-dismiss')).toBe(3);
    expect(count('remote-workroom-history-pending-dismiss-confirm')).toBe(0);
  });
  test('without the list of held Macs the panel shows none (no false «not connected»)', () => {
    const storage = memory();
    fill(storage, GONE, 1);
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: true, visible: true, online: true, host: HOST, projects: [{ targetId: CONTROL, label: '블로그' }], transport: fakeMac().transport, storage }));
    expect(html).not.toContain('remote-workroom-history-orphans');
  });
  test('the overall cap points to where those requests can be cleaned up', async () => {
    const storage = memory();
    fill(storage, GONE, REMOTE_HISTORY_PENDING_PER_HOST); fill(storage, ELSEWHERE, REMOTE_HISTORY_PENDING_PER_HOST);
    await expect(resumeRemoteHistory({ transport: fakeMac().transport, storage, host: HOST, controlId: CONTROL, row, cols: 100, rows: 30 })).rejects.toThrow('연결되어 있지 않은 Mac');
  });
  test('the portal gives the panel this phone\'s Macs and its pairing', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'remote-control-portal-main.tsx'), 'utf8');
    const panel = source.slice(source.indexOf('<RemoteWorkroomHistoryPanel'), source.indexOf('/>', source.indexOf('<RemoteWorkroomHistoryPanel')));
    expect(panel).toContain('knownHosts={');
    expect(panel).toContain('pairing={');
  });
});
