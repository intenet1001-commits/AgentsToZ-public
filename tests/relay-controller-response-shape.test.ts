import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const CONTROLLER = readFileSync(new URL('../src/remoteControlRelayController.ts', import.meta.url), 'utf8');

/**
 * REMOTE_CONTROL_RESPONSE_INVALID while the session was `online`.
 *
 * The relay controller validates every server message with exact key counts —
 * deliberately strict, so a relay cannot smuggle extra fields into the phone.
 * Two changes on the host side then started producing messages this parser
 * rejects outright, and because the parse throws before the payload is read,
 * the phone reported a connection failure for a connection that was fine.
 */
describe('relay controller accepts the messages the host actually sends', () => {
  test('an action error may carry the paths that explain the refusal', () => {
    // remoteControlPublicError adds `changedPaths` for WORKTREE_SOURCE_DIRTY so
    // the phone can say WHICH files block the worktree. The parser required
    // exactly {code, message}, so the improved refusal became an invalid
    // response — the failure it was meant to explain got replaced by a
    // misleading "check your internet".
    expect(CONTROLLER).toContain("'changedPaths'");
    expect(CONTROLLER).not.toContain('Object.keys(error).length !== 2');
  });

  test('a restored session is a message type the parser knows', () => {
    // remoteControlCore.restore() answers `session.restored`; the parser only
    // handled `session.ready` and fell through to the final throw, so every
    // reconnect that resumed a session failed to parse.
    expect(CONTROLLER).toContain("'session.restored'");
  });

  test('the parser stays strict about unknown keys', () => {
    // Loosening must be limited to the fields the host really sends; an
    // unbounded passthrough would defeat the point of validating at all.
    expect(CONTROLLER).toContain('REMOTE_CONTROL_RESPONSE_INVALID');
    expect(CONTROLLER).toContain('exactObject');
  });
});
