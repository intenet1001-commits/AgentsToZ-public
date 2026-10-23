import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexInstallEffects } from './onboardingCodexInstallHost';
import { diagnoseCodexLogin } from './onboardingCodexDiagnosis';
import {
  AUTHENTICODE_PROBE_PATH_ENV,
  WINDOWS_ONBOARDING_RECIPES,
  WINGET_EXIT_NO_PACKAGE,
  authenticodeProbeArgs,
  isTrustedWindowsPublisher,
  parseAuthenticodeReading,
  windowsOnboardingExecutableCandidates,
  wingetExitDetail,
  wingetInstallArgs,
  wingetShowArgs,
} from './onboardingWindowsInstall';

const RECIPE = WINDOWS_ONBOARDING_RECIPES.codex;

/**
 * Windows side of the one-click Codex CLI install. Mirrors
 * `onboardingGithubWindowsEffects.ts`; see `onboardingWindowsInstall.ts` for why
 * the trust anchor is winget plus Authenticode rather than a pinned SHA-256.
 *
 * The macOS installer extracts a reviewed tarball into
 * `~/.local/share/agentstoz/tools/<recipe>` and links it into `~/.local/bin`.
 * Nothing like that happens here: winget owns the install location, and this app
 * writes no executable of its own on Windows.
 */

function systemRoot(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? '';
  return /^[A-Za-z]:\\/.test(root) ? root : 'C:\\Windows';
}

function powershellExecutable(): string {
  return join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function cleanEnvironment(): Record<string, string> {
  const root = systemRoot();
  const environment: Record<string, string> = {
    SystemRoot: root,
    windir: root,
    PATH: `${root}\\System32;${root};${root}\\System32\\Wbem;${root}\\System32\\WindowsPowerShell\\v1.0`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    COMSPEC: join(root, 'System32', 'cmd.exe'),
    NO_COLOR: '1',
    WINGET_DISABLE_INTERACTIVITY: '1',
  };
  for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[name];
    if (typeof value === 'string' && value) environment[name] = value;
  }
  return environment;
}

interface CommandResult { exitCode: number | null; stdout: string; output: string; timedOut: boolean }

function command(
  executable: string,
  args: readonly string[],
  timeout = 8_000,
  signal?: AbortSignal,
  extraEnvironment?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  return new Promise(resolve => execFile(
    executable,
    [...args],
    {
      cwd: systemRoot(),
      env: { ...cleanEnvironment(), ...extraEnvironment },
      timeout, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true, signal,
    },
    (error: any, stdout: string, stderr: string) => resolve({
      exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
      stdout,
      output: `${stdout}\n${stderr}`,
      timedOut: !!error?.killed,
    }),
  ));
}

/** See `onboardingGithubWindowsEffects.ts`: the path travels in the environment, never in argv. */
async function authenticode(path: string): Promise<boolean> {
  const result = await command(
    powershellExecutable(),
    authenticodeProbeArgs(),
    20_000,
    undefined,
    { [AUTHENTICODE_PROBE_PATH_ENV]: path },
  );
  if (result.timedOut) return false;
  return isTrustedWindowsPublisher(parseAuthenticodeReading(result.stdout), RECIPE.publisherCommonName);
}

function windowsCodexExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  for (const candidate of windowsOnboardingExecutableCandidates('codex', environment)) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    const info = lstatSync(canonical);
    // The official payload is large (measured on macOS: 222MB for bin/codex), so
    // the ceiling is generous; it only rejects something that is not an executable.
    if (!info.isFile() || info.size > 600 * 1024 * 1024) throw new Error('existing installation');
    return canonical;
  }
  return null;
}

export function createWindowsCodexInstallEffects(appData: string): CodexInstallEffects {
  void appData;
  // An explicitly configured installation or profile is never silently switched.
  const customContext = !!(
    process.env.CODEX_HOME || process.env.CODEX_INSTALL_DIR || process.env.PORTMGR_CODEX_PATH
  );

  async function wingetAvailable(): Promise<boolean> {
    return (await command('winget.exe', ['--version'], 10_000)).exitCode === 0;
  }

  return {
    // The panel shows the winget text, so the receipt must name that recipe.
    recipeId: RECIPE.id,
    supported: process.platform === 'win32',
    probe: async () => {
      if (customContext) return 'unknown';
      try {
        const executable = windowsCodexExecutable();
        if (!executable) return 'missing';
        // A `.cmd` npm shim carries no Authenticode signature of its own, so the
        // publisher check applies only to a real executable. The shim path stays
        // reportable (the user installed it) but is never called "verified".
        if (/\.exe$/i.test(executable) && !await authenticode(executable)) return 'unknown';
        const version = await command(executable, ['--version']);
        if (version.exitCode !== 0 || !/^codex-cli \d+\.\d+\.\d+(?:\S*)\s*$/.test(version.output.trim())) return 'unknown';
        const status = await command(executable, ['login', 'status']);
        const login = diagnoseCodexLogin({ ok: status.exitCode === 0, output: status.output, timedOut: status.timedOut });
        return login.authenticationEvidence === 'cached'
          ? 'configured'
          : login.state === 'needs-login' ? 'installed' : 'unknown';
      } catch { return 'unknown'; }
    },
    prepare: async signal => {
      if (!await wingetAvailable()) {
        throw new Error('이 Windows에는 winget(앱 설치 관리자)이 없습니다. Microsoft Store에서 「앱 설치 관리자」를 설치한 뒤 다시 시도하세요.');
      }
      signal.throwIfAborted();
      const shown = await command('winget.exe', wingetShowArgs(RECIPE), 120_000, signal);
      signal.throwIfAborted();
      if (shown.exitCode === WINGET_EXIT_NO_PACKAGE) {
        throw new Error(`winget 공식 목록에서 ${RECIPE.packageId} 를 찾지 못했습니다. 네트워크 또는 winget 원본 설정을 확인하세요.`);
      }
      if (shown.exitCode !== 0) throw new Error(`설치 전 확인에 실패했습니다 (${wingetExitDetail(shown.exitCode)}).`);
    },
    install: async signal => {
      signal.throwIfAborted();
      const installed = await command('winget.exe', wingetInstallArgs(RECIPE), 900_000, signal);
      signal.throwIfAborted();
      let executable: string | null = null;
      try { executable = windowsCodexExecutable(); } catch { executable = null; }
      if (!executable) throw new Error(`설치 후 codex.exe 를 찾지 못했습니다 (${wingetExitDetail(installed.exitCode)}).`);
      if (/\.exe$/i.test(executable) && !await authenticode(executable)) {
        throw new Error(`설치된 codex.exe 의 서명이 ${RECIPE.publisherCommonName} 로 확인되지 않았습니다.`);
      }
    },
  };
}
