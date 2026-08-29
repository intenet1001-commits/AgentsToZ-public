import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNewDeviceHermesSetupPrompt, NEW_DEVICE_HERMES_SETUP_MANUAL } from "../src/newDeviceHermesSetupPrompt";
import { buildTelegramBotOnboardingPrompt, TELEGRAM_BOT_ONBOARDING_MANUAL } from "../src/newDeviceTelegramBotSetupPrompt";

const root = join(import.meta.dir, "..");

describe("new device Hermes Bot onboarding handoff", () => {
  test("keeps the full procedure in a repository manual", () => {
    const manualPath = join(root, NEW_DEVICE_HERMES_SETUP_MANUAL);
    expect(existsSync(manualPath)).toBe(true);
    const manual = readFileSync(manualPath, "utf8");
    expect(manual).toContain("새 단말 identity 등록");
    expect(manual).toContain("Hermes Desktop 단체방 설정");
    expect(manual).toContain("duplicate request");
    expect(manual).toContain("remote inSync=true");
    expect(manual).toContain("commit/push가 사용자 승인 없이 실행됨");
  });

  test("copies only the manual location and short read commands", () => {
    const prompt = buildNewDeviceHermesSetupPrompt();
    expect(prompt).toContain("Hermes Bot 2개 + 3명 단체톡");
    expect(prompt).toContain("Hermes + agentstoz-bot + cs-ceo");
    expect(prompt).toContain("3 bots / 3 of 3 available");
    expect(prompt).toContain(NEW_DEVICE_HERMES_SETUP_MANUAL);
    expect(prompt).toContain("sed -n '1,260p'");
    expect(prompt).toContain("Get-Content");
    expect(prompt).not.toContain("device_credential");
    expect(prompt).not.toContain("service-role");
    expect(prompt.length).toBeLessThan(1000);
  });

  test("Telegram Bot onboarding stays secret-free and device-scoped", () => {
    const manualPath = join(root, TELEGRAM_BOT_ONBOARDING_MANUAL);
    expect(existsSync(manualPath)).toBe(true);
    const prompt = buildTelegramBotOnboardingPrompt();
    expect(prompt).toContain(TELEGRAM_BOT_ONBOARDING_MANUAL);
    expect(prompt).toContain("<alias> · Hermes");
    expect(prompt).toContain("<alias> · AgentsToZ");
    expect(prompt).toContain("<alias> · CS CEO");
    expect(prompt).toContain("BotFather");
    expect(prompt).toContain("present/not present");
    expect(prompt).not.toMatch(/123456:[A-Za-z0-9_-]{20,}/);
    expect(prompt).not.toContain("service-role");
    const manual = readFileSync(manualPath, "utf8");
    expect(manual).toContain("기존 Hermes Bot이 이미 이 단말에 연결되어 있으면 Bot을 새로 만들지 않는다");
    expect(manual).toContain("token 값은 기록하지 않는다");
    expect(manual).toContain("member count = 3 bots");
  });

  test("exposes both desktop and Telegram onboarding copy buttons", () => {
    const panel = readFileSync(join(root, "src/ProjectMemoryPanel.tsx"), "utf8");
    expect(panel).toContain('data-testid="copy-new-device-hermes-setup"');
    expect(panel).toContain('data-testid="copy-telegram-bot-onboarding"');
    expect(panel).toContain("newDeviceHermesSetupPrompt");
    expect(panel).toContain("telegramBotOnboardingPrompt");
  });

  test("keeps onboarding prompts visible in the selected-project view", () => {
    const app = readFileSync(join(root, "src/App.tsx"), "utf8");
    const panel = readFileSync(join(root, "src/ProjectMemoryPanel.tsx"), "utf8");
    expect(app).toContain("<ProjectMemoryPanel");
    expect(app).toContain("compact");
    expect(panel).toContain('data-testid="project-memory-setup-prompts"');
    expect(panel).toContain("open={compact}");
    expect(panel).not.toContain("{!compact && (\n          <details data-testid=\"project-memory-setup-prompts\"");
  });

  test("shows both onboarding copy buttons in the memory directory", () => {
    const directory = readFileSync(join(root, "src/PortalMemoryDirectory.tsx"), "utf8");
    expect(directory).toContain('data-testid="portal-memory-onboarding-actions"');
    expect(directory).toContain('data-testid="portal-memory-copy-hermes-onboarding"');
    expect(directory).toContain('data-testid="portal-memory-copy-telegram-onboarding"');
    expect(directory).toContain("buildNewDeviceHermesSetupPrompt");
    expect(directory).toContain("buildTelegramBotOnboardingPrompt");
  });
});
