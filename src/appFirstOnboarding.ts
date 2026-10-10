/**
 * 앱 우선(app-first) 온보딩 문구의 정본.
 *
 * 기본 경로는 **Mac 앱 + iPhone 앱**이다. iPhone 앱은 Mac의 「원격제어 → 앱으로 원격제어」 QR을
 * 스캔해 Supabase 주소·공개(anon) 키를 받고, 이메일 코드로 로그인한다. Mac 앞이 아니면 같은 채널의
 * 「폰 연결 링크」(`src/phoneConnectLink.ts`)로 ① 데이터 연결만 먼저 하고, ② 제어는 나중에 QR+승인으로 연다. 그래서 기본 경로에는
 * Google OAuth·Redirect URL·Vercel 배포가 필요 없다 — 그것들은 「웹앱으로도 쓰기 (선택)」에만 둔다.
 *
 * 사실 근거(코드로 확인):
 * - Mac 앱(Tauri)은 로컬 관리자 연결(sidecar service_role)로 올리기/받기를 하므로 사용자 로그인이 없다.
 *   Google JWT를 요구하는 것은 배포한 웹앱(`isDeployedWeb()`)뿐이다.
 * - 서버 권한 `portmgr_is_member()`는 JWT의 이메일로 판정한다. iPhone 앱의 이메일 코드 로그인과
 *   웹앱의 Google 로그인이 **같은 허용 이메일**을 쓴다 — 그래서 입력칸은 「로그인 허용 이메일」이다.
 * - 이메일 코드 요청은 `shouldCreateUser: false`라 계정을 새로 만들지 않는다
 *   (`src/portalEmailCodeAuth.ts`). Google 로그인을 한 번도 안 한 사용자는 Supabase에 그 이메일의
 *   사용자를 먼저 추가해야 코드가 발송된다.
 * - `http://127.0.0.1:3001/api/auth/native/callback/*`는 예전 데스크톱 Google 로그인 경로다.
 *   현재 호출부가 없으므로 기본 경로에서 요구하지 않는다(웹앱 선택 영역에 호환용으로만 남긴다).
 */

export const ALLOWED_LOGIN_EMAIL_LABEL = '로그인 허용 이메일';

export const ALLOWED_LOGIN_EMAIL_HELP =
  'iPhone 앱의 이메일 코드 로그인에 쓰는 이메일입니다. 웹앱을 쓰기로 했다면 같은 이메일로 Google 로그인합니다. '
  + '이 목록이 서버(RLS)의 실제 접근 권한이며, 빈 목록은 모두 차단합니다.';

export const ALLOWED_LOGIN_EMAIL_REQUIRED_SQL_COMMENT = '-- 먼저 로그인 허용 이메일을 입력하세요.';

/** 이메일 코드 로그인은 계정을 만들지 않으므로, 허용 이메일의 Supabase 사용자를 한 번 만들어 둔다. */
export const APP_LOGIN_ACCOUNT_TITLE = 'iPhone 앱 로그인 계정 만들기 (권장)';
export const APP_LOGIN_ACCOUNT_STEPS = [
  'Supabase Dashboard → Authentication → Users → Add user → Create new user',
  '위 로그인 허용 이메일을 입력하고 Auto Confirm User를 켭니다. 비밀번호는 쓰지 않으니 아무 값이나 넣어도 됩니다.',
] as const;
export const APP_LOGIN_ACCOUNT_REASON =
  'iPhone 앱의 이메일 코드 로그인은 계정을 새로 만들지 않습니다. Google 로그인이나 Redirect URL 설정은 필요 없습니다.';

export const APP_LOGIN_ACCOUNT_SHORT =
  '처음이라면 Supabase Authentication → Users에 로그인 허용 이메일 사용자를 한 번 추가해 두세요. 이메일 코드 로그인은 계정을 새로 만들지 않습니다.';

export const DESKTOP_NO_LOGIN_NOTE =
  '로컬 관리자 연결을 확인했으므로 앱에서는 Google 로그인 없이 Push/Pull을 사용합니다.';

export const DEPLOYED_WEB_LOGIN_NOTE =
  '배포한 웹앱(브라우저)에서 설정하는 경우에만 완료할 때 Google 로그인 창이 열립니다. Mac 앱과 iPhone 앱에는 Google 로그인이 필요 없습니다.';

export const IPHONE_APP_NEXT_TITLE = '다음 단계 · iPhone 앱 연결';
export const IPHONE_APP_NEXT_STEPS = [
  'Mac 앱에서 원격제어 → 앱으로 원격제어를 엽니다.',
  'iPhone의 AgentsToZ 앱으로 QR을 스캔합니다. Supabase 주소와 공개 키가 QR에 들어 있어 따로 입력할 것이 없습니다.',
  '로그인 허용 이메일로 받은 코드를 입력하면 연결됩니다.',
  'Mac 앞이 아니라면 같은 화면의 「폰 연결 링크 복사」로 링크를 iPhone에 보내 먼저 데이터만 연결할 수 있습니다(앱의 「연결 링크 붙여넣기」). 로그인하면 현황·북마크·기록을 볼 수 있고, Mac 제어는 나중에 Mac 앞에서 QR 승인 후에 열립니다.',
] as const;
export const IPHONE_APP_NEXT_NOTE =
  'Supabase 기본 메일은 시간당 발송 수가 적습니다(약 2통). 가끔 로그인하는 데는 충분하고, 이미 받은 코드는 그대로 쓸 수 있습니다.';

export const WEB_APP_OPTIONAL_TITLE = '웹앱으로도 쓰기 (선택)';
export const WEB_APP_OPTIONAL_SUMMARY =
  '대부분은 필요 없습니다. iPhone 앱 대신 브라우저에서 쓰고 싶을 때만 Google 로그인·Redirect URL·Vercel 배포를 준비합니다.';

export const LEGACY_NATIVE_CALLBACK_REDIRECT = 'http://127.0.0.1:3001/api/auth/native/callback/*';

export const WEB_APP_OPTIONAL_STEPS = [
  'Supabase Dashboard → Authentication → Providers → Google을 켜고 Client ID·Secret을 저장합니다.',
  '웹앱 주소(예: https://<내 포털>.vercel.app/**)를 Authentication → URL Configuration → Redirect URLs에 추가합니다.',
  '웹앱을 배포하려면 「웹앱으로도 쓰기 (선택)」의 개인 웹 포털 만들기를 따릅니다.',
] as const;
