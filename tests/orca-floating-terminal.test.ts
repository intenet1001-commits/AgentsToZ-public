import { describe, expect, test } from 'bun:test';
import {
  buildOrcaManagedFloatingTerminalTitle,
  buildOrcaFloatingCommand,
  buildWindowsOrcaAgentCommand,
  buildWindowsCmdAgentCommand,
  buildWindowsCmdOrcaCommand,
  isOrcaManagedFloatingTerminal,
  orcaManagedFloatingTerminalMarker,
  ORCA_FLOATING_WORKTREE_SELECTOR,
  shouldUseOrcaFloatingTerminal,
} from '../src/orcaFloatingTerminal';

describe('Orca Floating Terminal helpers', () => {
  test('builds one safely quoted cd-and-launch command', () => {
    expect(buildOrcaFloatingCommand("/tmp/a'b", '/opt/bin/claude --flag'))
      .toBe("cd '/tmp/a'\\''b' && /opt/bin/claude --flag");
  });

  test('uses Orca\'s dedicated Floating Workspace selector', () => {
    expect(ORCA_FLOATING_WORKTREE_SELECTOR).toBe('id:global-floating-terminal');
  });

  test('marks a Floating tab by exact agent and project without exposing the path', () => {
    const title = buildOrcaManagedFloatingTerminalTitle(
      'my-project',
      'Claude',
      'claude',
      '/workspace/my-project/',
    );
    expect(title).toContain('[ATZ:claude:');
    expect(title).not.toContain('/workspace/my-project');
    expect(orcaManagedFloatingTerminalMarker('claude', '/workspace/my-project'))
      .toBe(orcaManagedFloatingTerminalMarker('claude', '/workspace/my-project/'));
    expect(isOrcaManagedFloatingTerminal(title, 'claude', '/workspace/my-project')).toBe(true);
    expect(isOrcaManagedFloatingTerminal(title, 'codex', '/workspace/my-project')).toBe(false);
    expect(isOrcaManagedFloatingTerminal(title, 'claude', '/workspace/another-project')).toBe(false);
  });

  test('applies the surface choice only to project/worktree launches', () => {
    expect(shouldUseOrcaFloatingTerminal('/repo/worktrees/task', 'floating')).toBe(true);
    expect(shouldUseOrcaFloatingTerminal('/repo/worktrees/task', 'worktree')).toBe(false);
    expect(shouldUseOrcaFloatingTerminal(undefined, 'worktree')).toBe(true);
  });

  test('launches every Windows agent through an explicit WSL-interoperable executable', () => {
    expect(buildWindowsOrcaAgentCommand('claude', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe', true))
      .toBe("'/mnt/c/Users/me/AppData/Roaming/npm/claude.exe' --dangerously-skip-permissions");
    expect(buildWindowsOrcaAgentCommand('codex', 'D:\\tools\\codex.exe', false))
      .toBe("env -u CODEX_HOME '/mnt/d/tools/codex.exe'");
    expect(buildWindowsOrcaAgentCommand('agy', 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe', true))
      .toBe("'/mnt/c/Users/me/AppData/Local/agy/bin/agy.exe' --dangerously-skip-permissions");
  });

  test('uses native cmd syntax for Windows worktree-owned terminals', () => {
    expect(buildWindowsCmdAgentCommand('claude', 'C:\\Users\\me\\claude.exe', false))
      .toBe('"C:\\Users\\me\\claude.exe"');
    expect(buildWindowsCmdAgentCommand('codex', 'C:\\Tools\\codex.exe', true))
      .toBe('set "CODEX_HOME=" && "C:\\Tools\\codex.exe" --dangerously-bypass-approvals-and-sandbox');
    expect(buildWindowsCmdOrcaCommand('C:\\repo\\worktrees\\task', '"C:\\Tools\\agy.exe"'))
      .toBe('cd /d "C:\\repo\\worktrees\\task" && "C:\\Tools\\agy.exe"');
  });
});
