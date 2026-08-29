import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { windowsHermesExecutableCandidates } from '../src/windowsAgentExecutable';
import { buildWindowsCmdAgentCommand } from '../src/orcaFloatingTerminal';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('native Windows agent launch contract', () => {
  test('double-quotes executable paths with spaces for cmd.exe', () => {
    expect(buildWindowsCmdAgentCommand(
      'codex',
      'C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\codex.exe',
      true,
    )).toBe(
      'set "CODEX_HOME=" && "C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\codex.exe" --dangerously-bypass-approvals-and-sandbox',
    );
  });

  test('discovers the executable guaranteed by the official Hermes Windows installer', () => {
    expect(windowsHermesExecutableCandidates({
      localAppData: 'C:\\Users\\Alice Smith\\AppData\\Local',
    })).toEqual([
      'C:\\Users\\Alice Smith\\AppData\\Local\\hermes\\hermes-agent\\bin\\hermes.exe',
      'C:\\Users\\Alice Smith\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe',
    ]);
    expect(windowsHermesExecutableCandidates({
      localAppData: 'C:\\Users\\Alice Smith\\AppData\\Local',
      hermesHome: 'D:\\Hermes Home',
    })[0]).toBe('D:\\Hermes Home\\hermes-agent\\bin\\hermes.exe');
  });

  test('discovers Claude from the official native Windows installer outside GUI PATH', () => {
    expect(apiSource).toContain("join(userProfile, '.local', 'bin', 'claude.exe')");
    expect(rustSource).toContain('Path::new(&user_profile).join(".local/bin/claude.exe")');
  });

  test('routes every native terminal agent through cmd-specific quoting', () => {
    expect(apiSource).toContain("const codexCli = terminalAgentCli('codex', bypass);");
    expect(apiSource).toContain("const agyCli = terminalAgentCli('agy', bypass);");
    expect(apiSource).toContain("const claudeCmd = terminalAgentCli('claude', false);");
    expect(apiSource).toContain("const hermesCmd = terminalAgentCli('hermes', false);");
    expect(apiSource).toContain("const command = `${terminalAgentCli('claude', bypass === true)} agents`;");
    expect(rustSource).toContain('fn windows_cmd_agent_command(executable: &str, arguments: &str) -> String');
    expect(rustSource).toContain('native_terminal_agent_command("codex"');
    expect(rustSource).toContain('native_terminal_agent_command("agy"');
    expect(rustSource).toContain('native_terminal_agent_command("hermes"');
    const agentView = rustSource.slice(
      rustSource.indexOf('fn open_terminal_agent_view('),
      rustSource.indexOf('fn open_cmux_project_agents('),
    );
    expect(agentView).toContain('native_terminal_agent_command("claude"');
    expect(agentView).not.toContain('"claude{} agents"');
  });

  test('checks the Windows terminal handoff instead of returning unconditional verified true', () => {
    expect(apiSource).toContain('async function spawnWindowsTerminalChecked(');
    expect(apiSource).toContain('return await spawnWindowsTerminalChecked(plan.cmd, plan.env, plan.detached);');
    expect(apiSource).not.toContain("spawn({ cmd: wtArgs, stdout: 'inherit', stderr: 'inherit' });");
  });

  test('routes terminal folders, titles, and UNC paths through the safe planner', () => {
    const helper = apiSource.slice(
      apiSource.indexOf('async function openTerminalWithCmd'),
      apiSource.indexOf('if (url.pathname === "/api/open-tmux-claude"'),
    );
    const folderRoute = apiSource.slice(
      apiSource.indexOf('if (url.pathname === "/api/open-terminal-at-folder"'),
      apiSource.indexOf('if (url.pathname === "/api/open-terminal-git-merge"'),
    );
    const wslHelper = apiSource.slice(
      apiSource.indexOf('function spawnWslTmux'),
      apiSource.indexOf('/** 포트를 **LISTEN 중인**'),
    );
    expect(helper).toContain('buildWindowsTerminalLaunch({');
    expect(helper).not.toContain("'/c', 'start'");
    expect(folderRoute).toContain("await openTerminalWithCmd('', expandedPath");
    expect(folderRoute).not.toContain("'/c', 'start'");
    expect(wslHelper).not.toContain("'/c', 'start'");
  });

  test('keeps managed sidecar descendants inside the bundled Job Object supervisor', () => {
    expect(apiSource).toContain('function windowsProcessSupervisorScript()');
    expect((apiSource.match(/buildWindowsSupervisedLaunch\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(apiSource).toContain("src-tauri', 'resources', 'windows-process-supervisor.ps1");
    const nativeSpawn = rustSource.slice(
      rustSource.indexOf('#[cfg(target_os = "windows")]\nfn spawn_process('),
      rustSource.indexOf('#[cfg(not(target_os = "windows"))]\nfn spawn_process('),
    );
    expect(nativeSpawn).toContain('args.supervisor_script.ok_or_else');
    expect(nativeSpawn).toContain('windows_supervisor_plan(');
    expect(rustSource).toContain('app_handle.path().resource_dir()');
  });
});
