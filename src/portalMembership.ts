import { PortalAuthRequestTimeoutError, portalAuthErrorMessage, withPortalAuthTimeout } from './portalAuth';
import { phoneIsOnline, portalNetworkFailureMessage } from './phoneNetwork';
import { isTransientNetworkError } from './remoteTransientNetworkError';

export interface PortalMembershipRpcClient {
  rpc(name: 'portmgr_is_member'): PromiseLike<{ data: unknown; error: unknown }>;
}

export type PortalMembershipResult =
  | { state: 'member' }
  | { state: 'denied' }
  /**
   * `network: true` — the question never reached the database (no network on this device, or the
   * fetch itself failed). That is not evidence about membership or migrations, so the screen must
   * not advise either (2026-10-10: an offline iPhone was told to check migrations).
   */
  | { state: 'error'; message: string; network?: true };

/**
 * A failure the device's network explains. `online` is injected for tests; a timeout while the
 * device reports no network counts too, since the request could not have been answered.
 *
 * A membership check that did not answer within its bound is the network's too: weak cellular or a
 * hanging captive Wi‑Fi, not a fact about membership or migrations. It still admits nobody — only an
 * explicit true does — but it gets the network card, its bounded re-check, and keeps an already verified
 * page (2026-10-16 audit: a 14 s answer showed 「최신 Supabase 마이그레이션… (PORTAL_AUTH_MEMBERSHIP_TIMEOUT)」
 * and never recovered). A stored-session read that times out is not: an auth-js lock can hang it, and that
 * card's 「이 기기 로그인 초기화」 is the way out.
 */
export function isPortalNetworkFailure(error: unknown, online = phoneIsOnline()): boolean {
  return !online || isTransientNetworkError(error)
    || (error instanceof PortalAuthRequestTimeoutError && error.operation === 'MEMBERSHIP');
}

function failure(error: unknown, online: () => boolean): PortalMembershipResult {
  const message = portalAuthErrorMessage(error);
  return isPortalNetworkFailure(error, online()) ? { state: 'error', message, network: true } : { state: 'error', message };
}

/**
 * The database allowlist is the only authorization authority for hosted UIs.
 * A build-time email mirror can be stale, and a localStorage flag
 * is user-controlled, so neither may grant or deny portal access.
 * A network failure is still an error — it never admits anyone.
 */
export async function verifyPortalMembership(
  client: PortalMembershipRpcClient,
  timeoutMs?: number,
  online: () => boolean = () => phoneIsOnline(),
): Promise<PortalMembershipResult> {
  try {
    const { data, error } = await withPortalAuthTimeout(
      client.rpc('portmgr_is_member'),
      'MEMBERSHIP',
      timeoutMs,
    );
    if (error) return failure(error, online);
    if (data === true) return { state: 'member' };
    if (data === false) return { state: 'denied' };
    return { state: 'error', message: MEMBERSHIP_NOT_BOOLEAN };
  } catch (error) {
    return failure(error, online);
  }
}

const MEMBERSHIP_NOT_BOOLEAN = 'portmgr_is_member()가 boolean을 반환하지 않았습니다.';

/** The desktop web portal's (portal-main.tsx) re-check button; the sentence for it names this label. */
export const PORTAL_RECHECK_BUTTON_LABEL = '로그인 상태 다시 확인';

/**
 * `recheck` says what the screen does after a network failure. 'automatic' is the phone, which re-checks by itself
 * (on 'online' and a bounded timer). 'button' is the desktop web portal, which only re-checks when its
 * 「로그인 상태 다시 확인」 is pressed — promising 「잠시 뒤 저절로」 there was false (review 2026-10-16).
 */
export function portalMembershipFailureMessage(
  result: Exclude<PortalMembershipResult, { state: 'member' }>,
  email = '',
  online = phoneIsOnline(),
  recheck: 'automatic' | 'button' = 'automatic',
): string {
  if (result.state === 'denied') {
    return `${email || '현재 Google 계정'}은 이 개인 배포본의 DB 허용 회원이 아닙니다.`;
  }
  if (result.network && recheck === 'button') {
    return `${online ? '네트워크 요청이 실패해' : '네트워크에 연결되지 않아'} 회원 권한을 확인하지 못했습니다. 연결을 확인한 뒤 「${PORTAL_RECHECK_BUTTON_LABEL}」을 누르세요.`;
  }
  if (result.network) return portalNetworkFailureMessage('membership', online);
  return `DB 회원 권한을 확인하지 못했습니다. 최신 Supabase 마이그레이션과 네트워크를 확인하세요. (${result.message})`;
}

/**
 * The phone's locked card for a failure that is not the network's, under its own title: one sentence of
 * advice — not the title again — and the server's own words apart, for a copyable detail line instead of a
 * raw code inside the sentence.
 *
 * Migrations are advised only when the server said the function or schema is missing or older (PostgREST
 * PGRST202/PGRST205, Postgres 42883/42P01, or a non-boolean answer). A 5xx or an expired token is not that,
 * and sending a member to the database for it was wrong advice (review 2026-10-16).
 */
export function portalMembershipCardBody(result: { message: string }): { text: string; detail: string } {
  const schema = result.message === MEMBERSHIP_NOT_BOOLEAN || /\((?:PGRST202|PGRST205|42883|42P01)\)$/.test(result.message);
  return {
    text: schema
      ? '이 계정이 허용 회원인지 서버에서 확인하지 못했습니다. 이 배포본에 최신 Supabase 마이그레이션이 적용됐는지 확인하세요.'
      : '서버가 회원 확인 요청을 처리하지 못했습니다. 잠시 뒤 「다시 확인」을 눌러 주세요. 계속되면 아래 내용을 배포한 사람에게 알려 주세요.',
    detail: result.message,
  };
}

/**
 * Keep an already verified member signed in through a network failure?
 * Only when this page has verified this same account and the failure is the network's. A denial,
 * a different account, or any other error still ends the signed-in state.
 */
export function keepVerifiedThroughFailure(
  verifiedEmail: string,
  sessionEmail: string,
  result: PortalMembershipResult,
): boolean {
  return !!verifiedEmail && verifiedEmail === sessionEmail && result.state === 'error' && result.network === true;
}

/**
 * A stored-session read (auth-js getSession) failed. What the page does:
 * - `keep` — the network's fault, and this page already verified an account: stay signed in, re-check later.
 * - `network` — the network's fault on a cold load: the network card, never the app (nothing was verified).
 * - `error` — anything else: the locked card, and whatever this page had verified is gone. Only a later
 *   successful member check may sign it in again (review 2026-10-10: a timeout, then a network failure on
 *   「다시 확인」, brought the app back without reading any session).
 */
export type SessionReadFailure = 'keep' | 'network' | 'error';
export function sessionReadFailure(verifiedEmail: string, networkFailure: boolean): SessionReadFailure {
  if (!networkFailure) return 'error';
  return verifiedEmail ? 'keep' : 'network';
}

/**
 * After a failed session read, does this auth event still count?
 * The locked card (`error`) waits for 「다시 확인」. A network failure keeps listening — a sign-out, another account,
 * or auth-js's own later TOKEN_REFRESHED must reach the page — except auth-js's INITIAL_SESSION(null), which is
 * how it answers the very read that failed and is not a sign-out (review 2026-10-10: ignoring every event left a
 * signed-in screen after a sign-out, and a cold load that never noticed the refresh that finally worked).
 */
export function authEventCountsAfterSessionFailure(
  failure: SessionReadFailure | null,
  event: string,
  hasSession: boolean,
): boolean {
  if (failure === 'error') return false;
  if (failure && event === 'INITIAL_SESSION' && !hasSession) return false;
  return true;
}
