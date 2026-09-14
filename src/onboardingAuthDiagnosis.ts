export interface OnboardingProbe { ok: boolean; output: string; timedOut: boolean }
export type OnboardingAuthState = 'ready' | 'needs-login' | 'unknown';

/** CLI output is inspected locally, never returned in diagnostics or receipts. */
export function classifyOnboardingAuth(probe: OnboardingProbe): {
  state: OnboardingAuthState; authenticated?: boolean; detail?: string;
} {
  if (probe.timedOut) return { state: 'unknown', detail: '연결 확인이 늦어지고 있습니다. 기존 로그인은 유지됩니다.' };
  if (probe.ok) return { state: 'ready', authenticated: true };
  // Network and permission failures can also mention login. Prefer inconclusive
  // evidence over an unsolicited reauthentication loop.
  if (/ENOTFOUND|ECONN|EAI_AGAIN|ETIMEDOUT|network|fetch failed|certificate|TLS|proxy|rate.limit|429|5\d\d|forbidden|permission denied|insufficient.scope/i.test(probe.output)) {
    return { state: 'unknown', detail: '서비스 연결이나 접근 권한을 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.' };
  }
  if (/not logged (?:in|into)|not authenticated|no (?:valid )?(?:credentials|token)|access token not provided|login required|please (?:run .{0,24}login|log in)|invalid (?:authentication )?token|token (?:has )?expired/i.test(probe.output)) {
    return { state: 'needs-login', authenticated: false, detail: '공식 로그인 화면에서 계정을 연결해 주세요.' };
  }
  return { state: 'unknown', detail: '로그인 상태를 확정하지 못했습니다. 기존 설정을 유지하고 다시 확인해 주세요.' };
}
