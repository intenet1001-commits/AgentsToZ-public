import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Regression: ISSUE-005 — 개인 포털의 결과와 발급된 Vercel 주소의 다음 행동이 묻혀 있었음
// Found by /qa on 2026-08-29
// Report: .gstack/qa-reports/qa-report-agentstoz-guide-vercel-app-2026-08-29.md
describe('public guide optional personal portal path', () => {
  test('keeps the portal path findable without presenting it as desktop installation', () => {
    const guide = source('src/onboarding-guide-main.tsx');
    const wizard = source('src/SetupWizard.tsx');

    expect(guide).toContain('선택 기능 · 개인 웹 포털');
    expect(guide).toContain('데스크톱 앱을 설치하는 과정이 아닙니다.');
    expect(guide).toContain('발급 주소를 Supabase Redirect URLs에 연결하고 로그인');
    expect(guide).toContain('Supabase Redirect URLs');
    expect(guide).not.toContain('가장 쉬운 웹 설치 · Vercel');
    expect(wizard).toContain('data-testid="setup-personal-portal-optional"');
    expect(wizard).not.toContain('data-testid="setup-personal-portal-primary"');
    expect(wizard).not.toContain('웹에서 쓰는 가장 쉬운 설치');
    expect(wizard.indexOf('로컬로 바로 시작')).toBeLessThan(wizard.indexOf('setup-personal-portal-optional'));
    expect(wizard).toContain('선택 기능 · 개인 웹 포털과 고급 설정');
    expect(wizard).toContain('Vercel 가입 → 내 주소 받기 → Supabase Redirect URLs에 붙여넣기');
    expect(wizard).toContain('데스크톱 앱 설치나 내 PC의 GitHub clone 과정은 아닙니다.');
    expect(wizard).toContain('이 단계는 데스크톱 앱 설치가 아니라 선택형 개인 웹 포털 생성입니다.');

    const portalWizard = wizard.slice(
      wizard.indexOf('function PortalVercelWizard'),
      wizard.indexOf('// ─── Shared Wizard Layout'),
    );
    const outcomeStep = portalWizard.slice(portalWizard.indexOf('/* 0: Outcome boundary */'), portalWizard.indexOf('/* 1: Supabase SQL */'));
    const deployStep = portalWizard.slice(portalWizard.indexOf('/* 3: Vercel deploy */'), portalWizard.indexOf('/* 4: Connect device */'));
    expect(outcomeStep).toContain('만들지 않는 것');
    expect(outcomeStep).not.toContain('href={VERCEL_IMPORT_URL}');
    expect(deployStep).toContain('href={VERCEL_IMPORT_URL}');
    expect(portalWizard.indexOf("{ title: 'Supabase 데이터 준비' }")).toBeLessThan(portalWizard.indexOf("{ title: 'Vercel 프로젝트·배포' }"));
    expect(portalWizard).toContain('title="개인 웹 포털 만들기"');
  });
});
