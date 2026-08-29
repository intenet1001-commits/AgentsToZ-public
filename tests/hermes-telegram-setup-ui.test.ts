import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildTelegramProfileHandoffPrompt } from '../src/newDeviceTelegramBotSetupPrompt';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');

describe('Hermes default Telegram setup UI', () => {
  test('opens the official default-profile gateway setup without handling a token', () => {
    expect(api).toContain('/api/open-hermes-telegram-setup');
    const setupRoute = api.slice(api.indexOf('if (url.pathname === "/api/open-hermes-telegram-setup"'), api.indexOf('if (url.pathname === "/api/open-terminal-hermes"'));
    expect(setupRoute).toContain('profileName');
    expect(setupRoute).toContain('gateway setup');
    expect(setupRoute).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  test('builds an automatic handoff without manual BotFather values', () => {
    const prompt = buildTelegramProfileHandoffPrompt({ profileName: 'agentstoz-bot', deviceId: 'device-1', connectionMode: 'automatic' });
    expect(prompt).toContain('Automatic(QR)');
    expect(prompt).toContain('username은 Hermes/Telegram이 자동 생성');
    expect(prompt).not.toContain('아래 표시 이름과 username을 사용하고 token은 Hermes 공식 setup에 사용자가 직접 입력한다.');
  });

  test('separates manual and automatic connection controls', () => {
    expect(panel).toContain('data-testid="open-hermes-telegram-setup"');
    expect(panel).toContain('Telegram Bot 표시 이름');
    expect(panel).toContain('Telegram Bot username');
    expect(panel).toContain('이름 복사');
    expect(panel).toContain('username 복사');
    expect(panel).toContain('수동 · BotFather');
    expect(panel).toContain('자동 · QR 승인');
    expect(panel).toContain('자동 연결에서는 Bot 표시 이름과 username을 이 화면에서 입력하지 않습니다.');
    expect(panel).toContain('setTelegramConnectionMode');
    expect(panel).toContain('authoritative device_id');
    expect(panel).toContain('Telegram 연결 prompt 복사를 차단합니다.');
    expect(panel).toContain('로컬 Hermes Bot Chat · 권장(Telegram Bot 없음)');
    expect(panel).toContain('Telegram Bot · 별도 연결 필요');
    expect(panel).toContain('setNewProfileChannel');
    expect(panel).toContain('터미널 QR을 Telegram으로 스캔하고 Create Bot');
    expect(panel).toContain('5초마다 다시 확인합니다');
    expect(panel).toContain('setInterval(() => { void loadHermesProfiles(); }, 5000);');
    expect(panel).toContain('default Telegram Bot:');
    expect(panel).toContain("defaultHermesProfile?.telegramState === 'connected'");
    expect(panel).toContain('Telegram Bot 연결은 서로 다릅니다.');
    expect(panel).toContain('data-testid="onboarding-scroll-content"');
    expect(panel).toContain('max-h-[calc(100vh-2rem)]');
    expect(panel).toContain('flex-1 space-y-4 overflow-y-auto');
    expect(panel).toContain('flex shrink-0 flex-wrap justify-end');
    expect(panel).toContain('disabled={onboardingCopyBlocked}');
    expect(panel).toContain('nextAvailableHermesProfileName');
    expect(panel).toContain('autoCapitalize="none" autoCorrect="off" spellCheck={false}');
    expect(panel).toContain("fetch('http://127.0.0.1:3001/api/ports'");
    expect(panel).toContain('이미 존재하는 Hermes profile을 선택해 Telegram Bot만 연결합니다. 새 profile과 project는 이 화면에서 만들지 않습니다.');
    expect(panel).toContain("onboardingMode === 'project-hermes' && <button type=\"button\" data-testid=\"onboarding-new-profile\"");
    expect(panel).toContain("onboardingMode === 'project-hermes' && <label className=\"block space-y-1\"");
    expect(panel).toContain('Hermes ${onboardingProfile || \'default\'} profile의 Telegram 설정을 열었습니다');
  });
});
