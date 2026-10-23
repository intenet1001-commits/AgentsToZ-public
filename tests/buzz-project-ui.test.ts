import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("../src/BuzzProjectDialog.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");

describe("Buzz local project UI", () => {
  test("offers Buzz beside the existing project desktop app actions", () => {
    expect(appSource).toContain('data-testid="project-buzz-app"');
    expect(appSource).toContain('data-testid="detail-buzz-app"');
    expect(appSource).toContain("setBuzzProjectTarget");
  });

  test("supports create, existing-channel link, open and unlink with honest local status", () => {
    expect(dialogSource).toContain('data-testid="buzz-create-channel"');
    expect(dialogSource).toContain('data-testid="buzz-link-channel"');
    expect(dialogSource).toContain('data-testid="buzz-open-app"');
    expect(dialogSource).toContain('data-testid="buzz-unlink-channel"');
    expect(dialogSource).toContain("로컬 앱 연동");
    expect(dialogSource).toContain("hosted community");
    expect(dialogSource).toContain("기본값 저장");
    expect(dialogSource).toContain('aria-invalid={channelId.length > 0 && !channelIdValid}');
    expect(dialogSource).toContain('role="alert"');
    expect(dialogSource).toContain("allowUnverified");
    expect(dialogSource).toContain("다시 눌러 연결 해제");
    expect(dialogSource).toContain("정확한 채널 화면으로 이동하는 공식 링크는 아직 없어");
    expect(dialogSource).toContain("https://github.com/block/buzz/releases");
    expect(dialogSource).not.toContain("BUZZ_PRIVATE_KEY");
  });

  test("keeps the project area channel-only and sends Agent creation to memory", () => {
    expect(dialogSource).not.toContain('data-testid="buzz-purpose-dev"');
    expect(dialogSource).not.toContain('data-testid="buzz-purpose-use"');
    expect(dialogSource).not.toContain('data-testid="buzz-open-use-setup"');
    expect(dialogSource).not.toContain("onOpenUseSetup");
    expect(dialogSource).toContain("서비스 Agent 생성은 장기기억 탭에서 별도로 진행합니다");
    expect(appSource).not.toContain("buzzUseSetupTarget");
    expect(appSource).not.toContain("setBuzzUseSetupTarget");
    expect(appSource).toContain("이 프로젝트의 Buzz 채널을 만들거나 기존 채널과 연결");
  });

  test("routes all mutations through registered-project local endpoints", () => {
    for (const path of ["status", "settings", "create", "link", "open", "unlink"]) {
      expect(apiSource).toContain(`/api/buzz-project/${path}`);
    }
    expect(apiSource).toContain("resolveRegisteredBuzzProject");
    expect(apiSource).toContain("PROJECT_MEMORY_THREAD_BINDINGS_FILE");
  });
});
