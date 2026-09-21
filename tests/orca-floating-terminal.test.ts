import { describe, expect, test } from 'bun:test';
import {
  buildOrcaManagedFloatingTerminalTitle,
  buildOrcaFloatingCommand,
  buildWindowsOrcaAgentCommand,
  buildWindowsCmdAgentCommand,
  buildWindowsCmdOrcaCommand,
  isOrcaManagedFloatingTerminal,
  isLiveOrcaFloatingTerminalRecord,
  orcaManagedFloatingTerminalMarker,
  ORCA_FLOATING_WORKTREE_SELECTOR,
  shouldUseOrcaFloatingTerminal,
  withOrcaAgentTerminalEnvironment,
} from '../src/orcaFloatingTerminal';

describe('Orca Floating Terminal helpers', () => {
  test('builds one safely quoted cd-and-launch command', () => {
    expect(buildOrcaFloatingCommand("/tmp/a'b", '/opt/bin/claude --flag'))
      .toBe("cd '/tmp/a'\\''b' && /opt/bin/claude --flag");
  });

  test('uses Orca\'s dedicated Floating Workspace selector', () => {
    expect(ORCA_FLOATING_WORKTREE_SELECTOR).toBe('id:global-floating-terminal');
  });

  test('disables only Hermes OSC 11 theme probing on Orca terminals', () => {
    expect(withOrcaAgentTerminalEnvironment('hermes', '/opt/bin/hermes'))
      .toBe('env HERMES_TUI_THEME=dark /opt/bin/hermes');
    expect(withOrcaAgentTerminalEnvironment('hermes', '"C:\\Tools\\hermes.exe"', true))
      .toBe('set "HERMES_TUI_THEME=dark" && "C:\\Tools\\hermes.exe"');
    expect(withOrcaAgentTerminalEnvironment('claude', '/opt/bin/claude'))
      .toBe('/opt/bin/claude');
  });

  test('moves Hermes to a new ownership marker after the OSC 11 launch fix', () => {
    const marker = orcaManagedFloatingTerminalMarker('hermes', '/workspace/my-project');
    const legacyPayload = new TextEncoder().encode('hermes\0/workspace/my-project');
    let legacyHash = 0x811c9dc5;
    for (const byte of legacyPayload) {
      legacyHash ^= byte;
      legacyHash = Math.imul(legacyHash, 0x01000193) >>> 0;
    }
    expect(marker).not.toBe(`[ATZ:hermes:${legacyHash.toString(16).padStart(8, '0')}]`);
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

  test('rejects exited or orphaned Floating terminal history records', () => {
    const live = { handle: 'term-live', worktreeId: 'global-floating-terminal', connected: true, orphaned: false };
    expect(isLiveOrcaFloatingTerminalRecord(live)).toBe(true);
    expect(isLiveOrcaFloatingTerminalRecord({ ...live, connected: false })).toBe(false);
    expect(isLiveOrcaFloatingTerminalRecord({ ...live, orphaned: true })).toBe(false);
    expect(isLiveOrcaFloatingTerminalRecord({ ...live, connected: undefined })).toBe(true);
    expect(isLiveOrcaFloatingTerminalRecord({ ...live, worktreeId: 'project-worktree' })).toBe(false);
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
