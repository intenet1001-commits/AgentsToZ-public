import { describe, expect, test } from 'bun:test';
import { buildNewHermesProfilePreparationPrompt, nextAvailableHermesProfileName, validateHermesProfileName } from '../src/hermesProfileOnboardingPrompt';

describe('새 Hermes profile 준비', () => {
  test('profile 이름을 안전하게 검증한다', () => {
    expect(validateHermesProfileName('new-agent')).toBe(true);
    expect(validateHermesProfileName('')).toBe(false);
    expect(validateHermesProfileName('../escape')).toBe(false);
    expect(validateHermesProfileName('a'.repeat(65))).toBe(false);
  });

  test('기존 이름과 중복이면 준비 prompt를 만들지 않는다', () => {
    expect(buildNewHermesProfilePreparationPrompt({ profileName: 'cs-ceo', existingProfiles: ['agentstoz-bot', 'cs-ceo'], channel: 'telegram' })).toBe('');
    expect(buildNewHermesProfilePreparationPrompt({ profileName: 'CS-CEO', existingProfiles: ['cs-ceo'], channel: 'telegram' })).toBe('');
  });

  test('새 profile 화면을 열면 즉시 쓸 수 있는 이름을 채운다', () => {
    expect(nextAvailableHermesProfileName([])).toBe('new-agent');
    expect(nextAvailableHermesProfileName(['new-agent'])).toBe('new-agent-2');
    expect(nextAvailableHermesProfileName([], 'My Project')).toBe('my-project-bot');
  });

  test('로컬 Chat의 기본 실행 모델은 Hermes Codex SOL이다', () => {
    const prompt = buildNewHermesProfilePreparationPrompt({ profileName: 'sol-worker', existingProfiles: [], channel: 'local' });
    const defaultPrompt = buildNewHermesProfilePreparationPrompt({ profileName: 'default-worker', existingProfiles: [], channel: 'local', model: 'profile-default' });
    expect(defaultPrompt).toContain('gpt-5.6-luna');
    expect(defaultPrompt).toContain('SOL 아님');
    expect(prompt).toContain('gpt-5.6-sol');
    expect(prompt).toContain('Hermes Codex SOL');
  });

  test('새 profile 준비는 자동 생성하지 않고 선택 채널만 안내한다', () => {
    const prompt = buildNewHermesProfilePreparationPrompt({ profileName: 'telegram-worker', existingProfiles: ['default'], channel: 'telegram' });
    expect(prompt).toContain('자동으로 profile 디렉터리나 gateway를 생성하지');
    expect(prompt).toContain('Telegram Bot');
    expect(prompt).not.toMatch(/token\s*[:=]/i);
  });
});
