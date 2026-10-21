/**
 * The phone side of 「업데이트 전 실행 중이던 작업 세션 이어 열기」 (w14, Build B): the batch, the banner's states and
 * the wire over a real E2EE relay. A batch is per-row `resumeRemoteHistory` — the request is remembered before it is
 * sent, each row executes once, and the batch stops at the first outcome it cannot know. Nothing is sent to a Mac that
 * does not advertise `workroom-restart-v1`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from '../src/mobileWorkspaceProtocol';
import { createMobileWorkspaceGateway } from '../src/mobileWorkspaceGateway';
import {
  REMOTE_HISTORY_PENDING_PER_HOST, WORKROOM_RESTART_REMOTE_FEATURE, pendingRemoteHistoryResumes, savePendingRemoteHistoryResume,
  type RemoteRestartOffer, type RemoteRestartRow,
} from '../src/workroomHistoryRemoteProtocol';
import {
  hideRemoteRestartOffer, listRemoteRestart, remoteRestartBatchSummary, remoteRestartOfferHidden, remoteRestartRunnableRows, resumeRemoteRestartRows,
} from '../src/remoteWorkroomRestartClient';
import { RemoteRestartBannerView, RemoteWorkroomRestartBanner } from '../src/RemoteWorkroomRestartBanner';
import { remoteHistoryWhyPhrase, remoteRestartCollapsedLabel, restartRowLabeler, REMOTE_RESTART_GRANT_SENTENCE, REMOTE_RESTART_READ_SENTENCE } from '../src/workroomRestartText';
import { RemoteWorkroomHistoryPanel } from '../src/RemoteWorkroomHistoryPanel';
import { terminalRelayHarness } from './fixtures/terminalRelayHarness';
import type { RemoteControlGateway } from '../src/remoteControlCore';

const HOST = 'host-0123456789', CONTROL = 'control_' + 'A'.repeat(36), CONTROL_B = 'control_' + 'B'.repeat(36);
const memory = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const now = new Date().toISOString();
const row = (over: Partial<RemoteRestartRow> = {}): RemoteRestartRow => ({ id: 'conv_' + randomUUID().replaceAll('-', ''), project: CONTROL, title: '지난 작업', agent: 'claude', availability: 'ready', bypass: false, revision: 2, createdAt: now, updatedAt: now, ...over });
const offerOf = (rows: RemoteRestartRow[], over: Partial<RemoteRestartOffer> = {}): RemoteRestartOffer => ({ offerId: randomUUID(), revision: 1, update: true, more: false, complete: true, closable: true, unlisted: 0, rows, ...over });

/** A Mac that answers the history actions; `outcomes` decides each execute (by conversation id). */
function fakeMac(opts: { outcomes?: Record<string, 'completed' | 'unknown' | 'rejected' | 'lost' | 'throw-review'>; unavailable?: string[]; offer?: RemoteRestartOffer | null; storage?: ReturnType<typeof memory> } = {}) {
  const sent: { action: string; targetId: string; conversationId?: string; pendingAtSend?: number }[] = [];
  let executions = 0;
  const transport = async (request: MobileWorkspaceRequest): Promise<MobileWorkspaceResult> => {
    const { action, history } = request.workspace as any;
    sent.push({ action, targetId: request.targetId, conversationId: history?.conversationId, ...(opts.storage && action === 'history.resume.execute' ? { pendingAtSend: pendingRemoteHistoryResumes(opts.storage, HOST).length } : {}) });
    if (action === 'history.restart') return { kind: 'workspace', action, history: { restart: opts.offer ?? null } };
    if (action === 'history.resume.review') {
      if (opts.outcomes?.[history.conversationId] === 'throw-review') throw new Error('Mac이 아직 결과를 보내지 않았습니다.');
      const unavailable = opts.unavailable?.includes(history.conversationId);
      return { kind: 'workspace', action, history: { review: { id: 'review-' + randomUUID(), expiresAt: Date.now() + 60_000, available: !unavailable, reason: unavailable ? '첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다.' : '', revision: 3 } } };
    }
    if (action === 'history.resume.execute') {
      executions++;
      const outcome = opts.outcomes?.[history.conversationId] ?? 'completed';
      if (outcome === 'lost') throw new Error('Mac이 아직 결과를 보내지 않았습니다.');
      return { kind: 'workspace', action, history: { resume: { state: outcome as any, ...(outcome === 'completed' ? { sessionId: 'session-' + randomUUID() } : {}) } } };
    }
    throw new Error('unexpected ' + action);
  };
  return { transport, sent, executions: () => executions };
}

describe('phone restart batch', () => {
  test('one request per row through its own project; the request is remembered before it leaves', async () => {
    const storage = memory(), rows = [row(), row({ project: CONTROL_B })];
    const mac = fakeMac({ storage });
    const result = await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, pairing: 'pairing-00000001', rows, cols: 100, height: 30 });
    expect(result.opened.map(o => o.row.id)).toEqual(rows.map(r => r.id));
    expect(mac.sent.map(s => `${s.action}:${s.targetId}`)).toEqual([
      `history.resume.review:${CONTROL}`, `history.resume.execute:${CONTROL}`, `history.resume.review:${CONTROL_B}`, `history.resume.execute:${CONTROL_B}`]);
    // Each execute left with its pending record already saved (one at a time: the first was settled before the second).
    expect(mac.sent.filter(s => s.action === 'history.resume.execute').map(s => s.pendingAtSend)).toEqual([1, 1]);
    expect(pendingRemoteHistoryResumes(storage, HOST)).toEqual([]);
    expect(mac.executions()).toBe(2);
  });
  test('rows that cannot be opened from here are never sent', async () => {
    const storage = memory(), rows = [row({ availability: 'unsupported' }), row({ availability: 'grant' }), row({ availability: 'account' }), row({ availability: 'pending' }), row({ availability: 'check' })];
    const mac = fakeMac();
    const result = await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, rows, cols: 100, height: 30 });
    expect(result.opened.map(o => o.row.id)).toEqual([rows[4]!.id]);
    expect(mac.sent.map(s => s.conversationId)).toEqual([rows[4]!.id, rows[4]!.id]);
  });
  test('stops at the first unknown outcome: never resent, the rows after it are not tried', async () => {
    const storage = memory(), rows = [row(), row(), row()];
    const mac = fakeMac({ outcomes: { [rows[1]!.id]: 'unknown' } });
    const result = await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, rows, cols: 100, height: 30 });
    expect(result.opened.map(o => o.row.id)).toEqual([rows[0]!.id]);
    expect(result.stopped).toMatchObject({ row: { id: rows[1]!.id }, sent: true });
    expect(mac.executions()).toBe(2);
    expect(mac.sent.some(s => s.conversationId === rows[2]!.id)).toBe(false);
    // The unknown one stays as a pending request for 「결과 확인」 only.
    expect(pendingRemoteHistoryResumes(storage, HOST).map(p => p.conversationId)).toEqual([rows[1]!.id]);
  });
  test('a lost execute answer stops the batch the same way; a second press does not send that row again', async () => {
    const storage = memory(), rows = [row(), row()];
    const mac = fakeMac({ outcomes: { [rows[0]!.id]: 'lost' } });
    const first = await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, rows, cols: 100, height: 30 });
    expect(first.stopped).toMatchObject({ row: { id: rows[0]!.id }, sent: true });
    expect(first.opened).toEqual([]);
    // The banner offers only rows without a pending request: the lost one is checked with status, never re-executed.
    const again = remoteRestartRunnableRows(offerOf(rows), pendingRemoteHistoryResumes(storage, HOST));
    expect(again.map(r => r.id)).toEqual([rows[1]!.id]);
    await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, rows: again, cols: 100, height: 30 });
    expect(mac.sent.filter(s => s.action === 'history.resume.execute').map(s => s.conversationId)).toEqual([rows[0]!.id, rows[1]!.id]);
  });
  test('an unavailable review skips that row and goes on; an error before anything ran stops with nothing sent for it', async () => {
    const storage = memory(), rows = [row(), row(), row()];
    const mac = fakeMac({ unavailable: [rows[0]!.id], outcomes: { [rows[2]!.id]: 'throw-review' } });
    const result = await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, rows, cols: 100, height: 30 });
    expect(result.skipped.map(s => s.row.id)).toEqual([rows[0]!.id]);
    expect(result.opened.map(o => o.row.id)).toEqual([rows[1]!.id]);
    expect(result.stopped).toMatchObject({ row: { id: rows[2]!.id }, sent: false });
    expect(mac.executions()).toBe(1);
  });
  test('offline: nothing more is sent and the batch says so', async () => {
    const storage = memory(), rows = [row(), row()];
    const mac = fakeMac();
    let online = true;
    const result = await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, rows, cols: 100, height: 30, online: () => online,
      onProgress: done => { if (done === 1) online = false; } });
    expect(result.opened).toHaveLength(1);
    expect(result.stopped).toMatchObject({ row: { id: rows[1]!.id }, sent: false });
    expect(result.stopped!.reason).toContain('오프라인');
    expect(mac.executions()).toBe(1);
  });
  test('a full list of unsettled requests on this phone stops before anything is asked', async () => {
    const storage = memory();
    for (let i = 0; i < REMOTE_HISTORY_PENDING_PER_HOST; i++) savePendingRemoteHistoryResume(storage, { host: HOST, conversationId: randomUUID(), resumeRequestId: randomUUID(), controlId: CONTROL, requestedAt: now });
    const mac = fakeMac();
    const result = await resumeRemoteRestartRows({ transport: mac.transport, storage, host: HOST, rows: [row(), row()], cols: 100, height: 30 });
    expect(result.stopped?.sent).toBe(false);
    expect(mac.sent).toEqual([]);
  });
  test('the summary never asks to run anything again', () => {
    const rows = [row({ title: '첫 작업' }), row({ title: '둘째 작업' }), row({ title: '셋째 작업' })];
    const label = (r: RemoteRestartRow) => r.title;
    expect(remoteRestartBatchSummary({ opened: [{ row: rows[0]! }], skipped: [{ row: rows[1]!, reason: '첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다. 새 대화를 시작하세요.' }], stopped: null }, label))
      .toBe('1개를 다시 열었습니다 — 작업 세션 목록에서 여세요 · 1개는 첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다.');
    expect(remoteRestartBatchSummary({ opened: [], skipped: [], stopped: { row: rows[2]!, reason: 'x', sent: true } }, label)).toContain('셋째 작업의 결과를 확인하지 못해 멈췄습니다');
    expect(remoteRestartBatchSummary({ opened: [], skipped: [], stopped: { row: rows[2]!, reason: '휴대폰이 오프라인입니다.', sent: false } }, label)).toContain('휴대폰이 오프라인입니다');
    expect(remoteRestartBatchSummary({ opened: [], skipped: [], stopped: { row: rows[2]!, reason: '휴대폰이 오프라인입니다.', sent: false } }, label)).not.toContain('결과를 확인하지 못해');
  });
});

describe('phone restart client and local hide', () => {
  test('listing sends one history.restart through the given project', async () => {
    const offer = offerOf([row()]);
    const mac = fakeMac({ offer });
    expect(await listRemoteRestart(mac.transport, CONTROL)).toEqual(offer);
    expect(mac.sent).toEqual([{ action: 'history.restart', targetId: CONTROL, conversationId: undefined }]);
  });
  test('「이 휴대폰에서 숨기기」 hides that offer on this phone only, per Mac; a broken storage hides nothing', () => {
    const storage = memory(), offer = offerOf([row()]);
    expect(remoteRestartOfferHidden(storage, HOST, offer)).toBe(false);
    hideRemoteRestartOffer(storage, HOST, offer);
    expect(remoteRestartOfferHidden(storage, HOST, offer)).toBe(true);
    expect(remoteRestartOfferHidden(storage, 'host-other-000001', offer)).toBe(false);
    expect(remoteRestartOfferHidden(storage, HOST, offerOf([row()]))).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => hideRemoteRestartOffer(broken, HOST, offer)).not.toThrow();
    expect(remoteRestartOfferHidden(broken, HOST, offer)).toBe(false);
  });
});

describe('phone restart banner', () => {
  const props = (offer: RemoteRestartOffer, over: Record<string, unknown> = {}) => ({
    offer, expanded: true, armed: null, progress: null, summary: '', notice: '', pendingIds: new Set<string>(), online: true,
    label: (r: RemoteRestartRow) => r.title, onToggle() {}, onArm() {}, onConfirm() {}, onCancel() {}, onDismiss() {}, onHide() {}, onCheck() {}, ...over,
  });
  const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1;
  test('folded, it is one button that says how many and what for', () => {
    const offer = offerOf([row(), row(), row({ availability: 'unsupported' })]);
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offer, { expanded: false })));
    expect(count(html, 'remote-workroom-restart-toggle')).toBe(1);
    // Every session it lists (w14 review: 3 were running, 2 open — the label said 2 and the list showed 3).
    expect(html).toContain(remoteRestartCollapsedLabel(3, true, true));
    expect(html).toContain('업데이트 전 작업 세션 3개 · 이어 열기');
    expect(count(html, 'remote-workroom-restart-open-all')).toBe(0);
    expect(remoteRestartCollapsedLabel(3, false, false)).toBe('앱을 다시 열기 전 작업 세션 3개 · 보기');
  });
  test('expanded: each row says why in one phrase; 「N개 이어 열기」, and 닫기 only when the phone sees every row', () => {
    const offer = offerOf([row({ bypass: true }), row({ availability: 'unsaved' }), row({ availability: 'account' })]);
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offer)));
    expect(count(html, 'remote-workroom-restart-row')).toBe(3);
    expect(html).toContain('첫 요청 전에 끝나 저장된 대화 없음');
    expect(html).toContain('권한 우회');
    expect(count(html, 'remote-workroom-restart-open-all')).toBe(1);
    expect(html).toContain('1개 이어 열기');
    expect(count(html, 'remote-workroom-restart-dismiss')).toBe(1);
    expect(count(html, 'remote-workroom-restart-hide')).toBe(0);
    const partial = renderToStaticMarkup(createElement(RemoteRestartBannerView, props({ ...offer, complete: false, closable: false })));
    expect(count(partial, 'remote-workroom-restart-dismiss')).toBe(0);
    expect(count(partial, 'remote-workroom-restart-hide')).toBe(1);
  });
  test('without the resume grant: the sentence that says so, and no button that opens anything', () => {
    const offer = offerOf([row({ availability: 'grant' }), row({ availability: 'grant' })], { closable: false });
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offer)));
    expect(html).toContain(REMOTE_RESTART_GRANT_SENTENCE);
    expect(count(html, 'remote-workroom-restart-open-all')).toBe(0);
    expect(count(html, 'remote-workroom-restart-row-open')).toBe(0);
    expect(count(html, 'remote-workroom-restart-dismiss')).toBe(0);
    expect(count(html, 'remote-workroom-restart-hide')).toBe(1);
  });
  test('review: whether this phone may close it is the Mac\'s word — a pending-only offer to a read-only phone offers hide, never 닫기', () => {
    const offer = offerOf([row({ availability: 'pending' })], { closable: false });
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offer)));
    expect(count(html, 'remote-workroom-restart-dismiss')).toBe(0);
    expect(count(html, 'remote-workroom-restart-hide')).toBe(1);
  });
  test('review: without the read grant, how many and which permission — no rows, no titles, hide on this phone', () => {
    const offer = offerOf([], { unlisted: 3, complete: false, closable: false });
    const folded = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offer, { expanded: false })));
    expect(folded).toContain('업데이트 전 작업 세션 3개 · 보기');
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offer)));
    expect(html).toContain(REMOTE_RESTART_READ_SENTENCE);
    expect(html).not.toContain('Mac에서 이어서 엽니다');
    expect(count(html, 'remote-workroom-restart-row')).toBe(0);
    expect(count(html, 'remote-workroom-restart-open-all')).toBe(0);
    expect(count(html, 'remote-workroom-restart-hide')).toBe(1);
  });
  test('review: a row is headed by its name and says when it started under it; a confirmation names it with the time', () => {
    const early = row({ title: '', createdAt: '2026-10-16T01:00:00.000Z' }), late = row({ title: '', createdAt: '2026-10-16T05:30:00.000Z' });
    const name = () => '쇼핑몰 · Codex CLI';
    const label = restartRowLabeler([early, late], name);
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offerOf([early, late]), { name, label, armed: { kind: 'one', rowId: late.id } })));
    expect(html.split('<strong>쇼핑몰 · Codex CLI</strong>').length - 1).toBe(2);
    expect(html.match(/10월 16일 \d\d:\d\d 시작 · 이어 열 수 있음/g)).toHaveLength(2);
    expect(html).toMatch(/「쇼핑몰 · Codex CLI \(10월 16일 \d\d:\d\d 시작\)」 대화를 다시 엽니다 · 권한 우회 없음/);
  });
  test('a row this phone sent and has not settled offers 「결과 확인」, not 「이어 열기」', () => {
    const pending = row();
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offerOf([pending, row()]), { pendingIds: new Set([pending.id]) })));
    expect(count(html, 'remote-workroom-restart-row-check')).toBe(1);
    expect(count(html, 'remote-workroom-restart-row-open')).toBe(1);
    expect(html).toContain('1개 이어 열기');
  });
  test('the confirmation is its own block that says what opens, with 취소', () => {
    const html = renderToStaticMarkup(createElement(RemoteRestartBannerView, props(offerOf([row(), row()]), { armed: { kind: 'all' } })));
    expect(count(html, 'remote-workroom-restart-confirm')).toBe(1);
    expect(html).toContain('이 Mac에서 2개 대화를 다시 엽니다 · 권한 우회 없음');
    expect(count(html, 'remote-workroom-restart-confirm-cancel')).toBe(1);
    expect(count(html, 'remote-workroom-restart-open-all')).toBe(0);
  });
  test('a Mac without the feature renders nothing', () => {
    const html = renderToStaticMarkup(createElement(RemoteWorkroomRestartBanner, { available: false, visible: true, online: true, host: HOST, controlId: CONTROL, projects: [], transport: fakeMac().transport }));
    expect(html).toBe('');
  });
});

describe('phone history list reasons', () => {
  test('a reason phrase per code, never a bare 「이어 열 수 없음」 when the Mac says why', () => {
    expect(remoteHistoryWhyPhrase('unsaved')).toBe('첫 요청 전에 끝나 저장된 대화 없음');
    expect(remoteHistoryWhyPhrase('grant')).toContain('권한');
    expect(remoteHistoryWhyPhrase('running')).toContain('작업 세션 목록');
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'RemoteWorkroomHistoryPanel.tsx'), 'utf8');
    expect(src).toContain("detached: '앱 재시작으로 끊김'");
    expect(src).not.toContain('앱 재시작 전 대화');
    expect(renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, { available: true, detail: true, visible: true, online: true, host: HOST, projects: [{ targetId: CONTROL, label: 'A' }], transport: fakeMac().transport }))).toContain('대화 기록');
  });
  test('the portal gives the banner to this Mac\'s panel only, and asks for reasons only from a Mac that has the feature', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'remote-control-portal-main.tsx'), 'utf8');
    const community = src.split('\n').find(line => line.includes("key={'community:'+communityDevice.ref}"))!;
    expect(community).toBeTruthy(); expect(community).not.toContain('restartBanner');
    expect(src).toMatch(/restartBanner=\{<RemoteWorkroomRestartBanner/);
    expect(src).toContain('WORKROOM_RESTART_REMOTE_FEATURE');
    expect(src).toMatch(/detail=\{[^}]*WORKROOM_RESTART_REMOTE_FEATURE/);
  });
});

describe('workroom-restart-v1 over the real encrypted relay', () => {
  const disposals: (() => Promise<unknown>)[] = [];
  afterEach(async () => { for (const f of disposals.splice(0).reverse()) await f(); });
  const projectGateway: RemoteControlGateway = { listRegisteredProjects: () => [{ internalId: 'private-project', name: 'Fixture project', port: null, command: null, kind: 'main', folderPath: '/tmp', status: 'unknown', actions: ['folder.open'] }], executeRegisteredProjectAction: () => {} };
  const terminal = (calls: string[]) => createMobileWorkspaceGateway({
    terminal: async () => ({ sessions: [] }), active: () => true,
    resolve: async bindings => bindings.map(b => ({ controlId: b.controlId, runtimeTargetId: 'runtime-target-0001' })),
    consent: async () => ({ targetIds: new Set(['runtime-target-0001']), workspaceScopes: [], historyScopes: ['history.read', 'history.resume'], isActive: () => true, requestOwner: 'device:h:c' }),
    perform: async () => { throw new Error('unused'); },
    history: async (request: any, _target: string, _owner: string, a: any) => {
      calls.push(request.workspace.action);
      const control = [...a.controlIds.values()][0];
      return { restart: { offerId: randomUUID(), revision: 1, update: true, more: false, complete: true, closable: true, unlisted: 0, rows: [row({ project: control })] } };
    },
  });
  test('advertised on the extended read only; the legacy answer is unchanged; the offer arrives intact', async () => {
    const calls: string[] = [];
    const h = await terminalRelayHarness(projectGateway, terminal(calls), { host: { workspaceSupported: true, historySupported: true } });
    disposals.push(async () => { await h.host.disable(); });
    await h.connect();
    const legacy = (await h.controller.probeSupportedFeatures(true)).supportedFeatures ?? [];
    expect(legacy).not.toContain(WORKROOM_RESTART_REMOTE_FEATURE);
    const extended = (await h.controller.probeSupportedFeatures(true, true)).supportedFeatures ?? [];
    expect(extended).toContain(WORKROOM_RESTART_REMOTE_FEATURE);
    expect(extended).toContain('workroom-history-v1');
    const control = h.controller.status().projects[0]!.controlId;
    const offer = await listRemoteRestart(request => h.controller.sendTerminal(request), control);
    expect(offer?.rows[0]?.project).toBe(control);
    expect(calls).toEqual(['history.restart']);
  });
  test('a Mac without the feature is never asked', async () => {
    const calls: string[] = [];
    const h = await terminalRelayHarness(projectGateway, terminal(calls), { host: { workspaceSupported: true, historySupported: false } });
    disposals.push(async () => { await h.host.disable(); });
    await h.connect();
    await h.controller.probeSupportedFeatures(true, true);
    expect(h.controller.status().supportedFeatures).not.toContain(WORKROOM_RESTART_REMOTE_FEATURE);
    const control = h.controller.status().projects[0]!.controlId;
    await expect(listRemoteRestart(request => h.controller.sendTerminal(request), control)).rejects.toThrow('업데이트');
    expect(calls).toEqual([]);
  });
});
