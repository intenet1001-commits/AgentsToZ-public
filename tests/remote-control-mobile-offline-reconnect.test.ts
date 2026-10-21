/**
 * The same-Wi‑Fi QR page's reconnect, executed rather than grepped (pattern of
 * remote-control-mobile-retry.test.ts): the functions are lifted verbatim out of the shipped bundle.
 *
 * Before 2026-10-10 a phone with no network burned its five attempts, was told the Mac could not be
 * reached, and had its saved pairing wiped — a new QR at the Mac for the phone's own outage.
 */
import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_MOBILE_JS } from '../src/remoteControlMobilePage';
import { phoneIsOnline, phoneOfflineLabel, phoneOfflineLanNotice } from '../src/phoneNetwork';

type Timer = { at: number; run: () => void; cancelled: boolean };

function reconnector() {
  const start = REMOTE_CONTROL_MOBILE_JS.indexOf('function reconnectDelay()');
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf('function closeReasonMessage(', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const source = REMOTE_CONTROL_MOBILE_JS.slice(start, end);
  expect(source).toContain('function scheduleReconnect');
  expect(source).toContain('function reconnectWhenOnline');
  // The close decision and the 'offline' handler run here, not as copies.
  expect(source).toContain('function afterUnexpectedClose');
  expect(source).toContain('function phoneWentOffline');

  const timers: Timer[] = [];
  const log: string[] = [];
  const build = new Function('timers', 'log', 'nav', `
    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_BASE_DELAY_MS = 1000;
    const RECONNECT_MAX_DELAY_MS = 30000;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let sessionToken = '';
    let pairToken = '';
    let saved = 'saved-token';
    let socket = null;
    const WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
    const navigator = nav;
    const intro = { hidden: true };
    const introMessage = { textContent: '' };
    let status = '';
    const phoneOnline = (${phoneIsOnline.toString()});
    const phoneOfflineStatus = (${phoneOfflineLabel.toString()});
    const phoneOfflineIntro = (${phoneOfflineLanNotice.toString()});
    function setTimeout(run, at) { const entry = { at, run, cancelled: false }; timers.push(entry); return entry; }
    function clearTimeout(entry) { if (entry) entry.cancelled = true; }
    function setStatus(text) { status = text; }
    function notify(message) { log.push('notify:' + message); }
    function loadSavedSession() { return saved; }
    function clearSavedSession() { saved = ''; log.push('cleared'); }
    function attemptReconnect() { log.push('attempt'); socket = { readyState: WebSocket.CONNECTING }; }
    function connect() { log.push('connect'); socket = { readyState: WebSocket.CONNECTING }; }
    function closeReasonMessage(code) { return 'close ' + code; }
    ${source}
    return {
      schedule: () => scheduleReconnect(),
      online: () => reconnectWhenOnline(),
      socketClosed: () => { socket = { readyState: WebSocket.CLOSED }; },
      socketOpen: () => { socket = { readyState: WebSocket.OPEN }; sessionToken = 'T'; },
      setSaved: value => { saved = value; },
      setPairToken: value => { pairToken = value; },
      attempts: () => reconnectAttempts,
      status: () => status,
      saved: () => saved,
      intro: () => introMessage.textContent,
      introHidden: () => intro.hidden,
      closed: code => { socket = { readyState: WebSocket.CLOSED }; afterUnexpectedClose(code); },
      wentOffline: () => phoneWentOffline(),
      dropSession: () => { sessionToken = ''; },
    };
  `);
  const nav = { onLine: true };
  const api = build(timers, log, nav);
  const fire = () => {
    const pending = timers.filter(entry => !entry.cancelled);
    timers.length = 0;
    for (const entry of pending) entry.run();
    return pending.length;
  };
  return { api, timers, log, nav, fire };
}

describe('the QR page waits out the phone\'s own outage', () => {
  test('offline: no attempt is counted, nothing is cleared, the chip names the phone', () => {
    const { api, log, nav, fire } = reconnector();
    nav.onLine = false;
    for (let index = 0; index < 20; index += 1) { api.schedule(); fire(); api.socketClosed(); }
    expect(api.attempts()).toBe(0);
    expect(log).not.toContain('cleared');
    expect(log).not.toContain('attempt');
    expect(api.saved()).toBe('saved-token');
    expect(api.status()).toBe('휴대폰 오프라인');
    expect(api.intro()).toContain('QR을 다시 스캔할 필요는 없습니다');
    expect(api.intro()).toContain('저장된 연결로');
    // A paired page had hidden the intro; the explanation must be shown, not only written.
    expect(api.introHidden()).toBe(false);
  });

  test("'online' reconnects at once with the saved session", () => {
    const { api, log, nav, timers } = reconnector();
    nav.onLine = false;
    api.schedule();
    expect(timers.filter(entry => !entry.cancelled)).toHaveLength(0);
    nav.onLine = true;
    api.online();
    expect(log).toEqual(['attempt']);
    expect(api.attempts()).toBe(0);
  });

  test('the network dropping during a backoff wait does not spend that attempt', () => {
    const { api, log, nav, fire } = reconnector();
    api.schedule();
    nav.onLine = false;
    fire();
    expect(api.attempts()).toBe(0);
    expect(log).not.toContain('attempt');
    expect(api.status()).toBe('휴대폰 오프라인');
    nav.onLine = true;
    api.online();
    expect(log.filter(entry => !entry.startsWith('notify:'))).toEqual(['attempt']);
  });

  test("'online' with a pending backoff skips the wait instead of sitting out the delay", () => {
    const { api, log, timers } = reconnector();
    api.schedule();
    api.online();
    expect(log.filter(entry => !entry.startsWith('notify:'))).toEqual(['attempt']);
    expect(timers.filter(entry => !entry.cancelled)).toHaveLength(0);
  });

  test("'online' with the socket still open only restores the chip", () => {
    const { api, log } = reconnector();
    api.socketOpen();
    api.online();
    expect(log).toEqual([]);
    expect(api.status()).toBe('연결됨');
    expect(api.introHidden()).toBe(true);
  });

  test('an unspent QR token opened without a network connects when it returns', () => {
    const { api, log, nav } = reconnector();
    api.setSaved('');
    api.setPairToken('one-use-token');
    nav.onLine = false;
    api.schedule();
    nav.onLine = true;
    api.online();
    expect(log).toEqual(['connect']);
  });

  test('online and still failing: five counted attempts still end the saved session (unchanged)', () => {
    const { api, log, fire } = reconnector();
    for (let index = 0; index < 5; index += 1) { api.schedule(); fire(); api.socketClosed(); }
    expect(api.attempts()).toBe(5);
    api.schedule();
    expect(log).toContain('cleared');
    expect(api.status()).toBe('연결 실패');
  });

  test('connect()\'s real close path: an unspent QR opened offline waits for the network, then connects with that QR', () => {
    const { api, log, nav } = reconnector();
    api.setSaved('');
    api.setPairToken('one-use-token');
    nav.onLine = false;
    api.closed(1006);
    expect(api.status()).toBe('휴대폰 오프라인');
    expect(api.introHidden()).toBe(false);
    expect(api.intro()).toContain('이 QR로');
    expect(api.intro()).not.toContain('저장된');
    expect(log).not.toContain('cleared');
    nav.onLine = true;
    api.online();
    expect(log).toEqual(['connect']);
  });

  test('connect()\'s real close path online with no session and no QR still ends (unchanged)', () => {
    const { api, log } = reconnector();
    api.setSaved('');
    api.closed(1006);
    expect(api.status()).toBe('연결 종료');
    api.online();
    expect(log).toEqual([]);
  });

  test('connect()\'s real close path with a saved session goes through the offline-aware reconnect', () => {
    const { api, log, nav } = reconnector();
    nav.onLine = false;
    api.closed(1006);
    expect(api.status()).toBe('휴대폰 오프라인');
    expect(api.attempts()).toBe(0);
    expect(log).toContain('notify:close 1006');
  });

  test("the 'offline' event names the phone at once for a paired page, and leaves an unpaired page alone", () => {
    const paired = reconnector();
    paired.api.wentOffline();
    expect(paired.api.status()).toBe('휴대폰 오프라인');
    const unpaired = reconnector();
    unpaired.api.setSaved('');
    unpaired.api.wentOffline();
    expect(unpaired.api.status()).toBe('');
  });

  test('the page listens for the network and does not treat an offline socket error as a Mac error', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('window.addEventListener("online", reconnectWhenOnline);');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('window.addEventListener("offline", phoneWentOffline);');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('afterUnexpectedClose(event.code);');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('setStatus(phoneOnline() ? "연결 오류" : phoneOfflineStatus(), "offline")');
  });
});
