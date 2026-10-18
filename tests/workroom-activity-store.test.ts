import {describe, expect, test} from 'bun:test';
import {WORKROOM_ACTIVITY_RETRY_MIN_MS, WORKROOM_ACTIVITY_UNSUPPORTED_RETRY_MS, WORKROOM_ACTIVITY_WEB_POLL_MS, createWorkroomActivityStore, workroomActivityTransport} from '../src/workroomActivityStore';
import {normalizeWorkroomActivityResponse} from '../src/workroomActivityProtocol';
import {WORKROOM_ACTIVITY_GROUPS, workroomActivityPresentation, workroomActivityTitlePrefix, workroomAttentionCount, workroomAttentionTitle} from '../src/workroomActivityView';

const bootId = '00000000-0000-4000-8000-000000000001';
const page = (cursor: number, sessions: object[] = [], reset = false) => ({activity: {bootId, cursor, reset, sessions, events: []}});
const entry = (sessionId: string, state: string, extra: object = {}) =>
  ({sessionId, targetId: 'target-0001', agent: 'codex', state, since: 1, turn: 1, source: 'screen', exact: false, lastOutputAt: null, ...extra});

function harness(answer: (body: any) => Promise<unknown>, transport: {holdMs?: number; gapMs?: number} = {}) {
  const timers: {callback: () => void; ms: number}[] = [];
  let visible = true, onVisibility: (() => void) | null = null;
  const bodies: any[] = [];
  let inFlight = 0, maxInFlight = 0;
  const store = createWorkroomActivityStore({
    request: async body => { bodies.push(body); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); try { return await answer(body); } finally { inFlight--; } },
    visible: () => visible,
    onVisibility: listener => { onVisibility = listener; return () => { onVisibility = null; }; },
    setTimer: (callback, ms) => { const timer = {callback, ms}; timers.push(timer); return timer; },
    clearTimer: timer => { const index = timers.indexOf(timer as any); if (index >= 0) timers.splice(index, 1); },
    now: () => 0,
    ...transport,
  });
  const fire = async () => { const timer = timers.shift(); timer?.callback(); await Bun.sleep(0); await Bun.sleep(0); return timer?.ms; };
  return {store, bodies, timers, fire, get maxInFlight() { return maxInFlight; }, hide() { visible = false; onVisibility?.(); }, show() { visible = true; onVisibility?.(); }};
}

describe('activity store: one long-poll per window', () => {
  test('asks without a cursor first, then from the cursor; never two at once', async () => {
    const h = harness(async body => page(body.after ? body.after.seq + 1 : 3, [entry('session-0001', 'needs-answer')], !body.after));
    const release = h.store.own();
    await Bun.sleep(0); await Bun.sleep(0);
    expect(h.bodies[0]).toEqual({operation: 'activity', waitMs: 25_000});
    expect(h.store.getSnapshot().sessions.get('session-0001')?.state).toBe('needs-answer');
    await h.fire(); await h.fire();
    expect(h.bodies.slice(1).map(b => b.after)).toEqual([{bootId, seq: 3}, {bootId, seq: 4}]);
    // A second owner in the same window shares the loop.
    const second = h.store.own();
    await Bun.sleep(0);
    expect(h.maxInFlight).toBe(1);
    second(); release();
    expect(h.timers).toHaveLength(0);
  });

  test('an old sidecar is not an error: unsupported, asked again after 5 minutes', async () => {
    const h = harness(async () => { throw new Error('허용되지 않은 터미널 요청입니다.'); });
    h.store.own();
    await Bun.sleep(0); await Bun.sleep(0);
    expect(h.store.getSnapshot().status).toBe('unsupported');
    expect(h.timers.map(t => t.ms)).toEqual([WORKROOM_ACTIVITY_UNSUPPORTED_RETRY_MS]);
  });

  test('errors back off by doubling', async () => {
    const h = harness(async () => { throw new Error('network'); });
    h.store.own();
    await Bun.sleep(0); await Bun.sleep(0);
    const waits = [h.timers[0]!.ms];
    for (let i = 0; i < 3; i++) { await h.fire(); waits.push(h.timers[0]!.ms); }
    expect(waits).toEqual([WORKROOM_ACTIVITY_RETRY_MIN_MS, WORKROOM_ACTIVITY_RETRY_MIN_MS * 2, WORKROOM_ACTIVITY_RETRY_MIN_MS * 4, WORKROOM_ACTIVITY_RETRY_MIN_MS * 8]);
    expect(h.store.getSnapshot().status).toBe('retrying');
  });

  test('a hidden window stops asking and resumes when shown', async () => {
    const h = harness(async () => page(1));
    h.store.own();
    await Bun.sleep(0); await Bun.sleep(0);
    h.hide();
    await h.fire();
    const asked = h.bodies.length;
    expect(h.timers).toHaveLength(0);
    h.show();
    await Bun.sleep(0); await Bun.sleep(0);
    expect(h.bodies.length).toBe(asked + 1);
  });

  test('a malformed answer is refused, never shown', () => {
    expect(() => normalizeWorkroomActivityResponse({sessions: []})).toThrow();
    expect(() => normalizeWorkroomActivityResponse(page(1, [{...entry('session-0001', 'working'), extra: 1}]))).toThrow();
    expect(() => normalizeWorkroomActivityResponse(page(1, [entry('session-0001', 'sleeping')]))).toThrow();
    expect(normalizeWorkroomActivityResponse(page(1, [entry('session-0001', 'working')])).sessions).toHaveLength(1);
  });
});

describe('activity presentation', () => {
  test('labels follow proof; another Mac has no state beyond running', () => {
    const view = (state: string, extra: object = {}) => entry('session-0001', state, extra) as any;
    expect(workroomActivityPresentation('running', view('turn-finished', {exact: true})).label).toBe('완료');
    expect(workroomActivityPresentation('running', view('turn-finished', {exact: false})).label).toBe('응답 멈춤');
    expect(workroomActivityPresentation('running', view('needs-answer')).group).toBe('needs-answer');
    expect(workroomActivityPresentation('running')).toEqual({group: 'running', label: '실행 중', tone: 'unknown'});
    // Only a proven end sits under 「완료」 (review 2026-10-16).
    expect(workroomActivityPresentation('running', view('turn-finished', {exact: false}))).toEqual({group: 'stopped', label: '응답 멈춤', tone: 'stopped'});
    expect(workroomActivityPresentation('running', view('starting')).group).toBe('running');
    expect(WORKROOM_ACTIVITY_GROUPS.find(group => group.id === 'finished')!.title).toBe('완료');
    expect(workroomActivityPresentation('exited', view('exited', {exitCode: 2, cause: 'exit'})).label).toBe('종료(코드 2)');
    expect(workroomActivityPresentation('exited', view('exited', {exitCode: 143, cause: 'close'})).label).toBe('종료');
    expect(workroomActivityTitlePrefix(view('needs-answer'))).toBe('● 응답 필요 · ');
    expect(workroomActivityTitlePrefix(view('turn-finished', {exact: true}))).toBe('✓ 완료 · ');
    expect(workroomActivityTitlePrefix(view('turn-finished', {exact: false}))).not.toContain('완료');
    expect(workroomAttentionCount([view('needs-answer'), view('turn-finished'), view('working'), view('idle')])).toBe(2);
  });
});

describe('sidebar attention badge text (review 2026-10-16)', () => {
  test('the tooltip names both proven and guessed ends; the tab name reads with a separator', () => {
    expect(workroomAttentionTitle(2)).toBe('확인할 작업 세션 2개 (응답 필요·완료·응답 멈춤)');
    const app = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, '../src/App.tsx'), 'utf8') as string;
    const badge = app.slice(app.indexOf('data-testid="tab-terminal-attention"') - 200, app.indexOf('data-testid="tab-terminal-attention"') + 200);
    expect(badge).toContain('aria-hidden="true"');
    expect(app).toMatch(/id="tab-terminal"[^>]*aria-label=\{workroomAttention>0\?`대화 세션, 확인할 세션 \$\{workroomAttention\}개`:undefined\}/);
  });
});

describe('local web mode holds no connection (review 2026-10-16)', () => {
  test('the app holds a long-poll; the browser asks without holding, every few seconds', () => {
    expect(workroomActivityTransport(true)).toEqual({holdMs: 25_000, gapMs: 250});
    // Chromium allows six HTTP/1.1 connections per host: one 25 s hold per window starves the page at six windows.
    expect(workroomActivityTransport(false)).toEqual({holdMs: 0, gapMs: WORKROOM_ACTIVITY_WEB_POLL_MS});
  });
  test('a non-holding store asks with waitMs 0 and waits its gap between answers', async () => {
    const h = harness(async body => page(body.after ? body.after.seq + 1 : 1), workroomActivityTransport(false));
    const release = h.store.own();
    await Bun.sleep(0); await Bun.sleep(0);
    expect(h.bodies[0]).toEqual({operation: 'activity', waitMs: 0});
    expect(h.timers[0]!.ms).toBe(WORKROOM_ACTIVITY_WEB_POLL_MS);
    await h.fire();
    expect(h.bodies[1]).toEqual({operation: 'activity', after: {bootId, seq: 1}, waitMs: 0});
    expect(h.maxInFlight).toBe(1);
    release();
  });
});
