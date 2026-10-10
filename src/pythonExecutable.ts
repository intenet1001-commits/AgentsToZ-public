/**
 * Finding a Python that actually runs.
 *
 * ⚠️ `which python3` is a trap on Windows. Measured on Windows 11 26100 with
 * Python 3.13.7 installed:
 *
 *   %LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe   size 0, exit 9009
 *   %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe    size 0, exit 9009
 *   %LOCALAPPDATA%\Programs\Python\Launcher\py.exe     Python 3.13.7
 *
 * Those `WindowsApps` entries are app-execution-alias stubs that Windows ships
 * whether or not Python is installed. They are zero-byte reparse points: a PATH
 * lookup finds them, so the app reports "Python found", and then every spawn
 * exits 9009 with no output. The user is told their Python is broken while a
 * working interpreter sits one directory away.
 *
 * So a candidate is only accepted after the stub shapes are excluded, and the
 * official `py` launcher is preferred on Windows.
 */

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** Lowest interpreter the project tester supports. */
export const MINIMUM_PYTHON = Object.freeze({ major: 3, minor: 9 });

/**
 * True for the zero-byte Store alias. Both conditions are required: a real
 * interpreter is never zero bytes, and a Store-installed Python does place a
 * working binary under `WindowsApps`, so the directory alone must not disqualify.
 */
export function isWindowsStoreAliasStub(path: string, sizeBytes: number | null): boolean {
  if (typeof path !== 'string') return false;
  const underWindowsApps = /\\Microsoft\\WindowsApps\\/i.test(path) || /\/Microsoft\/WindowsApps\//i.test(path);
  return underWindowsApps && sizeBytes === 0;
}

export interface PythonVersion { major: number; minor: number }

/** Parses `python --version` output. Accepts either stream: some builds print to stderr. */
export function parsePythonVersion(output: string): PythonVersion | null {
  if (typeof output !== 'string' || output.length > 4096) return null;
  // The Store stub prints a bare `Python ` with no numbers; that must not parse.
  const match = output.match(/\bPython\s+(\d{1,3})\.(\d{1,3})(?:\.\d{1,5})?/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? { major, minor } : null;
}

export function meetsMinimumPython(version: PythonVersion | null): boolean {
  if (!version) return false;
  if (version.major !== MINIMUM_PYTHON.major) return version.major > MINIMUM_PYTHON.major;
  return version.minor >= MINIMUM_PYTHON.minor;
}

/**
 * Candidate order. On Windows the `py` launcher comes first because it resolves
 * the newest real installation and is unaffected by the alias stubs.
 */
export function pythonCandidateNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32' ? ['py', 'python3', 'python'] : ['python3', 'python'];
}

/** Fixed install locations to try when PATH holds only stubs. */
export function windowsPythonFallbackPaths(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const localAppData = environment.LOCALAPPDATA ?? '';
  const programFiles = environment.ProgramFiles ?? '';
  const paths = [
    `${localAppData}\\Programs\\Python\\Launcher\\py.exe`,
    `${programFiles}\\Python\\Launcher\\py.exe`,
    `${environment.SystemRoot ?? ''}\\py.exe`,
  ];
  // Windows paths, judged by Windows rules on every host (this list is only used on Windows).
  return paths.filter(path => win32.isAbsolute(path) && /^[A-Za-z]:\\/.test(path));
}

export interface PythonProbe {
  /** PATH lookup; returns null when the name is not found. */
  which(name: string): string | null;
  /** Byte size of a file, or null when it cannot be read. */
  sizeOf(path: string): number | null;
  /** Combined stdout+stderr of `<path> --version`, or null when it could not run. */
  version(path: string): string | null;
}

/**
 * The one place that decides which interpreter the tester will run.
 *
 * A candidate must survive all three gates: it is not a stub shape, it runs,
 * and it reports a supported version. Skipping the version read is what let the
 * stub through before -- its PATH entry exists and `spawn` "succeeds" at the OS
 * level while the process exits 9009.
 */
export function resolvePythonExecutable(
  probe: PythonProbe,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const candidates: string[] = [];
  for (const name of pythonCandidateNames(platform)) {
    const found = probe.which(name);
    if (found) candidates.push(found);
  }
  if (platform === 'win32') candidates.push(...windowsPythonFallbackPaths(environment));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isWindowsStoreAliasStub(candidate, probe.sizeOf(candidate))) continue;
    const output = probe.version(candidate);
    if (output === null) continue;
    if (meetsMinimumPython(parsePythonVersion(output))) return candidate;
  }
  return null;
}

/**
 * The command shown to a person or handed to an AI. `python3` does not exist on
 * a default Windows install, so a copied instruction fails there; `py` is the
 * launcher that ships with every official Windows Python.
 */
export function pythonCommandName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'py' : 'python3';
}

/** Probe backed by this process. Private: callers use `resolveSystemPython`. */
function systemPythonProbe(): PythonProbe {
  return {
    which: name => Bun.which(name),
    sizeOf: path => {
      try { return Number(statSync(path).size); } catch { return null; }
    },
    version: path => {
      try {
        const result = Bun.spawnSync([path, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
        // A stub exits non-zero yet still "runs", so only the printed text decides.
        return `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`;
      } catch { return null; }
    },
  };
}

/**
 * A found interpreter is kept for the process (each candidate costs a spawn). 「Not found」 is kept only for a
 * minute: otherwise installing Python after the first check did nothing until the app restarted.
 */
export function cachedPythonResolver(resolve: () => string | null, now: () => number = Date.now): () => string | null {
  let cache: { value: string | null; at: number } | null = null;
  return () => {
    if (cache && (cache.value !== null || now() - cache.at < 60_000)) return cache.value;
    cache = { value: resolve(), at: now() };
    return cache.value;
  };
}

const systemPython = cachedPythonResolver(() => resolvePythonExecutable(systemPythonProbe()));
export function resolveSystemPython(): string | null {
  return systemPython();
}
