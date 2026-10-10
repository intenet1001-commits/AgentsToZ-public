import { parseRemoteControlRelayPairingUrl } from './remoteControlRelayContract';

/**
 * A web portal serves ONE Supabase project (compiled in as VITE_SUPABASE_URL). Macs that
 * self-host their own Supabase and use only the iPhone app issue QRs with the public default
 * controller origin (`src/defaultRemoteControllerOrigin.ts`), so a phone CAMERA scan of such a
 * QR lands on this public page. Signing in here would hit this portal's project, where that
 * person is not a member — a login that can only fail RLS. So before any login, relay or vault
 * work, the page asks: whose Supabase is this QR for?
 *
 * Returns the QR's Supabase URL when it is a different project; null when the page should
 * behave as before (bundled app portal, no/invalid fragment, QR from an older Mac without a
 * `supabase` bootstrap, or the same project).
 */
export function portalForeignPairing(input: {
  fragment: string;
  isBundled: boolean;
  portalSupabaseUrl: string;
  pageOrigin: string;
}): { qrSupabaseUrl: string } | null {
  if (input.isBundled || !input.fragment) return null;
  let qrSupabaseUrl: string | undefined;
  try {
    qrSupabaseUrl = parseRemoteControlRelayPairingUrl(`${input.pageOrigin}/remote/#${input.fragment}`)
      .bootstrap.supabase?.url;
  } catch {
    return null;
  }
  if (!qrSupabaseUrl) return null;
  return sameOrigin(qrSupabaseUrl, input.portalSupabaseUrl) ? null : { qrSupabaseUrl };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export const PORTAL_FOREIGN_PAIRING_TITLE =
  '이 QR은 다른 사용자의 AgentsToZ(자기 Supabase)용입니다. iPhone의 AgentsToZ 앱으로 스캔하세요.';
export const PORTAL_FOREIGN_PAIRING_APP_HINT =
  'AgentsToZ iPhone 앱은 App Store 또는 TestFlight 초대로 설치합니다. 앱을 열고 첫 화면의 「기기 연결 · QR 스캔」으로 Mac의 QR을 다시 찍으면 그 Mac의 Supabase로 연결됩니다.';
export const PORTAL_FOREIGN_PAIRING_WHY =
  '휴대폰 카메라로 찍으면 이 공개 웹 포털이 열리지만, 이 웹 포털은 다른 Supabase 프로젝트를 씁니다. 여기서 로그인해도 그 Mac에 연결되지 않으므로 로그인을 보여 주지 않습니다.';
