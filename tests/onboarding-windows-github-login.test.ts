import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  GITHUB_DEVICE_CODE_PATTERN,
  GITHUB_DEVICE_CODE_TAIL_CHARS,
  githubDeviceCodeFrom,
} from '../src/githubDeviceCode';
import { buildWindowsSupervisedLaunch } from '../src/windowsCommandLaunch';

test('the device code is read out of real gh output and nothing else is', () => {
  // Shape printed by `gh auth login --web`.
  expect(githubDeviceCodeFrom('! First copy your one-time code: ABCD-1234\n')).toBe('ABCD-1234');
  expect(githubDeviceCodeFrom('one-time code:   9Z8Y-7X6W')).toBe('9Z8Y-7X6W');
  for (const other of [
    '',
    'Logged in as octocat',                       // account name
    'error: HTTP 401 Bad credentials',            // error response
    'Configured git protocol',
    '! Your token is gho_xxxxxxxxxxxxxxxxxxxx',   // a credential must never match
    'one-time code: abcd-1234',                   // lowercase is not the format
    'one-time code: ABCD1234',                    // missing separator
    'one-time code: ABC-1234',                    // wrong length
  ]) {
    expect(githubDeviceCodeFrom(other)).toBeNull();
  }
  expect(githubDeviceCodeFrom(null as any)).toBeNull();
});

test('a code split across reads is still found within the bounded tail', () => {
  // The reader keeps only a tail, so the window must be large enough for the
  // line yet bounded against a chatty CLI.
  expect(GITHUB_DEVICE_CODE_TAIL_CHARS).toBeGreaterThanOrEqual(256);
  expect(GITHUB_DEVICE_CODE_TAIL_CHARS).toBeLessThanOrEqual(8192);
  const noise = 'x'.repeat(GITHUB_DEVICE_CODE_TAIL_CHARS * 3);
  const tail = (noise + '! First copy your one-time code: QQQQ-0000\n').slice(-GITHUB_DEVICE_CODE_TAIL_CHARS);
  expect(githubDeviceCodeFrom(tail)).toBe('QQQQ-0000');
});

test('both login owners recognise the same output, so neither can drift', () => {
  // macOS runs the login inside the packaged guard, Windows inside the Job
  // Object supervisor. A drifted copy of the pattern would quietly stop
  // surfacing the code on one platform only.
  const guard = readFileSync(new URL('../src/onboardingGithubAuthGuard.ts', import.meta.url), 'utf8');
  const windows = readFileSync(new URL('../src/onboardingGithubWindowsEffects.ts', import.meta.url), 'utf8');
  const body = GITHUB_DEVICE_CODE_PATTERN.source;
  // The Windows path consumes the shared module.
  expect(windows).toContain('githubDeviceCodeFrom');
  expect(windows).not.toContain(body);
  // The macOS guard still carries the identical literal; if it is ever edited,
  // this fails and points at the shared module.
  expect(guard).toContain(body);
});

test('the Windows login runs gh under the Job Object supervisor, never bare', () => {
  const source = readFileSync(new URL('../src/onboardingGithubWindowsEffects.ts', import.meta.url), 'utf8');
  // An unowned `gh auth login` would keep holding the device code after the app
  // closed, so the supervisor wrapper is not optional here.
  expect(source).toContain('buildWindowsSupervisedLaunch');
  expect(source).toContain('parentPid: process.pid');
  expect(source).toContain("'auth', 'login'");
  // A missing supervisor script must refuse, not fall back to a bare spawn.
  expect(source).toContain('supervisorScript()');
  expect(source).toMatch(/프로세스 감시기/);
  // The login must never run inside a project directory.
  expect(source).toContain('cwd: systemRoot()');
});

test('the supervised launch keeps the owner and the child argv intact', () => {
  const launch = buildWindowsSupervisedLaunch(
    'C:\\Program Files\\AgentsToZ\\windows-process-supervisor.ps1',
    { cmd: ['C:\\Program Files\\GitHub CLI\\gh.exe', 'auth', 'login', '--web'], env: {} },
    { parentPid: 1234 },
  );
  expect(launch.cmd[0]).toBe('powershell.exe');
  expect(launch.cmd).toContain('-File');
  expect(launch.env.AGENTSTOZ_SUPERVISOR_PROGRAM).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
  expect(JSON.parse(launch.env.AGENTSTOZ_SUPERVISOR_ARGS_JSON!)).toEqual(['auth', 'login', '--web']);
  // Without the owner PID the Job would not close when the sidecar dies.
  expect(launch.env.AGENTSTOZ_SUPERVISOR_PARENT_PID).toBe('1234');
});
