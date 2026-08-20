export interface WindowsCommandLaunchInput {
  commandPath: string;
  isFilePath: boolean;
  folderPath?: string | null;
}

export interface WindowsCommandLaunch {
  cmd: string[];
  env: Record<string, string>;
}

export interface WindowsTerminalLaunchInput {
  windowsTerminalPath?: string | null;
  shellCommand: string;
  folderPath?: string | null;
  title: string;
}

export interface WindowsTerminalLaunch extends WindowsCommandLaunch {
  detached: boolean;
}

export function buildWindowsSupervisedLaunch(
  supervisorScriptPath: string,
  child: WindowsCommandLaunch,
): WindowsCommandLaunch {
  if (!supervisorScriptPath.trim()) throw new Error('Windows process supervisor script is required.');
  if (child.cmd.length === 0 || !child.cmd[0]) throw new Error('Windows supervised child command is required.');
  return {
    cmd: [
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      supervisorScriptPath,
    ],
    env: {
      ...child.env,
      AGENTSTOZ_SUPERVISOR_PROGRAM: child.cmd[0],
      AGENTSTOZ_SUPERVISOR_ARGS_JSON: JSON.stringify(child.cmd.slice(1)),
      AGENTSTOZ_SUPERVISOR_CWD: '',
    },
  };
}

/** Build a Windows launch without interpolating file/cwd paths into shell source.
 * Batch files use PowerShell's invocation operator because cmd.exe has a separate
 * `/C` quote parser that cannot safely survive our Job supervisor's argv encoding. */
export function buildWindowsCommandLaunch(
  input: WindowsCommandLaunchInput,
): WindowsCommandLaunch {
  if (input.isFilePath) {
    if (/\.ps1$/i.test(input.commandPath)) {
      return {
        cmd: [
          'powershell.exe',
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          input.commandPath,
        ],
        env: {},
      };
    }
    return {
      cmd: [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Start-Process -FilePath $env:AGENTSTOZ_COMMAND_FILE -Wait -NoNewWindow',
      ],
      env: { AGENTSTOZ_COMMAND_FILE: input.commandPath },
    };
  }

  const folderPath = input.folderPath?.trim();
  if (folderPath) {
    return {
      cmd: [
        'cmd.exe',
        '/D',
        '/S',
        '/C',
        `pushd "%AGENTSTOZ_WORK_DIR%" && ${input.commandPath}`,
      ],
      env: { AGENTSTOZ_WORK_DIR: folderPath },
    };
  }

  return {
    cmd: ['cmd.exe', '/D', '/S', '/C', input.commandPath],
    env: {},
  };
}

/** Plan a visible Windows terminal without routing user-controlled values
 * through an outer `cmd /c start` parse. The only cmd source text is static;
 * cwd/command values arrive through one environment-expansion pass. */
export function buildWindowsTerminalLaunch(
  input: WindowsTerminalLaunchInput,
): WindowsTerminalLaunch {
  const folderPath = input.folderPath?.trim() ? input.folderPath : null;
  const shellCommand = input.shellCommand || 'rem';
  const innerCommand = folderPath
    ? 'pushd "%AGENTSTOZ_WORK_DIR%" && %AGENTSTOZ_SHELL_COMMAND%'
    : '%AGENTSTOZ_SHELL_COMMAND%';
  const env: Record<string, string> = {
    ...(folderPath ? { AGENTSTOZ_WORK_DIR: folderPath } : {}),
    AGENTSTOZ_SHELL_COMMAND: shellCommand,
  };
  const windowsTerminalPath = input.windowsTerminalPath?.trim();
  if (windowsTerminalPath) {
    return {
      cmd: [
        windowsTerminalPath,
        '--title',
        input.title,
        '--',
        'cmd.exe',
        '/D',
        '/V:OFF',
        '/K',
        innerCommand,
      ],
      env,
      detached: true,
    };
  }

  const safeTitle = input.title.replace(/["\r\n]/g, ' ');
  return {
    cmd: [
      'cmd.exe',
      '/D',
      '/V:OFF',
      '/K',
      `title "%AGENTSTOZ_WINDOW_TITLE%" && ${innerCommand}`,
    ],
    env: { AGENTSTOZ_WINDOW_TITLE: safeTitle, ...env },
    detached: true,
  };
}
