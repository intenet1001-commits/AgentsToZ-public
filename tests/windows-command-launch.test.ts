import { describe, expect, test } from 'bun:test';
import {
  buildWindowsCommandLaunch,
  buildWindowsSupervisedLaunch,
  buildWindowsTerminalLaunch,
} from '../src/windowsCommandLaunch';

describe('Windows command launch planning', () => {
  test('wraps managed launches in the persistent Job Object supervisor', () => {
    const child = buildWindowsCommandLaunch({
      commandPath: 'C:\\Work & Tools\\run%prod%.cmd',
      isFilePath: true,
    });
    const plan = buildWindowsSupervisedLaunch('C:\\Program Files\\AgentsToZ\\windows-process-supervisor.ps1', child);

    expect(plan.cmd[0]).toBe('powershell.exe');
    expect(plan.cmd).toContain('C:\\Program Files\\AgentsToZ\\windows-process-supervisor.ps1');
    expect(plan.env.AGENTSTOZ_SUPERVISOR_PROGRAM).toBe('powershell.exe');
    expect(JSON.parse(plan.env.AGENTSTOZ_SUPERVISOR_ARGS_JSON!)).toEqual(child.cmd.slice(1));
    expect(plan.env.AGENTSTOZ_COMMAND_FILE).toBe('C:\\Work & Tools\\run%prod%.cmd');
  });
  test('runs batch-file paths through an argv-safe PowerShell bridge', () => {
    expect(buildWindowsCommandLaunch({
      commandPath: 'C:\\Work & Tools\\run%prod%.cmd',
      isFilePath: true,
      folderPath: 'C:\\ignored',
    })).toEqual({
      cmd: [
        'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-Command',
        'Start-Process -FilePath $env:AGENTSTOZ_COMMAND_FILE -Wait -NoNewWindow',
      ],
      env: { AGENTSTOZ_COMMAND_FILE: 'C:\\Work & Tools\\run%prod%.cmd' },
    });
  });

  test('runs PowerShell launchers with an argv-safe bypass plan', () => {
    expect(buildWindowsCommandLaunch({
      commandPath: 'C:\\Work & Tools\\run%prod%.ps1',
      isFilePath: true,
    })).toEqual({
      cmd: [
        'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Work & Tools\\run%prod%.ps1',
      ],
      env: {},
    });
  });

  test('uses pushd instead of a UNC process cwd for raw commands', () => {
    expect(buildWindowsCommandLaunch({
      commandPath: 'bun run dev',
      isFilePath: false,
      folderPath: '\\\\server\\share & team\\project',
    })).toEqual({
      cmd: ['cmd.exe', '/D', '/S', '/C', 'pushd "%AGENTSTOZ_WORK_DIR%" && bun run dev'],
      env: { AGENTSTOZ_WORK_DIR: '\\\\server\\share & team\\project' },
    });
  });
});

describe('Windows terminal launch planning', () => {
  test('passes percent-bearing titles and UNC workdirs outside cmd source text', () => {
    expect(buildWindowsTerminalLaunch({
      windowsTerminalPath: 'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
      shellCommand: '"C:\\Program Files\\Claude\\claude.exe"',
      folderPath: '\\\\server\\share%TEMP% & team\\repo',
      title: 'repo%TEMP% & team',
    })).toEqual({
      cmd: [
        'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
        '--title',
        'repo%TEMP% & team',
        '--',
        'cmd.exe',
        '/D',
        '/V:OFF',
        '/K',
        'pushd "%AGENTSTOZ_WORK_DIR%" && %AGENTSTOZ_SHELL_COMMAND%',
      ],
      env: {
        AGENTSTOZ_WORK_DIR: '\\\\server\\share%TEMP% & team\\repo',
        AGENTSTOZ_SHELL_COMMAND: '"C:\\Program Files\\Claude\\claude.exe"',
      },
      detached: true,
    });
  });

  test('fallback opens cmd directly and uses env-backed title, cwd, and command', () => {
    const plan = buildWindowsTerminalLaunch({
      windowsTerminalPath: null,
      shellCommand: '',
      folderPath: 'C:\\src%TEMP%\\repo',
      title: 'repo%TEMP%',
    });
    expect(plan.cmd).toEqual([
      'cmd.exe', '/D', '/V:OFF', '/K',
      'title "%AGENTSTOZ_WINDOW_TITLE%" && pushd "%AGENTSTOZ_WORK_DIR%" && %AGENTSTOZ_SHELL_COMMAND%',
    ]);
    expect(plan.env).toEqual({
      AGENTSTOZ_WINDOW_TITLE: 'repo%TEMP%',
      AGENTSTOZ_WORK_DIR: 'C:\\src%TEMP%\\repo',
      AGENTSTOZ_SHELL_COMMAND: 'rem',
    });
    expect(plan.cmd.join(' ')).not.toContain('repo%TEMP%');
  });
});
