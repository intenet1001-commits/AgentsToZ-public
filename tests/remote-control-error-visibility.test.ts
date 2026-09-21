import { describe, test, expect } from 'bun:test';
import { REMOTE_CONTROL_MOBILE_JS, REMOTE_CONTROL_MOBILE_HTML } from '../src/remoteControlMobilePage';

/**
 * A failed remote action used to be a 3-second toast and nothing else.
 *
 * Creating a worktree on the 9월1일테스트 project was refused twice with
 * WORKTREE_SOURCE_DIRTY (two uncommitted files in the main tree). The host
 * returned the reason AND the offending paths, but the phone showed a toast
 * that vanished, so the user saw "nothing happened" and retried — the failure
 * was unusable for fixing the cause. Errors must persist until dismissed and
 * must carry the code and the paths the host reported.
 */
describe('remote control mobile keeps failures on screen', () => {
  test('the page has a dedicated error region that is not the toast', () => {
    expect(REMOTE_CONTROL_MOBILE_HTML).toContain('id="error-log"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('errorLog');
  });

  test('a failed action records code, message, and time instead of only notifying', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('recordError');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('error.code');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('toLocaleTimeString');
  });

  test('host-supplied detail paths are rendered so the cause is actionable', () => {
    // WORKTREE_SOURCE_DIRTY carries changedPaths; a bare message is not enough
    // to know which files block the worktree.
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('changedPaths');
  });

  test('the error region can be cleared by the user, not by a timer', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('clearErrors');
    expect(REMOTE_CONTROL_MOBILE_HTML).toContain('id="error-clear"');
  });

  test('a dirty main tree explains the next step rather than only the refusal', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('WORKTREE_SOURCE_DIRTY');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('Commit');
  });
});

/**
 * After a successful worktree.add the host answers with the page the new card
 * is on. The controller must show that card without waiting for a manual
 * refresh, and must not silently drop the tail of the list it already had.
 */
describe('remote control mobile surfaces a newly created worktree', () => {
  test('a successful worktree creation reports the new card explicitly', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('워크트리');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('lastActionName');
  });

  test('the controller keeps pulling remaining pages so no card is lost', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('nextProjectPage !== null');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('projects.list');
  });
});
