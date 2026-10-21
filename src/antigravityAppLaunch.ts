/**
 * 「Antigravity 앱에서 열기」 — launch or focus Antigravity.app (2.0, an agent hub).
 *
 * The app handles neither a folder argument nor an initial prompt (verified from its asar), so this
 * is launch/focus only: the project is never applied and the user picks it inside the app. Every
 * response says so instead of implying the project opened.
 *
 * Pure decisions live here so tests never start the real app; api-server performs the spawn.
 */
export const ANTIGRAVITY_BUNDLE_ID = 'com.google.antigravity';
export const ANTIGRAVITY_APP_LAUNCH_DEADLINE_MS = 10_000;
export const ANTIGRAVITY_APP_MDFIND_TIMEOUT_MS = 3_000;
/** How long a «Spotlight did not find it» answer is reused, so repeated clicks do not re-run mdfind. */
export const ANTIGRAVITY_APP_MISSING_CACHE_MS = 30_000;
/**
 * What the app does *not* do — said next to every result. It never claims the app opened: whether it did is
 * `launchVerified`, and the wording for that comes from the caller (opened / not confirmed).
 */
export const ANTIGRAVITY_APP_PROJECT_NOTE = '프로젝트는 앱에서 선택하세요';

export function antigravityAppCandidatePaths(home: string): string[] {
  return ['/Applications/Antigravity.app', `${home.replace(/\/+$/, '')}/Applications/Antigravity.app`];
}

export function antigravityMdfindCommand(): string[] {
  return ['/usr/bin/mdfind', `kMDItemCFBundleIdentifier == '${ANTIGRAVITY_BUNDLE_ID}'`];
}

/**
 * The installed app bundle, or null. Fixed locations first; Spotlight (bounded by the caller, which must
 * not block the sidecar — run it asynchronously) only when neither exists. A Spotlight hit is accepted
 * only if it is an `.app` bundle that still exists.
 */
export async function findAntigravityApp(input: {
  home: string;
  exists: (path: string) => boolean;
  /** stdout of the bounded mdfind, or null when it failed or timed out. */
  mdfind: () => Promise<string | null> | string | null;
}): Promise<string | null> {
  for (const path of antigravityAppCandidatePaths(input.home)) if (input.exists(path)) return path;
  const output = await input.mdfind();
  if (!output) return null;
  for (const line of output.split('\n')) {
    const path = line.trim();
    if (path.startsWith('/') && path.endsWith('.app') && input.exists(path)) return path;
  }
  return null;
}

/**
 * `findAntigravityApp` with a short memory of a Spotlight miss. The fixed locations are always checked
 * again (cheap, and an install there is seen at once); only the mdfind fallback is skipped while a recent
 * miss is remembered. A hit is never cached — the bundle may move or be deleted.
 */
export function createAntigravityAppLocator(input: {
  home: () => string;
  exists: (path: string) => boolean;
  mdfind: () => Promise<string | null>;
  now?: () => number;
  missCacheMs?: number;
}): () => Promise<string | null> {
  const now = input.now ?? Date.now;
  const missCacheMs = input.missCacheMs ?? ANTIGRAVITY_APP_MISSING_CACHE_MS;
  let missUntil = 0;
  return async () => {
    const skipSpotlight = now() < missUntil;
    const found = await findAntigravityApp({
      home: input.home(), exists: input.exists,
      mdfind: skipSpotlight ? () => null : input.mdfind,
    });
    if (!found && !skipSpotlight) missUntil = now() + missCacheMs;
    if (found) missUntil = 0;
    return found;
  };
}

export function antigravityLaunchCommand(): string[] {
  return ['/usr/bin/open', '-b', ANTIGRAVITY_BUNDLE_ID];
}

/**
 * The environment for `open`. Inherited SSH_* reaches the app (and its agents) and makes it treat the
 * Mac as a remote session — the same leak the Workroom already strips (CLAUDE.md, 3호 2026-10-08).
 */
export function antigravityLaunchEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith('SSH_')) continue;
    out[key] = value;
  }
  return out;
}

export type AntigravityLaunchOutcome =
  | {kind: 'exited'; exitCode: number | null}
  | {kind: 'timeout'}
  | {kind: 'spawn-error'};

export type AntigravityLaunchVerdict =
  | {status: 'verified'}
  | {status: 'unverified'; warning: string}
  | {status: 'failed'; code: 'ANTIGRAVITY_APP_LAUNCH_FAILED'; error: string};

/**
 * `open -b` hands the bundle id to LaunchServices and exits: its exit code is the answer.
 * Silence past the deadline is «not confirmed» (the app may still come up), never a failure — and the
 * process is not killed.
 */
export function classifyAntigravityLaunch(outcome: AntigravityLaunchOutcome): AntigravityLaunchVerdict {
  if (outcome.kind === 'timeout') {
    return {status: 'unverified', warning: 'Antigravity 앱 실행 요청을 보냈지만 제때 확인하지 못했습니다. 앱이 열렸는지 확인하세요.'};
  }
  if (outcome.kind === 'exited' && outcome.exitCode === 0) return {status: 'verified'};
  return {
    status: 'failed', code: 'ANTIGRAVITY_APP_LAUNCH_FAILED',
    error: outcome.kind === 'spawn-error'
      ? 'Antigravity 앱을 여는 명령을 실행하지 못했습니다.'
      : `Antigravity 앱을 열지 못했습니다 (open 종료 코드 ${outcome.exitCode ?? '알 수 없음'}).`,
  };
}
