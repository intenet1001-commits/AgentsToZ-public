import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const directorySource = readFileSync(new URL("../src/PortalMemoryDirectory.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("../src/BuzzAgentSetupDialog.tsx", import.meta.url), "utf8");
const projectDialogSource = readFileSync(new URL("../src/BuzzProjectDialog.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");

describe("generic Buzz agent onboarding UI", () => {
  test("lives in device onboarding instead of the project channel dialog", () => {
    expect(directorySource).toContain('data-testid="portal-memory-open-buzz-agent-onboarding"');
    expect(directorySource).toContain("Buzz 범용 Agent 생성·연결");
    expect(directorySource).toContain('data-testid="portal-memory-open-buzz-project-agent"');
    expect(directorySource).toContain("프로젝트 → USE 서비스 Agent 만들기");
    expect(projectDialogSource).not.toContain("CS-CEO 설정 복사");
    expect(projectDialogSource).not.toContain("agentSetup");
    expect(projectDialogSource).not.toContain("Buzz agent의 working directory");
    expect(projectDialogSource).toContain("현재 channel UUID로 이 단말의 연결을 조회");
  });

  test("separates one-time agent creation from repeatable channel assignment", () => {
    expect(dialogSource).toContain("한 번만 생성");
    expect(dialogSource).toContain("프로젝트 채널 연결은 별도");
    expect(dialogSource).toContain('data-testid="buzz-agent-runtime"');
    expect(dialogSource).toContain('data-testid="buzz-agent-project"');
    expect(dialogSource).toContain('data-testid="buzz-service-memory-ensure"');
    expect(dialogSource).toContain('data-testid="buzz-agent-copy-settings"');
    expect(dialogSource).toContain('data-testid="buzz-agent-open-desktop"');
    expect(dialogSource).toContain("Buzz Desktop에서 최종 생성 승인");
    expect(dialogSource).toContain("Agent별 working-directory 입력란이 없으므로");
    expect(dialogSource).not.toContain("BUZZ_PRIVATE_KEY");
  });

  test("creates USE memory lazily and keeps the DEV identity visible", () => {
    expect(dialogSource).toContain("buildServiceBuzzAgentInstructions");
    expect(dialogSource).toContain("DEV 프로젝트 기억");
    expect(dialogSource).toContain("USE 운영기억");
    expect(dialogSource).toContain("원격 동기화는 아직 지원하지 않습니다");
    expect(dialogSource).toContain("같은 서비스 Agent가 이미 있으면 중복 생성하지 마세요.");
    expect(dialogSource).toContain('data-testid="agentstoz-use-control-capabilities"');
    expect(dialogSource).toContain('data-testid="agentstoz-use-install-codex-control"');
    expect(dialogSource).toContain("AgentsToZ 로컬 제어 · 안전한 앱 작업");
    expect(dialogSource).toContain("고정된 9개 MCP 도구");
    expect(dialogSource).toContain("Codex의 전체 접근 권한을 켜지 않고");
  });

  test("uses dedicated credential-free local endpoints", () => {
    expect(apiSource).toContain('/api/buzz-agent-bootstrap/status');
    expect(apiSource).toContain('/api/buzz-agent-bootstrap/open');
    expect(apiSource).toContain('/api/buzz-agent-bootstrap/install-codex-control');
    expect(apiSource).toContain('/api/service-memory/status');
    expect(apiSource).toContain('/api/service-memory/ensure');
    expect(apiSource).toContain("inspectBuzzAgentBootstrap");
    expect(apiSource).toContain('body.scope === "service"');
    expect(apiSource).toContain("resolveRegisteredBuzzProject(body.portId)");
    expect(apiSource).toContain('/api/agentstoz-use/action');
    expect(apiSource).toContain("verifyAgentsToZUseController");
  });
});
