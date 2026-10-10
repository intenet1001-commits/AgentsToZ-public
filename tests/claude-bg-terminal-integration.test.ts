import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('Claude --bg terminal integration', () => {
  test('starts the background agent before opening the chosen Agent View', () => {
    const backgroundStart = appSource.indexOf("callCmux('open_claude_bg', '/api/open-claude-bg'");
    const agentViewOpen = appSource.indexOf('const agentViewMessage = await openClaudeBgAgentView(item, context, newWindow)');
    expect(backgroundStart).toBeGreaterThan(-1);
    expect(agentViewOpen).toBeGreaterThan(backgroundStart);
    expect(appSource).toContain('claude agents를 열지 못했습니다');
  });

  test('uses project context for iTerm and Terminal Agent View launches', () => {
    expect(apiSource).toContain("const { terminalApp = 'iterm', bypass = false, folderPath, name = '' }");
    expect(apiSource).toContain('await openTerminalWithCmd(command, targetPath, title, selectedTerminal)');
    expect(tauriSource).toContain('folder_path: Option<String>');
    expect(tauriSource).toContain("cd '{}' && printf");
  });

  test('preserves permission mode when cmux opens its project Agent View', () => {
    expect(tauriSource).toContain('fn open_cmux_project_agents(');
    expect(tauriSource).toContain('bypass: Option<bool>');
    expect(tauriSource).toContain('"{}{} agents",');
  });
});
