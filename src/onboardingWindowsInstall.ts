/**
 * Windows one-click onboarding installs.
 *
 * The macOS helpers pin a download URL plus SHA-256 and verify the extracted
 * binary with `codesign` TeamIdentifier. Windows has no equivalent of that
 * recipe shape: the vendors publish installers, not a fixed extractable
 * payload, and the file layout changes between versions. So the trust anchor
 * here is different and stated plainly:
 *
 *   1. `winget` installs only a pinned package id from the `winget` source,
 *      whose manifest Microsoft curates with its own hash verification.
 *   2. After the install, the executable this app will actually run must carry
 *      a *Valid* Authenticode signature whose subject common name is the
 *      pinned publisher. That is the Windows analogue of TeamIdentifier and it
 *      is what finally decides `installed` -- not winget's own report.
 *
 * ⚠️ Never parse winget's human output to decide anything. It is localized
 * (measured on a Korean install: `버전:`, `게시자:`), so a locale change would
 * silently turn a verified install into an unverified one. Exit codes and the
 * Authenticode read are the only signals used (measured: found = 0,
 * unknown id = -1978335212).
 */

export type WindowsOnboardingTool = 'github' | 'codex';

export interface WindowsOnboardingRecipe {
  /** Recipe identity. A change to any pinned field below needs a new id and a renewed review. */
  readonly id: string;
  readonly tool: WindowsOnboardingTool;
  /** Exact winget package id. Never built from user input. */
  readonly packageId: string;
  /**
   * Authenticode subject common name required on the executable we will run.
   *
   * ⚠️ This is the code-signing certificate's CN, which is NOT the same string
   * as winget's `게시자`/Publisher manifest field. Measured: winget reports
   * `OpenAI, Inc.` for `OpenAI.Codex`, while the shipped `codex.exe` is signed
   * `CN="OpenAI OpCo, LLC"`. Copying the manifest publisher here would reject
   * the genuine binary. Read the real signature before changing this.
   */
  readonly publisherCommonName: string;
  /** Basename of the executable this app launches. */
  readonly executable: string;
}

export const WINDOWS_ONBOARDING_RECIPES: Readonly<Record<WindowsOnboardingTool, WindowsOnboardingRecipe>> =
  Object.freeze({
    github: Object.freeze({
      id: 'github-windows-winget-GitHub.cli-v1',
      tool: 'github',
      packageId: 'GitHub.cli',
      publisherCommonName: 'GitHub, Inc.',
      executable: 'gh.exe',
    }),
    codex: Object.freeze({
      id: 'codex-windows-winget-OpenAI.Codex-v1',
      tool: 'codex',
      packageId: 'OpenAI.Codex',
      // Measured from a shipped codex.exe 0.146.0 on Windows x64:
      // CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US
      publisherCommonName: 'OpenAI OpCo, LLC',
      executable: 'codex.exe',
    }),
  });

/** A winget package id is pinned in this file; this only rejects a corrupted constant. */
export function isPinnedWingetPackageId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9]$/.test(value) && value.includes('.');
}

/**
 * Read-only availability check. `--disable-interactivity` matters: without it
 * winget renders a spinner and can wait on an agreement prompt that no one can
 * answer inside the sidecar.
 */
export function wingetShowArgs(recipe: WindowsOnboardingRecipe): readonly string[] {
  if (!isPinnedWingetPackageId(recipe.packageId)) throw new Error('pinned package id');
  return ['show', '--id', recipe.packageId, '--exact', '--source', 'winget', '--disable-interactivity'];
}

/**
 * Fixed install argv. `--source winget` keeps a third-party source from
 * answering for a pinned id, and the accept flags are required because an
 * unanswered agreement prompt is indistinguishable from a hang here.
 */
export function wingetInstallArgs(recipe: WindowsOnboardingRecipe): readonly string[] {
  if (!isPinnedWingetPackageId(recipe.packageId)) throw new Error('pinned package id');
  return [
    'install', '--id', recipe.packageId, '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements',
    '--disable-interactivity', '--silent',
  ];
}

/** winget exit code for "this id exists in that source". */
export const WINGET_EXIT_OK = 0;
/**
 * Measured on winget v1.11.430 (`--exact --id Bogus.DoesNotExist.XYZ`): -1978335212
 * = 0x8A150014 APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND.
 */
export const WINGET_EXIT_NO_PACKAGE = -1978335212;

/**
 * ⚠️ There is deliberately no "install succeeded" exit-code list here.
 *
 * winget returns a different non-zero code for already-installed, for
 * no-applicable-upgrade, and for a reboot-pending finish, and those values were
 * NOT measured on this machine. Encoding a guessed constant would make the
 * installer call a failed install a success. So the exit code is only ever
 * reported as detail: the Authenticode probe over the executable this app will
 * actually run is what decides the outcome (`isTrustedWindowsPublisher`).
 */
export function wingetExitDetail(exitCode: number | null): string {
  if (exitCode === WINGET_EXIT_OK) return 'winget exit 0';
  if (exitCode === WINGET_EXIT_NO_PACKAGE) return 'winget: package not found in the winget source';
  return `winget exit ${exitCode ?? 'unknown'}`;
}

export interface AuthenticodeReading {
  readonly status: string;
  readonly subject: string;
}

/**
 * Parses the fixed two-line probe output. `$s.Status` is a .NET enum, so its
 * string form stays English on a localized Windows (measured: `Valid` on a
 * Korean install) -- that is why the probe prints the enum and not a message.
 */
export function parseAuthenticodeReading(output: string): AuthenticodeReading | null {
  if (typeof output !== 'string' || output.length > 8192) return null;
  let status = '';
  let subject = '';
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('STATUS=')) status = line.slice(7).trim();
    else if (line.startsWith('SUBJECT=')) subject = line.slice(8).trim();
  }
  if (!status) return null;
  return { status, subject };
}

/**
 * Pulls the common name out of an X.500 subject. A publisher name containing a
 * comma is quoted there (measured: `CN="GitHub, Inc.", O="GitHub, Inc.", ...`),
 * so an unquoted split on `,` would truncate it to `CN="GitHub` and fail a
 * correctly signed binary.
 */
export function authenticodeCommonName(subject: string): string | null {
  if (typeof subject !== 'string' || subject.length > 2048) return null;
  const match = subject.match(/(?:^|,)\s*CN=(?:"((?:[^"]|"")*)"|([^,]*))/);
  if (!match) return null;
  const value = match[1] !== undefined ? match[1].replace(/""/g, '"') : (match[2] ?? '');
  const name = value.trim();
  return name.length > 0 && name.length <= 256 ? name : null;
}

/**
 * The single place that decides a Windows executable is the pinned publisher's.
 * Anything other than `Valid` is a refusal: `UnknownError`, `NotSigned` and
 * `HashMismatch` all mean this app cannot prove what it is about to run.
 */
export function isTrustedWindowsPublisher(
  reading: AuthenticodeReading | null,
  expectedCommonName: string,
): boolean {
  if (!reading || reading.status !== 'Valid') return false;
  const name = authenticodeCommonName(reading.subject);
  return name !== null && name === expectedCommonName;
}

/**
 * Environment variable carrying the path to inspect.
 *
 * ⚠️ The path must NOT travel in argv. Measured: `powershell -Command <script>
 * <path>` does not populate `$args` -- PowerShell appends the extra argument to
 * the command text, so `C:\Windows\notepad.exe` arrived as the parse error
 * `Unexpected token 'C:Windows'` with `\n` already consumed as an escape. That
 * is both a broken probe and a script-injection surface. An environment variable
 * crosses intact (measured: 34-character path, `LEN=34`, `EXISTS=True`).
 */
export const AUTHENTICODE_PROBE_PATH_ENV = 'AGENTSTOZ_AUTHENTICODE_PATH';

/** Fixed PowerShell probe. Reads only the environment variable above. */
export const AUTHENTICODE_PROBE_SCRIPT = [
  '$ErrorActionPreference=\'Stop\';',
  `$p=$env:${AUTHENTICODE_PROBE_PATH_ENV};`,
  'if([string]::IsNullOrEmpty($p) -or -not (Test-Path -LiteralPath $p -PathType Leaf)){ "STATUS=NotPresent"; "SUBJECT="; exit 0 }',
  '$s=Get-AuthenticodeSignature -LiteralPath $p;',
  '"STATUS=$($s.Status)";',
  '"SUBJECT=$($s.SignerCertificate.Subject)"',
].join(' ');

/**
 * `-EncodedCommand` takes base64 UTF-16LE and bypasses every quoting layer, so
 * the script text cannot be reinterpreted by cmd or by PowerShell's own parser.
 */
export function authenticodeProbeArgs(): readonly string[] {
  return [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(AUTHENTICODE_PROBE_SCRIPT, 'utf16le').toString('base64'),
  ];
}

/**
 * Where a winget install of each tool can land. Machine scope writes under
 * Program Files; user scope writes under LOCALAPPDATA. Both are listed because
 * winget picks per the manifest, and the probe must find either one.
 *
 * ⚠️ `~/.local/bin` is kept last on purpose: a user who already installed the
 * tool by hand must not be told the tool is missing. The app never replaces
 * what it finds there -- it only reports it.
 */
export function windowsOnboardingExecutableCandidates(
  tool: WindowsOnboardingTool,
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const programFiles = environment.ProgramFiles ?? '';
  const programFilesX86 = environment['ProgramFiles(x86)'] ?? '';
  const localAppData = environment.LOCALAPPDATA ?? '';
  const appData = environment.APPDATA ?? '';
  const userProfile = environment.USERPROFILE ?? '';
  const join = (...parts: string[]) => parts.filter(Boolean).join('\\');
  const candidates = tool === 'github'
    ? [
      join(programFiles, 'GitHub CLI', 'bin', 'gh.exe'),
      join(programFiles, 'GitHub CLI', 'gh.exe'),
      join(programFilesX86, 'GitHub CLI', 'bin', 'gh.exe'),
      join(localAppData, 'Programs', 'GitHub CLI', 'bin', 'gh.exe'),
      join(localAppData, 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
      join(userProfile, '.local', 'bin', 'gh.exe'),
    ]
    : [
      join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      join(programFiles, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      join(localAppData, 'Microsoft', 'WinGet', 'Links', 'codex.exe'),
      join(appData, 'npm', 'codex.cmd'),
      join(userProfile, '.local', 'bin', 'codex.exe'),
    ];
  // A missing environment variable collapses a candidate to a relative path;
  // only absolute Windows paths may be probed.
  return candidates.filter(path => /^[A-Za-z]:\\/.test(path));
}

/**
 * `gh auth login --web` opens a browser itself. The app opens the login page on
 * the user's own click instead, so gh's launch is suppressed by pointing it at a
 * no-op executable -- the Windows counterpart of `/usr/bin/true`.
 * Measured: `rundll32.exe` with no arguments shows no window and exits 0.
 */
export function windowsNoOpBrowser(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const root = environment.SystemRoot ?? environment.windir ?? '';
  if (!/^[A-Za-z]:\\/.test(root)) return null;
  return `${root}\\System32\\rundll32.exe`;
}
