import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {
  BROWSER_BLOCKED_HINT_MS,BROWSER_MESSAGE_PRIORITY,browserAbsoluteTime,browserActivityRows,browserControlView,
  browserRecoveryCard,browserRelativeTime,receiptSentenceKey,targetName,type BrowserControlInput,
} from '../src/workroomBrowserPresentation';
import {workroomBrowserUiCopy} from '../src/workroomBrowserUiCopy';
import {BROWSER_ERROR_CODES} from '../src/workroomBrowserErrorCodes';
import type {BrowserActivity,BrowserOwner,BrowserReceipt,BrowserRecoverySummary,BrowserWorkspace} from '../src/workroomBrowserProtocol';
import {APP_LANGUAGES,type Lang} from '../src/i18n';
import {browserControlCloseAction,WorkroomBrowserControlMessages,WorkroomBrowserFrameControl,type WorkroomBrowserControlSignals,type WorkroomBrowserControlState} from '../src/WorkroomBrowserFrameControl';
import {EmptyState,PageErrorCard,PagePlaceholder,UnavailableState} from '../src/WorkroomBrowserFrameStates';
import {BROWSER_LOAD_ERROR_CODES,workroomBrowserPageErrorCopy} from '../src/workroomBrowserErrorCopy';
import {WorkroomBrowserRecoveries} from '../src/WorkroomBrowserRecoveries';
import type {WorkroomBrowserPageState} from '../src/OwnedWorkroomBrowser';

const projectRoot = new URL('../', import.meta.url);
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const base = (over: Partial<BrowserControlInput> = {}): BrowserControlInput =>
  ({owner: 'human', source: 'owned', hasPage: true, now: NOW, lang: 'ko', ...over});
const copy = workroomBrowserUiCopy('ko');
// Every key this module names must exist in A1's copy; a sentence is never built here.
const resolve = (group: 'owner' | 'waiting' | 'activity', key: string) => (copy[group] as Record<string, string>)[key];

test('every key and parameter this module decides exists in the A1 copy, in all seven languages', () => {
  const owners: BrowserOwner[] = ['human', 'observing', 'agent', 'taking', 'disconnected'];
  const receipts = [null, {state: 'completed' as const, action: 'click' as const, target: {role: 'button', name: '주문하기'}, id: 'r1'},
    {state: 'unknown' as const, action: 'click' as const, target: {role: 'button', name: '주문하기'}, id: 'r2'},
    {state: 'rejected' as const, action: 'fill' as const, id: 'r3'}, {state: 'reviewed' as const, action: 'select' as const, id: 'r4'}];
  const extras: Partial<BrowserControlInput>[] = [{}, {errorCode: 'chrome-disconnected'}, {grantFailed: true},
    {popup: {open: true, host: 'accounts.google.com'}}, {popup: {open: true}}, {waiting: {reason: 'login', at: NOW}},
    {waiting: {reason: 'open-page', at: NOW, url: 'https://example.com/'}}, {handoffReady: true}, {fileNotice: true},
    {blockedAt: NOW - 1000}, {busy: true}, {hasPage: false}, {profileVerification: 'unverified'}, {connectFailed: true, errorCode: 'target-lost'}];
  let seen = 0;
  for (const lang of APP_LANGUAGES.map(item => item.id)) {
    const langCopy = workroomBrowserUiCopy(lang);
    for (const owner of owners) for (const source of ['owned', 'chrome'] as const) for (const receipt of receipts) for (const extra of extras) {
      const view = browserControlView(base({owner, source, receipt, ...extra}));
      seen++;
      // The label, the message and every button name resolve to a real sentence.
      expect(typeof (langCopy.owner as Record<string, string>)[view.labelKey]).toBe('string');
      if (view.message.textKey) expect(typeof (langCopy[view.message.group] as Record<string, string>)[view.message.textKey]).toBe('string');
      for (const action of [view.primary, view.secondary]) {
        if (!action) continue;
        expect(typeof (langCopy[action.group] as Record<string, string>)[action.labelKey]).toBe('string');
        if (action.disabledReasonKey) expect(typeof (langCopy.owner as Record<string, string>)[action.disabledReasonKey]).toBe('string');
      }
      if (view.detail) expect(typeof (langCopy[view.detail.group] as Record<string, string>)[view.detail.textKey]).toBe('string');
      // A parameterized sentence always gets its parameter, and never the other way round.
      const text = view.message.textKey ? (langCopy[view.message.group] as Record<string, string>)[view.message.textKey]! : '';
      for (const token of text.matchAll(/\{(\w+)\}/g)) expect(view.message.params?.[token[1]!]).toBeDefined();
      if (view.message.params) for (const name of Object.keys(view.message.params)) expect(text).toContain(`{${name}}`);
      // An error is the only message that carries a code, and it never carries a sentence of its own (A3 renders it).
      expect(!!view.message.errorCode).toBe(view.message.kind === 'error' && view.message.textKey === '');
    }
  }
  expect(seen).toBe(7 * 5 * 2 * 5 * 14);
});

test('the state line and the one verb follow the owner, for both sources', () => {
  expect(browserControlView(base())).toMatchObject({
    tone: 'neutral', labelKey: 'human', humanControlsEnabled: true, showTake: false,
    message: {kind: 'owner', textKey: 'human', role: 'status'},
    primary: {action: 'handoff', labelKey: 'handToAi', disabled: false, primary: true},
    secondary: null,
  });
  // 「직접 하기」 is hidden while a person owns the page — for My Chrome too, which used to be the only covered source.
  for (const source of ['owned', 'chrome'] as const) expect(browserControlView(base({source})).showTake).toBe(false);
  expect(browserControlView(base({owner: 'observing'}))).toMatchObject({
    tone: 'ai', labelKey: 'observing', message: {kind: 'transition', textKey: 'observing'},
    primary: {action: 'handoff', disabled: true, disabledReasonKey: 'disabledBusy'}, humanControlsEnabled: false, showTake: true,
  });
  expect(browserControlView(base({owner: 'agent'}))).toMatchObject({
    tone: 'ai', labelKey: 'agent', message: {kind: 'owner', textKey: 'agent'},
    primary: {action: 'take', labelKey: 'takeOver', disabled: false}, humanControlsEnabled: false, showTake: true,
  });
  expect(browserControlView(base({owner: 'taking'}))).toMatchObject({
    tone: 'ai', labelKey: 'taking', message: {kind: 'transition', textKey: 'taking'},
    primary: {action: 'take', disabled: true, disabledReasonKey: 'disabledBusy'},
  });
  // Disconnected is source-specific, and the built-in browser never mentions Chrome.
  expect(browserControlView(base({owner: 'disconnected'}))).toMatchObject({
    tone: 'danger', labelKey: 'disconnectedOwned', message: {kind: 'disconnected', textKey: 'disconnectedOwned', role: 'alert'},
    primary: {action: 'reconnect', labelKey: 'reconnect'}, humanControlsEnabled: false,
  });
  expect(browserControlView(base({owner: 'disconnected', source: 'chrome'})).message.textKey).toBe('disconnectedChrome');
  expect(resolve('owner', 'disconnectedOwned')).not.toContain('Chrome');
  // A dropped connection outranks whatever the host last said about ownership.
  expect(browserControlView(base({owner: 'agent', connection: 'disconnected'}))).toMatchObject({labelKey: 'disconnectedOwned', humanControlsEnabled: false});
  // An unverified Chrome profile is a warning label, not a different verb.
  expect(browserControlView(base({source: 'chrome', profileVerification: 'unverified'}))).toMatchObject({
    tone: 'warn', labelKey: 'unverified', primary: {action: 'handoff'},
  });
  expect(browserControlView(base({source: 'owned', profileVerification: 'unverified'})).labelKey).toBe('human');
});

test('messages replace the state line in the spec order', () => {
  expect([...BROWSER_MESSAGE_PRIORITY]).toEqual(['error', 'transition', 'disconnected', 'popup', 'waiting', 'notice', 'blocked', 'owner']);
  const all: Partial<BrowserControlInput> = {
    errorCode: 'chrome-disconnected', owner: 'taking', popup: {open: true, host: 'accounts.google.com'},
    waiting: {reason: 'login', at: NOW}, fileNotice: true, handoffReady: true, blockedAt: NOW,
  };
  // Everything at once: the danger error wins, then transition, then disconnected, then popup, waiting, notice, blocked.
  const order: Array<[Partial<BrowserControlInput>, (typeof BROWSER_MESSAGE_PRIORITY)[number]]> = [
    [all, 'error'],
    [{...all, errorCode: null}, 'transition'],
    [{...all, errorCode: null, owner: 'human', connection: 'disconnected'}, 'disconnected'],
    [{...all, errorCode: null, owner: 'human'}, 'popup'],
    [{...all, errorCode: null, owner: 'human', popup: null}, 'waiting'],
    [{...all, errorCode: null, owner: 'human', popup: null, waiting: null}, 'notice'],
    [{...all, errorCode: null, owner: 'human', popup: null, waiting: null, fileNotice: false, handoffReady: false}, 'blocked'],
    [{owner: 'human'}, 'owner'],
  ];
  for (const [input, kind] of order) expect(browserControlView(base(input)).message.kind).toBe(kind);
  // The newest person-triggered notice is the one shown when both notices are pending.
  expect(browserControlView(base({fileNotice: true, handoffReady: true})).message.textKey).toBe('handoffReady');
  expect(browserControlView(base({fileNotice: true})).message.textKey).toBe('fileNotice');
  // The blocked hint is a four-second hint, not a state.
  expect(browserControlView(base({blockedAt: NOW - BROWSER_BLOCKED_HINT_MS + 1})).message.kind).toBe('blocked');
  expect(browserControlView(base({blockedAt: NOW - BROWSER_BLOCKED_HINT_MS})).message.kind).toBe('owner');
  // A refusal is carried as a code with no sentence of its own, and it is the only message that is role=alert + code.
  const refused = browserControlView(base({errorCode: 'take-control-first'}));
  expect(refused.message).toEqual({kind: 'error', tone: 'danger', group: 'owner', textKey: '', errorCode: 'take-control-first', role: 'alert', dismissible: true});
  for (const code of BROWSER_ERROR_CODES) expect(browserControlView(base({errorCode: code})).message.errorCode).toBe(code);
  // A failed connect keeps the page and offers to finish the connect — never a navigation.
  expect(browserControlView(base({errorCode: 'target-lost', connectFailed: true})).primary).toMatchObject({action: 'retry-connect', labelKey: 'retryConnect'});
});

test('the popup, the waiting AI and a failed grant each change what a person should press', () => {
  const popup = browserControlView(base({popup: {open: true, host: 'accounts.google.com'}}));
  expect(popup).toMatchObject({
    tone: 'warn', message: {kind: 'popup', textKey: 'popupOpen', params: {host: 'accounts.google.com'}},
    primary: {action: 'handoff', disabled: true, disabledReasonKey: 'disabledPopupOpen'},
    secondary: {action: 'close-popup', labelKey: 'closePopup'},
  });
  expect(browserControlView(base({popup: {open: true}})).message.textKey).toBe('popupOpenGeneric');
  // C3: the AI asks for a person. 「직접 하기」 for login/captcha/confirm/file, 「직접 열기」 for open-page.
  for (const [reason, key] of [['login', 'login'], ['captcha', 'captcha'], ['confirm', 'confirm'], ['file', 'file']] as const) {
    expect(browserControlView(base({owner: 'agent', waiting: {reason, at: NOW}}))).toMatchObject({
      tone: 'warn', message: {kind: 'waiting', group: 'waiting', textKey: key}, primary: {action: 'take', labelKey: 'takeOver'},
    });
  }
  expect(browserControlView(base({owner: 'agent', waiting: {reason: 'open-page', at: NOW, url: 'https://example.com/'}}))).toMatchObject({
    message: {group: 'waiting', textKey: 'openPage'}, primary: {action: 'take', group: 'waiting', labelKey: 'openPageAction'},
  });
  // A grant that could not be made: the AI keeps the page, the person is told, and nothing retries by itself.
  const grant = browserControlView(base({owner: 'agent', grantFailed: true}));
  expect(grant).toMatchObject({
    tone: 'warn', message: {kind: 'error', tone: 'warn', textKey: 'grantFailed', role: 'alert'},
    primary: {action: 'take', labelKey: 'takeOver', disabled: false},
    secondary: {action: 'retry-grant', labelKey: 'retryGrant'},
  });
  expect(grant.message.errorCode).toBeUndefined();
});

test('an action whose result is unknown is checked first and never sent again', () => {
  const unknown = {state: 'unknown' as const, action: 'click' as const, target: {role: 'button', name: '주문하기'}, id: 'r-unknown'};
  const view = browserControlView(base({receipt: unknown}));
  expect(view).toMatchObject({resendBlocked: true, primary: {action: 'handoff', disabled: true, disabledReasonKey: 'disabledUnknownReceipt'}});
  expect(view.detail).toEqual({group: 'owner', textKey: 'disabledUnknownReceipt'});
  // No decision anywhere in the matrix is a resend of the action.
  for (const owner of ['human', 'observing', 'agent', 'taking', 'disconnected'] as const) {
    const next = browserControlView(base({owner, receipt: unknown}));
    for (const action of [next.primary, next.secondary]) expect(['handoff', 'take', 'reconnect', 'retry-grant', 'close-popup', 'settle', 'retry-connect', 'open-address']).toContain(action?.action ?? 'handoff');
    expect(next.resendBlocked).toBe(true);
  }
  // A settled or completed receipt stops blocking.
  for (const state of ['completed', 'rejected', 'reviewed'] as const) {
    expect(browserControlView(base({receipt: {...unknown, state}})).resendBlocked).toBe(false);
  }
  // The drawer row is the only place with actions: check it myself, then 「확인했어요」.
  const rows = browserActivityRows([{...unknown, at: NOW - 12_000}] as BrowserActivity[], {now: NOW, lang: 'ko'});
  expect(rows[0]).toMatchObject({textKey: 'unknown', tone: 'warn', params: {target: '주문하기'}, time: '12초 전'});
  expect(rows[0]!.actions.map(action => [action.action, action.labelKey])).toEqual([['take', 'checkMyself'], ['settle', 'checkedIt']]);
  expect(resolve('activity', 'unknown')).toContain('다시 보내지 않았습니다');
});

test('a receipt becomes one sentence, and the drawer reads newest first with Intl times', () => {
  expect(receiptSentenceKey({state: 'completed', action: 'click'})).toBe('clickDone');
  expect(receiptSentenceKey({state: 'completed', action: 'fill'})).toBe('fillDone');
  expect(receiptSentenceKey({state: 'completed', action: 'select'})).toBe('selectDone');
  expect(receiptSentenceKey({state: 'completed'})).toBe('done');
  expect(receiptSentenceKey({state: 'reviewed', action: 'click'})).toBe('clickDone');
  expect(receiptSentenceKey({state: 'rejected', action: 'click'})).toBe('rejected');
  expect(receiptSentenceKey({state: 'unknown', action: 'click'})).toBe('unknown');
  // The element's own name only; unnamed roles are looked up in the localized copy, never printed as raw enums.
  expect(targetName({target: {role: 'button', name: '  주문하기 '}})).toBe('주문하기');
  expect(targetName({target: {role: 'textbox', name: ''}})).toBe('');
  expect(targetName({})).toBe('');
  const activity = [
    {id: 'a1', state: 'completed', action: 'fill', target: {role: 'textbox', name: '쿠폰'}, at: NOW - 12_000},
    {id: 'a2', state: 'completed', action: 'click', target: {role: 'button', name: '적용'}, at: NOW - 3_600_000},
    {id: 'a3', state: 'rejected', action: 'select', at: NOW - 90_000},
  ] as BrowserActivity[];
  const rows = browserActivityRows(activity, {now: NOW, lang: 'ko'});
  expect(rows.map(row => [row.id, row.icon, row.textKey, row.time])).toEqual([
    ['a1', 'fill', 'fillDone', '12초 전'], ['a3', 'select', 'rejected', '1분 전'], ['a2', 'click', 'clickDone', '1시간 전'],
  ]);
  expect(rows[2]!.named).toBe(true);
  expect(rows[1]!.named).toBe(false);
  expect(rows[0]!.timeTitle).toBe(browserAbsoluteTime(NOW - 12_000, 'ko'));
  expect(browserActivityRows(undefined)).toEqual([]);
  // The bar's own detail is the AI's last action, so a person reads it without opening the drawer.
  expect(browserControlView(base({owner: 'agent', activity}))).toMatchObject({detail: {group: 'activity', textKey: 'fillDone', params: {target: '쿠폰'}}, activityCount: 3});
  // Relative time speaks the app language and never shows a negative age.
  expect(browserRelativeTime(NOW - 12_000, {now: NOW, lang: 'en'})).toBe('12 seconds ago');
  expect(browserRelativeTime(NOW - 7_200_000, {now: NOW, lang: 'ko'})).toBe('2시간 전');
  expect(browserRelativeTime(NOW - 3 * 86_400_000, {now: NOW, lang: 'ja'})).toContain('3');
  expect(browserRelativeTime(NOW + 5_000, {now: NOW, lang: 'ko'})).toBe('0초 전');
});

test('a recovery card is titled by what the person saw, never by the source enum', () => {
  const card = browserRecoveryCard({id: 'rec-1', profileName: '결제 QA', source: 'owned', pageTitle: '결제 페이지', pageUrl: 'https://shop.example.com/checkout', updatedAt: NOW - 7_200_000, unknown: 2}, {now: NOW, lang: 'ko'});
  expect(card).toMatchObject({id: 'rec-1', title: '결제 페이지', host: 'shop.example.com', unknown: 2, time: '2시간 전', sourceKey: 'sourceOwned', monogram: '결'});
  expect(card.timeTitle).toBe(browserAbsoluteTime(NOW - 7_200_000, 'ko'));
  expect(JSON.stringify(card)).not.toContain('"owned"');
  // No page title: the host, then the profile name. A broken URL never throws.
  expect(browserRecoveryCard({id: 'r2', profileName: '내 Chrome', source: 'chrome', pageUrl: 'https://a.example.com/x', updatedAt: NOW, unknown: 0}, {now: NOW, lang: 'ko'}))
    .toMatchObject({title: 'a.example.com', monogram: 'A', sourceKey: 'sourceChrome', unknown: 0});
  expect(browserRecoveryCard({id: 'r3', profileName: '내 Chrome', source: 'chrome', pageUrl: 'not a url', updatedAt: NOW, unknown: -3}, {now: NOW, lang: 'ko'}))
    .toMatchObject({title: '내 Chrome', host: '', unknown: 0});
  expect(resolve('activity', 'untrustedNote')).toContain('그대로 믿지 마세요');
});

// ── K2: what the rendered control surface prints ──────────────────────────────────────────────────────────────────
const OWNERS: BrowserOwner[] = ['human', 'observing', 'agent', 'taking', 'disconnected'];
const LANGS = APP_LANGUAGES.map(item => item.id) as Lang[];
const REQUEST_IDS = ['req-a1f00d', 'req-b2e11c', 'req-c3d22b', 'req-d4c33a'];
const PROTOCOL_IDS = ['ws-7f3a91', 'sess-9c0e', 'tgt-41d2', 'prof-58aa', 'obs-6b7c', 'page-0e1f', 'grant_5f6e7d', '4242'];
const RECEIPTS: Array<BrowserReceipt | null> = [null,
  {id: REQUEST_IDS[0]!, state: 'completed', action: 'fill', target: {role: 'textbox', name: '쿠폰 코드'}, at: NOW - 12_000},
  {id: REQUEST_IDS[1]!, state: 'unknown', action: 'click', target: {role: 'button', name: '주문하기'}, at: NOW - 4_000},
  {id: REQUEST_IDS[2]!, state: 'rejected', action: 'select', at: NOW - 60_000}];
const ACTIVITY: BrowserActivity[] = [
  {id: REQUEST_IDS[0]!, state: 'completed', action: 'fill', target: {role: 'textbox', name: '쿠폰 코드'}, at: NOW - 12_000},
  {id: REQUEST_IDS[3]!, state: 'reviewed', action: 'click', target: {role: 'button', name: '적용'}, at: NOW - 3_600_000},
];
const page = (over: Partial<WorkroomBrowserPageState> = {}): WorkroomBrowserPageState =>
  ({phase: 'ready', failure: null, error: '', popups: 0, notice: null, tabs: [], active: 'main', native: null, ...over} as WorkroomBrowserPageState);
const workspace = (owner: BrowserOwner, source: 'owned' | 'chrome', receipt: BrowserReceipt | null, over: Partial<BrowserWorkspace> = {}): BrowserWorkspace => ({
  id: PROTOCOL_IDS[0]!, sessionId: PROTOCOL_IDS[1]!, targetId: PROTOCOL_IDS[2]!, profileId: PROTOCOL_IDS[3]!, profileName: '결제 QA', source,
  page: {id: PROTOCOL_IDS[5]!, title: 'Example Shop', url: 'https://shop.example.com/cart?coupon=WELCOME10'}, owner, epoch: 4242,
  observation: {id: PROTOCOL_IDS[4]!, url: 'https://shop.example.com/cart', title: 'Example Shop', text: '[0] textbox "쿠폰 코드" value="WELCOME10"',
    elements: [], capturedAt: '2026-10-25T12:00:00.000Z', untrusted: true},
  connection: 'connected', profileVerification: 'user-confirmed', activity: ACTIVITY, ...(receipt ? {receipt} : {}), ...over,
});
// One scenario per message kind of BROWSER_MESSAGE_PRIORITY (transition shows once the owner is observing or taking).
type Scenario = {name: (typeof BROWSER_MESSAGE_PRIORITY)[number]; signals?: WorkroomBrowserControlSignals; page?: WorkroomBrowserPageState; ws?: Partial<BrowserWorkspace>; busy?: boolean};
const SCENARIOS: Scenario[] = [
  {name: 'owner'},
  {name: 'error', signals: {errorCode: 'take-control-first'}},
  {name: 'transition', busy: true},
  {name: 'disconnected', ws: {connection: 'disconnected'}},
  {name: 'popup', page: page({popups: 1}), signals: {popupHost: 'accounts.google.com'}},
  {name: 'waiting', signals: {waiting: {reason: 'login', at: NOW - 2_000}}},
  {name: 'notice', page: page({notice: 'invoice.pdf'}), signals: {handoffReady: true}},
  {name: 'blocked', signals: {blockedAt: NOW - 1_000}},
];
const noop = () => {};
const ACTIONS = {take: noop, resume: noop, detach: noop, settle: noop, grant: noop, handoff: noop, reconnect: noop, retryConnect: noop,
  retryGrant: noop, closePopups: noop, openAddress: noop};
const renderControl = (lang: Lang, ws: BrowserWorkspace, scenario: Scenario) => renderToStaticMarkup(createElement(WorkroomBrowserFrameControl, {
  lang, now: NOW, actions: ACTIONS, signals: scenario.signals,
  state: {source: ws.source ?? 'owned', workspace: ws, busy: !!scenario.busy, page: scenario.page ?? page()},
}));
test('an open close-all confirmation follows current ownership, connection, busy and native admission locks', () => {
  const cases: Array<{owner?: BrowserOwner; connection?: BrowserWorkspace['connection']; busy?: boolean; phase?: WorkroomBrowserPageState['phase']; reason: string | null}> = [
    {reason: null},
    {owner: 'agent', reason: copy.owner.blockedClick},
    {owner: 'observing', reason: copy.owner.disabledBusy},
    {owner: 'taking', reason: copy.owner.disabledBusy},
    {owner: 'disconnected', reason: copy.owner.disconnectedOwned},
    {connection: 'disconnected', reason: copy.owner.disconnectedOwned},
    {busy: true, reason: copy.owner.disabledBusy},
    {phase: 'profile', reason: copy.owner.disabledBusy},
    {phase: 'closing', reason: copy.owner.disabledBusy},
    ...(['navigating', 'target', 'loading', 'connecting'] as const).map(phase => ({phase, reason: null})),
  ];
  for (const item of cases) {
    const html = renderToStaticMarkup(createElement(WorkroomBrowserFrameControl, {
      lang: 'ko', actions: ACTIONS,
      state: {source: 'owned', workspace: workspace(item.owner ?? 'human', 'owned', null, {connection: item.connection ?? 'connected'}), busy: !!item.busy, page: page({phase: item.phase ?? null})},
      confirm: {kind: 'close-all', count: 2, onCancel: noop, onConfirm: noop},
    }));
    const button = /<button[^>]*data-testid="workroom-browser-close-all-confirm"[^>]*>/.exec(html)![0];
    expect(button.includes('disabled=""')).toBe(item.reason !== null);
    if (item.reason) {
      expect(button).toContain(`title="${item.reason}"`);
      expect(button).toContain('aria-describedby=');
      expect(html).toContain(`>${item.reason}</span>`);
    }
    expect(/<button[^>]*data-testid="workroom-browser-close-all-cancel"[^>]*>/.exec(html)![0]).not.toContain('disabled=');
  }
});
test('close-all click rechecks the current lock before invoking its destructive callback', () => {
  let calls = 0;
  const state: WorkroomBrowserControlState = {source: 'owned', workspace: workspace('human', 'owned', null), busy: false, page: page()};
  const confirmation = browserControlCloseAction(state, () => calls++);
  expect(confirmation.reason).toBeNull();
  // A lock arriving after the question opened must block even a direct handler invocation.
  for (const owner of ['agent', 'observing', 'taking', 'disconnected'] as const) {
    state.workspace = {...state.workspace, owner};
    confirmation.onClick();
  }
  state.workspace = {...state.workspace, owner: 'human', connection: 'disconnected'};
  confirmation.onClick();
  state.workspace = {...state.workspace, connection: 'connected'};
  state.busy = true;
  confirmation.onClick();
  state.busy = false;
  for (const phase of ['profile', 'closing'] as const) {
    state.page = page({phase});
    confirmation.onClick();
  }
  expect(calls).toBe(0);
  for (const phase of [null, 'navigating', 'target', 'loading', 'connecting'] as const) {
    state.page = page({phase});
    confirmation.onClick();
  }
  expect(calls).toBe(5);
});
const TECHNICAL = /<details[^>]*data-testid="workroom-browser-technical"[^>]*>[\s\S]*?<\/details>/;
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** What a person can read: text, tooltips and accessible names — everything outside 「기술 정보」. */
function readable(markup: string) {
  const outside = markup.replace(TECHNICAL, '');
  const attrs = [...outside.matchAll(/\s(?:title|aria-label)="([^"]*)"/g)].map(match => match[1]!);
  return decode([outside.replace(/<[^>]+>/g, ' '), ...attrs].join(' ')).replace(/\s+/g, ' ');
}

test('the control renders no enum, id, grant, epoch or raw error over the full owner × source × message × receipt matrix', () => {
  const kinds = new Set<string>();
  let renders = 0;
  for (const lang of LANGS) for (const owner of OWNERS) for (const source of ['owned', 'chrome'] as const)
  for (const scenario of SCENARIOS) for (const receipt of RECEIPTS) {
    const ws = workspace(owner, source, receipt, scenario.ws);
    const markup = renderControl(lang, ws, scenario), text = readable(markup);
    renders++;
    kinds.add(/data-kind="([^"]+)"/.exec(markup)![1]!);
    const where = `${lang}/${owner}/${source}/${scenario.name}/${receipt?.state ?? 'none'}`;
    // No protocol value reaches what a person reads; ids and the address live only in 「기술 정보」.
    for (const id of [...REQUEST_IDS, ...PROTOCOL_IDS]) expect(text.includes(id) ? `${where}: ${id}` : '').toBe('');
    expect(text).not.toContain('shop.example.com/cart?');
    for (const raw of ['Error:', 'undefined', 'null', 'NaN', '[object']) expect(text.includes(raw) ? `${where}: ${raw}` : '').toBe('');
    expect(/\{\w+\}/.test(text) ? `${where}: unfilled ${text}` : '').toBe('');
    // Kebab-case codes (take-control-first, target-lost, load-refused…) are classified and worded, never printed.
    for (const code of BROWSER_ERROR_CODES) expect(text.includes(code) ? `${where}: ${code}` : '').toBe('');
    // In languages that do not write English, any Latin enum word is a leak.
    if (lang === 'ko' || lang === 'ja' || lang === 'zh-CN') {
      for (const word of [...OWNERS, 'completed', 'unknown', 'rejected', 'reviewed', 'owned', 'chrome', 'connected', 'unverified', 'user-confirmed'])
        expect(new RegExp(`(^|[^A-Za-z-])${word}([^A-Za-z-]|$)`).test(text) ? `${where}: ${word}` : '').toBe('');
    }
    // Every request id the drawer knows is in 「기술 정보」.
    const technical = TECHNICAL.exec(markup)?.[0] ?? '';
    for (const row of [...ACTIVITY, ...(receipt ? [receipt] : [])]) expect(technical).toContain(row.id);
    // 「직접 하기」 is never offered while a person holds the page (in the bar or in a drawer row).
    if (ws.owner === 'human' && ws.connection === 'connected') {
      expect(markup).not.toContain('data-testid="workroom-browser-take"');
      expect(markup).not.toContain('data-testid="workroom-browser-check"');
    }
    // An unknown result opens the drawer and offers to look first; the observation stays closed.
    if (receipt?.state === 'unknown') {
      const drawer = /<section[^>]*data-testid="workroom-browser-activity"[^>]*>/.exec(markup)![0];
      expect(drawer).not.toContain('hidden');
      const row = /<li[^>]*data-receipt-state="unknown"[^>]*>[\s\S]*?<\/li>/.exec(markup)![0];
      if (ws.owner === 'agent' && ws.connection === 'connected') expect(row.indexOf('workroom-browser-check')).toBeLessThan(row.indexOf('workroom-browser-settle'));
      expect(row).toContain('workroom-browser-settle');
    }
    expect(/<details[^>]*data-testid="workroom-browser-observation-details"[^>]*\sopen/.test(markup)).toBe(false);
    // An alert is the error line itself, with its code for tests and logs.
    if (scenario.name === 'error' && !/data-kind="(transition)"/.test(markup)) expect(markup).toMatch(/role="alert"[^>]*data-error-code="take-control-first"/);
    for (const alert of markup.matchAll(/<[^>]*role="alert"[^>]*>/g)) expect(alert[0]).toContain('data-error-code=');
  }
  expect(renders).toBe(7 * 5 * 2 * 8 * 4);
  expect([...kinds].sort()).toEqual([...BROWSER_MESSAGE_PRIORITY].sort());
}, 15_000); // Exhaustive behavior coverage, with room for concurrent GUI/compiler CPU load.

test('an unknown row names the element and asks to look before settling, in the order the host allows', () => {
  const unknown: BrowserReceipt = {id: 'req-u1', state: 'unknown', action: 'click', target: {role: 'button', name: '주문하기'}, at: NOW - 4_000};
  const actionsOf = (owner: BrowserOwner) => browserActivityRows(ACTIVITY, {now: NOW, lang: 'ko', owner, receipt: unknown})
    .find(row => row.id === 'req-u1')!.actions.map(action => [action.action, action.disabled, action.disabledReasonKey ?? '']);
  // The receipt joins the drawer even before the host lists it as activity, newest first.
  expect(browserActivityRows(ACTIVITY, {now: NOW, lang: 'ko', owner: 'agent', receipt: unknown}).map(row => row.id)).toEqual(['req-u1', REQUEST_IDS[0]!, REQUEST_IDS[3]!]);
  // While the AI holds the page: look first; 「확인했어요」 waits (the host settles only for a person) and says why.
  expect(actionsOf('agent')).toEqual([['take', false, ''], ['settle', true, 'blockedClick']]);
  expect(actionsOf('observing')).toEqual([['take', false, ''], ['settle', true, 'blockedClick']]);
  expect(actionsOf('taking')).toEqual([['take', true, 'disabledBusy'], ['settle', true, 'blockedClick']]);
  // A person already holds it: only 「확인했어요」, as the primary verb.
  expect(actionsOf('human')).toEqual([['settle', false, '']]);
  expect(actionsOf('disconnected')).toEqual([['settle', false, '']]);
  expect(browserActivityRows([], {owner: 'human', receipt: unknown})[0]!.actions[0]!.primary).toBe(true);
  // Only the current receipt carries verbs; an older unknown row is history.
  const old = {...unknown, id: 'req-u0', at: NOW - 90_000};
  expect(browserActivityRows([old], {now: NOW, owner: 'agent', receipt: unknown}).find(row => row.id === 'req-u0')!.actions).toEqual([]);
  // Rendered: the sentence names the element, and 「직접 확인하기」 comes before 「확인했어요」.
  const ko = workroomBrowserUiCopy('ko');
  const markup = renderControl('ko', workspace('agent', 'owned', unknown), {name: 'owner'});
  const row = /<li[^>]*data-receipt-state="unknown"[^>]*>[\s\S]*?<\/li>/.exec(markup)![0];
  expect(readable(row)).toContain('「주문하기」');
  expect(readable(row)).toContain(ko.activity.checkMyself);
  expect(row.indexOf(ko.activity.checkMyself)).toBeLessThan(row.indexOf(ko.activity.checkedIt));
  expect(row).toMatch(/data-testid="workroom-browser-settle"[^>]*disabled/);
  // The toggle names the count, and the observation is behind its own closed disclosure.
  expect(markup).toContain(`aria-label="${ko.activity.toggle.replace('{n}', '3')}"`);
  expect(markup).toContain('data-testid="workroom-browser-observation"');
  expect(markup).not.toMatch(/<details[^>]*workroom-browser-observation-details[^>]*open/);
});

test('unnamed elements use app-language role names, with a safe fallback for unknown roles', () => {
  for (const lang of LANGS) for (const role of ['textbox', 'button', 'link', 'checkbox', 'combobox', 'custom-role', '']) {
    const ui = workroomBrowserUiCopy(lang);
    const receipt: BrowserReceipt = {id: 'req-unnamed', state: 'completed', action: 'fill', target: {role, name: ''}, at: NOW};
    const ws = workspace('agent', 'owned', receipt, {activity: [receipt as BrowserActivity], observation: null});
    const text = readable(renderControl(lang, ws, {name: 'owner'}));
    const roleName = (ui.activity.roles as Record<string, string>)[role];
    expect(text).toContain(roleName ? ui.activity.unnamedTarget.replace('{role}', roleName) : ui.activity.unnamedElement);
    expect(text).not.toContain('{role}');
    expect(text).not.toContain('custom-role');
    if (role && (lang === 'ko' || lang === 'ja' || lang === 'zh-CN')) expect(text).not.toContain(role);
  }
});

test('current receipts override stale activity and in-flight calls disable every row verb', () => {
  const previous: BrowserActivity = {id: 'req-stale', state: 'completed', action: 'click', target: {role: 'button', name: '주문하기'}, at: NOW - 4000};
  const unknown: BrowserReceipt = {id: previous.id, state: 'unknown'};
  const row = browserActivityRows([previous], {now: NOW, lang: 'en', owner: 'human', receipt: unknown})[0]!;
  expect(row).toMatchObject({state: 'unknown', textKey: 'unknown', current: true, params: {target: '주문하기'}, time: '4 seconds ago'});
  expect(row.actions.map(action => [action.action, action.disabled])).toEqual([['settle', false]]);
  const reviewed = browserActivityRows([previous], {receipt: {...unknown, state: 'reviewed'}})[0]!;
  expect(reviewed).toMatchObject({state: 'reviewed', reviewed: true, actions: []});
  for (const owner of OWNERS) {
    const busyRows = browserActivityRows([previous], {owner, receipt: unknown, busy: true});
    expect(busyRows[0]!.actions.length).toBeGreaterThan(0);
    expect(busyRows[0]!.actions.every(action => action.disabled)).toBe(true);
    const view = browserControlView(base({owner, busy: true, grantFailed: true}));
    expect(view.primary?.disabled).toBe(true);
    if (owner !== 'agent') expect(view.secondary?.action).not.toBe('retry-grant');
  }
  expect(browserControlView(base({source: 'chrome', profileVerification: 'unverified'})).primary)
    .toMatchObject({action: 'handoff', disabled: true, disabledReasonKey: 'unverified'});
});

test('state cards explain the next step in every app language and errors never print raw exceptions', () => {
  for (const lang of LANGS) {
    const ui = workroomBrowserUiCopy(lang),errors = workroomBrowserPageErrorCopy(lang);
    const unavailable = renderToStaticMarkup(createElement(UnavailableState, {lang, onConnectChrome: noop}));
    expect(readable(unavailable)).toContain(ui.unavailable.title);
    expect(readable(unavailable)).toContain(ui.unavailable.connectMyChrome);
    expect(unavailable).not.toContain('workroom-browser-source-owned');
    const empty = renderToStaticMarkup(createElement(EmptyState, {lang, sessionId: 's', targetId: 't', request: () => Promise.reject(new Error('not called')),
      source: 'owned', recovery: null, onChooseRecovery: noop, onChooseSource: noop, suggestions: [{label: 'Project preview', url: 'http://localhost:9000/'}], onSuggestion: noop}));
    expect(readable(empty)).toContain(ui.empty.title);
    expect(empty).toContain('data-testid="workroom-browser-suggestion"');
    expect(empty).toContain('aria-pressed="true"');
    const chromeOnly = renderToStaticMarkup(createElement(EmptyState, {lang, sessionId: 's', targetId: 't', request: () => Promise.reject(new Error('not called')),
      source: 'chrome', recovery: null, onChooseRecovery: noop, onChooseSource: noop, ownedAvailable: false}));
    expect(chromeOnly).not.toContain('workroom-browser-source-owned');
    expect(chromeOnly).toContain('data-testid="workroom-browser-source-chrome"');
    for (const code of BROWSER_LOAD_ERROR_CODES) {
      const error = renderToStaticMarkup(createElement(PageErrorCard, {lang, host: 'preview.example.com', code, onRetry: noop, onEditAddress: noop}));
      expect(readable(error)).toContain(errors.retry);
      expect(readable(error)).toContain(errors.editAddress);
      expect(error).toContain(`role="alert" data-error-code="${code}"`);
      expect(readable(error)).not.toContain(code);
    }
    const raw = 'Error: private-native-diagnostic grant_123 epoch=4242';
    const notice = renderToStaticMarkup(createElement(WorkroomBrowserControlMessages, {lang, error: raw, notice: ''}));
    expect(notice).toContain('data-error-code="generic"');
    expect(readable(notice)).not.toContain(raw);
    expect(readable(notice)).not.toContain('grant_123');
    const placeholder = renderToStaticMarkup(createElement(PagePlaceholder, {lang, title: 'Preview', host: 'preview.example.com', loading: true}));
    expect(placeholder).toContain('aria-hidden="true"');
    expect(readable(placeholder)).toContain('Preview');
  }
});

test('recovery cards date themselves with Intl in every app language and never print the source enum', () => {
  const records: BrowserRecoverySummary[] = [
    {id: 'rec-1', sessionId: 's', profileId: 'p1', profileName: '결제 페이지 QA', source: 'owned', pageId: 'pg-1', updatedAt: NOW - 7_200_000, unknown: 1},
    {id: 'rec-2', sessionId: 's', profileId: 'p2', profileName: 'Work', source: 'chrome', pageId: null, updatedAt: NOW - 86_400_000, unknown: 0},
    {id: 'rec-3', sessionId: 's', profileId: 'p3', profileName: '관리자 주문 목록', source: 'owned', pageId: null, updatedAt: NOW - 45_000, unknown: 0},
  ];
  const seen = new Set<string>();
  for (const lang of LANGS) {
    const ui = workroomBrowserUiCopy(lang);
    const markup = renderToStaticMarkup(createElement(WorkroomBrowserRecoveries, {lang, sessionId: 's', targetId: 't', now: NOW, records,
      request: () => Promise.reject(new Error('not called')), onChoose: noop}));
    // Collapsed by default, one card per record with its id for 「이어가기」.
    expect(markup).toMatch(/^<details[^>]*data-testid="workroom-browser-recoveries"/);
    expect(markup).not.toMatch(/^<details[^>]*\sopen/);
    expect([...markup.matchAll(/data-testid="workroom-browser-recover" data-recovery-id="([^"]+)"/g)].map(match => match[1])).toEqual(['rec-1', 'rec-2', 'rec-3']);
    const times = [...markup.matchAll(/<time dateTime="([^"]+)" title="([^"]+)">([^<]+)<\/time>/g)];
    expect(times.length).toBe(3);
    times.forEach((match, index) => {
      const at = records[index]!.updatedAt;
      expect(match[1]).toBe(new Date(at).toISOString());
      expect(decode(match[2]!)).toBe(browserAbsoluteTime(at, lang));
      expect(decode(match[3]!)).toBe(browserRelativeTime(at, {now: NOW, lang}));
      seen.add(decode(match[3]!));
    });
    const text = readable(markup);
    // The metadata has no address or title, so each card is its profile name and says which browser in words.
    for (const record of records) expect(text).toContain(record.profileName);
    expect(text).toContain(ui.owner.sourceOwned);
    expect(text).toContain(ui.owner.sourceChrome);
    expect(text).toContain(ui.recoveries.unknownChip.replace('{n}', '1'));
    expect(/(^|[^A-Za-z])(owned|chrome)([^A-Za-z]|$)/.test(text)).toBe(false);
    for (const id of ['p1', 'p2', 'pg-1', 'rec-1']) expect(text.includes(` ${id} `)).toBe(false);
  }
  // Seven languages, seven different wordings of each age.
  expect(seen.size).toBe(7 * 3);
  // Dates go through Intl in the app language, never the device's toLocaleString.
  for (const file of ['src/WorkroomBrowserRecoveries.tsx', 'src/WorkroomBrowserFrameStates.tsx', 'src/WorkroomBrowserFrameControl.tsx', 'src/workroomBrowserPresentation.ts'])
    expect(readFileSync(new URL(file, projectRoot), 'utf8')).not.toContain('toLocaleString');
});

test('the control stylesheet uses tokens only, honours reduced motion and gives coarse pointers 44px', () => {
  const css = readFileSync(new URL('src/WorkroomBrowserFrameControl.css', projectRoot), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  expect(css.match(/rgba\(/g)).toBeNull();
  expect(css.match(/rgb\(\s*\d/g)).toBeNull();
  expect(css.match(/hsla?\(/g)).toBeNull();
  expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  expect(css).toMatch(/@media \(max-width:640px\),\(pointer:coarse\)\{[^}]*min-height:44px/);
  // Only colour, opacity, outline and transform animate: nothing the native page's frame follows.
  for (const match of css.matchAll(/transition:([^;}]+)/g)) for (const part of match[1]!.split(','))
    expect(['background-color', 'border-color', 'color', 'opacity', 'transform', 'box-shadow', 'none']).toContain(part.trim().split(/\s+/)[0]!);
});
