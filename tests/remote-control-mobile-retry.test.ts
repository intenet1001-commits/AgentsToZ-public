/**
 * The enumeration retry, executed rather than grepped.
 *
 * The phone follows a nextPage chain the host hands out, so a rate refusal that drops the chain
 * leaves a silently short list — the user sees projects missing, not an error. The scheduler that
 * resumes it is small but has three sharp edges, and a source-string assertion cannot tell whether
 * any of them is right. The functions below are lifted verbatim out of the shipped bundle and run
 * against stubs, so this fails when the behaviour changes, not when the wording does.
 */
import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_MOBILE_JS } from '../src/remoteControlMobilePage';

type Timer = { at: number; run: () => void; cancelled: boolean };

function scheduler() {
  const start = REMOTE_CONTROL_MOBILE_JS.indexOf('function cancelEnumerationRetry()');
  const end = REMOTE_CONTROL_MOBILE_JS.indexOf('function projectName(', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const source = REMOTE_CONTROL_MOBILE_JS.slice(start, end);
  expect(source).toContain('function scheduleEnumerationRetry');

  const timers: Timer[] = [];
  const sent: { action: string; page: unknown }[] = [];
  // Everything the lifted code reads as a free variable is declared in the same scope it is
  // spliced into, so the functions run exactly as shipped.
  const build = new Function('timers', 'sent', `
    let enumerationRetryTimer = null;
    let enumerationGeneration = 0;
    let socket = { readyState: 1 };
    let sessionToken = 'token';
    let inFlight = false;
    let workspaceRootsRequested = false;
    const WebSocket = { OPEN: 1 };
    const RATE_LIMIT_BUSY_RECHECK_MS = 1000;
    const RATE_LIMIT_RETRY_MS = 11000;
    function setTimeout(run, at) { const entry = { at, run, cancelled: false }; timers.push(entry); return entry; }
    function clearTimeout(entry) { if (entry) entry.cancelled = true; }
    function sendAction(action, controlId, confirmed, page) { sent.push({ action, page }); }
    ${source}
    return {
      schedule: (resume, page, delay) => scheduleEnumerationRetry(resume, page, delay),
      newEnumeration: () => { enumerationGeneration += 1; cancelEnumerationRetry(); },
      setSocketOpen: open => { socket = open ? { readyState: 1 } : { readyState: 3 }; },
      setSessionToken: value => { sessionToken = value; },
      setInFlight: value => { inFlight = value; },
      setWorkspaceRootsRequested: value => { workspaceRootsRequested = value; },
      workspaceRootsRequested: () => workspaceRootsRequested,
    };
  `);

  const api = build(timers, sent);
  /** Run every timer that is still armed and report the delays they were scheduled with. */
  const fire = () => {
    const pending = timers.filter(entry => !entry.cancelled);
    timers.length = 0;
    for (const entry of pending) entry.run();
    return pending.map(entry => entry.at);
  };
  return { api, sent, timers, fire };
}

describe('rate-refused enumeration retry', () => {
  test('retries the page that was actually refused, not wherever the cursor points', () => {
    const { api, sent, fire } = scheduler();
    // A refused refresh asked for page 0. Resuming from the cursor would either send nothing or
    // re-walk from a stale position, leaving the old cards in place.
    api.schedule('projects.list', 0, 11000);
    fire();
    expect(sent).toEqual([{ action: 'projects.list', page: 0 }]);
  });

  test('a held action lock defers the retry instead of abandoning the list', () => {
    const { api, sent, fire } = scheduler();
    api.setInFlight(true);
    api.schedule('projects.list', 3, 11000);
    expect(fire()).toEqual([11000]);
    expect(sent).toEqual([]);
    // Still pending, and on a short recheck rather than another whole window.
    api.setInFlight(false);
    expect(fire()).toEqual([1000]);
    expect(sent).toEqual([{ action: 'projects.list', page: 3 }]);
  });

  test('a retry from an abandoned walk retires instead of appending stale pages', () => {
    const { api, sent, fire } = scheduler();
    api.schedule('projects.list', 4, 11000);
    api.newEnumeration();
    fire();
    expect(sent).toEqual([]);
  });

  test('a closed socket or a lost session stops the retry', () => {
    const closed = scheduler();
    closed.api.schedule('projects.list', 2, 11000);
    closed.api.setSocketOpen(false);
    closed.fire();
    expect(closed.sent).toEqual([]);

    const signedOut = scheduler();
    signedOut.api.schedule('projects.list', 2, 11000);
    signedOut.api.setSessionToken('');
    signedOut.fire();
    expect(signedOut.sent).toEqual([]);
  });

  test('scheduling twice keeps one timer, so repeated refusals cannot stack', () => {
    const { api, timers } = scheduler();
    api.schedule('projects.list', 1, 11000);
    api.schedule('projects.list', 2, 11000);
    expect(timers.filter(entry => !entry.cancelled)).toHaveLength(1);
  });

  test('the work-root lookup resumes too, and re-arms the flag it cleared', () => {
    const { api, sent, fire } = scheduler();
    api.setWorkspaceRootsRequested(false);
    api.schedule('workspace-roots.list', null, 11000);
    fire();
    expect(sent).toEqual([{ action: 'workspace-roots.list', page: undefined }]);
    expect(api.workspaceRootsRequested()).toBe(true);
  });
});
