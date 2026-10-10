import { describe, expect, test } from "bun:test";
import { resolveAgentLaunchContext } from "../src/worktreeLaunch";

describe("AI worktree launch context", () => {
  test("uses the linked worktree as the authoritative working directory", () => {
    expect(resolveAgentLaunchContext("/repo/main", "/repo/main/.claude/worktrees/task-1"))
      .toEqual({
        repositoryPath: "/repo/main",
        workingPath: "/repo/main/.claude/worktrees/task-1",
        worktreePath: "/repo/main/.claude/worktrees/task-1",
        isLinkedWorktree: true,
      });
  });

  test("does not misclassify the main row as a linked worktree", () => {
    expect(resolveAgentLaunchContext("/repo/main/", "/repo/main"))
      .toEqual({
        repositoryPath: "/repo/main",
        workingPath: "/repo/main",
        worktreePath: undefined,
        isLinkedWorktree: false,
      });
  });

  test("honors a persisted worktree project entry without an explicit row path", () => {
    expect(resolveAgentLaunchContext("/repo/task", undefined, "/repo/task"))
      .toEqual({
        repositoryPath: "/repo/task",
        workingPath: "/repo/task",
        worktreePath: "/repo/task",
        isLinkedWorktree: true,
      });
  });

  test.each([
    ['Codex', '/Users/me/.codex/worktrees/task'],
    ['Orca', '/Users/me/orca/workspaces/repo/task'],
    ['AgentsToZ', '/repo/main/worktrees/task'],
    ['plain Git', '/Users/me/elsewhere/task'],
  ])('uses the exact %s-created Git worktree for every launcher', (_creator, worktreePath) => {
    expect(resolveAgentLaunchContext('/repo/main', worktreePath)).toMatchObject({
      repositoryPath: '/repo/main',
      workingPath: worktreePath,
      worktreePath,
      isLinkedWorktree: true,
    });
  });

  test('desktop cmux and Orca routes cover all four agents through the common worktree context', async () => {
    const [app, rust] = await Promise.all([
      Bun.file(new URL('../src/App.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src-tauri/src/lib.rs', import.meta.url)).text(),
    ]);
    for (const route of ['claude', 'codex', 'agy', 'hermes']) {
      expect(app).toContain(`open_cmux_${route}`);
    }
    expect(app).toContain("agent: 'claude' | 'codex' | 'agy' | 'hermes' | 'agents' | 'terminal'");
    expect(rust).toContain('fn open_cmux_agent(');
    expect(rust).toContain('let cd_path = first_worktree(&worktree_path)');
  });

  test('resolves tmux and agent binaries explicitly, creates a cmux window, and preserves unverified launch warnings', async () => {
    const [app, api, rust] = await Promise.all([
      Bun.file(new URL('../src/App.tsx', import.meta.url)).text(),
      Bun.file(new URL('../api-server.ts', import.meta.url)).text(),
      Bun.file(new URL('../src-tauri/src/lib.rs', import.meta.url)).text(),
    ]);
    expect(api).toContain('function resolveTmuxCli()');
    expect(api).toContain('function ensureCmuxWindowNode(');
    expect(api).toContain('const tmuxCli = resolveTmuxCli();');
    expect(api).toContain('const windowReady = ensureCmuxWindowNode(cliPath);');
    expect(rust).toContain('let tmux_bin = resolve_agent_bin("tmux")');
    expect(rust).toContain('ensure_cmux_window(&cli)?;');
    for (const agent of ['claude', 'codex', 'agy', 'hermes']) {
      expect(rust).toContain(`resolve_agent_bin("${agent}")`);
    }
    expect(app).toContain('const showTerminalLaunchOutcome = (message: string): void =>');
    expect(app).toContain('/확인하지 못|제때 응답하지|unverified/i.test(message)');
    expect(app).toContain('showTerminalLaunchOutcome(message);');
  });
});
