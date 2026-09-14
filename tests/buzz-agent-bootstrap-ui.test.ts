import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const directorySource = readFileSync(new URL("../src/PortalMemoryDirectory.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("../src/BuzzAgentSetupDialog.tsx", import.meta.url), "utf8");
const projectDialogSource = readFileSync(new URL("../src/BuzzProjectDialog.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const portalSource = readFileSync(new URL("../src/portal-main.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");

describe("project service Agent onboarding UI", () => {
  test("has one creation entry in the shared memory directory", () => {
    expect(directorySource).toContain('data-testid="portal-memory-service-agent-actions"');
    expect(directorySource).toContain('data-testid="portal-memory-open-buzz-project-agent"');
    expect(directorySource).toContain("프로젝트를 USE 서비스 Agent로 만들기");
    expect(directorySource).not.toContain('data-testid="portal-memory-open-buzz-agent-onboarding"');
    expect(directorySource).not.toContain("Buzz 범용 Agent 생성·연결");
    expect(appSource).toContain("<PortalMemoryDirectory");
    expect(portalSource).toContain("<PortalMemoryDirectory");
    expect(projectDialogSource).not.toContain("CS-CEO 설정 복사");
    expect(projectDialogSource).not.toContain("agentSetup");
    expect(projectDialogSource).not.toContain("Buzz agent의 working directory");
    expect(projectDialogSource).toContain("이 화면은 Buzz 채널을 만들거나 기존 채널과 프로젝트를 연결하는 역할만 합니다");
  });

  test("separates service Agent creation from channel assignment", () => {
    expect(dialogSource).toContain("프로젝트 영역의");
    expect(dialogSource).toContain("Buzz 채널");
    expect(dialogSource).toContain("대화 공간을 열거나 프로젝트와 연결만 합니다");
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
    expect(dialogSource).toContain("고정된 13개 MCP 도구");
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

  test("routes a voice-created Workroom session into the visible terminal", () => {
    expect(appSource).toContain("/api/agentstoz-use/workroom-navigation");
    expect(appSource).toContain("lastUseWorkroomNavigation");
    expect(appSource).toContain("sessionId: navigation.sessionId");
    expect(appSource).toContain("['codex', 'claude', 'hermes', 'agy'].includes(navigation.agent)");
    expect(appSource).toContain("setActiveTab('terminal')");
    expect(appSource).toContain("document.addEventListener('visibilitychange', onVisibilityChange)");
    expect(appSource).not.toContain("setInterval(() => void check(), 2_000)");
  });
});
