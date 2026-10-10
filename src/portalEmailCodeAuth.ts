/**
 * Email one-time-code sign-in for the portal (phone app and web).
 *
 * The desktop app needs no user login at all (its sidecar signs with service_role),
 * so the only surface that asks a person to log in is the phone. Google OAuth there
 * requires a Google Cloud client per deployment; an emailed code needs nothing but
 * the Supabase project. Supabase keeps one user per email, so a code sign-in lands on
 * the same user id as an earlier Google sign-in — pairings keyed by that id survive.
 *
 * `shouldCreateUser: false`: only existing accounts may use a code. The DB allowlist
 * (`portmgr_is_member`) still decides access after sign-in, exactly as for Google.
 */
export type PortalEmailCodeClient = {
  auth: {
    signInWithOtp: (credentials: { email: string; options: { shouldCreateUser: false } }) => PromiseLike<{ error: PortalAuthApiError | null }>;
    verifyOtp: (params: { email: string; token: string; type: 'email' }) => PromiseLike<{ error: PortalAuthApiError | null }>;
  };
};
export type PortalAuthApiError = { message?: string; code?: string; status?: number };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
// Supabase lets a project choose 6–8 digits; this shared project uses 8.
const CODE = /^\d{6,8}$/;

export function normalizePortalLoginEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}

export function normalizePortalLoginCode(value: string): string | null {
  const code = value.replace(/\s+/g, '');
  return CODE.test(code) ? code : null;
}

export class PortalEmailCodeError extends Error {
  constructor(readonly kind: 'rate-limited' | 'no-account' | 'invalid-code' | 'invalid-input' | 'failed', message: string) {
    super(message);
    this.name = 'PortalEmailCodeError';
  }
}

export function portalEmailCodeError(error: PortalAuthApiError): PortalEmailCodeError {
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (error.status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || /rate limit/i.test(message)) {
    return new PortalEmailCodeError('rate-limited', '코드 메일 발송 한도에 걸렸습니다. Supabase 기본 메일은 프로젝트 전체에서 시간당 몇 통만 보낼 수 있습니다. 이미 받은 코드가 있으면 그 코드를 입력하고, 없으면 잠시 뒤 다시 요청하세요.');
  }
  if (code === 'otp_disabled' || /signups not allowed/i.test(message) || code === 'user_not_found') {
    return new PortalEmailCodeError('no-account', '이 이메일로 된 계정이 없습니다. 허용된 계정 이메일인지 확인하세요. 처음 쓰는 계정이면 Supabase Dashboard → Authentication → Users → Add user에서 이 이메일을 추가하세요(웹앱에서 Google 로그인을 한 번 해도 계정이 만들어집니다).');
  }
  if (code === 'otp_expired' || /expired|invalid/i.test(message)) {
    return new PortalEmailCodeError('invalid-code', '코드가 맞지 않거나 만료됐습니다. 메일의 최신 코드를 다시 확인하세요.');
  }
  return new PortalEmailCodeError('failed', `이메일 코드 로그인에 실패했습니다.${message ? ` (${message.slice(0, 160)})` : ''}`);
}

export async function requestPortalEmailCode(client: PortalEmailCodeClient, rawEmail: string): Promise<string> {
  const email = normalizePortalLoginEmail(rawEmail);
  if (!email) throw new PortalEmailCodeError('invalid-input', '이메일 주소를 확인하세요.');
  const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) throw portalEmailCodeError(error);
  return email;
}

export async function verifyPortalEmailCode(client: PortalEmailCodeClient, email: string, rawCode: string): Promise<void> {
  const token = normalizePortalLoginCode(rawCode);
  if (!token) throw new PortalEmailCodeError('invalid-input', '메일로 받은 6~8자리 숫자 코드를 입력하세요.');
  const { error } = await client.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw portalEmailCodeError(error);
}
