import {describe, expect, test} from 'bun:test';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

function harness(confirmResult = true) {
  const start = REMOTE_CONTROL_MOBILE_JS.indexOf('function handleActionResult(message) {');
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf('/**\n * Resume an enumeration', start);
  if (start < 0 || end < 0) throw new Error('Missing shipped LAN action handler');
  const factory = new Function('confirmResult', `
    const events = [], hostName = {textContent: 'Mac'};
    let inFlight = true, pendingActionId = 'start-id', lastActionCode = 'codex.thread.start', lastActionName = 'Codex', lastRequestedPage = null;
    let currentCodexNewIntent = {actionId: 'start-id'}, currentCodexControlId = 'control', codexAcknowledgingReview = false;
    let projects = [], nextProjectPage = null, totalProjectCount = 0, workspaceRootsRequested = true, currentProjectCreateIntent = null;
    let codexNewSupported = true;
    const RATE_LIMIT_RETRY_MS = 11000, opsStatus = {textContent:''};
    function actionDone(action) { return 'done:' + action; }
    function setBusy(value) { inFlight = value; if (!value) pendingActionId = null; }
    function sendCodexFollowup(action, input) { events.push(['followup', action, input]); inFlight = true; pendingActionId = 'next-id'; lastActionCode = action; return true; }
    function codexNewIntentStore() { return {complete(intent) { events.push(['complete', intent.actionId]); }}; }
    function recordError(_context, error) { events.push(['error', error && error.code]); }
    function notify(value) { events.push(['notice', value]); }
    function confirm() { events.push(['confirm']); return confirmResult; }
    function renderProjects() {} function updateProject() {} function scheduleEnumerationRetry() {}
    function projectIntentStore() { return {complete() {}}; } function terminalReady() {} function showWorkspaceTab() {}
    function opsStatusLine() { return ''; } function setTimeout() {} function sendAction() {}
    const document = {querySelector() { return {replaceChildren(){},append(){},add(){}}; }, createElement() { return {append(){}}; }};
    ${REMOTE_CONTROL_MOBILE_JS.slice(start, end)}
    return {events, send(message) { handleActionResult(message); }, snapshot() { return {inFlight,pendingActionId}; }};
  `);
  return factory(confirmResult) as {events: unknown[][]; send(message: object): void; snapshot(): {inFlight: boolean; pendingActionId: string | null}};
}

describe('LAN actual new Codex action result handler', () => {
  test('success waits for acknowledgement; late unrelated replies cannot unlock it', () => {
    const h = harness();
    h.send({actionId:'old-id', ok:true, project:null});
    expect(h.events).toEqual([]); expect(h.snapshot().pendingActionId).toBe('start-id');
    h.send({actionId:'start-id', ok:true, project:null});
    expect(h.events).toEqual([['followup','codex.thread.ack.v2','start-id']]);
    h.send({actionId:'next-id', ok:true, project:null});
    expect(h.events).toContainEqual(['complete','start-id']);
  });

  test('review requires confirmation and acknowledges the original request, not the new attempt', () => {
    for (const allowed of [false, true]) {
      const h = harness(allowed);
      h.send({actionId:'start-id', ok:false, error:{code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'}});
      expect(h.events).toContainEqual(['followup','codex.thread.review.v2',undefined]);
      h.send({actionId:'next-id', ok:true, codexNewChatReceipt:{actionId:'original-id',state:'completed'}});
      expect(h.events).toContainEqual(['confirm']);
      expect(h.events.some(event => event[0] === 'followup' && event[1] === 'codex.thread.ack.v2')).toBe(allowed);
      if (allowed) expect(h.events).toContainEqual(['followup','codex.thread.ack.v2','original-id']);
      expect(h.events.some(event => event[0] === 'complete')).toBe(false);
    }
  });

  test('cancelled tombstone clears only the correlated request, unknown errors keep it', () => {
    const cancelled = harness();
    cancelled.send({actionId:'start-id',ok:false,error:{code:'CODEX_NEW_CHAT_NOT_SENT'}});
    expect(cancelled.events).toContainEqual(['complete','start-id']);
    const unknown = harness();
    unknown.send({actionId:'start-id',ok:false,error:{code:'CODEX_FIRST_TURN_FAILED'}});
    expect(unknown.events.some(event => event[0] === 'complete')).toBe(false);
  });
});
