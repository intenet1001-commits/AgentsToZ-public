import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('Hermes desktop project launch', () => {
  test('is shown beside the Claude and Codex desktop app actions', () => {
    expect(appSource).toContain('data-testid="detail-hermes-app"');
    expect(appSource).toContain('data-testid="worktree-hermes-app"');
    expect(appSource).toContain("openProjectCodeApp('hermes', sel)");
    expect(appSource).toContain('Hermes 앱에서 열기');
  });

  test('passes the selected project path to Hermes Desktop', () => {
    expect(apiSource).toContain("agent !== 'hermes'");
    expect(apiSource).toContain("[resolveAgentBin('hermes'), 'desktop', '--cwd', folderPath]");
    expect(rustSource).toContain('agent != "hermes"');
    expect(rustSource).toContain('local_api_post_json(');
    expect(rustSource).toContain('"/api/open-code-app"');
  });

  test('falls back to Terminal when iTerm is not installed', () => {
    expect(apiSource).toContain("const effectiveTerminalApp: 'iterm' | 'terminal' = terminalApp === 'iterm' && !existsSync('/Applications/iTerm.app')");
    expect(apiSource).toContain("? 'terminal'\n          : terminalApp === 'terminal' ? 'terminal' : 'iterm';");
  });

  test('routes Hermes CLI through the selected Orca surface', () => {
    expect(appSource).toContain("agent: 'claude' | 'codex' | 'agy' | 'hermes' | 'agents' | 'terminal'");
    expect(appSource).toContain("if (terminalApp === 'orca')");
    expect(appSource).toContain("const msg = await callOrca('hermes', item, context.worktreePath, isNew);");
    expect(apiSource).toContain("hermes: { agentName: 'hermes', label: 'Hermes' }");
    expect(rustSource).toContain('"hermes" => (agent_cmd("hermes", ""), "Hermes", "hermes")');
  });

  test('routes Hermes CLI through the selected cmux surface in browser and Tauri', () => {
    expect(appSource).toContain("'open_cmux_hermes'");
    expect(appSource).toContain("'/api/open-cmux-hermes'");
    expect(appSource).toContain("callCmux('open_cmux_hermes', '/api/open-cmux-hermes'");
    expect(apiSource).toContain('url.pathname === "/api/open-cmux-hermes"');
    expect(apiSource).toContain("agentCli('hermes', false)");
    expect(rustSource).toContain('fn open_cmux_hermes(');
    expect(rustSource).toContain('cmux_agent_command(&resolve_agent_bin("hermes"), "")');
    expect(rustSource).toContain('&resolve_agent_bin("codex")');
    expect(rustSource).toContain('&resolve_agent_bin("agy")');
    expect(rustSource).toContain('open_cmux_hermes,');
  });

  test('offers a distinct Hermes Desktop action on project cards', () => {
    expect(appSource).toContain('data-testid="project-hermes-app"');
    expect(appSource).toContain("openProjectCodeApp('hermes', item)");
    expect(appSource).toContain('Hermes 앱');
  });

  test('verifies a real Hermes process and seeds its visible project selection before reporting success', () => {
    expect(apiSource).toContain('verifyHermesDesktopRunning');
    expect(apiSource).toContain("join(projectUserData, 'project-dir.json')");
    expect(apiSource).toContain("JSON.stringify({ dir: folderPath }, null, 2)");
    expect(apiSource).toContain('HERMES_DESKTOP_READY_FILE: readyFile');
    expect(apiSource).toContain("receipt.schemaVersion === 1");
    expect(apiSource).toContain("realpathSync(receipt.cwd) === realpathSync(expectedCwd)");
    expect(apiSource).toContain('Hermes Desktop 프로세스를 확인하지 못했습니다.');
  });
});