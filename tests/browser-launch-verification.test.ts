import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  browserLaunchDeadlineMs,
  classifyBrowserLaunch,
} from '../src/browserLaunchVerification';

describe('browser launch verification', () => {
  test('a clean exit is the only unconditional success for a launcher helper', () => {
    expect(classifyBrowserLaunch({ kind: 'helper', exitCode: 0 })).toEqual({ ok: true });
  });

  // `open -a "Google Chrome"` exits non-zero when that browser is not installed.
  // Reporting success there is what told the phone 「열었습니다」 for a window
  // that never appeared.
  test('reports a refusal when the launcher exits non-zero', () => {
    const verdict = classifyBrowserLaunch({ kind: 'helper', exitCode: 1 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('BROWSER_LAUNCH_FAILED');
    expect(verdict.error).toContain('브라우저');
  });

  test('a silent launcher is unverified, never a success', () => {
    const verdict = classifyBrowserLaunch({ kind: 'helper', exitCode: null });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('BROWSER_LAUNCH_NOT_VERIFIED');
  });

  // The browser binary itself keeps running on success, so the two kinds must
  // read a timeout in opposite directions.
  test('a surviving browser executable is the normal success', () => {
    expect(classifyBrowserLaunch({ kind: 'executable', exitCode: null })).toEqual({ ok: true });
    expect(classifyBrowserLaunch({ kind: 'executable', exitCode: 0 })).toEqual({ ok: true });
    expect(classifyBrowserLaunch({ kind: 'executable', exitCode: 2 }).ok).toBe(false);
  });

  test('the executable deadline only has to catch an immediate failure', () => {
    expect(browserLaunchDeadlineMs('helper')).toBeGreaterThan(browserLaunchDeadlineMs('executable'));
    expect(browserLaunchDeadlineMs('executable')).toBeGreaterThan(0);
  });
});

describe('open-in-chrome contract', () => {
  const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
  const handler = apiSource.slice(apiSource.indexOf('"/api/open-in-chrome"'));
  const body = handler.slice(0, handler.indexOf('/api/open-terminal-worktree-run'));

  test('the endpoint decides through the verifier instead of reporting success', () => {
    expect(body).toContain('await launchBrowserVerified(cmd, kind)');
    expect(body).toContain('if (!verdict.ok)');
    // No bare spawn may remain: that is the pattern the verifier replaced.
    expect(body).not.toContain('spawn({ cmd:');
  });

  test('the phone receives the launch reason rather than the generic refusal', () => {
    expect(apiSource).toContain("code === 'BROWSER_LAUNCH_FAILED' || code === 'BROWSER_LAUNCH_NOT_VERIFIED'");
  });
});
