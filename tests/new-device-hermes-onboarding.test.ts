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

  // 이 버튼들은 프로젝트 상세 패널과 장기기억 탭 두 곳에 있었다. 프로젝트 하나가 아니라
  // 단말 하나에 한 번 하는 작업이라 장기기억 탭 한 곳으로 모았다(VOC 2026-08-28).
  test("exposes both desktop and Telegram onboarding copy buttons in the memory tab", () => {
    const directory = readFileSync(join(root, "src/PortalMemoryDirectory.tsx"), "utf8");
    expect(directory).toContain('data-testid="portal-memory-copy-hermes-onboarding"');
    expect(directory).toContain('data-testid="portal-memory-copy-telegram-bot-batch"');
    expect(directory).toContain('<details data-testid="portal-memory-telegram-advanced"');
    expect(directory).not.toContain('<details open data-testid="portal-memory-telegram-advanced"');
    expect(directory).toContain('일반 연결에는 위의 profile 1개 연결을 사용하세요.');
    expect(directory).toContain("buildNewDeviceHermesSetupPrompt");
    expect(directory).toContain("buildTelegramBotOnboardingPrompt");
  });

  test("stops duplicating them inside the project panel", () => {
    const panel = readFileSync(join(root, "src/ProjectMemoryPanel.tsx"), "utf8");
    expect(panel).not.toContain('data-testid="copy-new-device-hermes-setup"');
    expect(panel).not.toContain('data-testid="copy-telegram-bot-onboarding"');
    expect(panel).not.toContain('data-testid="copy-telegram-profile-handoff"');
  });

  // 걷어내되 말없이 사라지면 안 된다 — 선택된 프로젝트 화면은 옮겨 간 자리를 가리키고,
  // 그 자리로 바로 갈 수 있어야 한다.
  test("points the selected-project view at the memory tab instead", () => {
    const app = readFileSync(join(root, "src/App.tsx"), "utf8");
    const panel = readFileSync(join(root, "src/ProjectMemoryPanel.tsx"), "utf8");
    expect(app).toContain("<ProjectMemoryPanel");
    expect(app).toContain("compact");
    expect(app).toContain("onOpenMemoryTab={() => setActiveTab('memory')}");
    expect(panel).toContain('data-testid="project-memory-external-setup-pointer"');
    expect(panel).toContain('data-testid="project-memory-open-memory-tab"');
    expect(panel).not.toContain('data-testid="project-memory-setup-prompts"');
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
