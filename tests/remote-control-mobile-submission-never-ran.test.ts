/**
 * The LAN page's 「제출 결과 확인」 on a request that never ran (2026-10-30).
 *
 * A refusal before the Mac's write fence is now recorded `rejected` (and a request prepared before a Mac restart reads
 * `held`). The shared pendingAfterStatus settles both, so this page must not take that as «written»: the record goes,
 * the draft stays, and the message says it was not typed — never 「이미 전달」, which would clear the field.
 *
 * The handler is lifted verbatim out of the shipped bundle and run against stubs, as in remote-control-mobile-retry.
 */
import {describe, expect, test} from 'bun:test';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';
import {draftAfterWrittenStatus,pendingAfterStatus,submissionStateLabel} from '../src/workroomSubmissionClient';

function statusHandler(state: 'rejected' | 'held' | 'written' | 'prepared') {
  const start = REMOTE_CONTROL_MOBILE_JS.indexOf("document.querySelector('#terminal-submission-status').onclick=");
  expect(start).toBeGreaterThan(0);
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf('function terminalDismissSubmission(', start);
  expect(end).toBeGreaterThan(start);
  const source = REMOTE_CONTROL_MOBILE_JS.slice(start, end);
  // The helpers exactly as the page embeds them (each function's own source).
  const helpers = `const terminalPendingAfterStatus=${pendingAfterStatus.toString()};
    const terminalDraftAfterWritten=${draftAfterWrittenStatus.toString()};
    const terminalStateLabel=${submissionStateLabel.toString()};`;
  for (const name of ['terminalPendingAfterStatus', 'terminalDraftAfterWritten', 'terminalStateLabel']) expect(REMOTE_CONTROL_MOBILE_JS).toContain(`const ${name}=`);
  const writes: unknown[] = [];
  const build = new Function('state', 'writes', `
    ${helpers}
    let terminalPendingSubmission = {id: 'lan-' + 'a'.repeat(32), sessionId: 'session-0001', receipt: null};
    let terminalSubmissionBusy = false, terminalLineSending = false, terminalLineGeneration = 0;
    const terminalSelected = 'session-0001';
    const terminalSubmittedDrafts = new Map([[terminalPendingSubmission.id, '앞선 요청']]);
    const terminalError = {textContent: ''};
    const field = {value: '앞선 요청'};
    const handlers = {};
    const document = {querySelector: selector => selector === '#terminal-line' ? field : (handlers[selector] ??= {})};
    const sessionStorage = {};
    const terminalSubmissions = {
      status: async ({pending}) => ({id: pending.id, storeId: 'fixture-store', epoch: 'fixture-epoch', revision: 1, state}),
      write(storage, key, value) { writes.push({key, value}); },
    };
    const terminalRequest = async () => { throw new Error('unexpected request'); };
    function terminalSubmissionKey(sessionId) { return 'agentstoz:pending-submission:v1:lan:' + sessionId; }
    function terminalRenderSubmission() {}
    ${source}
    return {
      check: () => handlers['#terminal-submission-status'].onclick(),
      state: () => ({pending: terminalPendingSubmission, drafts: terminalSubmittedDrafts.size, field: field.value, error: terminalError.textContent}),
    };
  `);
  return {api: build(state, writes), writes};
}

describe('LAN 「제출 결과 확인」 on a request that never ran', () => {
  for (const state of ['rejected', 'held'] as const) {
    test(`${state}: the record goes, the draft stays, and it says the request was not typed`, async () => {
      const {api, writes} = statusHandler(state);
      await api.check();
      const after = api.state();
      expect(after.pending).toBeNull();
      expect(writes).toEqual([{key: 'agentstoz:pending-submission:v1:lan:session-0001', value: null}]);
      expect(after.field).toBe('앞선 요청');
      expect(after.drafts).toBe(0);
      expect(after.error).toContain('입력되지 않았습니다');
      expect(after.error).not.toContain('이미 전달');
    });
  }
  test('written still clears the submitted draft, and prepared still keeps the record', async () => {
    const written = statusHandler('written');
    await written.api.check();
    expect(written.api.state().pending).toBeNull();
    expect(written.api.state().field).toBe('');
    const prepared = statusHandler('prepared');
    await prepared.api.check();
    expect(prepared.api.state().pending).not.toBeNull();
    expect(prepared.api.state().field).toBe('앞선 요청');
  });
});
