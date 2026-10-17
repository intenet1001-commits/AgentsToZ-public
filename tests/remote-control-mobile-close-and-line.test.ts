/**
 * S4.6 (w11): the same-Wi-Fi QR page's 「세션 종료」 asks first, and its input is a textarea — Enter sends, Shift+Enter is a
 * new line, an IME composition is never sent, and a multi-line draft goes out once.
 *
 * The handlers are lifted verbatim out of the shipped bundle and run against stubs, as in remote-control-mobile-retry.
 */
import {describe, expect, test} from 'bun:test';
import {REMOTE_CONTROL_MOBILE_HTML, REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

function lift(startMarker: string, endMarker: string): string {
  const start = REMOTE_CONTROL_MOBILE_JS.indexOf(startMarker);
  expect(start).toBeGreaterThan(0);
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return REMOTE_CONTROL_MOBILE_JS.slice(start, end);
}

function closeHandler(confirmed: boolean) {
  const source = lift('async function terminalCloseSelected(', "document.querySelector('#terminal-close').onclick=terminalCloseSelected");
  const build = new Function('confirmed', `
    const requests = [], cancelled = [], asked = [];
    let terminalSelected = 'session-0001', terminalConnectionGeneration = 1, terminalGeneration = 0, terminalTimer = 0;
    const terminalClosing = new Set();
    const terminalError = {textContent: ''};
    function confirm(message) { asked.push(message); return confirmed; }
    function terminalCancelUnsent(id) { cancelled.push(id); }
    async function terminalRequest(request) { requests.push(request); return {}; }
    function terminalSelect(id) { terminalSelected = id; }
    async function terminalList() {}
    async function terminalPoll() {}
    ${source}
    return {close: () => terminalCloseSelected(), state: () => ({requests, cancelled, asked, selected: terminalSelected})};
  `);
  return build(confirmed);
}

function lineHandlers(options: {submission: boolean; value: string}) {
  const send = lift('async function terminalSendLine(', "document.querySelector('#terminal-send').onclick=terminalSendLine");
  const keydown = lift('function terminalLineKeydown(', 'terminalLine.onkeydown=terminalLineKeydown');
  const build = new Function('options', `
    const submitted = [], typed = [];
    const field = {value: options.value, focus() {}}, button = {disabled: false};
    const nodes = {'#terminal-line': field, '#terminal-send': button, '#terminal-project': {value: 'target-a'}, '#terminal-agent': {value: 'codex'}};
    const document = {querySelector: selector => nodes[selector]};
    let terminalLineSending = false, terminalLineGeneration = 1, terminalGeneration = 1;
    let terminalSelected = 'session-0001', terminalPendingSubmission = null, terminalDevice = 'lan';
    const terminalClosing = new Set();
    const terminalSubmissionFeatures = new Map([['lan', options.submission]]);
    const terminalRouteAgent = {value: 'codex'};
    const terminalError = {textContent: ''};
    function terminalRouteProject() { return undefined; }
    function terminalRouteSource() { return {targetId: 'target-a', agent: 'codex'}; }
    function terminalSetRoute() {}
    function terminalLegacySuspectAllows() { return true; }
    function terminalSubmissionStorage() { return {}; }
    // The whole-request submission keeps the line busy until its receipt, as the real one does.
    async function terminalSubmitLine(value) { submitted.push(value); }
    function terminalInput(data, receipt) { typed.push(data); receipt?.(true); return true; }
    async function terminalDeliverRoute() { throw new Error('no route in this test'); }
    ${send}
    ${keydown}
    const key = (init) => { const event = {key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, defaultPrevented: false, ...init, preventDefault() { this.defaultPrevented = true; }}; terminalLineKeydown(event); return event; };
    return {key, field, state: () => ({submitted, typed, sending: terminalLineSending})};
  `);
  return build(options);
}

describe('LAN page 「세션 종료」', () => {
  test('declining the confirmation sends nothing and keeps the session', async () => {
    const api = closeHandler(false);
    await api.close();
    const state = api.state();
    expect(state.asked).toHaveLength(1);
    expect(state.requests).toEqual([]);
    expect(state.cancelled).toEqual([]);
    expect(state.selected).toBe('session-0001');
  });
  test('confirming closes the selected session once', async () => {
    const api = closeHandler(true);
    await api.close();
    expect(api.state().requests).toEqual([{operation: 'close', sessionId: 'session-0001'}]);
  });
  test('the close button is not in the key row', () => {
    const keys = REMOTE_CONTROL_MOBILE_HTML.slice(REMOTE_CONTROL_MOBILE_HTML.indexOf('id="terminal-enter"'));
    const row = keys.slice(0, keys.indexOf('</div>') >= 0 ? keys.indexOf('</div>') : keys.length);
    expect(row.includes('id="terminal-close"')).toBe(false);
    expect(REMOTE_CONTROL_MOBILE_HTML).toContain('id="terminal-close"');
  });
});

describe('LAN page input line', () => {
  test('the input is a textarea', () => {
    expect(REMOTE_CONTROL_MOBILE_HTML).toMatch(/<textarea id="terminal-line"/);
  });
  test('Enter sends a multi-line draft once as a whole request; a second Enter while it is sending sends nothing', () => {
    const api = lineHandlers({submission: true, value: '첫 줄\n둘째 줄'});
    const first = api.key({});
    expect(first.defaultPrevented).toBe(true);
    api.key({});
    expect(api.state().submitted).toEqual(['첫 줄\n둘째 줄']);
    expect(api.state().typed).toEqual([]);
  });
  test('without whole-request submissions the multi-line draft is typed once with one Enter at the end', () => {
    const api = lineHandlers({submission: false, value: '첫 줄\n둘째 줄'});
    api.key({});
    expect(api.state().typed).toEqual(['첫 줄\n둘째 줄\r']);
  });
  test('Shift+Enter is a new line and an IME composition is not sent', () => {
    const api = lineHandlers({submission: true, value: '한글 조합'});
    const shift = api.key({shiftKey: true});
    expect(shift.defaultPrevented).toBe(false);
    const composing = api.key({isComposing: true});
    expect(composing.defaultPrevented).toBe(false);
    const ime = api.key({keyCode: 229});
    expect(ime.defaultPrevented).toBe(false);
    expect(api.state().submitted).toEqual([]);
  });
});
