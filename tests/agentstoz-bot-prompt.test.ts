import { describe, expect, test } from "bun:test";
import { buildAgentsToZBotCreationPrompt } from "../src/agentstozBotPrompt";

describe("AgentsToZ bot creation prompt", () => {
  test("is device-scoped and contains no credentials", () => {
    const prompt = buildAgentsToZBotCreationPrompt({
      deviceId: "device-1234567890",
      deviceName: "CS Mac",
      platform: "macOS",
      apiBaseUrl: "http://127.0.0.1:3002",
      uiBaseUrl: "http://127.0.0.1:9000",
      agentstozProfile: "agentstoz-bot",
      workerProfile: "cs-ceo",
    });
    expect(prompt).toContain("device-1234567890");
    expect(prompt).toContain("CS Mac");
    expect(prompt).toContain("agentstoz-bot");
    expect(prompt).toContain("cs-ceo");
    expect(prompt).toContain("http://127.0.0.1:3002");
    expect(prompt).toContain("exact");
    expect(prompt).toContain("csncompany2-0");
    expect(prompt).toContain("https://github.com/intenet1001-commits/CSnCompany_2-0");
    expect(prompt).toContain("PROJECT_BOOTSTRAP_CONFLICT");
    expect(prompt).toContain("workspace root가 정확히 하나");
    expect(prompt).toContain("remote memory backup 상태");
    expect(prompt).toContain("local-only project");
    expect(prompt).toContain("로컬 파일 작업과 로컬 테스트를 차단하지 않음");
    expect(prompt).toContain("push·pull·원격 저장소 비교·다른 단말 인수인계");
    expect(prompt).toContain("control-plane root를 대상으로 한 자기 수정");
    expect(prompt).not.toMatch(/api[_-]?key|password|secret|token\s*[:=]/i);
  });

  test("fails closed when device identity is missing", () => {
    expect(() => buildAgentsToZBotCreationPrompt({ deviceId: "" })).toThrow("deviceId");
  });

  test("advanced settings exposes the device-scoped copy action", async () => {
    const source = await Bun.file(new URL("../src/PortalManager.tsx", import.meta.url)).text();
    expect(source).toContain("agentstoz-bot 생성 프롬프트 복사");
    expect(source).toContain("buildAgentsToZBotCreationPrompt");
    expect(source).toContain("data.deviceId");
  });
});
