import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { GithubHostEffects } from './onboardingGithubHost';
import { diagnoseGithubAuth, type GithubAuthProbe } from './onboardingGithubAuthDiagnosis';
import { OnboardingGithubStore } from './onboardingGithubStore';
import type { GithubSetupReceipt } from './onboardingGithub';
import { buildWindowsSupervisedLaunch } from './windowsCommandLaunch';
import { GITHUB_DEVICE_CODE_TAIL_CHARS, githubDeviceCodeFrom } from './githubDeviceCode';
import {
  AUTHENTICODE_PROBE_PATH_ENV,
  WINDOWS_ONBOARDING_RECIPES,
  WINGET_EXIT_NO_PACKAGE,
  authenticodeProbeArgs,
  isTrustedWindowsPublisher,
  parseAuthenticodeReading,
  windowsNoOpBrowser,
  windowsOnboardingExecutableCandidates,
  wingetExitDetail,
  wingetInstallArgs,
  wingetShowArgs,
} from './onboardingWindowsInstall';

const RECIPE = WINDOWS_ONBOARDING_RECIPES.github;

/**
 * Windows side of the one-click GitHub CLI install.
 *
 * The state machine in `OnboardingGithubHost` is shared with macOS; only these
 * effects differ. What is deliberately NOT shared:
 *
 * - No POSIX mode/uid checks. `info.mode & 0o022` is meaningless on NTFS, and
 *   treating it as a security check here would be a check that proves nothing.
 *   The Authenticode publisher read replaces it.
 * - No hand-pinned download URL or SHA-256. See `onboardingWindowsInstall.ts`
 *   for why the trust anchor is winget's curated manifest plus Authenticode.
 * - No `~/.local/bin` hard link commit. winget owns its install location, so
 *   this app never writes an executable of its own on Windows.
 */

function systemRoot(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? '';
  return /^[A-Za-z]:\\/.test(root) ? root : 'C:\\Windows';
}

function powershellExecutable(): string {
  return join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * A clean, fixed environment. `GH_*` values that could redirect the install or
 * the auth context are pinned rather than inherited, and PATH is narrowed to
 * the system directories so a project-local shim cannot answer for `gh`.
 */
function cleanEnvironment(): Record<string, string> {
  const root = systemRoot();
  const environment: Record<string, string> = {
    SystemRoot: root,
    windir: root,
    PATH: `${root}\\System32;${root};${root}\\System32\\Wbem;${root}\\System32\\WindowsPowerShell\\v1.0`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    COMSPEC: join(root, 'System32', 'cmd.exe'),
    GH_PROMPT_DISABLED: '1',
    GH_HOST: 'github.com',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    // Without this winget renders a spinner and can block on an agreement prompt
    // that nothing in the sidecar can answer.
    WINGET_DISABLE_INTERACTIVITY: '1',
  };
  for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[name];
    if (typeof value === 'string' && value) environment[name] = value;
  }
  const noOpBrowser = windowsNoOpBrowser(process.env);
  if (noOpBrowser) {
    environment.GH_BROWSER = noOpBrowser;
    environment.BROWSER = noOpBrowser;
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

/** Reads the Authenticode status of one absolute path. The path travels in the environment, never in argv. */
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

/**
 * The executable this app would run. A reparse point is resolved first so the
 * Authenticode read and the later launch cannot disagree about the target.
 */
function windowsGithubExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  for (const candidate of windowsOnboardingExecutableCandidates('github', environment)) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    const info = lstatSync(canonical);
    // A 200MB+ "gh.exe" is not the CLI; refuse rather than hand it to Authenticode.
    if (!info.isFile() || info.size > 200 * 1024 * 1024) throw new Error('GitHub 설치 파일을 확인해 주세요.');
    return canonical;
  }
  return null;
}

/**
 * `supervisorScript` resolves the bundled Job Object wrapper. It is injected
 * because only the API server knows where the packaged resource landed, and
 * because a missing script must refuse the login rather than spawn an unowned
 * `gh auth login`.
 */
export function createWindowsGithubHostEffects(
  appData: string,
  supervisorScript: () => string,
): GithubHostEffects {
  // Never silently switch a configured profile or token context.
  const customAuthContext = !!(
    process.env.GH_CONFIG_DIR || process.env.XDG_CONFIG_HOME || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN || process.env.PORTMGR_GH_PATH || process.env.GH_HOST
  );
  void appData;

  async function wingetAvailable(): Promise<boolean> {
    const result = await command('winget.exe', ['--version'], 10_000);
    return result.exitCode === 0;
  }

  return {
    platform: process.platform,
    // The receipt must name the install the user actually reviewed; the panel
    // shows the winget text, not the macOS download text.
    recipeId: RECIPE.id,
    // winget ships with Windows 10 1809+ / 11. If it is absent the helper is
    // honestly unsupported rather than silently falling back to a raw download.
    supported: process.platform === 'win32',
    probe: async (): Promise<'missing' | GithubAuthProbe> => {
      if (customAuthContext) return 'unknown';
      let executable: string | null;
      try { executable = windowsGithubExecutable(); } catch { return 'unknown'; }
      if (!executable) return 'missing';
      // An unsigned or wrong-publisher gh.exe is not reported as installed:
      // this app would otherwise launch it for `auth login`.
      if (!await authenticode(executable)) return 'unknown';
      if ((await command(executable, ['--version'])).exitCode !== 0) return 'unknown';
      const status = await command(executable, ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']);
      return diagnoseGithubAuth({ ok: status.exitCode === 0, stdout: status.stdout, timedOut: status.timedOut });
    },
    /**
     * Read-only. Proves the pinned id resolves in the pinned source before the
     * host commits to `installing`, so a typo or a retired package surfaces as
     * a clean refusal instead of a half-finished install state.
     */
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
    installFile: async signal => {
      signal.throwIfAborted();
      const installed = await command('winget.exe', wingetInstallArgs(RECIPE), 600_000, signal);
      signal.throwIfAborted();
      // winget's own exit code is advisory here; the publisher check decides.
      let executable: string | null = null;
      try { executable = windowsGithubExecutable(); } catch { executable = null; }
      if (!executable) throw new Error(`설치 후 gh.exe 를 찾지 못했습니다 (${wingetExitDetail(installed.exitCode)}).`);
      if (!await authenticode(executable)) {
        throw new Error(`설치된 gh.exe 의 서명이 ${RECIPE.publisherCommonName} 로 확인되지 않았습니다.`);
      }
    },
    openLoginPage: async () => {
      // The same handler the Claude deep link uses. No shell, so the fixed URL
      // never crosses a cmd expansion pass.
      const result = await command(
        join(systemRoot(), 'System32', 'rundll32.exe'),
        ['url.dll,FileProtocolHandler', 'https://github.com/login/device'],
        10_000,
      );
      if (result.exitCode !== 0) throw new Error('브라우저를 열지 못했습니다. https://github.com/login/device 를 직접 열어 주세요.');
    },
    /**
     * Device-code login, owned by the bundled Job Object supervisor.
     *
     * macOS runs this inside the packaged guard
     * (`agentstoz-onboarding-github-auth-v1`), which holds `gh` in a POSIX
     * process group it can reap when the sidecar dies. That guard refuses to run
     * on Windows, so the owner here is the supervisor PowerShell wrapper
     * instead: it puts `gh` in a KILL_ON_JOB_CLOSE Job Object and watches the
     * sidecar through a SYNCHRONIZE handle, so the login cannot outlive the app.
     * `spawnContainedClaudeRemoteControl` already owns a Windows child this way.
     *
     * ⚠️ An unowned `gh auth login` is the thing being avoided: it would keep
     * holding the device code after the app closed, and nothing would stop it.
     * If the supervisor script cannot be found, this refuses rather than
     * spawning without an owner.
     */
    login: onCode => {
      const executable = windowsGithubExecutable();
      if (!executable) throw new Error('GitHub CLI를 찾지 못했습니다. 먼저 설치를 완료하세요.');
      let script: string;
      try { script = supervisorScript(); } catch {
        throw new Error('로그인 소유자(프로세스 감시기)를 찾지 못했습니다. 앱을 다시 설치하거나 다시 빌드한 뒤 시도하세요.');
      }
      const receipts = new OnboardingGithubStore(appData);
      let receipt: GithubSetupReceipt | null;
      try { receipt = receipts.receipt(); } finally { receipts.close(); }
      if (!receipt) throw new Error('로그인 예약을 확인하지 못했습니다.');

      // `--web` makes gh open a browser itself; the app opens the login page on
      // the user's own click, so gh's launch is pointed at a no-op executable.
      const supervised = buildWindowsSupervisedLaunch(
        script,
        {
          cmd: [executable, 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'],
          env: {},
        },
        { parentPid: process.pid },
      );
      const child = Bun.spawn(supervised.cmd, {
        // Never the project directory: Bun autoloads a `.env` from cwd, and the
        // login needs no workspace at all.
        cwd: systemRoot(),
        env: { ...cleanEnvironment(), ...supervised.env },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });

      // Killing the supervisor closes its Job handle, and KILL_ON_JOB_CLOSE
      // takes `gh` and its descendants with it.
      let cancelled = false;
      const cancel = () => { cancelled = true; try { child.kill(); } catch { /* already gone */ } };

      // A restart must know a login process may still be running.
      try {
        const store = new OnboardingGithubStore(appData);
        try {
          store.change(receipt.revision, current => {
            if (!current || current.id !== receipt!.id || current.state !== 'authenticating') throw new Error('reservation');
            return { ...current, guardPid: child.pid };
          });
        } finally { store.close(); }
      } catch { /* a newer cancel/check receipt owns the row; the login still runs under the Job */ }

      const done = (async () => {
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let total = 0;
        let sent = false;
        try {
          for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) break;
            total += value.length;
            // Bounded like the macOS guard: the only thing read out of this
            // stream is a one-time device code, never account names or errors.
            if (total > 65536) throw new Error('login output');
            buffer = (buffer + decoder.decode(value, { stream: true })).slice(-GITHUB_DEVICE_CODE_TAIL_CHARS);
            const code = githubDeviceCodeFrom(buffer);
            if (code && !sent && !cancelled) { sent = true; onCode(code); buffer = ''; }
          }
          const exitCode = await child.exited;
          if (cancelled) throw new Error('cancelled');
          // 70 is the supervisor's "owner already gone" result.
          if (exitCode !== 0) throw new Error('login incomplete');
        } finally {
          buffer = '';
          reader.releaseLock();
          cancel();
          await child.exited;
        }
      })();
      return { done, cancel };
    },
  };
}
