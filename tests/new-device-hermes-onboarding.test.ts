import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const root=join(import.meta.dir,'..');
describe('current device onboarding surface',()=>{
  test('keeps one-project Hermes and one-profile Telegram setup',()=>{
    const directory=readFileSync(join(root,'src/PortalMemoryDirectory.tsx'),'utf8');
    expect(directory).toContain('data-testid="portal-memory-copy-hermes-onboarding"');
    expect(directory).toContain('data-testid="portal-memory-copy-telegram-onboarding"');
    expect(directory).toContain('buildTelegramProfileHandoffPrompt');
    expect(directory).not.toContain('buildNewDeviceHermesSetupPrompt');
    expect(directory).not.toContain('buildTelegramBotOnboardingPrompt');
    expect(directory).not.toContain('portal-memory-copy-telegram-bot-batch');
  });

  test('does not surface the retired three-bot CS-CEO bootstrap',()=>{
    const directory=readFileSync(join(root,'src/PortalMemoryDirectory.tsx'),'utf8');
    const panel=readFileSync(join(root,'src/ProjectMemoryPanel.tsx'),'utf8');
    expect(directory).not.toContain('CS CEO');
    expect(directory).not.toContain('Telegram Bot 3개 만들기');
    expect(panel).not.toContain('data-testid="copy-new-device-hermes-setup"');
    expect(panel).not.toContain('data-testid="copy-telegram-bot-onboarding"');
  });
});
