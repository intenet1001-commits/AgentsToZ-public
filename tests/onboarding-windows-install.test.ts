import { expect, test } from 'bun:test';
import {
  AUTHENTICODE_PROBE_PATH_ENV,
  AUTHENTICODE_PROBE_SCRIPT,
  WINDOWS_ONBOARDING_RECIPES,
  WINGET_EXIT_NO_PACKAGE,
  WINGET_EXIT_OK,
  authenticodeCommonName,
  authenticodeProbeArgs,
  isPinnedWingetPackageId,
  isTrustedWindowsPublisher,
  parseAuthenticodeReading,
  windowsNoOpBrowser,
  windowsOnboardingExecutableCandidates,
  wingetExitDetail,
  wingetInstallArgs,
  wingetShowArgs,
} from '../src/onboardingWindowsInstall';

test('each pinned recipe names one exact winget package and one publisher', () => {
  for (const tool of ['github', 'codex'] as const) {
    const recipe = WINDOWS_ONBOARDING_RECIPES[tool];
    expect(recipe.tool).toBe(tool);
    expect(isPinnedWingetPackageId(recipe.packageId)).toBe(true);
    expect(recipe.publisherCommonName.length).toBeGreaterThan(0);
    expect(recipe.executable).toMatch(/\.exe$/);
    // A recipe id change is the review trigger, so it must carry the package id.
    expect(recipe.id).toContain(recipe.packageId);
  }
  expect(WINDOWS_ONBOARDING_RECIPES.github.packageId).toBe('GitHub.cli');
  expect(WINDOWS_ONBOARDING_RECIPES.codex.packageId).toBe('OpenAI.Codex');
});

test('winget argv pins the source and never waits on a prompt', () => {
  for (const tool of ['github', 'codex'] as const) {
    const recipe = WINDOWS_ONBOARDING_RECIPES[tool];
    const install = wingetInstallArgs(recipe);
    const show = wingetShowArgs(recipe);
    for (const args of [install, show]) {
      // A third-party source must never be allowed to answer for a pinned id.
      expect(args).toContain('--source');
      expect(args[args.indexOf('--source') + 1]).toBe('winget');
      expect(args).toContain('--exact');
      expect(args).toContain('--id');
      expect(args[args.indexOf('--id') + 1]).toBe(recipe.packageId);
      // An unanswerable agreement prompt inside the sidecar looks exactly like a hang.
      expect(args).toContain('--disable-interactivity');
    }
    expect(install).toContain('--accept-package-agreements');
    expect(install).toContain('--accept-source-agreements');
    expect(show[0]).toBe('show');
    expect(install[0]).toBe('install');
  }
});

test('a corrupted package id constant is refused instead of being passed to winget', () => {
  for (const packageId of ['', 'NoDot', '../evil', 'a b', 'GitHub.cli;calc', '-leading', 'x'.repeat(80)]) {
    expect(isPinnedWingetPackageId(packageId)).toBe(false);
    const recipe = { ...WINDOWS_ONBOARDING_RECIPES.github, packageId };
    expect(() => wingetInstallArgs(recipe)).toThrow();
    expect(() => wingetShowArgs(recipe)).toThrow();
  }
});

test('the probe output parses into the enum status and the raw subject', () => {
  const reading = parseAuthenticodeReading(
    'STATUS=Valid\r\nSUBJECT=CN="GitHub, Inc.", O="GitHub, Inc.", L=San Francisco, S=California, C=US\r\n',
  );
  expect(reading).toEqual({
    status: 'Valid',
    subject: 'CN="GitHub, Inc.", O="GitHub, Inc.", L=San Francisco, S=California, C=US',
  });
  expect(parseAuthenticodeReading('STATUS=NotPresent\nSUBJECT=')).toEqual({ status: 'NotPresent', subject: '' });
  expect(parseAuthenticodeReading('')).toBeNull();
  expect(parseAuthenticodeReading('SUBJECT=CN=x')).toBeNull();
  expect(parseAuthenticodeReading('x'.repeat(9000))).toBeNull();
});

test('a quoted common name containing a comma survives parsing', () => {
  // Measured subject of the real gh.exe. Splitting on "," unquoted would yield
  // `"GitHub` and reject a correctly signed binary.
  expect(authenticodeCommonName('CN="GitHub, Inc.", O="GitHub, Inc.", C=US')).toBe('GitHub, Inc.');
  expect(authenticodeCommonName('CN="OpenAI, Inc.", O="OpenAI, Inc.", C=US')).toBe('OpenAI, Inc.');
  expect(authenticodeCommonName('O=Other, CN=Plain Name, C=US')).toBe('Plain Name');
  expect(authenticodeCommonName('O=Other, C=US')).toBeNull();
  expect(authenticodeCommonName('')).toBeNull();
  expect(authenticodeCommonName('CN=' + 'x'.repeat(3000))).toBeNull();
});

test('only a Valid signature from the pinned publisher is trusted', () => {
  const subject = 'CN="GitHub, Inc.", O="GitHub, Inc.", C=US';
  const expected = WINDOWS_ONBOARDING_RECIPES.github.publisherCommonName;
  expect(isTrustedWindowsPublisher({ status: 'Valid', subject }, expected)).toBe(true);

  // Every non-Valid status means this app cannot prove what it would run.
  for (const status of ['NotSigned', 'HashMismatch', 'UnknownError', 'NotTrusted', 'NotPresent', 'valid', '']) {
    expect(isTrustedWindowsPublisher({ status, subject }, expected)).toBe(false);
  }
  // A valid signature by somebody else is still a refusal.
  for (const other of ['CN="Evil, Inc.", C=US', 'CN=GitHub, C=US', 'CN="GitHub, Inc", C=US', 'O="GitHub, Inc.", C=US']) {
    expect(isTrustedWindowsPublisher({ status: 'Valid', subject: other }, expected)).toBe(false);
  }
  expect(isTrustedWindowsPublisher(null, expected)).toBe(false);
});

test('the pinned signer is the certificate CN, not winget publisher metadata', () => {
  // Measured subjects of the real binaries on Windows. The Codex signer is
  // `OpenAI OpCo, LLC` while winget's manifest publisher reads `OpenAI, Inc.`;
  // pinning the manifest string here would reject the genuine codex.exe.
  const codex = WINDOWS_ONBOARDING_RECIPES.codex.publisherCommonName;
  expect(codex).toBe('OpenAI OpCo, LLC');
  expect(codex).not.toBe('OpenAI, Inc.');
  expect(isTrustedWindowsPublisher({
    status: 'Valid',
    subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US',
  }, codex)).toBe(true);
  expect(isTrustedWindowsPublisher({ status: 'Valid', subject: 'CN="OpenAI, Inc.", C=US' }, codex)).toBe(false);

  expect(isTrustedWindowsPublisher({
    status: 'Valid',
    subject: 'CN="GitHub, Inc.", O="GitHub, Inc.", L=San Francisco, S=California, C=US',
  }, WINDOWS_ONBOARDING_RECIPES.github.publisherCommonName)).toBe(true);
});

test('the probe reads its path from the environment, never from argv or script text', () => {
  // Measured: `powershell -Command <script> <path>` appends the path to the
  // command text instead of filling $args, which both broke the probe and
  // created a script-injection surface.
  expect(AUTHENTICODE_PROBE_SCRIPT).toContain(`$env:${AUTHENTICODE_PROBE_PATH_ENV}`);
  expect(AUTHENTICODE_PROBE_SCRIPT).not.toContain('$args');
  expect(AUTHENTICODE_PROBE_SCRIPT).toContain('-LiteralPath');
  // `$s.Status` is a .NET enum, so its text stays English on a localized Windows.
  expect(AUTHENTICODE_PROBE_SCRIPT).toContain('"STATUS=$($s.Status)"');
  expect(AUTHENTICODE_PROBE_SCRIPT).not.toMatch(/Write-Host/);

  const args = authenticodeProbeArgs();
  expect(args).toContain('-NoProfile');
  expect(args).toContain('-NonInteractive');
  // -EncodedCommand bypasses every quoting layer, so no path or script text can
  // be reinterpreted by cmd or by PowerShell's parser.
  expect(args).toContain('-EncodedCommand');
  const encoded = args[args.indexOf('-EncodedCommand') + 1]!;
  expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(AUTHENTICODE_PROBE_SCRIPT);
  expect(args.some(value => value.includes('\\'))).toBe(false);
});

test('install success is decided by the publisher check, not by a guessed exit code', () => {
  // Only the two measured codes carry a meaning; anything else is reported as-is
  // so a non-zero winget finish can never be mistaken for a successful install.
  expect(wingetExitDetail(WINGET_EXIT_OK)).toBe('winget exit 0');
  expect(wingetExitDetail(WINGET_EXIT_NO_PACKAGE)).toContain('not found');
  expect(wingetExitDetail(-1)).toBe('winget exit -1');
  expect(wingetExitDetail(null)).toContain('unknown');
  const module = require('../src/onboardingWindowsInstall') as Record<string, unknown>;
  expect(module.isWingetInstallSuccess).toBeUndefined();
  expect(module.WINGET_EXIT_ALREADY_INSTALLED).toBeUndefined();
});

test('only absolute Windows paths become executable candidates', () => {
  const environment = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\x',
  };
  const github = windowsOnboardingExecutableCandidates('github', environment);
  // The real install location measured on this machine must be covered.
  expect(github).toContain('C:\\Program Files\\GitHub CLI\\gh.exe');
  expect(github.every(path => /^[A-Za-z]:\\/.test(path))).toBe(true);
  expect(github.every(path => path.toLowerCase().endsWith('gh.exe'))).toBe(true);

  const codex = windowsOnboardingExecutableCandidates('codex', environment);
  expect(codex).toContain('C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
  expect(codex.every(path => /^[A-Za-z]:\\/.test(path))).toBe(true);

  // A missing variable must drop the candidate, never produce a relative probe.
  for (const tool of ['github', 'codex'] as const) {
    for (const path of windowsOnboardingExecutableCandidates(tool, {})) {
      expect(path).toMatch(/^[A-Za-z]:\\/);
    }
  }
});

test('a hand-installed tool is reported, so the user is never told it is missing', () => {
  const environment = { USERPROFILE: 'C:\\Users\\x' };
  // `~/.local/bin` is where the macOS helper installs; a user who mirrored that
  // layout on Windows must still be detected.
  expect(windowsOnboardingExecutableCandidates('github', environment))
    .toContain('C:\\Users\\x\\.local\\bin\\gh.exe');
  expect(windowsOnboardingExecutableCandidates('codex', environment))
    .toContain('C:\\Users\\x\\.local\\bin\\codex.exe');
});

test('the no-op browser is resolved from the system root only', () => {
  expect(windowsNoOpBrowser({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\rundll32.exe');
  expect(windowsNoOpBrowser({ windir: 'D:\\Win' })).toBe('D:\\Win\\System32\\rundll32.exe');
  // Without a trustworthy system root the app must not invent a path for gh to run.
  expect(windowsNoOpBrowser({})).toBeNull();
  expect(windowsNoOpBrowser({ SystemRoot: '/usr' })).toBeNull();
  expect(windowsNoOpBrowser({ SystemRoot: 'Windows' })).toBeNull();
});
