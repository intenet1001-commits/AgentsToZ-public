import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type NotaryCheckStatus = 'ready' | 'session-locked-profile-unavailable'
  | 'profile-unavailable' | 'apple-auth-rejected' | 'keychain-interaction-required'
  | 'lookup-timeout' | 'lookup-failed' | 'invalid-response';
export interface NotaryOptions { profile: string; keychain?: string }
export interface CheckProcessResult { status: number | null; stdout: string; stderr: string; timedOut?: boolean }
export type CheckRunner = (command: string, args: string[]) => CheckProcessResult;

// No password, clipboard access, Keychain mutation, or interactive prompt in this check.
export const runNotaryCheckProcess: CheckRunner = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' };
};

export function notaryAuthArgs(options: NotaryOptions): string[] {
  if (!options.profile.trim() || options.profile.length > 256 || /[\x00-\x1f\x7f]/.test(options.profile)) {
    throw new Error('A nonempty Keychain profile name is required.');
  }
  if (options.keychain !== undefined && (!isAbsolute(options.keychain) || /[\x00-\x1f\x7f]/.test(options.keychain))) {
    throw new Error('The Keychain path must be absolute.');
  }
  return ['--keychain-profile', options.profile, ...(options.keychain ? ['--keychain', options.keychain] : [])];
}

const SESSION_STATE = `ObjC.import('CoreGraphics');
var ref = $.CGSessionCopyCurrentDictionary();
if (!ref) { JSON.stringify({screenLocked:null}); }
else {
  var d = ObjC.deepUnwrap(ObjC.castRefToObject(ref));
  var value = d.CGSSessionScreenIsLocked;
  JSON.stringify({screenLocked:value === true || value === 1 ? true :
    value === false || value === 0 ? false : null});
}`;

export function readMacScreenLocked(run: CheckRunner): boolean | null {
  const result = run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SESSION_STATE]);
  if (result.status !== 0) return null;
  try {
    const value = JSON.parse(result.stdout).screenLocked;
    return typeof value === 'boolean' ? value : null;
  } catch { return null; }
}

export function checkMacOSNotary(options: NotaryOptions, run: CheckRunner = runNotaryCheckProcess) {
  const authArgs = notaryAuthArgs(options);
  const screenLocked = readMacScreenLocked(run);
  // Attempt the existing credential even while locked: a file-based Keychain may work.
  const result = run('/usr/bin/xcrun', ['notarytool', 'history', ...authArgs, '--output-format', 'json']);
  let status: NotaryCheckStatus;
  if (result.timedOut) status = 'lookup-timeout';
  else if (result.status === 0) {
    try {
      const history = JSON.parse(result.stdout);
      status = history && Array.isArray(history.history) ? 'ready' : 'invalid-response';
    } catch { status = 'invalid-response'; }
  } else if (/HTTP status code:\s*401\b/i.test(result.stderr)) status = 'apple-auth-rejected';
  else if (/No Keychain password item found for profile:/i.test(result.stderr)) {
    status = screenLocked === true ? 'session-locked-profile-unavailable' : 'profile-unavailable';
  } else if (/User interaction is not allowed|interaction.*required|keychain.*locked/i.test(result.stderr)) {
    status = 'keychain-interaction-required';
  } else status = 'lookup-failed';

  return {
    status, ready: status === 'ready', screenLocked,
    storage: options.keychain ? 'file-keychain' as const : 'data-protection-keychain' as const,
    authArgs, notaryExitCode: result.status,
    // Missing-item errors do not establish deletion or an incorrect Apple password.
    nextStep: status === 'ready' ? 'continue-with-same-auth-args'
      : status === 'session-locked-profile-unavailable' ? 'recheck-existing-profile-after-unlock'
      : status === 'profile-unavailable' ? 'check-original-storage-and-login-session'
      : status === 'apple-auth-rejected' ? 'review-apple-credential'
      : status === 'keychain-interaction-required' ? 'resolve-keychain-interaction'
      : 'inspect-tool-or-network',
  };
}
