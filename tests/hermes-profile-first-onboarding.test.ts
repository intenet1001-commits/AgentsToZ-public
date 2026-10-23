import { describe, expect, test } from 'bun:test';
import { buildHermesProfileOnboardingPrompt, hermesProfileDisplayName } from '../src/hermesProfileOnboardingPrompt';

describe('profile-first onboarding', () => {
  test('allows local or Telegram channel onboarding without a project', () => {
    const local = buildHermesProfileOnboardingPrompt({ profileName: 'local-agent', channel: 'local' });
    const telegram = buildHermesProfileOnboardingPrompt({ profileName: 'telegram-agent', channel: 'telegram' });
    expect(local).toContain('프로젝트 없이 profile과 채널만 연결');
    expect(local).toContain('로컬 Hermes Bot Chat');
    expect(telegram).toContain('Telegram Bot');
    expect(telegram).toContain('프로젝트 없이 profile과 채널만 연결');
  });

  test('shows friendly display names while preserving canonical profile IDs', () => {
    expect(hermesProfileDisplayName('default')).toBe('Hermes (default)');
    expect(hermesProfileDisplayName('cs-ceo')).toBe('CS CEO (cs-ceo)');
    expect(hermesProfileDisplayName('agentstoz-bot')).toBe('agentstoz-bot');
    expect(hermesProfileDisplayName(' default ')).toBe('Hermes (default)');
    expect(hermesProfileDisplayName('default', '회사 대표 Bot')).toBe('회사 대표 Bot (default)');
  });

  test('adds project matching only when the complete identity is supplied', () => {
    const prompt = buildHermesProfileOnboardingPrompt({ profileName: 'agent', channel: 'local', projectName: 'project-a', canonicalPath: '/work/project-a', memoryId: 'memory-a' });
    expect(prompt).toContain('선택적 project matching: project-a');
    expect(prompt).toContain('/work/project-a');
    expect(buildHermesProfileOnboardingPrompt({ profileName: 'agent', channel: 'local', projectName: 'project-a' })).toBe('');
  });
});
