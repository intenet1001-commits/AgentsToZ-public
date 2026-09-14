import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const panel = readFileSync(join(root, "src", "ProjectMemoryPanel.tsx"), "utf8");
const directory = readFileSync(join(root, "src", "PortalMemoryDirectory.tsx"), "utf8");
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");

describe("AI 이름 생성 — 새로고침과 채팅 복사는 한 쌍으로 보인다", () => {
  test("두 버튼이 한 테두리 안에 묶여 있다", () => {
    const group = app.slice(
      app.indexOf('data-testid="ai-name-refresh-group"'),
      app.indexOf('data-testid="ports-supabase-push"'),
    );
    expect(group.length).toBeGreaterThan(0);
    expect(group).toContain('data-testid="copy-batch-ai-name-chat-prompt"');
    expect(group).toContain('data-help-key="btn-refresh"');
  });

  test("두 title 이 서로를 가리켜, 어느 쪽이 복붙 경로인지 말한다", () => {
    expect(app).toContain("오른쪽 새로고침이 하는 AI 이름·카테고리 생성을");
    expect(app).toContain("오래 걸리면 왼쪽 「AI 이름 채팅 복사」");
  });
});

// VOC 2026-08-28 21:53 — "이 두개는 이 앱을 안쓸때 참고하는 기능인데 인지가 안되네".
// 라벨이 동작("다른 폴더에서 수동 실행")만 말하고 용도(이 앱이 없는 환경)를 말하지 않았다.
describe("환경 단위 설치·연결은 이름이 용도를 먼저 말한다", () => {
  test("장기기억 탭 한 곳에 모여 있다", () => {
    expect(directory).toContain('data-testid="portal-memory-external-setup"');
    for (const testId of [
      "portal-memory-copy-standalone-init",
      "portal-memory-copy-manual-init",
      "portal-memory-copy-aws-ubuntu-setup",
    ]) {
      expect(directory).toContain(`data-testid="${testId}"`);
    }
  });

  test("라벨이 어떤 환경을 위한 것인지 먼저 말한다", () => {
    expect(directory).toContain("이 앱이 없는 PC에 장기기억 만들기");
    expect(directory).toContain("앱은 있는 PC의 다른 폴더에 장기기억 만들기");
    expect(directory).toContain("AWS Ubuntu 서버를 이 Supabase에 연결");
    expect(directory).toContain("PC·서버 한 대에 한 번");
    // 동작만 말하던 옛 라벨로 되돌아가지 않게 한다.
    expect(directory).not.toContain("다른 폴더에서 수동 실행");
  });

  test("프로젝트 패널에는 복사 버튼 대신 옮겨 간 자리를 가리키는 한 줄만 남는다", () => {
    expect(panel).toContain('data-testid="project-memory-external-setup-pointer"');
    expect(panel).toContain("환경 단위 설치·연결");
    for (const testId of [
      "copy-manual-init-prompt",
      "copy-standalone-init-prompt",
      "copy-aws-ubuntu-memory-setup",
      "copy-new-device-hermes-setup",
      "copy-telegram-profile-handoff",
      "copy-telegram-bot-onboarding",
      "hermes-project-profile-name",
      "project-memory-setup-prompts",
    ]) {
      expect(panel).not.toContain(`data-testid="${testId}"`);
    }
  });

  test("프로젝트 상세 포인터는 실제 최상위 장기기억 탭으로 연결된다", () => {
    expect(panel).toContain('onOpenMemoryTab?: () => void');
    expect(app).toContain("onOpenMemoryTab={() => setActiveTab('memory')}");
    expect(app.match(/onOpenMemoryTab=\{/g)).toHaveLength(1);
  });

  test("복사 프롬프트 문자열은 한 모듈이 정본이고 프로젝트에 매이지 않는다", () => {
    const prompts = readFileSync(join(root, "src", "externalMemorySetupPrompts.ts"), "utf8");
    expect(prompts).toContain("export function buildManualInitPrompt");
    expect(prompts).toContain("export function buildStandaloneInitPrompt");
    // 프로젝트 이름·경로를 받지 않는다 — 받는 쪽이 자기 PROJECT_ROOT 를 구한다.
    expect(prompts).toContain("buildManualInitPrompt(): string");
    expect(prompts).toContain("buildStandaloneInitPrompt(): string");
    expect(panel).not.toContain("const standaloneInitPrompt");
    expect(panel).not.toContain("const manualInitPrompt");
  });
});

// VOC 2026-08-28 22:55 — "위에 있는 기능과 중복같은데 확인하고 제거해".
// 하나는 profile 1개 ↔ Bot 1개, 다른 하나는 Telegram Bot 3개 생성 뒤 단체톡 연결이다.
// 두 번째 버튼은 수량만 나열하지 않고 사용자가 하게 될 동작을 그대로 말한다.
describe("Telegram 연결 버튼 둘은 규모가 다르고, 그 차이가 라벨에 있다", () => {
  const onboardingBar = directory.slice(
    directory.indexOf('data-testid="portal-memory-onboarding-actions"'),
    directory.indexOf('data-testid="portal-memory-external-setup"'),
  );

  test("둘 다 「이 단말 연결 설정」 줄에 나란히 있다", () => {
    expect(onboardingBar.length).toBeGreaterThan(0);
    expect(onboardingBar).toContain("이 단말 연결 설정");
    expect(onboardingBar).toContain('data-testid="portal-memory-copy-telegram-onboarding"');
    expect(onboardingBar).toContain('data-testid="portal-memory-copy-telegram-bot-batch"');
  });

  test("라벨이 대상 수와 실제 작업을 함께 말한다", () => {
    expect(onboardingBar).toContain("Hermes profile 1개 → Telegram Bot 1개 연결");
    expect(onboardingBar).toContain("Telegram Bot 3개 만들기·단체톡 연결");
    expect(onboardingBar).not.toContain("이 단말 Bot 3개 + 단체톡");
  });

  test("3개짜리 절차를 지우지 않았다 — 복사 대상 프롬프트가 그대로 있다", () => {
    expect(directory).toContain("buildTelegramBotOnboardingPrompt()");
  });

  test("환경 단위 설치 상자에는 장기기억 설치 프롬프트만 남는다", () => {
    const externalBox = directory.slice(
      directory.indexOf('data-testid="portal-memory-external-setup"'),
      directory.indexOf('data-testid="hermes-telegram-readiness"'),
    );
    expect(externalBox).not.toContain('data-testid="portal-memory-copy-telegram-bot-batch"');
    expect(externalBox).toContain("장기기억 설치");
    expect(externalBox).toContain("이 단말 연결 설정");
  });
});
