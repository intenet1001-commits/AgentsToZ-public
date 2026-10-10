import { expect, test } from 'bun:test';
import {
  MINIMUM_PYTHON,
  isWindowsStoreAliasStub,
  meetsMinimumPython,
  parsePythonVersion,
  pythonCandidateNames,
  pythonCommandName,
  resolvePythonExecutable,
  windowsPythonFallbackPaths,
  type PythonProbe,
} from '../src/pythonExecutable';

/** Probe over a fixed table, so no test depends on what this machine has installed. */
function probe(table: Record<string, { size?: number | null; version?: string | null }>, path: Record<string, string> = {}): PythonProbe {
  return {
    which: name => path[name] ?? null,
    sizeOf: p => (p in table ? (table[p]!.size ?? null) : null),
    version: p => (p in table ? (table[p]!.version ?? null) : null),
  };
}

test('a version string parses from either stream and the stub text does not', () => {
  expect(parsePythonVersion('Python 3.13.7')).toEqual({ major: 3, minor: 13 });
  expect(parsePythonVersion('\nPython 3.9.0\n')).toEqual({ major: 3, minor: 9 });
  expect(parsePythonVersion('Python 3.12')).toEqual({ major: 3, minor: 12 });
  // Measured output of the zero-byte Store alias: a bare "Python " with no numbers.
  expect(parsePythonVersion('Python ')).toBeNull();
  for (const bad of ['', 'not python', 'Python x.y', 'py launcher']) {
    expect(parsePythonVersion(bad)).toBeNull();
  }
});

test('the supported floor is enforced in both directions', () => {
  expect(MINIMUM_PYTHON).toEqual({ major: 3, minor: 9 });
  expect(meetsMinimumPython({ major: 3, minor: 9 })).toBe(true);
  expect(meetsMinimumPython({ major: 3, minor: 13 })).toBe(true);
  expect(meetsMinimumPython({ major: 4, minor: 0 })).toBe(true);
  expect(meetsMinimumPython({ major: 3, minor: 8 })).toBe(false);
  expect(meetsMinimumPython({ major: 2, minor: 7 })).toBe(false);
  expect(meetsMinimumPython(null)).toBe(false);
});

test('only a zero-byte WindowsApps entry counts as the alias stub', () => {
  const stub = 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe';
  expect(isWindowsStoreAliasStub(stub, 0)).toBe(true);
  // A Store-INSTALLED Python does place a real binary under WindowsApps, so the
  // directory alone must not disqualify it.
  expect(isWindowsStoreAliasStub(stub, 98_304)).toBe(false);
  expect(isWindowsStoreAliasStub('C:\\Python313\\python.exe', 0)).toBe(false);
  expect(isWindowsStoreAliasStub('/usr/bin/python3', 0)).toBe(false);
});

test('Windows tries the py launcher first', () => {
  // py.exe resolves the newest real installation and is unaffected by the stubs.
  expect([...pythonCandidateNames('win32')]).toEqual(['py', 'python3', 'python']);
  expect([...pythonCandidateNames('darwin')]).toEqual(['python3', 'python']);
  expect([...pythonCandidateNames('linux')]).toEqual(['python3', 'python']);
});

test('the stub is rejected and a working interpreter behind it is used', () => {
  const stub = 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe';
  const launcher = 'C:\\Users\\x\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe';
  const resolved = resolvePythonExecutable(
    probe(
      {
        // Measured: size 0, exit 9009, prints a bare "Python ".
        [stub]: { size: 0, version: 'Python ' },
        [launcher]: { size: 140_000, version: 'Python 3.13.7' },
      },
      { python3: stub, py: launcher },
    ),
    'win32',
    { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
  );
  expect(resolved).toBe(launcher);
});

test('a candidate that reports no version is never accepted', () => {
  const stub = 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
  // The dangerous case: the stub is NOT zero bytes in the probe, so only the
  // version read can reject it. Skipping that read is what let it through.
  expect(resolvePythonExecutable(
    probe({ [stub]: { size: 4096, version: 'Python ' } }, { python: stub }),
    'win32',
    {},
  )).toBeNull();
  // And a candidate that could not run at all.
  expect(resolvePythonExecutable(
    probe({ 'C:\\p\\python.exe': { size: 100, version: null } }, { python: 'C:\\p\\python.exe' }),
    'win32',
    {},
  )).toBeNull();
});

test('an outdated interpreter is refused rather than used', () => {
  expect(resolvePythonExecutable(
    probe({ '/usr/bin/python3': { size: 100, version: 'Python 3.8.10' } }, { python3: '/usr/bin/python3' }),
    'darwin',
  )).toBeNull();
  expect(resolvePythonExecutable(
    probe({ '/usr/bin/python3': { size: 100, version: 'Python 3.9.6' } }, { python3: '/usr/bin/python3' }),
    'darwin',
  )).toBe('/usr/bin/python3');
});

test('fixed install locations are tried when PATH holds nothing usable', () => {
  const launcher = 'C:\\Users\\x\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe';
  expect(windowsPythonFallbackPaths({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toContain(launcher);
  // A missing variable must never produce a relative probe path.
  for (const path of windowsPythonFallbackPaths({})) expect(path).toMatch(/^[A-Za-z]:\\/);

  expect(resolvePythonExecutable(
    probe({ [launcher]: { size: 140_000, version: 'Python 3.13.7' } }, {}),
    'win32',
    { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
  )).toBe(launcher);
});

test('the same candidate is probed once however many names point at it', () => {
  const launcher = 'C:\\Py\\py.exe';
  let versionReads = 0;
  const resolved = resolvePythonExecutable({
    which: () => launcher,
    sizeOf: () => 140_000,
    version: () => { versionReads++; return 'Python 3.13.7'; },
  }, 'win32', {});
  expect(resolved).toBe(launcher);
  expect(versionReads).toBe(1);
});

test('the command handed to a person runs on their platform', () => {
  // `python3` is not on a default Windows install, so a copied instruction fails.
  expect(pythonCommandName('win32')).toBe('py');
  expect(pythonCommandName('darwin')).toBe('python3');
  expect(pythonCommandName('linux')).toBe('python3');
});
