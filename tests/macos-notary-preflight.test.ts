import { describe, expect, test } from 'bun:test';
import { checkMacOSNotary, notaryAuthArgs, type CheckProcessResult, type CheckRunner } from '../src/macOSNotaryPreflight';

const missing = { status: 69, stdout: '', stderr: 'Error: No Keychain password item found for profile: test' };
function fixture(screenLocked: boolean | null, result: CheckProcessResult) {
  const calls: { command: string; args: string[] }[] = [];
  const run: CheckRunner = (command, args) => {
    calls.push({ command, args });
    return command === '/usr/bin/osascript'
      ? { status: 0, stdout: JSON.stringify({ screenLocked }), stderr: '' } : result;
  };
  return { run, calls };
}
describe('macOS notarization credential preflight', () => {
  test('a locked-session missing item requires rechecking, not password replacement', () => {
    const f = fixture(true, missing);
    const result = checkMacOSNotary({ profile: 'test' }, f.run);
    expect(result.status).toBe('session-locked-profile-unavailable');
    expect(result.nextStep).toBe('recheck-existing-profile-after-unlock');
    expect(result.ready).toBe(false);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.args).toEqual(['notarytool', 'history', '--keychain-profile', 'test', '--output-format', 'json']);
  });
  test.each([false, null])('does not invent deletion or screen lock for state %s', state => {
    const f = fixture(state, missing);
    expect(checkMacOSNotary({ profile: 'test' }, f.run).status).toBe('profile-unavailable');
  });
  test('explicit Keychain can succeed with a locked screen and preserves the exact path', () => {
    const f = fixture(true, { status: 0, stdout: '{"history":[]}', stderr: '' });
    const result = checkMacOSNotary({ profile: 'test', keychain: '/path with spaces/login.keychain-db' }, f.run);
    expect(result.ready).toBe(true);
    expect(result.authArgs).toEqual(['--keychain-profile', 'test', '--keychain', '/path with spaces/login.keychain-db']);
    expect(result.storage).toBe('file-keychain');
  });
  test.each([
    [{ status: 1, stdout: '', stderr: 'HTTP status code: 401. Invalid credentials.' }, 'apple-auth-rejected'],
    [{ status: 1, stdout: '', stderr: 'User interaction is not allowed.' }, 'keychain-interaction-required'],
    [{ status: null, stdout: '', stderr: '', timedOut: true }, 'lookup-timeout'],
    [{ status: 1, stdout: '', stderr: 'Network unavailable' }, 'lookup-failed'],
    [{ status: 0, stdout: 'not JSON', stderr: '' }, 'invalid-response'],
    [{ status: 0, stdout: '{}', stderr: '' }, 'invalid-response'],
  ] as const)('classifies failures without exposing raw output', (processResult, expected) => {
    const f = fixture(true, processResult);
    const result = checkMacOSNotary({ profile: 'test' }, f.run);
    expect(result.status).toBe(expected);
    expect(result.ready).toBe(false);
    expect(result).not.toHaveProperty('stderr');
    expect(result).not.toHaveProperty('stdout');
  });
  test('rejects malformed profile and relative Keychain paths before any subprocess', () => {
    expect(() => notaryAuthArgs({ profile: '' })).toThrow();
    expect(() => notaryAuthArgs({ profile: 'test\npassword' })).toThrow();
    expect(() => notaryAuthArgs({ profile: 'test', keychain: 'login.keychain-db' })).toThrow();
  });
});
