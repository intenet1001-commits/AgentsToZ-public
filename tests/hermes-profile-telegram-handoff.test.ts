import { describe, expect, test } from 'bun:test';
import { buildTelegramProfileHandoffPrompt, isValidTelegramBotUsername, suggestTelegramBotNaming } from '../src/newDeviceTelegramBotSetupPrompt';

describe('Hermes profile to Telegram handoff', () => {
  test('profile 기반 BotFather 이름과 username을 추천한다', () => {
    expect(suggestTelegramBotNaming('default', '회사에서받은맥북')).toEqual({ displayName: '회사에서받은맥북 Hermes Bot', username: 'workmacbook_hermes_bot' });
    expect(suggestTelegramBotNaming('default', '워크맥북_헤르메스', 'AgentsToZ_byCS')).toEqual({ displayName: '워크맥북_헤르메스 AgentsToZ_byCS Bot', username: 'workmacbook_hermes_agentstoz_bot' });
    expect(suggestTelegramBotNaming('cs-ceo', 'MacBook-Pro')).toEqual({ displayName: 'MacBook-Pro cs-ceo Bot', username: 'macbook_pro_cs_ceo_bot' });
    expect(isValidTelegramBotUsername('cs_ceo_bot')).toBe(true);
    expect(isValidTelegramBotUsername('bad-name')).toBe(false);
  });

  test('includes selected profile, project and device identity', () => {
    const prompt = buildTelegramProfileHandoffPrompt({
      profileName: 'csncompany2-0-hermes',
      projectName: 'csncompany2-0',
      canonicalPath: '/work/csncompany2-0',
      memoryId: 'memory-1',
      deviceName: '테스트 맥북',
      deviceId: 'device-1',
    });
    expect(prompt).toContain('csncompany2-0-hermes');
    expect(prompt).toContain('memory-1');
    expect(prompt).toContain('테스트 맥북');
    expect(prompt).toContain('authoritative device_id: device-1');
    expect(prompt).toContain('사용자가 그룹을 만든 뒤');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).not.toMatch(/\\d{8,}:[A-Za-z0-9_-]{20,}/);
  });

  test('fails closed without a profile or device identity', () => {
    expect(buildTelegramProfileHandoffPrompt({ profileName: ' ' })).toBe('');
    expect(buildTelegramProfileHandoffPrompt({ profileName: 'agentstoz-bot' })).toBe('');
  });
});
