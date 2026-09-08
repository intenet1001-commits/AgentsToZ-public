import { portalAuthErrorMessage, withPortalAuthTimeout } from './portalAuth';

export interface PortalMembershipRpcClient {
  rpc(name: 'portmgr_is_member'): PromiseLike<{ data: unknown; error: unknown }>;
}

export type PortalMembershipResult =
  | { state: 'member' }
  | { state: 'denied' }
  | { state: 'error'; message: string };

/**
 * The database allowlist is the only authorization authority for hosted UIs.
 * A build-time email mirror can be stale, and a localStorage flag
 * is user-controlled, so neither may grant or deny portal access.
 */
export async function verifyPortalMembership(
  client: PortalMembershipRpcClient,
  timeoutMs?: number,
): Promise<PortalMembershipResult> {
  try {
    const { data, error } = await withPortalAuthTimeout(
      client.rpc('portmgr_is_member'),
      'MEMBERSHIP',
      timeoutMs,
    );
    if (error) return { state: 'error', message: portalAuthErrorMessage(error) };
    if (data === true) return { state: 'member' };
    if (data === false) return { state: 'denied' };
    return { state: 'error', message: 'portmgr_is_member()가 boolean을 반환하지 않았습니다.' };
  } catch (error) {
    return { state: 'error', message: portalAuthErrorMessage(error) };
  }
}

export function portalMembershipFailureMessage(
  result: Exclude<PortalMembershipResult, { state: 'member' }>,
  email = '',
): string {
  if (result.state === 'denied') {
    return `${email || '현재 Google 계정'}은 이 개인 배포본의 DB 허용 회원이 아닙니다.`;
  }
  return `DB 회원 권한을 확인하지 못했습니다. 최신 Supabase 마이그레이션과 네트워크를 확인하세요. (${result.message})`;
}
