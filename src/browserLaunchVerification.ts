/**
 * Whether a browser launch actually happened.
 *
 * The remote (phone) 「localhost 열기」 path reports back one line, so an
 * unconditional `success: true` reads as 「열었습니다」 for a Chrome that was
 * never there — the fake-success pattern this repository forbids. Keep the
 * decision here, away from the spawn, so both the kind asymmetry and the
 * refusal copy stay in one place.
 */

/**
 * `helper` — a short-lived launcher (`open -a`, `rundll32`) hands the URL to the
 * browser and exits, so its exit code *is* the answer and a silent timeout means
 * we never learned anything.
 *
 * `executable` — the browser binary itself. On success it keeps running (or
 * exits 0 after handing off to an already-open instance), so a process still
 * alive at the deadline is the normal outcome and only an early non-zero exit
 * proves failure.
 */
export type BrowserLaunchKind = 'helper' | 'executable';

export type BrowserLaunchFailureCode = 'BROWSER_LAUNCH_FAILED' | 'BROWSER_LAUNCH_NOT_VERIFIED';

export type BrowserLaunchVerdict =
  | { ok: true }
  | { ok: false; code: BrowserLaunchFailureCode; error: string };

/** Milliseconds to wait before giving up on learning the outcome. A helper must
 * answer quickly; the browser binary only needs long enough to fail. */
export function browserLaunchDeadlineMs(kind: BrowserLaunchKind): number {
  return kind === 'helper' ? 5_000 : 1_200;
}

export function classifyBrowserLaunch(input: {
  kind: BrowserLaunchKind;
  /** The spawn's exit code, or `null` when it was still running at the deadline. */
  exitCode: number | null;
}): BrowserLaunchVerdict {
  if (input.exitCode === 0) return { ok: true };
  if (input.exitCode !== null) {
    return {
      ok: false,
      code: 'BROWSER_LAUNCH_FAILED',
      error: '이 Mac에서 브라우저를 열지 못했습니다. 브라우저가 설치되어 있는지 확인해 주세요.',
    };
  }
  if (input.kind === 'executable') return { ok: true };
  return {
    ok: false,
    code: 'BROWSER_LAUNCH_NOT_VERIFIED',
    error: '브라우저를 열었는지 확인하지 못했습니다. Mac 화면을 확인하고 필요하면 다시 누르세요.',
  };
}
