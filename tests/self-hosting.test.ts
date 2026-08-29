import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSelfHostingAgentPrompt,
  buildVercelImportUrl,
  publicGitHubRepositoryUrl,
} from '../src/selfHosting';

const root = join(import.meta.dir, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('public self-hosting flow', () => {
  const privatePortalHost = [
    ['portmanager', 'portal'].join('-'),
    'vercel',
    'app',
  ].join('.');

  test('accepts only credential-free public GitHub repository URLs', () => {
    expect(publicGitHubRepositoryUrl('https://github.com/example/my-agentstoz.git'))
      .toBe('https://github.com/example/my-agentstoz');

    const fallback = 'https://github.com/safe-owner/safe-repo';
    for (const unsafe of [
      'https://user:token@github.com/example/repo',
      'https://github.com/example/repo?token=secret',
      'https://github.com/example/repo#credential',
      'https://gitlab.com/example/repo',
      'file:///private/repo',
      'https://github.com/example/repo/extra',
    ]) {
      expect(publicGitHubRepositoryUrl(unsafe, fallback)).toBe(fallback);
    }
  });

  test('builds a Vercel import URL containing the repository and no environment values', () => {
    const importUrl = new URL(buildVercelImportUrl('https://github.com/example/my-agentstoz'));
    expect(importUrl.origin).toBe('https://vercel.com');
    expect(importUrl.pathname).toBe('/new/clone');
    expect([...importUrl.searchParams.keys()]).toEqual(['repository-url']);
    expect(importUrl.searchParams.get('repository-url')).toBe('https://github.com/example/my-agentstoz');

    const serialized = importUrl.toString().toLowerCase();
    for (const forbidden of ['supabase', 'anon', 'service_role', 'allowed_email', 'token', 'secret']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('gives any AI a self-hosting prompt with the authenticated-RLS boundary', () => {
    const prompt = buildSelfHostingAgentPrompt('https://github.com/example/my-agentstoz');
    expect(prompt).toContain('내가 로그인한 Vercel 계정');
    expect(prompt).toContain('내가 소유한 Supabase 프로젝트');
    expect(prompt).toContain('query parameter로 전달하지 말고');
    expect(prompt).toContain('service_role은 데스크톱 앱의 로컬 sidecar 전용');
    expect(prompt).toContain('authenticated 세션만');
    expect(prompt).toContain('VITE_ALLOWED_EMAIL은 UI 사전 필터');
    expect(prompt).toContain('새 UUID');
    expect(prompt).not.toContain(privatePortalHost);
  });

  test('requires an explicit Vercel account confirmation before automatic production deploy', () => {
    const setup = source('src/SetupWizard.tsx');
    expect(setup).toContain('내 계정에서 Deploy with Vercel');
    expect(setup).toContain('SELF_HOSTING_AGENT_PROMPT');
    expect(setup).toContain('setVercelOwnershipConfirmed(false)');
    expect(setup).toContain('disabled={!allowedEmailValid || !vercelUser || !vercelOwnershipConfirmed}');
    expect(setup).toContain('vercel whoami');
    expect(setup).toContain('vercel link');
    expect(setup).toContain('vercel env add VITE_SUPABASE_URL production');
    expect(setup).toContain('vercel deploy --prod');
  });

  test('shows the same owner-isolated flow in the public guide and standalone manual', () => {
    const guide = source('src/onboarding-guide-main.tsx');
    const manual = source('docs/SELF-HOSTING.md');
    expect(guide).toContain('내 Supabase + 내 Vercel로 완전히 분리해 씁니다.');
    expect(guide).toContain('Deploy 버튼 URL에는');
    expect(guide).toContain('docs/SELF-HOSTING.md');
    expect(manual).toContain('자기 Supabase와 자기 Vercel');
    expect(manual).toContain('service_role');
    expect(manual).toContain('Deploy with Vercel');
    expect(guide).not.toContain(privatePortalHost);
    expect(manual).not.toContain(privatePortalHost);
  });

  test('keeps the standalone beginner manual actionable and in dependency order', () => {
    const manual = source('docs/SELF-HOSTING.md');
    const headings = [
      '## 1. Supabase 프로젝트 준비',
      '## 2. 정본 SQL 실행과 owner 이메일 등록',
      '## 3. Google OAuth 연결',
      '## 4. 공개 GitHub를 내 Vercel로 가져오고 배포',
      '## 5. Supabase Redirect URL 등록과 실제 로그인',
    ];
    const positions = headings.map(heading => manual.indexOf(heading));

    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    for (let index = 0; index < positions.length; index += 1) {
      const end = positions[index + 1] ?? manual.length;
      expect(manual.slice(positions[index], end)).toContain('**성공 근거:**');
    }

    expect(manual).toContain('초기 설정 → 첫 단말 · 동기화 설정 → 동기화 DB 준비');
    expect(manual).toContain('migrationSqlForAllowedEmails');
    expect(manual).toContain('ALLOWED_EMAIL=owner@example.com bun -e');
    expect(manual).toContain("$env:ALLOWED_EMAIL = 'owner@example.com'");
    expect(manual).toContain("and grantee in ('anon', 'PUBLIC')");
    expect(manual).toContain('VITE_SUPABASE_URL');
    expect(manual).toContain('VITE_SUPABASE_ANON_KEY');
    expect(manual).toContain('VITE_ALLOWED_EMAIL');
    expect(manual).toContain('https://<내-프로젝트>.vercel.app/');
  });

  test('README permits the documented non-commercial personal self-host path', () => {
    const readme = source('README.md');
    expect(readme).toContain('본인 계정의 Supabase·Vercel');
    expect(readme).toContain('비상업적으로 배포해 본인이 사용하는 것');
    expect(readme).toContain('수정본');
    expect(readme).toContain('별도 서면 허가');
  });
});
