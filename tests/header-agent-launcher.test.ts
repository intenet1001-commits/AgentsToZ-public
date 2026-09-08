import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('header AI launcher', () => {
  test('keeps the terminal target separate and exposes every quick AI action', () => {
    expect(appSource).toContain('data-testid="header-terminal-root"');
    expect(appSource).toContain('data-testid="header-agent-launcher"');
    expect(appSource).toContain('data-testid="header-agents-launch"');
    expect(appSource).toContain('data-testid="header-claude-launch"');
    expect(appSource).toContain('data-testid="header-codex-launch"');
    expect(appSource).toContain('data-testid="header-agy-launch"');
    expect(appSource).toContain('data-testid="header-hermes-launch"');
  });

  test('launches each global agent from its intentional home context', () => {
    expect(appSource).toContain("name: '.claude', port: 0, folderPath: '~/.claude'");
    expect(appSource).toContain("name: '.codex', port: 0, folderPath: '~/.codex'");
    expect(appSource).toContain("name: 'agy', port: 0, folderPath: '~'");
    expect(appSource).toContain("name: '.hermes', port: 0, folderPath: '~/.hermes'");
  });

  test('offers an Orca-only worktree surface selector', () => {
    expect(appSource).toContain('data-testid="orca-worktree-launch-mode"');
    expect(appSource).toContain('data-testid={`orca-launch-mode-${mode}`}');
    expect(appSource).toContain("localStorage.setItem('portmanager-orcaLaunchMode', mode)");
    expect(appSource).toContain('const orcaSurfacePath = worktreePath ?? item.worktreePath ?? item.folderPath');
    expect(appSource).toContain('const floating = shouldUseOrcaFloatingTerminal(orcaSurfacePath, orcaLaunchMode)');
    expect(appSource).toContain("if (terminalApp === 'orca')");
    expect(appSource).toContain("return openOrcaAgent('claude', item, context.worktreePath, isNew)");
    expect(appSource).toContain("const nextBgMode = mode === 'floating'");
    expect(appSource).toContain('setBgMode(nextBgMode)');
    expect(appSource).toContain('isClaudeBgAvailable(terminalApp, orcaLaunchMode)');
  });

  test('keeps Claude --bg visible on supported surfaces and routes it before regular Orca launch', () => {
    expect(appSource).toContain('data-testid="claude-bg-toggle"');
    expect(appSource).toContain('aria-label="Claude --bg 전환"');
    expect(appSource).toContain('data-testid="terminal-agent-panel-bg-state"');
    expect(appSource).toContain("if (claudeBgActive) {\n      return openClaudeBg(item, context.worktreePath, isNew);\n    }\n    if (terminalApp === 'orca')");
  });

  test('opens the selected terminal surface Agent View after starting Claude --bg', () => {
    expect(appSource).toContain("return callCmux('open_cmux_project_agents', '/api/open-cmux-project-agents'");
    expect(appSource).toContain("return callOrca('agents', item, context.worktreePath, newWindow)");
    expect(appSource).toContain('API.openTerminalAgentView(terminalApp, bypassPermissions, context.workingPath, name)');
    expect(appSource).toContain("const baseUrl = isTauri() ? 'http://localhost:3001' : ''");
  });
});
