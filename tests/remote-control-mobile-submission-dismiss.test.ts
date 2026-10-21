/**
 * w2-followups #12: the LAN page's 「터미널 결과 확인했음」 after storage became blocked.
 *
 * Safari can block site data after the page loaded. A record written earlier then cannot be removed, and the old
 * handler kept the in-memory record whenever the storage write threw — the banner stayed and every later 「전송」 was
 * refused with 「앞서 보낸 요청의 결과를 먼저 확인하세요」 until a reload. The user already confirmed they checked the
 * terminal, so the page clears its own record either way and says the stored one may come back after a reload.
 *
 * The handler is lifted verbatim out of the shipped bundle and run against stubs, as in remote-control-mobile-retry.
 */
import {describe, expect, test} from 'bun:test';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

function dismissHandler(options: {writeThrows: boolean; confirmed?: boolean}) {
  const start = REMOTE_CONTROL_MOBILE_JS.indexOf('function terminalDismissSubmission(');
  expect(start).toBeGreaterThan(0);
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf("document.querySelector('#terminal-submission-dismiss').onclick", start);
  expect(end).toBeGreaterThan(start);
  const source = REMOTE_CONTROL_MOBILE_JS.slice(start, end);
  const writes: unknown[] = [];
  const build = new Function('options', 'writes', `
    let terminalPendingSubmission = {id: 'lan-' + 'a'.repeat(32), sessionId: 'session-0001', receipt: null};
    let terminalSubmissionBusy = false;
    const terminalSubmittedDrafts = new Map([[terminalPendingSubmission.id, 'draft']]);
    const terminalError = {textContent: ''};
    let renders = 0;
    const sessionStorage = {};
    const terminalSubmissions = {write(storage, key, value) { writes.push({key, value}); if (options.writeThrows) throw new Error('SecurityError'); }};
    function terminalSubmissionKey(sessionId) { return 'agentstoz:pending-submission:v1:lan:' + sessionId; }
    function terminalRenderSubmission() { renders++; }
    function confirm() { return options.confirmed !== false; }
    ${source}
    return {
      dismiss: () => terminalDismissSubmission(),
      state: () => ({pending: terminalPendingSubmission, drafts: terminalSubmittedDrafts.size, error: terminalError.textContent, renders}),
    };
  `);
  return {api: build(options, writes), writes};
}

describe('LAN page dismiss of an unsettled submission', () => {
  test('a storage write that throws still clears the in-memory record and says so', () => {
    const {api, writes} = dismissHandler({writeThrows: true});
    api.dismiss();
    const state = api.state();
    expect(writes).toHaveLength(1);
    expect(state.pending).toBeNull();
    expect(state.drafts).toBe(0);
    expect(state.renders).toBeGreaterThan(0);
    expect(state.error).toContain('새로고침');
  });
  test('a working storage clears both without a warning', () => {
    const {api, writes} = dismissHandler({writeThrows: false});
    api.dismiss();
    expect(writes).toEqual([{key: 'agentstoz:pending-submission:v1:lan:session-0001', value: null}]);
    expect(api.state().pending).toBeNull();
    expect(api.state().error).toBe('');
  });
  test('declining the confirmation keeps the record', () => {
    const {api, writes} = dismissHandler({writeThrows: false, confirmed: false});
    api.dismiss();
    expect(writes).toHaveLength(0);
    expect(api.state().pending).not.toBeNull();
  });
});
