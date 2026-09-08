import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const guide = readFileSync(join(import.meta.dir, '..', 'src', 'onboarding-guide-main.tsx'), 'utf8');
const manual = readFileSync(join(import.meta.dir, '..', 'docs', 'user-guide', 'GUIDE.md'), 'utf8');
const wizard = readFileSync(join(import.meta.dir, '..', 'src', 'SetupWizard.tsx'), 'utf8');

function section(from: string, to: string): string {
  return guide.slice(guide.indexOf(from), guide.indexOf(to));
}

describe('public guide AI handoff', () => {
  test('explains the copy-paste loop next to every major journey', () => {
    expect(guide).toContain('data-testid="guide-agent-handoff"');
    expect(guide).toContain('1. 프롬프트 복사');
    expect(guide).toContain('2. Claude·Codex 새 대화에 붙여넣기');
    expect(guide).toContain('3. AI가 알려주는 한 단계만 실행');
    expect(guide).toContain('로그인·비밀번호·토큰 입력은 직접');

    for (const journey of [
      section('id="first-device"', 'id="second-device"'),
      section('id="second-device"', 'id="aws"'),
      section('id="aws"', 'id="cloud-reuse"'),
      section('id="self-hosting"', '<Screenshot src={portalImage}'),
      section('id="windows-update-build"', '<div className="mt-8 overflow-hidden'),
    ]) {
      expect(journey).toContain('<AgentHandoff');
    }
  });

  test('gives first-device users direct platform prompts and the official Supabase entry point', () => {
    const firstDevice = section('id="first-device"', 'id="second-device"');
    expect(firstDevice).toContain("scenario: 'first'");
    expect(firstDevice).toContain("platform: 'windows'");
    expect(firstDevice).toContain("platform: 'mac'");
    expect(firstDevice).toContain('Windows용 프롬프트 복사');
    expect(firstDevice).toContain('macOS용 프롬프트 복사');
    expect(firstDevice).toContain('href: SUPABASE_DASHBOARD_URL');
    expect(firstDevice).toContain('Supabase Dashboard 열기');
    expect(guide).toContain("const SUPABASE_DASHBOARD_URL = 'https://supabase.com/dashboard'");
  });

  test('copies executable stage-specific prompts instead of explanatory labels', () => {
    expect(guide).toContain('buildGuideJourneyPrompt');
    expect(guide).toContain('이 과정만 맡아줘');
    expect(guide).toContain('현재 상태를 먼저 읽기 전용으로 확인');
    expect(guide).toContain('다음 행동은 한 번에 하나만');
    expect(guide).toContain('성공 증거를 확인한 뒤에만 다음 단계');
  });

  test('keeps a universal copy-paste fallback in the release manual', () => {
    expect(manual).toContain('## AI 복붙으로 모든 과정 진행하기');
    expect(manual).toContain('아래 프롬프트 전체를 복사');
    expect(manual).toContain('지금 필요한 과정부터 판정');
    expect(manual).toContain('다음 행동은 반드시 하나만');
    expect(manual).toContain('비밀번호·토큰·secret 입력은 내가 직접');
  });

  test('explains where to paste the prompt in the installed setup wizard', () => {
    expect(wizard).toContain('AI 전체 과정 프롬프트 복사');
    expect(wizard).toContain('Claude·Codex 새 대화에 그대로 붙여넣고');
    expect(wizard).toContain('AI가 알려주는 다음 행동 하나만 실행');
  });
});
