import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_LOGIN_EMAIL_HELP,
  ALLOWED_LOGIN_EMAIL_LABEL,
  APP_LOGIN_ACCOUNT_STEPS,
  IPHONE_APP_NEXT_STEPS,
  WEB_APP_OPTIONAL_STEPS,
  WEB_APP_OPTIONAL_TITLE,
} from '../src/appFirstOnboarding';
import { portalEmailCodeError } from '../src/portalEmailCodeAuth';
import { buildOnboardingAgentPrompt } from '../src/onboardingInfrastructure';

const root = join(import.meta.dir, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const wizard = source('src/SetupWizard.tsx');
const slice = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

// 기본 경로는 Mac 앱 + iPhone 앱(QR + 이메일 코드). Google OAuth·Redirect URL·Vercel은 웹앱 선택 영역에만 둔다.
describe('app-first onboarding structure', () => {
  test('the allowed email is a login email shared by the iPhone app code and the optional web Google login', () => {
    expect(ALLOWED_LOGIN_EMAIL_LABEL).toBe('로그인 허용 이메일');
    expect(ALLOWED_LOGIN_EMAIL_HELP).toContain('iPhone 앱의 이메일 코드 로그인');
    expect(ALLOWED_LOGIN_EMAIL_HELP).toContain('빈 목록은 모두 차단');
    for (const legacy of ['서버 RLS 허용 Google 이메일', 'Google 로그인 허용 이메일']) {
      expect(wizard).not.toContain(legacy);
    }
    // 네 입력 화면(CLI·권장·원클릭·포털)이 모두 같은 필드를 쓴다.
    expect((wizard.match(/<AllowedLoginEmailField /g) ?? [])).toHaveLength(4);
  });

  test('email-code login cannot create accounts, so setup tells the user to add the Supabase user', () => {
    expect(source('src/portalEmailCodeAuth.ts')).toContain('shouldCreateUser: false');
    expect(APP_LOGIN_ACCOUNT_STEPS.join(' ')).toContain('Authentication → Users → Add user');
    const noAccount = portalEmailCodeError({ code: 'otp_disabled', message: 'Signups not allowed for otp' });
    expect(noAccount.kind).toBe('no-account');
    expect(noAccount.message).toContain('Add user');
  });

  test('the recommended first-device wizard is app-first and keeps web setup collapsed', () => {
    const first = slice(wizard, 'function FirstSetupWizard', '// ─── Additional Device Wizard');
    const titles = [...first.matchAll(/\{ title: '([^']+)' \}/g)].map(match => match[1]);
    expect(titles).toEqual(['Supabase 프로젝트·로그인 이메일', 'SQL·RLS 적용', '안전한 연결 확인', '이 기기 이름']);
    expect(first).not.toContain('api/auth/native/callback');
    expect(first).not.toContain('Redirect URL 등록을 완료');
    expect(first.indexOf('<WebAppOptionalDetails')).toBeGreaterThan(first.indexOf('SQL 실행을 완료했습니다'));
    expect(first).toContain('<IphoneAppNextStep />');
    // 체크박스는 SQL 적용만 요구하고 이메일이 바뀌면 다시 확인하게 한다.
    expect(first).toContain('canNext={[allowedEmailValid, allowedEmailValid && schemaApplied,');
  });

  test('web-only pieces live inside a collapsed <details>, never as a required step', () => {
    const optional = slice(wizard, 'function WebAppOptionalDetails', '// ─── Migration SQL');
    expect(optional).toContain('<details');
    expect(optional).not.toContain('<details open');
    expect(optional).toContain('{LEGACY_NATIVE_CALLBACK_REDIRECT}');
    expect(WEB_APP_OPTIONAL_TITLE).toBe('웹앱으로도 쓰기 (선택)');
    expect(WEB_APP_OPTIONAL_STEPS.join(' ')).toContain('Providers → Google');
    // Google 로그인이 필요하다는 안내는 배포 웹에서만 뜬다.
    expect(wizard).not.toMatch(/authRequired && !isTauri\(\) && \(\s*<InfoBox color="blue">\s*<p className="text-xs font-semibold">Google/);
    expect(wizard).toContain("isDeployedWeb() ? 'Google 로그인 대기 중…' : '연결 설정 중…'");
  });

  test('the next step after setup is pairing the iPhone app by QR and email code', () => {
    const steps = IPHONE_APP_NEXT_STEPS.join(' ');
    expect(steps).toContain('원격제어 → 앱으로 원격제어');
    expect(steps).toContain('QR');
    expect(steps).toContain('코드');
    expect(steps).not.toContain('Google');
    expect(steps).not.toContain('service_role');
    // Away from the Mac: the link connects data only; control still needs the QR + approval.
    expect(steps).toContain('폰 연결 링크');
    expect(steps).toContain('QR 승인');
    expect(source('src/OnboardingInfrastructureCenter.tsx')).toContain('data-testid="onboarding-iphone-app-path"');
  });

  test('the AI setup prompt does not send app users through Google OAuth or Vercel', () => {
    const prompt = buildOnboardingAgentPrompt({ scenario: 'first', platform: 'mac', runtimeMode: 'packaged' });
    expect(prompt).toContain('기본 경로는 Mac 앱 + iPhone 앱');
    expect(prompt).toContain('Google OAuth·Redirect URL·Vercel은 사용자가 웹앱을 원할 때만');
  });
});
