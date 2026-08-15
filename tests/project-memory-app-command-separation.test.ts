import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const panel = readFileSync(join(import.meta.dir, "../src/ProjectMemoryPanel.tsx"), "utf8");

describe("app project-memory save and sync separation", () => {
  test("keeps conversation curation separate from cloud synchronization", () => {
    expect(panel).toContain('data-testid="project-memory-remember-actions"');
    expect(panel).toContain('data-testid="project-memory-sync-actions"');
    expect(panel).toContain('data-testid="project-memory-session-end"');
    expect(panel).toContain('data-testid="project-memory-safe-sync"');
    expect(panel).toContain("'/api/project-memory/sync'");
    expect(panel).toContain('대화·세션 기억 저장');
    expect(panel).toContain('클라우드 동기화');
  });

  test("the remember button never changes into push or pull", () => {
    expect(panel).toContain('onClick={() => void sessionEnd()}');
    expect(panel).not.toContain("if (effectiveSessionAction === 'remember') void sessionEnd();");
    expect(panel).not.toContain("else if (effectiveSessionAction === 'push') void push();");
    expect(panel).not.toContain("else if (effectiveSessionAction === 'pull') void pull();");
  });

  test("keeps the local-terminal row to the agents that read project-folder skills", () => {
    expect(panel).toContain('data-testid="project-memory-local-terminal-commands"');
    expect(panel).toContain('로컬 터미널 AI');
    expect(panel).toContain('data-testid="copy-claude-remember-session"');
    expect(panel).toContain('data-testid="copy-codex-remember-session"');
    // Hermes never reads the project folder, so it is not a local-terminal peer
    // of Claude/Codex — it is a device-wide surface with its own box.
    expect(panel).not.toContain('data-testid="copy-local-hermes-remember-session"');
    expect(panel).not.toContain('<code>로컬 터미널 Hermes /remember_session</code>');
  });

  test("splits Hermes commands by argument, not by host", () => {
    expect(panel).toContain('data-testid="project-memory-hermes-commands"');
    // Every skill body calls 127.0.0.1:3001, so an "AWS command" does not exist.
    expect(panel).not.toContain('AWS·Telegram Hermes');
    expect(panel).not.toContain('data-testid="project-memory-aws-telegram-commands"');
    expect(panel).toContain('그 대화를 받는 gateway가 도는 호스트');

    expect(panel).toContain('data-testid="project-memory-hermes-topic-commands"');
    expect(panel).toContain('data-testid="project-memory-hermes-path-commands"');
    expect(panel).toContain('const hermesRememberSessionPathCommand');
    expect(panel).toContain('`/remember_session ${folderPath.trim()}`');
    expect(panel).toContain('`/memory_link ${status.config.memoryId}`');
    expect(panel).toContain('data-testid="project-memory-hermes-path-commands"');
    // The topic list is data-driven, so the ids live in the table, not in JSX.
    for (const id of [
      "copy-hermes-memory-link",
      "copy-hermes-remember-session",
      "copy-hermes-memory-sync",
      "copy-hermes-memory-status",
      "copy-hermes-memory-unlink",
    ]) {
      expect(panel).toContain(`testId: '${id}'`);
    }
    expect(panel).toContain("'/remember_session'");
    expect(panel).toContain("'/memory_sync'");
    expect(panel).toContain("'/memory_status'");
    expect(panel).toContain("'/memory_unlink'");
    expect(panel).toContain('“모두/General”에서는 실행하지 마세요');
    expect(panel).not.toContain('기존 /memory_start · /remember');
  });

  // The panel used to show five of the eight skills the installer writes; the rest
  // lived in a footnote or nowhere. Telegram listed all of them, so the app looked
  // out of date next to the thing it installs. Adding a template must add a row.
  test("offers every Hermes skill the installer writes, with a one-line purpose", () => {
    const templates = readdirSync(join(import.meta.dir, "../templates/hermes"), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    expect(templates.length).toBeGreaterThan(0);
    for (const skill of templates) {
      expect(panel).toContain(`skill: '${skill}'`);
    }
    for (const command of ["/memory_start", "/memory_stop", "/hermes_open"]) {
      expect(panel).toContain(command);
    }
    // Each row must carry a description; a bare command list is what we replaced.
    const rows = panel.match(/skill: '[a-z-]+',/g) ?? [];
    const descriptions = panel.match(/\n\s+desc: '/g) ?? [];
    expect(descriptions.length).toBe(rows.length);
  });

  // Ordering is by execution sequence, not by frequency. Every one of these commands
  // needs the topic bound first, so a frequency order put the command that fails first
  // (/remember_session in a fresh topic) at the top of the list.
  test("lists the binding commands before the ones that need a binding", () => {
    const order = (skill: string) => panel.indexOf(`skill: '${skill}'`);
    for (const skill of ["remember-session", "memory-sync", "memory-status", "hermes-open", "memory-unlink", "memory-stop"]) {
      expect(order("memory-start")).toBeLessThan(order(skill));
      expect(order("memory-link")).toBeLessThan(order(skill));
    }
    expect(order("memory-start")).toBeLessThan(order("memory-link"));
    expect(panel).toContain("step: '연결'");
    expect(panel).toContain('이게 되어 있어야 나머지가 동작합니다');
  });

  // Two buttons copied the identical `/remember_session <path>` string — one in the
  // always-visible local-terminal row, one inside the collapsed Hermes box. Same
  // payload, same label, one panel. The argument form keeps a single copy button.
  test("offers the path form from exactly one button", () => {
    const copies = panel.match(/copyChatCommand\('[^']+', hermesRememberSessionPathCommand/g) ?? [];
    expect(copies.length).toBe(1);
    expect(panel).toContain("copyChatCommand('hermes-local', hermesRememberSessionPathCommand");
    // The meaning stays where the Telegram commands are, without a second button.
    expect(panel).toContain('복사 버튼은 위 ');
    expect(panel).not.toContain('data-testid="copy-hermes-remember-session-path"');
  });

  // /memory_stop does exactly what /memory_unlink does. It stays in the table so the
  // list still matches what Hermes loads, but it is a note on unlink, not a button.
  test("folds the alias into its target instead of giving it a button", () => {
    expect(panel).toContain("aliasOf: 'memory-unlink'");
    expect(panel).toContain('const hermesCommandRows = hermesTopicCommands.filter(item => !item.aliasOf)');
    expect(panel).toContain('project-memory-hermes-alias-');
    expect(panel).not.toContain('data-testid="copy-hermes-memory-stop"');
  });

  test("states the install target and keeps guidance when Hermes is absent", () => {
    expect(panel).toContain('data-testid="project-memory-hermes-install-row"');
    expect(panel).toContain('data-testid="project-memory-hermes-absent"');
    expect(panel).toContain('data-testid="project-memory-hermes-installed"');
    expect(panel).toContain('이 PC에 한 번');
    // The old label counted installed skills, which read as "already done" while
    // the only pending work was deleting a legacy alias.
    expect(panel).not.toContain('Hermes에 명령 설치 (${hermesAdapter.installed.length}');
    expect(panel).toContain('`이 PC의 Hermes에 ${hermesInstallPending}`');
  });

  test("keeps setup and migration prompts out of routine chat commands", () => {
    expect(panel).toContain('data-testid="project-memory-setup-prompts"');
    expect(panel).toContain('다른 환경에 설치·연결');
    expect(panel).toContain('클립보드에 복사하지 못했습니다');
    expect(panel).not.toContain('채팅 명령 복사 실패');
  });
});
